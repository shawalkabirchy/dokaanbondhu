import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  apiKeyHeaderOf,
  authHeaders,
  baseUrlProblem,
  callHost,
  checkApiConnection,
  HostCallFailed,
  hostUrl,
  keyProbeOf,
  type ApiConnection,
} from "./api";

// The auth adapters and host calls (spec 11.12, D134) against a small local host: the secret goes in the named header
// or as a bearer token, never to a redirect's target; slow and oversized answers stop; and the connection test reads
// the document and checks the secret with a harmless guarded read, on a document shaped unlike the test host's.

const SECRET = "s3cret-value";
const seen: { path: string; headers: IncomingMessage["headers"] }[] = [];

/** An OpenAPI 3.0 host with camelCase names, bearer tokens, and one guarded read by ID. */
const document = {
  openapi: "3.0.3",
  security: [{ token: [] }],
  components: { securitySchemes: { token: { type: "http", scheme: "bearer" } } },
  paths: {
    "/v2/orders": {
      post: {
        operationId: "createOrder",
        requestBody: {
          content: {
            "application/json": {
              schema: { type: "object", properties: { customerId: { type: "integer" } } },
            },
          },
        },
        responses: { "201": { description: "ok" } },
      },
    },
    "/v2/orders/{orderId}": {
      get: {
        operationId: "getOrder",
        parameters: [{ name: "orderId", in: "path", required: true, schema: { type: "integer" } }],
        responses: { "200": { description: "ok" } },
      },
    },
  },
};

function handler(request: IncomingMessage, response: ServerResponse) {
  const path = request.url ?? "/";
  seen.push({ path, headers: request.headers });
  const json = (status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  if (path === "/shop/openapi.json") return json(200, document);
  if (path === "/shop/v2/orders/0") {
    return request.headers.authorization === `Bearer ${SECRET}`
      ? json(404, { error: "no order" })
      : json(401, {});
  }
  if (path === "/shop/echo") return json(200, { ok: true });
  if (path === "/shop/moved") {
    response.writeHead(302, { location: "http://127.0.0.1:1/elsewhere" });
    return response.end();
  }
  if (path === "/shop/slow") return; // never answers
  if (path === "/shop/huge") {
    response.writeHead(200, { "content-type": "application/json" });
    const block = "x".repeat(1024 * 1024);
    for (let i = 0; i < 6; i++) response.write(block);
    return response.end();
  }
  json(404, {});
}

let server: Server;
let base = "";
const connection = (overrides: Partial<ApiConnection> = {}): ApiConnection => ({
  id: "c",
  baseUrl: `${base}/shop`,
  authType: "bearer",
  authHeader: null,
  secret: SECRET,
  features: { openapi: "/openapi.json" },
  ...overrides,
});

beforeAll(async () => {
  server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

describe("host addresses and auth adapters", () => {
  it("takes https anywhere and http only on this machine, without a user or a query", () => {
    expect(baseUrlProblem("https://shop.example.com/app")).toBeNull();
    expect(baseUrlProblem("http://localhost:4000")).toBeNull();
    expect(baseUrlProblem("http://127.0.0.1:4000")).toBeNull();
    expect(baseUrlProblem("http://shop.example.com")).toMatch(/https/);
    expect(baseUrlProblem("https://user:pw@shop.example.com")).toMatch(/user/);
    expect(baseUrlProblem("https://shop.example.com/?a=1")).toMatch(/query/);
    expect(baseUrlProblem("not a url")).toBe("not a URL");
  });

  it("adds the operation's path to the base URL's path", () => {
    expect(hostUrl("https://shop.example.com/app/", "/api/v1/sales", { dry_run: "true" }).toString()).toBe(
      "https://shop.example.com/app/api/v1/sales?dry_run=true",
    );
    expect(hostUrl("http://localhost:4000", "/api/v1/health").toString()).toBe(
      "http://localhost:4000/api/v1/health",
    );
  });

  it("puts an API key in its named header and a token in Authorization; session waits for step 7", () => {
    expect(authHeaders({ authType: "api_key", authHeader: "X-Api-Key", secret: "k" })).toEqual({
      "X-Api-Key": "k",
    });
    expect(authHeaders({ authType: "bearer", authHeader: null, secret: "t" })).toEqual({
      authorization: "Bearer t",
    });
    expect(() => authHeaders({ authType: "api_key", authHeader: null, secret: "k" })).toThrow(HostCallFailed);
    expect(() => authHeaders({ authType: "session", authHeader: null, secret: "x" })).toThrow(/step 7/);
  });
});

describe("calls to the host", () => {
  it("sends the secret and reads JSON", async () => {
    const answer = await callHost(connection({ authType: "api_key", authHeader: "X-Shop-Key" }), {
      method: "GET",
      path: "/echo",
    });
    expect(answer).toMatchObject({ status: 200, body: { ok: true } });
    expect(seen.at(-1)!.headers["x-shop-key"]).toBe(SECRET);
  });

  it("never follows a redirect, so the secret stays with the host", async () => {
    await expect(callHost(connection(), { method: "GET", path: "/moved" })).rejects.toMatchObject({
      reason: "redirect",
    });
  });

  it("stops a host that does not answer, and an answer over 5 MB", async () => {
    await expect(
      callHost(connection(), { method: "GET", path: "/slow" }, { timeoutMs: 300 }),
    ).rejects.toMatchObject({ reason: "timeout" });
    await expect(callHost(connection(), { method: "GET", path: "/huge" })).rejects.toMatchObject({
      reason: "too_large",
    });
  });

  it("says a host that cannot be reached", async () => {
    await expect(
      callHost(connection({ baseUrl: "http://127.0.0.1:1" }), { method: "GET", path: "/x" }),
    ).rejects.toMatchObject({ reason: "network" });
  });
});

describe("the API connection test", () => {
  it("finds the guarded read by one ID and the API key's header in a document", () => {
    expect(keyProbeOf(document)).toBe("/v2/orders/0");
    expect(apiKeyHeaderOf(document)).toBeNull();
    const keyed = {
      components: { securitySchemes: { k: { type: "apiKey", in: "header", name: "X-Api-Key" } } },
    };
    expect(apiKeyHeaderOf(keyed)).toBe("X-Api-Key");
  });

  it("reads the document and sees the token accepted, or refused", async () => {
    expect(await checkApiConnection(connection())).toEqual({ ok: true, operations: 2, key: "accepted" });
    expect(await checkApiConnection(connection({ secret: "wrong" }))).toMatchObject({
      ok: false,
      key: "refused",
      error: "the host refused the key",
    });
  });

  it("reports a document that is not there, without throwing", async () => {
    const result = await checkApiConnection(connection({ features: { openapi: "/missing.json" } }));
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/404/) });
  });
});
