import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// An OpenAI-compatible stub LLM on a local port for the server's integration tests: each request is answered with
// the next scripted step as a streamed chat completion; with no step left it answers 500, which the fallback chain
// treats as a failed provider. The requests are kept, so a test can check what the server sent. The near-word clean-up
// call (D153) is answered "no change" apart from the script and kept in its own list.

export interface Step {
  text?: string;
  calls?: { name: string; arguments: Record<string, unknown> }[];
}

export interface ReceivedRequest {
  tools?: { function: { name: string } }[];
  stream?: boolean;
  messages: unknown[];
}

export interface StubLlm {
  script: Step[];
  received: ReceivedRequest[];
  /** The clean-up calls' messages; their answers come from `cleanups`, "no change" when it is empty. */
  cleanupRequests: ReceivedRequest[];
  cleanups: string[];
  baseUrl: string;
  close(): Promise<void>;
}

export async function startStubLlm(): Promise<StubLlm> {
  const script: Step[] = [];
  const received: ReceivedRequest[] = [];
  const cleanupRequests: ReceivedRequest[] = [];
  const cleanups: string[] = [];
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      const parsed = JSON.parse(body) as ReceivedRequest;
      const system = (parsed.messages[0] as { content?: unknown } | undefined)?.content;
      const cleanup = typeof system === "string" && system.startsWith("You correct speech-to-text mistakes");
      if (cleanup) cleanupRequests.push(parsed);
      else received.push(parsed);
      const step = cleanup ? { text: cleanups.shift() ?? '{"replaced":[]}' } : script.shift();
      if (!step) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "no scripted step" } }));
        return;
      }
      const base = { id: "stub", object: "chat.completion.chunk", created: 0, model: "stub" };
      const chunk = (delta: object, finish: string | null = null) => ({
        ...base,
        choices: [{ index: 0, delta, finish_reason: finish }],
      });
      const chunks = [chunk({ role: "assistant" })];
      if (step.text) chunks.push(chunk({ content: step.text }));
      step.calls?.forEach((call, index) =>
        chunks.push(
          chunk({
            tool_calls: [
              {
                index,
                id: `call_${index}`,
                type: "function",
                function: { name: call.name, arguments: JSON.stringify(call.arguments) },
              },
            ],
          }),
        ),
      );
      chunks.push(chunk({}, step.calls?.length ? "tool_calls" : "stop"));
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const item of chunks) response.write(`data: ${JSON.stringify(item)}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    script,
    cleanupRequests,
    cleanups,
    received,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
