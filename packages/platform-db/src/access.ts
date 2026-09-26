import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

// Every platform query runs through one of these helpers (spec 7.3), so a query without a shop cannot be written by
// accident: the raw database object never leaves this package, and a lint rule keeps the Drizzle driver here too.

type Database = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type SetupToken = typeof schema.setupTokens.$inferSelect;

export class SetupTokenError extends Error {
  constructor(readonly reason: "unknown" | "used" | "expired") {
    super(`setup token ${reason}`);
    this.name = "SetupTokenError";
  }
}

export interface Platform {
  /** A transaction in which row-level security shows only this shop's rows (and the global ones). */
  withShop<T>(shopId: string, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Login lookup only: shows the users row of this Supabase Auth user, and nothing else. */
  withAuthUser<T>(authUserId: string, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** The scanner upload: finds the token's row, marks it used, then continues as withShop() for its shop. */
  withSetupToken<T>(tokenHash: string, fn: (tx: Tx, token: SetupToken) => Promise<T>): Promise<T>;
  /** Cross-shop work; only a platform_admin connection sees anything (admin CLI, the worker's admin jobs). */
  withAdmin<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  end(): Promise<void>;
}

/** Opens a pool on a platform role's connection string (with sslmode and sslrootcert, spec 4.2). */
export function createPlatform(connectionString: string, options: { max: number }): Platform {
  const pool = new pg.Pool({ connectionString, max: options.max });
  const db: Database = drizzle(pool, { schema });

  const withSetting = <T>(name: string, value: string, fn: (tx: Tx) => Promise<T>) =>
    db.transaction(async (tx) => {
      await tx.execute(sql`select set_config(${name}, ${value}, true)`);
      return fn(tx);
    });

  return {
    withShop: (shopId, fn) => withSetting("app.shop_id", shopId, fn),
    withAuthUser: (authUserId, fn) => withSetting("app.auth_user_id", authUserId, fn),
    withSetupToken: (tokenHash, fn) =>
      withSetting("app.token_hash", tokenHash, async (tx) => {
        const [token] = await tx
          .select()
          .from(schema.setupTokens)
          .where(sql`${schema.setupTokens.tokenHash} = ${tokenHash}`)
          .for("update");
        if (!token) throw new SetupTokenError("unknown");
        if (token.usedAt) throw new SetupTokenError("used");
        if (token.expiresAt.getTime() <= Date.now()) throw new SetupTokenError("expired");
        await tx
          .update(schema.setupTokens)
          .set({ usedAt: new Date() })
          .where(sql`${schema.setupTokens.id} = ${token.id}`);
        await tx.execute(sql`select set_config('app.shop_id', ${token.shopId}, true)`);
        return fn(tx, token);
      }),
    withAdmin: (fn) => db.transaction(fn),
    end: () => pool.end(),
  };
}
