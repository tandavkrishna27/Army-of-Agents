import Anthropic from "@anthropic-ai/sdk";
import type {
  ChatParams,
  ChatStreamChunk,
  LLMProvider,
  ProviderToolDef,
} from "./types.js";

/** Convert AoA tool definitions to Anthropic's tool format */
export function toAnthropicTools(
  tools: ProviderToolDef[],
): Anthropic.Messages.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Messages.Tool.InputSchema,
  }));
}

export function createAnthropicProvider(apiKey: string): LLMProvider {
  const client = new Anthropic({ apiKey });

  return {
    name: "anthropic",

    async *chat(params: ChatParams): AsyncIterable<ChatStreamChunk> {
      const messages: Anthropic.Messages.MessageParam[] = params.messages
        .filter((m) => m.role !== "system")
        .map((m) => {
          if (m.toolResults && m.toolResults.length > 0) {
            return {
              role: "user" as const,
              content: m.toolResults.map((tr) => ({
                type: "tool_result" as const,
                tool_use_id: tr.toolCallId,
                content: tr.result,
              })),
            };
          }
          return {
            role: m.role as "user" | "assistant",
            content: m.content,
          };
        });

      const tools = toAnthropicTools(params.tools);

      const stream = client.messages.stream({
        model: params.model,
        max_tokens: params.maxTokens,
        system: params.systemPrompt,
        messages,
        ...(tools.length > 0 ? { tools } : {}),
      });

      let inputTokens = 0;
      let outputTokens = 0;

      for await (const event of stream) {
        if (event.type === "content_block_delta") {
          const delta = event.delta;
          if (delta.type === "text_delta") {
            yield { type: "text", delta: delta.text };
          }
          // input_json_delta is accumulated by the SDK; we handle tool_use at content_block_stop
        }

        if (event.type === "content_block_stop") {
          // Access the completed content block from the snapshot
          const snapshot = stream.currentMessage;
          if (snapshot) {
            const block = snapshot.content[event.index];
            if (block && block.type === "tool_use") {
              yield {
                type: "tool_call",
                id: block.id,
                name: block.name,
                input: block.input,
              };
            }
          }
        }

        if (event.type === "message_delta") {
          inputTokens = stream.currentMessage?.usage?.input_tokens ?? 0;
          outputTokens =
            (event.usage as Anthropic.Messages.MessageDeltaUsage)
              ?.output_tokens ?? 0;
        }
      }

      // Final usage from the completed message
      const finalMessage = await stream.finalMessage();
      yield {
        type: "done",
        usage: {
          inputTokens: finalMessage.usage.input_tokens,
          outputTokens: finalMessage.usage.output_tokens,
        },
      };
    },
  };
}
