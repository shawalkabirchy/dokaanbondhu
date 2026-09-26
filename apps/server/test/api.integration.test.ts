import { randomBytes, randomUUID } from "node:crypto";
import { aiProviders, createPlatform, shops, users, type Platform } from "@dokaanbondhu/platform-db";
import { sql } from "drizzle-orm";
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The Step 2 endpoints against the local CI database (spec 8, 18.1): login, roles, staff, settings, providers and
// shop isolation. Supabase's admin API is replaced by a fake, because CI has no Supabase project.

const SUPABASE_URL = "http://localhost:54321";
const JWT_SECRET = "server-test-secret-0123456789";
const urls = {
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
const allLocal = isLocal(urls.api) && isLocal(urls.admin);
if (process.env.CI === "true" && !allLocal)
  throw new Error("server integration tests need the local CI database");

Object.assign(process.env, {
  SUPABASE_URL,
  SUPABASE_SECRET_KEY: "sb_secret_fake_for_integration_tests",
  AES_KEY: randomBytes(32).toString("base64"),
  JWT_TEST_SECRET: JWT_SECRET,
});

const token = (authUserId: string) =>
  new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(authUserId)
    .setIssuer(`${SUPABASE_URL}/auth/v1`)
    .setAudience("authenticated")
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(JWT_SECRET));

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

async function call(
  handler: unknown,
  options: { auth?: string; method?: string; body?: unknown; params?: object },
) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.auth) headers.authorization = `Bearer ${await token(options.auth)}`;
  const request = new Request("http://localhost:3100/api/v1/test", {
    method: options.method ?? "GET",
    headers,
    body:
      options.body === undefined || (options.method ?? "GET") === "GET"
        ? undefined
        : JSON.stringify(options.body),
  });
  const response = await (handler as Handler)(request, { params: Promise.resolve({ ...options.params }) });
  return { status: response.status, body: await response.json() };
}

describe.skipIf(!allLocal)("server endpoints", () => {
  let admin: Platform;
  const shopA = randomUUID();
  const shopB = randomUUID();
  const ownerA = { id: randomUUID(), auth: randomUUID() };
  const staffA = { id: randomUUID(), auth: randomUUID() };
  const ownerB = { id: randomUUID(), auth: randomUUID() };
  const created: string[] = [];
  const providers = { ownStt: randomUUID(), ownScribe: randomUUID(), shopBStt: randomUUID() };
  let routes: Record<string, Record<string, unknown>>;

  beforeAll(async () => {
    admin = createPlatform(urls.admin, { max: 1 });
    await admin.withAdmin(async (tx) => {
      await tx.insert(shops).values([
        { id: shopA, name: "Shop A", ownerUserId: ownerA.id },
        { id: shopB, name: "Shop B", ownerUserId: ownerB.id },
      ]);
      await tx.insert(users).values([
        {
          id: ownerA.id,
          shopId: shopA,
          authUserId: ownerA.auth,
          name: "Owner A",
          email: "owner-a@t",
          role: "owner",
        },
        {
          id: staffA.id,
          shopId: shopA,
          authUserId: staffA.auth,
          name: "Staff A",
          email: "staff-a@t",
          role: "staff",
        },
        {
          id: ownerB.id,
          shopId: shopB,
          authUserId: ownerB.auth,
          name: "Owner B",
          email: "owner-b@t",
          role: "owner",
        },
      ]);
      await tx.execute(sql`delete from ai_providers where shop_id is null`);
      await tx.insert(aiProviders).values([
        {
          job: "llm",
          provider: "cloudflare",
          model: "@cf/google/gemma-4-26b-a4b-it",
          priority: 1,
          external: false,
        },
        { job: "llm", provider: "deepseek", model: "deepseek-flash", priority: 2, external: true },
        { job: "stt", provider: "speech_worker", active: true, external: false },
        { job: "tts", provider: "speech_worker", active: true, external: false },
        {
          id: providers.ownStt,
          shopId: shopA,
          job: "stt",
          provider: "speech_worker",
          active: true,
          external: false,
        },
        { id: providers.ownScribe, shopId: shopA, job: "stt", provider: "elevenlabs", external: true },
        {
          id: providers.shopBStt,
          shopId: shopB,
          job: "stt",
          provider: "speech_worker",
          active: true,
          external: false,
        },
      ]);
    });
    const { setAuthAdminForTests } = await import("../src/server/auth-admin");
    setAuthAdminForTests({
      async createUser({ email }) {
        if (email === "taken@shop.test") {
          const { appError } = await import("../src/server/errors");
          throw appError("VALIDATION_FAILED", 400, { field: "email", reason: "taken" });
        }
        const id = randomUUID();
        created.push(id);
        return { id };
      },
      async deleteUser() {},
    });
    routes = {
      health: await import("../app/api/v1/health/route"),
      me: await import("../app/api/v1/me/route"),
      staff: await import("../app/api/v1/staff/route"),
      staffOne: await import("../app/api/v1/staff/[userId]/route"),
      settings: await import("../app/api/v1/settings/route"),
      providers: await import("../app/api/v1/providers/route"),
      providerJob: await import("../app/api/v1/providers/[job]/route"),
    };
  });

  afterAll(async () => {
    await admin.withAdmin(async (tx) => {
      await tx.execute(
        sql`delete from ai_providers where shop_id in (${shopA}, ${shopB}) or shop_id is null`,
      );
      await tx.execute(sql`delete from users where shop_id in (${shopA}, ${shopB})`);
      await tx.execute(sql`delete from shops where id in (${shopA}, ${shopB})`);
    });
    await admin.end();
  });

  it("answers /health without a login: status from the database only", async () => {
    const { status, body } = await call(routes.health?.GET, {});
    expect(status).toBe(200);
    expect(body).toMatchObject({ status: "ok", db: "ok", speech: "unknown", llm: "unknown" });
  });

  it("refuses a request without a valid login, and a login without a users row", async () => {
    expect((await call(routes.me?.GET, {})).body.error.code).toBe("UNAUTHENTICATED");
    const unknown = await call(routes.me?.GET, { auth: randomUUID() });
    expect(unknown.status).toBe(403);
    expect(unknown.body.error.code).toBe("FORBIDDEN");
  });

  it("gives /me the user, shop, settings with defaults and the providers in use", async () => {
    const { status, body } = await call(routes.me?.GET, { auth: ownerA.auth });
    expect(status).toBe(200);
    expect(body.user).toMatchObject({ id: ownerA.id, role: "owner" });
    expect(body.shop).toEqual({ id: shopA, name: "Shop A", market_area: null });
    expect(body.settings).toMatchObject({ voice: "aditi", external_providers_allowed: false });
    expect(body.providers.llm.map((p: { provider: string }) => p.provider)).toEqual(["cloudflare"]);
    expect(body.providers.stt).toMatchObject({ id: providers.ownStt, scope: "shop" });
    expect(body.providers.tts).toMatchObject({ provider: "speech_worker", scope: "global" });
  });

  it("keeps owner-only endpoints from staff", async () => {
    for (const [handler, method] of [
      [routes.staff?.GET, "GET"],
      [routes.settings?.PATCH, "PATCH"],
      [routes.providers?.GET, "GET"],
    ] as const) {
      const { status, body } = await call(handler, { auth: staffA.auth, method, body: { voice: "x" } });
      expect(status).toBe(403);
      expect(body.error.code).toBe("FORBIDDEN");
    }
  });

  it("lets the owner add a staff login, and refuses a taken email or a short password", async () => {
    const made = await call(routes.staff?.POST, {
      auth: ownerA.auth,
      method: "POST",
      body: { name: "New Staff", email: "new@shop.test", password: "12345678" },
    });
    expect(made.status).toBe(201);
    expect(made.body.staff).toMatchObject({ name: "New Staff", role: "staff", status: "active" });
    const newAuth = created.at(-1) ?? "";
    expect((await call(routes.me?.GET, { auth: newAuth })).body.user.role).toBe("staff");

    const taken = await call(routes.staff?.POST, {
      auth: ownerA.auth,
      method: "POST",
      body: { name: "X", email: "taken@shop.test", password: "12345678" },
    });
    expect(taken.body.error).toMatchObject({ code: "VALIDATION_FAILED", details: { field: "email" } });
    const short = await call(routes.staff?.POST, {
      auth: ownerA.auth,
      method: "POST",
      body: { name: "X", email: "x@shop.test", password: "short" },
    });
    expect(short.status).toBe(400);
  });

  it("turns a staff login off at once, and never the owner's", async () => {
    const off = await call(routes.staffOne?.PATCH, {
      auth: ownerA.auth,
      method: "PATCH",
      body: { status: "disabled" },
      params: { userId: staffA.id },
    });
    expect(off.body.staff.status).toBe("disabled");
    const refused = await call(routes.me?.GET, { auth: staffA.auth });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("USER_DISABLED");
    const owner = await call(routes.staffOne?.PATCH, {
      auth: ownerA.auth,
      method: "PATCH",
      body: { status: "disabled" },
      params: { userId: ownerA.id },
    });
    expect(owner.status).toBe(403);
  });

  it("shows each owner only their own shop's logins", async () => {
    const { body } = await call(routes.staff?.GET, { auth: ownerB.auth });
    expect(body.staff.map((s: { id: string }) => s.id)).toEqual([ownerB.id]);
    const other = await call(routes.staffOne?.PATCH, {
      auth: ownerB.auth,
      method: "PATCH",
      body: { status: "disabled" },
      params: { userId: staffA.id },
    });
    expect(other.status).toBe(404);
  });

  it("switches the speech provider only among the shop's own rows, external only when allowed", async () => {
    const switchTo = (id: string, auth = ownerA.auth) =>
      call(routes.providerJob?.PATCH, {
        auth,
        method: "PATCH",
        body: { provider_id: id },
        params: { job: "stt" },
      });
    expect((await switchTo(providers.ownScribe)).body.error.code).toBe("EXTERNAL_PROVIDERS_NOT_ALLOWED");
    expect((await switchTo(providers.shopBStt)).status).toBe(404);

    const allowed = await call(routes.settings?.PATCH, {
      auth: ownerA.auth,
      method: "PATCH",
      body: { external_providers_allowed: true },
    });
    expect(allowed.body.settings.external_providers_allowed).toBe(true);
    const switched = await switchTo(providers.ownScribe);
    expect(switched.status).toBe(200);
    expect(switched.body.in_use.stt).toMatchObject({ id: providers.ownScribe, provider: "elevenlabs" });
    expect((await call(routes.me?.GET, { auth: ownerA.auth })).body.providers.llm).toHaveLength(2);

    const listed = await call(routes.providers?.GET, { auth: ownerA.auth });
    expect(listed.body.providers.filter((p: { job: string }) => p.job === "stt")).toHaveLength(2);
  });

  it("refuses a settings change the owner may not make", async () => {
    const { status } = await call(routes.settings?.PATCH, {
      auth: ownerA.auth,
      method: "PATCH",
      body: { evaluation_consent: true },
    });
    expect(status).toBe(400);
  });
});
