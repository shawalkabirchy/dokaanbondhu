import {
  AudioStudioModule,
  useAudioRecorder,
  type AudioDataEvent,
  type RecordingConfig,
} from "@siteed/audio-studio";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { useHealth } from "../../src/lib/health";
import { base64ToBytes, RmsMeter } from "../../src/lib/pcm";
import { colors, Heading, Note, Screen, styles } from "../../src/ui";

// Until step 4 this page checks the recording (proof P5, passed 27 Sep): 16 kHz mono 16-bit PCM chunks every
// 500 ms and the last partial chunk on stop. The recorder is prepared before the
// press (on opening the page and after every stop): unprepared, it takes about 1.4 s to start and loses the first
// words (P5).

interface ChunkInfo {
  bytes: number;
  atMs: number;
}

export default function Voice() {
  const { t } = useTranslation();
  const { micAllowed } = useHealth();
  const { prepareRecording, startRecording, stopRecording } = useAudioRecorder();
  const [recording, setRecording] = useState(false);
  const [chunks, setChunks] = useState<ChunkInfo[]>([]);
  const [summary, setSummary] = useState<string | null>(null);
  const pressedAt = useRef(0);
  const startedAt = useRef(0);
  const micReady = useRef(false);
  const rms = useRef(new RmsMeter());
  const collected = useRef<ChunkInfo[]>([]);
  // The settings of spec 15.3; the same object prepares and starts the recorder.
  const config = useRef<RecordingConfig>({
    sampleRate: 16000,
    channels: 1,
    encoding: "pcm_16bit",
    interval: 500,
    onAudioStream: async (event: AudioDataEvent) => {
      if (typeof event.data !== "string") return;
      const bytes = base64ToBytes(event.data); // exactly as recorded: no gain, no normalizing
      rms.current.add(bytes);
      collected.current.push({ bytes: bytes.byteLength, atMs: Date.now() - pressedAt.current });
      setChunks([...collected.current]);
    },
  }).current;

  useEffect(() => {
    void (async () => {
      const permission = await AudioStudioModule.getPermissionsAsync();
      if (!permission?.granted) return; // asked on the first press instead
      micReady.current = true;
      await prepareRecording(config);
    })();
  }, [prepareRecording, config]);

  async function onPressIn() {
    pressedAt.current = Date.now();
    if (!micReady.current) {
      const permission = await AudioStudioModule.requestPermissionsAsync();
      if (!permission?.granted) return;
      micReady.current = true;
    }
    collected.current = [];
    rms.current = new RmsMeter();
    setChunks([]);
    setSummary(null);
    setRecording(true);
    await startRecording(config);
    startedAt.current = Date.now();
  }

  async function onPressOut() {
    if (!recording) return;
    const releasedAt = Date.now();
    const result = await stopRecording(); // flushes the last partial chunk
    setRecording(false);
    void prepareRecording(config); // ready for the next press
    const all = collected.current;
    const gaps = all.slice(1).map((chunk, index) => chunk.atMs - (all[index]?.atMs ?? 0));
    const total = all.reduce((sum, chunk) => sum + chunk.bytes, 0);
    const text =
      `chunks ${all.length}; sizes ${all.map((chunk) => chunk.bytes).join(",")}; gaps ms ${gaps.join(",")}; ` +
      `total ${total} bytes (${(total / 32).toFixed(0)} ms of 16 kHz 16-bit mono); rms ${rms.current.value.toFixed(4)}; ` +
      `start ${startedAt.current - pressedAt.current} ms after the press; held ${releasedAt - pressedAt.current} ms; ` +
      `file ${result?.sampleRate ?? "?"} Hz, ${result?.channels ?? "?"} ch, ${result?.bitDepth ?? "?"} bit, ` +
      `${result?.size ?? "?"} bytes`;
    setSummary(text);
    console.warn(`P5 recording: ${text}`);
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
    </Screen>
  );
}
