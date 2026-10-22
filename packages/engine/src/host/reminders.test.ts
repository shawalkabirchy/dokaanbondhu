import { describe, expect, it } from "vitest";
import { geargridMap } from "../../test/geargrid-map";
import type { Catalog } from "./catalog";
import { lowStock, oldDues } from "./reminders";
import type { SchemaMap } from "./schema-map";

// D194: the reminders read only what the app's confirmed map has; what it lacks changes the rule, never a guess.

const NOW = new Date("2026-10-15T12:00:00+06:00");
const DAY_MS = 86_400_000;

const catalog: Catalog = {
  syncedAt: null,
  parts: ["a", "b", "c"].map((id) => ({
    hostId: id,
    name: `Part ${id}`,
    nameBn: null,
    partNumbers: [],
    category: null,
    brand: null,
    attrs: {},
  })),
  vehicles: [],
  customers: [{ hostId: "c1", name: "Rahim Motors", nameBn: "রহিম মোটরস", attrs: {} }],
  suppliers: [],
};

/** The map without some fields, or without whole concepts. */
function without(drop: string[]): SchemaMap {
  const map = structuredClone(geargridMap);
  for (const name of drop) {
    const [concept, field] = name.split(".") as [keyof SchemaMap["entities"], string | undefined];
    if (field) delete map.entities[concept]!.fields[field];
    else delete map.entities[concept];
  }
  return map;
}

/** Part a at 0 and sold 20 days ago, b at 0 never sold, c at 3; each with a reorder level of 5 when asked. */
function runner(options: { reorder?: number } = {}) {
  const queries: string[] = [];
  const run = async (query: { text: string; values: unknown[] }) => {
    queries.push(query.text);
    if (query.text.includes('"low_part"'))
      return [
        { low_part: "a", stock: "0", reorder: String(options.reorder ?? 0) },
        { low_part: "b", stock: "0", reorder: String(options.reorder ?? 0) },
        { low_part: "c", stock: "3", reorder: String(options.reorder ?? 0) },
        { low_part: "gone", stock: "0", reorder: "0" },
      ];
    if (query.text.includes('"sold_part"')) return [{ sold_part: "a" }];
    if (query.text.includes('"owing_customer"')) return [{ owing_customer: "c1", due: "900" }];
    if (query.text.includes('"due_customer"'))
      return [
        { due_customer: "c1", time: new Date(NOW.getTime() - 5 * DAY_MS), sale_due: "400" },
        { due_customer: "c1", time: new Date(NOW.getTime() - 40 * DAY_MS), sale_due: "300" },
        { due_customer: "c1", time: new Date(NOW.getTime() - 60 * DAY_MS), sale_due: "700" },
      ];
    return [];
  };
  return { run, queries };
}

describe("parts running low (D194)", () => {
  it("at or below the reorder level when the app keeps one; parts not in the catalog are left out", async () => {
    const { run } = runner({ reorder: 5 });
    const lines = await lowStock({ map: geargridMap, run }, catalog, NOW);
    expect(lines?.map((line) => [line.hostPartId, line.stock, line.reorderLevel])).toEqual([
      ["a", 0, 5],
      ["b", 0, 5],
      ["c", 3, 5],
    ]);
  });

  it("without a reorder level: at or below zero and sold in the last 90 days", async () => {
    const { run, queries } = runner();
    const lines = await lowStock({ map: without(["StockItem.reorder_level"]), run }, catalog, NOW);
    expect(lines?.map((line) => line.hostPartId)).toEqual(["a"]);
    expect(lines?.[0]?.reorderLevel).toBeNull();
    expect(queries.some((text) => text.includes("reorder_level"))).toBe(false);
  });

  it("an app without sales: every part at or below zero", async () => {
    const { run } = runner();
    const lines = await lowStock(
      { map: without(["StockItem.reorder_level", "Sale", "SaleItem"]), run },
      catalog,
      NOW,
    );
    expect(lines?.map((line) => line.hostPartId)).toEqual(["a", "b"]);
  });

  it("an app whose stock is not mapped: none (null)", async () => {
    const { run, queries } = runner();
    expect(await lowStock({ map: without(["StockItem"]), run }, catalog, NOW)).toBeNull();
    expect(queries).toHaveLength(0);
  });
});

describe("old dues (D194)", () => {
  it("the due laid on the newest sales first; the part from a sale over 30 days old is old", async () => {
    const { run } = runner();
    const lines = await oldDues({ map: geargridMap, run }, catalog, NOW);
    // 900 due: 400 from 5 days ago, then 300 from 40 days, then 200 of the 700 from 60 days: 500 is old.
    expect(lines).toEqual([
      expect.objectContaining({
        hostId: "c1",
        due: 900n,
        old: 500n,
        since: new Date(NOW.getTime() - 60 * DAY_MS),
      }),
    ]);
  });

  it("over a different number of days", async () => {
    const { run } = runner();
    const lines = await oldDues({ map: geargridMap, run }, catalog, NOW, 50);
    expect(lines?.[0]?.old).toBe(200n);
  });

  it("an app without its sales' dues: none (null)", async () => {
    const { run, queries } = runner();
    expect(await oldDues({ map: without(["Sale.due"]), run }, catalog, NOW)).toBeNull();
    expect(await oldDues({ map: without(["Customer.due_balance"]), run }, catalog, NOW)).toBeNull();
    expect(queries).toHaveLength(0);
  });
});
