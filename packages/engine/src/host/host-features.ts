import { banglaDigits } from "@dokaanbondhu/core";
import { findField, numberOf } from "../write/request";
import type { WriteHost } from "../write/types";
import { REPORT_NAMES, type ReportName } from "./reports";

// An app's own report endpoints and sync status, used when its feature list names them (architecture, host
// features; D180, D181). Both go through the API connection's auth adapter; an app without them keeps the fallbacks.

type Json = Record<string, unknown>;

/** "GET /api/v1/reports/{name}" as a method and a path; null when the entry is not one. */
function endpointOf(entry: unknown): { method: string; path: string } | null {
  if (typeof entry !== "string") return null;
  const match = /^(GET|POST)\s+(\/\S*)$/i.exec(entry.trim());
  return match ? { method: match[1]!.toUpperCase(), path: match[2]! } : null;
}

/** The reports the app answers itself: its feature list's names, else all three when it has a report path. */
export function reportNamesOf(features: Json | undefined): ReportName[] {
  if (!features || !endpointOf(features.report_path)) return [];
  const listed = Array.isArray(features.reports) ? features.reports.map(String) : null;
  return REPORT_NAMES.filter((name) => !listed || listed.includes(name));
}

/**
 * The app's own figure for a report, in whole taka: its answer's number named taka, value, total or amount, or ending
 * in _taka. A call that fails or brings no figure throws, so the report falls back (D181).
 */
export async function hostReport(
  host: WriteHost,
  name: ReportName,
  from: string | null,
  to: string | null,
): Promise<bigint> {
  const endpoint = endpointOf(host.features.report_path);
  if (!endpoint) throw new Error("the app names no report path");
  const response = await host.call({
    method: endpoint.method,
    path: endpoint.path.replace(/\{[^}]+\}/, encodeURIComponent(name)),
    query: { ...(from ? { from } : {}), ...(to ? { to } : {}) },
  });
  if (response.status >= 300) throw new Error(`the app's report answered ${response.status}`);
  const figure = numberOf(
    findField(response.body, (key) => /^(taka|value|total|amount|figure)$|_taka$/.test(key)),
  );
  if (figure === null) throw new Error("the app's report has no figure");
  return BigInt(Math.round(figure));
}

const SYNC_READ_MS = 60_000;
/** A sync older than this is said with the answer (D181). */
export const STALE_SYNC_MS = 30 * 60_000;
const lastRead = new WeakMap<WriteHost, { at: number; synced: Date | null }>();

/** When the app's phones last synced, at most one call a minute per connection; null when it cannot tell. */
async function lastSync(host: WriteHost, now: Date): Promise<Date | null> {
  const endpoint = endpointOf(host.features.sync_status);
  if (!endpoint) return null;
  const seen = lastRead.get(host);
  if (seen && now.getTime() - seen.at < SYNC_READ_MS) return seen.synced;
  let synced: Date | null;
  try {
    const response = await host.call({ method: endpoint.method, path: endpoint.path }, { timeoutMs: 3_000 });
    const value = findField(response.body, (key) => /^(last_?sync(ed)?(_at|_time)?|synced_at)$/.test(key));
    const time = typeof value === "string" || typeof value === "number" ? new Date(value) : null;
    synced = response.status < 300 && time && !Number.isNaN(time.getTime()) ? time : null;
  } catch {
    synced = null; // a sync status that does not answer says nothing
  }
  lastRead.set(host, { at: now.getTime(), synced });
  return synced;
}

/** How long ago, in Bangla: ৪০ মিনিট, ২ ঘণ্টা, ৩ দিন. */
function agoText(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${banglaDigits(String(minutes))} মিনিট`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${banglaDigits(String(hours))} ঘণ্টা`;
  return `${banglaDigits(String(Math.floor(hours / 24)))} দিন`;
}

/** The sentence a read answer ends with when the app's phones last synced long ago, else null (D181). */
export async function syncNote(host: WriteHost, now: Date): Promise<string | null> {
  const synced = await lastSync(host, now);
  if (!synced) return null;
  const age = now.getTime() - synced.getTime();
  return age > STALE_SYNC_MS ? `অ্যাপের হিসাব শেষ মেলানো হয়েছে ${agoText(age)} আগে।` : null;
}
