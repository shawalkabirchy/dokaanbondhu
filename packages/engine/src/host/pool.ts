import { createHash } from "node:crypto";
import mysql from "mysql2/promise";
import pg from "pg";
import type { Dialect } from "./schema-map";

// Connections and pools (spec 11.1): one lazily created pool per host connection; TLS built from ssl_mode and ssl_ca;
// every read in a read-only transaction with a 5 s limit; bigint and numeric values arrive as strings.

export interface HostDb {
  id: string;
  dialect: Dialect;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  sslMode: "verify-full" | "require" | "disable";
  sslCa: string | null;
  poolMax: number;
}

export type Row = Record<string, unknown>;
export type RunQuery = (query: { text: string; values: unknown[] }) => Promise<Row[]>;

const LOCAL = new Set(["localhost", "127.0.0.1", "::1"]);
const STATEMENT_TIMEOUT_MS = 5_000;

export class HostConnectionError extends Error {}

/** TLS options from ssl_mode and ssl_ca: verify-full checks the certificate and the host name. */
export function tlsOptions(db: Pick<HostDb, "host" | "sslMode" | "sslCa">) {
  switch (db.sslMode) {
    case "verify-full":
      return { rejectUnauthorized: true, servername: db.host, ...(db.sslCa ? { ca: db.sslCa } : {}) };
    case "require":
      return { rejectUnauthorized: false };
    case "disable":
      if (!LOCAL.has(db.host)) throw new HostConnectionError("ssl_mode disable is only for localhost");
      return false as const;
  }
}

interface PgEntry {
  dialect: "postgres";
  fingerprint: string;
  pool: pg.Pool;
}
interface MysqlEntry {
  dialect: "mysql";
  fingerprint: string;
  pool: mysql.Pool;
}

/** Everything that makes a pool, the password included; a change means a new pool. */
function fingerprint(db: HostDb): string {
  return createHash("sha256")
    .update(JSON.stringify({ ...db, id: undefined }))
    .digest("hex");
}

/** Adds MySQL's execution-time hint to a SELECT. */
function withMysqlTimeout(text: string): string {
  return text.replace(/^\s*SELECT\b/i, `SELECT /*+ MAX_EXECUTION_TIME(${STATEMENT_TIMEOUT_MS}) */`);
}

export class HostPools {
  private readonly entries = new Map<string, PgEntry | MysqlEntry>();

  constructor(private readonly onIdleError: (error: Error) => void = () => {}) {}

  private entry(db: HostDb): PgEntry | MysqlEntry {
    const print = fingerprint(db);
    const current = this.entries.get(db.id);
    if (current && current.fingerprint === print) return current;
    if (current) void this.close(db.id); // a changed connection closes its pool
    const ssl = tlsOptions(db);
    let created: PgEntry | MysqlEntry;
    if (db.dialect === "postgres") {
      const pool = new pg.Pool({
        host: db.host,
        port: db.port,
        database: db.database,
        user: db.username,
        password: db.password,
        ssl,
        max: db.poolMax,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
      });
      pool.on("error", (error) => this.onIdleError(error));
      created = { dialect: "postgres", fingerprint: print, pool };
    } else {
      const pool = mysql.createPool({
        host: db.host,
        port: db.port,
        database: db.database,
        user: db.username,
        password: db.password,
        ...(ssl ? { ssl } : {}),
        connectionLimit: db.poolMax,
        idleTimeout: 30_000,
        connectTimeout: 5_000,
        supportBigNumbers: true,
        bigNumberStrings: true,
        decimalNumbers: false,
        dateStrings: true,
      });
      created = { dialect: "mysql", fingerprint: print, pool };
    }
    this.entries.set(db.id, created);
    return created;
  }

  /** Runs fn with a query runner inside one read-only transaction (5 s per statement). */
  async readOnly<T>(db: HostDb, fn: (run: RunQuery) => Promise<T>): Promise<T> {
    const entry = this.entry(db);
    if (entry.dialect === "postgres") {
      const client = await entry.pool.connect();
      try {
        await client.query("BEGIN READ ONLY");
        await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS / 1000}s'`);
        const result = await fn(async ({ text, values }) => (await client.query(text, values)).rows as Row[]);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    }
    const connection = await entry.pool.getConnection();
    try {
      await connection.query("SET SESSION TRANSACTION READ ONLY");
      await connection.query("START TRANSACTION READ ONLY");
      const result = await fn(async ({ text, values }) => {
        const [rows] = await connection.query(withMysqlTimeout(text), values);
        return rows as Row[];
      });
      await connection.query("COMMIT");
      return result;
    } catch (error) {
      await connection.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      connection.release();
    }
  }

  async close(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    await entry.pool.end();
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((id) => this.close(id)));
  }
}
