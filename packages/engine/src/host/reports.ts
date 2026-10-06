import { roundTaka } from "@dokaanbondhu/core";
import { newerPrice, toTaka, toUnits } from "./find-parts";
import type { Row, RunQuery } from "./pool";
import { hasField, type SchemaMap } from "./schema-map";
import { buildQuery } from "./sql";

// Reports: profit, cash book, stock value (spec 11.7, D44). Figures that need the host's accounting rules are never
// written as SQL by the LLM: the host's report endpoint first, then an owner-confirmed formula, otherwise "see this in
// your app". This semester only stock_value has a formula (a should have).

export const REPORT_NAMES = ["stock_value", "profit_loss", "cash_book"] as const;
export type ReportName = (typeof REPORT_NAMES)[number];

export interface ReportFormula {
  name: ReportName;
  definition: unknown;
  confirmed: boolean;
}

/** The host's own report endpoint, when its feature list names one: the figure in whole taka. */
export type HostReportCall = (name: ReportName, from: string | null, to: string | null) => Promise<bigint>;

export type ReportResult =
  | {
      kind: "figure";
      name: ReportName;
      taka: bigint;
      from: string | null;
      to: string | null;
      source: "host" | "formula";
    }
  | { kind: "see_in_app"; name: ReportName };

const STOCK_VALUE = { sum_of_product: ["StockItem.quantity", "Price.cost"] } as const;

/** The stock-value formula, when both fields are mapped: proposed in setup with its current result (spec 11.7). */
export function proposeStockValue(map: SchemaMap): ReportFormula | null {
  const ready =
    ["part_id", "quantity"].every((field) => hasField(map, "StockItem", field)) &&
    ["part_id", "cost"].every((field) => hasField(map, "Price", field));
  return ready ? { name: "stock_value", definition: STOCK_VALUE, confirmed: false } : null;
}

/**
 * Sum over parts of stock quantity times cost, a part's stock added up over all its stock rows (branches, godowns) and
 * its cost the newest of a price history (D122), negative stock counted as zero, in whole taka: summed exactly
 * (quantities carry at most three decimals) and rounded once (D110).
 */
export async function stockValue(map: SchemaMap, run: RunQuery): Promise<bigint> {
  const stock = await run(
    buildQuery(map, {
      from: { concept: "StockItem", alias: "s" },
      select: [
        { ref: { alias: "s", field: "part_id" }, as: "part_id" },
        { ref: { alias: "s", field: "quantity" }, as: "quantity", aggregate: "sum" },
      ],
      groupBy: [{ alias: "s", field: "part_id" }],
    }),
  );
  const prices = await run(
    buildQuery(map, {
      from: { concept: "Price", alias: "pr" },
      select: [
        { ref: { alias: "pr", field: "part_id" }, as: "part_id" },
        { ref: { alias: "pr", field: "cost" }, as: "cost" },
        ...(hasField(map, "Price", "valid_from")
          ? [{ ref: { alias: "pr", field: "valid_from" }, as: "valid_from" }]
          : []),
      ],
    }),
  );
  const costs = new Map<string, Row>();
  for (const row of prices) costs.set(String(row.part_id), newerPrice(costs.get(String(row.part_id)), row));
  let milliTaka = 0n;
  for (const row of stock) {
    const quantity = toUnits(row.quantity) ?? 0;
    const cost = toTaka(costs.get(String(row.part_id))?.cost) ?? 0n;
    if (quantity <= 0 || cost <= 0n) continue;
    milliTaka += BigInt(Math.round(quantity * 1000)) * cost;
  }
  return roundTaka(milliTaka, 1000n);
}

export interface ReportInput {
  name: ReportName;
  from: string | null;
  to: string | null;
  map: SchemaMap;
  run: RunQuery;
  formulas: ReportFormula[];
  /** The report names the host's feature list gives a report_path for. */
  hostReports: ReportName[];
  callHost?: HostReportCall;
}

export async function getReport(input: ReportInput): Promise<ReportResult> {
  const { name, from, to } = input;
  if (input.hostReports.includes(name) && input.callHost) {
    return { kind: "figure", name, taka: await input.callHost(name, from, to), from, to, source: "host" };
  }
  const formula = input.formulas.find((candidate) => candidate.name === name && candidate.confirmed);
  if (
    formula &&
    name === "stock_value" &&
    JSON.stringify(formula.definition) === JSON.stringify(STOCK_VALUE)
  ) {
    return {
      kind: "figure",
      name,
      taka: await stockValue(input.map, input.run),
      from: null,
      to: null,
      source: "formula",
    };
  }
  return { kind: "see_in_app", name };
}
