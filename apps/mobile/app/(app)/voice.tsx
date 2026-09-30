import type { ReplyEvent } from "@dokaanbondhu/contracts";
import { ASK_AGAIN } from "@dokaanbondhu/core";
import {
  AudioStudioModule,
  useAudioRecorder,
  type AudioDataEvent,
  type RecordingConfig,
} from "@siteed/audio-studio";
import * as Crypto from "expo-crypto";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { AssistantBubble, UserBubble } from "../../src/chat-ui";
import { phonePlayer, playAskAgain, stopPlayback } from "../../src/lib/audio";
import { useHealth } from "../../src/lib/health";
import { base64ToBytes } from "../../src/lib/pcm";
import { ReplyPlayer } from "../../src/lib/reply-player";
import { useMe } from "../../src/lib/session";
import { useDeviceSettings } from "../../src/lib/settings-store";
import { streamTurn, uploadChunk } from "../../src/lib/stream";
import { useVoice } from "../../src/lib/voice";
import { MAX_RECORDING_MS, MIN_PRESS_MS, VoiceTurn } from "../../src/lib/voice-turn";

/** How long release waits for the recorder's last chunk, and how much short of the held time counts as all of it. */
const LAST_CHUNK_WAIT_MS = 600;
const LAST_CHUNK_SLACK_MS = 250;
/**
 * The recorder keeps listening this long after the button is let go (D113): the sound of the last word is still on its
 * way through the microphone when the finger lifts. Not after a tap, and never past the 30 s limit.
 */
const TAIL_MS = 500;
import { Button, colors, OfflineBanner } from "../../src/ui";

// The voice page (spec 15.2, 15.3, 15.4): hold the button and speak; on release the clip is finished and the answer
// streams in: the transcript as the user's words, then the reply as text with its audio, played in order. The recorder
// is prepared before the press (on opening the page and after every stop), because unprepared it takes about 1.4 s
// to start and loses the first words (P5). Pressing again while an answer plays stops it (barge-in). After the release
// the recorder listens for half a second more, so the last word is not cut (D113).

export default function Voice() {
  const { t } = useTranslation();
  const language = useDeviceSettings((state) => state.language);
  const { micAllowed, speechTrouble, refresh } = useHealth();
  const { messages, busy, runTurn, ensureConversation, send, reset, note } = useVoice();
  /** False when the developer has switched reading aloud off (AI_SPEAK=off, D114). */
  const speaks = useMe().data?.providers.speaks ?? true;
  const { prepareRecording, startRecording, stopRecording } = useAudioRecorder();
  const [recording, setRecording] = useState(false);
  const turn = useRef<VoiceTurn | null>(null);
  /** The turn the recorder's chunks belong to: it stays until the recorder's last chunk is in (D103). */
  const capturing = useRef<VoiceTurn | null>(null);
  const recordingSince = useRef(0);
  const player = useRef<ReplyPlayer | null>(null);
  const limit = useRef<ReturnType<typeof setTimeout> | null>(null);
  const micReady = useRef(false);
  const list = useRef<ScrollView>(null);
  const newestReply = [...messages].reverse().find((message) => message.kind === "assistant");

  // The settings of spec 15.3; the same object prepares and starts the recorder.
  const config = useRef<RecordingConfig>({
    sampleRate: 16000,
    channels: 1,
    encoding: "pcm_16bit",
    interval: 500,
    onAudioStream: async (event: AudioDataEvent) => {
      if (typeof event.data !== "string") return;
      capturing.current?.add(base64ToBytes(event.data)); // exactly as recorded: no gain, no normalizing
    },
  }).current;

  useEffect(() => {
    void (async () => {
      const permission = await AudioStudioModule.getPermissionsAsync();
      if (!permission?.granted) return; // asked on the first press instead
      micReady.current = true;
      await prepareRecording(config);
    })();
    ensureConversation().catch(() => undefined); // opened early, so the first press starts at once
    return () => player.current?.stop();
  }, [prepareRecording, config, ensureConversation]);

  /** A new reply's audio player; the previous one stops. */
  function playerTap(): (event: ReplyEvent) => void {
    player.current?.stop();
    const current = new ReplyPlayer(phonePlayer, Crypto.randomUUID());
    player.current = current;
    return (event) => {
      if (event.type === "audio") current.add(event.seq, event.data);
      if (event.type === "done") current.end();
    };
  }

  /** A clip too quiet to send: "আবার বলবেন?" as text, and as the bundled sound unless speaking is off (D114). */
  function askAgain() {
    note(ASK_AGAIN);
    if (speaks) playAskAgain();
  }

  async function onPressIn() {
    player.current?.stop(); // barge-in
    stopPlayback();
    if (busy || turn.current || capturing.current) return; // the last recording is still coming in
    if (!micReady.current) {
      const permission = await AudioStudioModule.requestPermissionsAsync();
      if (!permission?.granted) return;
      micReady.current = true;
      await prepareRecording(config);
    }
    const started = new VoiceTurn(
      {
        upload: uploadChunk,
        playAskAgain: askAgain,
        newId: () => Crypto.randomUUID(),
        now: () => Date.now(),
      },
      ensureConversation(),
    );
    turn.current = started;
    capturing.current = started;
    setRecording(true);
    await startRecording(config);
    recordingSince.current = Date.now();
    if (turn.current !== started) {
      // released while the recorder was starting: a tap, dropped by its verdict
      await stopRecording().catch(() => undefined);
      if (capturing.current === started) capturing.current = null;
      void prepareRecording(config);
      return;
    }
    limit.current = setTimeout(() => void onPressOut(true), MAX_RECORDING_MS); // hard limit 30 s
  }

  async function onPressOut(atLimit = false) {
    const current = turn.current;
    if (!current) return;
    turn.current = null;
    current.markReleased();
    if (limit.current) clearTimeout(limit.current);
    // Half a second more after the release (D113); a tap and the 30 s limit stop at once.
    const heldMs = Date.now() - recordingSince.current;
    const tailMs = atLimit || heldMs < MIN_PRESS_MS ? 0 : Math.min(TAIL_MS, MAX_RECORDING_MS - heldMs);
    if (tailMs > 0) await new Promise((resolve) => setTimeout(resolve, tailMs));
    const recordedMs = Date.now() - recordingSince.current;
    await stopRecording().catch(() => undefined);
    // The recorder sends its last partial chunk a moment after it stops: wait for it (at most 0.6 s), so the end of
    // what was said is not lost, and it can never land in the next question (D103).
    await current.waitForAudio(recordedMs - LAST_CHUNK_SLACK_MS, LAST_CHUNK_WAIT_MS);
    if (capturing.current === current) capturing.current = null;
    setRecording(false);
    void prepareRecording(config); // ready for the next press
    if (current.verdict() !== "send") return;
    await runTurn(
      "",
      (_conversationId, onEvent) =>
        current.send((turnId, body) => streamTurn(`/voice/turns/${turnId}/finish`, body, onEvent)),
      playerTap(),
    );
    if (speechTrouble) void refresh(); // a turn that worked clears the warning at once
  }

  return (
    <View style={styles.page}>
      <OfflineBanner />
      <ScrollView
        ref={list}
        style={styles.flex}
        contentContainerStyle={styles.list}
        onContentSizeChange={() => list.current?.scrollToEnd({ animated: true })}
      >
        {messages.length === 0 ? <Text style={styles.hint}>{t("voice.hint")}</Text> : null}
        {messages.map((message) =>
          message.kind === "user" ? (
            message.text ? (
              <UserBubble key={message.id} text={message.text} />
            ) : null
          ) : (
            <AssistantBubble
              key={message.id}
              message={message}
              language={language}
              newest={message.id === newestReply?.id}
              busy={busy}
              onChoose={(slot, option) =>
                void send(
                  { choice: { slot, option_id: option.id }, label: option.label },
                  { speak: true, tap: playerTap() },
                )
              }
            />
          ),
        )}
      </ScrollView>
      <View style={styles.bottom}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("voice.hold")}
          // Never while recording: a question being asked is always finished and sent (D111).
          disabled={!micAllowed && !recording}
          onPressIn={onPressIn}
          onPressOut={() => void onPressOut()}
          style={[
            styles.button,
            { backgroundColor: recording ? colors.danger : micAllowed ? colors.green : colors.line },
          ]}
        >
          <Text style={styles.buttonText}>{recording ? t("status.listening") : t("voice.hold")}</Text>
        </Pressable>
        {!micAllowed ? (
          <Text style={styles.danger}>{t("offline.mic_off")}</Text>
        ) : speechTrouble ? (
          <Text style={styles.danger}>{t("offline.speech_trouble")}</Text>
        ) : null}
        {messages.length > 0 && !busy && !recording ? (
          <Button
            label={t("chat.new")}
            kind="plain"
            onPress={() => {
              player.current?.stop();
              reset();
            }}
          />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.white },
  flex: { flex: 1 },
  list: { padding: 16, gap: 14 },
  hint: { fontSize: 17, color: colors.muted, lineHeight: 24 },
  bottom: { padding: 16, gap: 10, borderTopWidth: 1, borderColor: colors.line },
  button: { height: 120, borderRadius: 60, alignItems: "center", justifyContent: "center" },
  buttonText: { color: colors.white, fontSize: 22, fontWeight: "700" },
  danger: { fontSize: 15, color: colors.danger },
});
