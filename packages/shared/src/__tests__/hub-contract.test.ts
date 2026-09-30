// packages/shared/src/__tests__/hub-contract.test.ts
import { describe, it, expect } from "vitest";
import {
  HUB_AUTOPILOT_ACTIONS,
  HUB_AUTOPILOT_MODES,
  HUB_LANES,
  HUB_ITEM_STATUSES,
  HUB_DENSITIES,
  HUB_GROUP_MODES,
  HUB_LANDING_TARGETS,
  HUB_SEMANTIC_TYPES,
  HUB_SEMANTIC_TO_LANE,
  HUB_AUTHORITY_BY_TYPE,
  HUB_SOURCE_MIRRORED_TYPES,
  RUNTIME_DECISION_KINDS,
  RUNTIME_DECISION_STATUSES,
  RUNTIME_DECISION_PERMISSION_DECISIONS,
  RUNTIME_DECISION_TIMEOUT_POLICIES,
  laneForSemanticType,
  authorityForSemanticType,
  isSourceMirroredType,
} from "../hub.js";
import {
  runtimeDecisionAnswerSchema,
  runtimeDecisionDetailSchema,
  hubActionSchema,
  hubAutopilotPolicySchema,
  hubBulkActionSchema,
  hubCurationMetadataSchema,
  updateHubAutopilotPolicySchema,
  hubListResponseSchema,
  hubPreferencesSchema,
  hubUserStateSchema,
  listHubItemsQuery,
  updateHubPreferencesSchema,
} from "../validators/hub.js";

describe("hub contract", () => {
  it("every semantic type maps to exactly one valid lane", () => {
    for (const t of HUB_SEMANTIC_TYPES) {
      const lane = HUB_SEMANTIC_TO_LANE[t];
      expect(HUB_LANES, `${t} -> ${lane}`).toContain(lane);
      expect(laneForSemanticType(t)).toBe(lane);
    }
  });
  it("reserves the W5 runtime-decision type without a UI bridge yet", () => {
    // W5 reserve-don't-build boundary: the runtime-decision type exists in the
    // contract, lands in the "waiting_on_you" lane, and is gated to founder
    // authority — but W1a ships NO adapter bridge for it (master scope §10/§18).
    expect(HUB_SEMANTIC_TYPES).toContain("agent_runtime_decision");
    expect(HUB_SEMANTIC_TO_LANE.agent_runtime_decision).toBe("waiting_on_you");
    expect(HUB_AUTHORITY_BY_TYPE.agent_runtime_decision).toBe("founder");
    expect(authorityForSemanticType("agent_runtime_decision")).toBe("founder");
  });
  it("exports W5 runtime decision lifecycle constants", () => {
    expect(RUNTIME_DECISION_KINDS).toEqual(["permission", "work_question"]);
    expect(RUNTIME_DECISION_STATUSES).toEqual([
      "created",
      "shown",
      "answered",
      "relayed",
      "expired",
      "cancelled",
      "relay_failed",
    ]);
    expect(RUNTIME_DECISION_PERMISSION_DECISIONS).toEqual([
      "allow_once",
      "allow_run",
      "allow_always",
      "deny",
    ]);
    expect(RUNTIME_DECISION_TIMEOUT_POLICIES).toEqual([
      "deny",
      "cancel_run",
      "park_run",
      "continue_with_default",
      "escalate",
    ]);
  });
  it("accepts W5 runtime permission answers with nonce and source revision binding", () => {
    const parsed = runtimeDecisionAnswerSchema.parse({
      kind: "permission",
      decision: "allow_once",
      expectedSourceRevision: 3,
      nonce: "nonce-abc",
      idempotencyKey: "answer-1",
    });

    expect(parsed).toMatchObject({
      kind: "permission",
      decision: "allow_once",
      expectedSourceRevision: 3,
      nonce: "nonce-abc",
    });
  });
  it("accepts W5 runtime work-question answers and rejects implicit deny", () => {
    const parsed = runtimeDecisionAnswerSchema.parse({
      kind: "work_question",
      answer: { value: "monthly" },
      expectedSourceRevision: 4,
      nonce: "nonce-question",
    });

    expect(parsed.kind).toBe("work_question");
    if (parsed.kind === "work_question") {
      expect(parsed.answer).toEqual({ value: "monthly" });
    }

    expect(() =>
      runtimeDecisionAnswerSchema.parse({
        kind: "work_question",
        decision: "deny",
        expectedSourceRevision: 4,
        nonce: "nonce-question",
      }),
    ).toThrow();
  });
  it("accepts bounded W5 runtime decision detail payloads for the hub viewer", () => {
    const parsed = runtimeDecisionDetailSchema.parse({
      id: "550e8400-e29b-41d4-a716-446655440010",
      hubItemId: "550e8400-e29b-41d4-a716-446655440011",
      companyId: "550e8400-e29b-41d4-a716-446655440012",
      agentId: "550e8400-e29b-41d4-a716-446655440013",
      runId: "550e8400-e29b-41d4-a716-446655440014",
      adapterType: "claude_local",
      adapterSessionId: null,
      kind: "permission",
      status: "shown",
      sourceRevision: 2,
      nonce: "nonce-detail",
      title: "Allow shell command?",
      summary: "Agent wants to run a test command.",
      promptText: "pnpm test:run",
      toolName: "shell",
      command: "pnpm test:run",
      cwd: "C:/repo",
      path: null,
      networkTarget: null,
      riskClass: "medium",
      allowRunEligible: false,
      allowRunReason: "Run access is unavailable for shell actions.",
      options: null,
      timeoutPolicy: "deny",
      expiresAt: "2026-07-01T12:00:00.000Z",
      answeredAt: null,
      relayedAt: null,
      relayError: null,
      createdAt: "2026-07-01T11:45:00.000Z",
      updatedAt: "2026-07-01T11:45:00.000Z",
    });

    expect(parsed.kind).toBe("permission");
    expect(parsed.status).toBe("shown");
  });
  it("statuses are the three terminal-distinct lifecycle states + open", () => {
    expect(HUB_ITEM_STATUSES).toEqual(["open", "snoozed", "resolved", "archived"]);
  });
  it("every semantic type has an authority (HUB_AUTHORITY_BY_TYPE is total)", () => {
    for (const t of HUB_SEMANTIC_TYPES) {
      const authority = HUB_AUTHORITY_BY_TYPE[t];
      expect(["founder", "owner"], `${t} -> ${authority}`).toContain(authority);
      expect(authorityForSemanticType(t)).toBe(authority);
    }
  });
  it("approval_request requires founder authority", () => {
    expect(authorityForSemanticType("approval_request")).toBe("founder");
  });
  it("treats durable work questions as source-owned Inbox mirrors", () => {
    expect(HUB_SOURCE_MIRRORED_TYPES).toContain("work_question");
    expect(isSourceMirroredType("work_question")).toBe(true);
  });
  it("memory_review is a known semantic type", () => {
    expect(HUB_SEMANTIC_TYPES).toContain("memory_review");
  });
  it("memory_review lives in the waiting_on_you lane, beside discussion_pending", () => {
    expect(laneForSemanticType("memory_review")).toBe("waiting_on_you");
    expect(laneForSemanticType("discussion_pending")).toBe("waiting_on_you");
  });
  it("memory_review shares discussion_pending's owner authority (not founder-gated)", () => {
    expect(authorityForSemanticType("memory_review")).toBe(
      authorityForSemanticType("discussion_pending"),
    );
    expect(authorityForSemanticType("memory_review")).toBe("owner");
  });
  it("list query limit defaults to 50 and caps at 50", () => {
    expect(listHubItemsQuery.parse({}).limit).toBe(50);
    expect(listHubItemsQuery.parse({ limit: "25" }).limit).toBe(25);
    expect(() => listHubItemsQuery.parse({ limit: "51" })).toThrow();
  });
  it("list query parses includeSnoozed query booleans", () => {
    expect(listHubItemsQuery.parse({}).includeSnoozed).toBe(false);
    expect(listHubItemsQuery.parse({ includeSnoozed: "true" }).includeSnoozed).toBe(true);
    expect(listHubItemsQuery.parse({ includeSnoozed: "1" }).includeSnoozed).toBe(true);
    expect(listHubItemsQuery.parse({ includeSnoozed: "false" }).includeSnoozed).toBe(false);
    expect(listHubItemsQuery.parse({ includeSnoozed: "0" }).includeSnoozed).toBe(false);
  });
  it("accepts W1d search, cursor, and group mode list query params", () => {
    expect(
      listHubItemsQuery.parse({
        lane: "waiting_on_you",
        status: "open",
        q: "approval deployment",
        cursor: "eyJjcmVhdGVkQXQiOiIyMDI2LTA2LTMwVDAwOjAwOjAwLjAwMFoiLCJpZCI6ImgifQ",
        groupMode: "auto",
        limit: "25",
      }),
    ).toMatchObject({
      lane: "waiting_on_you",
      status: "open",
      q: "approval deployment",
      groupMode: "auto",
      limit: 25,
    });
  });
  it("trims empty W1d search strings out of list query params", () => {
    expect(listHubItemsQuery.parse({ q: "   " }).q).toBeUndefined();
  });
  it("exports W1d preference constants", () => {
    expect(HUB_LANDING_TARGETS).toEqual([
      "home",
      "waiting_on_you",
      "notifications",
      "suggestions",
    ]);
    expect(HUB_GROUP_MODES).toEqual(["auto", "source", "scope", "type", "none"]);
    expect(HUB_DENSITIES).toEqual(["comfortable", "compact"]);
  });
  it("accepts default hub preference payloads", () => {
    expect(
      hubPreferencesSchema.parse({
        defaultLanding: "home",
        visibleLanes: ["waiting_on_you", "notifications", "suggestions"],
        groupMode: "auto",
        density: "comfortable",
        showAutopilotEntry: true,
        updatedAt: null,
      }),
    ).toMatchObject({
      defaultLanding: "home",
      visibleLanes: ["waiting_on_you", "notifications", "suggestions"],
      groupMode: "auto",
      density: "comfortable",
      showAutopilotEntry: true,
      updatedAt: null,
    });
  });
  it("accepts W1d list response envelopes with group metadata", () => {
    expect(
      hubListResponseSchema.parse({
        items: [
          {
            id: "hub-1",
            title: "Deploy approval",
            groupKey: "source:approval",
            groupLabel: "approval",
            groupCount: null,
            scopeKey: null,
            slaAt: null,
          },
        ],
        nextCursor: "cursor-1",
        totalKnown: null,
      }),
    ).toMatchObject({
      items: [
        {
          id: "hub-1",
          groupKey: "source:approval",
          groupLabel: "approval",
          groupCount: null,
        },
      ],
      nextCursor: "cursor-1",
      totalKnown: null,
    });
  });
  it("accepts bounded W4 curation metadata without changing the semantic type contract", () => {
    const parsed = hubCurationMetadataSchema.parse({
      curationGroupLabel: "Failed runs",
      curationGroupSummary: "3 failed runs need review.",
      curationReason: "Grouped by source and scope.",
      curationPriorityReason: "Urgent because SLA is within 30 minutes.",
      curationRevision: 2,
      curatedAt: "2026-07-01T10:00:00.000Z",
      curatedByAgentId: "550e8400-e29b-41d4-a716-446655440000",
    });

    expect(parsed.curationRevision).toBe(2);
    expect(HUB_SEMANTIC_TYPES).not.toContain("steward_curation");
  });
  it("rejects unbounded W4 curation explanation text", () => {
    expect(() =>
      hubCurationMetadataSchema.parse({
        curationGroupLabel: "A".repeat(121),
        curationGroupSummary: null,
        curationReason: null,
        curationPriorityReason: null,
        curationRevision: 0,
        curatedAt: null,
        curatedByAgentId: null,
      }),
    ).toThrow();
    expect(() =>
      hubCurationMetadataSchema.parse({
        curationGroupLabel: null,
        curationGroupSummary: "B".repeat(501),
        curationReason: null,
        curationPriorityReason: null,
        curationRevision: 0,
        curatedAt: null,
        curatedByAgentId: null,
      }),
    ).toThrow();
  });
  it("rejects empty visible lane preferences", () => {
    expect(() =>
      updateHubPreferencesSchema.parse({ visibleLanes: [] }),
    ).toThrow();
  });
  it("rejects duplicate visible lane preferences", () => {
    expect(() =>
      updateHubPreferencesSchema.parse({
        visibleLanes: ["waiting_on_you", "waiting_on_you"],
      }),
    ).toThrow();
  });
  it("lifecycle action schema accepts named shared actions and rejects client-chosen nextStatus", () => {
    for (const action of ["resolve", "archive", "claim", "release"]) {
      expect(
        hubActionSchema.parse({
          action,
          expectedVersion: 2,
          idempotencyKey: `${action}-key`,
          reason: "because",
        }).action,
      ).toBe(action);
    }

    expect(() =>
      hubActionSchema.parse({
        action: "resolve",
        expectedVersion: 2,
        nextStatus: "archived",
      }),
    ).toThrow();
    expect(() =>
      hubActionSchema.parse({
        action: "dismiss",
        expectedVersion: 2,
      }),
    ).toThrow();
  });
  it("user state schema accepts all W1c personal-state actions", () => {
    expect(hubUserStateSchema.parse({ kind: "read" }).kind).toBe("read");
    expect(hubUserStateSchema.parse({ kind: "unread" }).kind).toBe("unread");
    expect(hubUserStateSchema.parse({ kind: "snooze", until: "2026-06-29T10:00:00.000Z" }).kind).toBe("snooze");
    expect(hubUserStateSchema.parse({ kind: "unsnooze" }).kind).toBe("unsnooze");
    expect(hubUserStateSchema.parse({ kind: "dismiss" }).kind).toBe("dismiss");
    expect(hubUserStateSchema.parse({ kind: "undismiss" }).kind).toBe("undismiss");
  });
  it("bulk action schema accepts mixed shared and personal actions with per-item requirements", () => {
    const parsed = hubBulkActionSchema.parse({
      bulkId: "bulk-1",
      items: [
        { id: "550e8400-e29b-41d4-a716-446655440001", action: "resolve", expectedVersion: 1 },
        { id: "550e8400-e29b-41d4-a716-446655440002", action: "dismiss" },
        { id: "550e8400-e29b-41d4-a716-446655440003", action: "snooze", until: "2026-06-29T10:00:00.000Z" },
        { id: "550e8400-e29b-41d4-a716-446655440004", action: "claim", expectedVersion: 0, reason: "taking it" },
      ],
    });
    expect(parsed.items).toHaveLength(4);

    expect(() =>
      hubBulkActionSchema.parse({
        items: [{ id: "550e8400-e29b-41d4-a716-446655440003", action: "snooze" }],
      }),
    ).toThrow();
    expect(() =>
      hubBulkActionSchema.parse({
        items: [{ id: "550e8400-e29b-41d4-a716-446655440001", action: "resolve" }],
      }),
    ).toThrow();
  });
  it("exposes W3 autopilot modes and actions", () => {
    expect(HUB_AUTOPILOT_MODES).toEqual(["off", "assist", "drive"]);
    expect(HUB_AUTOPILOT_ACTIONS).toEqual(["none", "resolve", "archive"]);
  });
  it("accepts a company autopilot policy with category rules", () => {
    const parsed = hubAutopilotPolicySchema.parse({
      mode: "assist",
      handledToday: 0,
      lastHandledAt: null,
      rules: [
        {
          semanticType: "run_complete",
          action: "resolve",
          minTrustScore: 80,
          enabled: true,
        },
      ],
      updatedAt: null,
    });

    expect(parsed.rules[0].semanticType).toBe("run_complete");
  });
  it("rejects autopilot auto-handle for founder-gated categories in W3 core", () => {
    expect(() =>
      updateHubAutopilotPolicySchema.parse({
        rules: [
          {
            semanticType: "approval_request",
            action: "resolve",
            minTrustScore: 80,
            enabled: true,
          },
        ],
      }),
    ).toThrow();
  });
  it("rejects duplicate autopilot semantic type rules", () => {
    expect(() =>
      updateHubAutopilotPolicySchema.parse({
        rules: [
          { semanticType: "run_complete", action: "resolve", minTrustScore: 80, enabled: true },
          { semanticType: "run_complete", action: "archive", minTrustScore: 90, enabled: true },
        ],
      }),
    ).toThrow();
  });
  it("has explicit autopilot rule coverage for every hub semantic type", () => {
    const covered = new Set(
      hubAutopilotPolicySchema.parse({
        mode: "off",
        handledToday: 0,
        lastHandledAt: null,
        rules: HUB_SEMANTIC_TYPES.map((semanticType) => ({
          semanticType,
          action: "none",
          minTrustScore: 100,
          enabled: false,
        })),
        updatedAt: null,
      }).rules.map((rule) => rule.semanticType),
    );

    expect(covered.size).toBe(HUB_SEMANTIC_TYPES.length);
  });
});
