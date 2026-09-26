// Which provider answers (spec 13.2): for a shop and a job, the enabled rows of that job, without external ones
// unless the owner allowed them. If the shop has its own rows for the job, only those count; otherwise the global
// rows do. The LLM uses them in priority order; a speech job uses its one active row.

export type ProviderJob = "llm" | "stt" | "tts";

export interface ProviderRow {
  id: string;
  shopId: string | null;
  job: string;
  provider: string;
  model: string | null;
  priority: number | null;
  active: boolean;
  external: boolean;
  enabled: boolean;
}

export function candidatesFor<T extends ProviderRow>(
  rows: T[],
  shopId: string,
  job: ProviderJob,
  externalAllowed: boolean,
): T[] {
  const usable = rows.filter((row) => row.job === job && row.enabled && (externalAllowed || !row.external));
  const own = usable.filter((row) => row.shopId === shopId);
  return own.length > 0 ? own : usable.filter((row) => row.shopId === null);
}

export interface ProvidersInUse<T> {
  llm: T[];
  stt: T | null;
  tts: T | null;
}

export function selectProviders<T extends ProviderRow>(
  rows: T[],
  shopId: string,
  externalAllowed: boolean,
): ProvidersInUse<T> {
  const byPriority = (a: T, b: T) =>
    (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER) ||
    a.id.localeCompare(b.id);
  const activeOf = (job: ProviderJob) =>
    candidatesFor(rows, shopId, job, externalAllowed).find((row) => row.active) ?? null;
  return {
    llm: candidatesFor(rows, shopId, "llm", externalAllowed).sort(byPriority),
    stt: activeOf("stt"),
    tts: activeOf("tts"),
  };
}
