import { buildDictionary, separatingSlot } from "@dokaanbondhu/core";
import pg from "pg";
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
    // A status column's values come from the table's CHECK rule too, so "reversed" is known before any reversal.
    const status = (table: string) =>
      tables.find((candidate) => candidate.name === table)!.columns.find((column) => column.name === "status")
        ?.values ?? [];
    expect(status("customer_payments")).toContain("reversed");
    expect(status("purchases")).toContain("reversed");
    expect(status("sales")).toContain("void");
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

  it("finds both front pads for a 2014 Axio, separated by quality, with price in taka, stock and rack", async () => {
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
    expect(genuine).toMatchObject({ retailTaka: 4500n, stock: 3, rack: "B-3", fitmentVerified: true });
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

  // D122: a part type that only sounds like one ("power steering pump" like Piston Ring) is asked, never taken.
  it.each([
    { style: "Bangla", part_type: "পাওয়ার স্টিয়ারিং পাম্প" },
    { style: "Banglish", part_type: "power steering pump" },
  ])("asks the part when a name only sounds like a type it stocks ($style)", async ({ part_type }) => {
    const result = await findParts(input({ part_type, vehicle: "axio", year: "2014" }));
    expect(result).toMatchObject({ kind: "ask", slot: "part_type" });
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

  it("checks a part number said with a car against that car's recorded fitment (D94)", async () => {
    const fits = await findParts(input({ part_number: "04465-10010", vehicle: "axio", year: "2014" }));
    expect(fits).toMatchObject({ kind: "rows", resolved: { vehicle: "Toyota Axio", year: 2014 } });
    const notRecorded = await findParts(
      input({ part_number: "AN-220WK", vehicle: "bluebird sylphy", year: "2011" }),
    );
    expect(notRecorded).toMatchObject({ kind: "none", resolved: { partType: "AN-220WK" } });
    if (notRecorded.kind === "none") expect(notRecorded.mentioned.map((row) => row.name).length).toBe(1);
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

  it("never counts a reversed payment, a reversed purchase or its lines, whatever SQL the LLM writes (D17, D94)", async () => {
    // One completed payment and purchase are marked reversed for this test and put back after (the write tests leave
    // reversals of their own, so the first rows may be reversed already).
    const owner = new pg.Client({ connectionString: migrationUrl });
    await owner.connect();
    const [payment] = (
      await owner.query("SELECT id FROM customer_payments WHERE status = 'completed' ORDER BY id LIMIT 1")
    ).rows;
    const [purchase] = (
      await owner.query("SELECT id FROM purchases WHERE status = 'completed' ORDER BY id LIMIT 1")
    ).rows;
    const read = (sql: string) => pools.readOnly(db, (run) => runReadQuery(geargridMap, run, sql));
    const paymentSql = `SELECT COUNT(*) AS n FROM customer_payments WHERE id = '${payment.id}'`;
    const purchaseSql = `SELECT COUNT(*) AS n FROM purchases WHERE id = '${purchase.id}'`;
    const linesSql = `SELECT COUNT(*) AS n FROM purchase_items WHERE purchase_id = '${purchase.id}'`;
    try {
      expect((await read(paymentSql)).rows[0]?.n).toBe(1);
      expect((await read(purchaseSql)).rows[0]?.n).toBe(1);
      expect(Number((await read(linesSql)).rows[0]?.n)).toBeGreaterThan(0);
      await owner.query("UPDATE customer_payments SET status = 'reversed' WHERE id = $1", [payment.id]);
      await owner.query("UPDATE purchases SET status = 'reversed' WHERE id = $1", [purchase.id]);
      expect((await read(paymentSql)).rows[0]?.n).toBe(0);
      expect((await read(purchaseSql)).rows[0]?.n).toBe(0);
      expect((await read(linesSql)).rows[0]?.n).toBe(0); // the lines of a reversed purchase, read on their own
    } finally {
      await owner.query("UPDATE customer_payments SET status = 'completed' WHERE id = $1", [payment.id]);
      await owner.query("UPDATE purchases SET status = 'completed' WHERE id = $1", [purchase.id]);
      await owner.end();
    }
  });

  it("answers other reads through the guard: a due, and low stock without inactive or deleted parts", async () => {
    const due = await pools.readOnly(db, (run) =>
      runReadQuery(geargridMap, run, "SELECT name, due_balance FROM customers WHERE name = 'Rahim Motors'"),
    );
    expect(due.rows).toEqual([{ name: "Rahim Motors", due_balance: 19200n }]);
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
        // avg_cost is whole taka (D92); the sum is rounded once to the taka (D110)
        text: "SELECT ROUND(SUM(GREATEST(s.quantity, 0) * p.avg_cost)) AS taka FROM stock_levels s JOIN parts p ON p.id = s.part_id WHERE p.avg_cost > 0",
        values: [],
      }),
    );
    expect(value).toBe(BigInt(String(direct?.taka)));
  });
});
