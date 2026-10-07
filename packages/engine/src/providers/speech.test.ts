import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encryptSecret } from "../crypto";
import type { StoredProviderRow } from "./chain";
import { recentHealth } from "./health";
import {
  elevenLabsStt,
  elevenLabsTts,
  SpeechError,
  speechWorkerStt,
  speechWorkerTts,
  sttAdapter,
  ttsAdapter,
  type ElevenLabsConfig,
  type SpeechWorkerConfig,
} from "./speech";

// The speech worker adapters against a stub worker on a local port (spec 13.4, 18.1): the multipart fields, both
// kinds of auth, the answer mapped field for field, and errors.

interface Seen {
  path: string;
  headers: IncomingMessage["headers"];
  body: Buffer;
}

describe("speech worker adapters", () => {
  let server: Server;
  let baseUrl: string;
  const seen: Seen[] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks);
        seen.push({ path: request.url ?? "", headers: request.headers, body });
        if (request.headers["modal-key"] === "bad") {
          response.writeHead(401).end("unauthorized");
        } else if (request.headers["modal-key"] === "short") {
          response.writeHead(422, { "Content-Type": "application/json" }).end('{"detail":"audio too short"}');
        } else if (request.url === "/asr") {
          response.writeHead(200, { "Content-Type": "application/json" }).end(
            JSON.stringify({
              text: "নোয়ার সেলফ আছে",
              words: [{ word: "নোয়ার", start: 0.1, end: 0.5, probability: 0.93 }],
              low_confidence_words: [{ word: "সেলফ", start: 0.5, end: 0.8, probability: 0.41 }],
              nbest: [
                { text: "নোয়ার সেলফ আছে", score: -0.2 },
                { text: "নোয়ার সেল আছে", score: -0.9 },
              ],
              duration_seconds: 1.4,
              processing_ms: 420,
              note: null,
            }),
          );
        } else {
          response.writeHead(200, { "Content-Type": "audio/mpeg" }).end(Buffer.from([0xff, 0xf3, 1, 2]));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const config = (overrides: Partial<SpeechWorkerConfig> = {}): SpeechWorkerConfig => ({
    id: "worker",
    baseUrl,
    auth: "modal",
    secret: "key-1:secret-1",
    maxKeyterms: 2,
    ...overrides,
  });

  it("sends the clip with keyterms and N-best as multipart, and maps the answer field for field", async () => {
    const result = await speechWorkerStt(config()).transcribe(new Uint8Array([82, 73, 70, 70]), {
      keyterms: ["সেলফ", "নোয়া", "এক্সিও"], // the third is over this worker's limit of 2
      nbest: 5,
      lowConfidenceBelow: 0.5,
    });
    expect(result).toMatchObject({
      text: "নোয়ার সেলফ আছে",
      lowConfidenceWords: [{ word: "সেলফ", probability: 0.41 }],
      nbest: [{ text: "নোয়ার সেলফ আছে" }, { text: "নোয়ার সেল আছে" }],
      durationSeconds: 1.4,
      processingMs: 420,
      note: null,
    });
    const request = seen.at(-1)!;
    expect(request.path).toBe("/asr");
    expect(request.headers).toMatchObject({ "modal-key": "key-1", "modal-secret": "secret-1" });
    const form = request.body.toString("utf8");
    expect(form).toContain('name="keyterms"\r\n\r\nসেলফ,নোয়া');
    expect(form).toContain('name="nbest"\r\n\r\n5');
    expect(form).toContain('name="low_confidence_below"\r\n\r\n0.5');
    expect(form).toContain('name="audio"; filename="clip.wav"');
    expect(recentHealth("stt")).toBe("ok");
  });

  it("sends no keyterms unless the row allows some (D100)", async () => {
    await speechWorkerStt(config({ maxKeyterms: undefined })).transcribe(new Uint8Array(4), {
      keyterms: ["সেলফ", "নোয়া"],
      nbest: 5,
      lowConfidenceBelow: 0.5,
    });
    expect(seen.at(-1)!.body.toString("utf8")).toContain('name="keyterms"\r\n\r\n\r\n');
  });

  it("asks for MP3 with the voice, with the pod's X-API-Key", async () => {
    const audio = await speechWorkerTts(config({ auth: "x-api-key", secret: "pod-key" })).synthesize(
      "নোয়া ২০১৬-এর সেলফ আছে।",
      { voice: "aditi" },
    );
    expect(audio).toEqual({ mime: "audio/mpeg", bytes: new Uint8Array([0xff, 0xf3, 1, 2]) });
    const request = seen.at(-1)!;
    expect(request.headers["x-api-key"]).toBe("pod-key");
    expect(JSON.parse(request.body.toString("utf8"))).toEqual({
      text: "নোয়া ২০১৬-এর সেলফ আছে।",
      voice: "aditi",
      format: "mp3",
    });
  });

  it("turns an error answer or an unreachable worker into a SpeechError, and marks speech down", async () => {
    await expect(
      speechWorkerStt(config({ secret: "bad:x" })).transcribe(new Uint8Array(4), {
        keyterms: [],
        nbest: 5,
        lowConfidenceBelow: 0.5,
      }),
    ).rejects.toMatchObject({ name: "SpeechError", status: 401 });
    expect(recentHealth("stt")).toBe("down");
    await expect(
      speechWorkerTts(config({ baseUrl: "http://127.0.0.1:9" })).synthesize("x", { voice: "aditi" }),
    ).rejects.toBeInstanceOf(SpeechError);
    expect(recentHealth("tts")).toBe("down");
  });

  // From the owner's test on 30 Sep (D111): "audio too short" marked speech down, and the app then turned the
  // microphone off for five minutes.
  it("keeps speech up when the worker refuses one clip, and a cancelled call changes nothing", async () => {
    const options = { keyterms: [], nbest: 5, lowConfidenceBelow: 0.5 };
    await expect(
      speechWorkerStt(config({ secret: "short:x" })).transcribe(new Uint8Array(4), options),
    ).rejects.toMatchObject({ name: "SpeechError", status: 422 });
    expect(recentHealth("stt")).toBe("ok");

    // A call the caller cancelled (a text-to-speech call: its body is not a stream) leaves the last result as it was.
    const tts = speechWorkerTts(config());
    await tts.synthesize("আছে।", { voice: "aditi" });
    expect(recentHealth("tts")).toBe("ok");
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(tts.synthesize("আছে।", { voice: "aditi" }, cancelled.signal)).rejects.toBeInstanceOf(
      SpeechError,
    );
    expect(recentHealth("tts")).toBe("ok");
  });
});

// The ElevenLabs adapters against a stub of its API on a local port (spec 13.4, D128): Scribe v2's multipart fields
// and keyterm limits, its words mapped to ours, the voice by name, the key header, and errors.
describe("ElevenLabs adapters", () => {
  let server: Server;
  let baseUrl: string;
  const seen: Seen[] = [];
  let scribeAnswer: { status: number; body: unknown } = { status: 200, body: {} };

  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        seen.push({ path: request.url ?? "", headers: request.headers, body: Buffer.concat(chunks) });
        if (request.headers["xi-api-key"] !== "xi-key") {
          response.writeHead(401).end('{"detail":"invalid api key"}');
        } else if (request.url === "/v1/speech-to-text") {
          response
            .writeHead(scribeAnswer.status, { "Content-Type": "application/json" })
            .end(JSON.stringify(scribeAnswer.body));
        } else {
          response.writeHead(200, { "Content-Type": "audio/mpeg" }).end(Buffer.from([0xff, 0xf3, 9]));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const config = (overrides: Partial<ElevenLabsConfig> = {}): ElevenLabsConfig => ({
    id: "eleven",
    baseUrl,
    apiKey: "xi-key",
    model: "scribe_v2",
    ...overrides,
  });
  const fields = (body: Buffer, name: string) =>
    [...body.toString("utf8").matchAll(new RegExp(`name="${name}"\r\n\r\n(.*?)\r\n`, "g"))].map(
      (match) => match[1],
    );

  it("sends the clip to Scribe v2 in Bangla with word timestamps and the keyterms it allows, and maps its words", async () => {
    scribeAnswer = {
      status: 200,
      body: {
        language_code: "ben",
        language_probability: 0.98,
        text: " নোয়ার সেলফ আছে ",
        words: [
          { text: "নোয়ার", type: "word", start: 0.1, end: 0.5, logprob: -0.05 },
          { text: " ", type: "spacing", start: 0.5, end: 0.55 },
          { text: "সেলফ", type: "word", start: 0.55, end: 0.9, logprob: -1.2 },
          { text: "(noise)", type: "audio_event", start: 0.9, end: 1.0 },
          { text: "আছে", type: "word", start: 1.0, end: 1.3 },
        ],
        audio_duration_secs: 1.4,
      },
    };
    const result = await elevenLabsStt(config()).transcribe(new Uint8Array([82, 73, 70, 70]), {
      keyterms: ["সেলফ", "নোয়া", "x".repeat(60), "one two three four five six"],
      nbest: 5,
      lowConfidenceBelow: 0.5,
    });
    expect(result.text).toBe("নোয়ার সেলফ আছে");
    expect(result.words.map((word) => word.word)).toEqual(["নোয়ার", "সেলফ", "আছে"]);
    expect(result.words[0]!.probability).toBeCloseTo(Math.exp(-0.05));
    expect(result.words[2]!.probability).toBeNull(); // no logprob in the answer: no probability made up
    expect(result.lowConfidenceWords.map((word) => word.word)).toEqual(["সেলফ"]); // e^-1.2 = 0.30
    expect(result).toMatchObject({
      nbest: [{ text: "নোয়ার সেলফ আছে", score: null }],
      durationSeconds: 1.4,
      note: null,
    });

    const request = seen.at(-1)!;
    expect(request.path).toBe("/v1/speech-to-text");
    expect(request.headers["xi-api-key"]).toBe("xi-key");
    expect(fields(request.body, "model_id")).toEqual(["scribe_v2"]);
    expect(fields(request.body, "language_code")).toEqual(["ben"]);
    expect(fields(request.body, "timestamps_granularity")).toEqual(["word"]);
    expect(fields(request.body, "tag_audio_events")).toEqual(["false"]);
    // one field per keyterm; a term of 50 characters or more, or of more than five words, is left out
    expect(fields(request.body, "keyterms")).toEqual(["সেলফ", "নোয়া"]);
    expect(request.body.toString("utf8")).toContain('name="file"; filename="clip.wav"');
    expect(recentHealth("stt")).toBe("ok");
  });

  it("speaks with the voice named by the shop's setting, else the first, as small MP3", async () => {
    const tts = elevenLabsTts(
      config({ model: "eleven_v3_conversational", voiceIds: { aditi: "voice-a", arjun: "voice-b" } }),
    );
    expect(await tts.synthesize("নোয়া দুই হাজার ষোলোর সেলফ আছে।", { voice: "arjun" })).toEqual({
      mime: "audio/mpeg",
      bytes: new Uint8Array([0xff, 0xf3, 9]),
    });
    const request = seen.at(-1)!;
    expect(request.path).toBe("/v1/text-to-speech/voice-b?output_format=mp3_22050_32");
    expect(request.headers["xi-api-key"]).toBe("xi-key");
    expect(JSON.parse(request.body.toString("utf8"))).toEqual({
      text: "নোয়া দুই হাজার ষোলোর সেলফ আছে।",
      model_id: "eleven_v3_conversational",
    });
    await tts.synthesize("আছে।", { voice: "someone-else" });
    expect(seen.at(-1)!.path).toBe("/v1/text-to-speech/voice-a?output_format=mp3_22050_32");
    await expect(
      elevenLabsTts(config({ model: "eleven_v3_conversational" })).synthesize("আছে।", { voice: "aditi" }),
    ).rejects.toBeInstanceOf(SpeechError); // no voice IDs in the row
  });

  it("turns a refused key into a SpeechError and marks speech down, but one refused clip keeps it up", async () => {
    const options = { keyterms: [], nbest: 5, lowConfidenceBelow: 0.5 };
    await expect(
      elevenLabsStt(config({ apiKey: "wrong" })).transcribe(new Uint8Array(4), options),
    ).rejects.toMatchObject({
      name: "SpeechError",
      status: 401,
    });
    expect(recentHealth("stt")).toBe("down");
    scribeAnswer = { status: 422, body: { detail: "audio too short" } };
    await expect(elevenLabsStt(config()).transcribe(new Uint8Array(4), options)).rejects.toMatchObject({
      status: 422,
    });
    expect(recentHealth("stt")).toBe("ok");
  });

  it("makes an adapter from a stored row only with its key, with the model and voices of the row", async () => {
    const aesKey = randomBytes(32);
    const row = (overrides: Partial<StoredProviderRow>): StoredProviderRow => ({
      id: "row-1",
      shopId: null,
      job: "stt",
      provider: "elevenlabs",
      model: null,
      priority: null,
      active: true,
      external: true,
      enabled: true,
      baseUrl,
      secretEncrypted: encryptSecret(
        aesKey,
        { table: "ai_providers", rowId: "row-1", column: "secret_encrypted" },
        "xi-key",
      ),
      options: {},
      ...overrides,
    });
    expect(sttAdapter(row({ secretEncrypted: null }), aesKey)).toBeNull();
    expect(ttsAdapter(row({ job: "tts", secretEncrypted: null }), aesKey)).toBeNull();

    scribeAnswer = { status: 200, body: { text: "আছে", words: [] } };
    await sttAdapter(row({}), aesKey)!.transcribe(new Uint8Array(4), {
      keyterms: [],
      nbest: 5,
      lowConfidenceBelow: 0.5,
    });
    expect(fields(seen.at(-1)!.body, "model_id")).toEqual(["scribe_v2"]); // the default model

    await ttsAdapter(
      row({ job: "tts", model: "eleven_v3", options: { voice_ids: { aditi: "voice-a" } } }),
      aesKey,
    )!.synthesize("আছে।", { voice: "aditi" });
    expect(JSON.parse(seen.at(-1)!.body.toString("utf8"))).toMatchObject({ model_id: "eleven_v3" });
  });
});
