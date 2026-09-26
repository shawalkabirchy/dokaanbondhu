import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { llmStream, NothingLeftError } from "./fallback";
import type { LlmDelta, LlmProvider, LlmRequest } from "./llm";

// Provider fallback with stub providers and fake timers (spec 13.3, 18.1).

const request: LlmRequest = { messages: [{ role: "user", content: "x" }], temperature: 0, maxTokens: 10 };

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });
}

/** A stub that waits `delayMs` before its first chunk, then sends `text` (or fails before or after starting). */
function stub(
  id: string,
  behaviour: { delayMs?: number; fail?: "before" | "after"; status?: number; text?: string },
) {
  const provider: LlmProvider & { calls: number } = {
    id,
    external: false,
    calls: 0,
    async *stream(_request, signal): AsyncIterable<LlmDelta> {
      provider.calls++;
      if (behaviour.fail === "before")
        throw Object.assign(new Error("upstream"), { status: behaviour.status ?? 503 });
      await sleep(behaviour.delayMs ?? 0, signal);
      yield { type: "start" };
      if (behaviour.fail === "after") throw new Error("stream broke");
      yield { type: "text", text: behaviour.text ?? id };
      yield { type: "finish", reason: "stop" };
    },
  };
  return provider;
}

async function collect(providers: LlmProvider[], fallbacks: string[] = []) {
  const texts: string[] = [];
  for await (const delta of llmStream(providers, request, {
    onFallback: (id, why) => fallbacks.push(`${id}:${why}`),
  })) {
    if (delta.type === "text") texts.push(`${delta.providerId}:${delta.text}`);
  }
  return texts;
}

describe("LLM fallback", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("uses the first provider that answers", async () => {
    const first = stub("gemma", { delayMs: 500 });
    const second = stub("deepseek", {});
    const run = collect([first, second]);
    await vi.advanceTimersByTimeAsync(600);
    expect(await run).toEqual(["gemma:gemma"]);
    expect(second.calls).toBe(0);
  });

  it("moves on at once after a 429 or 5xx", async () => {
    const fallbacks: string[] = [];
    const run = collect([stub("gemma", { fail: "before", status: 429 }), stub("deepseek", {})], fallbacks);
    await vi.advanceTimersByTimeAsync(10);
    expect(await run).toEqual(["deepseek:deepseek"]);
    expect(fallbacks).toEqual(["gemma:http 429"]);
  });

  it("abandons a provider that has not started within 3 s", async () => {
    const fallbacks: string[] = [];
    const run = collect([stub("gemma", { delayMs: 5000 }), stub("deepseek", { delayMs: 100 })], fallbacks);
    await vi.advanceTimersByTimeAsync(3200);
    expect(await run).toEqual(["deepseek:deepseek"]);
    expect(fallbacks).toEqual(["gemma:no-start"]);
  });

  it("never switches once a provider has started", async () => {
    const second = stub("deepseek", {});
    const run = collect([stub("gemma", { fail: "after" }), second]);
    const settled = expect(run).rejects.toThrow("stream broke");
    await vi.advanceTimersByTimeAsync(10);
    await settled;
    expect(second.calls).toBe(0);
  });

  it("stops at the 8 s cap and when nothing is left", async () => {
    const slow = [stub("a", { delayMs: 9000 }), stub("b", { delayMs: 9000 }), stub("c", { delayMs: 9000 })];
    const run = collect(slow);
    const settled = expect(run).rejects.toBeInstanceOf(NothingLeftError);
    await vi.advanceTimersByTimeAsync(8000); // a and b use 3 s each; c gets the 2 s that are left
    await settled;
    expect(slow.map((provider) => provider.calls)).toEqual([1, 1, 1]);
  });

  it("ends with ASSISTANT_UNAVAILABLE when every provider fails", async () => {
    const run = collect([stub("a", { fail: "before" }), stub("b", { fail: "before" })]);
    await expect(run).rejects.toMatchObject({ code: "ASSISTANT_UNAVAILABLE", httpStatus: 503 });
  });
});
