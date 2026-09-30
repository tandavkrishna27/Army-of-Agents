import { describe, expect, it } from "vitest";
import { runtimeDecisionDetailSchema } from "../validators/hub.js";

function baseDetail() {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    hubItemId: null,
    companyId: "00000000-0000-0000-0000-0000000000c1",
    agentId: "00000000-0000-0000-0000-0000000000b1",
    runId: "00000000-0000-0000-0000-0000000000d1",
    adapterType: "claude_local",
    adapterSessionId: null,
    kind: "work_question" as const,
    status: "shown" as const,
    sourceRevision: 0,
    nonce: "nonce-1",
    title: "Pick a segment",
    summary: null,
    promptText: "Which segment?",
    toolName: null,
    command: null,
    cwd: null,
    path: null,
    networkTarget: null,
    riskClass: null,
    timeoutPolicy: "park_run" as const,
    expiresAt: null,
    answeredAt: null,
    relayedAt: null,
    relayError: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

describe("runtimeDecisionDetailSchema.options", () => {
  it("accepts options carrying optional description + rationale (typed)", () => {
    const parsed = runtimeDecisionDetailSchema.parse({
      ...baseDetail(),
      options: [
        {
          label: "SaaS",
          value: "saas",
          description: "Founder-led teams.",
          rationale: "Highest WTP.",
        },
      ],
    });
    expect(parsed.options?.[0].description).toBe("Founder-led teams.");
    expect(parsed.options?.[0].rationale).toBe("Highest WTP.");
  });

  it("still accepts label/value-only options (backward compatible)", () => {
    const parsed = runtimeDecisionDetailSchema.parse({
      ...baseDetail(),
      options: [{ label: "Agencies", value: "agencies" }],
    });
    expect(parsed.options?.[0].label).toBe("Agencies");
    expect(parsed.options?.[0].description).toBeUndefined();
  });
});
