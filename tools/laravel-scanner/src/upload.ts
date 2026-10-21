import type { ScannerSummary } from "@dokaanbondhu/contracts";

// The upload (spec 16.3): the summary only, to /setup/scanner-upload with the owner's one-time setup token.

const UPLOAD_MS = 120_000;
/** Plain http only to this computer (or, from a container, the computer it runs on). */
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\]|host\.docker\.internal)$/;

/** The upload's address from the server's: https://x.example → https://x.example/api/v1/setup/scanner-upload. */
export function uploadUrl(server: string): string {
  const url = new URL(server);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL.test(url.hostname)))
    throw new Error("the server address must start with https://");
  const base = url.href.replace(/\/+$/, "");
  return /\/api\/v1$/.test(base) ? `${base}/setup/scanner-upload` : `${base}/api/v1/setup/scanner-upload`;
}

export interface UploadResult {
  connection_id?: string;
  added?: string[];
  changed?: string[];
  kept?: string[];
  removed?: string[];
}

export async function upload(
  server: string,
  token: string,
  summary: ScannerSummary,
  fetchImpl: typeof fetch = fetch,
): Promise<UploadResult> {
  const response = await fetchImpl(uploadUrl(server), {
    method: "POST",
    headers: { "content-type": "application/json", "x-setup-token": token },
    body: JSON.stringify(summary),
    signal: AbortSignal.timeout(UPLOAD_MS),
  });
  const body = (await response.json().catch(() => null)) as
    (UploadResult & { error?: { code?: string; message_en?: string } }) | null;
  if (!response.ok) {
    const reason = body?.error
      ? `${body.error.code}: ${body.error.message_en ?? ""}`
      : `HTTP ${response.status}`;
    throw new Error(`the upload was refused (${reason.trim()})`);
  }
  return body ?? {};
}
