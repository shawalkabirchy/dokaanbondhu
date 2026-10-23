import type { ReplyEvent } from "@dokaanbondhu/contracts";
import {
  AudioStudioModule,
  useAudioRecorder,
  type AudioDataEvent,
  type RecordingConfig,
} from "@siteed/audio-studio";
import * as Crypto from "expo-crypto";
import { useEffect, useRef, useState } from "react";
import type { ChatState } from "./chat-store";
import { base64ToBytes, RmsMeter } from "./pcm";
import { streamTurn, uploadChunk } from "./stream";
import { MAX_RECORDING_MS, MIN_PRESS_MS, VoiceTurn } from "./voice-turn";

// Push-to-talk (spec 15.3, 15.4): hold the button and speak; on release the clip is finished and the answer streams
// in: the transcript as the user's words, then the reply as text with its audio. The recorder is prepared before the
// press (on opening the page and after every stop), because unprepared it takes about 1.4 s to start and loses the
// first words (P5). Pressing again while an answer plays stops it (barge-in). After the release the recorder listens
// for half a second more, so the last word is not cut (D113). Moved unchanged from the voice page into this hook when
// voice and typing became one page (D166); the page adds what the user sees and feels.

/** How long release waits for the recorder's last chunk, and how much short of the held time counts as all of it. */
const LAST_CHUNK_WAIT_MS = 600;
const LAST_CHUNK_SLACK_MS = 250;
/**
 * The recorder keeps listening this long after the button is let go (D113): the sound of the last word is still on its
 * way through the microphone when the finger lifts. Not after a tap, and never past the 30 s limit.
 */
const TAIL_MS = 500;

export interface PushToTalkDeps {
  /** A turn is running: a press only stops the answer being spoken. */
  busy: boolean;
  ensureConversation: ChatState["ensureConversation"];
  runTurn: ChatState["runTurn"];
  /** A clip too quiet to send (D114, D150). */
  askAgain: () => void;
  /** A new reply's audio player; the previous one stops. */
  replyTap: () => (event: ReplyEvent) => void;
  /** Barge-in: stops the answer being spoken. */
  stopReply: () => void;
  /** After a question was sent and answered. */
  afterTurn: () => void;
}

export function usePushToTalk(deps: PushToTalkDeps) {
  const { prepareRecording, startRecording, stopRecording } = useAudioRecorder();
  const [recording, setRecording] = useState(false);
  /** The loudness of the last chunk while recording (RMS, 0 to 1), for the ring around the button (D166). */
  const [level, setLevel] = useState(0);
  const turn = useRef<VoiceTurn | null>(null);
  /** The turn the recorder's chunks belong to: it stays until the recorder's last chunk is in (D103). */
  const capturing = useRef<VoiceTurn | null>(null);
  const recordingSince = useRef(0);
  const limit = useRef<ReturnType<typeof setTimeout> | null>(null);
  const micReady = useRef(false);
  const { ensureConversation } = deps;

  // The settings of spec 15.3; the same object prepares and starts the recorder. The floating mic's service declares
  // the microphone for the background, which turns on the library's own background mode; keepAwake off and the
  // interactive audio focus keep its recording exactly as before (spec 15.9). Streaming only: the library would also
  // write each recording to a WAV file that nothing reads and nothing deletes (D204).
  const config = useRef<RecordingConfig>({
    sampleRate: 16000,
    channels: 1,
    encoding: "pcm_16bit",
    interval: 500,
    keepAwake: false,
    android: { audioFocusStrategy: "interactive" },
    output: { primary: { enabled: false } },
    onAudioStream: async (event: AudioDataEvent) => {
      if (typeof event.data !== "string") return;
      const current = capturing.current;
      if (!current) return;
      const bytes = base64ToBytes(event.data);
      current.add(bytes); // exactly as recorded: no gain, no normalizing
      const meter = new RmsMeter();
      meter.add(bytes);
      setLevel(meter.value);
    },
  }).current;

  useEffect(() => {
    void (async () => {
      const permission = await AudioStudioModule.getPermissionsAsync();
      if (!permission?.granted) return; // asked on the first press instead
      micReady.current = true;
      await prepareRecording(config);
    })();
    ensureConversation("voice").catch(() => undefined); // opened early, so the first press starts at once
  }, [prepareRecording, config, ensureConversation]);

  async function onPressIn() {
    deps.stopReply(); // barge-in
    if (deps.busy || turn.current || capturing.current) return; // the last recording is still coming in
    if (!micReady.current) {
      const permission = await AudioStudioModule.requestPermissionsAsync();
      if (!permission?.granted) return;
      micReady.current = true;
      await prepareRecording(config);
    }
    const started = new VoiceTurn(
      {
        upload: uploadChunk,
        playAskAgain: deps.askAgain,
        newId: () => Crypto.randomUUID(),
        now: () => Date.now(),
      },
      ensureConversation("voice"),
    );
    turn.current = started;
    capturing.current = started;
    setLevel(0);
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
    setLevel(0);
    void prepareRecording(config); // ready for the next press
    if (current.verdict() !== "send") return;
    await deps.runTurn(
      "",
      (_conversationId, onEvent) =>
        current.send((turnId, body) => streamTurn(`/voice/turns/${turnId}/finish`, body, onEvent)),
      deps.replyTap(),
      "status.understanding", // turning the voice into words: "বুঝছি…", never "খুঁজছি…" first (D115)
    );
    deps.afterTurn();
  }

  /** The floating mic was dragged instead of held (spec 15.9): the recording stops and nothing is sent. */
  async function onCancel() {
    const current = turn.current;
    if (!current) return;
    turn.current = null;
    current.cancel();
    if (limit.current) clearTimeout(limit.current);
    await stopRecording().catch(() => undefined);
    if (capturing.current === current) capturing.current = null;
    setRecording(false);
    setLevel(0);
    void prepareRecording(config);
  }

  return { recording, level, onPressIn, onPressOut, onCancel };
}
