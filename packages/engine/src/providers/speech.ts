import { decryptSecret } from "../crypto";
import { recordProviderCall } from "./health";
import type { StoredProviderRow } from "./chain";

// Speech adapters (spec 13.1, 13.4): the speech worker's /asr and /tts, and ElevenLabs Scribe v2 and its voice, the
// paid side (D98, D128). A speech failure is never retried on another provider: speech-to-text failure ->
// "আবার বলবেন?", text-to-speech failure -> text only. Secrets are decrypted only here and never logged (spec 13.5).

/** The speech worker's /asr answer, field for field. */
export interface AsrResult {
  text: string;
  words: { word: string; start: number; end: number; probability: number | null }[];
  lowConfidenceWords: AsrResult["words"];
  nbest: { text: string; score: number | null }[]; // one entry for providers without N-best
  durationSeconds: number;
  processingMs: number;
  note: string | null;
}

export interface SttOptions {
  keyterms: string[];
  nbest: number;
  lowConfidenceBelow: number;
}

export interface SttProvider {
  id: string;
  transcribe(wav: Uint8Array, options: SttOptions, signal?: AbortSignal): Promise<AsrResult>;
}

export interface TtsProvider {
  id: string;
  synthesize(
    text: string,
    options: { voice: string },
    signal?: AbortSignal,
  ): Promise<{ mime: "audio/mpeg"; bytes: Uint8Array }>;
}

/** A speech call that failed: the HTTP status when there was one. */
export class SpeechError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "SpeechError";
  }
}

export interface SpeechWorkerConfig {
  id: string;
  baseUrl: string;
  /** "modal": Modal-Key and Modal-Secret from "<key>:<secret>" (development); "x-api-key": the pod's X-API-Key. */
  auth: "modal" | "x-api-key" | "none";
  secret: string | null;
  /**
   * How many keyterms the worker gets (options.keyterms, default 0, D100): Whisper's prompt made it drop and invent
   * words on 29 Sep even at 4 to 6 terms, so none are sent until real recordings show a number that helps.
   */
  maxKeyterms?: number;
}

// Timeouts (spec 13.4): 10 s to transcribe, 8 s per sentence to speak; Modal may first have to start the container
// (P2: up to 193 s; over 240 s after a laptop restart on 29 Sep, D101), so with Modal both are 360 s.
const STT_TIMEOUT_MS = 10_000;
const TTS_TIMEOUT_MS = 8_000;
const MODAL_TIMEOUT_MS = 360_000;

function authHeaders(config: SpeechWorkerConfig): Record<string, string> {
  if (!config.secret || config.auth === "none") return {};
  if (config.auth === "x-api-key") return { "X-API-Key": config.secret };
  const split = config.secret.indexOf(":");
  return { "Modal-Key": config.secret.slice(0, split), "Modal-Secret": config.secret.slice(split + 1) };
}

/** One HTTP call to a speech provider within its timeout; an error answer or no answer is a SpeechError. */
async function request(
  name: string,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  } catch (error) {
    throw new SpeechError(error instanceof Error ? error.message : String(error));
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 200);
    throw new SpeechError(`${name}: http ${response.status} ${detail}`, response.status);
  }
  return response;
}

function call(
  config: SpeechWorkerConfig,
  path: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  return request(
    `speech worker ${path}`,
    `${config.baseUrl.replace(/\/$/, "")}${path}`,
    { ...init, headers: { ...(init.headers as Record<string, string>), ...authHeaders(config) } },
    config.auth === "modal" ? MODAL_TIMEOUT_MS : timeoutMs,
    signal,
  );
}

/** Answers that refuse one clip or text ("audio too short"): the worker itself is working. */
const REFUSED_INPUT = new Set([400, 413, 422]);

/**
 * What a failed call says about the worker for /health (D111): an answer refusing this one input means it is up; no
 * answer, a timeout, a wrong key or a server error means it is down; a call the caller cancelled says nothing.
 */
function recordFailure(job: "stt" | "tts", error: unknown, signal: AbortSignal | undefined): void {
  if (signal?.aborted) return;
  recordProviderCall(job, error instanceof SpeechError && REFUSED_INPUT.has(error.status ?? 0));
}

interface WorkerWord {
  word: string;
  start: number;
  end: number;
  probability: number | null;
}

export function speechWorkerStt(config: SpeechWorkerConfig): SttProvider {
  return {
    id: config.id,
    async transcribe(wav, options, signal) {
      const form = new FormData();
      form.append("audio", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "clip.wav");
      form.append("keyterms", options.keyterms.slice(0, config.maxKeyterms ?? 0).join(","));
      form.append("nbest", String(options.nbest));
      form.append("low_confidence_below", String(options.lowConfidenceBelow));
      try {
        const response = await call(config, "/asr", { method: "POST", body: form }, STT_TIMEOUT_MS, signal);
        const body = (await response.json()) as {
          text: string;
          words: WorkerWord[];
          low_confidence_words: WorkerWord[];
          nbest: { text: string; score: number | null }[];
          duration_seconds: number;
          processing_ms: number;
          note: string | null;
        };
        recordProviderCall("stt", true);
        return {
          text: body.text,
          words: body.words,
          lowConfidenceWords: body.low_confidence_words,
          nbest: body.nbest,
          durationSeconds: body.duration_seconds,
          processingMs: body.processing_ms,
          note: body.note,
        };
      } catch (error) {
        recordFailure("stt", error, signal);
        throw error;
      }
    },
  };
}

export function speechWorkerTts(config: SpeechWorkerConfig): TtsProvider {
  return {
    id: config.id,
    async synthesize(text, options, signal) {
      try {
        const response = await call(
          config,
          "/tts",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text, voice: options.voice, format: "mp3" }),
          },
          TTS_TIMEOUT_MS,
          signal,
        );
        const bytes = new Uint8Array(await response.arrayBuffer());
        recordProviderCall("tts", true);
        return { mime: "audio/mpeg", bytes };
      } catch (error) {
        recordFailure("tts", error, signal);
        throw error;
      }
    },
  };
}

export interface ElevenLabsConfig {
  id: string;
  /** https://api.elevenlabs.io unless the row says otherwise (the tests point it at a stub). */
  baseUrl: string;
  apiKey: string;
  /** scribe_v2 to transcribe; eleven_v3_conversational to speak (eleven_v3 if the plain request refuses it, D128). */
  model: string;
  /** Our voice names (aditi, arjun) to ElevenLabs voice IDs; a name not in it uses the first. */
  voiceIds?: Record<string, string>;
}

export const ELEVENLABS_URL = "https://api.elevenlabs.io";
const SCRIBE_TIMEOUT_MS = 15_000;

/** Scribe's keyterm limits: at most 1,000 terms, each under 50 characters and of at most five words. */
function scribeKeyterms(keyterms: string[]): string[] {
  return keyterms
    .map((term) => term.trim())
    .filter((term) => term && term.length < 50 && term.split(/\s+/).length <= 5)
    .slice(0, 1000);
}

interface ScribeWord {
  text: string;
  type?: "word" | "spacing" | "audio_event";
  start?: number;
  end?: number;
  logprob?: number;
}

/** ElevenLabs Scribe v2 (spec 13.4, D128): the same trimmed clip as the speech worker, as WAV, in Bangla. */
export function elevenLabsStt(config: ElevenLabsConfig): SttProvider {
  return {
    id: config.id,
    async transcribe(wav, options, signal) {
      const form = new FormData();
      form.append("model_id", config.model);
      form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "clip.wav");
      form.append("language_code", "ben");
      form.append("timestamps_granularity", "word");
      form.append("tag_audio_events", "false"); // no "(laughter)" in the text the engine reads
      for (const term of scribeKeyterms(options.keyterms)) form.append("keyterms", term);
      const started = Date.now();
      try {
        const response = await request(
          "elevenlabs speech-to-text",
          `${config.baseUrl.replace(/\/$/, "")}/v1/speech-to-text`,
          { method: "POST", headers: { "xi-api-key": config.apiKey }, body: form },
          SCRIBE_TIMEOUT_MS,
          signal,
        );
        const body = (await response.json()) as {
          text?: string;
          words?: ScribeWord[];
          audio_duration_secs?: number;
        };
        recordProviderCall("stt", true);
        const text = (body.text ?? "").trim();
        const words = (body.words ?? [])
          .filter((word) => (word.type ?? "word") === "word")
          .map((word) => ({
            word: word.text,
            start: word.start ?? 0,
            end: word.end ?? 0,
            probability: typeof word.logprob === "number" ? Math.exp(word.logprob) : null,
          }));
        return {
          text,
          words,
          lowConfidenceWords: words.filter(
            (word) => word.probability !== null && word.probability < options.lowConfidenceBelow,
          ),
          nbest: [{ text, score: null }],
          durationSeconds: body.audio_duration_secs ?? words.at(-1)?.end ?? 0,
          processingMs: Date.now() - started,
          note: null,
        };
      } catch (error) {
        recordFailure("stt", error, signal);
        throw error;
      }
    },
  };
}

/** The ElevenLabs voice (spec 13.4, D128): MP3 at 22.05 kHz, 32 kbit/s, one sentence per call. */
export function elevenLabsTts(config: ElevenLabsConfig): TtsProvider {
  return {
    id: config.id,
    async synthesize(text, options, signal) {
      const voiceIds = config.voiceIds ?? {};
      const voiceId = voiceIds[options.voice] ?? Object.values(voiceIds)[0];
      try {
        if (!voiceId) throw new SpeechError("elevenlabs text-to-speech: no voice_ids in the provider row");
        const response = await request(
          "elevenlabs text-to-speech",
          `${config.baseUrl.replace(/\/$/, "")}/v1/text-to-speech/${encodeURIComponent(voiceId)}` +
            "?output_format=mp3_22050_32",
          {
            method: "POST",
            headers: {
              "xi-api-key": config.apiKey,
              "Content-Type": "application/json",
              Accept: "audio/mpeg",
            },
            body: JSON.stringify({ text, model_id: config.model }),
          },
          TTS_TIMEOUT_MS,
          signal,
        );
        const bytes = new Uint8Array(await response.arrayBuffer());
        recordProviderCall("tts", true);
        return { mime: "audio/mpeg", bytes };
      } catch (error) {
        recordFailure("tts", error, signal);
        throw error;
      }
    },
  };
}

function rowSecret(row: StoredProviderRow, aesKey: Buffer): string | null {
  return row.secretEncrypted
    ? decryptSecret(
        aesKey,
        { table: "ai_providers", rowId: row.id, column: "secret_encrypted" },
        row.secretEncrypted,
      )
    : null;
}

/** The speech worker's settings from a stored row. */
function workerConfig(row: StoredProviderRow, aesKey: Buffer): SpeechWorkerConfig | null {
  if (row.provider !== "speech_worker" || !row.baseUrl) return null;
  const options = (row.options ?? {}) as { auth?: SpeechWorkerConfig["auth"]; keyterms?: number };
  return {
    id: row.id,
    baseUrl: row.baseUrl,
    auth: options.auth ?? "none",
    secret: rowSecret(row, aesKey),
    maxKeyterms: options.keyterms ?? 0,
  };
}

/** ElevenLabs' settings from a stored row; a row without its key has no adapter (D128). */
function elevenLabsConfig(row: StoredProviderRow, aesKey: Buffer, model: string): ElevenLabsConfig | null {
  if (row.provider !== "elevenlabs") return null;
  const apiKey = rowSecret(row, aesKey);
  if (!apiKey) return null;
  const options = (row.options ?? {}) as { voice_ids?: Record<string, string> };
  return {
    id: row.id,
    baseUrl: row.baseUrl ?? ELEVENLABS_URL,
    apiKey,
    model: row.model ?? model,
    ...(options.voice_ids ? { voiceIds: options.voice_ids } : {}),
  };
}

export function sttAdapter(row: StoredProviderRow, aesKey: Buffer): SttProvider | null {
  const worker = workerConfig(row, aesKey);
  if (worker) return speechWorkerStt(worker);
  const eleven = elevenLabsConfig(row, aesKey, "scribe_v2");
  return eleven ? elevenLabsStt(eleven) : null;
}

export function ttsAdapter(row: StoredProviderRow, aesKey: Buffer): TtsProvider | null {
  const worker = workerConfig(row, aesKey);
  if (worker) return speechWorkerTts(worker);
  const eleven = elevenLabsConfig(row, aesKey, "eleven_v3_conversational");
  return eleven ? elevenLabsTts(eleven) : null;
}
