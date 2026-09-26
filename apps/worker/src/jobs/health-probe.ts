import { decryptSecret } from "@dokaanbondhu/engine/crypto";
import { connections, type Platform } from "@dokaanbondhu/platform-db";
import { and, eq, ne, sql } from "drizzle-orm";
import pg from "pg";

// health.probe (spec 7.4): every 5 minutes while the worker runs, tests each host database connection and sets its
// status and last_error. PostgreSQL hosts are probed from step 2; MySQL hosts join with the MySQL adapter in step 3.

type Connection = typeof connections.$inferSelect;

function sslOf(connection: Connection): pg.ClientConfig["ssl"] {
  if (connection.sslMode === "disable") return false;
  if (connection.sslMode === "require") return { rejectUnauthorized: false }; // encrypted, not verified
  return { rejectUnauthorized: true, ...(connection.sslCa ? { ca: connection.sslCa } : {}) }; // verify-full
}

async function probePostgres(connection: Connection, password: string): Promise<void> {
  const client = new pg.Client({
    host: connection.host ?? undefined,
    port: connection.port ?? 5432,
    database: connection.database ?? undefined,
    user: connection.username ?? undefined,
    password,
    ssl: sslOf(connection),
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
  });
  await client.connect();
  try {
    await client.query("select 1");
  } finally {
    await client.end();
  }
}

export async function runHealthProbe(
  admin: Platform,
  aesKey: Buffer,
): Promise<{ checked: number; failed: number }> {
  const rows = await admin.withAdmin((tx) =>
    tx
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.kind, "db"),
          eq(connections.dialect, "postgres"),
          ne(connections.status, "disabled"),
        ),
      ),
  );
  let failed = 0;
  for (const connection of rows) {
    let status: "active" | "error" = "active";
    let lastError: string | null = null;
    try {
      const password = decryptSecret(
        aesKey,
        { table: "connections", rowId: connection.id, column: "secret_encrypted" },
        connection.secretEncrypted,
      );
      await probePostgres(connection, password);
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
