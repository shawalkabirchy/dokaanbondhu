import type { ReplyEvent } from "@dokaanbondhu/contracts";
import {
  buildDictionary,
  catalogEntries,
  GLOSSARY,
  type ActionTemplate,
  type CatalogVehicle,
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
// cars have no years, with its own engine codes, grades and brands), each with GearGrid's sale as setup imports it.
// The part search runs as on a host (spec 11.5); a fake runner answers its queries from the tables below, and the
// sale's dry run a fake API.

interface ShopPart {
  id: string;
  name: string;
  category?: string;
  quality: string | null;
  position: string | null;
  brand: string | null;
  fits: string[];
}

export interface Shop {
  name: string;
  vehicles: CatalogVehicle[];
  parts: ShopPart[];
}

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
}

/** GearGrid's sale as setup imports it, sent to a fake API; each call and each wake is counted. */
function salesApi(calls: HostRequest[], wakes: { count: number }, api: Api): WriteHost {
  const imported = importOpenApi(openapi);
  const capabilities: WriteCapability[] = imported.capabilities
    .filter((capability) => capability.kind === "write" && capability.name === "record_sale")
    .map((capability) => ({
      id: "sale",
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
        enumValues: param.enumValues,
        entityConcept: param.entityConcept,
        semanticSlot: param.semanticSlot,
        spokenMap: param.spokenMap,
      })),
      compensation: null,
      readBack: capability.readBack,
    }));
  return {
    capabilities,
    operations: {},
    features: imported.features,
    call: async (request, options) => {
      calls.push(request);
      return (api.answer ?? answered)(request, options);
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
    customers: [{ hostId: "c1", name: "Rahim Motors", nameBn: "রহিম মোটরস", attrs: {} }],
    suppliers: [],
  };
}

export const fresh = (): TurnState => ({ state: "IDLE", context: {}, frame: null, history: [] });

type Input = { text: string } | { choice: { slot: string; optionId: string } };

/** One shop app connected, as the server builds its turn (the glossary with the app's own cars and parts). */
export function connect(shop: Shop, api: Api = {}) {
  const catalog = catalogOf(shop);
  const calls: HostRequest[] = [];
  const wakes = { count: 0 };
  let id = 0;
  const deps = (steps: Step[]): TurnDeps => ({
    llm: [scripted(steps)],
    dictionary: buildDictionary([...GLOSSARY, ...catalogEntries(catalog)]),
    host: {
      map: geargridMap,
      run: runner(shop),
      catalog,
      fitmentExtra: [],
      rackExtra: new Map(),
      formulas: [],
      hostReports: [],
      writes: salesApi(calls, wakes, api),
    },
    now: () => new Date("2026-10-15T12:00:00+06:00"),
    newId: () => `id-${++id}`,
    evalMode: false,
    shopWords: [],
    role: "staff",
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
      confirm: events.find((event) => event.type === "confirm") as { text: string } | undefined,
      found: outcome.trace.lookups.at(-1)?.parts.flat() ?? [],
      statuses: events.flatMap((event) => (event.type === "status" ? [event.label_key] : [])),
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
