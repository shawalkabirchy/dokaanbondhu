import { importOpenApi, OpenApiImportError } from "./openapi-import";

// Calls to a host's own API through its auth adapter (spec 11.12): api_key (the secret in a named header) and bearer
// now; session comes with the Laravel scanner in step 7. A call never follows a redirect, so the secret goes only to
// the address the owner gave; it stops after 10 s and reads at most 5 MB (D134).

type Json = Record<string, unknown>;

export const AUTH_ADAPTERS = ["api_key", "bearer"] as const;
export const HOST_TIMEOUT_MS = 10_000;
const MAX_BYTES = 5 * 1024 * 1024;
const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);

export interface ApiConnection {
  id: string;
  baseUrl: string;
  authType: string;
  authHeader: string | null;
  secret: string;
  features: Json;
}

export interface HostRequest {
  method: string;
  /** As the document writes it, with its path parameters filled in. */
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface HostResponse {
  status: number;
  headers: Headers;
  /** Parsed JSON when the host answers JSON, else the text. */
  body: unknown;
}

export class HostCallFailed extends Error {
  constructor(
    message: string,
    readonly reason: "timeout" | "network" | "redirect" | "too_large" | "auth",
  ) {
    super(message);
  }
}

/** Why a base URL cannot be used, or null: https, or http only on this machine (like ssl_mode disable, spec 7.2). */
export function baseUrlProblem(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "not a URL";
  }
  if (url.username || url.password) return "the address must not carry a user or password";
  if (url.search || url.hash) return "the address must not carry a query";
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:" && LOCAL.has(url.hostname)) return null;
  return "use https (http only for localhost)";
}

/** The base URL's path, then the operation's path: https://shop.example/app + /api/v1/sales. */
export function hostUrl(baseUrl: string, path: string, query: Record<string, string> = {}): URL {
  const base = new URL(baseUrl);
  const url = new URL(
    base.pathname.replace(/\/+$/, "") + (path.startsWith("/") ? path : `/${path}`),
    base.origin,
  );
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url;
}

/** The headers that carry the secret. */
export function authHeaders(connection: Pick<ApiConnection, "authType" | "authHeader" | "secret">) {
  if (connection.authType === "api_key") {
    if (!connection.authHeader) throw new HostCallFailed("the API key's header is not named", "auth");
    return { [connection.authHeader]: connection.secret };
  }
  if (connection.authType === "bearer") return { authorization: `Bearer ${connection.secret}` };
  throw new HostCallFailed(`the ${connection.authType} sign-in is not built yet (step 7)`, "auth");
}

async function readLimited(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES) throw new HostCallFailed("the answer is larger than 5 MB", "too_large");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new HostCallFailed("the answer is larger than 5 MB", "too_large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** One call to the host with the connection's secret. Statuses are answers, not errors; only the call itself fails. */
export async function callHost(
  connection: ApiConnection,
  request: HostRequest,
  options: { timeoutMs?: number; signIn?: boolean } = {},
): Promise<HostResponse> {
  const headers: Record<string, string> = { accept: "application/json", ...request.headers };
  if (options.signIn !== false) Object.assign(headers, authHeaders(connection));
  if (request.body !== undefined) headers["content-type"] = "application/json";
  let response: Response;
  try {
    response = await fetch(hostUrl(connection.baseUrl, request.path, request.query), {
      method: request.method,
      headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs ?? HOST_TIMEOUT_MS),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError")
      throw new HostCallFailed("the host did not answer in time", "timeout");
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
    throw new HostCallFailed(`the host cannot be reached${cause ? `: ${cause}` : ""}`, "network");
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new HostCallFailed("the host answered with a redirect, which is not followed", "redirect");
  }
  const text = await readLimited(response);
  let body: unknown = text;
  if ((response.headers.get("content-type") ?? "").includes("json") && text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, headers: response.headers, body };
}

/** The document's path from the feature list, else the usual one. */
export function openApiPath(features: Json): string {
  return typeof features.openapi === "string" && features.openapi.startsWith("/")
    ? features.openapi
    : "/api/openapi.json";
}

/** Fetches the host's OpenAPI document (with the secret, for a host that guards it). */
export async function fetchOpenApi(connection: ApiConnection): Promise<{ path: string; document: unknown }> {
  const path = openApiPath(connection.features);
  const signIn = connection.authType !== "api_key" || Boolean(connection.authHeader);
  const response = await callHost(connection, { method: "GET", path }, { signIn });
  if (response.status !== 200 || typeof response.body !== "object" || !response.body) {
    throw new OpenApiImportError(`GET ${path} answered ${response.status}, not an OpenAPI document`);
  }
  return { path, document: response.body };
}

/** The header an apiKey security scheme of the document names, if it names exactly one. */
export function apiKeyHeaderOf(document: unknown): string | null {
  const schemes = ((document as Json)?.components as Json | undefined)?.securitySchemes as
    Record<string, Json> | undefined;
  const headers = Object.values(schemes ?? {})
    .filter((scheme) => scheme.type === "apiKey" && scheme.in === "header" && typeof scheme.name === "string")
    .map((scheme) => scheme.name as string);
  return headers.length === 1 ? headers[0]! : null;
}

/**
 * A harmless call that needs the secret: a guarded read by one path ID, with an ID nothing has. The host answers it
 * 401 or 403 when it refuses the secret, and anything else (usually 404) when it accepts it.
 */
export function keyProbeOf(document: unknown): string | null {
  const root = document as Json;
  const guardedByDefault = Array.isArray(root.security) && root.security.length > 0;
  for (const [path, item] of Object.entries((root.paths as Record<string, Json>) ?? {})) {
    const operation = item.get as Json | undefined;
    if (!operation) continue;
    const guarded = Array.isArray(operation.security) ? operation.security.length > 0 : guardedByDefault;
    const parameters = [...((item.parameters as Json[]) ?? []), ...((operation.parameters as Json[]) ?? [])];
    const inPath = parameters.filter((parameter) => parameter.in === "path");
    const requiredElse = parameters.filter(
      (parameter) => parameter.in !== "path" && parameter.required === true,
    );
    const names = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
    if (!guarded || names.length !== 1 || inPath.length !== 1 || requiredElse.length) continue;
    const schema = (inPath[0]!.schema as Json | undefined) ?? {};
    const sample = schema.format === "uuid" ? "00000000-0000-4000-8000-000000000000" : "0";
    return path.replace(`{${names[0]}}`, sample);
  }
  return null;
}

export interface ApiConnectionCheck {
  ok: boolean;
  operations?: number;
  /** accepted, refused, or not_checked when the document has no harmless guarded read. */
  key?: "accepted" | "refused" | "not_checked";
  /** The header the document names for an API key, when the owner left it empty. */
  authHeader?: string;
  error?: string;
}

/** POST /setup/connections/{id}/test for an API connection: the document can be read, and the secret is accepted. */
export async function checkApiConnection(connection: ApiConnection): Promise<ApiConnectionCheck> {
  try {
    const { document, path } = await fetchOpenApi(connection);
    const operations = importOpenApi(document, path).capabilities.length;
    const authHeader =
      connection.authType === "api_key" && !connection.authHeader ? apiKeyHeaderOf(document) : null;
    const signed = { ...connection, authHeader: connection.authHeader ?? authHeader };
    if (connection.authType === "api_key" && !signed.authHeader) {
      return { ok: false, operations, error: "name the header the API key goes in" };
    }
    const probe = keyProbeOf(document);
    let key: ApiConnectionCheck["key"] = "not_checked";
    if (probe) {
      const answer = await callHost(signed, { method: "GET", path: probe });
      key = answer.status === 401 || answer.status === 403 ? "refused" : "accepted";
    }
    return {
      ok: key !== "refused",
      operations,
      key,
      ...(authHeader ? { authHeader } : {}),
      ...(key === "refused" ? { error: "the host refused the key" } : {}),
    };
  } catch (error) {
    if (error instanceof HostCallFailed || error instanceof OpenApiImportError) {
      return { ok: false, error: error.message.slice(0, 300) };
    }
    throw error;
  }
}
