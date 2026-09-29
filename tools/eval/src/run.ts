import { CANNOT_ANSWER_NOW } from "@dokaanbondhu/core";
import type { Item, WriteExpected } from "./items";
import type { ItemResult, TurnRecord } from "./score";
import type { Session } from "./session";

// The runner (spec 18.4): each item in its own conversation, as the user it names; questions answered from its
// script, and a question without a scripted answer gets "I don't know" (counted as unnecessary). At Cloudflare's daily
// limit the run stops and keeps its state, so --resume continues the next day with the interrupted item (D68).

export const DONT_KNOW = "জানি না";
const MAX_TURNS = 5;

export interface RunState {
  runId: string;
  startedAt: string;
  /** The providers in use when the run started (D98). */
  providers?: { chat: string[]; stt: string | null; tts: string | null };
  itemIds: string[];
  builtActions: string[];
  nextIndex: number;
  results: ItemResult[];
  stopped?: { at: string; reason: string };
}

export class DailyLimitReached extends Error {}

/** A turn that failed because the LLM's daily allowance is used up. */
function dailyLimit(turn: TurnRecord): boolean {
  return (
    turn.reply === CANNOT_ANSWER_NOW && (turn.trace?.fallbacks ?? []).some((f) => f.includes("daily-limit"))
  );
}

function tooMany(turn: TurnRecord): boolean {
  return (
    turn.reply === CANNOT_ANSWER_NOW && (turn.trace?.fallbacks ?? []).some((f) => f.includes("http 429"))
  );
}

/** A voice item's recording as 16 kHz mono PCM, or null when it has not been recorded yet. */
export type LoadClip = (item: Item) => Promise<Uint8Array | null>;

/**
 * One item in its own conversation. A voice item's first turn is its recording, sent in real time as the app does;
 * the answers to the questions it should need are sent as text in both halves, so the voice score measures the first
 * utterance (architecture 11.2).
 */
export async function runChatItem(
  item: Item,
  session: Session,
  clip: Uint8Array | null = null,
): Promise<ItemResult> {
  const conversation = await session.newConversation(clip ? "voice" : "chat");
  const turns: TurnRecord[] = [];
  let unscripted = 0;
  let text = item.text ?? "";
  for (let n = 0; n < MAX_TURNS; n++) {
    const turn =
      n === 0 && clip
        ? await session.voice(conversation, clip, { realTime: true })
        : await session.chat(conversation, text);
    if (dailyLimit(turn)) throw new DailyLimitReached(item.id);
    turns.push(turn);
    if (turn.state !== "CLARIFYING") break;
    const answer = turn.slot ? item.script[turn.slot] : undefined;
    if (answer === undefined) {
      unscripted++;
      text = DONT_KNOW;
    } else {
      text = String(answer);
    }
  }
  return { id: item.id, status: "done", turns, unscripted };
}

/** Why an item is not run now, or null to run it. */
export function notRunReason(item: Item, builtActions: string[]): ItemResult | null {
  if (item.kind === "write") {
    const action = (item.expected as WriteExpected).action;
    if (!builtActions.includes(action)) {
      return {
        id: item.id,
        status: "not_built",
        reason: `action ${action} is not built`,
        turns: [],
        unscripted: 0,
      };
    }
  }
  return null;
}

export async function runItems(
  items: Item[],
  state: RunState,
  sessions: Record<"owner" | "staff", Session>,
  save: (state: RunState) => void,
  log: (line: string) => void,
  loadClip: LoadClip = async () => null,
): Promise<RunState> {
  delete state.stopped;
  let rateLimited = 0;
  for (let index = state.nextIndex; index < items.length; index++) {
    const item = items[index]!;
    let result = notRunReason(item, state.builtActions);
    const clip = !result && item.channel === "voice" ? await loadClip(item) : null;
    if (!result && item.channel === "voice" && !clip) {
      result = { id: item.id, status: "skipped", reason: "not recorded yet", turns: [], unscripted: 0 };
    }
    if (!result) {
      try {
        result = await runChatItem(item, sessions[item.as], clip);
      } catch (error) {
        if (error instanceof DailyLimitReached) {
          state.nextIndex = index;
          state.stopped = { at: new Date().toISOString(), reason: "the LLM's daily allowance is used up" };
          save(state);
          return state;
        }
        result = {
          id: item.id,
          status: "error",
          reason: error instanceof Error ? error.message : String(error),
          turns: [],
          unscripted: 0,
        };
      }
      // Three items in a row refused with 429: stop as at the daily limit, rather than score a whole day of refusals.
      rateLimited = result.turns.some(tooMany) ? rateLimited + 1 : 0;
      if (rateLimited >= 3) {
        state.results.push(result);
        state.nextIndex = index + 1;
        state.stopped = { at: new Date().toISOString(), reason: "three items in a row refused with 429" };
        save(state);
        return state;
      }
    }
    state.results.push(result);
    state.nextIndex = index + 1;
    save(state);
    const last = result.turns.at(-1);
    log(
      `${item.id} ${result.status}${last ? `  ${last.reply.slice(0, 70)}` : result.reason ? `  (${result.reason})` : ""}`,
    );
  }
  return state;
}
