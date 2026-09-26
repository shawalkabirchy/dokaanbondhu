import OpenAI from "openai";

// One adapter for every OpenAI-compatible endpoint (spec 13.3): vLLM on the pod, Cloudflare in development,
// DeepSeek and OpenAI as fallbacks. Always streaming, so "started to answer" is visible; tool-call deltas are
// accumulated into complete calls. The rest of the system never names a model.

export type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
export type ToolDef = OpenAI.Chat.Completions.ChatCompletionFunctionTool;

export interface LlmRequest {
  messages: ChatMessage[];
  tools?: ToolDef[];
  toolChoice?: "auto" | "none";
  temperature: number;
  maxTokens: number;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // JSON text, as the model wrote it
}

export type LlmDelta =
  | { type: "start" } // the first chunk arrived: the provider has started to answer
  | { type: "reasoning"; text: string } // a thinking model's reasoning, never shown or spoken
  | { type: "text"; text: string }
  | { type: "tool_calls"; calls: ToolCall[] }
  | { type: "finish"; reason: string | null };

export interface LlmProvider {
  id: string;
  external: boolean;
  stream(request: LlmRequest, signal: AbortSignal): AsyncIterable<LlmDelta>;
}

export interface OpenAiCompatibleConfig {
  id: string;
  external: boolean;
  baseUrl: string;
  model: string;
  apiKey: string;
  extraBody?: Record<string, unknown>; // options.extra_body, e.g. chat_template_kwargs
}

export function openAiCompatibleProvider(config: OpenAiCompatibleConfig): LlmProvider {
  const client = new OpenAI({ baseURL: config.baseUrl, apiKey: config.apiKey, maxRetries: 0 });
  return {
    id: config.id,
    external: config.external,
    async *stream(request, signal) {
      const stream = await client.chat.completions.create(
        {
          model: config.model,
          messages: request.messages,
          ...(request.tools?.length
            ? { tools: request.tools, tool_choice: request.toolChoice ?? "auto" }
            : {}),
          temperature: request.temperature,
          max_tokens: request.maxTokens,
          stream: true,
          ...config.extraBody,
        },
        { signal },
      );
      const calls = new Map<number, ToolCall>();
      let reason: string | null = null;
      let started = false;
      for await (const chunk of stream) {
        if (!started) {
          started = true;
          yield { type: "start" };
        }
        const choice = chunk.choices[0];
        if (!choice) continue;
        const delta = choice.delta as typeof choice.delta & {
          reasoning_content?: string;
          reasoning?: string;
        };
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (reasoning) yield { type: "reasoning", text: reasoning };
        if (delta.content) yield { type: "text", text: delta.content };
        for (const part of delta.tool_calls ?? []) {
          const call = calls.get(part.index) ?? { id: "", name: "", arguments: "" };
          if (part.id) call.id = part.id;
          if (part.function?.name) call.name += part.function.name;
          if (part.function?.arguments) call.arguments += part.function.arguments;
          calls.set(part.index, call);
        }
        if (choice.finish_reason) reason = choice.finish_reason;
      }
      if (calls.size > 0) {
        yield {
          type: "tool_calls",
          calls: [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call),
        };
      }
      yield { type: "finish", reason };
    },
  };
}
