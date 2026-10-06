import {
  isPriceTier,
  phoneticKey,
  priceTierOf,
  type CatalogCustomer,
  type CatalogPart,
  type CatalogVehicle,
  type PriceTier,
} from "@dokaanbondhu/core";
import { catalogCache, type Tx } from "@dokaanbondhu/platform-db";
import { and, eq, lt, max, sql } from "drizzle-orm";
import type { Row, RunQuery } from "./pool";
import { hasField, type Concept, type SchemaMap } from "./schema-map";
import { buildQuery, type SelectItem } from "./sql";

// Catalog sync (spec 11.4): every part (names, all part numbers, category, quality, position, unit, vehicle type,
// brand), vehicle, customer and supplier, read through the confirmed schema map, with phonetic keys and 30-day sales
// counts, upserted into catalog_cache; rows the host no longer has are removed.

export interface CatalogRow {
  concept: "part" | "vehicle" | "customer" | "supplier";
  hostId: string;
  displayName: string;
  displayNameBn: string | null;
  partNumbers: string[] | null;
  attrs: Record<string, unknown>;
}

const text = (value: unknown) => (value === null || value === undefined ? null : String(value));
const list = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item) => item !== null).map(String)
    : typeof value === "string"
      ? JSON.parse(value)
      : [];

/** The confirmed optional fields of a concept, as select items. */
function optional(map: SchemaMap, concept: Concept, alias: string, fields: string[]): SelectItem[] {
  return fields
    .filter((field) => hasField(map, concept, field))
    .map((field) => ({ ref: { alias, field }, as: field }));
}

async function salesCounts(run: RunQuery, map: SchemaMap, since: Date) {
  const parts = new Map<string, number>();
  const customers = new Map<string, number>();
  const confirmed = (concept: Concept, field: string) => hasField(map, concept, field);
  if (
    confirmed("Sale", "id") &&
    confirmed("Sale", "date_time") &&
    confirmed("SaleItem", "sale_id") &&
    confirmed("SaleItem", "part_id")
  ) {
    const rows = await run(
      buildQuery(map, {
        from: { concept: "SaleItem", alias: "si" },
        joins: [
          {
            entity: { concept: "Sale", alias: "s" },
            kind: "inner",
            on: [{ left: { alias: "si", field: "sale_id" }, right: { alias: "s", field: "id" } }],
          },
        ],
        select: [
          { ref: { alias: "si", field: "part_id" }, as: "part_id" },
          { ref: { alias: "si", field: "sale_id" }, as: "lines", aggregate: "count" },
        ],
        where: [{ ref: { alias: "s", field: "date_time" }, op: "gte", value: since.toISOString() }],
        groupBy: [{ alias: "si", field: "part_id" }],
      }),
    );
    for (const row of rows) parts.set(String(row.part_id), Number(row.lines));
  }
  if (confirmed("Sale", "customer_id") && confirmed("Sale", "date_time") && confirmed("Sale", "id")) {
    const rows = await run(
      buildQuery(map, {
        from: { concept: "Sale", alias: "s" },
        select: [
          { ref: { alias: "s", field: "customer_id" }, as: "customer_id" },
          { ref: { alias: "s", field: "id" }, as: "sales", aggregate: "count" },
        ],
        where: [{ ref: { alias: "s", field: "date_time" }, op: "gte", value: since.toISOString() }],
        groupBy: [{ alias: "s", field: "customer_id" }],
      }),
    );
    for (const row of rows)
      if (row.customer_id !== null) customers.set(String(row.customer_id), Number(row.sales));
  }
  return { parts, customers };
}

/** Reads the catalog from the host (inside one read-only transaction). */
export async function readCatalog(
  run: RunQuery,
  map: SchemaMap,
  now: Date = new Date(),
): Promise<CatalogRow[]> {
  const out: CatalogRow[] = [];
  const since = new Date(now.getTime() - 30 * 86_400_000);
  const sold = await salesCounts(run, map, since);

  // The rack labels each part is kept on, so a rack named in a request is known however it was said (D108).
  const racks = new Map<string, Set<string>>();
  if (hasField(map, "StockItem", "part_id") && hasField(map, "StockItem", "rack_location")) {
    const rows = await run(
      buildQuery(map, {
        from: { concept: "StockItem", alias: "st" },
        select: [
          { ref: { alias: "st", field: "part_id" }, as: "part_id" },
          { ref: { alias: "st", field: "rack_location" }, as: "rack" },
        ],
      }),
    );
    for (const row of rows) {
      const rack = text(row.rack)?.trim();
      if (!rack) continue;
      const id = String(row.part_id);
      racks.set(id, (racks.get(id) ?? new Set()).add(rack));
    }
  }

  if (hasField(map, "Part", "id") && hasField(map, "Part", "name")) {
    const attrFields = [
      "name_bn",
      "category",
      "brand",
      "quality",
      "position",
      "unit",
      "pack_size",
      "vehicle_type",
    ];
    const extra = optional(map, "Part", "p", attrFields);
    const numbers: SelectItem[] = hasField(map, "Part", "part_number")
      ? [{ ref: { alias: "p", field: "part_number" }, as: "part_numbers", aggregate: "list" }]
      : [];
    const rows = await run(
      buildQuery(map, {
        from: { concept: "Part", alias: "p" },
        select: [
          { ref: { alias: "p", field: "id" }, as: "id" },
          { ref: { alias: "p", field: "name" }, as: "name" },
          ...extra,
          ...numbers,
        ],
        ...(numbers.length
          ? {
              groupBy: [
                { alias: "p", field: "id" },
                { alias: "p", field: "name" },
                ...extra.map((item) => item.ref),
              ],
            }
          : {}),
      }),
    );
    for (const row of rows) {
      const attrs: Record<string, unknown> = { sold_30d: sold.parts.get(String(row.id)) ?? 0 };
      for (const item of extra) if (item.as !== "name_bn") attrs[item.as] = text(row[item.as]);
      const kept = racks.get(String(row.id));
      if (kept) attrs.racks = [...kept];
      out.push({
        concept: "part",
        hostId: String(row.id),
        displayName: String(row.name),
        displayNameBn: text(row.name_bn),
        partNumbers: numbers.length ? list(row.part_numbers) : null,
        attrs,
      });
    }
  }

  if (hasField(map, "Vehicle", "id") && hasField(map, "Vehicle", "model")) {
    const extra = optional(map, "Vehicle", "v", [
      "make",
      "year_from",
      "year_to",
      "engine_code",
      "vehicle_type",
      "body",
    ]);
    const rows = await run(
      buildQuery(map, {
        from: { concept: "Vehicle", alias: "v" },
        select: [
          { ref: { alias: "v", field: "id" }, as: "id" },
          { ref: { alias: "v", field: "model" }, as: "model" },
          ...extra,
        ],
      }),
    );
    for (const row of rows) {
      const years = row.year_from ? ` ${row.year_from}-${row.year_to ?? ""}` : "";
      out.push({
        concept: "vehicle",
        hostId: String(row.id),
        displayName: `${row.make ? `${row.make} ` : ""}${row.model}${years}`,
        displayNameBn: null,
        partNumbers: null,
        attrs: Object.fromEntries([
          ["model", text(row.model)],
          ...extra.map((item) => [item.as, text(row[item.as])]),
        ]),
      });
    }
  }

  for (const [concept, entity, alias, fields] of [
    ["customer", "Customer", "c", ["type", "price_tier", "phone"]],
    ["supplier", "Supplier", "s", ["phone"]],
  ] as const) {
    if (!hasField(map, entity, "id") || !hasField(map, entity, "name")) continue;
    const extra = optional(map, entity, alias, [...fields]);
    const rows = await run(
      buildQuery(map, {
        from: { concept: entity, alias },
        select: [
          { ref: { alias, field: "id" }, as: "id" },
          { ref: { alias, field: "name" }, as: "name" },
          ...extra,
        ],
      }),
    );
    for (const row of rows) {
      const attrs: Record<string, unknown> = Object.fromEntries(
        extra.map((item) => [item.as, text(row[item.as])]),
      );
      if (concept === "customer") attrs.sales_30d = sold.customers.get(String(row.id)) ?? 0;
      out.push({
        concept,
        hostId: String(row.id),
        displayName: String(row.name),
        displayNameBn: null,
        partNumbers: null,
        attrs,
      });
    }
  }
  return out;
}

/** Upserts the rows and removes the ones the host no longer has. Returns the sync time. */
export async function writeCatalog(
  tx: Tx,
  shopId: string,
  connectionId: string,
  rows: CatalogRow[],
): Promise<Date> {
  const syncedAt = new Date();
  for (let start = 0; start < rows.length; start += 500) {
    const chunk = rows.slice(start, start + 500).map((row) => ({
      shopId,
      connectionId,
      concept: row.concept,
      hostId: row.hostId,
      displayName: row.displayName,
      displayNameBn: row.displayNameBn,
      partNumbers: row.partNumbers,
      phoneticKey: phoneticKey(row.displayName),
      attrs: row.attrs,
      syncedAt,
    }));
    await tx
      .insert(catalogCache)
      .values(chunk)
      .onConflictDoUpdate({
        target: [catalogCache.connectionId, catalogCache.concept, catalogCache.hostId],
        set: {
          displayName: sql`excluded.display_name`,
          displayNameBn: sql`excluded.display_name_bn`,
          partNumbers: sql`excluded.part_numbers`,
          phoneticKey: sql`excluded.phonetic_key`,
          attrs: sql`excluded.attrs`,
          syncedAt,
        },
      });
  }
  await tx
    .delete(catalogCache)
    .where(and(eq(catalogCache.connectionId, connectionId), lt(catalogCache.syncedAt, syncedAt)));
  return syncedAt;
}

/** The catalog of one connection in memory, as the resolvers use it. */
export interface Catalog {
  syncedAt: Date | null;
  parts: (CatalogPart & { attrs: Record<string, unknown> })[];
  vehicles: CatalogVehicle[];
  customers: (CatalogCustomer & { attrs: Record<string, unknown> })[];
  suppliers: { hostId: string; name: string }[];
}

const number = (value: unknown) =>
  value === null || value === undefined || value === "" ? null : Number(value);

export async function loadCatalog(tx: Tx, connectionId: string): Promise<Catalog> {
  const rows = await tx.select().from(catalogCache).where(eq(catalogCache.connectionId, connectionId));
  return toCatalog(
    rows.map((row) => ({
      ...row,
      concept: row.concept as CatalogRow["concept"],
      attrs: row.attrs as Record<string, unknown>,
    })),
  );
}

/** Catalog rows (as synced or as stored) to the in-memory catalog. */
export function toCatalog(rows: (CatalogRow & { syncedAt?: Date })[]): Catalog {
  const catalog: Catalog = { syncedAt: null, parts: [], vehicles: [], customers: [], suppliers: [] };
  for (const row of rows) {
    if (row.syncedAt && (!catalog.syncedAt || row.syncedAt > catalog.syncedAt))
      catalog.syncedAt = row.syncedAt;
    const attrs = (row.attrs ?? {}) as Record<string, unknown>;
    if (row.concept === "part") {
      catalog.parts.push({
        hostId: row.hostId,
        name: row.displayName,
        nameBn: row.displayNameBn,
        partNumbers: row.partNumbers ?? [],
        attrs,
      });
    } else if (row.concept === "vehicle") {
      catalog.vehicles.push({
        hostId: row.hostId,
        make: String(attrs.make ?? ""),
        model: String(attrs.model ?? row.displayName),
        yearFrom: number(attrs.year_from) ?? 0,
        yearTo: number(attrs.year_to),
        engineCode: (attrs.engine_code as string | null) ?? null,
        vehicleType: (attrs.vehicle_type as string | null) ?? null,
      });
    } else if (row.concept === "customer") {
      catalog.customers.push({ hostId: row.hostId, name: row.displayName, nameBn: row.displayNameBn, attrs });
    } else {
      catalog.suppliers.push({ hostId: row.hostId, name: row.displayName });
    }
  }
  return catalog;
}

/** Every rack label the shop's stock is kept on (D108). */
export function rackLabels(catalog: Catalog): string[] {
  const labels = new Set<string>();
  for (const part of catalog.parts)
    if (Array.isArray(part.attrs.racks)) for (const rack of part.attrs.racks) labels.add(String(rack));
  return [...labels];
}

/** A host value's price level as the owner set it in setup (connections.price_tiers, D121). */
export type ChosenTiers = Readonly<Record<string, string>>;

export interface PriceLevel {
  /** The value as the host stores it ("Dealer"). */
  value: string;
  /** The level: the owner's choice, else the word list's; null when neither knows it (then retail is used). */
  tier: PriceTier | null;
  decidedBy: "owner" | "words" | null;
}

/**
 * The value that decides a customer's price level (spec 9.8, D121): its own tier, else its type, each through the
 * owner's choice and then the word list; when neither is known, the first value the host stores, without a level.
 */
function levelOf(attrs: Record<string, unknown>, chosen: ChosenTiers): PriceLevel | null {
  const values = [attrs.price_tier, attrs.type]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);
  for (const value of values) {
    const owner = chosen[value];
    if (isPriceTier(owner)) return { value, tier: owner, decidedBy: "owner" };
    const word = priceTierOf(value);
    if (word) return { value, tier: word, decidedBy: "words" };
  }
  return values[0] ? { value: values[0], tier: null, decidedBy: null } : null;
}

/** A customer's price level; retail when the host stores none or one nobody has named yet. */
export function customerTier(
  attrs: Record<string, unknown> | undefined,
  chosen: ChosenTiers = {},
): PriceTier {
  return (attrs && levelOf(attrs, chosen)?.tier) ?? "retail";
}

/** Every value that decides a customer's price level, with its customers, for setup (D121); unknown ones first. */
export function priceLevels(catalog: Catalog, chosen: ChosenTiers): (PriceLevel & { customers: number })[] {
  const levels = new Map<string, PriceLevel & { customers: number }>();
  for (const customer of catalog.customers) {
    const level = levelOf(customer.attrs, chosen);
    if (!level) continue;
    const seen = levels.get(level.value);
    if (seen) seen.customers += 1;
    else levels.set(level.value, { ...level, customers: 1 });
  }
  return [...levels.values()].sort(
    (a, b) => Number(a.tier !== null) - Number(b.tier !== null) || b.customers - a.customers,
  );
}

/** The newest sync time of a connection's cache (the server polls this every 60 s). */
export async function catalogVersion(tx: Tx, connectionId: string): Promise<Date | null> {
  const [row] = await tx
    .select({ at: max(catalogCache.syncedAt) })
    .from(catalogCache)
    .where(eq(catalogCache.connectionId, connectionId));
  return row?.at ?? null;
}

export type { Row };
