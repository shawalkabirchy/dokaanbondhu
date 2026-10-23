import { AudioStudioModule } from "@siteed/audio-studio";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AppState } from "react-native";
import { FloatingMic } from "../modules/floating-mic";
import { usePlayback } from "./lib/audio";
import { useChat } from "./lib/chat";
import type { ActionResultEvent } from "./lib/chat-store";
import {
  bubbleMode,
  cardLasts,
  cardOf,
  KEEP_AWAKE_MS,
  keepsAwake,
  letJsSleep,
  useFloatingMicStatus,
} from "./lib/floating-mic";
import { buzz } from "./lib/haptics";
import { useHealth, wakeSpeech } from "./lib/health";
import { useDeviceSettings } from "./lib/settings-store";
import { useVoice } from "./lib/voice";

// The floating mic in the app (spec 15.9, D196, D203): it brings the bubble up whenever the switch in Settings is on
// and the phone allows it, which Android permits only while the app is in front, so also each time the app is
// opened; the bubble's presses drive the app's one voice (src/lib/voice), so a question asked over another app lands
// in the same conversation as the page's; and the bubble is told how to look: the page's button and status line as a
// colour, and the newest reply's text, or a write's yes and no, on its card. While it is on it keeps the speech worker
// awake, until nobody has pressed it for 30 minutes (D203). Signing out takes it down. Renders nothing.

export function FloatingMicBridge() {
  const { t } = useTranslation();
  const wanted = useDeviceSettings((state) => state.floatingMic);
  const setFloatingMic = useDeviceSettings((state) => state.setFloatingMic);
  const running = useFloatingMicStatus((state) => state.running);
  const { talk, playerTap, lastAsked } = useVoice();
  const { messages, busy, decide } = useChat();
  const { micAllowed, speechWaking, refresh } = useHealth();
  const playing = usePlayback((state) => state.playing);
  /** When the bubble was last pressed (or brought up). */
  const lastUsed = useRef(Date.now());

  // The bubble's listeners are added once; they always reach the newest of these.
  const latest = useRef({ talk, playerTap, decide, refresh, t });
  latest.current = { talk, playerTap, decide, refresh, t };

  useEffect(() => {
    const mic = FloatingMic;
    if (!mic) return;
    if (!wanted) {
      letJsSleep();
      void mic.stop();
      useFloatingMicStatus.setState({ running: false });
      return;
    }
    const bringUp = async () => {
      // A microphone service may start only while the app is in front (Android 14); asked again on each return.
      if (AppState.currentState !== "active" || !mic.canDrawOverlays()) return;
      if (!(await AudioStudioModule.getPermissionsAsync())?.granted) return;
      const words = latest.current.t;
      try {
        // Again on each return too: it is the same bubble, and a reloaded app is listened to once more.
        await mic.start({
          name: words("floating.title"),
          title: words("floating.notification_title"),
          text: words("floating.notification_text"),
          stop: words("floating.stop"),
          hold: words("voice.hold"),
        });
        if (!useFloatingMicStatus.getState().running) lastUsed.current = Date.now();
        useFloatingMicStatus.setState({ running: true });
      } catch {
        useFloatingMicStatus.setState({ running: false });
      }
    };
    void bringUp();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void bringUp();
    });
    return () => subscription.remove();
  }, [wanted]);

  // Signing out takes the bubble down; the switch stays as it was for the next sign-in.
  useEffect(
    () => () => {
      letJsSleep();
      void FloatingMic?.stop();
      useFloatingMicStatus.setState({ running: false });
    },
    [],
  );

  useEffect(() => {
    const mic = FloatingMic;
    if (!mic) return;
    const subscriptions = [
      mic.addListener("onPressIn", () => {
        const now = Date.now();
        // Asleep by now (30 quiet minutes): it starts waking while the question is said.
        if (!keepsAwake(lastUsed.current, now)) void wakeSpeech(latest.current.refresh);
        lastUsed.current = now;
        lastAsked.current = "voice";
        void latest.current.talk.onPressIn();
      }),
      mic.addListener("onPressOut", () => void latest.current.talk.onPressOut()),
      mic.addListener("onCancel", () => void latest.current.talk.onCancel()),
      mic.addListener("onDecide", ({ actionId, decision }) => {
        lastUsed.current = Date.now();
        lastAsked.current = "voice";
        if (decision === "yes") buzz("success");
        const { decide: say, playerTap: tap, t: words } = latest.current;
        void say(actionId, decision, words(`confirm.${decision}`), { speak: true, tap: tap() });
      }),
      mic.addListener("onClosed", ({ error }) => {
        letJsSleep();
        useFloatingMicStatus.setState({ running: false });
        // The × or the notification's Stop turns the switch off; a bubble that could not start is tried again.
        if (!error) setFloatingMic(false);
      }),
    ];
    return () => subscriptions.forEach((subscription) => subscription.remove());
  }, [lastAsked, setFloatingMic]);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      if (keepsAwake(lastUsed.current, Date.now())) void wakeSpeech(latest.current.refresh);
    }, KEEP_AWAKE_MS);
    return () => clearInterval(timer);
  }, [running]);

  // The card: the newest reply's, until it has been said and a few seconds more, or a write's until it expires.
  const reply = [...messages].reverse().find((message) => message.kind === "assistant");
  const results = new Map<string, ActionResultEvent>();
  for (const message of messages)
    if (message.kind === "assistant" && message.result) results.set(message.result.action_id, message.result);
  const content = cardOf(
    reply,
    results,
    { yes: t("confirm.yes"), no: t("confirm.no"), error: (key) => t(key) },
    Date.now(),
  );
  const cardKey = content && reply ? `${reply.id}:${content.actionId ?? ""}:${content.text}` : null;
  const [goneKey, setGoneKey] = useState<string | null>(null);
  const lasts = content && reply ? cardLasts(content, reply, playing, Date.now()) : null;
  const ending = lasts !== null;
  // Timed from when its end is known (said, or the write's expiry); a write's time left shrinks on every render.
  useEffect(() => {
    if (cardKey === null || lasts === null) return;
    const timer = setTimeout(() => setGoneKey(cardKey), lasts);
    return () => clearTimeout(timer);
  }, [cardKey, ending]);

  const mode = bubbleMode({ recording: talk.recording, busy, playing, micAllowed, speechWaking });
  // A new question puts the last answer's card away.
  const card =
    content && cardKey !== goneKey && mode !== "listening"
      ? { text: content.text, actionId: content.actionId, yes: content.yes, no: content.no }
      : null;
  const level = talk.recording ? talk.level : 0;
  // The card is a new object on every render: its text and action say whether it changed.
  useEffect(() => {
    if (running) void FloatingMic?.update({ mode, level, card }).catch(() => undefined);
  }, [running, mode, level, card?.text, card?.actionId]);

  return null;
}
