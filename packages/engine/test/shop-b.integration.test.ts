import {
  buildDictionary,
  catalogEntries,
  GLOSSARY,
  matchVehicles,
  namesInText,
  partsAnswer,
  priceLevelIn,
  resolveCustomer,
  type Dictionary,
  type PartsContext,
} from "@dokaanbondhu/core";
import type { ReplyEvent } from "@dokaanbondhu/contracts";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runTurn, type TurnState } from "../src/conversation/turn";
import { appWordsOf, customerTier, readCatalog, toCatalog, type Catalog } from "../src/host/catalog";
import { findParts, type FindPartsInput, type FitmentExtra } from "../src/host/find-parts";
import { parsedFitments } from "../src/host/fitment-text";
import { introspect } from "../src/host/introspect";
import { HostPools, type HostDb } from "../src/host/pool";
import { ReadQueryRejected, runReadQuery } from "../src/host/read-query";
import { stockValue } from "../src/host/reports";
import { fittedParts } from "../src/host/sync";
import { scripted, type Step } from "./scripted-llm";
import { shopBMap } from "./shop-b-map";

// Host integration against test shop B (D122; tools/fixtures/shop-b): a MySQL 8 shop app shaped unlike GearGrid, read
// as its read-only user, so every feature is shown to work on a second kind of host. Only against a local container.

const shopUrl = process.env.SHOPB_DATABASE_URL ?? "";
const isLocal = (() => {
  try {
    return ["localhost", "127.0.0.1"].includes(new URL(shopUrl).hostname);
  } catch {
    return false;
  }
})();
if (process.env.CI === "true" && !isLocal) throw new Error("shop B tests need the local CI database");

describe.skipIf(!isLocal)("host integration on test shop B (MySQL)", () => {
  const pools = new HostPools();
  let db: HostDb;
  let catalog: Catalog;
  let dictionary: Dictionary;
  let fitmentExtra: FitmentExtra[];

  const input = (query: FindPartsInput["query"]): FindPartsInput => ({
    query,
    hypotheses: [],
    map: shopBMap,
    run: (built) => pools.readOnly(db, (run) => run(built)),
    catalog,
    dictionary,
    fitmentExtra,
    rackExtra: new Map(),
  });

  beforeAll(async () => {
    const url = new URL(shopUrl);
    db = {
      id: "shop-b-ci",
      dialect: "mysql",
      host: url.hostname,
      port: Number(url.port || 3306),
      database: url.pathname.slice(1),
      username: "shopb_ro",
      password: process.env.SHOPB_RO_PASSWORD ?? "",
      sslMode: "disable",
      sslCa: null,
      poolMax: 2,
    };
    catalog = toCatalog(await pools.readOnly(db, (run) => readCatalog(run, shopBMap)));
    // As the server builds it: the glossary, then the app's own car models, categories and part kinds (D122).
    dictionary = buildDictionary([...GLOSSARY, ...catalogEntries(catalog)]);
    // As catalog sync does: the fit of the parts its item_cars table leaves out, read from their name and remarks.
    const covered = await pools.readOnly(db, (run) => fittedParts(run, shopBMap));
    fitmentExtra = parsedFitments(catalog, dictionary, covered);
  });

  afterAll(async () => {
    await pools.closeAll();
  });

  it("introspects the shop's tables with their keys and samples, as its read-only user", async () => {
    const tables = await pools.readOnly(db, (run) => introspect(run, "mysql"));
    const names = tables.map((table) => table.name);
    expect(names).toEqual(
      expect.arrayContaining(["items", "item_cars", "branch_stock", "item_prices", "parties"]),
    );
    const codes = tables.find((table) => table.name === "item_codes")!;
    expect(codes.columns.find((column) => column.name === "item_id")?.references).toEqual({
      table: "items",
      column: "item_id",
    });
    expect(tables.find((table) => table.name === "items")!.samples.length).toBe(5);
  });

  it("reads the catalog without deleted rows: parts with their group, all their racks, cars and customers", () => {
    expect(catalog.parts).toHaveLength(7);
    expect(catalog.vehicles).toHaveLength(5);
    expect(catalog.customers).toHaveLength(4);
    expect(catalog.suppliers).toHaveLength(1);
    const pad = catalog.parts.find((part) => part.partNumbers.includes("04465-12610"))!;
    expect(pad.attrs.category).toBe("Brake Pad");
    expect([...(pad.attrs.racks as string[])].sort()).toEqual(["B-3", "G-1"]);
  });

  it("reads the app's own words for quality, side, unit and customer kind; R and VIP are asked (D121, D122)", () => {
    const read = (concept: Parameters<typeof appWordsOf>[1]) =>
      Object.fromEntries(appWordsOf(catalog, concept, {}).map((word) => [word.value, word.our]));
    expect(read("quality")).toEqual({ OEM: "genuine", Copy: "aftermarket", Used: "used" });
    expect(read("position")).toEqual({ F: "front", FL: "front left", R: null });
    expect(read("unit")).toEqual({ set: "set", pcs: "piece", ltr: "liter" });
    expect(read("price_tier")).toEqual({
      Mechanic: "garage",
      Dealer: "wholesale",
      VIP: null,
      "Walk-in": "retail",
    });
    const customer = (name: string) => catalog.customers.find((candidate) => candidate.name === name)!.attrs;
    expect(customerTier(customer("Rahman Auto Works"))).toBe("garage");
    expect(customerTier(customer("Mr. Karim"))).toBe("retail");
    expect(customerTier(customer("Mr. Karim"), { price_tier: { VIP: "wholesale" } })).toBe("wholesale");
  });

  it("finds its cars without a make column, with years written as text; two Axio generations ask the year (D122)", () => {
    const axio = matchVehicles("Toyota Axio", 2014, null, catalog.vehicles);
    expect(axio.vehicles.map((vehicle) => vehicle.model).sort()).toEqual(["Axio NZE141", "Axio NZE144"]);
    expect(axio.vehicles[0]).toMatchObject({ yearFrom: 2012, yearTo: 2017 });
    expect(matchVehicles("Toyota Axio", null, null, catalog.vehicles)).toMatchObject({ needsYear: true });
    expect(matchVehicles("Toyota Fielder", 2014, null, catalog.vehicles).vehicles).toHaveLength(1);
  });

  it("lists a part once: stock added up over both branches, every rack, the newest price (D122)", async () => {
    const result = await findParts(input({ part_number: "04465-12610" }));
    if (result.kind !== "rows") throw new Error(result.kind);
    expect(result.rows).toHaveLength(1);
    const [pad] = result.rows;
    expect(pad).toMatchObject({ stock: 5, retailTaka: 4500n, garageTaka: 4200n, wholesaleTaka: 4000n });
    expect(pad).toMatchObject({ quality: "genuine", position: "front", unit: "set" });
    expect([...(pad!.racks ?? [])].sort()).toEqual(["B-3", "G-1"]);
  });

  it.each([
    {
      style: "Bangla",
      args: { part_type: "সামনের ব্রেক প্যাড", vehicle: "এক্সিও", year: "২০১৪", position: "সামনের" },
    },
    {
      style: "Banglish",
      args: { part_type: "brake pad", vehicle: "axio", year: "2014", position: "samner" },
    },
  ])(
    "answers Axio 2014 front pads: one only its group calls a pad, one fitting two chassis said once ($style)",
    async ({ args }) => {
      const result = await findParts(input(args));
      if (result.kind !== "rows") throw new Error(result.kind);
      const context: PartsContext = {
        vehicle: "Toyota Axio",
        year: 2014,
        partType: "Brake Pad",
        position: result.resolved.position,
        tier: "retail",
      };
      expect(partsAnswer(result.rows, context)).toBe(
        "এক্সিও ২০১৪-এর সামনের ব্রেক প্যাড দুই রকম আছে: জেনুইন ৫ সেট, ৪,৫০০ টাকা, B-3 আর G-1 তাকে; নন-জেনুইন ৬ সেট, ১,৯৯১ টাকা, B-3 তাকে।",
      );
    },
  );

  it.each([
    { style: "Bangla", part_type: "পাওয়ার স্টিয়ারিং পাম্প", vehicle: "এক্সিও" },
    { style: "Banglish", part_type: "power steering pump", vehicle: "axio" },
  ])(
    "knows the app's own part kinds, never a sound-alike glossary type ($style)",
    async ({ part_type, vehicle }) => {
      const result = await findParts(input({ part_type, vehicle, year: "2014" }));
      expect(result.resolved.partType).toBe("Power Steering Pump");
    },
  );

  it("knows the app's own car models, typed as it writes them", async () => {
    const result = await findParts(input({ part_type: "shock absorber", vehicle: "tucson", year: "2018" }));
    expect(result.resolved.vehicle).toBe("Tucson");
    const compressor = await findParts(
      input({ part_type: "ac compressor", vehicle: "fielder", year: "2014" }),
    );
    expect(compressor.resolved).toMatchObject({ partType: "AC Compressor", vehicle: "Toyota Fielder" });
  });

  it("reads the fit of the items item_cars leaves out from their name and remarks (D122)", () => {
    const fits = fitmentExtra
      .map((row) => `${row.hostPartId} ${row.model} ${row.yearFrom}-${row.yearTo}`)
      .sort();
    expect(fits).toEqual([
      "3 Tucson 2016-2020",
      "4 Toyota Axio 2012-2017",
      "4 Toyota Fielder 2012-2017",
      "5 Toyota Axio 2012-2017",
    ]);
  });

  it.each([
    { style: "Bangla", args: { part_type: "পাওয়ার স্টিয়ারিং পাম্প", vehicle: "এক্সিও", year: "২০১৪" } },
    { style: "Banglish", args: { part_type: "power steering pump", vehicle: "axio", year: "2014" } },
  ])("answers a part whose car is only in its remarks, and says so ($style)", async ({ args }) => {
    const result = await findParts(input(args));
    if (result.kind !== "rows") throw new Error(result.kind);
    const context: PartsContext = {
      vehicle: "Toyota Axio",
      year: 2014,
      partType: result.resolved.partType!,
      position: null,
      tier: "retail",
    };
    expect(partsAnswer(result.rows, context)).toBe(
      "এক্সিও ২০১৪-এর জেনুইন Power Steering Pump ১টা আছে, ৯,০০০ টাকা, C-2 তাকে। এই গাড়িতে লাগে বলে নামে লেখা আছে, নিশ্চিত নয়।",
    );
  });

  // The app's own car is English; its Bangla word comes from the listening check once the owner adds it (D105), as
  // the server then loads it among the shop's aliases.
  it.each([
    { style: "Bangla", args: { part_type: "শক অ্যাবজর্ভার", vehicle: "টুসান", year: "২০১৮" } },
    { style: "Banglish", args: { part_type: "shock absorber", vehicle: "tucson", year: "2018" } },
  ])("answers the app's own car from a name, front left in its words ($style)", async ({ args }) => {
    const added = {
      target_concept: "vehicle_model" as const,
      target_value: "Tucson",
      bn: ["টুসান"],
      latin: [],
    };
    const shop = buildDictionary([...GLOSSARY, ...catalogEntries(catalog), added]);
    const result = await findParts({ ...input(args), dictionary: shop });
    if (result.kind !== "rows") throw new Error(`${result.kind} ${JSON.stringify(result.resolved)}`);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      position: "front left",
      stock: 2,
      rack: "D-12",
      fitFromName: true,
    });
  });

  /** One whole turn on shop B with a scripted LLM step: its reply and the outcome (the next turn's state). */
  const turn = async (said: string, state: TurnState, step: Step, words: Dictionary = dictionary) => {
    const events: ReplyEvent[] = [];
    const outcome = await runTurn(
      { text: said },
      state,
      {
        llm: [scripted([step])],
        dictionary: words,
        host: {
          map: shopBMap,
          run: (built) => pools.readOnly(db, (run) => run(built)),
          catalog,
          fitmentExtra,
          rackExtra: new Map(),
          formulas: [],
          hostReports: [],
        },
        now: () => new Date(),
        newId: () => randomUUID(),
        evalMode: false,
        shopWords: [],
      },
      (event) => events.push(event),
    );
    const reply = events.flatMap((event) => (event.type === "text" ? [event.text] : [])).join(" ");
    return { outcome, reply, done: events.at(-1) };
  };
  const fresh = (): TurnState => ({ state: "IDLE", context: {}, frame: null, history: [] });

  // D125: a new part with no car is looked up for the remembered car, on an app shaped unlike GearGrid too.
  it.each([
    {
      style: "Bangla",
      text: "এক্সিও ২০১৪-এর সামনের ব্রেক প্যাড আছে?",
      args: { part_type: "সামনের ব্রেক প্যাড", vehicle: "এক্সিও", year: "২০১৪", position: "সামনের" },
      next: "পাওয়ার স্টিয়ারিং পাম্প আছে?",
      part: "পাওয়ার স্টিয়ারিং পাম্প",
    },
    {
      style: "Banglish",
      text: "axio 2014 er samner brake pad ache?",
      args: { part_type: "brake pad", vehicle: "axio", year: "2014", position: "samner" },
      next: "power steering pump ache?",
      part: "power steering pump",
    },
  ])(
    "looks up a new part for the remembered car in a whole turn ($style)",
    async ({ text, args, next, part }) => {
      const first = await turn(text, fresh(), { calls: [{ name: "find_parts", arguments: args }] });
      expect(first.reply).toContain("B-3 আর G-1 তাকে");
      const second = await turn(next, first.outcome.state, {
        calls: [{ name: "find_parts", arguments: { part_type: part } }],
      });
      expect(second.reply).toBe(
        "এক্সিও ২০১৪-এর জেনুইন Power Steering Pump ১টা আছে, ৯,০০০ টাকা, C-2 তাকে। এই গাড়িতে লাগে বলে নামে লেখা আছে, নিশ্চিত নয়।",
      );
    },
  );

  // D125: a car only the app knows (the Tucson is in no glossary) is remembered too, shown as the app writes it, and
  // completes the next part's search. Its Bangla word is the owner's, added as in the test above.
  it.each([
    {
      style: "Bangla",
      text: "টুসান ২০১৮-এর ব্রেক প্যাড আছে?",
      args: { part_type: "ব্রেক প্যাড", vehicle: "টুসান", year: "২০১৮" },
      next: "শক অ্যাবজর্ভার আছে?",
      part: "শক অ্যাবজর্ভার",
    },
    {
      style: "Banglish",
      text: "tucson 2018 er brake pad ache?",
      args: { part_type: "brake pad", vehicle: "tucson", year: "2018" },
      next: "shock absorber ache?",
      part: "shock absorber",
    },
  ])(
    "remembers a car only the app knows and finds the next part for it ($style)",
    async ({ text, args, next, part }) => {
      const added = {
        target_concept: "vehicle_model" as const,
        target_value: "Tucson",
        bn: ["টুসান"],
        latin: [],
      };
      const shop = buildDictionary([...GLOSSARY, ...catalogEntries(catalog), added]);
      // No brake pad is recorded for a Tucson; the car is remembered all the same.
      const first = await turn(text, fresh(), { calls: [{ name: "find_parts", arguments: args }] }, shop);
      expect(first.outcome.state.context.vehicle).toMatchObject({ model: "Tucson", year: 2018 });
      expect(first.done).toMatchObject({ type: "done", context: { vehicle: { label: "Tucson ২০১৮" } } });

      const second = await turn(
        next,
        first.outcome.state,
        { calls: [{ name: "find_parts", arguments: { part_type: part } }] },
        shop,
      );
      expect(second.reply).toContain("Tucson ২০১৮-এর");
      expect(second.reply).toContain("D-12 তাকে");
      expect(second.reply).toContain("নামে লেখা আছে");
      expect(second.outcome.state.frame?.slots.vehicle).toMatchObject({ value: "Tucson", source: "context" });
    },
  );

  // D127: an answer that names another car is a new request on this app too; the Axio's year is not given to it. The
  // app's own "AC Compressor" gets its Bangla word from the owner, as the Tucson above.
  it.each([
    {
      style: "Bangla",
      car: "এক্সিও ২০১৪",
      carArgs: { vehicle: "এক্সিও", year: "২০১৪" },
      other: "ফিল্ডারের এসি কম্প্রেসার আছে?",
      otherArgs: { part_type: "এসি কম্প্রেসার", vehicle: "ফিল্ডার", year: "২০১৪" },
    },
    {
      style: "Banglish",
      car: "axio 2014",
      carArgs: { vehicle: "axio", year: "2014" },
      other: "fielder er ac compressor ache?",
      otherArgs: { part_type: "ac compressor", vehicle: "fielder", year: "2014" },
    },
  ])(
    "takes an answer that names another car as a new request (D127; $style)",
    async ({ car, carArgs, other, otherArgs }) => {
      const added = {
        target_concept: "part_type" as const,
        target_value: "AC Compressor",
        bn: ["এসি কম্প্রেসার"],
        latin: [],
      };
      const shop = buildDictionary([...GLOSSARY, ...catalogEntries(catalog), added]);
      const first = await turn(car, fresh(), { calls: [{ name: "find_parts", arguments: carArgs }] }, shop);
      expect(first.reply).toBe("কোন পার্ট লাগবে?");
      const second = await turn(
        other,
        first.outcome.state,
        { calls: [{ name: "find_parts", arguments: otherArgs }] },
        shop,
      );
      expect(second.reply).toContain("ফিল্ডার");
      expect(second.reply).toContain("C-2 তাকে");
      expect(second.reply).not.toContain("এক্সিও");
    },
  );

  it("finds nothing for a year the name's range leaves out", async () => {
    const result = await findParts(
      input({ part_type: "power steering pump", vehicle: "axio", year: "2010" }),
    );
    expect(result.kind).toBe("none");
  });

  it.each([
    { style: "Bangla", said: "রহমান অটো ওয়ার্কসের বাকি কত?" },
    { style: "Banglish", said: "rahman auto works er baki koto?" },
  ])("knows a customer by the Bangla name the app keeps, or the English one ($style)", ({ said }) => {
    const rahman = catalog.customers.find((customer) => customer.name === "Rahman Auto Works")!;
    expect(rahman.nameBn).toBe("রহমান অটো ওয়ার্কস");
    const names = catalog.customers.flatMap((customer) => [
      { kind: "customer", name: customer.name },
      ...(customer.nameBn ? [{ kind: "customer", name: customer.nameBn }] : []),
    ]);
    expect(namesInText(said, names, dictionary)[0]?.name).toMatch(/^(Rahman Auto Works|রহমান অটো ওয়ার্কস)$/);
    const name = said.replace(/(er |ের )?বাকি.*|( er)? baki.*/, "").trim();
    const match = resolveCustomer(name, [], catalog.customers, dictionary);
    expect(match.decision).toBe("understood");
    expect(match.candidates[0]?.customer.hostId).toBe(rahman.hostId);
  });

  it("bills a customer at its own level, but says a level only when the question names it (D141)", () => {
    // Shop B's own word for Rahman Auto Works' level is still read, for the bill the app makes.
    expect(
      customerTier(catalog.customers.find((customer) => customer.name === "Rahman Auto Works")!.attrs),
    ).toBe("garage");
    const pad = {
      hostPartId: "1",
      name: "x",
      nameBn: null,
      quality: "genuine",
      position: "front",
      brand: null,
      unit: "set",
      stock: 5,
      retailTaka: 4500n,
      garageTaka: 4200n,
      wholesaleTaka: null,
      rack: "B-3",
      fitmentVerified: true,
    };
    const context = (text: string): PartsContext => ({
      vehicle: "Toyota Axio",
      year: 2014,
      partType: "Brake Pad",
      position: "front",
      tier: priceLevelIn(text) ?? "retail",
    });
    expect(partsAnswer([pad], context("রহমান অটো ওয়ার্কসের জন্য এক্সিওর প্যাড আছে?"))).toMatch(
      /৪,৫০০ টাকা, B-3 তাকে।$/,
    );
    expect(partsAnswer([pad], context("এক্সিওর প্যাডের গ্যারেজের দাম কত?"))).toMatch(
      /৪,২০০ টাকা, B-3 তাকে। দাম গ্যারেজ রেটে।$/,
    );
    expect(partsAnswer([pad], context("axio r pad er garage dam koto?"))).toMatch(/দাম গ্যারেজ রেটে।$/);
  });

  it("values the stock per part with the newest cost, over both branches", async () => {
    // 5 x 3,200 + 6 x 1,400 + 2 x 4,000 + 1 x 15,000 + 1 x 7,000 + 12.5 x 700 + 3 x 1,100
    expect(await pools.readOnly(db, (run) => stockValue(shopBMap, run))).toBe(66450n);
  });

  it("answers a due through the MySQL guard, and refuses a write", async () => {
    const read = (sql: string) => pools.readOnly(db, (run) => runReadQuery(shopBMap, run, sql));
    const due = await read("SELECT party_name, balance FROM parties WHERE party_name = 'Bhai Bhai Traders'");
    expect(due.rows).toEqual([{ party_name: "Bhai Bhai Traders", balance: 30000n }]);
    const deleted = await read("SELECT COUNT(*) AS n FROM parties WHERE party_name = 'Old Party'");
    expect(deleted.rows[0]?.n).toBe(0); // a deleted party is never read
    await expect(read("DELETE FROM parties")).rejects.toBeInstanceOf(ReadQueryRejected);
  });
});
