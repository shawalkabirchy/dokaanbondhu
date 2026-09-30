// Which provider answers (spec 13.2, D98): the developer chooses a side for each job in the server's environment,
// our own models or the paid APIs. For a shop, a job and a side the candidates are the enabled rows of that side:
// the shop's own rows if it has any there, otherwise the global ones. The LLM chain is the chosen side's candidates
// in priority order, then the other side's, so the other side is always the backup; a speech job uses one row of
// the chosen side, the other side's only when the chosen side has none. Speaking can also be switched off (D114):
// answers are then text only and no text-to-speech provider is used.

export type ProviderJob = "llm" | "stt" | "tts";

/** "own": our models (Gemma 4, the speech worker); "api": the paid services. */
export type Side = "own" | "api";

/** AI_SPEAK: a side, or "off" for no reading aloud at all (D114). */
export type SpeakSide = Side | "off";

/** The developer's switches: AI_CHAT, AI_LISTEN and AI_SPEAK. */
export interface Sides {
  chat: Side;
  listen: Side;
  speak: SpeakSide;
}

export const OWN_SIDE: Sides = { chat: "own", listen: "own", speak: "own" };

const OWN_PROVIDERS = new Set(["vllm", "cloudflare", "speech_worker"]);

/** vllm, cloudflare and speech_worker are our models; deepseek, openai, openrouter and elevenlabs are paid APIs. */
export const sideOf = (provider: string): Side => (OWN_PROVIDERS.has(provider) ? "own" : "api");

/**
 * Reads AI_CHAT, AI_LISTEN and AI_SPEAK: unset or empty means own; any other value than own or api is refused, except
 * AI_SPEAK=off (D114).
 */
export function sidesFrom(env: Record<string, string | undefined>): Sides {
  const read = (name: string): Side => {
    const value = env[name]?.trim() || "own";
    if (value !== "own" && value !== "api") throw new Error(`${name} must be own or api, not "${value}"`);
    return value;
  };
  const speak = env.AI_SPEAK?.trim() === "off" ? "off" : read("AI_SPEAK");
  return { chat: read("AI_CHAT"), listen: read("AI_LISTEN"), speak };
}

const other = (side: Side): Side => (side === "own" ? "api" : "own");

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
  side: Side,
): T[] {
  const usable = rows.filter((row) => row.job === job && row.enabled && sideOf(row.provider) === side);
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
  sides: Sides,
): ProvidersInUse<T> {
  const byPriority = (a: T, b: T) =>
    (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER) ||
    a.id.localeCompare(b.id);
  const chain = (side: Side) => candidatesFor(rows, shopId, "llm", side).sort(byPriority);
  const speech = (job: ProviderJob, side: Side): T | null => {
    const pick = (on: Side) => {
      const candidates = candidatesFor(rows, shopId, job, on).sort(byPriority);
      return candidates.find((row) => row.active) ?? candidates[0] ?? null;
    };
    return pick(side) ?? pick(other(side));
  };
  return {
    llm: [...chain(sides.chat), ...chain(other(sides.chat))],
    stt: speech("stt", sides.listen),
    tts: sides.speak === "off" ? null : speech("tts", sides.speak),
  };
}
