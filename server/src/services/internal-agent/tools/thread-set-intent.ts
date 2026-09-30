// server/src/services/internal-agent/tools/thread-set-intent.ts
//
// Task C2 batch 1 — `thread.setIntent` (action tool).
// Validates against the THREAD_INTENTS enum from the shared package, then
// writes the array into discussions.intent (jsonb).

import { and, eq } from "drizzle-orm";
import { discussions } from "@armyofagents/db";
import { THREAD_INTENTS } from "@armyofagents/shared";
import type { AgentTool } from "../types.js";

export const threadSetIntentTool: AgentTool = {
  name: "thread.setIntent",
  description:
    "Set the intent classification on a thread (e.g. planning, research, problem, alignment).",
  parameters: {
    type: "object",
    properties: {
      threadId: { type: "string", description: "The thread (discussion) ID" },
      intent: {
        type: "array",
        items: { type: "string" },
        description:
          "One or more thread intents. Valid values: " +
          THREAD_INTENTS.join(", "),
      },
    },
    required: ["threadId", "intent"],
  },
  // category=action so any future capability-gated rollout is consistent with
  // other write tools. THREAD_INTENTS validation here is the primary gate.
  category: "action",
  requiredRole: "team_member",
  requiresConfirmation: false,
  async execute(params, ctx) {
    const { threadId, intent } = (params ?? {}) as {
      threadId?: string;
      intent?: unknown;
    };
    if (!threadId || typeof threadId !== "string") {
      return {
        success: false,
        data: null,
        summary: "threadId is required",
        error: "INVALID_PARAMS",
      };
    }
    if (!Array.isArray(intent)) {
      return {
        success: false,
        data: null,
        summary: "intent must be an array of strings",
        error: "INVALID_PARAMS",
      };
    }
    const stringIntent = intent.filter(
      (i): i is string => typeof i === "string",
    );
    const validValues = THREAD_INTENTS as readonly string[];
    const invalid = stringIntent.filter((i) => !validValues.includes(i));
    if (invalid.length > 0) {
      return {
        success: false,
        data: null,
        summary: `Invalid intent values: ${invalid.join(", ")}. Valid: ${THREAD_INTENTS.join(", ")}`,
        error: "INVALID_INTENT",
      };
    }
    const updated = await ctx.db
      .update(discussions)
      // jsonb column accepts arbitrary JSON; cast through any to satisfy the
      // strict Drizzle column type that expects the JSON pre-validated.
      .set({ intent: stringIntent as unknown as never })
      .where(and(eq(discussions.id, threadId), eq(discussions.companyId, ctx.companyId)))
      .returning({ id: discussions.id });
    if (!Array.isArray(updated) || updated.length === 0) {
      return { success: false, data: null, summary: "Thread not found", error: "NOT_FOUND" };
    }
    return {
      success: true,
      data: { threadId, intent: stringIntent },
      summary: `Intent set: ${stringIntent.join(", ") || "(empty)"}`,
    };
  },
};
