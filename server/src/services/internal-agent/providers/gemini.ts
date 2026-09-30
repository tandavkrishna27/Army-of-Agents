import {
  GoogleGenerativeAI,
  type FunctionDeclaration,
  type FunctionDeclarationSchemaProperty,
  SchemaType,
  type Content,
  type Part,
} from "@google/generative-ai";
import type {
  ChatParams,
  ChatStreamChunk,
  LLMProvider,
  ProviderToolDef,
} from "./types.js";

/**
 * Map JSON Schema type strings to Gemini's SchemaType enum.
 * Gemini requires its own enum values rather than plain strings.
 */
function mapSchemaType(type: string): SchemaType {
  switch (type) {
    case "string":
      return SchemaType.STRING;
    case "number":
      return SchemaType.NUMBER;
    case "integer":
      return SchemaType.INTEGER;
    case "boolean":
      return SchemaType.BOOLEAN;
    case "array":
      return SchemaType.ARRAY;
    case "object":
      return SchemaType.OBJECT;
    default:
      return SchemaType.STRING;
  }
}

/** Recursively convert a JSON Schema property to Gemini's schema format */
function convertProperty(prop: Record<string, unknown>): FunctionDeclarationSchemaProperty {
  const result: Record<string, unknown> = {
    type: mapSchemaType((prop.type as string) ?? "string"),
  };
  if (prop.description) result.description = prop.description;
  if (prop.enum) result.enum = prop.enum;
  if (prop.properties) {
    const converted: Record<string, FunctionDeclarationSchemaProperty> = {};
    for (const [k, v] of Object.entries(prop.properties as Record<string, unknown>)) {
      converted[k] = convertProperty(v as Record<string, unknown>);
    }
    result.properties = converted;
  }
  if (prop.items) {
    result.items = convertProperty(prop.items as Record<string, unknown>);
  }
  if (prop.required) result.required = prop.required;
  return result as unknown as FunctionDeclarationSchemaProperty;
}

/** Convert AoA tool definitions to Gemini's functionDeclarations format */
export function toGeminiFunctionDeclarations(
  tools: ProviderToolDef[],
): FunctionDeclaration[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: convertProperty(t.parameters) as FunctionDeclaration["parameters"],
  }));
}

let toolCallCounter = 0;

export function createGeminiProvider(apiKey: string): LLMProvider {
  const genAI = new GoogleGenerativeAI(apiKey);

  return {
    name: "google",

    async *chat(params: ChatParams): AsyncIterable<ChatStreamChunk> {
      const model = genAI.getGenerativeModel({ model: params.model });

      // Build Gemini contents from messages
      const contents: Content[] = [];

      for (const m of params.messages) {
        if (m.role === "system") continue;

        if (m.toolResults && m.toolResults.length > 0) {
          const parts: Part[] = m.toolResults.map((tr) => ({
            functionResponse: {
              name: tr.name,
              response: safeJsonParse(tr.result),
            },
          }));
          contents.push({ role: "function", parts });
          continue;
        }

        contents.push({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        });
      }

      const tools = toGeminiFunctionDeclarations(params.tools);

      const chat = model.startChat({
        history: contents.slice(0, -1),
        ...(tools.length > 0
          ? { tools: [{ functionDeclarations: tools }] }
          : {}),
        generationConfig: {
          maxOutputTokens: params.maxTokens,
        },
        systemInstruction: params.systemPrompt
          ? { role: "user", parts: [{ text: params.systemPrompt }] }
          : undefined,
      });

      // Get the last user message to send
      const lastContent = contents[contents.length - 1];
      const lastParts = lastContent?.parts ?? [{ text: "" }];

      const result = await chat.sendMessageStream(lastParts);

      let inputTokens = 0;
      let outputTokens = 0;

      for await (const chunk of result.stream) {
        const candidate = chunk.candidates?.[0];
        if (candidate) {
          for (const part of candidate.content?.parts ?? []) {
            if (part.text) {
              yield { type: "text", delta: part.text };
            }
            if (part.functionCall) {
              yield {
                type: "tool_call",
                id: `gemini_${part.functionCall.name}_${++toolCallCounter}`,
                name: part.functionCall.name,
                input: part.functionCall.args ?? {},
              };
            }
          }
        }

        // Token usage from usageMetadata
        if (chunk.usageMetadata) {
          inputTokens = chunk.usageMetadata.promptTokenCount ?? 0;
          outputTokens = chunk.usageMetadata.candidatesTokenCount ?? 0;
        }
      }

      yield {
        type: "done",
        usage: { inputTokens, outputTokens },
      };
    },
  };
}

function safeJsonParse(str: string): Record<string, unknown> {
  try {
    return JSON.parse(str);
  } catch {
    return { result: str };
  }
}
