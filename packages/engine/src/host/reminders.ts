import { OLD_DUE_DAYS, SOLD_DAYS, type LowStockLine, type OldDueLine } from "@dokaanbondhu/core";
import { toTaka, toUnits } from "./find-parts";
import type { Catalog } from "./catalog";
import type { RunQuery } from "./pool";
import { hasField, type SchemaMap } from "./schema-map";
import { buildQuery } from "./sql";

// Reminders (D194), read from the shop's own app through the confirmed map, for any app (D122). Nothing here names a
// host; a field the map lacks is never guessed, and the reminder it needs is then not given (null).
//   - Low: a part whose stock (summed over every stock row: branches, racks) is at or below its reorder level when the
//     app keeps one above zero; else at or below zero and sold in the last 90 days; an app without sales: every part
//     at or below zero. Only parts in the catalog count (the app's own filters, such as inactive parts, apply).
//   - Old due: each customer's due laid on their newest sales with a due first; the part from a sale more than 30 days
//     old, or from before every sale (an opening due), is old. An app without sales dues gives no due reminders.

export interface ReadPath {
  map: SchemaMap;
  run: RunQuery;
}

export interface LowStock extends LowStockLine {
  hostPartId: string;
  reorderLevel: number | null;
}

export interface OldDue extends OldDueLine {
  hostId: string;
  /** The oldest sale the old part comes from; null when it is from before every sale. */
  since: Date | null;
}

/** At most this many of each are listed. */
export const REMINDER_ROWS = 50;

const DAY_MS = 86_400_000;

/** The parts sold since a time, by their IDs; null when the app's sales are not mapped. */
async function soldSince(read: ReadPath, since: Date): Promise<Set<string> | null> {
  const { map, run } = read;
  const needed: [Parameters<typeof hasField>[1], string][] = [
    ["Sale", "id"],
    ["Sale", "date_time"],
    ["SaleItem", "sale_id"],
    ["SaleItem", "part_id"],
  ];
  if (!needed.every(([concept, field]) => hasField(map, concept, field))) return null;
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
      select: [{ ref: { alias: "i", field: "part_id" }, as: "sold_part" }],
      where: [{ ref: { alias: "s", field: "date_time" }, op: "gte", value: since.toISOString() }],
      groupBy: [{ alias: "i", field: "part_id" }],
    }),
  );
  return new Set(rows.map((row) => String(row.sold_part)));
}

/** Parts running low, the lowest first; null when the app's stock is not mapped. */
export async function lowStock(read: ReadPath, catalog: Catalog, now: Date): Promise<LowStock[] | null> {
  const { map, run } = read;
  if (!hasField(map, "StockItem", "part_id") || !hasField(map, "StockItem", "quantity")) return null;
  const reorder = hasField(map, "StockItem", "reorder_level");
  const rows = await run(
    buildQuery(map, {
      from: { concept: "StockItem", alias: "s" },
      select: [
        { ref: { alias: "s", field: "part_id" }, as: "low_part" },
        { ref: { alias: "s", field: "quantity" }, as: "stock", aggregate: "sum" },
        ...(reorder
          ? [{ ref: { alias: "s", field: "reorder_level" }, as: "reorder", aggregate: "max" as const }]
          : []),
      ],
      groupBy: [{ alias: "s", field: "part_id" }],
    }),
  );
  const parts = new Map(catalog.parts.map((part) => [part.hostId, part]));
  const levels = rows
    .map((row) => ({
      hostPartId: String(row.low_part),
      stock: toUnits(row.stock) ?? 0,
      reorderLevel: reorder ? toUnits(row.reorder) : null,
    }))
    .filter((row) => parts.has(row.hostPartId));
  // Without a reorder level, only a part that sells is worth reminding; an app without sales: every empty part.
  const needsSales = levels.some((row) => !(row.reorderLevel && row.reorderLevel > 0) && row.stock <= 0);
  const sold = needsSales ? await soldSince(read, new Date(now.getTime() - SOLD_DAYS * DAY_MS)) : null;
  return levels
    .filter((row) =>
      row.reorderLevel && row.reorderLevel > 0
        ? row.stock <= row.reorderLevel
        : row.stock <= 0 && (sold === null || sold.has(row.hostPartId)),
    )
    .map((row) => {
      const part = parts.get(row.hostPartId)!;
      return { ...row, name: part.name, nameBn: part.nameBn };
    })
    .sort(
      (a, b) =>
        a.stock - (a.reorderLevel ?? 0) - (b.stock - (b.reorderLevel ?? 0)) || a.name.localeCompare(b.name),
    )
    .slice(0, REMINDER_ROWS);
}

/** Customers whose due is partly older than OLD_DUE_DAYS, the oldest part largest first; null without sales dues. */
export async function oldDues(
  read: ReadPath,
  catalog: Catalog,
  now: Date,
  days = OLD_DUE_DAYS,
): Promise<OldDue[] | null> {
  const { map, run } = read;
  const needed: [Parameters<typeof hasField>[1], string][] = [
    ["Customer", "id"],
    ["Customer", "due_balance"],
    ["Sale", "customer_id"],
    ["Sale", "date_time"],
    ["Sale", "due"],
  ];
  if (!needed.every(([concept, field]) => hasField(map, concept, field))) return null;
  const owing = await run(
    buildQuery(map, {
      from: { concept: "Customer", alias: "c" },
      select: [
        { ref: { alias: "c", field: "id" }, as: "owing_customer" },
        { ref: { alias: "c", field: "due_balance" }, as: "due" },
      ],
      where: [{ ref: { alias: "c", field: "due_balance" }, op: "gt", value: 0 }],
    }),
  );
  const dues = new Map(
    owing
      .map((row) => [String(row.owing_customer), toTaka(row.due) ?? 0n] as const)
      .filter(([, due]) => due > 0n),
  );
  if (!dues.size) return [];
  const sales = await run(
    buildQuery(map, {
      from: { concept: "Sale", alias: "s" },
      select: [
        { ref: { alias: "s", field: "customer_id" }, as: "due_customer" },
        { ref: { alias: "s", field: "date_time" }, as: "time" },
        { ref: { alias: "s", field: "due" }, as: "sale_due" },
      ],
      where: [
        { ref: { alias: "s", field: "customer_id" }, op: "in", values: [...dues.keys()] },
        { ref: { alias: "s", field: "due" }, op: "gt", value: 0 },
      ],
      orderBy: [{ as: "time", direction: "desc" }],
    }),
  );
  const cutoff = now.getTime() - days * DAY_MS;
  const bySale = new Map<string, { time: Date; due: bigint }[]>();
  for (const row of sales) {
    const id = String(row.due_customer);
    const list = bySale.get(id) ?? [];
    list.push({ time: new Date(row.time as string | Date), due: toTaka(row.sale_due) ?? 0n });
    bySale.set(id, list);
  }
  const names = new Map(catalog.customers.map((customer) => [customer.hostId, customer]));
  const out: OldDue[] = [];
  for (const [hostId, due] of dues) {
    let left = due;
    let old = 0n;
    let since: Date | null = null;
    for (const sale of bySale.get(hostId) ?? []) {
      if (left <= 0n) break;
      const part = sale.due < left ? sale.due : left;
      left -= part;
      if (sale.time.getTime() < cutoff && part > 0n) {
        old += part;
        since = sale.time;
      }
    }
    // What is left after every sale is from before them (an opening due): old, from an unknown day.
    if (left > 0n) {
      old += left;
      since = null;
    }
    const customer = names.get(hostId);
    if (old > 0n && customer)
      out.push({ hostId, name: customer.name, nameBn: customer.nameBn, due, old, since });
  }
  return out
    .sort((a, b) => (b.old > a.old ? 1 : b.old < a.old ? -1 : a.name.localeCompare(b.name)))
    .slice(0, REMINDER_ROWS);
}
