import { randomBytes, randomUUID } from "node:crypto";
import type { SchemaView } from "@dokaanbondhu/contracts";
import {
  aiProviders,
  connections,
  createPlatform,
  shops,
  users,
  type Platform,
} from "@dokaanbondhu/platform-db";
import { eq } from "drizzle-orm";
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { geargridMap } from "../../../packages/engine/test/geargrid-map";
import { startStubLlm, type StubLlm } from "./stub-llm";

// The setup endpoints, database half (spec 8.3, 11.3, 11.4, 11.7), against the CI copy of GearGrid: add and test a
// read-only connection, let the (stub) LLM propose the schema map, confirm and correct it, sync the catalog, and
// confirm the stock-value formula. The stub proposes GearGrid's known map, so the mapper's own checks run on it.

const SUPABASE_URL = "http://localhost:54321";
const JWT_SECRET = "server-test-secret-0123456789";
const urls = {
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
const allLocal = isLocal(urls.api) && isLocal(urls.admin) && isLocal(urls.host);
if (process.env.CI === "true" && !allLocal)
  throw new Error("setup integration tests need the local CI databases");

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

/** GearGrid's known map in the LLM's proposal format (spec 11.3). */
const proposal = {
  entities: Object.values(geargridMap.entities).map((entity) => ({
    concept: entity!.concept,
    host_table: entity!.hostTable,
    joins: entity!.joins.map((join) => ({ table: join.table, on: join.on })),
    row_filters: entity!.rowFilters,
    fields: Object.values(entity!.fields).map((field) => ({
      concept_field: field.conceptField,
      host_table: field.hostTable,
      host_column: field.hostColumn,
    })),
  })),
};

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
type Routes = Record<
  "connections" | "test" | "propose" | "schema" | "entity" | "sync" | "reports",
  Record<string, unknown>
>;

describe.skipIf(!allLocal)("setup endpoints, database half", () => {
  let admin: Platform;
  let llm: StubLlm;
  let routes: Routes;
  const shopId = randomUUID();
  const owner = { id: randomUUID(), auth: randomUUID() };
  const staff = { id: randomUUID(), auth: randomUUID() };
  const host = new URL(urls.host || "postgres://localhost/geargrid");
  let connectionId = "";

  async function call(
    handler: unknown,
    options: { auth?: string; method?: string; body?: unknown; params?: object; query?: string },
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
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  const connectionBody = (overrides: Record<string, unknown> = {}) => ({
    kind: "db",
    label: "GearGrid (CI)",
    dialect: "postgres",
    host: host.hostname,
    port: Number(host.port || 5432),
    database: host.pathname.slice(1),
    username: "dokaanbondhu_ro",
    password: process.env.DOKAAN_RO_PASSWORD ?? "",
    ssl_mode: "disable",
    ...overrides,
  });

  beforeAll(async () => {
    llm = await startStubLlm();
    admin = createPlatform(urls.admin, { max: 1 });
    await admin.withAdmin(async (tx) => {
      await tx.insert(shops).values({ id: shopId, name: "Setup shop", ownerUserId: owner.id });
      await tx.insert(users).values([
        {
          id: owner.id,
          shopId,
          authUserId: owner.auth,
          name: "Owner",
          email: "setup-owner@t",
          role: "owner",
        },
        {
          id: staff.id,
          shopId,
          authUserId: staff.auth,
          name: "Staff",
          email: "setup-staff@t",
          role: "staff",
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
    });
    routes = {
      connections: await import("../app/api/v1/setup/connections/route"),
      test: await import("../app/api/v1/setup/connections/[id]/test/route"),
      propose: await import("../app/api/v1/setup/schema/propose/route"),
      schema: await import("../app/api/v1/setup/schema/route"),
      entity: await import("../app/api/v1/setup/schema/[entityId]/route"),
      sync: await import("../app/api/v1/setup/catalog/sync/route"),
      reports: await import("../app/api/v1/setup/reports/route"),
    };
  });

  afterAll(async () => {
    // Switched off, not deleted: a catalog sync in another test file may be reading every active connection.
    if (connectionId) {
      await admin.withAdmin((tx) =>
        tx.update(connections).set({ status: "disabled" }).where(eq(connections.id, connectionId)),
      );
    }
    const { hostPools } = await import("../src/server/host");
    await hostPools().closeAll();
    await llm.close();
  });

  it("adds a connection for the owner only, never returns its password, and refuses disable for a remote host", async () => {
    expect(
      (await call(routes.connections.POST, { auth: staff.auth, method: "POST", body: connectionBody() }))
        .status,
    ).toBe(403);
    const remote = await call(routes.connections.POST, {
      method: "POST",
      body: connectionBody({ host: "db.example.com" }),
    });
    expect(remote).toMatchObject({ status: 400, body: { error: { code: "VALIDATION_FAILED" } } });
    const created = await call(routes.connections.POST, { method: "POST", body: connectionBody() });
    expect(created.status).toBe(201);
    const connection = created.body.connection as { id: string; status: string };
    connectionId = connection.id;
    expect(connection.status).toBe("pending");
    expect(JSON.stringify(created.body)).not.toContain(process.env.DOKAAN_RO_PASSWORD ?? "never-empty");
    const listed = await call(routes.connections.GET, {});
    expect(listed.body.connections).toEqual([expect.objectContaining({ id: connectionId })]);
  });

  it("tests the connection read-only and marks it active; a wrong password is an error with the reason", async () => {
    const tested = await call(routes.test.POST, { method: "POST", params: { id: connectionId } });
    expect(tested.body).toMatchObject({ ok: true, connection: { status: "active", last_error: null } });
    expect(tested.body.tables).toBeGreaterThan(20);

    const wrong = await call(routes.connections.POST, {
      method: "POST",
      body: connectionBody({ password: "not-the-password" }),
    });
    const wrongId = (wrong.body.connection as { id: string }).id;
    const failed = await call(routes.test.POST, { method: "POST", params: { id: wrongId } });
    expect(failed.body).toMatchObject({ ok: false, connection: { status: "error" } });
    expect(String(failed.body.error)).toMatch(/password/i);
  });

  it("proposes the schema map with one LLM call and shows sample values as they will be spoken", async () => {
    llm.script.push({ text: JSON.stringify(proposal) });
    const proposed = await call(routes.propose.POST, {
      method: "POST",
      body: { connection_id: connectionId },
    });
    expect(proposed.status).toBe(200);
    expect(llm.received).toHaveLength(1);
    const schema = proposed.body.schema as SchemaView;
    expect(schema.entities.map((entity) => entity.concept)).toEqual(
      expect.arrayContaining(["Part", "Vehicle", "Fitment", "StockItem", "Price", "Customer"]),
    );
    expect(schema.entities.every((entity) => !entity.confirmed)).toBe(true);
    const price = schema.entities.find((entity) => entity.concept === "Price")!;
    const retail = price.fields.find((field) => field.concept_field === "retail_price")!;
    expect(retail).not.toHaveProperty("value_scale"); // money is whole taka, never a scale (D110)
    expect(retail.samples.length).toBeGreaterThan(0);
    expect(retail.samples.every((sample) => sample.endsWith("টাকা"))).toBe(true);

    const read = await call(routes.schema.GET, { query: `?connection_id=${connectionId}` });
    expect((read.body.schema as SchemaView).entities).toHaveLength(schema.entities.length);
  });

  it("confirms each concept; a correction naming a column the host lacks keeps only the real columns", async () => {
    const schema = (await call(routes.schema.GET, { query: `?connection_id=${connectionId}` })).body
      .schema as SchemaView;
    const supplier = schema.entities.find((entity) => entity.concept === "Supplier")!;
    const corrected = await call(routes.entity.PUT, {
      method: "PUT",
      params: { entityId: supplier.id },
      body: {
        entity: {
          host_table: supplier.host_table,
          joins: supplier.joins.map((join) => ({ table: join.table, on: join.on })),
          row_filters: supplier.row_filters,
          fields: [
            ...supplier.fields.map((field) => ({
              concept_field: field.concept_field,
              host_table: field.host_table,
              host_column: field.host_column,
            })),
            {
              concept_field: "phone",
              host_table: "suppliers",
              host_column: "no_such_column",
            },
          ],
        },
      },
    });
    expect(corrected.status).toBe(200);
    const after = corrected.body.schema as SchemaView;
    expect(after.warnings.join(" ")).toContain("no_such_column");
    const stored = after.entities.find((entity) => entity.concept === "Supplier")!;
    expect(stored.confirmed).toBe(true);
    expect(stored.fields.map((field) => field.host_column)).not.toContain("no_such_column");

    for (const entity of schema.entities.filter((candidate) => candidate.concept !== "Supplier")) {
      const confirmed = await call(routes.entity.PUT, { method: "PUT", params: { entityId: entity.id } });
      expect(confirmed.status).toBe(200);
    }
    const final = (await call(routes.schema.GET, { query: `?connection_id=${connectionId}` })).body
      .schema as SchemaView;
    expect(final.entities.every((entity) => entity.confirmed)).toBe(true);
  });

  it("syncs the catalog, then proposes and confirms the stock-value formula with its current result", async () => {
    const synced = await call(routes.sync.POST, { method: "POST", body: { connection_id: connectionId } });
    expect(synced.body.catalog).toMatchObject({ parts: 237, vehicles: 40, customers: 30, suppliers: 5 });

    const reports = await call(routes.reports.GET, { query: `?connection_id=${connectionId}` });
    expect(reports.body.reports).toMatchObject({
      stock_value: { available: true, confirmed: false },
      see_in_app: ["profit_loss", "cash_book"],
    });
    const current = (reports.body.reports as { stock_value: { current_taka: number } }).stock_value
      .current_taka;
    expect(current).toBeGreaterThan(0);

    const confirmed = await call(routes.reports.PUT, {
      method: "PUT",
      body: { connection_id: connectionId, name: "stock_value" },
    });
    expect(confirmed.body.reports).toMatchObject({
      stock_value: { available: true, confirmed: true, current_taka: current },
    });
  });
});
