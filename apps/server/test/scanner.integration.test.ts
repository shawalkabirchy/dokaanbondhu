import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ScannerSummary } from "@dokaanbondhu/contracts";
import { encryptSecret } from "@dokaanbondhu/engine/crypto";
import {
  aiProviders,
  capabilities,
  capabilityParams,
  connections,
  createPlatform,
  setupTokenHash,
  setupTokens,
  shops,
  users,
  type Platform,
} from "@dokaanbondhu/platform-db";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { post, urls, useTestEnvironment } from "./harness";
import { startStubLlm, type StubLlm } from "./stub-llm";

// The Laravel scanner's upload (spec 8.3, 11.8, 16.3; D182, D183): the owner's one-time token, the summary of the
// scanner's fixture app turned into capabilities through the OpenAPI importer, the LLM's one-line descriptions, and
// every way a token is refused.

const aesKey = useTestEnvironment();
const summary = JSON.parse(
  readFileSync(new URL("../../../fixtures/laravel/expected-summary.json", import.meta.url), "utf8"),
) as ScannerSummary;
const WRITES = summary.routes.filter((route) => route.method !== "GET").length;

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
type Body = Record<string, unknown> & { error?: { code: string; details?: Record<string, unknown> } };

describe("scanner token and upload", () => {
  let admin: Platform;
  let llm: StubLlm;
  let routes: { tokens: Handler; upload: Handler };
  const shopId = randomUUID();
  const bare = randomUUID(); // a shop without an API connection yet
  const owner = { id: randomUUID(), auth: randomUUID() };
  const staff = { id: randomUUID(), auth: randomUUID() };
  const bareOwner = { id: randomUUID(), auth: randomUUID() };
  const connectionId = randomUUID();

  const apiConnection = (id: string, shop: string) => ({
    id,
    shopId: shop,
    kind: "api",
    baseUrl: "http://localhost:8080",
    authType: "session",
    loginConfig: {
      login_path: "/login",
      user_field: "email",
      password_field: "password",
      user: "owner@shop.test",
    },
    status: "pending",
    poolMax: 1,
    secretEncrypted: encryptSecret(
      aesKey,
      { table: "connections", rowId: id, column: "secret_encrypted" },
      "pw",
    ),
  });

  const newToken = async (auth = owner.auth) => {
    const response = await post(routes.tokens, auth, {});
    return { status: response.status, body: (await response.json()) as Body };
  };
  const upload = async (token: string | null, body: unknown = summary) => {
    const response = await routes.upload(
      new Request("http://localhost:3100/api/v1/setup/scanner-upload", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token === null ? {} : { "x-setup-token": token }),
        },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({}) },
    );
    return { status: response.status, body: (await response.json()) as Body };
  };

  beforeAll(async () => {
    admin = createPlatform(urls.admin, { max: 1 });
    llm = await startStubLlm();
    await admin.withAdmin(async (tx) => {
      await tx.insert(shops).values([
        { id: shopId, name: "Scanner shop", ownerUserId: owner.id },
        { id: bare, name: "Scanner shop without an API", ownerUserId: bareOwner.id },
      ]);
      await tx.insert(users).values([
        { id: owner.id, shopId, authUserId: owner.auth, name: "Owner", email: "scan-owner@t", role: "owner" },
        { id: staff.id, shopId, authUserId: staff.auth, name: "Staff", email: "scan-staff@t", role: "staff" },
        {
          id: bareOwner.id,
          shopId: bare,
          authUserId: bareOwner.auth,
          name: "Owner",
          email: "scan-bare@t",
          role: "owner",
        },
      ]);
      await tx.insert(aiProviders).values({
        shopId,
        job: "llm",
        provider: "vllm",
        model: "stub",
        baseUrl: llm.baseUrl,
        priority: 1,
        external: false,
      });
      await tx.insert(connections).values(apiConnection(connectionId, shopId));
    });
    routes = {
      tokens: (await import("../app/api/v1/setup/scanner-tokens/route")).POST as Handler,
      upload: (await import("../app/api/v1/setup/scanner-upload/route")).POST as Handler,
    };
  });

  beforeEach(() => {
    (globalThis as { __dokaanRateLimiter?: unknown }).__dokaanRateLimiter = undefined;
    llm.script.length = 0;
  });

  afterAll(async () => {
    await admin.withAdmin((tx) =>
      tx
        .update(connections)
        .set({ status: "disabled" })
        .where(inArray(connections.shopId, [shopId, bare])),
    );
    await llm.close();
    await admin.end();
  });

  it("gives the owner a token for 15 minutes, stores only its hash, and refuses staff", async () => {
    expect((await newToken(staff.auth)).status).toBe(403);
    const { status, body } = await newToken();
    expect(status).toBe(201);
    const token = String(body.token);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const minutes = (Date.parse(String(body.expires_at)) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(14);
    expect(minutes).toBeLessThanOrEqual(15);
    const rows = await admin.withAdmin((tx) =>
      tx.select().from(setupTokens).where(eq(setupTokens.shopId, shopId)),
    );
    expect(rows.map((row) => row.tokenHash)).toContain(setupTokenHash(token));
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it("turns the summary into the connection's capabilities, switched off, each write described by the LLM", async () => {
    const { body: issued } = await newToken();
    for (let index = 0; index < WRITES; index++)
      llm.script.push({ text: '{"description": "Records a shop action"}' });
    const { status, body } = await upload(String(issued.token));
    expect(status).toBe(200);
    expect(body).toMatchObject({ connection_id: connectionId, changed: [], removed: [], described: WRITES });
    expect((body.added as string[]).sort()).toEqual(
      [
        "sales_index",
        "sales_store",
        "sales_show",
        "sales_void",
        "returns_store",
        "parts_price",
        "parts_destroy",
        "payments_store",
        "payment_show",
        "stock_in",
      ].sort(),
    );
    const rows = await admin.withAdmin((tx) =>
      tx.select().from(capabilities).where(eq(capabilities.connectionId, connectionId)),
    );
    expect(rows.every((row) => row.source === "scanner" && !row.enabled && !row.verifiedAt)).toBe(true);
    const sale = rows.find((row) => row.name === "sales_store")!;
    expect(sale).toMatchObject({ kind: "write", httpMethod: "POST", path: "/sales", template: "sale" });
    expect(sale.description).toMatch(/^Records a shop action\. StoreSaleRequest: customer_id\?/);
    // A read is not described: only writes are.
    expect(rows.find((row) => row.name === "sales_index")!.description).toMatch(
      /^GET \/sales \(SaleController@index\)/,
    );
    const params = await admin.withAdmin((tx) =>
      tx.select().from(capabilityParams).where(eq(capabilityParams.capabilityId, sale.id)),
    );
    expect(Object.fromEntries(params.map((param) => [param.path, param.semanticSlot]))).toMatchObject({
      customer_id: "customer",
      "items[].part_id": "items",
      "items[].quantity": "items",
      payment_method: "payment",
    });
    // The LLM was asked about write routes only, one call each.
    expect(llm.received).toHaveLength(WRITES);
  });

  it("refuses a token used once, an expired one, a wrong one, and none", async () => {
    const { body: issued } = await newToken();
    const token = String(issued.token);
    expect((await upload(token)).status).toBe(200); // the LLM has no script: every route keeps its own description
    const again = await upload(token);
    expect(again.status).toBe(401);
    expect(again.body.error).toMatchObject({ code: "SETUP_TOKEN_INVALID", details: { reason: "used" } });

    const expired = `expired-${randomUUID()}`; // its own each run, as the hash is unique
    await admin.withAdmin((tx) =>
      tx.insert(setupTokens).values({
        shopId,
        tokenHash: setupTokenHash(expired),
        purpose: "scanner_upload",
        expiresAt: new Date(Date.now() - 1000),
        createdBy: owner.id,
      }),
    );
    expect((await upload(expired)).body.error).toMatchObject({ details: { reason: "expired" } });
    expect((await upload("never-issued-token-0123456789abcdef")).body.error).toMatchObject({
      code: "SETUP_TOKEN_INVALID",
      details: { reason: "unknown" },
    });
    expect((await upload(null)).status).toBe(401);
  });

  it("checks the summary before the token is used, and keeps the token when the shop has no API connection yet", async () => {
    const { body: issued } = await newToken(bareOwner.auth);
    const token = String(issued.token);
    expect((await upload(token, { ...summary, framework: "express" })).status).toBe(400);
    const missing = await upload(token);
    expect(missing.status).toBe(404);
    expect(missing.body.error).toMatchObject({ code: "NOT_FOUND", details: { entity: "connection" } });
    await admin.withAdmin((tx) => tx.insert(connections).values(apiConnection(randomUUID(), bare)));
    const done = await upload(token);
    expect(done.status).toBe(200);
    expect((done.body.added as string[]).length).toBe(summary.routes.length);
  });
});
