import { describe, expect, it } from "vitest";
import { HttpError } from "../errors.js";
import { resolveAgentCompletionPolicyFromSettings } from "../services/agent-completion-policy.js";

const NOW = new Date("2026-07-11T10:00:00.000Z");

describe("resolveAgentCompletionPolicyFromSettings", () => {
  it("uses company default when no narrower setting exists", () => {
    expect(resolveAgentCompletionPolicyFromSettings({
      companyId: "company-1",
      companyDefault: "agent_can_complete",
      reviewGuardrail: false,
    }, NOW)).toMatchObject({
      policy: "agent_can_complete",
      source: "company",
      sourceId: "company-1",
      guardrailApplied: false,
      resolvedAt: NOW,
    });
  });

  it("resolves task over creator over project over company", () => {
    const base = {
      companyId: "company-1",
      companyDefault: "review_required" as const,
      reviewGuardrail: false,
      project: { id: "project-1", type: "project", policyDefault: "agent_can_complete" as const },
      creatorOverride: "review_required" as const,
      creatorSource: "routine" as const,
      creatorSourceId: "routine-1",
    };
    expect(resolveAgentCompletionPolicyFromSettings(base, NOW)).toMatchObject({
      policy: "review_required", source: "routine", sourceId: "routine-1",
    });
    expect(resolveAgentCompletionPolicyFromSettings({
      ...base,
      taskOverride: "agent_can_complete",
    }, NOW)).toMatchObject({
      policy: "agent_can_complete", source: "task", sourceId: null,
    });
  });

  it("records department provenance for a department scope", () => {
    expect(resolveAgentCompletionPolicyFromSettings({
      companyId: "company-1",
      companyDefault: "review_required",
      reviewGuardrail: false,
      project: { id: "department-1", type: "department", policyDefault: "agent_can_complete" },
    }, NOW)).toMatchObject({ source: "department", sourceId: "department-1" });
  });

  it("forces review_required when the company guardrail is active", () => {
    expect(resolveAgentCompletionPolicyFromSettings({
      companyId: "company-1",
      companyDefault: "agent_can_complete",
      reviewGuardrail: true,
      taskOverride: "agent_can_complete",
    }, NOW)).toMatchObject({
      policy: "review_required",
      source: "company",
      sourceId: "company-1",
      guardrailApplied: true,
    });
  });

  it("rejects creator overrides without auditable provenance", () => {
    expect(() => resolveAgentCompletionPolicyFromSettings({
      companyId: "company-1",
      companyDefault: "review_required",
      reviewGuardrail: false,
      creatorOverride: "agent_can_complete",
    }, NOW)).toThrow(HttpError);
  });
});
