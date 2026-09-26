import { AppError } from "@dokaanbondhu/core";
import { recordProviderCall } from "./health";
import type { LlmDelta, LlmProvider, LlmRequest } from "./llm";

// The LLM fallback chain (spec 13.3; architecture: fallback rules). The providers are tried in priority order, only
// the allowed ones. An attempt that has not started within 3 s is abandoned; the whole LLM step is capped at 8 s.
// Connection errors, 429 and 5xx move on at once. Once a provider has started, it is never switched mid-answer.

export interface FallbackOptions {
  startTimeoutMs?: number; // default 3000
  deadlineMs?: number; // default 8000
  onFallback?: (providerId: string, reason: string) => void; // logged into messages.meta.fallbacks
}

/** Nothing left to try: the turn ends with the fixed "cannot answer right now" message. */
export class NothingLeftError extends AppError {
  constructor() {
    super("ASSISTANT_UNAVAILABLE", 503, "errors.ASSISTANT_UNAVAILABLE");
  }
}

function reasonOf(error: unknown, signal: AbortSignal): string {
  if (signal.aborted) return signal.reason instanceof Error ? signal.reason.message : String(signal.reason);
  const status = (error as { status?: number }).status;
  if (typeof status === "number") return `http ${status}`;
  return error instanceof Error ? error.name : "error";
}

export async function* llmStream(
  providers: LlmProvider[],
  request: LlmRequest,
  options: FallbackOptions = {},
): AsyncIterable<LlmDelta & { providerId: string }> {
  const startTimeoutMs = options.startTimeoutMs ?? 3000;
  const deadline = Date.now() + (options.deadlineMs ?? 8000);
  for (const provider of providers) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const control = new AbortController();
    const startTimer = setTimeout(
      () => control.abort(new Error("no-start")),
      Math.min(startTimeoutMs, remaining),
    );
    const deadlineTimer = setTimeout(() => control.abort(new Error("deadline")), remaining);
    let started = false;
    try {
      for await (const delta of provider.stream(request, control.signal)) {
        if (control.signal.aborted) throw control.signal.reason;
        if (!started) {
          started = true;
          clearTimeout(startTimer);
          recordProviderCall("llm", true);
        }
        yield { ...delta, providerId: provider.id };
      }
      if (control.signal.aborted) throw control.signal.reason;
      return;
    } catch (error) {
      if (started) throw error; // never switch mid-answer
      options.onFallback?.(provider.id, reasonOf(error, control.signal));
    } finally {
      clearTimeout(startTimer);
      clearTimeout(deadlineTimer);
    }
  }
  recordProviderCall("llm", false);
  throw new NothingLeftError();
}
