import {
  buildDictionary,
  catalogEntries,
  GLOSSARY,
  matchVehicles,
  partsAnswer,
  type Dictionary,
  type PartsContext,
} from "@dokaanbondhu/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appWordsOf, customerTier, readCatalog, toCatalog, type Catalog } from "../src/host/catalog";
import { findParts, type FindPartsInput } from "../src/host/find-parts";
import { introspect } from "../src/host/introspect";
import { HostPools, type HostDb } from "../src/host/pool";
import { ReadQueryRejected, runReadQuery } from "../src/host/read-query";
import { stockValue } from "../src/host/reports";
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

  const input = (query: FindPartsInput["query"]): FindPartsInput => ({
    query,
    hypotheses: [],
    map: shopBMap,
    run: (built) => pools.readOnly(db, (run) => run(built)),
    catalog,
    dictionary,
    fitmentExtra: [],
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
