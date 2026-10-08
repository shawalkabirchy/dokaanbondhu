import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { CapabilityView, DiscoverResult } from "@dokaanbondhu/contracts";
import { applyVerification, importOpenApi, saveImport } from "@dokaanbondhu/engine/host";
import {
  capabilities,
  connections,
  createPlatform,
  shops,
  users,
  type Platform,
} from "@dokaanbondhu/platform-db";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { allLocal, token, urls, useTestEnvironment } from "./harness";

// The setup endpoints, API half (spec 8.3, 11.8, 11.12, 11.13; D134), against the test host's API that the CI job
// starts on port 4000: add and test an API connection, discover its capabilities, switch a write on under the rules,
// re-import, and confirm the feature list. Then the same for an app shaped unlike it: a bearer token, OpenAPI 3.0 and
// camelCase names, served by a small local host (D122).

useTestEnvironment();
const apiUrl = process.env.GEARGRID_API_URL ?? "";
const seedKey = process.env.SEED_API_KEY ?? "";
const apiLocal = (() => {
  try {
    return ["localhost", "127.0.0.1"].includes(new URL(apiUrl).hostname) && seedKey.length > 0;
  } catch {
    return false;
  }
})();
if (process.env.CI === "true" && !apiLocal) throw new Error("these tests need the API the CI job starts");

const fixture = JSON.parse(
  readFileSync(new URL("../../../tools/fixtures/openapi/geargrid-openapi.json", import.meta.url), "utf8"),
) as { paths: Record<string, unknown>; components: { schemas: Record<string, { properties: object }> } };

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
type Body = Record<string, unknown> & { error?: { code: string; details?: Record<string, unknown> } };

/** An app unlike the test host: OpenAPI 3.0, camelCase, a bearer token that guards the document too. */
const OTHER_TOKEN = "other-app-token";
const otherDocument = {
  openapi: "3.0.3",
  security: [{ token: [] }],
  components: { securitySchemes: { token: { type: "http", scheme: "bearer" } } },
  paths: {
    "/orders": {
      post: {
        operationId: "createOrder",
        "x-supports-dry-run": true,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["customerId", "lines"],
                properties: {
                  customerId: { type: "integer" },
                  lines: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["partId", "qty"],
                      properties: { partId: { type: "integer" }, qty: { type: "number" } },
                    },
                  },
                  paymentMethod: { type: "string", enum: ["cash", "bkash"] },
                },
              },
            },
          },
        },
        responses: { "201": { description: "ok" } },
      },
    },
    "/orders/{orderId}": {
      get: {
        operationId: "getOrder",
        parameters: [{ name: "orderId", in: "path", required: true, schema: { type: "integer" } }],
        responses: { "200": { description: "ok" } },
      },
    },
  },
};

describe.skipIf(!allLocal || !apiLocal)("setup endpoints, API half", () => {
  let admin: Platform;
  let other: Server;
  let otherUrl = "";
  let routes: Record<string, Record<string, unknown>>;
  const shopId = randomUUID();
  const owner = { id: randomUUID(), auth: randomUUID() };
  const staff = { id: randomUUID(), auth: randomUUID() };
  const created: string[] = [];
  let connectionId = "";
  let sale: CapabilityView;

  async function call(
    handler: unknown,
    options: { auth?: string; method?: string; body?: unknown; params?: object; query?: string } = {},
  ) {
    const method = options.method ?? "GET";
    const request = new Request(`http://localhost:3100/api/v1/test${options.query ?? ""}`, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await token(options.auth ?? owner.auth)}`,
      },
      body: method === "GET" ? undefined : JSON.stringify(options.body ?? {}),
    });
    const response = await (handler as Handler)(request, { params: Promise.resolve({ ...options.params }) });
    return { status: response.status, body: (await response.json()) as Body };
  }

  const addConnection = async (body: Record<string, unknown>) => {
    const answer = await call(routes.connections!.POST, { method: "POST", body: { kind: "api", ...body } });
    const id = (answer.body.connection as { id?: string } | undefined)?.id;
    if (id) created.push(id);
    return answer;
  };
  const byName = (list: CapabilityView[], name: string) => list.find((item) => item.name === name)!;
  const capability = async (id: string) =>
    (await call(routes.capability!.GET, { params: { id } })).body.capability as CapabilityView;
  const patch = (id: string, body: unknown, auth = owner.auth) =>
    call(routes.capability!.PATCH, { method: "PATCH", body, params: { id }, auth });

  beforeAll(async () => {
    admin = createPlatform(urls.admin, { max: 1 });
    await admin.withAdmin(async (tx) => {
      await tx.insert(shops).values({ id: shopId, name: "API setup shop", ownerUserId: owner.id });
      await tx.insert(users).values([
        { id: owner.id, shopId, authUserId: owner.auth, name: "Owner", email: "api-owner@t", role: "owner" },
        { id: staff.id, shopId, authUserId: staff.auth, name: "Staff", email: "api-staff@t", role: "staff" },
      ]);
    });
    other = createServer((request, response) => {
      const json = (status: number, body: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (request.headers.authorization !== `Bearer ${OTHER_TOKEN}`) return json(401, { message: "sign in" });
      if (request.url === "/shop/api/openapi.json") return json(200, otherDocument);
      json(404, { message: "not found" });
    });
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
    otherUrl = `http://127.0.0.1:${(other.address() as AddressInfo).port}/shop`;
    routes = {
      connections: await import("../app/api/v1/setup/connections/route"),
      test: await import("../app/api/v1/setup/connections/[id]/test/route"),
      discover: await import("../app/api/v1/setup/capabilities/discover/route"),
      capabilities: await import("../app/api/v1/setup/capabilities/route"),
      capability: await import("../app/api/v1/setup/capabilities/[id]/route"),
      features: await import("../app/api/v1/setup/features/route"),
    };
  });

  beforeEach(() => {
    // A fresh minute of setup calls for each test: together they make more than the 30 a minute a shop may (spec 8.7).
    (globalThis as { __dokaanRateLimiter?: unknown }).__dokaanRateLimiter = undefined;
  });

  afterAll(async () => {
    if (created.length) {
      await admin.withAdmin((tx) =>
        tx.update(connections).set({ status: "disabled" }).where(inArray(connections.id, created)),
      );
    }
    other.closeAllConnections();
    await new Promise((resolve) => other.close(resolve));
  });

  it("adds an API connection for the owner only, on https or this machine, and never returns its secret", async () => {
    expect(
      (
        await call(routes.connections!.POST, {
          auth: staff.auth,
          method: "POST",
          body: { kind: "api", base_url: apiUrl, auth_type: "api_key", secret: seedKey },
        })
      ).status,
    ).toBe(403);
    expect(
      await addConnection({ base_url: "http://shop.example.com", auth_type: "api_key", secret: "k" }),
    ).toMatchObject({
      status: 400,
      body: { error: { code: "VALIDATION_FAILED", details: { field: "base_url" } } },
    });
    expect(
      await addConnection({ base_url: apiUrl, auth_type: "bearer", auth_header: "X-Key", secret: "k" }),
    ).toMatchObject({ status: 400, body: { error: { details: { field: "auth_header" } } } });

    const answer = await addConnection({
      label: "Shop API",
      base_url: apiUrl,
      auth_type: "api_key",
      secret: seedKey,
    });
    expect(answer.status).toBe(201);
    expect(answer.body.connection).toMatchObject({
      kind: "api",
      base_url: apiUrl.replace(/\/+$/, ""),
      auth_type: "api_key",
      auth_header: null,
      ssl_mode: null,
      status: "pending",
    });
    expect(JSON.stringify(answer.body)).not.toContain(seedKey);
    connectionId = (answer.body.connection as { id: string }).id;
  });

  it("tests it: reads the document, takes the key's header from it and sees the key accepted; a wrong key is refused", async () => {
    const tested = await call(routes.test!.POST, { method: "POST", params: { id: connectionId } });
    expect(tested.body).toMatchObject({
      ok: true,
      operations: 19,
      key: "accepted",
      connection: { status: "active", auth_header: "X-Api-Key", last_error: null },
    });

    const wrong = await addConnection({
      base_url: apiUrl,
      auth_type: "api_key",
      auth_header: "X-Api-Key",
      secret: `ggk_${"0".repeat(32)}`,
    });
    const refused = await call(routes.test!.POST, {
      method: "POST",
      params: { id: (wrong.body.connection as { id: string }).id },
    });
    expect(refused.body).toMatchObject({
      ok: false,
      key: "refused",
      connection: { status: "error", last_error: "the host refused the key" },
    });
  });

  it("discovers every operation as a capability with its proposals, switched off, and the detected features", async () => {
    expect((await call(routes.discover!.POST, { auth: staff.auth, method: "POST", body: {} })).status).toBe(
      403,
    );
    const answer = await call(routes.discover!.POST, {
      method: "POST",
      body: { connection_id: connectionId },
    });
    expect(answer.status).toBe(200);
    const result = answer.body as unknown as DiscoverResult;
    expect(result.added).toHaveLength(19);
    expect(result).toMatchObject({
      changed: [],
      kept: [],
      removed: [],
      unresolved: [],
      features_confirmed: false,
    });
    expect(result.detected_features).toEqual({
      openapi: "/api/openapi.json",
      dry_run: "?dry_run=true",
      idempotency_header: "Idempotency-Key",
      bangla_errors: "error.message_bn",
      acting_user_header: "X-Acting-User",
    });

    sale = byName(result.capabilities, "record_sale");
    const voidSale = byName(result.capabilities, "void_sale");
    expect(sale).toMatchObject({
      kind: "write",
      template: "sale",
      required_role: "staff",
      dry_run: true,
      enabled: false,
      verified_at: null,
      is_compensation: false,
      compensation: { operation: "void_sale", capability_id: voidSale.id, id_from: "sale.id" },
      read_back: { operation: "get_sale", id_from: "sale.id" },
    });
    expect(sale.params.find((param) => param.path === "items[].part_id")).toMatchObject({
      entity_concept: "Part",
      semantic_slot: "items",
      safety_critical: true,
      confirmed: false,
    });
    expect(voidSale.is_compensation).toBe(true);
    expect(byName(result.capabilities, "reverse_payment").is_compensation).toBe(true);
    // its own compensation stays a tool (spec 9.6)
    expect(byName(result.capabilities, "update_price")).toMatchObject({
      is_compensation: false,
      required_role: "owner",
    });

    const listed = await call(routes.capabilities!.GET, { query: `?connection_id=${connectionId}` });
    expect((listed.body.capabilities as CapabilityView[]).map((item) => item.name).sort()).toEqual(
      result.capabilities.map((item) => item.name).sort(),
    );
    expect(await capability(sale.id)).toEqual(sale);
  });

  it("switches a write on only once verified with every required parameter confirmed; never a read or an undo action", async () => {
    expect(await patch(sale.id, { enabled: true })).toMatchObject({
      status: 409,
      body: { error: { code: "CAPABILITY_NOT_VERIFIED" } },
    });
    const all = (await call(routes.capabilities!.GET, { query: `?connection_id=${connectionId}` })).body
      .capabilities as CapabilityView[];
    expect(await patch(byName(all, "get_sale").id, { enabled: true })).toMatchObject({
      status: 400,
      body: { error: { details: { field: "enabled" } } },
    });
    expect(await patch(byName(all, "void_sale").id, { enabled: true })).toMatchObject({
      status: 400,
      body: { error: { details: { reason: "an undo action is never a tool (D52)" } } },
    });

    await admin.withAdmin((tx) =>
      tx.update(capabilities).set({ verifiedAt: new Date() }).where(eq(capabilities.id, sale.id)),
    );
    const unconfirmed = await patch(sale.id, { enabled: true });
    expect(unconfirmed).toMatchObject({ status: 400, body: { error: { code: "VALIDATION_FAILED" } } });
    expect(unconfirmed.body.error!.details!.unconfirmed).toEqual(
      expect.arrayContaining(["items[].part_id", "items[].quantity"]),
    );
    expect(
      await patch(sale.id, {
        params: [{ path: "payments[].method", spoken_map: { "ক্রেডিট কার্ড": "card" } }],
      }),
    ).toMatchObject({ status: 400, body: { error: { details: { values: ["card"] } } } });
    expect((await patch(sale.id, { enabled: true }, staff.auth)).status).toBe(403);

    const confirmed = await patch(sale.id, {
      params: [
        ...sale.params.map((param) => ({ path: param.path, confirmed: true })),
        {
          path: "payments[].method",
          spoken_map: { নগদে: "cash", nogode: "cash", বিকাশে: "bkash", bikashe: "bkash" },
        },
      ],
    });
    expect(confirmed.status).toBe(200);
    const enabled = await patch(sale.id, { enabled: true });
    expect(enabled).toMatchObject({ status: 200, body: { capability: { enabled: true } } });
    sale = enabled.body.capability as CapabilityView;
    expect(sale.params.every((param) => param.confirmed)).toBe(true);
    expect(sale.params.find((param) => param.path === "payments[].method")!.spoken_map).toEqual({
      নগদে: "cash",
      nogode: "cash",
      বিকাশে: "bkash",
      bikashe: "bkash",
    });
    // a switched-on capability cannot lose a required confirmation
    expect((await patch(sale.id, { params: [{ path: "items[].part_id", confirmed: false }] })).status).toBe(
      400,
    );
  });

  it("re-imports an unchanged document and keeps every choice", async () => {
    const result = (
      await call(routes.discover!.POST, { method: "POST", body: { connection_id: connectionId } })
    ).body as unknown as DiscoverResult;
    expect(result.kept).toHaveLength(19);
    expect(result).toMatchObject({ added: [], changed: [], removed: [] });
    expect(byName(result.capabilities, "record_sale")).toEqual(sale);
  });

  it("switches off a changed request until verified again, keeps a leaf that stayed, and links compensations again", async () => {
    const changed = structuredClone(fixture);
    changed.components.schemas.SaleInput!.properties = {
      ...changed.components.schemas.SaleInput!.properties,
      vehicle_note: { type: "string" },
    };
    delete changed.paths["/api/v1/sales/{id}/void"];
    const summary = await admin.withAdmin((tx) =>
      saveImport(tx, shopId, connectionId, importOpenApi(changed)),
    );
    expect(summary).toMatchObject({
      changed: ["record_sale"],
      removed: ["void_sale"],
      unresolved: ["record_sale"],
    });

    const after = await capability(sale.id);
    expect(after).toMatchObject({ enabled: false, verified_at: null, compensation: { capability_id: null } });
    expect(after.params.find((param) => param.path === "customer_id")!.confirmed).toBe(true);
    expect(after.params.find((param) => param.path === "vehicle_note")).toMatchObject({ confirmed: false });

    // the live document again: the request is back as it was, still to be verified; void_sale is linked again
    const result = (
      await call(routes.discover!.POST, { method: "POST", body: { connection_id: connectionId } })
    ).body as unknown as DiscoverResult;
    expect(result.changed).toEqual(["record_sale"]);
    const back = byName(result.capabilities, "record_sale");
    expect(back).toMatchObject({ enabled: false, verified_at: null });
    expect(back.compensation!.capability_id).toBe(byName(result.capabilities, "void_sale").id);
    expect(back.params.map((param) => param.path)).not.toContain("vehicle_note");
  });

  it("keeps the feature list detected until the owner confirms it, and a later discovery leaves it alone", async () => {
    const listed = await call(routes.features!.GET);
    expect(listed.body.connections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          connection_id: connectionId,
          confirmed_at: null,
          features: expect.objectContaining({ dry_run: "?dry_run=true" }),
        }),
      ]),
    );
    expect(
      (
        await call(routes.features!.PUT, {
          method: "PUT",
          body: { connection_id: connectionId, features: { dry_run: "?dry_run=true", made_up: true } },
        })
      ).status,
    ).toBe(400);
    const features = {
      openapi: "/api/openapi.json",
      dry_run: "?dry_run=true",
      idempotency_header: "Idempotency-Key",
      acting_user_header: "X-Acting-User",
    };
    const put = await call(routes.features!.PUT, {
      method: "PUT",
      body: { connection_id: connectionId, features },
    });
    expect(put).toMatchObject({ status: 200, body: { features, confirmed_at: expect.any(String) } });

    const again = (
      await call(routes.discover!.POST, { method: "POST", body: { connection_id: connectionId } })
    ).body as unknown as DiscoverResult;
    expect(again).toMatchObject({
      features_confirmed: true,
      detected_features: { bangla_errors: "error.message_bn" },
    });
    const after = (await call(routes.features!.GET)).body.connections as {
      connection_id: string;
      features: object;
    }[];
    expect(after.find((item) => item.connection_id === connectionId)!.features).toEqual(features);
  });

  it("does the same for an app shaped unlike the test host: a bearer token, OpenAPI 3.0, camelCase names", async () => {
    const answer = await addConnection({
      label: "Other app",
      base_url: otherUrl,
      auth_type: "bearer",
      secret: OTHER_TOKEN,
    });
    const id = (answer.body.connection as { id: string }).id;
    const tested = await call(routes.test!.POST, { method: "POST", params: { id } });
    expect(tested.body).toMatchObject({
      ok: true,
      operations: 2,
      key: "accepted",
      connection: { status: "active" },
    });

    const result = (await call(routes.discover!.POST, { method: "POST", body: { connection_id: id } }))
      .body as unknown as DiscoverResult;
    expect(result.detected_features).toEqual({ openapi: "/api/openapi.json", dry_run: "?dry_run=true" });
    const order = byName(result.capabilities, "create_order");
    expect(order).toMatchObject({ template: "sale", dry_run: true, compensation: null, enabled: false });
    expect(Object.fromEntries(order.params.map((param) => [param.path, param.semantic_slot]))).toEqual({
      customerId: "customer",
      "lines[].partId": "items",
      "lines[].qty": "items",
      paymentMethod: "payment",
    });
    expect(order.params.find((param) => param.path === "paymentMethod")!.spoken_map).toMatchObject({
      নগদে: "cash",
      nogode: "cash",
      বিকাশ: "bkash",
      bkash: "bkash",
    });

    const wrong = await addConnection({ base_url: otherUrl, auth_type: "bearer", secret: "not-the-token" });
    const refused = await call(routes.test!.POST, {
      method: "POST",
      params: { id: (wrong.body.connection as { id: string }).id },
    });
    expect(refused.body).toMatchObject({ ok: false, error: expect.stringMatching(/401/) });
  });

  it("marks a capability verified only when the sandbox report has it passing with its current hash (spec 11.11)", async () => {
    const all = (await call(routes.capabilities!.GET, { query: `?connection_id=${connectionId}` })).body
      .capabilities as CapabilityView[];
    const payment = byName(all, "receive_payment");
    const stockIn = byName(all, "stock_in");
    const price = byName(all, "update_price");
    const report = {
      host: "test host",
      commit: "ci",
      date: new Date().toISOString(),
      capabilities: [
        { name: "receive_payment", schema_hash: payment.schema_hash, result: "pass" as const, checks: [] },
        { name: "stock_in", schema_hash: "0".repeat(64), result: "pass" as const, checks: [] },
        { name: "update_price", schema_hash: price.schema_hash, result: "fail" as const, checks: [] },
      ],
    };
    const result = await admin.withAdmin((tx) => applyVerification(tx, connectionId, report, new Date()));
    expect(result).toEqual({ verified: ["receive_payment"], unmatched: ["stock_in"] });
    expect((await capability(payment.id)).verified_at).not.toBeNull();
    expect((await capability(stockIn.id)).verified_at).toBeNull();
    expect((await capability(price.id)).verified_at).toBeNull();
  });
});
