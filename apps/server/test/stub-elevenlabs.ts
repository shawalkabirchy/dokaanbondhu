import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// A stub of ElevenLabs' API on a local port for the server's integration tests (spec 13.4, D128): Scribe v2 answers the
// next scripted transcript (or fails), the voice answers a few bytes that name the sentence. The requests are kept,
// with the clip exactly as sent, so a test can check the trim and that no gain was applied.

export const ELEVEN_KEY = "xi-test-key";

export interface ScribeStep {
  text: string;
  status?: number; // an error answer instead
}

export interface ScribeRequest {
  /** The file field as sent: a WAV of the trimmed clip. */
  wav: Buffer;
  fields: Record<string, string[]>;
}

export interface VoiceRequest {
  voiceId: string;
  query: string;
  text: string;
  modelId: string;
}

export interface StubElevenLabs {
  transcripts: ScribeStep[];
  scribeRequests: ScribeRequest[];
  voiceRequests: VoiceRequest[];
  baseUrl: string;
  close(): Promise<void>;
}

/** The fake MP3 bytes the stub's voice answers for a sentence. */
export const fakeElevenMp3 = (text: string) => Buffer.from(`eleven:${text}`, "utf8");

/** Every part of a multipart body, binary-safe: text fields by name, the file as bytes. */
function parts(request: IncomingMessage, body: Buffer): { fields: Record<string, string[]>; file: Buffer } {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(request.headers["content-type"] ?? "");
  const delimiter = Buffer.from(`--${boundary?.[1] ?? boundary?.[2] ?? ""}`);
  const fields: Record<string, string[]> = {};
  let file = Buffer.alloc(0);
  let at = body.indexOf(delimiter);
  while (at >= 0) {
    const next = body.indexOf(delimiter, at + delimiter.length);
    if (next < 0) break;
    const part = body.subarray(at + delimiter.length + 2, next - 2); // without the CRLFs around it
    const split = part.indexOf("\r\n\r\n");
    const head = part.subarray(0, split).toString("utf8");
    const value = part.subarray(split + 4);
    const name = /name="([^"]+)"/.exec(head)?.[1] ?? "";
    if (/filename=/.test(head)) file = Buffer.from(value);
    else (fields[name] ??= []).push(value.toString("utf8"));
    at = next;
  }
  return { fields, file };
}

export async function startStubElevenLabs(): Promise<StubElevenLabs> {
  const stub: Omit<StubElevenLabs, "baseUrl" | "close"> = {
    transcripts: [],
    scribeRequests: [],
    voiceRequests: [],
  };
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      if (request.headers["xi-api-key"] !== ELEVEN_KEY) {
        response.writeHead(401).end('{"detail":"invalid api key"}');
        return;
      }
      const url = new URL(request.url ?? "/", "http://stub");
      if (url.pathname === "/v1/speech-to-text") {
        const { fields, file } = parts(request, body);
        stub.scribeRequests.push({ wav: file, fields });
        const step = stub.transcripts.shift() ?? { text: "" };
        if (step.status) {
          response.writeHead(step.status).end('{"detail":"failed"}');
          return;
        }
        const words = step.text.split(/\s+/).filter(Boolean);
        response.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            language_code: "ben",
            language_probability: 0.97,
            text: step.text,
            words: words.map((text, i) => ({
              text,
              type: "word",
              start: i * 0.3,
              end: i * 0.3 + 0.3,
              logprob: -0.1,
            })),
            audio_duration_secs: 1.2,
          }),
        );
        return;
      }
      const voice = /^\/v1\/text-to-speech\/([^/]+)$/.exec(url.pathname);
      if (voice) {
        const { text, model_id } = JSON.parse(body.toString("utf8")) as { text: string; model_id: string };
        stub.voiceRequests.push({
          voiceId: decodeURIComponent(voice[1]!),
          query: url.search,
          text,
          modelId: model_id,
        });
        response.writeHead(200, { "content-type": "audio/mpeg" }).end(fakeElevenMp3(text));
        return;
      }
      response.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return Object.assign(stub, {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  });
}
