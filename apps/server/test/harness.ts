import { randomBytes, randomUUID } from "node:crypto";
import { readReplyStream, type ReplyEvent } from "@dokaanbondhu/contracts";
import { encryptSecret } from "@dokaanbondhu/engine/crypto";
import { confirmEntity, HostPools, syncConnection, type HostDb } from "@dokaanbondhu/engine/host";
import { aiProviders, connections, shops, users, type Platform } from "@dokaanbondhu/platform-db";
import { eq } from "drizzle-orm";
import { SignJWT } from "jose";
import { geargridMap } from "../../../packages/engine/test/geargrid-map";

// Shared set-up of the server's integration tests against the local CI databases (spec 18.1): the environment, test
// tokens, a shop whose host is the CI copy of GearGrid with its map confirmed and its catalog synced, and a chat call
// that reads the NDJSON reply.

export const SUPABASE_URL = "http://localhost:54321";
export const JWT_SECRET = "server-test-secret-0123456789";
export const EVAL_KEY = "eval-key-for-integration-tests";

export const urls = {
  api: process.env.PLATFORM_DATABASE_URL ?? "",
  admin: process.env.PLATFORM_ADMIN_DATABASE_URL ?? "",
  host: process.env.MIGRATION_DATABASE_URL ?? "",
};

const isLocal = (url: string) => {
  try {
    return ["localhost", "127.0.0.1"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
};

export const allLocal = isLocal(urls.api) && isLocal(urls.admin) && isLocal(urls.host);

/** Sets the server's environment; call it at the top of a test file, before any route is imported. */
export function useTestEnvironment(): Buffer {
  if (process.env.CI === "true" && !allLocal) throw new Error("these tests need the local CI databases");
  const aesKey = randomBytes(32);
  Object.assign(process.env, {
    SUPABASE_URL,
    SUPABASE_SECRET_KEY: "sb_secret_fake_for_integration_tests",
    AES_KEY: aesKey.toString("base64"),
    JWT_TEST_SECRET: JWT_SECRET,
    EVAL_MODE_SECRET: EVAL_KEY,
  });
  return aesKey;
}

export const token = (authUserId: string) =>
  new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(authUserId)
    .setIssuer(`${SUPABASE_URL}/auth/v1`)
    .setAudience("authenticated")
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(JWT_SECRET));

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

export async function post(
  handler: unknown,
  auth: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const request = new Request("http://localhost:3100/api/v1/test", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${await token(auth)}`, ...headers },
    body: JSON.stringify(body),
  });
  return (handler as Handler)(request, { params: Promise.resolve({}) });
}

/** A chat request with its reply read: the response, every event, and the text sentences joined. */
export async function chatCall(
  handler: unknown,
  auth: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  const response = await post(handler, auth, body, headers);
  const events: ReplyEvent[] = [];
  if (response.headers.get("content-type")?.startsWith("application/x-ndjson")) {
    await readReplyStream(response.body!.getReader(), (event) => events.push(event));
  }
  const reply = events
    .filter((event): event is Extract<ReplyEvent, { type: "text" }> => event.type === "text")
    .map((event) => event.text)
    .join(" ");
  return { response, events, reply };
}

/** The CI copy of GearGrid through DokaanBondhu's read-only role. */
export function readOnlyHost(): HostDb {
  const host = new URL(urls.host || "postgres://localhost/geargrid");
  return {
    id: `ro-${randomUUID()}`,
    dialect: "postgres",
    host: host.hostname,
    port: Number(host.port || 5432),
    database: host.pathname.slice(1),
    username: "dokaanbondhu_ro",
    password: process.env.DOKAAN_RO_PASSWORD ?? "",
    sslMode: "disable",
    sslCa: null,
    poolMax: 1,
  };
}

export interface HostShop {
  shopId: string;
  owner: { id: string; auth: string };
  staff: { id: string; auth: string };
  connectionId: string;
}

/** A shop with an owner, a staff user, the stub LLM, and GearGrid's copy as its host (map confirmed, catalog synced). */
export async function createHostShop(
  admin: Platform,
  aesKey: Buffer,
  llmBaseUrl: string,
  name: string,
): Promise<HostShop> {
  const shop: HostShop = {
    shopId: randomUUID(),
    owner: { id: randomUUID(), auth: randomUUID() },
    staff: { id: randomUUID(), auth: randomUUID() },
    connectionId: randomUUID(),
  };
  const db = readOnlyHost();
  const slug = name.toLowerCase().replace(/[^a-z]+/g, "-");
  await admin.withAdmin(async (tx) => {
    await tx.insert(shops).values({ id: shop.shopId, name, ownerUserId: shop.owner.id });
    await tx.insert(users).values([
      {
        id: shop.owner.id,
        shopId: shop.shopId,
        authUserId: shop.owner.auth,
        name: "Owner",
        email: `${slug}-owner@t`,
        role: "owner",
      },
      {
        id: shop.staff.id,
        shopId: shop.shopId,
        authUserId: shop.staff.auth,
        name: "Staff",
        email: `${slug}-staff@t`,
        role: "staff",
      },
    ]);
    await tx.insert(aiProviders).values({
      shopId: shop.shopId,
      job: "llm",
      provider: "vllm",
      model: "stub",
      baseUrl: llmBaseUrl,
      priority: 1,
      external: false,
    });
    await tx.insert(connections).values({
      id: shop.connectionId,
      shopId: shop.shopId,
      kind: "db",
      dialect: "postgres",
      host: db.host,
      port: db.port,
      database: db.database,
      username: db.username,
      sslMode: "disable",
      status: "active",
      secretEncrypted: encryptSecret(
        aesKey,
        { table: "connections", rowId: shop.connectionId, column: "secret_encrypted" },
        db.password,
      ),
    });
  });
  for (const entity of Object.values(geargridMap.entities)) {
    if (entity) {
      await admin.withAdmin((tx) => confirmEntity(tx, shop.shopId, shop.connectionId, entity, shop.owner.id));
    }
  }
  const pools = new HostPools();
  try {
    await syncConnection((fn) => admin.withAdmin(fn), pools, aesKey, shop.shopId, shop.connectionId);
  } finally {
    await pools.closeAll();
  }
  return shop;
}

/**
 * Switches the shop's connection off instead of deleting the shop: the CI database is thrown away after the job, and
 * a catalog sync running in another test file at the same time never meets a half-deleted shop.
 */
export async function disableConnection(admin: Platform, connectionId: string): Promise<void> {
  await admin.withAdmin((tx) =>
    tx.update(connections).set({ status: "disabled" }).where(eq(connections.id, connectionId)),
  );
}
