import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appWordsOf, customerTier, readCatalog, toCatalog, type Catalog } from "../src/host/catalog";
import { introspect } from "../src/host/introspect";
import { HostPools, type HostDb } from "../src/host/pool";
import { ReadQueryRejected, runReadQuery } from "../src/host/read-query";
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
    expect(catalog.vehicles).toHaveLength(4);
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

  it("answers a due through the MySQL guard, and refuses a write", async () => {
    const read = (sql: string) => pools.readOnly(db, (run) => runReadQuery(shopBMap, run, sql));
    const due = await read("SELECT party_name, balance FROM parties WHERE party_name = 'Bhai Bhai Traders'");
    expect(due.rows).toEqual([{ party_name: "Bhai Bhai Traders", balance: 30000n }]);
    const deleted = await read("SELECT COUNT(*) AS n FROM parties WHERE party_name = 'Old Party'");
    expect(deleted.rows[0]?.n).toBe(0); // a deleted party is never read
    await expect(read("DELETE FROM parties")).rejects.toBeInstanceOf(ReadQueryRejected);
  });
});
