import { randomBytes, randomUUID } from "node:crypto";
import { encryptSecret } from "@dokaanbondhu/engine/crypto";
import {
  catalogCache,
  connections,
  conversations,
  createPlatform,
  messages,
  requestFrames,
  shops,
  users,
  type Platform,
} from "@dokaanbondhu/platform-db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { confirmEntity, HostPools, loadSchemaMap } from "@dokaanbondhu/engine/host";
import { geargridMap } from "../../../packages/engine/test/geargrid-map";
import { runCatalogSync } from "../src/jobs/catalog-sync";
import { runHealthProbe } from "../src/jobs/health-probe";
import { runRetention } from "../src/jobs/retention";

// The worker's jobs against the local CI database (spec 7.4): retention deletes only what is old enough; the
// health probe marks a reachable PostgreSQL host active and an unreachable one as an error.

const adminUrl = process.env.PLATFORM_ADMIN_DATABASE_URL ?? "";
const migrationUrl = process.env.PLATFORM_MIGRATION_DATABASE_URL ?? "";
const isLocal = (url: string) => {
  try {
    return ["localhost", "127.0.0.1"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
};
const allLocal = isLocal(adminUrl) && isLocal(migrationUrl);
if (process.env.CI === "true" && !allLocal)
  throw new Error("worker integration tests need the local CI database");

describe.skipIf(!allLocal)("worker jobs", () => {
  let admin: Platform;
  const shopId = randomUUID();
  const userId = randomUUID();
  const conversationId = randomUUID();
  const aesKey = randomBytes(32);
  const days = (n: number) => new Date(Date.now() - n * 86_400_000);

  beforeAll(async () => {
    admin = createPlatform(adminUrl, { max: 1 });
    await admin.withAdmin(async (tx) => {
      await tx.insert(shops).values({ id: shopId, name: "Retention shop" });
      await tx.insert(users).values({
        id: userId,
        shopId,
        authUserId: randomUUID(),
        name: "U",
        email: "u@shop.test",
        role: "owner",
      });
      await tx.insert(conversations).values({ id: conversationId, shopId, userId, channel: "chat" });
      const message = { shopId, conversationId, turnId: randomUUID(), role: "user" as const };
      await tx.insert(messages).values([
        { ...message, text: "old", createdAt: days(91) },
        { ...message, text: "recent", createdAt: days(89) },
      ]);
      const frame = { shopId, conversationId, intent: "find_parts", slots: {}, expiresAt: days(0) };
      await tx.insert(requestFrames).values([
        { ...frame, status: "done", updatedAt: days(2) },
        { ...frame, status: "expired", updatedAt: days(0.5) },
        { ...frame, status: "set_aside", updatedAt: days(3) },
      ]);
    });
  });

  afterAll(async () => {
    await admin.withAdmin(async (tx) => {
      await tx.execute(sql`delete from messages where shop_id = ${shopId}`);
      await tx.execute(sql`delete from request_frames where shop_id = ${shopId}`);
      await tx.execute(sql`delete from catalog_cache where shop_id = ${shopId}`);
      await tx.execute(sql`delete from schema_fields where shop_id = ${shopId}`);
      await tx.execute(sql`delete from schema_entities where shop_id = ${shopId}`);
      await tx.execute(sql`delete from connections where shop_id = ${shopId}`);
      await tx.execute(sql`delete from conversations where shop_id = ${shopId}`);
      await tx.execute(sql`delete from users where shop_id = ${shopId}`);
      await tx.execute(sql`delete from shops where id = ${shopId}`);
    });
    await admin.end();
  });

  it("deletes messages after 90 days and closed frames after 1 day, nothing else", async () => {
    await runRetention(admin);
    const left = await admin.withAdmin(async (tx) => ({
      messages: (await tx.select().from(messages).where(eq(messages.shopId, shopId))).map((m) => m.text),
      frames: (await tx.select().from(requestFrames).where(eq(requestFrames.shopId, shopId))).map(
        (f) => f.status,
      ),
    }));
    expect(left.messages).toEqual(["recent"]);
    expect(left.frames.sort()).toEqual(["expired", "set_aside"]);
  });

  it("marks a reachable PostgreSQL host active and an unreachable one as an error", async () => {
    const database = new URL(migrationUrl);
    const good = randomUUID();
    const bad = randomUUID();
    const secret = (id: string, password: string) =>
      encryptSecret(aesKey, { table: "connections", rowId: id, column: "secret_encrypted" }, password);
    const base = {
      shopId,
      kind: "db",
      dialect: "postgres",
      host: database.hostname,
      database: database.pathname.slice(1),
      username: decodeURIComponent(database.username),
      sslMode: "disable",
      status: "pending",
    };
    await admin.withAdmin((tx) =>
      tx.insert(connections).values([
        {
          ...base,
          id: good,
          port: Number(database.port || 5432),
          secretEncrypted: secret(good, decodeURIComponent(database.password)),
        },
        { ...base, id: bad, port: 1, secretEncrypted: secret(bad, "wrong") },
      ]),
    );
    const pools = new HostPools();
    await runHealthProbe(admin, pools, aesKey);
    await pools.closeAll();
    const rows = await admin.withAdmin((tx) =>
      tx.select().from(connections).where(eq(connections.shopId, shopId)),
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(good)).toMatchObject({ status: "active", lastError: null });
    expect(byId.get(bad)?.status).toBe("error");
    expect(byId.get(bad)?.lastError).toBeTruthy();
    expect(byId.get(good)?.lastCheckedAt).toBeInstanceOf(Date);
  });

  it("syncs a host's catalog into catalog_cache through its confirmed schema map, and again as an upsert", async () => {
    const hostUrl = process.env.MIGRATION_DATABASE_URL ?? "";
    if (!hostUrl) return; // the host copy exists only in the CI integration job
    const host = new URL(hostUrl);
    const connectionId = randomUUID();
    await admin.withAdmin((tx) =>
      tx.insert(connections).values({
        id: connectionId,
        shopId,
        kind: "db",
        dialect: "postgres",
        host: host.hostname,
        port: Number(host.port || 5432),
        database: host.pathname.slice(1),
        username: "dokaanbondhu_ro",
        sslMode: "disable",
        status: "active",
        secretEncrypted: encryptSecret(
          aesKey,
          { table: "connections", rowId: connectionId, column: "secret_encrypted" },
          process.env.DOKAAN_RO_PASSWORD ?? "",
        ),
      }),
    );
    for (const entity of Object.values(geargridMap.entities)) {
      if (entity) await admin.withAdmin((tx) => confirmEntity(tx, shopId, connectionId, entity, userId));
    }
    const stored = await admin.withAdmin((tx) => loadSchemaMap(tx, connectionId, "postgres"));
    expect(stored.entities.Part?.fields.part_number).toMatchObject({
      hostTable: "part_numbers",
      confirmed: true,
    });

    const pools = new HostPools();
    try {
      for (let round = 0; round < 2; round++) {
        const result = await runCatalogSync(admin, pools, aesKey);
        const ours = result.results.find((entry) => entry.connectionId === connectionId);
        expect(ours?.counts).toMatchObject({ parts: 237, vehicles: 40, customers: 30, suppliers: 5 });
        const cached = await admin.withAdmin((tx) =>
          tx.select().from(catalogCache).where(eq(catalogCache.connectionId, connectionId)),
        );
        expect(cached).toHaveLength(237 + 40 + 30 + 5);
      }
    } finally {
      await pools.closeAll();
    }
  });
});
