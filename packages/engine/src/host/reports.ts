import { toPaisa, toUnits } from "./find-parts";
import type { RunQuery } from "./pool";
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

/** The host's own report endpoint, when its feature list names one: the figure in paisa. */
export type HostReportCall = (name: ReportName, from: string | null, to: string | null) => Promise<bigint>;

export type ReportResult =
  | {
      kind: "figure";
      name: ReportName;
      paisa: bigint;
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

/** Sum over parts of stock quantity times average cost, negative stock counted as zero, in exact paisa. */
export async function stockValue(map: SchemaMap, run: RunQuery): Promise<bigint> {
  const built = buildQuery(map, {
    from: { concept: "StockItem", alias: "s" },
    joins: [
      {
        entity: { concept: "Price", alias: "pr" },
        kind: "inner",
        on: [{ left: { alias: "pr", field: "part_id" }, right: { alias: "s", field: "part_id" } }],
      },
    ],
    select: [
      { ref: { alias: "s", field: "quantity" }, as: "quantity" },
      { ref: { alias: "pr", field: "cost" }, as: "cost" },
    ],
  });
  const scale = (as: string) => built.columns.find((column) => column.as === as)?.valueScale ?? 1;
  let total = 0n;
  for (const row of await run(built)) {
    const quantity = toUnits(row.quantity, scale("quantity")) ?? 0;
    const cost = toPaisa(row.cost, scale("cost")) ?? 0n;
    if (quantity <= 0 || cost <= 0n) continue;
    const milli = BigInt(Math.round(quantity * 1000)); // quantities carry at most three decimals
    total += (milli * cost + 500n) / 1000n;
  }
  return total;
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
    return { kind: "figure", name, paisa: await input.callHost(name, from, to), from, to, source: "host" };
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
      paisa: await stockValue(input.map, input.run),
      from: null,
      to: null,
      source: "formula",
    };
  }
  return { kind: "see_in_app", name };
}
