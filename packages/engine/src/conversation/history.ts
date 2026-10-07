import { splitSentences } from "@dokaanbondhu/core";
import type { ChatMessage } from "../providers";

// The past messages the LLM is given (spec 9.5, D125, D126): only as much memory as the request needs. A request that
// names its own part and car needs none; otherwise the last six, each answer cut to what it was about ("এক্সিও
// ২০১৪-এর সামনের ব্রেক প্যাড দুই রকম আছে…"): its first sentence, before the list a colon or semicolon starts, so the old
// prices and racks are not there to be repeated.

export const HISTORY_MESSAGES = 6;
export const ANSWER_CHARS = 150;

export interface PastMessage {
  role: "user" | "assistant";
  text: string;
}

/** An answer's first sentence up to its list, at most ANSWER_CHARS characters. */
export function brief(text: string): string {
  const first = splitSentences(text)[0] ?? text.trim();
  const list = first.search(/[:;]/);
  const head = list > 0 ? `${first.slice(0, list).trimEnd()}…` : first;
  return head.length > ANSWER_CHARS ? `${head.slice(0, ANSWER_CHARS - 1)}…` : head;
}

export function llmHistory(
  history: readonly PastMessage[],
  options: { selfContained: boolean },
): ChatMessage[] {
  if (options.selfContained) return [];
  return history.slice(-HISTORY_MESSAGES).map(
    (message) =>
      ({
        role: message.role,
        content: message.role === "assistant" ? brief(message.text) : message.text,
      }) as ChatMessage,
  );
}
