import { HostPools, loadHostDb } from "@dokaanbondhu/engine/host";
import { connections, type Platform } from "@dokaanbondhu/platform-db";
import { and, eq, ne, sql } from "drizzle-orm";

// health.probe (spec 7.4): every 5 minutes while the worker runs, tests each host database connection (PostgreSQL
// and MySQL, through the engine's pools, read-only) and sets its status and last_error.

export async function runHealthProbe(
  admin: Platform,
  pools: HostPools,
  aesKey: Buffer,
): Promise<{ checked: number; failed: number }> {
  const rows = await admin.withAdmin((tx) =>
    tx
      .select({ id: connections.id })
      .from(connections)
      .where(and(eq(connections.kind, "db"), ne(connections.status, "disabled"))),
  );
  let failed = 0;
  for (const connection of rows) {
    let status: "active" | "error" = "active";
    let lastError: string | null = null;
    try {
      const db = await admin.withAdmin((tx) => loadHostDb(tx, connection.id, aesKey));
      await pools.readOnly(db, (run) => run({ text: "SELECT 1", values: [] }));
    } catch (error) {
      status = "error";
      // a refused connection to "localhost" is an AggregateError with an empty message: keep its code instead
      const detail = error as { message?: string; code?: string; name?: string };
      lastError = (detail.message || detail.code || detail.name || "probe failed").slice(0, 300);
      failed++;
    }
    await admin.withAdmin((tx) =>
      tx
        .update(connections)
        .set({ status, lastError, lastCheckedAt: sql`now()` })
        .where(eq(connections.id, connection.id)),
    );
  }
  return { checked: rows.length, failed };
}
