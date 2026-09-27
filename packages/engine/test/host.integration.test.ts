import { buildDictionary, separatingSlot } from "@dokaanbondhu/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readCatalog, toCatalog, type Catalog } from "../src/host/catalog";
import { findParts, type FindPartsInput } from "../src/host/find-parts";
import { introspect } from "../src/host/introspect";
import { runReadQuery } from "../src/host/read-query";
import { stockValue } from "../src/host/reports";
import { HostPools, type HostDb } from "../src/host/pool";
import { buildQuery } from "../src/host/sql";
import { geargridMap } from "./geargrid-map";

// Host integration against the CI copy of GearGrid (migrated, roles, seeded), read as the read-only role
// dokaanbondhu_ro, exactly as a shop's host is read (spec 11; P1). Only against the local CI container.

const migrationUrl = process.env.MIGRATION_DATABASE_URL ?? "";
const isLocal = (() => {
  try {
    return ["localhost", "127.0.0.1"].includes(new URL(migrationUrl).hostname);
  } catch {
    return false;
  }
})();
if (process.env.CI === "true" && !isLocal)
  throw new Error("host integration tests need the local CI database");

describe.skipIf(!isLocal)("host integration on GearGrid's seed", () => {
  const pools = new HostPools();
  let db: HostDb;
  let catalog: Catalog;
  const dictionary = buildDictionary();

  const input = (query: FindPartsInput["query"]): FindPartsInput => ({
    query,
    hypotheses: [],
    map: geargridMap,
    run: (built) => pools.readOnly(db, (run) => run(built)),
    catalog,
    dictionary,
    fitmentExtra: [],
    rackExtra: new Map(),
  });
  const byNumber = (number: string) =>
    catalog.parts.find((part) => part.partNumbers.includes(number))!.hostId;

  beforeAll(async () => {
    const url = new URL(migrationUrl);
    db = {
      id: "geargrid-ci",
      dialect: "postgres",
      host: url.hostname,
      port: Number(url.port || 5432),
      database: url.pathname.slice(1),
      username: "dokaanbondhu_ro",
      password: process.env.DOKAAN_RO_PASSWORD ?? "",
      sslMode: "disable",
      sslCa: null,
      poolMax: 2,
    };
    catalog = toCatalog(await pools.readOnly(db, (run) => readCatalog(run, geargridMap)));
  });

  afterAll(async () => {
    await pools.closeAll();
  });

  it("introspects the tables it may read, with keys, through the read-only role", async () => {
    const tables = await pools.readOnly(db, (run) => introspect(run, "postgres"));
    const names = tables.map((table) => table.name);
    expect(names).toContain("parts");
    expect(names).not.toContain("users"); // not granted to the read-only role
    const fitments = tables.find((table) => table.name === "fitments")!;
    expect(fitments.columns.find((column) => column.name === "part_id")?.references).toEqual({
      table: "parts",
      column: "id",
    });
    expect(tables.find((table) => table.name === "parts")!.samples.length).toBe(5);
  });

  it("reads the catalog through the map: active parts with all their numbers, vehicles, customers, suppliers", () => {
    expect(catalog.parts).toHaveLength(237); // 239 minus one inactive and one deleted part
    expect(catalog.vehicles).toHaveLength(40);
    expect(catalog.customers).toHaveLength(30);
    expect(catalog.suppliers).toHaveLength(5);
    const pad = catalog.parts.find((part) => part.partNumbers.includes("AN-101WK"))!;
    expect(pad.partNumbers).toEqual(expect.arrayContaining(["AN-101WK"]));
    expect(pad.attrs).toMatchObject({ quality: "aftermarket", brand: "Akebono", position: "front" });
    const noah = catalog.vehicles.filter((vehicle) => vehicle.model === "Noah");
    expect(noah.map((vehicle) => vehicle.yearFrom).sort()).toEqual([2001, 2007, 2014]);
  });

  it("finds both front pads for a 2014 Axio, separated by quality, with price in paisa, stock and rack", async () => {
    const result = await findParts(
      input({ part_type: "সামনের প্যাড", vehicle: "এক্সিও", year: "২০১৪", position: "সামনের" }),
    );
    expect(result.kind).toBe("rows");
    if (result.kind !== "rows") return;
    // 04465-10010 is also the aftermarket pad's cross-reference number, so the genuine row is found by its quality
    const genuine = result.rows.find((row) => row.quality === "genuine")!;
    expect(catalog.parts.find((part) => part.hostId === genuine.hostPartId)?.partNumbers).toContain(
      "04465-10010",
    );
    expect(genuine).toMatchObject({ retailPaisa: 450000n, stock: 3, rack: "B-3", fitmentVerified: true });
    expect(result.rows.map((row) => row.quality).sort()).toEqual(["aftermarket", "genuine"]);
    expect(separatingSlot(result.rows)?.slot).toBe("quality");
  });

  it("takes the brake shoe pair when a car has no rear pads recorded", async () => {
    const result = await findParts(
      input({ part_type: "brake pad", vehicle: "axio", year: "2014", position: "rear" }),
    );
    expect(result).toMatchObject({ kind: "rows", pairUsed: "Brake Shoe" });
    if (result.kind === "rows")
      expect(result.rows.map((row) => row.hostPartId)).toEqual([byNumber("AN-108WK")]);
  });

  it("asks the year for a Noah starter, and finds the one for a 2016 Noah", async () => {
    expect(await findParts(input({ part_type: "সেলফ", vehicle: "নোয়া" }))).toMatchObject({
      kind: "ask",
      slot: "year",
      options: expect.arrayContaining(["2001-2007", "2007-2013", "2014-2021"]),
    });
    const result = await findParts(input({ part_type: "self", vehicle: "noah", year: "16" }));
    expect(result.kind).toBe("rows");
    if (result.kind === "rows") expect(result.rows.map((row) => row.quality)).toEqual(["genuine"]);
  });

  it("uses an exact part number and only offers a near one", async () => {
    const exact = await findParts(input({ part_number: "04465 10010" }));
    expect(exact.kind).toBe("rows");
    expect(await findParts(input({ part_number: "04465-10019" }))).toMatchObject({
      kind: "ask",
      slot: "part_number",
      options: expect.arrayContaining(["04465-10010"]),
    });
  });

  it("never asserts a fitment it has no row for", async () => {
    const result = await findParts(input({ part_type: "horn", vehicle: "axio", year: "2014" }));
    expect(result.kind).toBe("none");
  });

  it("never counts the lines of a voided sale (D17)", async () => {
    const lines = await pools.readOnly(db, (run) =>
      run(
        buildQuery(geargridMap, {
          from: { concept: "SaleItem", alias: "l" },
          select: [{ ref: { alias: "l", field: "sale_id" }, as: "lines", aggregate: "count" }],
        }),
      ),
    );
    const all = await pools.readOnly(db, (run) =>
      run({
        text: "SELECT count(*) AS n FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE s.status <> 'void' AND si.deleted_at IS NULL",
        values: [],
      }),
    );
    expect(Number(lines[0]?.lines)).toBe(Number(all[0]?.n));
  });

  it("answers other reads through the guard: a due, and low stock without inactive or deleted parts", async () => {
    const due = await pools.readOnly(db, (run) =>
      runReadQuery(geargridMap, run, "SELECT name, due_balance FROM customers WHERE name = 'Rahim Motors'"),
    );
    expect(due.rows).toEqual([{ name: "Rahim Motors", due_balance: 1920000n }]);
    const low = await pools.readOnly(db, (run) =>
      runReadQuery(
        geargridMap,
        run,
        "SELECT p.name_en, s.quantity FROM parts p JOIN stock_levels s ON s.part_id = p.id WHERE s.quantity <= p.reorder_level",
      ),
    );
    expect(low.rows).toHaveLength(8);
    expect(low.columns.find((column) => column.key === "quantity")).toMatchObject({ kind: "quantity" });
  });

  it("computes the stock value exactly, as a direct sum would", async () => {
    const value = await pools.readOnly(db, (run) => stockValue(geargridMap, run));
    const [direct] = await pools.readOnly(db, (run) =>
      run({
        text: "SELECT SUM(ROUND(GREATEST(s.quantity, 0) * p.avg_cost)) AS paisa FROM stock_levels s JOIN parts p ON p.id = s.part_id WHERE p.avg_cost > 0",
        values: [],
      }),
    );
    expect(value).toBe(BigInt(String(direct?.paisa)));
  });
});
