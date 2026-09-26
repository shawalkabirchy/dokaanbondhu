import { readReplyStream, type ReplyEvent } from "@dokaanbondhu/contracts";
import { AudioStudioModule, useAudioRecorder, type AudioDataEvent } from "@siteed/audio-studio";
import { fetch } from "expo/fetch";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { useHealth } from "../../src/lib/health";
import { base64ToBytes, RmsMeter } from "../../src/lib/pcm";
import { useDeviceSettings } from "../../src/lib/settings-store";
import { Button, colors, Heading, Note, Screen, styles } from "../../src/ui";

// Until step 4 this page checks the recording (proof P5): 16 kHz mono 16-bit PCM chunks every 500 ms, the last
// partial chunk on stop, and expo/fetch reading an NDJSON reply line by line.

interface ChunkInfo {
  bytes: number;
  atMs: number;
}

export default function Voice() {
  const { t } = useTranslation();
  const { micAllowed } = useHealth();
  const serverUrl = useDeviceSettings((state) => state.serverUrl);
  const recorder = useAudioRecorder();
  const [recording, setRecording] = useState(false);
  const [chunks, setChunks] = useState<ChunkInfo[]>([]);
  const [summary, setSummary] = useState<string | null>(null);
  const [stream, setStream] = useState<string[]>([]);
  const started = useRef(0);
  const rms = useRef(new RmsMeter());
  const collected = useRef<ChunkInfo[]>([]);

  async function onPressIn() {
    const permission = await AudioStudioModule.requestPermissionsAsync();
    if (!permission?.granted) return;
    collected.current = [];
    rms.current = new RmsMeter();
    setChunks([]);
    setSummary(null);
    started.current = Date.now();
    setRecording(true);
    await recorder.startRecording({
      sampleRate: 16000,
      channels: 1,
      encoding: "pcm_16bit",
      interval: 500,
      onAudioStream: async (event: AudioDataEvent) => {
        if (typeof event.data !== "string") return;
        const bytes = base64ToBytes(event.data); // exactly as recorded: no gain, no normalizing
        rms.current.add(bytes);
        collected.current.push({ bytes: bytes.byteLength, atMs: Date.now() - started.current });
        setChunks([...collected.current]);
      },
    });
  }

  async function onPressOut() {
    if (!recording) return;
    const result = await recorder.stopRecording(); // flushes the last partial chunk
    setRecording(false);
    const all = collected.current;
    const gaps = all.slice(1).map((chunk, index) => chunk.atMs - (all[index]?.atMs ?? 0));
    const total = all.reduce((sum, chunk) => sum + chunk.bytes, 0);
    const text =
      `chunks ${all.length}; sizes ${all.map((chunk) => chunk.bytes).join(",")}; gaps ms ${gaps.join(",")}; ` +
      `total ${total} bytes (${(total / 32).toFixed(0)} ms of 16 kHz 16-bit mono); rms ${rms.current.value.toFixed(4)}; ` +
      `held ${Date.now() - started.current} ms; file ${result?.sampleRate ?? "?"} Hz, ${result?.channels ?? "?"} ch, ` +
      `${result?.bitDepth ?? "?"} bit, ${result?.size ?? "?"} bytes`;
    setSummary(text);
    console.warn(`P5 recording: ${text}`);
  }

  async function testStream() {
    setStream([]);
    const begin = Date.now();
    const lines: string[] = [];
    const response = await fetch(`${serverUrl}/api/v1/dev/stream-test`);
    const reader = response.body?.getReader();
    if (!reader) return;
    await readReplyStream(reader, (event: ReplyEvent) => {
      lines.push(`${Date.now() - begin} ms: ${event.type}${event.type === "text" ? ` ${event.text}` : ""}`);
      setStream([...lines]);
    });
    console.warn(`P5 stream: ${lines.join(" | ")}`);
  }

  return (
    <Screen>
      <Note>{t("voice.coming")}</Note>
      <Pressable
        accessibilityRole="button"
        disabled={!micAllowed}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        style={{
          height: 160,
          borderRadius: 80,
          backgroundColor: recording ? colors.danger : micAllowed ? colors.green : colors.line,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={{ color: colors.white, fontSize: 22, fontWeight: "700" }}>
          {recording ? t("status.listening") : t("voice.hold")}
        </Text>
      </Pressable>
      {!micAllowed ? <Note tone="danger">{t("offline.mic_off")}</Note> : null}

      <Heading>{t("voice.check_title")}</Heading>
      <View style={styles.card}>
        <Note>
          {t("voice.chunks")}: {chunks.length} · {t("voice.last_chunk")}: {chunks.at(-1)?.bytes ?? 0} B
        </Note>
        {summary ? <Note>{summary}</Note> : null}
      </View>
      {__DEV__ ? (
        <>
          <Button kind="plain" label={t("voice.stream_test")} onPress={testStream} />
          {stream.map((line) => (
            <Note key={line}>{line}</Note>
          ))}
        </>
      ) : null}
    </Screen>
  );
}
