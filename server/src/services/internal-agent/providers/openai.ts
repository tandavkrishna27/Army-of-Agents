import OpenAI from "openai";
import type {
  ChatParams,
  ChatStreamChunk,
  LLMProvider,
  ProviderToolDef,
} from "./types.js";

/** Convert AoA tool definitions to OpenAI's function tool format */
export function toOpenAITools(
  tools: ProviderToolDef[],
): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/**
 * Accumulates streamed JSON fragments for OpenAI tool call arguments.
 *
 * Gotcha 2.2: OpenAI streams tool call arguments as JSON fragments that must
 * be accumulated before parsing. We buffer per tool-call index and only parse
 * when the stream signals completion (finish_reason: 'tool_calls').
 */
export interface ToolCallAccumulator {
  id: string;
  name: string;
  arguments: string;
}

export function createOpenAIProvider(apiKey: string): LLMProvider {
  const client = new OpenAI({ apiKey });

  return {
    name: "openai",

    async *chat(params: ChatParams): AsyncIterable<ChatStreamChunk> {
      const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

      // System prompt as first message
      if (params.systemPrompt) {
        messages.push({ role: "system", content: params.systemPrompt });
      }

      for (const m of params.messages) {
        if (m.role === "system") continue;

        if (m.toolResults && m.toolResults.length > 0) {
          for (const tr of m.toolResults) {
            messages.push({
              role: "tool",
              tool_call_id: tr.toolCallId,
              content: tr.result,
            });
          }
          continue;
        }

        messages.push({
          role: m.role as "user" | "assistant",
          content: m.content,
        });
      }

      const tools = toOpenAITools(params.tools);

      const stream = await client.chat.completions.create({
        model: params.model,
        max_tokens: params.maxTokens,
        messages,
        ...(tools.length > 0 ? { tools } : {}),
        stream: true,
        stream_options: { include_usage: true },
      });

      // Gotcha 2.2: accumulate tool call argument fragments per index
      const accumulators = new Map<number, ToolCallAccumulator>();
      let inputTokens = 0;
      let outputTokens = 0;

      for await (const chunk of stream) {
        const choice = chunk.choices?.[0];

        if (choice) {
          const delta = choice.delta;

          // Text content
          if (delta?.content) {
            yield { type: "text", delta: delta.content };
          }

          // Tool call deltas — accumulate fragments
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              let acc = accumulators.get(tc.index);
              if (!acc) {
                acc = {
                  id: tc.id ?? "",
                  name: tc.function?.name ?? "",
                  arguments: "",
                };
                accumulators.set(tc.index, acc);
              }
              if (tc.id) acc.id = tc.id;
              if (tc.function?.name) acc.name = tc.function.name;
              if (tc.function?.arguments) acc.arguments += tc.function.arguments;
            }
          }

          // When finish_reason indicates tool_calls, parse and emit accumulated calls
          if (choice.finish_reason === "tool_calls") {
            for (const [, acc] of accumulators) {
              let input: unknown;
              try {
                input = JSON.parse(acc.arguments);
              } catch {
                input = { _raw: acc.arguments };
              }
              yield {
                type: "tool_call",
                id: acc.id,
                name: acc.name,
                input,
              };
            }
            accumulators.clear();
          }
        }

        // Usage is sent in the final chunk (with stream_options.include_usage)
        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens ?? 0;
          outputTokens = chunk.usage.completion_tokens ?? 0;
        }
      }

      yield {
        type: "done",
        usage: { inputTokens, outputTokens },
      };
    },
  };
}
