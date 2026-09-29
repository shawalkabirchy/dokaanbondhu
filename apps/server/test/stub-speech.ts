import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// A stub speech worker on a local port for the server's integration tests (spec 14.1 API): /asr answers the next
// scripted transcript (or fails), /tts answers a few bytes that name the sentence, so a test can check which audio
// belongs to which sentence. The requests are kept.

export interface AsrStep {
  text: string;
  nbest?: string[];
  unclear?: string[];
  note?: string | null;
  status?: number; // an error answer instead
}

export interface AsrRequest {
  wavBytes: number;
  riff: boolean;
  keyterms: string[];
  nbest: string;
}

export interface StubSpeech {
  asr: AsrStep[];
  asrRequests: AsrRequest[];
  ttsTexts: string[];
  ttsFails: boolean;
  baseUrl: string;
  close(): Promise<void>;
}

/** The fake MP3 bytes the stub answers for a sentence. */
export const fakeMp3 = (text: string) => Buffer.from(`mp3:${text}`, "utf8");

/** Reads one field of a multipart body (enough for the adapter's own requests). */
function field(body: Buffer, name: string): Buffer | null {
  const marker = Buffer.from(`name="${name}"`);
  const at = body.indexOf(marker);
  if (at < 0) return null;
  const start = body.indexOf("\r\n\r\n", at) + 4;
  const end = body.indexOf("\r\n--", start);
  return body.subarray(start, end);
}

export async function startStubSpeech(): Promise<StubSpeech> {
  const stub: Omit<StubSpeech, "baseUrl" | "close"> = {
    asr: [],
    asrRequests: [],
    ttsTexts: [],
    ttsFails: false,
  };
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      if (request.url === "/asr") {
        const audio = field(body, "audio") ?? Buffer.alloc(0);
        stub.asrRequests.push({
          wavBytes: audio.byteLength,
          riff: audio.subarray(0, 4).toString("latin1") === "RIFF",
          keyterms: (field(body, "keyterms")?.toString("utf8") ?? "").split(",").filter(Boolean),
          nbest: field(body, "nbest")?.toString("utf8") ?? "",
        });
        const step = stub.asr.shift() ?? { text: "" };
        if (step.status) {
          response.writeHead(step.status).end("failed");
          return;
        }
        const words = step.text.split(/\s+/).filter(Boolean);
        response.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            text: step.text,
            words: words.map((word, i) => ({ word, start: i * 0.3, end: i * 0.3 + 0.3, probability: 0.9 })),
            low_confidence_words: (step.unclear ?? []).map((word) => ({
              word,
              start: 0,
              end: 0.3,
              probability: 0.3,
            })),
            nbest: (step.nbest ?? [step.text]).map((text, i) => ({ text, score: -0.1 * (i + 1) })),
            duration_seconds: 1.5,
            processing_ms: 300,
            note: step.note ?? null,
          }),
        );
        return;
      }
      const { text } = JSON.parse(body.toString("utf8")) as { text: string };
      stub.ttsTexts.push(text);
      if (stub.ttsFails) {
        response.writeHead(500).end("tts failed");
        return;
      }
      response.writeHead(200, { "content-type": "audio/mpeg" }).end(fakeMp3(text));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return Object.assign(stub, {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  });
}
