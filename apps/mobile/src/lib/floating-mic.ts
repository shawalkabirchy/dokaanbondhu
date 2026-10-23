import { AppRegistry } from "react-native";
import { create } from "zustand";
import type { BubbleCard, BubbleMode } from "../../modules/floating-mic";
import type { ActionResultEvent, AssistantMessage } from "./chat-store";

// The floating mic's rules (spec 15.9, D203), without the phone, so they are tested on their own: how the bubble
// looks, what its card says, and how long it keeps the speech worker awake. Also the JS task that keeps the app's
// timers running while the bubble is on: React Native holds timers while its screen is in the background, and
// push-to-talk needs them; the native side starts the task with the bubble and ends it with the bubble.

/** While the bubble is on, the speech worker is woken this often (Modal sleeps after 5 idle minutes, D164). */
export const KEEP_AWAKE_MS = 4 * 60_000;
/** ... but not once nobody has pressed the bubble for this long (D203). */
export const IDLE_MS = 30 * 60_000;
/** The card stays this long after its answer has been said. */
export const CARD_MS = 8_000;

const ends: (() => void)[] = [];

AppRegistry.registerHeadlessTask(
  "FloatingMicAwake",
  () => () =>
    new Promise<void>((resolve) => {
      ends.push(resolve);
    }),
);

/** Ends the JS task with the bubble (the native side ends it too). */
export function letJsSleep(): void {
  for (const end of ends.splice(0)) end();
}

/** Whether the bubble is up now, for the settings row. */
export const useFloatingMicStatus = create<{ running: boolean }>(() => ({ running: false }));

export interface BubbleInputs {
  recording: boolean;
  busy: boolean;
  playing: boolean;
  micAllowed: boolean;
  speechWaking: boolean;
}

/**
 * The bubble's mode, as the page's button and status line would show it: listening while held, working until the
 * answer's text is in, speaking while it plays, off while the server is offline (a hold that has started always
 * finishes, D111), and the speech worker waking (it still works then, D164).
 */
export function bubbleMode(state: BubbleInputs): BubbleMode {
  if (state.recording) return "listening";
  if (state.busy) return "working";
  if (state.playing) return "speaking";
  if (!state.micAllowed) return "off";
  if (state.speechWaking) return "waking";
  return "ready";
}

export interface CardContent extends BubbleCard {
  /** A write's card goes when its confirmation expires. */
  expiresAt?: string;
}

/**
 * The card for the newest reply (D203): a write waiting for yes or no shows its confirmation sentence with the two
 * buttons until it is decided or expires; otherwise the reply's text, or its error, once there is one.
 */
export function cardOf(
  reply: AssistantMessage | undefined,
  results: ReadonlyMap<string, ActionResultEvent>,
  words: { yes: string; no: string; error: (key: string) => string },
  now: number,
): CardContent | null {
  if (!reply) return null;
  const confirm = reply.confirm;
  if (confirm && !results.has(confirm.action_id) && Date.parse(confirm.expires_at) > now)
    return {
      text: confirm.text,
      actionId: confirm.action_id,
      yes: words.yes,
      no: words.no,
      expiresAt: confirm.expires_at,
    };
  const text = reply.texts.filter(Boolean).join(" ");
  if (text) return { text };
  if (reply.error) return { text: words.error(reply.error) };
  return null;
}

/** When the card should go, in ms from now: a write's at its expiry, an answer's once it has been said. */
export function cardLasts(
  card: CardContent,
  reply: AssistantMessage,
  playing: boolean,
  now: number,
): number | null {
  if (card.expiresAt) return Math.max(0, Date.parse(card.expiresAt) - now);
  return reply.done && !playing ? CARD_MS : null;
}

/** Whether the bubble still keeps the speech worker awake: until nobody has pressed it for 30 minutes (D203). */
export function keepsAwake(lastUsedAt: number, now: number): boolean {
  return now - lastUsedAt < IDLE_MS;
}
