/**
 * Provider abstraction layer for LLM providers (Anthropic, OpenAI, Google).
 *
 * All providers normalize to a common streaming interface so the agent loop
 * can consume responses uniformly regardless of which LLM is backing it.
 */

/**
 * Message roles understood by all providers.
 *
 * Note: "system" role messages in the messages array are ignored by all providers.
 * Use ChatParams.systemPrompt instead — it maps to each provider's native system
 * prompt mechanism (Anthropic: `system` param, OpenAI: system message, Gemini: systemInstruction).
 */
export type ChatMessageRole = "user" | "assistant" | "system";

/** A single message in the conversation */
export interface ChatMessage {
  role: ChatMessageRole;
  content: string;
  /** Tool results to feed back after a tool_call chunk */
  toolResults?: ToolResultMessage[];
  /** Tool calls from assistant (for conversation history reconstruction) */
  toolCalls?: { id: string; name: string; input: unknown }[];
}

/** Result of a tool execution, sent back to the LLM */
export interface ToolResultMessage {
  toolCallId: string;
  name: string;
  result: string;
}

/** Provider-agnostic tool definition (AoA internal format) */
export interface ProviderToolDef {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** Parameters for a chat request */
export interface ChatParams {
  messages: ChatMessage[];
  tools: ProviderToolDef[];
  model: string;
  maxTokens: number;
  systemPrompt: string;
}

/** Normalized streaming chunk emitted by all providers */
export type ChatStreamChunk =
  | { type: "text"; delta: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "done"; usage: { inputTokens: number; outputTokens: number } };

/** Interface every LLM provider must implement */
export interface LLMProvider {
  /** Provider identifier (e.g. 'anthropic', 'openai', 'google') */
  name: string;
  /** Stream a chat completion, yielding normalized chunks */
  chat(params: ChatParams): AsyncIterable<ChatStreamChunk>;
}
