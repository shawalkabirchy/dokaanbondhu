import type { ReplyEvent } from "@dokaanbondhu/contracts";
import {
  buildDictionary,
  catalogEntries,
  GLOSSARY,
  type ActionTemplate,
  type CatalogVehicle,
} from "@dokaanbondhu/core";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { geargridMap } from "../../test/geargrid-map";
import { scripted, type Step } from "../../test/scripted-llm";
import type { HostRequest } from "../host/api";
import type { Catalog } from "../host/catalog";
import { importOpenApi } from "../host/openapi-import";
import type { WriteCapability, WriteHost } from "../write/types";
import { runTurn, type TurnDeps, type TurnState } from "./turn";

// D167: a question answered in a request is never asked again in it, whatever shop app is connected. The owner's
// credit sale of 15 Oct asked the Fielder's year again after every tap. These conversations tap or say each answer, in
// Bangla and in Banglish (D96), over three apps shaped differently: GearGrid's two Fielders that share 2012, shop B's
// two Axio chassis of the same years with its own grade words, and an app whose cars have no years, with its own
// engine codes, grades and brands. The part search runs as on a host (spec 11.5); a fake runner answers its queries
// from the tables below, and the sale's dry run from a fake API.

interface ShopPart {
  id: string;
  name: string;
  category?: string;
  quality: string | null;
  position: string | null;
  brand: string | null;
  fits: string[];
}

interface Shop {
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
const geargrid: Shop = {
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
const shopB: Shop = {
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
const ownWords: Shop = {
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

const SHOPS = [geargrid, shopB, ownWords];

const openapi = JSON.parse(
  readFileSync(new URL("../../../../tools/fixtures/openapi/geargrid-openapi.json", import.meta.url), "utf8"),
);

/** GearGrid's sale as setup imports it, sent to a fake API that answers every dry run with a total. */
function salesApi(calls: HostRequest[]): WriteHost {
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
      dryRun: capability.supportsDryRun,
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
    call: async (request) => {
      calls.push(request);
      return { status: 200, headers: new Headers(), body: { data: { total: 3200, warnings: [] } } };
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

const fresh = (): TurnState => ({ state: "IDLE", context: {}, frame: null, history: [] });

type Input = { text: string } | { choice: { slot: string; optionId: string } };

/** One shop app connected, as the server builds its turn (the glossary with the app's own cars and parts). */
function connect(shop: Shop) {
  const catalog = catalogOf(shop);
  const calls: HostRequest[] = [];
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
      writes: salesApi(calls),
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
      state: outcome.state,
    };
  }
  /** The part the last dry run would sell. */
  const sold = () => JSON.stringify(calls.at(-1)?.body ?? null);
  return { say, sold, calls };
}

type Reply = Awaited<ReturnType<ReturnType<typeof connect>["say"]>>;

/** Taps the button whose label matches, on the question just asked. */
function tap(reply: Reply, label: RegExp): { choice: { slot: string; optionId: string } } {
  const option = reply.choices?.options.find((candidate) => label.test(candidate.label));
  if (!reply.choices || !option)
    throw new Error(`no button ${label} in ${JSON.stringify(reply.choices)} (${reply.reply})`);
  return { choice: { slot: reply.choices.slot, optionId: option.id } };
}

const SALE = [
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

const saleCall = (args: object): Step[] => [{ calls: [{ name: "record_sale", arguments: { ...args } }] }];

describe("the owner's credit sale, the car and its year tapped (GearGrid, D167)", () => {
  it.each(SALE)("taps the Fielder, then 2012–2017: that Fielder's pad, asked once ($style)", async (sale) => {
    const shop = connect(geargrid);
    const first = await shop.say(fresh(), { text: sale.text }, saleCall(sale.args));
    expect(first.asked).toBe("vehicle");
    const fielder = await shop.say(first.state, tap(first, /ফিল্ডার/));
    expect(fielder.reply).toBe("কোন বছরের ফিল্ডার?");
    expect(fielder.choices?.options.map((option) => option.label)).toEqual(["2006–2012", "2012–2017"]);
    const year = await shop.say(fielder.state, tap(fielder, /^2012–2017$/));
    expect(year.asked).toBeUndefined();
    expect(year.confirm?.text).toMatch(/^Rahim Motors — ফিল্ডার ২০১২, সামনের ব্রেক প্যাড, জেনুইন, ২ সেট/);
    expect(shop.sold()).toContain('"pad-new"');
  });

  it.each(SALE)("taps 2006–2012: the quality is asked next, never the year again ($style)", async (sale) => {
    const shop = connect(geargrid);
    const first = await shop.say(fresh(), { text: sale.text }, saleCall(sale.args));
    const fielder = await shop.say(first.state, tap(first, /ফিল্ডার/));
    const year = await shop.say(fielder.state, tap(fielder, /^2006–2012$/));
    expect(year.reply).toBe("জেনুইন না নন-জেনুইন?");
    const quality = await shop.say(year.state, tap(year, /নন-জেনুইন/));
    expect(quality.confirm?.text).toMatch(
      /^Rahim Motors — ফিল্ডার ২০০৬, সামনের ব্রেক প্যাড, নন-জেনুইন, ২ সেট/,
    );
    expect(shop.sold()).toContain('"pad-old-copy"');
  });

  it.each(SALE)(
    "says 2012, which both Fielders have: the next questions are about other things ($style)",
    async (sale) => {
      const shop = connect(geargrid);
      const first = await shop.say(fresh(), { text: sale.text }, saleCall(sale.args));
      const fielder = await shop.say(first.state, tap(first, /ফিল্ডার/));
      const year = await shop.say(fielder.state, { text: sale.said2012 });
      expect(year.asked).toBe("quality");
      const quality = await shop.say(year.state, tap(year, /^জেনুইন/));
      // Two genuine pads, one per Fielder, that read the same: the list says each one's years.
      expect(quality.asked).toBe("part_pick");
      expect(quality.choices?.options.map((option) => option.label)).toEqual([
        "Front brake pad set, Toyota (২০১২–২০১৭)",
        "Front brake pad set, Toyota (২০০৬–২০১২)",
      ]);
      const picked = await shop.say(quality.state, tap(quality, /২০১২–২০১৭/));
      expect(picked.confirm).toBeDefined();
      expect(shop.sold()).toContain('"pad-new"');
    },
  );

  it.each(SALE)("a car changed after its year was tapped asks the new car's year ($style)", async (sale) => {
    const shop = connect(geargrid);
    const first = await shop.say(fresh(), { text: sale.text }, saleCall(sale.args));
    const fielder = await shop.say(first.state, tap(first, /ফিল্ডার/));
    const year = await shop.say(fielder.state, tap(fielder, /^2006–2012$/));
    const axio = await shop.say(year.state, { text: sale.noAxio });
    expect(axio.reply).toBe("কোন বছরের এক্সিও?");
    expect(axio.choices?.options.map((option) => option.label)).toEqual(["2006–2011", "2012–2017"]);
  });
});

describe("other apps' cars, codes and words (D167)", () => {
  it.each(SALE)("shop B: one button for the two Axio chassis of the same years ($style)", async (sale) => {
    const shop = connect(shopB);
    const first = await shop.say(fresh(), { text: sale.text }, saleCall(sale.args));
    // The app's own car names are its buttons (D154): "Axio" is every Axio row.
    const axio = await shop.say(first.state, tap(first, /^Axio$/));
    expect(axio.choices?.options.map((option) => option.label)).toEqual(["2006–2011", "2012–2017"]);
    const year = await shop.say(axio.state, tap(axio, /^2012–2017$/));
    expect(year.asked).toBe("quality");
    const quality = await shop.say(year.state, tap(year, /নন-জেনুইন/));
    expect(quality.confirm).toBeDefined();
    expect(shop.sold()).toContain('"2"');
  });

  it.each(SALE)(
    "cars kept without years: no year button; the app's engine codes pick the part ($style)",
    async (sale) => {
      const shop = connect(ownWords);
      const args = {
        ...sale.args,
        items: [{ ...sale.args.items[0], part: { ...sale.args.items[0].part, vehicle: "pajero" } }],
      };
      const first = await shop.say(fresh(), { text: `${sale.text} pajero` }, saleCall(args));
      expect(first.asked).toBe("engine");
      expect(first.choices?.options.map((option) => option.label)).toEqual(["4D56", "4M40"]);
      const engine = await shop.say(first.state, tap(first, /^4M40$/));
      expect(engine.confirm).toBeDefined();
      expect(shop.sold()).toContain('"pj-4m40"');
    },
  );

  it.each(SALE)(
    "grades and brands no word list knows are picked as the app writes them ($style)",
    async (sale) => {
      const shop = connect(ownWords);
      const args = {
        ...sale.args,
        items: [{ ...sale.args.items[0], part: { ...sale.args.items[0].part, vehicle: "tucson" } }],
      };
      const first = await shop.say(fresh(), { text: `${sale.text} tucson` }, saleCall(args));
      expect(first.asked).toBe("quality");
      const quality = await shop.say(first.state, tap(first, /Silver/i));
      expect(quality.asked).toBe("brand");
      const brand = await shop.say(quality.state, tap(quality, /Zimco/i));
      expect(brand.confirm).toBeDefined();
      expect(shop.sold()).toContain('"tc-silver-zimco"');
    },
  );
});

const ASK = [
  { style: "Bangla", text: "ব্রেক প্যাড আছে?", part: "ব্রেক প্যাড", again: "ফিল্ডারের ব্রেক প্যাড আছে?" },
  { style: "Banglish", text: "brake pad ache?", part: "brake pad", again: "fielder er brake pad ache?" },
] as const;

const findCall = (args: object): Step[] => [{ calls: [{ name: "find_parts", arguments: { ...args } }] }];

describe("a part question, the car and its year tapped (D167)", () => {
  it.each(ASK)(
    "answers for the tapped years, and the same car's next question keeps them ($style)",
    async (ask) => {
      const shop = connect(geargrid);
      const first = await shop.say(fresh(), { text: ask.text }, findCall({ part_type: ask.part }));
      expect(first.asked).toBe("vehicle");
      const fielder = await shop.say(first.state, tap(first, /ফিল্ডার/));
      expect(fielder.choices?.options.map((option) => option.label)).toEqual(["2006–2012", "2012–2017"]);
      const year = await shop.say(fielder.state, tap(fielder, /^2012–2017$/));
      expect(year.asked).toBeUndefined();
      expect(year.found).toEqual(["PAD-NEW"]);
      expect(year.state.context.vehicle).toMatchObject({
        model: "Toyota Fielder",
        years: { from: 2012, to: 2017 },
      });
      // The LLM copies the remembered first year ("ফিল্ডার ২০১২" in its context): the tapped years still hold.
      const again = await shop.say(
        year.state,
        { text: ask.again },
        findCall({ part_type: ask.part, vehicle: "fielder", year: "2012" }),
      );
      expect(again.asked).toBeUndefined();
      expect(again.found).toEqual(["PAD-NEW"]);
    },
  );
});

/**
 * Every button of every question, on every app, for a sale and a part question: after a tap the request goes on, and
 * no question it asked is asked again in it.
 */
describe("no question is asked twice in a request, on any app (D167)", () => {
  async function walk(
    shop: ReturnType<typeof connect>,
    reply: Reply,
    asked: string[],
    paths: { count: number },
  ): Promise<void> {
    if (!reply.asked) {
      paths.count += 1;
      return;
    }
    expect(asked, `${reply.asked} asked again after ${asked.join(", ")}: ${reply.reply}`).not.toContain(
      reply.asked,
    );
    expect(asked.length).toBeLessThan(8);
    for (const option of reply.choices?.options ?? []) {
      const next = await shop.say(reply.state, {
        choice: { slot: reply.choices!.slot, optionId: option.id },
      });
      await walk(shop, next, [...asked, reply.asked], paths);
    }
  }

  for (const app of SHOPS) {
    it.each(SALE)(`${app.name}: a sale, every button ($style)`, async (sale) => {
      const shop = connect(app);
      const paths = { count: 0 };
      await walk(shop, await shop.say(fresh(), { text: sale.text }, saleCall(sale.args)), [], paths);
      expect(paths.count).toBeGreaterThan(1);
    });
    it.each(ASK)(`${app.name}: a part question, every button ($style)`, async (ask) => {
      const shop = connect(app);
      const paths = { count: 0 };
      await walk(
        shop,
        await shop.say(fresh(), { text: ask.text }, findCall({ part_type: ask.part })),
        [],
        paths,
      );
      expect(paths.count).toBeGreaterThan(1);
    });
  }
});
