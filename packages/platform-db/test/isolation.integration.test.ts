import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  aiProviders,
  aliases,
  connections,
  conversations,
  createPlatform,
  requestFrames,
  setupTokens,
  SetupTokenError,
  shops,
  users,
  type Platform,
} from "../src";

// Shop isolation and lockdown (spec 7.3, 18.1). They write rows, so they run only against a database on this
// machine (the CI container), never against a Supabase project; in CI a non-local URL is an error, not a skip.

const urls = {
  migration: process.env.PLATFORM_MIGRATION_DATABASE_URL ?? "",
  api: process.env.PLATFORM_DATABASE_URL ?? "",
  admin: process.env.PLATFORM_ADMIN_DATABASE_URL ?? "",
};
const isLocal = (url: string) => {
  try {
    return ["localhost", "127.0.0.1"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
};
const allLocal = Object.values(urls).every(isLocal);
if (process.env.CI === "true" && !allLocal) {
  throw new Error(
    "integration tests need the local CI database: every PLATFORM_* URL must point at localhost",
  );
}

describe.skipIf(!allLocal)("platform database", () => {
  let api: Platform;
  let admin: Platform;
  const migration = new pg.Client({ connectionString: urls.migration });
  const shopA = randomUUID();
  const shopB = randomUUID();
  const authA = randomUUID();
  const authB = randomUUID();
  const run = randomUUID().slice(0, 8);

  beforeAll(async () => {
    api = createPlatform(urls.api, { max: 2 });
    admin = createPlatform(urls.admin, { max: 1 });
    await migration.connect();
    await admin.withAdmin(async (tx) => {
      await tx.insert(shops).values([
        { id: shopA, name: `A ${run}` },
        { id: shopB, name: `B ${run}` },
      ]);
      await tx.insert(users).values([
        { shopId: shopA, authUserId: authA, name: "Owner A", email: `a-${run}@test`, role: "owner" },
        { shopId: shopB, authUserId: authB, name: "Owner B", email: `b-${run}@test`, role: "owner" },
      ]);
      const secret = { secretEncrypted: "v1:test", status: "active", kind: "db" } as const;
      await tx.insert(connections).values([
        { ...secret, shopId: shopA, label: `A ${run}` },
        { ...secret, shopId: shopB, label: `B ${run}` },
      ]);
      const alias = {
        aliasNormalized: "x",
        aliasPhonetic: "x",
        targetConcept: "part_type",
        source: "owner",
      } as const;
      await tx.insert(aliases).values([
        { ...alias, shopId: null, aliasText: `global ${run}`, targetValue: "g", source: "global" },
        { ...alias, shopId: shopA, aliasText: `a ${run}`, targetValue: "a" },
        { ...alias, shopId: shopB, aliasText: `b ${run}`, targetValue: "b" },
      ]);
    });
  });

  afterAll(async () => {
    await admin.withAdmin(async (tx) => {
      for (const shopId of [shopA, shopB]) {
        await tx.execute(sql`delete from request_frames where shop_id = ${shopId}`);
        await tx.execute(sql`delete from conversations where shop_id = ${shopId}`);
        await tx.execute(sql`delete from setup_tokens where shop_id = ${shopId}`);
        await tx.execute(sql`delete from ai_providers where shop_id = ${shopId}`);
        await tx.execute(sql`delete from aliases where shop_id = ${shopId}`);
        await tx.execute(sql`delete from connections where shop_id = ${shopId}`);
        await tx.execute(sql`delete from users where shop_id = ${shopId}`);
        await tx.execute(sql`delete from shops where id = ${shopId}`);
      }
      await tx.execute(sql`delete from aliases where shop_id is null and alias_text = ${`global ${run}`}`);
    });
    await Promise.all([api.end(), admin.end(), migration.end()]);
  });

  it("forces row-level security on every table and grants only the two platform roles", async () => {
    const { rows } = await migration.query<{ relname: string; ok: boolean }>(`
      select c.relname,
             c.relrowsecurity and c.relforcerowsecurity
             and has_table_privilege('platform_api', c.oid, 'SELECT, INSERT, UPDATE, DELETE')
             and has_table_privilege('platform_admin', c.oid, 'SELECT, INSERT, UPDATE, DELETE')
             and not has_table_privilege('anon', c.oid, 'SELECT')
             and not has_table_privilege('authenticated', c.oid, 'SELECT') as ok
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'`);
    expect(rows.length).toBe(18);
    expect(rows.filter((row) => !row.ok)).toEqual([]);
  });

  it("shows a shop only its own rows and the global ones", async () => {
    await api.withShop(shopA, async (tx) => {
      expect((await tx.select().from(shops)).map((s) => s.id)).toEqual([shopA]);
      expect((await tx.select().from(users)).map((u) => u.authUserId)).toEqual([authA]);
      expect((await tx.select().from(connections)).map((c) => c.label)).toEqual([`A ${run}`]);
      const visible = (await tx.select().from(aliases)).map((a) => a.aliasText);
      expect(visible).toContain(`global ${run}`);
      expect(visible).toContain(`a ${run}`);
      expect(visible).not.toContain(`b ${run}`);
    });
  });

  it("refuses to write another shop's rows", async () => {
    await expect(
      api.withShop(shopA, (tx) =>
        tx
          .insert(connections)
          .values({ shopId: shopB, kind: "db", secretEncrypted: "v1:x", status: "pending" }),
      ),
    ).rejects.toMatchObject({ cause: { code: "42501" } }); // new row violates row-level security policy
    const changed = await api.withShop(shopA, (tx) =>
      tx.update(connections).set({ label: "hijacked" }).where(eq(connections.shopId, shopB)).returning(),
    );
    expect(changed).toEqual([]);
  });

  it("shows nothing but global rows when no shop is set", async () => {
    await api.withAdmin(async (tx) => {
      expect(await tx.select().from(shops)).toEqual([]);
      expect(await tx.select().from(users)).toEqual([]);
      expect((await tx.select().from(aliases)).every((a) => a.shopId === null)).toBe(true);
    });
  });

  it("finds a login by its Supabase Auth user and nothing else", async () => {
    const rows = await api.withAuthUser(authB, (tx) => tx.select().from(users));
    expect(rows.map((u) => u.shopId)).toEqual([shopB]);
    expect(await api.withAuthUser(authB, (tx) => tx.select().from(shops))).toEqual([]);
  });

  it("lets a setup token be used once, then continues as its shop", async () => {
    const hash = `hash-${run}`;
    await admin.withAdmin((tx) =>
      tx.insert(setupTokens).values([
        {
          shopId: shopB,
          tokenHash: hash,
          purpose: "scanner_upload",
          expiresAt: new Date(Date.now() + 60_000),
          createdBy: authB,
        },
        {
          shopId: shopB,
          tokenHash: `${hash}-old`,
          purpose: "scanner_upload",
          expiresAt: new Date(Date.now() - 1000),
          createdBy: authB,
        },
      ]),
    );
    const seen = await api.withSetupToken(hash, async (tx, token) => {
      expect(token.shopId).toBe(shopB);
      return (await tx.select().from(shops)).map((s) => s.id);
    });
    expect(seen).toEqual([shopB]);
    await expect(api.withSetupToken(hash, async () => null)).rejects.toThrow(SetupTokenError);
    await expect(api.withSetupToken(`${hash}-old`, async () => null)).rejects.toMatchObject({
      reason: "expired",
    });
    await expect(api.withSetupToken("no-such-hash", async () => null)).rejects.toMatchObject({
      reason: "unknown",
    });
  });

  it("keeps one active speech provider per job and shop, global rows counted as one shop", async () => {
    const row = {
      shopId: shopA,
      job: "stt",
      provider: "speech_worker",
      external: false,
      active: true,
    } as const;
    await admin.withAdmin((tx) => tx.insert(aiProviders).values(row));
    await expect(admin.withAdmin((tx) => tx.insert(aiProviders).values(row))).rejects.toMatchObject({
      cause: { code: "23505" },
    });
    await admin.withAdmin((tx) => tx.insert(aiProviders).values({ ...row, active: false }));
  });

  it("keeps at most one open request frame per conversation", async () => {
    const [user] = await api.withShop(shopA, (tx) => tx.select().from(users));
    const frame = {
      shopId: shopA,
      intent: "find_parts",
      slots: {},
      expiresAt: new Date(Date.now() + 60_000),
    };
    await api.withShop(shopA, async (tx) => {
      const [conversation] = await tx
        .insert(conversations)
        .values({ shopId: shopA, userId: user?.id ?? "", channel: "chat" })
        .returning();
      const conversationId = conversation?.id ?? "";
      await tx.insert(requestFrames).values({ ...frame, conversationId, status: "active" });
      await tx.insert(requestFrames).values({ ...frame, conversationId, status: "set_aside" });
      await expect(
        tx.transaction((inner) =>
          inner.insert(requestFrames).values({ ...frame, conversationId, status: "confirming" }),
        ),
      ).rejects.toMatchObject({ cause: { code: "23505" } });
    });
  });
});
