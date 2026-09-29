import type { ReplyEvent } from "@dokaanbondhu/contracts";
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
import { useDeviceSettings } from "../../src/lib/settings-store";
import { streamTurn, uploadChunk } from "../../src/lib/stream";
import { useVoice } from "../../src/lib/voice";
import { MAX_RECORDING_MS, VoiceTurn } from "../../src/lib/voice-turn";
import { Button, colors, OfflineBanner } from "../../src/ui";

// The voice page (spec 15.2, 15.3, 15.4): hold the button and speak; on release the clip is finished and the answer
// streams in: the transcript as the user's words, then the reply as text with its audio, played in order. The recorder
// is prepared before the press (on opening the page and after every stop), because unprepared it takes about 1.4 s
// to start and loses the first words (P5). Pressing again while an answer plays stops it (barge-in).

export default function Voice() {
  const { t } = useTranslation();
  const language = useDeviceSettings((state) => state.language);
  const { micAllowed } = useHealth();
  const { messages, busy, runTurn, ensureConversation, send, reset } = useVoice();
  const { prepareRecording, startRecording, stopRecording } = useAudioRecorder();
  const [recording, setRecording] = useState(false);
  const turn = useRef<VoiceTurn | null>(null);
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
      turn.current?.add(base64ToBytes(event.data)); // exactly as recorded: no gain, no normalizing
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

  async function onPressIn() {
    player.current?.stop(); // barge-in
    stopPlayback();
    if (busy || turn.current) return;
    if (!micReady.current) {
      const permission = await AudioStudioModule.requestPermissionsAsync();
      if (!permission?.granted) return;
      micReady.current = true;
      await prepareRecording(config);
    }
    const started = new VoiceTurn(
      { upload: uploadChunk, playAskAgain, newId: () => Crypto.randomUUID(), now: () => Date.now() },
      ensureConversation(),
    );
    turn.current = started;
    setRecording(true);
    await startRecording(config);
    if (turn.current !== started) {
      // released while the recorder was starting: a tap, dropped by its verdict
      await stopRecording().catch(() => undefined);
      void prepareRecording(config);
      return;
    }
    limit.current = setTimeout(() => void onPressOut(), MAX_RECORDING_MS); // hard limit 30 s
  }

  async function onPressOut() {
    const current = turn.current;
    if (!current) return;
    turn.current = null;
    if (limit.current) clearTimeout(limit.current);
    await stopRecording().catch(() => undefined); // flushes the last partial chunk
    setRecording(false);
    void prepareRecording(config); // ready for the next press
    if (current.verdict() !== "send") return;
    await runTurn(
      "",
      (_conversationId, onEvent) =>
        current.send((turnId, body) => streamTurn(`/voice/turns/${turnId}/finish`, body, onEvent)),
      playerTap(),
    );
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
          disabled={!micAllowed}
          onPressIn={onPressIn}
          onPressOut={onPressOut}
          style={[
            styles.button,
            { backgroundColor: recording ? colors.danger : micAllowed ? colors.green : colors.line },
          ]}
        >
          <Text style={styles.buttonText}>{recording ? t("status.listening") : t("voice.hold")}</Text>
        </Pressable>
        {!micAllowed ? <Text style={styles.danger}>{t("offline.mic_off")}</Text> : null}
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
