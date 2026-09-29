import { describe, expect, it } from "vitest";
import { guardReadQuery, ReadQueryRejected, runReadQuery } from "./read-query";
import { testMap } from "./test-map";

const map = testMap();

describe("run_read_query guard (spec 11.6)", () => {
  it("replaces every table read by its filtered version, parents' filters through their joins", () => {
    const { sql } = guardReadQuery(
      map,
      "SELECT i.title, SUM(l.qty) AS sold FROM items i JOIN bill_lines l ON l.item_id = i.id GROUP BY i.title",
    );
    expect(sql.startsWith("WITH ")).toBe(true);
    expect(sql).toContain(
      '"bill_lines" AS (SELECT t.* FROM "bill_lines" AS t LEFT JOIN "bills" AS p0 ON t."bill_id" = p0."id" ' +
        'WHERE (p0."id" IS NULL OR (p0."state" IS NULL OR p0."state" <> \'void\')))',
    );
    expect(sql).toContain(
      '"items" AS (SELECT t.* FROM "items" AS t WHERE t."deleted_at" IS NULL AND t."is_active" IS TRUE)',
    );
    expect(sql).toMatch(/LIMIT 200$/);
  });

  it("gives a child table its entity's filters through the link: numbers of an inactive part are left out", () => {
    const { sql } = guardReadQuery(map, "SELECT code FROM item_codes");
    expect(sql).toContain(
      '"item_codes" AS (SELECT t.* FROM "item_codes" AS t LEFT JOIN "items" AS p0 ON p0."id" = t."item_id" ' +
        'WHERE t."deleted_at" IS NULL AND (p0."id" IS NULL OR p0."deleted_at" IS NULL) ' +
        'AND (p0."id" IS NULL OR p0."is_active" IS TRUE))',
    );
  });

  it("caps a larger LIMIT and keeps a smaller one", () => {
    expect(guardReadQuery(map, "SELECT title FROM items LIMIT 5000").sql).toMatch(/LIMIT 200$/);
    expect(guardReadQuery(map, "SELECT title FROM items LIMIT 10").sql).toMatch(/LIMIT 10$/);
  });

  it("refuses anything but one plain SELECT over confirmed tables and columns", () => {
    const refused = [
      "SELECT title FROM items; DELETE FROM items",
      "UPDATE items SET title = 'x'",
      "DELETE FROM items",
      "SELECT title INTO copy FROM items",
      "SELECT title FROM items FOR UPDATE",
      "SELECT title FROM public.items",
      "SELECT name FROM users",
      "SELECT password FROM items",
      "SELECT * FROM items",
      "SELECT pg_sleep(5)",
      "SELECT title FROM items WHERE set_config('x', 'y', false) = 'y'",
      "WITH x AS (SELECT title FROM items) SELECT title FROM x",
      "not sql at all",
    ];
    for (const sql of refused) expect(() => guardReadQuery(map, sql), sql).toThrow(ReadQueryRejected);
  });

  it("gives result columns their lineage: mapped money and quantities, COUNT a count, others unmapped", () => {
    const { columns } = guardReadQuery(
      map,
      "SELECT c.name, c.due, SUM(l.qty) AS sold, COUNT(l.bill_id) AS lines, upper(c.name) AS loud " +
        "FROM clients c JOIN bill_lines l ON l.bill_id = c.id GROUP BY c.name, c.due",
    );
    expect(columns).toEqual([
      { key: "name", kind: "text" },
      { key: "due", kind: "money" },
      { key: "sold", kind: "quantity" },
      { key: "lines", kind: "count" },
      { key: "loud", kind: "unmapped" },
    ]);
  });

  it("returns money in whole taka, counts as numbers, and runs only the guarded SQL", async () => {
    const seen: string[] = [];
    const result = await runReadQuery(
      map,
      async ({ text }) => {
        seen.push(text);
        return [{ name: "Rahim Motors", due: "19200.40", lines: "3" }];
      },
      "SELECT name, due, COUNT(id) AS lines FROM clients GROUP BY name, due",
    );
    expect(seen[0]).toMatch(/^WITH "clients" AS/);
    expect(result.rows).toEqual([{ name: "Rahim Motors", due: 19200n, lines: 3 }]); // a fraction rounds to the taka
    expect(result.truncated).toBe(false);
  });
});
