import { decryptSecret } from "../crypto";
import { recordProviderCall } from "./health";
import type { StoredProviderRow } from "./chain";

// Speech adapters (spec 13.1, 13.4): the speech worker's /asr and /tts. A speech failure is never retried on another
// provider: speech-to-text failure -> "আবার বলবেন?", text-to-speech failure -> text only. Secrets are decrypted only
// here and never logged (spec 13.5).

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
// (P2: up to 193 s), so with Modal both are 240 s.
const STT_TIMEOUT_MS = 10_000;
const TTS_TIMEOUT_MS = 8_000;
const MODAL_TIMEOUT_MS = 240_000;

function authHeaders(config: SpeechWorkerConfig): Record<string, string> {
  if (!config.secret || config.auth === "none") return {};
  if (config.auth === "x-api-key") return { "X-API-Key": config.secret };
  const split = config.secret.indexOf(":");
  return { "Modal-Key": config.secret.slice(0, split), "Modal-Secret": config.secret.slice(split + 1) };
}

async function call(
  config: SpeechWorkerConfig,
  path: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  const timeout = AbortSignal.timeout(config.auth === "modal" ? MODAL_TIMEOUT_MS : timeoutMs);
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl.replace(/\/$/, "")}${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), ...authHeaders(config) },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (error) {
    throw new SpeechError(error instanceof Error ? error.message : String(error));
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 200);
    throw new SpeechError(`speech worker ${path}: http ${response.status} ${detail}`, response.status);
  }
  return response;
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
        recordProviderCall("stt", false);
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
        recordProviderCall("tts", false);
        throw error;
      }
    },
  };
}

/** The speech worker's settings from a stored row; null for a provider without an adapter yet (ElevenLabs: step 4). */
function workerConfig(row: StoredProviderRow, aesKey: Buffer): SpeechWorkerConfig | null {
  if (row.provider !== "speech_worker" || !row.baseUrl) return null;
  const secret = row.secretEncrypted
    ? decryptSecret(
        aesKey,
        { table: "ai_providers", rowId: row.id, column: "secret_encrypted" },
        row.secretEncrypted,
      )
    : null;
  const options = (row.options ?? {}) as { auth?: SpeechWorkerConfig["auth"]; keyterms?: number };
  return {
    id: row.id,
    baseUrl: row.baseUrl,
    auth: options.auth ?? "none",
    secret,
    maxKeyterms: options.keyterms ?? 0,
  };
}

export function sttAdapter(row: StoredProviderRow, aesKey: Buffer): SttProvider | null {
  const config = workerConfig(row, aesKey);
  return config ? speechWorkerStt(config) : null;
}

export function ttsAdapter(row: StoredProviderRow, aesKey: Buffer): TtsProvider | null {
  const config = workerConfig(row, aesKey);
  return config ? speechWorkerTts(config) : null;
}
