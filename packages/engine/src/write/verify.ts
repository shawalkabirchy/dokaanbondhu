import { toTaka, toUnits } from "../host/find-parts";
import type { RunQuery } from "../host/pool";
import { hasField, type SchemaMap } from "../host/schema-map";
import { buildQuery } from "../host/sql";
import type { ActionPreview } from "./types";

// The checks around a write, through the read-only path (spec 11.9 steps 5 and 6): stock and balance before and
// after, and, after a timeout, a record the host may have saved anyway. A check whose fields the schema map lacks
// is skipped, never guessed.

export interface ReadPath {
  map: SchemaMap;
  run: RunQuery;
}

export interface Snapshot {
  stock: Record<string, number> | null;
  balance: number | null;
}

const asNumber = (value: unknown) => (value === null || value === undefined ? 0 : Number(value));

/** The parts' stock (all rows summed) and the customer's due or the supplier's payable, as the host has them now. */
export async function snapshot(read: ReadPath, preview: ActionPreview): Promise<Snapshot> {
  const { map, run } = read;
  let stock: Record<string, number> | null = null;
  const ids = preview.lines.map((line) => line.hostPartId);
  if (ids.length && hasField(map, "StockItem", "part_id") && hasField(map, "StockItem", "quantity")) {
    const rows = await run(
      buildQuery(map, {
        from: { concept: "StockItem", alias: "s" },
        select: [
          { ref: { alias: "s", field: "part_id" }, as: "part_id" },
          { ref: { alias: "s", field: "quantity" }, as: "quantity", aggregate: "sum" },
        ],
        where: [{ ref: { alias: "s", field: "part_id" }, op: "in", values: ids }],
        groupBy: [{ alias: "s", field: "part_id" }],
      }),
    );
    stock = Object.fromEntries(ids.map((id) => [id, 0]));
    for (const row of rows) stock[String(row.part_id)] = toUnits(row.quantity) ?? asNumber(row.quantity);
  }
  let balance: number | null = null;
  const party = preview.customer
    ? { concept: "Customer" as const, field: "due_balance", id: preview.customer.hostId }
    : preview.supplier
      ? { concept: "Supplier" as const, field: "payable_balance", id: preview.supplier.hostId }
      : null;
  if (party && hasField(map, party.concept, "id") && hasField(map, party.concept, party.field)) {
    const [row] = await run(
      buildQuery(map, {
        from: { concept: party.concept, alias: "p" },
        select: [{ ref: { alias: "p", field: party.field }, as: "balance" }],
        where: [{ ref: { alias: "p", field: "id" }, op: "eq", value: party.id }],
        limit: 1,
      }),
    );
    if (row) balance = Number(toTaka(row.balance) ?? 0n);
  }
  return { stock, balance };
}

/** Whether the changes between two snapshots are the ones the action expected; null when nothing could be checked. */
export function changedAsExpected(before: Snapshot, after: Snapshot, preview: ActionPreview): boolean | null {
  let checked = false;
  if (before.stock && after.stock) {
    for (const [part, change] of Object.entries(preview.expect.stock)) {
      checked = true;
      if (Math.abs((after.stock[part] ?? 0) - (before.stock[part] ?? 0) - change) > 1e-6) return false;
    }
  }
  if (preview.expect.balance !== null && before.balance !== null && after.balance !== null) {
    checked = true;
    if (after.balance - before.balance !== preview.expect.balance) return false;
  }
  return checked ? true : null;
}

/**
 * After a timeout or a 5xx (spec 11.9 step 5): a sale or payment the host saved in the last 5 minutes for the same
 * customer with the same total or amount. Null when the map cannot tell (the caller then retries once).
 */
export async function savedAnyway(
  read: ReadPath,
  preview: ActionPreview,
  now: Date,
): Promise<boolean | null> {
  const { map, run } = read;
  const kind =
    preview.template === "sale"
      ? { concept: "Sale" as const, party: "customer_id", value: "total" }
      : preview.template === "payment"
        ? { concept: "Payment" as const, party: "customer_id", value: "amount" }
        : null;
  const party = preview.customer?.hostId;
  const value = preview.template === "payment" ? preview.paid : preview.total;
  if (!kind || !party || value === null) return null;
  if (![kind.party, kind.value, "date_time"].every((field) => hasField(map, kind.concept, field)))
    return null;
  const rows = await run(
    buildQuery(map, {
      from: { concept: kind.concept, alias: "r" },
      select: [{ ref: { alias: "r", field: kind.value }, as: "value" }],
      where: [
        { ref: { alias: "r", field: kind.party }, op: "eq", value: party },
        {
          ref: { alias: "r", field: "date_time" },
          op: "gte",
          value: new Date(now.getTime() - 5 * 60_000).toISOString(),
        },
      ],
      limit: 20,
    }),
  );
  return rows.some((row) => Number(toTaka(row.value) ?? -1n) === value);
}
