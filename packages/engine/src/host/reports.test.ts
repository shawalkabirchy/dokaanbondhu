import { describe, expect, it } from "vitest";
import { getReport, proposeStockValue, type ReportInput } from "./reports";
import type { FieldMap } from "./schema-map";
import { testMap } from "./test-map";

function withCost() {
  const map = testMap();
  const cost: FieldMap = {
    conceptField: "cost",
    hostTable: "items",
    hostColumn: "cost_paisa",
    dataType: null,
    idType: null,
    valueScale: 100,
    confirmed: true,
  };
  map.entities.Price!.fields.cost = cost;
  return map;
}

const base = (overrides: Partial<ReportInput>): ReportInput => ({
  name: "stock_value",
  from: null,
  to: null,
  map: withCost(),
  run: async () => [
    { quantity: "3000", cost: "360000" }, // 3 sets at 3,600 taka (quantity in thousandths)
    { quantity: "1500", cost: "10000" }, // 1.5 at 100 taka
    { quantity: "-2000", cost: "50000" }, // negative stock counts as zero
  ],
  formulas: [],
  hostReports: [],
  ...overrides,
});

describe("reports (spec 11.7)", () => {
  it("proposes the stock-value formula only when both fields are mapped", () => {
    expect(proposeStockValue(testMap())).toBeNull();
    expect(proposeStockValue(withCost())).toMatchObject({ name: "stock_value", confirmed: false });
  });

  it("uses a confirmed formula: quantity times average cost, negative stock as zero, exact paisa", async () => {
    const formula = { ...proposeStockValue(withCost())!, confirmed: true };
    expect(await getReport(base({ formulas: [formula] }))).toEqual({
      kind: "figure",
      name: "stock_value",
      paisa: 3n * 360000n + 15000n,
      from: null,
      to: null,
      source: "formula",
    });
  });

  it("says see this in your app without a host endpoint or a confirmed formula", async () => {
    expect(await getReport(base({}))).toEqual({ kind: "see_in_app", name: "stock_value" });
    expect(await getReport(base({ name: "profit_loss" }))).toEqual({
      kind: "see_in_app",
      name: "profit_loss",
    });
  });

  it("asks the host's own report endpoint first, when its feature list names one", async () => {
    const result = await getReport(
      base({
        name: "profit_loss",
        from: "2026-09-01",
        to: "2026-09-30",
        hostReports: ["profit_loss"],
        callHost: async () => 1234500n,
      }),
    );
    expect(result).toMatchObject({ kind: "figure", paisa: 1234500n, source: "host" });
  });
});
