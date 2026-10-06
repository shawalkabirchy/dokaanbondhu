import { aliasEntries, buildDictionary, catalogEntries, GLOSSARY } from "@dokaanbondhu/core";
import { aliases, fitmentExtra, type Tx } from "@dokaanbondhu/platform-db";
import { and, eq } from "drizzle-orm";
import { readCatalog, toCatalog, writeCatalog } from "./catalog";
import { parsedFitments } from "./fitment-text";
import type { HostPools, RunQuery } from "./pool";
import { hasField, type SchemaMap } from "./schema-map";
import { buildQuery } from "./sql";
import { loadHostDb, loadSchemaMap } from "./store";

// One catalog.sync of one host connection (spec 7.4, 11.4). The worker's job, the admin CLI's sync-catalog and the
// server's "sync now" run this same code; each passes its own way into the platform DB (withShop or withAdmin). The
// parts the app's own fitment table does not cover have their fit read from their name and notes (D122).

export type WithTx = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;

export interface SyncCounts {
  parts: number;
  vehicles: number;
  customers: number;
  suppliers: number;
  syncedAt: Date;
}

/** The parts the app's own fitment table covers (none without one). */
export async function fittedParts(run: RunQuery, map: SchemaMap): Promise<Set<string>> {
  const covered = new Set<string>();
  if (!hasField(map, "Fitment", "part_id") || !hasField(map, "Fitment", "vehicle_id")) return covered;
  const fitted = await run(
    buildQuery(map, {
      from: { concept: "Fitment", alias: "f" },
      select: [{ ref: { alias: "f", field: "part_id" }, as: "part_id" }],
      groupBy: [{ alias: "f", field: "part_id" }],
    }),
  );
  for (const row of fitted) covered.add(String(row.part_id));
  return covered;
}

export async function syncConnection(
  withTx: WithTx,
  pools: HostPools,
  aesKey: Buffer,
  shopId: string,
  connectionId: string,
): Promise<SyncCounts> {
  const { db, map } = await withTx(async (tx) => {
    const db = await loadHostDb(tx, connectionId, aesKey);
    return { db, map: await loadSchemaMap(tx, connectionId, db.dialect) };
  });
  const { rows, covered } = await pools.readOnly(db, async (run) => ({
    rows: await readCatalog(run, map),
    covered: await fittedParts(run, map),
  }));
  const syncedAt = await withTx(async (tx) => {
    const at = await writeCatalog(tx, shopId, connectionId, rows);
    const own = await tx.select().from(aliases).where(eq(aliases.shopId, shopId));
    const catalog = toCatalog(rows);
    const dictionary = buildDictionary([...GLOSSARY, ...catalogEntries(catalog), ...aliasEntries(own)]);
    const parsed = parsedFitments(catalog, dictionary, covered);
    await tx
      .delete(fitmentExtra)
      .where(and(eq(fitmentExtra.connectionId, connectionId), eq(fitmentExtra.source, "parsed")));
    for (let start = 0; start < parsed.length; start += 500) {
      await tx.insert(fitmentExtra).values(
        parsed.slice(start, start + 500).map((row) => ({
          shopId,
          connectionId,
          hostPartId: row.hostPartId,
          make: row.make,
          model: row.model,
          yearFrom: row.yearFrom,
          yearTo: row.yearTo,
          engineCode: row.engineCode,
          source: "parsed",
          verified: false,
        })),
      );
    }
    return at;
  });
  const count = (concept: string) => rows.filter((row) => row.concept === concept).length;
  return {
    parts: count("part"),
    vehicles: count("vehicle"),
    customers: count("customer"),
    suppliers: count("supplier"),
    syncedAt,
  };
}
