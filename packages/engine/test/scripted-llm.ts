import type { LlmDelta, LlmProvider } from "../src/providers";

// The scripted LLM of the turn tests (spec 18.1): every call is known, the tool it chooses and the sentence it phrases.

export interface Step {
  text?: string;
  calls?: { name: string; arguments: Record<string, unknown> }[];
}

/** An LLM that answers from a script, one step per call, and fails the test when called beyond it. */
export function scripted(steps: Step[]): LlmProvider & { calls: number } {
  const llm = {
    id: "stub",
    external: false,
    calls: 0,
    async *stream(): AsyncIterable<LlmDelta> {
      const step = steps[llm.calls];
      llm.calls += 1;
      if (!step) throw new Error("the LLM was called more often than the script allows");
      yield { type: "start" };
      if (step.text) yield { type: "text", text: step.text };
      if (step.calls?.length) {
        yield {
          type: "tool_calls",
          calls: step.calls.map((call, index) => ({
            id: `call-${index}`,
            name: call.name,
            arguments: JSON.stringify(call.arguments),
          })),
        };
      }
      yield { type: "finish", reason: step.calls?.length ? "tool_calls" : "stop" };
    },
  };
  return llm;
}
