import type { ReplyEvent } from "@dokaanbondhu/contracts";
import {
  buildDictionary,
  catalogEntries,
  GLOSSARY,
  type ActionTemplate,
  type CatalogVehicle,
  type Dictionary,
} from "@dokaanbondhu/core";
import { readFileSync } from "node:fs";
import type { HostRequest, HostResponse } from "../src/host/api";
import type { Catalog } from "../src/host/catalog";
import { importOpenApi } from "../src/host/openapi-import";
import type { WriteCapability, WriteHost } from "../src/write/types";
import { runTurn, type TurnDeps, type TurnState } from "../src/conversation/turn";
import { geargridMap } from "./geargrid-map";
import { scripted, type Step } from "./scripted-llm";

// Shop apps for conversation tests without a database (D167, D168): three apps shaped differently (GearGrid's two
// Fielders that share 2012, shop B's two Axio chassis of the same years with its own grade words, and an app whose
// cars have no years, with its own engine codes, grades and brands), each with GearGrid's sale and return as setup
// imports them. The part search and the sale finder run as on a host (spec 11.5, 10.7); a fake runner answers their
// queries from the tables below, and the dry runs a fake API.

interface ShopPart {
  id: string;
  name: string;
  category?: string;
  quality: string | null;
  position: string | null;
  brand: string | null;
  fits: string[];
}

/** A sale line in the app's books, for returns (D169), so many days before the tests' now. */
export interface ShopSale {
  id: string;
  lineId: string;
  partId: string;
  customerId: string | null;
  quantity: number;
  unitPrice: number;
  /** What was still due on the sale. */
  due: number;
  daysAgo: number;
  /** Units of the line returned already. */
  returned?: number;
}

export interface Shop {
  name: string;
  vehicles: CatalogVehicle[];
  parts: ShopPart[];
  sales?: ShopSale[];
  /** Rahim Motors' due, when a test reads it. */
  customerDue?: number;
  /** The app's own customer types, for a new customer (D173); GearGrid's by default. */
  customerTypes?: string[];
}

/** The tests' now: 15 Oct 2026, noon in Dhaka. */
export const NOW = new Date("2026-10-15T12:00:00+06:00");
const DAY_MS = 86_400_000;

const car = (
  hostId: string,
  make: string,
  model: string,
  yearFrom: number,
  yearTo: number | null,
  engineCode: string | null = "1NZ",
): CatalogVehicle => ({ hostId, make, model, yearFrom, yearTo, engineCode, vehicleType: "car" });

const pad = (id: string, fits: string[], fields: Partial<ShopPart> = {}): ShopPart => ({
  id,
  name: "Front brake pad set",
  quality: "genuine",
  position: "front",
  brand: "Toyota",
  fits,
  ...fields,
});

/** GearGrid's seed: the Fielder 2006-2012 and 2012-2017 share 2012; the older one has a genuine and a copy pad. */
export const geargrid: Shop = {
  name: "GearGrid",
  vehicles: [
    car("axio-2006", "Toyota", "Axio", 2006, 2011),
    car("axio-2012", "Toyota", "Axio", 2012, 2017),
    car("fielder-2006", "Toyota", "Fielder", 2006, 2012),
    car("fielder-2012", "Toyota", "Fielder", 2012, 2017),
    car("premio-2007", "Toyota", "Premio", 2007, 2011),
    car("premio-2012", "Toyota", "Premio", 2012, 2017),
  ],
  parts: [
    pad("pad-new", ["axio-2012", "fielder-2012", "premio-2012"]),
    pad("pad-old", ["axio-2006", "fielder-2006", "premio-2007"]),
    pad("pad-old-copy", ["axio-2006", "fielder-2006", "premio-2007"], {
      quality: "aftermarket",
      brand: "Akebono",
    }),
  ],
};

/** Shop B (D122): no make column, two Axio chassis of the same years, grades and sides in its own words. */
export const shopB: Shop = {
  name: "shop B",
  customerTypes: ["Walk-in", "Mechanic"],
  vehicles: [
    car("1", "", "Axio NZE141", 2012, 2017),
    car("2", "", "Fielder", 2012, 2017),
    car("4", "", "Axio", 2006, 2011),
    car("5", "", "Axio NZE144", 2012, 2017),
  ],
  parts: [
    pad("1", ["1", "2", "5"], {
      name: "Toyota 04465-12610",
      category: "Brake Pad",
      quality: "OEM",
      position: "F",
    }),
    pad("2", ["1", "5"], { name: "Brake Pad F Copy", category: "Brake Pad", quality: "Copy", position: "F" }),
  ],
};

/** An app with cars kept without years, its own engine codes, and grades and brands no word list knows. */
export const ownWords: Shop = {
  name: "an app with its own words",
  customerTypes: ["Normal", "Dealer", "Workshop"],
  vehicles: [
    car("pj-a", "Mitsubishi", "Pajero", 0, null, "4D56"),
    car("pj-b", "Mitsubishi", "Pajero", 0, null, "4M40"),
    car("tc", "Hyundai", "Tucson", 2016, 2020, null),
  ],
  parts: [
    pad("pj-4d56", ["pj-a"], { name: "Brake Pad Front", quality: "Platinum", brand: "Rexo" }),
    pad("pj-4m40", ["pj-b"], { name: "Brake Pad Front", quality: "Platinum", brand: "Rexo" }),
    pad("tc-platinum", ["tc"], { name: "Brake Pad Front", quality: "Platinum", brand: "Rexo" }),
    pad("tc-silver-rexo", ["tc"], { name: "Brake Pad Front", quality: "Silver", brand: "Rexo" }),
    pad("tc-silver-zimco", ["tc"], { name: "Brake Pad Front", quality: "Silver", brand: "Zimco" }),
  ],
};

export const SHOPS = [geargrid, shopB, ownWords];

const openapi = JSON.parse(
  readFileSync(new URL("../../../tools/fixtures/openapi/geargrid-openapi.json", import.meta.url), "utf8"),
);

/** How the app's API answers a call: by default every dry run with a total, at once. */
export type ApiAnswer = (request: HostRequest, options?: { timeoutMs?: number }) => Promise<HostResponse>;

export const answered: ApiAnswer = async () => ({
  status: 200,
  headers: new Headers(),
  body: { data: { total: 3200, warnings: [] } },
});

/** The app's API as the turn sees it, for tests that change how it answers (D168). */
export interface Api {
  answer?: ApiAnswer;
  /** False for an app whose sale has no dry run: the confirmation's total comes from the prices. */
  dryRun?: boolean;
  /** Who is signed in: staff by default; a price change is the owner's (D171). */
  role?: "owner" | "staff";
}

/** The app's new fitment as GearGrid answers it (D172). */
const fitAnswer: ApiAnswer = async (request) => ({
  status: 201,
  headers: new Headers(),
  body: { fitment: { id: "fit-1", ...(request.body as Record<string, unknown>) } },
});

/** A new customer or supplier as GearGrid answers it: the record with its new ID (D173). */
const partyAnswer: ApiAnswer = async (request) => {
  const party = request.path.endsWith("/suppliers") ? "supplier" : "customer";
  const dry = request.query?.dry_run === "true";
  return {
    status: dry ? 200 : 201,
    headers: new Headers(),
    body: {
      [party]: { id: `${party}-new`, ...(request.body as Record<string, unknown>) },
      warnings: [],
      dry_run: dry,
    },
  };
};

/** The app's price change as GearGrid answers it: the new prices, and the previous ones for an undo (D132). */
const priceAnswer: ApiAnswer = async (request) => {
  const body = (request.body ?? {}) as { retail_price_taka?: number; garage_price_taka?: number };
  const id = decodeURIComponent(request.path.split("/").at(-2) ?? "");
  return {
    status: 200,
    headers: new Headers(),
    body: {
      part: {
        id,
        retail_price_taka: body.retail_price_taka ?? 1600,
        garage_price_taka: body.garage_price_taka ?? 1500,
      },
      previous: { retail_price_taka: 1600, garage_price_taka: 1500 },
    },
  };
};

/** The app's return as GearGrid answers it: the total from the sold line, the customer's due after the refund. */
function returnAnswer(shop: Shop): ApiAnswer {
  return async (request) => {
    const body = (request.body ?? {}) as {
      items?: { sale_item_id?: string; quantity?: number }[];
      refund_due_taka?: number;
    };
    const item = body.items?.[0];
    const line = shop.sales?.find((sale) => sale.lineId === item?.sale_item_id);
    const dry = request.query?.dry_run === "true";
    const due = (shop.customerDue ?? 0) - (body.refund_due_taka ?? 0);
    return {
      status: dry ? 200 : 201,
      headers: new Headers(),
      body: {
        return: { id: dry ? null : "return-1", total_taka: (line?.unitPrice ?? 0) * (item?.quantity ?? 0) },
        customer: line?.customerId ? { id: line.customerId, due_balance_taka: due } : null,
        warnings: [],
        dry_run: dry,
      },
    };
  };
}

const IDS: Record<string, string> = {
  record_sale: "sale",
  stock_in: "stock",
  record_return: "return",
  update_price: "price",
  add_fitment: "fit",
  add_customer: "add-customer",
  add_supplier: "add-supplier",
};

/** GearGrid's writes as setup imports them (dry runs as the API allows, unless `api` turns them off), with the app's
 * own customer types. */
function appCapabilities(api: Api = {}, shop?: Shop): WriteCapability[] {
  const imported = importOpenApi(openapi);
  return imported.capabilities
    .filter((capability) => capability.kind === "write" && IDS[capability.name])
    .map((capability) => ({
      id: IDS[capability.name]!,
      name: capability.name,
      description: capability.description || null,
      template: capability.template as ActionTemplate,
      requiredRole: capability.requiredRole,
      httpMethod: capability.httpMethod,
      path: capability.path,
      dryRun: capability.supportsDryRun && api.dryRun !== false,
      params: capability.params.map((param) => ({
        path: param.path,
        location: param.location,
        type: param.type,
        required: param.required,
        enumValues:
          param.semanticSlot === "party_type" && shop?.customerTypes ? shop.customerTypes : param.enumValues,
        entityConcept: param.entityConcept,
        semanticSlot: param.semanticSlot,
        spokenMap: param.spokenMap,
      })),
      compensation: null,
      readBack: capability.readBack,
    }));
}

/** One of the fake apps' writes, by its operation's name (record_sale, record_return). */
export function appCapability(name: string): WriteCapability {
  return appCapabilities().find((capability) => capability.name === name)!;
}

/** The writes sent to a fake API; each call and each wake is counted. */
function salesApi(shop: Shop, calls: HostRequest[], wakes: { count: number }, api: Api): WriteHost {
  return {
    capabilities: appCapabilities(api, shop),
    operations: {},
    features: importOpenApi(openapi).features,
    call: async (request, options) => {
      calls.push(request);
      const answer =
        api.answer ??
        (request.path.includes("/returns")
          ? returnAnswer(shop)
          : request.path.endsWith("/price")
            ? priceAnswer
            : request.path.endsWith("/fitments")
              ? fitAnswer
              : /\/(customers|suppliers)$/.test(request.path)
                ? partyAnswer
                : answered);
      return answer(request, options);
    },
    wake: () => {
      wakes.count += 1;
    },
  };
}

/** The app's tables behind find_parts' three queries (parts through fitments, stock, prices). */
function runner(shop: Shop) {
  const lists = (values: unknown[]) => values.map((value) => (Array.isArray(value) ? value.map(String) : []));
  return async (query: { text: string; values: unknown[] }) => {
    // The sale finder (D169): the sales of a part to a customer, or without one, newest first.
    if (query.text.includes('"sale_items"')) {
      const walkIn = query.text.includes('"customer_id" IS NULL');
      return (shop.sales ?? [])
        .filter(
          (sale) =>
            query.values.includes(sale.partId) &&
            (walkIn
              ? sale.customerId === null
              : sale.customerId !== null && query.values.includes(sale.customerId)),
        )
        .sort((a, b) => a.daysAgo - b.daysAgo)
        .map((sale) => ({
          sale_id: sale.id,
          line_id: sale.lineId,
          time: new Date(NOW.getTime() - sale.daysAgo * DAY_MS),
          quantity: String(sale.quantity),
          unit_price: String(sale.unitPrice),
          due: String(sale.due),
        }));
    }
    if (query.text.includes('"return_items"')) {
      const ids = lists(query.values).flat();
      return (shop.sales ?? [])
        .filter((sale) => sale.returned && ids.includes(sale.id))
        .map((sale) => ({ sale_id: sale.id, quantity: String(sale.returned) }));
    }
    if (shop.customerDue !== undefined && query.text.includes('"due_balance"'))
      return [{ due: String(shop.customerDue), balance: String(shop.customerDue) }];
    const [partIds = [], vehicleIds = []] = lists(query.values);
    const parts = shop.parts.filter((part) => partIds.includes(part.id));
    if (query.text.includes('"fitments"'))
      return parts.flatMap((part) =>
        part.fits
          .filter((vehicle) => vehicleIds.includes(vehicle))
          .map((vehicle) => ({
            part_id: part.id,
            name: part.name,
            name_bn: null,
            quality: part.quality,
            position: part.position,
            unit: "set",
            brand: part.brand,
            vehicle_id: vehicle,
            verified: true,
          })),
      );
    if (query.text.includes('"stock_levels"'))
      return parts.map((part) => ({ part_id: part.id, stock: "4", racks: ["B-3"] }));
    if (query.text.includes('"retail_price"'))
      return parts.map((part) => ({ part_id: part.id, retail_price: "1600", garage_price: "1500" }));
    return [];
  };
}

function catalogOf(shop: Shop): Catalog {
  return {
    syncedAt: null,
    parts: shop.parts.map((part) => ({
      hostId: part.id,
      name: part.name,
      nameBn: null,
      partNumbers: [part.id.toUpperCase()],
      category: part.category ?? null,
      attrs: {},
    })),
    vehicles: shop.vehicles,
    customers: [
      { hostId: "c1", name: "Rahim Motors", nameBn: "রহিম মোটরস", attrs: { phone: "01711000000" } },
    ],
    suppliers: [{ hostId: "s1", name: "Nawabpur Auto Parts", nameBn: null, attrs: { phone: "01911000000" } }],
  };
}

export const fresh = (): TurnState => ({ state: "IDLE", context: {}, frame: null, history: [] });

type Input = { text: string } | { choice: { slot: string; optionId: string } };

/** Each app's dictionary, built once: building one is the slow part of a turn, and the apps never change. */
const dictionaries = new WeakMap<ShopPart[], Dictionary>();

/** One shop app connected, as the server builds its turn (the glossary with the app's own cars and parts). */
export function connect(shop: Shop, api: Api = {}) {
  const catalog = catalogOf(shop);
  const calls: HostRequest[] = [];
  const wakes = { count: 0 };
  let id = 0;
  let dictionary = dictionaries.get(shop.parts);
  if (!dictionary) {
    dictionary = buildDictionary([...GLOSSARY, ...catalogEntries(catalog)]);
    dictionaries.set(shop.parts, dictionary);
  }
  const deps = (steps: Step[]): TurnDeps => ({
    llm: [scripted(steps)],
    dictionary: dictionary!,
    host: {
      map: geargridMap,
      run: runner(shop),
      catalog,
      fitmentExtra: [],
      rackExtra: new Map(),
      formulas: [],
      hostReports: [],
      writes: salesApi(shop, calls, wakes, api),
    },
    now: () => NOW,
    newId: () => `id-${++id}`,
    evalMode: false,
    shopWords: [],
    role: api.role ?? "staff",
  });
  /** One turn; an answer needs no LLM, so a request brings the one tool call its script names. */
  async function say(state: TurnState, input: Input, steps: Step[] = []) {
    const events: ReplyEvent[] = [];
    const outcome = await runTurn(input, structuredClone(state), deps(steps), (event) => events.push(event));
    const reply = events
      .filter((event) => event.type === "text")
      .map((event) => (event as { text: string }).text)
      .join(" ");
    const choices = events.find((event) => event.type === "choices") as
      { slot: string; options: { id: string; label: string }[] } | undefined;
    const asked = outcome.state.frame?.status === "active" ? outcome.state.frame.asking : undefined;
    return {
      reply,
      choices,
      asked,
      confirm: events.find((event) => event.type === "confirm") as
        { text: string; fields: { label: string; value: string }[] } | undefined,
      found: outcome.trace.lookups.at(-1)?.parts.flat() ?? [],
      statuses: events.flatMap((event) => (event.type === "status" ? [event.label_key] : [])),
      results: events.flatMap((event) => (event.type === "action_result" ? [event.status] : [])),
      added: outcome.added,
      state: outcome.state,
    };
  }
  /** The part the last dry run would sell. */
  const sold = () => JSON.stringify(calls.at(-1)?.body ?? null);
  return { say, sold, calls, wakes };
}

export type Reply = Awaited<ReturnType<ReturnType<typeof connect>["say"]>>;

/** Taps the button whose label matches, on the question just asked. */
export function tap(reply: Reply, label: RegExp): { choice: { slot: string; optionId: string } } {
  const option = reply.choices?.options.find((candidate) => label.test(candidate.label));
  if (!reply.choices || !option)
    throw new Error(`no button ${label} in ${JSON.stringify(reply.choices)} (${reply.reply})`);
  return { choice: { slot: reply.choices.slot, optionId: option.id } };
}

export const SALE = [
  {
    style: "Bangla",
    text: "রহিম মোটরসকে দুই সেট ব্রেক প্যাড বাকিতে দাও",
    args: {
      customer: "রহিম মোটরস",
      items: [{ part: { part_type: "ব্রেক প্যাড" }, quantity: "দুই সেট" }],
      payment: { method_word: "বাকিতে" },
    },
    said2012: "২০১২",
    noAxio: "না, এক্সিও",
  },
  {
    style: "Banglish",
    text: "Rohim Motors ke dui set brake pad bakite dau",
    args: {
      customer: "Rohim Motors",
      items: [{ part: { part_type: "brake pad" }, quantity: "dui set" }],
      payment: { method_word: "bakite" },
    },
    said2012: "2012",
    noAxio: "na, axio",
  },
] as const;

export const saleCall = (args: object): Step[] => [
  { calls: [{ name: "record_sale", arguments: { ...args } }] },
];
