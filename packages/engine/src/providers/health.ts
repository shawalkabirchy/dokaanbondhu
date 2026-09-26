import type { ProviderJob } from "./select";

// Speech and LLM readiness for /health (spec 8.8, D55): the result of the job's last real call in the past 5
// minutes, else "unknown". Kept on globalThis, so every route bundle and hot reload of the server shares it.

const WINDOW_MS = 5 * 60_000;
type Health = "ok" | "down" | "unknown";

const holder = globalThis as { __dokaanProviderHealth?: Map<ProviderJob, { ok: boolean; at: number }> };
const store = (holder.__dokaanProviderHealth ??= new Map());

export function recordProviderCall(job: ProviderJob, ok: boolean, now = Date.now()): void {
  store.set(job, { ok, at: now });
}

/** "ok" or "down" from a real call in the last 5 minutes; "unknown" otherwise, so /health never wakes a GPU. */
export function recentHealth(job: ProviderJob, now = Date.now()): Health {
  const last = store.get(job);
  if (!last || now - last.at > WINDOW_MS) return "unknown";
  return last.ok ? "ok" : "down";
}

/** Speech readiness: stt and tts together; "down" if either failed recently. */
export function speechHealth(now = Date.now()): Health {
  const results = [recentHealth("stt", now), recentHealth("tts", now)];
  if (results.includes("down")) return "down";
  return results.includes("ok") ? "ok" : "unknown";
}
