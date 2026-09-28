import { errorBodySchema, type ErrorBody } from "@dokaanbondhu/contracts";
import { useDeviceSettings } from "./settings-store";
import { supabase } from "./supabase";

// The API client (spec 15.5): the bearer token, the server address from the settings, typed errors.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ErrorBody["error"] | null,
  ) {
    super(body?.code ?? `HTTP ${status}`);
    this.name = "ApiError";
  }
}

export function apiUrl(path: string): string {
  return `${useDeviceSettings.getState().serverUrl}/api/v1${path}`;
}

/** JSON content type and the signed-in user's bearer token. */
export async function apiHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
}

/** An error response as a typed error: the nested error body when there is one. */
export function apiError(status: number, json: unknown): ApiError {
  const parsed = errorBodySchema.safeParse(json);
  return new ApiError(status, parsed.success ? parsed.data.error : null);
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(apiUrl(path), {
    method: init.method ?? "GET",
    headers: await apiHeaders(),
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) throw apiError(response.status, json);
  return json as T;
}

/** The message of an error in the chosen language; anything unexpected is the general error. */
export function errorText(error: unknown, language: "bn" | "en", fallback: string): string {
  if (error instanceof ApiError && error.body)
    return language === "bn" ? error.body.message_bn : error.body.message_en;
  return fallback;
}
