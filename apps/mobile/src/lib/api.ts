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

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const response = await fetch(`${useDeviceSettings.getState().serverUrl}/api/v1${path}`, {
    method: init.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = errorBodySchema.safeParse(json);
    throw new ApiError(response.status, parsed.success ? parsed.data.error : null);
  }
  return json as T;
}
