import { syncConnection, type HostPools, type SyncCounts } from "@dokaanbondhu/engine/host";
import { connections, type Platform } from "@dokaanbondhu/platform-db";
import { and, eq } from "drizzle-orm";

// catalog.sync (spec 7.4, 11.4): every 10 minutes, for each active database connection, rebuilds its catalog_cache
// from the host through the schema map. One connection failing never stops the others.

export interface CatalogSyncResult {
  synced: number;
  failed: number;
  results: { connectionId: string; counts?: SyncCounts; error?: string }[];
}

export async function runCatalogSync(
  admin: Platform,
  pools: HostPools,
  aesKey: Buffer,
): Promise<CatalogSyncResult> {
  const rows = await admin.withAdmin((tx) =>
    tx
      .select({ id: connections.id, shopId: connections.shopId })
      .from(connections)
      .where(and(eq(connections.kind, "db"), eq(connections.status, "active"))),
  );
  const result: CatalogSyncResult = { synced: 0, failed: 0, results: [] };
  for (const row of rows) {
    try {
      const counts = await syncConnection((fn) => admin.withAdmin(fn), pools, aesKey, row.shopId, row.id);
      result.synced++;
      result.results.push({ connectionId: row.id, counts });
    } catch (error) {
      result.failed++;
      result.results.push({
        connectionId: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}
