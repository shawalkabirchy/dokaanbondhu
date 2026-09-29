import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recentHealth } from "./health";
import { SpeechError, speechWorkerStt, speechWorkerTts, type SpeechWorkerConfig } from "./speech";

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
    ...overrides,
  });

  it("sends the clip with keyterms and N-best as multipart, and maps the answer field for field", async () => {
    const result = await speechWorkerStt(config()).transcribe(new Uint8Array([82, 73, 70, 70]), {
      keyterms: ["সেলফ", "নোয়া"],
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
});
