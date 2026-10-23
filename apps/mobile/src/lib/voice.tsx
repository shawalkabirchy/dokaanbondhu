import type { ReplyEvent } from "@dokaanbondhu/contracts";
import { ASK_AGAIN } from "@dokaanbondhu/core";
import * as Crypto from "expo-crypto";
import { createContext, useContext, useEffect, useRef, type ReactNode, type RefObject } from "react";
import { phonePlayer, playAskAgain, removeOldRecordings, stopPlayback } from "./audio";
import { useChat } from "./chat";
import { useHealth } from "./health";
import { ReplyPlayer } from "./reply-player";
import { useMe } from "./session";
import { usePushToTalk } from "./use-push-to-talk";

// The app's one voice (spec 15.3, 15.9): the recorder, the spoken reply and how the last question was asked, shared by
// the assistant page's round button and the floating mic, so both speak into the same conversation and never record
// or play at the same time. It sits in the signed-in layout, so it lives while the app runs, also with the app in the
// background behind the floating mic.

export interface Voice {
  talk: ReturnType<typeof usePushToTalk>;
  /** A new reply's audio player; the previous one stops. */
  playerTap: () => (event: ReplyEvent) => void;
  /** Stops the answer being spoken (the stop button, a new press, a new conversation). */
  stopReply: () => void;
  /** How the last question was asked: a choice or Yes and No is answered aloud after a spoken one. */
  lastAsked: RefObject<"voice" | "typed">;
}

const VoiceContext = createContext<Voice | null>(null);

export function VoiceProvider({ children }: { children: ReactNode }) {
  const { busy, runTurn, ensureConversation, note } = useChat();
  const { speechTrouble, refresh } = useHealth();
  /** False when the developer has switched reading aloud off (AI_SPEAK=off, D114). */
  const speaks = useMe().data?.providers.speaks ?? true;
  const player = useRef<ReplyPlayer | null>(null);
  const lastAsked = useRef<"voice" | "typed">("voice");

  function playerTap(): (event: ReplyEvent) => void {
    player.current?.stop();
    const current = new ReplyPlayer(phonePlayer, Crypto.randomUUID());
    player.current = current;
    return (event) => {
      if (event.type === "audio") current.add(event.seq, event.data);
      if (event.type === "done") current.end();
    };
  }

  function stopReply() {
    player.current?.stop();
    stopPlayback();
  }

  /** A clip too quiet to send: "আবার বলবেন?" as text, and as the bundled sound unless speaking is off (D114). */
  function askAgain() {
    note(ASK_AGAIN);
    if (speaks) playAskAgain();
  }

  const talk = usePushToTalk({
    busy,
    ensureConversation,
    runTurn,
    askAgain,
    replyTap: playerTap,
    stopReply,
    afterTurn: () => {
      if (speechTrouble) void refresh(); // a turn that worked clears the warning at once
    },
  });

  useEffect(() => {
    // Left over from before D204; a moment after the start, so the first screen is not held up.
    const tidy = setTimeout(removeOldRecordings, 3000);
    return () => {
      clearTimeout(tidy);
      player.current?.stop();
    };
  }, []);

  return (
    <VoiceContext.Provider value={{ talk, playerTap, stopReply, lastAsked }}>
      {children}
    </VoiceContext.Provider>
  );
}

export function useVoice(): Voice {
  const voice = useContext(VoiceContext);
  if (!voice) throw new Error("useVoice needs the VoiceProvider of the signed-in layout");
  return voice;
}
