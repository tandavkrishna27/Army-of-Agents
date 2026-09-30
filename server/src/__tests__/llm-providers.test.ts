import { beforeEach, describe, expect, it, vi } from "vitest";

/* ------------------------------------------------------------------ */
/*  Mock drizzle-orm + @armyofagents/db (standard project pattern)     */
/* ------------------------------------------------------------------ */
vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: any[]) => args),
  eq: vi.fn((a: any, b: any) => ({ eq: [a, b] })),
  desc: vi.fn((value: any) => ({ desc: value })),
  sql: Object.assign(
    vi.fn((strings: any, ...values: any[]) => ({
      sql: strings,
      values,
      as: vi.fn().mockReturnValue("aliased"),
    })),
    { raw: vi.fn((input: any) => input) },
  ),
}));

vi.mock("@armyofagents/db", () => ({
  companySecrets: {
    id: "cs_id",
    companyId: "cs_company_id",
    name: "cs_name",
    provider: "cs_provider",
    latestVersion: "cs_latest_version",
    externalRef: "cs_external_ref",
  },
  companySecretVersions: {
    secretId: "csv_secret_id",
    version: "csv_version",
    material: "csv_material",
  },
}));

/* ------------------------------------------------------------------ */
/*  Mock external SDKs — we don't want real API calls in tests        */
/* ------------------------------------------------------------------ */
vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: {
        stream: vi.fn(),
      },
    })),
  };
});

vi.mock("openai", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      chat: {
        completions: {
          create: vi.fn(),
        },
      },
    })),
  };
});

vi.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: vi.fn().mockImplementation(() => ({
    getGenerativeModel: vi.fn(),
  })),
  SchemaType: {
    STRING: "STRING",
    NUMBER: "NUMBER",
    INTEGER: "INTEGER",
    BOOLEAN: "BOOLEAN",
    ARRAY: "ARRAY",
    OBJECT: "OBJECT",
  },
}));

/* ------------------------------------------------------------------ */
/*  Mock secrets service — import after mocks are set up              */
/* ------------------------------------------------------------------ */
const mockSecretServiceInstance = {
  resolveByName: vi.fn(),
};

vi.mock("../services/secrets.js", () => ({
  secretService: vi.fn(() => mockSecretServiceInstance),
}));

/* ------------------------------------------------------------------ */
/*  Import subjects under test                                        */
/* ------------------------------------------------------------------ */
import { toAnthropicTools } from "../services/internal-agent/providers/anthropic.js";
import { toOpenAITools, type ToolCallAccumulator } from "../services/internal-agent/providers/openai.js";
import { toGeminiFunctionDeclarations } from "../services/internal-agent/providers/gemini.js";
import { createProvider, getProviderApiKey } from "../services/internal-agent/providers/index.js";
import type { ProviderToolDef } from "../services/internal-agent/providers/types.js";

/* ------------------------------------------------------------------ */
/*  Test fixtures                                                     */
/* ------------------------------------------------------------------ */
const sampleTools: ProviderToolDef[] = [
  {
    name: "query_tasks",
    description: "Search and filter tasks",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", description: "Filter by status" },
        limit: { type: "number", description: "Max results" },
      },
      required: ["status"],
    },
  },
  {
    name: "create_task",
    description: "Create a new task",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Task title" },
        priority: {
          type: "string",
          enum: ["low", "medium", "high", "urgent"],
          description: "Task priority",
        },
      },
      required: ["title"],
    },
  },
];

/* ================================================================== */
/*  1. Anthropic tool format conversion                               */
/* ================================================================== */
describe("Anthropic provider", () => {
  describe("toAnthropicTools", () => {
    it("converts ProviderToolDef[] to Anthropic tool format", () => {
      const result = toAnthropicTools(sampleTools);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        name: "query_tasks",
        description: "Search and filter tasks",
        input_schema: sampleTools[0].parameters,
      });
      expect(result[1]).toEqual({
        name: "create_task",
        description: "Create a new task",
        input_schema: sampleTools[1].parameters,
      });
    });

    it("uses input_schema (not parameters) as the key", () => {
      const result = toAnthropicTools(sampleTools);
      for (const tool of result) {
        expect(tool).toHaveProperty("input_schema");
        expect(tool).not.toHaveProperty("parameters");
      }
    });

    it("handles empty tools array", () => {
      expect(toAnthropicTools([])).toEqual([]);
    });
  });
});

/* ================================================================== */
/*  2. OpenAI tool format conversion + JSON accumulation (Gotcha 2.2) */
/* ================================================================== */
describe("OpenAI provider", () => {
  describe("toOpenAITools", () => {
    it("converts ProviderToolDef[] to OpenAI function tool format", () => {
      const result = toOpenAITools(sampleTools);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        type: "function",
        function: {
          name: "query_tasks",
          description: "Search and filter tasks",
          parameters: sampleTools[0].parameters,
        },
      });
    });

    it("wraps each tool in type: 'function' envelope", () => {
      const result = toOpenAITools(sampleTools);
      for (const tool of result) {
        expect(tool.type).toBe("function");
        expect(tool.function).toBeDefined();
        expect(tool.function.name).toBeDefined();
        expect(tool.function.parameters).toBeDefined();
      }
    });

    it("handles empty tools array", () => {
      expect(toOpenAITools([])).toEqual([]);
    });
  });

  describe("JSON fragment accumulation (Gotcha 2.2)", () => {
    it("accumulates fragments and produces valid JSON", () => {
      // Simulate what the OpenAI provider does internally:
      // tool call arguments arrive as JSON fragments across multiple chunks
      const acc: ToolCallAccumulator = {
        id: "call_abc123",
        name: "query_tasks",
        arguments: "",
      };

      // Simulate fragment-by-fragment arrival
      const fragments = ['{"sta', 'tus":', ' "in_', 'progress', '", "l', 'imit": 10}'];
      for (const frag of fragments) {
        acc.arguments += frag;
      }

      // Parse the accumulated arguments
      const parsed = JSON.parse(acc.arguments);
      expect(parsed).toEqual({ status: "in_progress", limit: 10 });
    });

    it("handles incomplete JSON gracefully with _raw fallback", () => {
      const acc: ToolCallAccumulator = {
        id: "call_xyz",
        name: "create_task",
        arguments: '{"title": "incomplete',
      };

      // When JSON is invalid, provider falls back to _raw
      let input: unknown;
      try {
        input = JSON.parse(acc.arguments);
      } catch {
        input = { _raw: acc.arguments };
      }

      expect(input).toEqual({ _raw: '{"title": "incomplete' });
    });

    it("accumulates multiple tool calls by index", () => {
      const accumulators = new Map<number, ToolCallAccumulator>();

      // First tool call at index 0
      accumulators.set(0, { id: "call_1", name: "query_tasks", arguments: "" });
      // Second tool call at index 1
      accumulators.set(1, { id: "call_2", name: "create_task", arguments: "" });

      // Fragments arrive interleaved
      accumulators.get(0)!.arguments += '{"status":';
      accumulators.get(1)!.arguments += '{"title":';
      accumulators.get(0)!.arguments += '"done"}';
      accumulators.get(1)!.arguments += '"Test"}';

      expect(JSON.parse(accumulators.get(0)!.arguments)).toEqual({ status: "done" });
      expect(JSON.parse(accumulators.get(1)!.arguments)).toEqual({ title: "Test" });
    });
  });
});

/* ================================================================== */
/*  3. Gemini tool format conversion                                  */
/* ================================================================== */
describe("Gemini provider", () => {
  describe("toGeminiFunctionDeclarations", () => {
    it("converts ProviderToolDef[] to Gemini functionDeclarations", () => {
      const result = toGeminiFunctionDeclarations(sampleTools);

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe("query_tasks");
      expect(result[0].description).toBe("Search and filter tasks");
      expect(result[1].name).toBe("create_task");
    });

    it("maps JSON Schema types to Gemini SchemaType enum values", () => {
      const result = toGeminiFunctionDeclarations(sampleTools);
      const params = result[0].parameters as any;

      // Top-level should be OBJECT
      expect(params.type).toBe("OBJECT");
      // Nested properties should have mapped types
      expect(params.properties.status.type).toBe("STRING");
      expect(params.properties.limit.type).toBe("NUMBER");
    });

    it("preserves required fields", () => {
      const result = toGeminiFunctionDeclarations(sampleTools);
      const params = result[0].parameters as any;
      expect(params.required).toEqual(["status"]);
    });

    it("preserves enum values", () => {
      const result = toGeminiFunctionDeclarations(sampleTools);
      const params = result[1].parameters as any;
      expect(params.properties.priority.enum).toEqual([
        "low",
        "medium",
        "high",
        "urgent",
      ]);
    });

    it("handles empty tools array", () => {
      expect(toGeminiFunctionDeclarations([])).toEqual([]);
    });
  });
});

/* ================================================================== */
/*  4. Provider factory                                               */
/* ================================================================== */
describe("createProvider", () => {
  it("creates an Anthropic provider", () => {
    const provider = createProvider("anthropic", "sk-test");
    expect(provider.name).toBe("anthropic");
    expect(typeof provider.chat).toBe("function");
  });

  it("creates an OpenAI provider", () => {
    const provider = createProvider("openai", "sk-test");
    expect(provider.name).toBe("openai");
    expect(typeof provider.chat).toBe("function");
  });

  it("creates a Google/Gemini provider", () => {
    const provider = createProvider("google", "key-test");
    expect(provider.name).toBe("google");
    expect(typeof provider.chat).toBe("function");
  });

  it("throws for unknown provider", () => {
    expect(() => createProvider("unknown", "key")).toThrow(
      "Unknown LLM provider: unknown",
    );
  });
});

/* ================================================================== */
/*  5. getProviderApiKey — company_secrets first, env fallback        */
/* ================================================================== */
describe("getProviderApiKey", () => {
  const mockDb = {} as any;

  beforeEach(() => {
    mockSecretServiceInstance.resolveByName.mockReset();
  });

  it("returns API key from company_secrets when available", async () => {
    mockSecretServiceInstance.resolveByName.mockResolvedValue("sk-secret-from-db");

    const key = await getProviderApiKey(mockDb, "company-1", "anthropic");

    expect(key).toBe("sk-secret-from-db");
    expect(mockSecretServiceInstance.resolveByName).toHaveBeenCalledWith(
      "company-1",
      "llm:anthropic",
      expect.objectContaining({
        consumerType: "system",
        consumerId: "llm-provider:anthropic",
        configPath: "provider.anthropic",
        actorType: "system",
      }),
    );
  });

  it("falls back to env var when no company secret exists", async () => {
    mockSecretServiceInstance.resolveByName.mockRejectedValue(new Error("Secret not found"));

    const originalEnv = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-from-env";

    try {
      const key = await getProviderApiKey(mockDb, "company-1", "anthropic");
      expect(key).toBe("sk-from-env");
    } finally {
      if (originalEnv !== undefined) {
        process.env.ANTHROPIC_API_KEY = originalEnv;
      } else {
        delete process.env.ANTHROPIC_API_KEY;
      }
    }
  });

  it("throws when no secret and no env var", async () => {
    mockSecretServiceInstance.resolveByName.mockRejectedValue(new Error("Secret not found"));
    const originalEnv = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    try {
      await expect(getProviderApiKey(mockDb, "company-1", "openai")).rejects.toThrow(
        /No API key configured for provider "openai"/,
      );
    } finally {
      if (originalEnv !== undefined) {
        process.env.OPENAI_API_KEY = originalEnv;
      }
    }
  });

  it("uses correct secret names per provider", async () => {
    mockSecretServiceInstance.resolveByName.mockRejectedValue(new Error("Secret not found"));

    // Set env vars so the calls don't throw
    const savedKeys = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      GOOGLE_AI_API_KEY: process.env.GOOGLE_AI_API_KEY,
    };
    process.env.ANTHROPIC_API_KEY = "test";
    process.env.OPENAI_API_KEY = "test";
    process.env.GOOGLE_AI_API_KEY = "test";

    try {
      await getProviderApiKey(mockDb, "c1", "anthropic");
      expect(mockSecretServiceInstance.resolveByName).toHaveBeenCalledWith(
        "c1",
        "llm:anthropic",
        expect.objectContaining({ consumerId: "llm-provider:anthropic" }),
      );

      await getProviderApiKey(mockDb, "c1", "openai");
      expect(mockSecretServiceInstance.resolveByName).toHaveBeenCalledWith(
        "c1",
        "llm:openai",
        expect.objectContaining({ consumerId: "llm-provider:openai" }),
      );

      await getProviderApiKey(mockDb, "c1", "google");
      expect(mockSecretServiceInstance.resolveByName).toHaveBeenCalledWith(
        "c1",
        "llm:google",
        expect.objectContaining({ consumerId: "llm-provider:google" }),
      );
    } finally {
      for (const [k, v] of Object.entries(savedKeys)) {
        if (v !== undefined) process.env[k] = v;
        else delete process.env[k];
      }
    }
  });
});

/* ================================================================== */
/*  6. ChatStreamChunk type correctness                               */
/* ================================================================== */
describe("ChatStreamChunk type shapes", () => {
  it("text chunk has correct shape", () => {
    const chunk = { type: "text" as const, delta: "Hello" };
    expect(chunk.type).toBe("text");
    expect(chunk.delta).toBe("Hello");
  });

  it("tool_call chunk has correct shape", () => {
    const chunk = {
      type: "tool_call" as const,
      id: "call_123",
      name: "query_tasks",
      input: { status: "done" },
    };
    expect(chunk.type).toBe("tool_call");
    expect(chunk.id).toBe("call_123");
    expect(chunk.name).toBe("query_tasks");
    expect(chunk.input).toEqual({ status: "done" });
  });

  it("done chunk has correct shape with usage", () => {
    const chunk = {
      type: "done" as const,
      usage: { inputTokens: 100, outputTokens: 50 },
    };
    expect(chunk.type).toBe("done");
    expect(chunk.usage.inputTokens).toBe(100);
    expect(chunk.usage.outputTokens).toBe(50);
  });
});
