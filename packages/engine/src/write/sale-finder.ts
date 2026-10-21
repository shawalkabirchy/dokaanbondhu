import { toTaka, toUnits } from "../host/find-parts";
import { hasField } from "../host/schema-map";
import { buildQuery, type Condition } from "../host/sql";
import type { ReadPath } from "./verify";

// The sale finder (spec 10.7; D169): the sale a return belongs to, through the read-only path. That customer's sales
// of the part in the last 30 days (a walk-in's: the sales without a customer), newest first, each line with what is
// left to return after earlier returns. A field the map lacks is never guessed: without the sales the finder answers
// null, and without returns every line counts as not returned yet. Nothing here names a host.

export const SALE_DAYS = 30;

export interface SaleLine {
  saleId: string;
  /** The line's own ID, when the map has it (a host that returns by line needs it). */
  lineId: string | null;
  /** When the sale was, ISO. */
  time: string;
  /** Units sold on the line, and what is left after earlier returns. */
  sold: number;
  left: number;
  /** The line's price of one in whole taka, when mapped. */
  unitPrice: number | null;
  /** What was still due on the whole sale, when mapped (0: paid in full). */
  saleDue: number | null;
}

export interface FoundSales {
  lines: SaleLine[];
  /** The customer's due now, when mapped (a host without a dry run uses it for the refund). */
  customerDue: number | null;
}

const NEEDED: [concept: "Sale" | "SaleItem", field: string][] = [
  ["Sale", "id"],
  ["Sale", "date_time"],
  ["Sale", "customer_id"],
  ["SaleItem", "sale_id"],
  ["SaleItem", "part_id"],
  ["SaleItem", "quantity"],
];

const asNumber = (value: unknown) => (value === null || value === undefined ? null : Number(value));
const taka = (value: unknown) => {
  const amount = toTaka(value);
  return amount === null ? null : Number(amount);
};

/**
 * The parts a customer bought in the last 30 days, newest first (D186): a return that names its buyer and a part
 * finds which part from these, so the car need not be asked.
 */
export async function boughtParts(
  read: ReadPath,
  input: { customerId: string; now: Date; days?: number },
): Promise<string[]> {
  const { map, run } = read;
  if (!NEEDED.every(([concept, field]) => hasField(map, concept, field))) return [];
  const since = new Date(input.now.getTime() - (input.days ?? SALE_DAYS) * 86_400_000).toISOString();
  const rows = await run(
    buildQuery(map, {
      from: { concept: "SaleItem", alias: "i" },
      joins: [
        {
          entity: { concept: "Sale", alias: "s" },
          kind: "inner",
          on: [{ left: { alias: "i", field: "sale_id" }, right: { alias: "s", field: "id" } }],
        },
      ],
      select: [
        { ref: { alias: "i", field: "part_id" }, as: "bought_part" },
        { ref: { alias: "s", field: "date_time" }, as: "time" },
      ],
      where: [
        { ref: { alias: "s", field: "customer_id" }, op: "eq", value: input.customerId },
        { ref: { alias: "s", field: "date_time" }, op: "gte", value: since },
      ],
      orderBy: [{ as: "time", direction: "desc" }],
      limit: 50,
    }),
  );
  return [...new Set(rows.map((row) => String(row.bought_part)))];
}

export async function findSales(
  read: ReadPath,
  input: { customerId: string | null; partId: string; now: Date; days?: number },
): Promise<FoundSales | null> {
  const { map, run } = read;
  if (!NEEDED.every(([concept, field]) => hasField(map, concept, field))) return null;
  const since = new Date(input.now.getTime() - (input.days ?? SALE_DAYS) * 86_400_000).toISOString();
  const optional = (concept: "Sale" | "SaleItem", field: string, alias: string, as: string) =>
    hasField(map, concept, field) ? [{ ref: { alias, field }, as }] : [];
  const customer: Condition = input.customerId
    ? { ref: { alias: "s", field: "customer_id" }, op: "eq", value: input.customerId }
    : { ref: { alias: "s", field: "customer_id" }, op: "is_null" };
  const rows = await run(
    buildQuery(map, {
      from: { concept: "SaleItem", alias: "i" },
      joins: [
        {
          entity: { concept: "Sale", alias: "s" },
          kind: "inner",
          on: [{ left: { alias: "i", field: "sale_id" }, right: { alias: "s", field: "id" } }],
        },
      ],
      select: [
        { ref: { alias: "s", field: "id" }, as: "sale_id" },
        { ref: { alias: "s", field: "date_time" }, as: "time" },
        { ref: { alias: "i", field: "quantity" }, as: "quantity" },
        ...optional("SaleItem", "id", "i", "line_id"),
        ...optional("SaleItem", "unit_price", "i", "unit_price"),
        ...optional("Sale", "due", "s", "due"),
      ],
      where: [
        { ref: { alias: "i", field: "part_id" }, op: "eq", value: input.partId },
        customer,
        { ref: { alias: "s", field: "date_time" }, op: "gte", value: since },
      ],
      orderBy: [{ as: "time", direction: "desc" }],
      limit: 20,
    }),
  );

  // Earlier returns of the part on those sales, when the map has returns.
  const returned = new Map<string, number>();
  const saleIds = [...new Set(rows.map((row) => String(row.sale_id)))];
  if (saleIds.length && ["sale_id", "part_id", "quantity"].every((field) => hasField(map, "Return", field))) {
    const back = await run(
      buildQuery(map, {
        from: { concept: "Return", alias: "r" },
        select: [
          { ref: { alias: "r", field: "sale_id" }, as: "sale_id" },
          { ref: { alias: "r", field: "quantity" }, as: "quantity", aggregate: "sum" },
        ],
        where: [
          { ref: { alias: "r", field: "sale_id" }, op: "in", values: saleIds },
          { ref: { alias: "r", field: "part_id" }, op: "eq", value: input.partId },
        ],
        groupBy: [{ alias: "r", field: "sale_id" }],
      }),
    );
    for (const row of back) returned.set(String(row.sale_id), toUnits(row.quantity) ?? 0);
  }

  const lines: SaleLine[] = [];
  for (const row of rows) {
    const sold = toUnits(row.quantity) ?? asNumber(row.quantity) ?? 0;
    const saleId = String(row.sale_id);
    // A sale with two lines of the part shares its returns out from the first line on.
    const earlier = returned.get(saleId) ?? 0;
    const left = Math.max(0, sold - earlier);
    returned.set(saleId, Math.max(0, earlier - sold));
    if (left <= 0) continue;
    const time = row.time instanceof Date ? row.time.toISOString() : new Date(String(row.time)).toISOString();
    lines.push({
      saleId,
      lineId: row.line_id === undefined || row.line_id === null ? null : String(row.line_id),
      time,
      sold,
      left,
      unitPrice: row.unit_price === undefined ? null : taka(row.unit_price),
      saleDue: row.due === undefined ? null : taka(row.due),
    });
  }

  let customerDue: number | null = null;
  if (input.customerId && hasField(map, "Customer", "id") && hasField(map, "Customer", "due_balance")) {
    const [row] = await run(
      buildQuery(map, {
        from: { concept: "Customer", alias: "c" },
        select: [{ ref: { alias: "c", field: "due_balance" }, as: "due" }],
        where: [{ ref: { alias: "c", field: "id" }, op: "eq", value: input.customerId }],
        limit: 1,
      }),
    );
    if (row) customerDue = taka(row.due);
  }
  return { lines, customerDue };
}
