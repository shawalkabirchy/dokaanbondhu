import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { ApiConnection } from "../src/host/api";

// The stub host (spec 18.1, D181): a small shop app in the test's own process, named unlike GearGrid (orders, lines,
// customerId), whose OpenAPI document and feature list follow its switches, so every optional feature's fallback runs
// in CI against a real HTTP app. It records every request it gets. With `session` it signs in as a Laravel app does
// (D183): a CSRF cookie, a login that starts a new session, 419 for a stale token and 401 for a session it forgot.

export interface StubFeatures {
  dryRun?: boolean;
  idempotency?: boolean;
  undo?: boolean;
  banglaErrors?: boolean;
  actingUser?: boolean;
  paymentMethods?: boolean;
  reports?: boolean;
  syncStatus?: boolean;
  /** A Laravel-style session sign-in instead of an API key. */
  session?: boolean;
}

export interface StubRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
}

export interface StubState {
  /** Refuse every order, as an app does that is out of stock. */
  refuse?: boolean;
  /** A report endpoint that fails. */
  brokenReports?: boolean;
  /** When the app's phones last synced. */
  lastSync?: Date;
  /** A saved order, so the test's stock can move as the app's does. */
  onOrder?: (body: unknown) => void;
  /** How a session login answers: JSON (as Fortify does) or a redirect (as a form login does). */
  loginAnswer?: "json" | "redirect";
  /** Every call answers 401 after the login, as an app does whose sessions never hold. */
  refuseSessions?: boolean;
}

const KEY_HEADER = "x-shop-key";
const SECRET = "stub-secret";
/** The app's own total for an order, unlike the 1,600-a-set prices the tests' catalog has. */
export const STUB_TOTAL = 2900;
/** The app's own profit report. */
export const STUB_PROFIT = 45000;
/** The user a session app signs in. */
export const STUB_USER = "owner@stub.test";

function documentOf(features: StubFeatures) {
  const json = (schema: unknown) => ({ "application/json": { schema } });
  const ok = (schema: unknown = { type: "object" }) => ({ description: "ok", content: json(schema) });
  const lines = {
    type: "array",
    items: {
      type: "object",
      required: ["partId", "qty"],
      properties: { partId: { type: "string" }, qty: { type: "number" } },
    },
  };
  const payments = {
    type: "array",
    items: {
      type: "object",
      properties: {
        method: { type: "string", enum: ["cash", "bkash"] },
        amount: { type: "integer" },
      },
    },
  };
  const order = {
    type: "object",
    required: ["customerId", "lines"],
    properties: { customerId: { type: "string" }, lines, ...(features.paymentMethods ? { payments } : {}) },
  };
  const hints: Record<string, unknown> = {};
  if (features.dryRun) hints.dry_run = "?preview=1";
  if (features.idempotency) hints.idempotency_header = "X-Request-Key";
  if (features.banglaErrors) hints.bangla_errors = "error.text_bn";
  if (features.actingUser) hints.acting_user_header = "X-Done-By";
  if (features.reports) {
    hints.reports = ["profit_loss", "cash_book"];
    hints.report_path = "GET /reports/{name}";
  }
  if (features.syncStatus) hints.sync_status = "GET /sync/status";
  return {
    openapi: "3.0.3",
    info: { title: "Stub shop", version: "1" },
    paths: {
      "/orders": {
        post: {
          operationId: "createOrder",
          summary: "Sell parts to a customer",
          requestBody: { required: true, content: json(order) },
          responses: { "201": ok(), ...(features.dryRun ? { "200": ok() } : {}) },
          ...(features.dryRun ? { "x-supports-dry-run": true } : {}),
          ...(features.undo
            ? {
                "x-compensating-operation": {
                  operation: "cancelOrder",
                  id_from: "order.id",
                  body: { reason: "{undo_reason}" },
                },
              }
            : {}),
          "x-read-back": { operation: "getOrder", id_from: "order.id" },
        },
      },
      "/orders/{id}": {
        get: {
          operationId: "getOrder",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": ok() },
        },
      },
      ...(features.undo
        ? {
            "/orders/{id}/cancel": {
              post: {
                operationId: "cancelOrder",
                parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
                requestBody: {
                  content: json({ type: "object", properties: { reason: { type: "string" } } }),
                },
                responses: { "200": ok() },
              },
            },
          }
        : {}),
      ...(features.reports
        ? {
            "/reports/{name}": {
              get: {
                operationId: "getReport",
                parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
                responses: { "200": ok() },
              },
            },
          }
        : {}),
      ...(features.syncStatus
        ? { "/sync/status": { get: { operationId: "getSyncStatus", responses: { "200": ok() } } } }
        : {}),
    },
    ...(Object.keys(hints).length ? { "x-host-features": hints } : {}),
  };
}

async function bodyOf(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

/** Starts the stub host on a free local port. */
export async function startStubHost(features: StubFeatures, state: StubState = {}) {
  const requests: StubRequest[] = [];
  // Session sign-in: each session's CSRF token and its signed-in user.
  const sessions = new Map<string, { token: string; user: string | null }>();
  let made = 0;
  const newSession = (user: string | null) => {
    made += 1;
    const id = `sess${made}`;
    sessions.set(id, { token: `csrf/${made}=`, user });
    return id;
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://stub");
    const headers = Object.fromEntries(
      Object.entries(request.headers).map(([key, value]) => [key, String(value)]),
    );
    const body = await bodyOf(request);
    const send = (status: number, answer: unknown, extra: Record<string, string | string[]> = {}) => {
      response.writeHead(status, { "content-type": "application/json", ...extra });
      response.end(JSON.stringify(answer));
    };
    if (url.pathname === "/docs/openapi.json") return send(200, documentOf(features));
    requests.push({
      method: request.method ?? "GET",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers,
      body,
    });
    if (features.session) {
      const cookies = Object.fromEntries(
        (headers.cookie ?? "")
          .split(";")
          .map((pair) => pair.trim().split("=") as [string, string])
          .filter(([name]) => name),
      );
      const cookiesFor = (id: string) => ({
        "set-cookie": [
          `stub_session=${id}; Path=/; HttpOnly; SameSite=Lax`,
          `XSRF-TOKEN=${encodeURIComponent(sessions.get(id)!.token)}; Path=/; SameSite=Lax`,
        ],
      });
      const id = cookies.stub_session;
      const session = id ? sessions.get(id) : undefined;
      if (url.pathname === "/csrf-cookie")
        return send(204, null, cookiesFor(session ? id! : newSession(null)));
      const tokenOk = session !== undefined && headers["x-xsrf-token"] === session.token;
      if (request.method === "POST" && url.pathname === "/login") {
        if (!tokenOk) return send(419, { message: "CSRF token mismatch." });
        const login = body as { email?: string; password?: string } | undefined;
        if (login?.email !== STUB_USER || login.password !== SECRET)
          return send(422, { message: "These credentials do not match our records." });
        sessions.delete(id!);
        const signed = cookiesFor(newSession(STUB_USER)); // a new session at sign-in, as Laravel regenerates it
        if (state.loginAnswer === "redirect") return send(302, null, { ...signed, location: "/dashboard" });
        return send(200, { two_factor: false }, signed);
      }
      if (!session?.user || state.refuseSessions) return send(401, { message: "Unauthenticated." });
      if (request.method !== "GET" && !tokenOk) return send(419, { message: "CSRF token mismatch." });
    } else if (headers[KEY_HEADER] !== SECRET) return send(401, { error: { message: "no key" } });
    const preview = features.dryRun && url.searchParams.get("preview") === "1";
    if (request.method === "POST" && url.pathname === "/orders") {
      if (state.refuse)
        return send(422, {
          error: { message: "Out of stock", ...(features.banglaErrors ? { text_bn: "স্টকে নেই" } : {}) },
        });
      if (!preview) state.onOrder?.(body);
      return send(preview ? 200 : 201, {
        order: { id: preview ? null : "ord-7", total: STUB_TOTAL },
        warnings: [],
      });
    }
    if (request.method === "GET" && url.pathname === "/orders/ord-7")
      return send(200, { order: { id: "ord-7" } });
    if (request.method === "POST" && url.pathname === "/orders/ord-7/cancel")
      return send(200, { order: { id: "ord-7", status: "cancelled" } });
    if (features.reports && url.pathname.startsWith("/reports/")) {
      if (state.brokenReports) return send(500, { error: { message: "report failed" } });
      return send(200, { report: url.pathname.split("/").at(-1), value_taka: STUB_PROFIT });
    }
    if (features.syncStatus && url.pathname === "/sync/status")
      return send(200, { last_synced_at: (state.lastSync ?? new Date()).toISOString() });
    return send(404, { error: { message: "not found" } });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const connection: ApiConnection = {
    id: `stub-${port}`,
    baseUrl: `http://127.0.0.1:${port}`,
    authType: features.session ? "session" : "api_key",
    authHeader: features.session ? null : KEY_HEADER,
    secret: SECRET,
    features: { openapi: "/docs/openapi.json" },
    ...(features.session
      ? {
          loginConfig: {
            login_path: "/login",
            csrf_path: "/csrf-cookie",
            user_field: "email",
            password_field: "password",
            user: STUB_USER,
          },
        }
      : {}),
  };
  return {
    connection,
    requests,
    state,
    /** The app forgets every session, as when they expire. */
    forgetSessions: () => sessions.clear(),
    /** Every session's CSRF token changes, so the one DokaanBondhu holds is stale. */
    staleTokens: () => {
      for (const session of sessions.values()) session.token = `${session.token}x`;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
