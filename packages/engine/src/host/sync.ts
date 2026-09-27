import type { Tx } from "@dokaanbondhu/platform-db";
import { readCatalog, writeCatalog } from "./catalog";
import type { HostPools } from "./pool";
import { loadHostDb, loadSchemaMap } from "./store";

// One catalog.sync of one host connection (spec 7.4, 11.4). The worker's job, the admin CLI's sync-catalog and the
// server's "sync now" run this same code; each passes its own way into the platform DB (withShop or withAdmin).

export type WithTx = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;

export interface SyncCounts {
  parts: number;
  vehicles: number;
  customers: number;
  suppliers: number;
  syncedAt: Date;
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
  const rows = await pools.readOnly(db, (run) => readCatalog(run, map));
  const syncedAt = await withTx((tx) => writeCatalog(tx, shopId, connectionId, rows));
  const count = (concept: string) => rows.filter((row) => row.concept === concept).length;
  return {
    parts: count("part"),
    vehicles: count("vehicle"),
    customers: count("customer"),
    suppliers: count("supplier"),
    syncedAt,
  };
}
