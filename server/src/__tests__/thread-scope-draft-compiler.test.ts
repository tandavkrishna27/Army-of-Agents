import { describe, expect, it } from "vitest";
import { compileThreadScopeDraft } from "../services/thread-scope-draft-compiler.js";

describe("compileThreadScopeDraft", () => {
  it("synthesizes one scope package from the full entry range", () => {
    const result = compileThreadScopeDraft({
      threadTitle: "Scope cycle test",
      summaryText: "Scope extraction requirements discussion.",
      entries: [
        {
          id: "entry-1",
          seq: 1,
          inputType: "write",
          rawContent: "Scope should be deliberate, not automatic per message.",
        },
        {
          id: "entry-2",
          seq: 2,
          inputType: "write",
          rawContent:
            "After accepted scope v1, new discussion should produce v2 unless we explicitly rescope old decisions.",
        },
        {
          id: "entry-3",
          seq: 3,
          inputType: "write",
          rawContent:
            "Memory must be retrievable by agents during task execution, with department, artifact, and evidence links.",
        },
      ],
      extractedItems: [],
    });

    expect(result.summary).toContain("deliberate");
    expect(result.summary).toContain("v2");
    expect(result.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: expect.stringMatching(/versioned scope/i),
          sourceEntryIds: expect.arrayContaining(["entry-2"]),
        }),
      ]),
    );
    expect(result.openQuestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: expect.stringMatching(/memory retrieval/i),
          sourceEntryIds: expect.arrayContaining(["entry-3"]),
        }),
      ]),
    );
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "task_proposal",
          // W2: derived from the LONGEST entry (entry-3), first sentence, <= 80 chars.
          title: expect.stringMatching(/^Memory must be retrievable/),
          sourceEntryIds: ["entry-1", "entry-2", "entry-3"],
        }),
        expect.objectContaining({
          kind: "memory_candidate",
          title: expect.stringMatching(/accepted scope/i),
          sourceEntryIds: expect.arrayContaining(["entry-2"]),
        }),
      ]),
    );
  });

  it("maps existing extracted items into scope items with evidence", () => {
    const result = compileThreadScopeDraft({
      threadTitle: "Existing extraction",
      summaryText: null,
      entries: [
        { id: "entry-1", seq: 1, inputType: "write", rawContent: "Build the scope viewer." },
      ],
      extractedItems: [
        {
          id: "extracted-task",
          discussionEntryId: "entry-1",
          type: "task",
          title: "Build scope viewer",
          description: "Render versioned scope items.",
          suggestedPriority: "high",
          suggestedAssigneeId: "agent-eng",
          suggestedProjectId: "project-1",
          suggestedGoalId: "goal-1",
          status: "pending",
        },
      ],
    });

    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "task_proposal",
          title: "Build scope viewer",
          extractedItemId: "extracted-task",
          sourceEntryIds: ["entry-1"],
          payload: expect.objectContaining({
            priority: "high",
            assigneeAgentId: "agent-eng",
            projectId: "project-1",
            goalId: "goal-1",
          }),
        }),
      ]),
    );
  });

  it("emits artifact links, asset source signals, and URL source signals from the scoped range", () => {
    const result = compileThreadScopeDraft({
      threadTitle: "Checkout redesign",
      summaryText: null,
      entries: [
        {
          id: "entry-1",
          seq: 1,
          inputType: "write",
          rawContent: "We need a checkout redesign. See https://example.com/current-flow for the rough path.",
        },
        {
          id: "entry-2",
          seq: 2,
          inputType: "write",
          rawContent: "Use the attached mockup as the requirement source.",
        },
      ],
      extractedItems: [
        {
          id: "extracted-artifact",
          discussionEntryId: "entry-2",
          type: "artifact",
          title: "Legacy extraction artifact",
          description: "An artifact-like extracted item without a concrete artifact ID.",
        },
      ],
      attachments: [
        {
          entryId: "entry-2",
          artifactId: "artifact-1",
          artifactVersionId: "artifact-version-1",
          assetId: "asset-artifact-1",
          title: "Checkout mockup",
          contentType: "application/pdf",
          kind: "artifact",
          storageKind: "asset",
          filename: "checkout-mockup.pdf",
          byteSize: 1234,
          sha256: "sha256-checkout",
        },
        {
          entryId: "entry-2",
          artifactId: null,
          artifactVersionId: null,
          assetId: "asset-1",
          title: "User interview notes",
          contentType: "text/plain",
          kind: "asset",
        },
      ],
    });

    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "artifact_link",
          title: "Checkout mockup",
          artifactId: "artifact-1",
          artifactVersionId: "artifact-version-1",
          sourceEntryIds: ["entry-2"],
          payload: expect.objectContaining({
            role: "reference",
            contentType: "application/pdf",
            storageKind: "asset",
            assetId: "asset-artifact-1",
            filename: "checkout-mockup.pdf",
            byteSize: 1234,
            sha256: "sha256-checkout",
          }),
        }),
        expect.objectContaining({
          kind: "source_signal",
          title: expect.stringContaining("User interview notes"),
          sourceEntryIds: ["entry-2"],
          payload: expect.objectContaining({
            assetId: "asset-1",
            contentType: "text/plain",
            role: "evidence",
          }),
        }),
        expect.objectContaining({
          kind: "source_signal",
          title: expect.stringContaining("https://example.com/current-flow"),
          sourceEntryIds: ["entry-1"],
          payload: expect.objectContaining({
            url: "https://example.com/current-flow",
            role: "evidence",
          }),
        }),
        expect.objectContaining({
          kind: "source_signal",
          title: "Legacy extraction artifact",
          extractedItemId: "extracted-artifact",
          sourceEntryIds: ["entry-2"],
        }),
      ]),
    );
    expect(result.items).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "task_proposal",
          extractedItemId: "extracted-artifact",
        }),
      ]),
    );
  });

  it("normalizes and deduplicates URL source signals across entries", () => {
    const result = compileThreadScopeDraft({
      threadTitle: "URL evidence cleanup",
      summaryText: null,
      entries: [
        {
          id: "entry-1",
          seq: 1,
          inputType: "write",
          rawContent: "Look at https://example.com/foo. It shows the current path.",
        },
        {
          id: "entry-2",
          seq: 2,
          inputType: "write",
          rawContent: "Same reference again: https://example.com/foo, plus more notes.",
        },
      ],
      extractedItems: [],
    });

    const urlSignals = result.items.filter(
      (item) => item.kind === "source_signal" && item.payload.url === "https://example.com/foo",
    );

    expect(urlSignals).toHaveLength(1);
    expect(urlSignals[0]).toEqual(
      expect.objectContaining({
        title: "Source: https://example.com/foo",
        payload: expect.objectContaining({
          role: "evidence",
          url: "https://example.com/foo",
        }),
        sourceEntryIds: ["entry-1", "entry-2"],
      }),
    );
  });

  it("keeps generated summaries concise while preserving the full evidence range", () => {
    const result = compileThreadScopeDraft({
      threadTitle: "Long discussion",
      summaryText: "Founder wants a scope model that turns messy discussion into executable work.",
      entries: [
        {
          id: "entry-1",
          seq: 1,
          inputType: "write",
          rawContent: "First, the scope should be deliberate and should consider the whole conversation. ".repeat(8),
        },
        {
          id: "entry-2",
          seq: 2,
          inputType: "write",
          rawContent: "Second, accepted versions should become the source of truth for tasks. ".repeat(8),
        },
        {
          id: "entry-3",
          seq: 3,
          inputType: "write",
          rawContent: "Third, memory should be useful to agents later and include evidence links. ".repeat(8),
        },
      ],
      extractedItems: [],
    });

    expect(result.summary.length).toBeLessThanOrEqual(520);
    expect(result.summary).toContain("Founder wants");
    expect(result.items[0]?.sourceEntryIds).toEqual(["entry-1", "entry-2", "entry-3"]);
  });

  it("synthesizes a memory candidate from explicit whole-thread durable memory intent", () => {
    const result = compileThreadScopeDraft({
      threadTitle: "Real crew scoping",
      summaryText:
        "The founder wants one implementation task and one durable memory about the decision rule.",
      entries: [
        {
          id: "entry-1",
          seq: 1,
          inputType: "write",
          rawContent:
            "Collect messy discussion, produce one implementation task, and save one durable memory about the decision rule.",
        },
        {
          id: "entry-2",
          seq: 2,
          inputType: "write",
          rawContent:
            "Now please scope this discussion into exactly one task proposal and one memory candidate. Use all messages above.",
        },
      ],
      extractedItems: [],
    });

    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "task_proposal",
          sourceEntryIds: ["entry-1", "entry-2"],
        }),
        expect.objectContaining({
          kind: "memory_candidate",
          // W2: synthesized memory-candidate titles derive from content too (longest
          // entry = entry-2, first sentence, <= 80) — the keyword stubs are dead.
          title: expect.stringMatching(/^Now please scope this discussion/),
          payload: expect.objectContaining({
            layer: "domain",
            category: "decision",
          }),
          sourceEntryIds: ["entry-1", "entry-2"],
        }),
      ]),
    );
  });

  it("does not synthesize memory candidates from casual memory mentions without save or scope intent", () => {
    const result = compileThreadScopeDraft({
      threadTitle: "Casual discussion",
      summaryText: null,
      entries: [
        {
          id: "entry-1",
          seq: 1,
          inputType: "write",
          rawContent: "I do not remember where the button is, but let us keep discussing the UI.",
        },
      ],
      extractedItems: [],
    });

    expect(result.items.some((item) => item.kind === "memory_candidate")).toBe(false);
  });
});

describe("compileThreadScopeDraft — proposedTasks", () => {
  const base = {
    threadTitle: "Auth rewrite",
    summaryText: "Migrate auth to JWT",
    entries: [{ id: "e1", seq: 1, inputType: "write", rawContent: "let's scope the auth work" }],
    extractedItems: [],
    attachments: [],
  };

  it("emits one assigned task_proposal per proposedTask and no placeholder", () => {
    const out = compileThreadScopeDraft({
      ...base,
      proposedTasks: [
        { title: "Build token endpoint", assigneeAgentId: "agent-eng" },
        { title: "Add refresh rotation", assigneeAgentId: "agent-eng" },
        { title: "Unassigned research" }, // no assignee → null
      ],
    });
    const tasks = out.items.filter((i) => i.kind === "task_proposal");
    expect(tasks).toHaveLength(3);
    expect(tasks.map((t) => t.title)).toEqual([
      "Build token endpoint",
      "Add refresh rotation",
      "Unassigned research",
    ]);
    expect(tasks[0].payload.assigneeAgentId).toBe("agent-eng");
    expect(tasks[2].payload.assigneeAgentId).toBeNull();
    // placeholder title must never appear when proposedTasks are given
    expect(tasks.map((t) => t.title)).not.toContain("Implement real multi-message scope generation");
  });

  it("falls back to a content-derived task when proposedTasks is absent (W2 — stub dead)", () => {
    const out = compileThreadScopeDraft(base); // no proposedTasks
    // no extracted items → ONE fallback task whose title derives from the entry
    // content. The text contains 'scope' — the OLD keyword stub would have fired
    // its placeholder title here; that stub is dead.
    const tasks = out.items.filter((i) => i.kind === "task_proposal");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe("let's scope the auth work");
    expect(tasks[0].title).not.toMatch(
      /Implement real multi-message|Implement crew discussion|Turn discussion into/,
    );
  });

  it("D1 dedup: proposedTasks suppress extracted task_proposals but keep decisions/memory", () => {
    const out = compileThreadScopeDraft({
      ...base,
      extractedItems: [
        { id: "x1", discussionEntryId: "e1", type: "task", title: "Extracted duplicate task", status: "pending" },
        { id: "x2", discussionEntryId: "e1", type: "decision", title: "Use JWT", status: "pending" },
      ] as any,
      proposedTasks: [{ title: "Adjutant task", assigneeAgentId: "agent-eng" }],
    });
    const tasks = out.items.filter((i) => i.kind === "task_proposal");
    // ONLY the proposed task — zero extracted task_proposals, zero placeholder
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe("Adjutant task");
    expect(tasks[0].payload.assigneeAgentId).toBe("agent-eng");
    // the extracted decision survives
    expect(out.items.some((i) => i.kind === "decision" && i.title === "Use JWT")).toBe(true);
  });
});

describe("compileThreadScopeDraft — derived fallback titles + suppressFallbackTask (W2)", () => {
  it("derives the fallback task title from entry content — the keyword stubs are dead", () => {
    // Entry text deliberately contains 'scope' — the OLD stub would have returned
    // its keyword placeholder. The derived title must come from the actual
    // content instead.
    const result = compileThreadScopeDraft({
      threadTitle: "Auth planning",
      summaryText: null,
      entries: [
        {
          id: "e1",
          seq: 1,
          inputType: "write",
          rawContent: "We need to scope the auth token endpoint rewrite before Friday.",
        },
      ],
      extractedItems: [],
    });
    const tasks = result.items.filter((i) => i.kind === "task_proposal");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe("We need to scope the auth token endpoint rewrite before Friday.");
    expect(tasks[0].title).not.toMatch(
      /Implement real multi-message|Implement crew discussion|Turn discussion into/,
    );
  });

  it("truncates long derived titles at a word boundary (<= 80 chars)", () => {
    const long =
      "Rebuild the entire authentication and authorization pipeline including refresh token rotation, session revocation lists, and audit logging for every login path.";
    const result = compileThreadScopeDraft({
      threadTitle: "Auth rebuild",
      summaryText: null,
      entries: [{ id: "e1", seq: 1, inputType: "write", rawContent: long }],
      extractedItems: [],
    });
    const task = result.items.find((i) => i.kind === "task_proposal")!;
    expect(task.title.length).toBeLessThanOrEqual(80);
    expect(task.title.startsWith("Rebuild the entire authentication")).toBe(true);
  });

  it("derives from the LONGEST entry — a short greeting first entry cannot become the title (eng-review D3)", () => {
    const result = compileThreadScopeDraft({
      threadTitle: "Billing retries",
      summaryText: null,
      entries: [
        { id: "e1", seq: 1, inputType: "write", rawContent: "Hey team, quick one." },
        {
          id: "e2",
          seq: 2,
          inputType: "write",
          rawContent: "We need to rebuild the billing retry queue with dead-letter handling.",
        },
      ],
      extractedItems: [],
    });
    const task = result.items.find((i) => i.kind === "task_proposal")!;
    expect(task.title).toBe("We need to rebuild the billing retry queue with dead-letter handling.");
    expect(task.title).not.toMatch(/Hey team/);
  });

  it("suppressFallbackTask: the intent-gated memory candidate still emits (it is derived, not fake)", () => {
    // Entry carries explicit durable-memory + decision intent — shouldSynthesizeMemoryCandidate
    // fires. suppressFallbackTask kills only the fallback TASK card, never the intent-derived
    // memory candidate (D6 targets fake cards; this one is authored by the user's own words).
    const result = compileThreadScopeDraft({
      threadTitle: "Extraction policy",
      summaryText: null,
      entries: [
        {
          id: "e1",
          seq: 1,
          inputType: "write",
          rawContent: "Save this to durable memory: our decision rule is codex-first for extraction.",
        },
      ],
      extractedItems: [],
      suppressFallbackTask: true,
    });
    expect(result.items.filter((i) => i.kind === "task_proposal")).toHaveLength(0);
    expect(result.items.filter((i) => i.kind === "memory_candidate")).toHaveLength(1);
  });

  it("suppressFallbackTask: zero real items → NO synthetic task card at all", () => {
    const result = compileThreadScopeDraft({
      threadTitle: "Crew scoping",
      summaryText: null,
      entries: [
        { id: "e1", seq: 1, inputType: "write", rawContent: "let us scope the crew work" },
      ],
      extractedItems: [],
      suppressFallbackTask: true,
    });
    expect(result.items.filter((i) => i.kind === "task_proposal")).toHaveLength(0);
  });

  it("suppressFallbackTask does NOT suppress real extracted items or proposedTasks", () => {
    const result = compileThreadScopeDraft({
      threadTitle: "Real work",
      summaryText: null,
      entries: [{ id: "e1", seq: 1, inputType: "write", rawContent: "scope this" }],
      extractedItems: [
        {
          id: "x1",
          discussionEntryId: "e1",
          type: "task",
          title: "Real extracted task",
          status: "pending",
        },
      ],
      suppressFallbackTask: true,
    });
    const tasks = result.items.filter((i) => i.kind === "task_proposal");
    expect(tasks.map((t) => t.title)).toContain("Real extracted task");
  });
});

describe("compileThreadScopeDraft — derived-title pool is HUMAN prose only (T6 review)", () => {
  const base = {
    threadTitle: "Auth rewrite",
    summaryText: "Migrate auth to JWT",
    extractedItems: [],
    attachments: [],
  };

  it("a longer scope_proposal JSON entry cannot become the title — longest HUMAN entry wins", () => {
    const out = compileThreadScopeDraft({
      ...base,
      entries: [
        { id: "e1", seq: 1, inputType: "write", rawContent: "We need to rebuild the billing retry queue." },
        {
          id: "e2",
          seq: 2,
          inputType: "scope_proposal",
          rawContent:
            '{"summary":"E2E fake scope from thread discussion with a very long JSON wire payload that would easily win a longest-entry contest","proposedTasks":[{"title":"X"}]}',
        },
      ],
    });
    const tasks = out.items.filter((i) => i.kind === "task_proposal");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe("We need to rebuild the billing retry queue.");
    expect(tasks[0].title).not.toMatch(/^\{/);
  });

  it("agent-authored entries (inputType 'agent' or authorAgentId set) are excluded from the title pool", () => {
    const out = compileThreadScopeDraft({
      ...base,
      entries: [
        { id: "e1", seq: 1, inputType: "write", rawContent: "Fix the webhook retries." },
        {
          id: "e2",
          seq: 2,
          inputType: "agent",
          rawContent: "As an agent I have produced a much longer reply that would otherwise win the longest-entry contest easily.",
        },
        {
          id: "e3",
          seq: 3,
          inputType: "write",
          authorAgentId: "agent-scout",
          rawContent: "Another long agent-authored message routed through a human-looking input type that must also not win here.",
        },
      ],
    });
    const tasks = out.items.filter((i) => i.kind === "task_proposal");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe("Fix the webhook retries.");
  });

  it("no human prose at all → static fallback title (never JSON, never agent text)", () => {
    const out = compileThreadScopeDraft({
      ...base,
      entries: [
        { id: "e1", seq: 1, inputType: "agent", rawContent: "Agent-only chatter in this thread." },
        { id: "e2", seq: 2, inputType: "scope_proposal", rawContent: '{"summary":"json blob"}' },
      ],
    });
    const tasks = out.items.filter((i) => i.kind === "task_proposal");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe("Scope work from this discussion");
  });
});
