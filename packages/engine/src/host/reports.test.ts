import { describe, expect, it } from "vitest";
import { getReport, proposeStockValue, type ReportInput } from "./reports";
import type { FieldMap } from "./schema-map";
import { testMap } from "./test-map";

function withCost() {
  const map = testMap();
  const cost: FieldMap = {
    conceptField: "cost",
    hostTable: "items",
    hostColumn: "avg_cost",
    dataType: null,
    idType: null,
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
    { quantity: "3", cost: "3600" }, // 3 sets at 3,600 taka
    { quantity: "1.5", cost: "101" }, // 1.5 litres at 101 taka: 151.5, rounded once at the end
    { quantity: "2.5", cost: "99.60" }, // a price with a fraction is read as 100 taka (D110)
    { quantity: "-2", cost: "500" }, // negative stock counts as zero
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

  it("uses a confirmed formula: quantity times average cost, negative stock as zero, in whole taka", async () => {
    const formula = { ...proposeStockValue(withCost())!, confirmed: true };
    expect(await getReport(base({ formulas: [formula] }))).toEqual({
      kind: "figure",
      name: "stock_value",
      taka: 11202n, // 10,800 + 151.5 + 250 = 11,201.5, rounded once
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
        callHost: async () => 12345n,
      }),
    );
    expect(result).toMatchObject({ kind: "figure", taka: 12345n, source: "host" });
  });
});
