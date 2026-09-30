import { beforeEach, describe, expect, it, vi } from "vitest";

// Task 4: mock crew-role-map so tests can control resolveRoleToAgentId without
// hitting the DB. The default mock resolves to undefined (no agent); individual
// tests override with mockResolvedValueOnce / mockResolvedValue as needed.
const { mockResolveRoleToAgentId } = vi.hoisted(() => ({
  mockResolveRoleToAgentId: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/internal-agent/tools/crew-role-map.js", () => ({
  resolveRoleToAgentId: mockResolveRoleToAgentId,
}));

// Review fix (f): the post_reply commit now runs mention processing on the
// committed entry (mirroring the non-gated post-entry-tool path). Mock
// ../services/threads.js so the real (pure) parseMentions runs but
// processMentions is a spy we can assert on — and threadService stays a callable
// stub (used only as the default advance_phase committer, never in these tests).
const { mockProcessMentions, mockEnsureAgentParticipant, realParseMentions } = vi.hoisted(() => ({
  mockProcessMentions: vi.fn().mockResolvedValue(undefined),
  mockEnsureAgentParticipant: vi.fn().mockResolvedValue(undefined),
  realParseMentions: (text: string) => {
    const regex = /(?:^|\s)@(\w+)/g;
    const seen = new Set<string>();
    const out: Array<{ raw: string; name: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
      if (!seen.has(m[1])) {
        seen.add(m[1]);
        out.push({ raw: `@${m[1]}`, name: m[1] });
      }
    }
    return out;
  },
}));
vi.mock("../services/threads.js", () => ({
  parseMentions: realParseMentions,
  processMentions: mockProcessMentions,
  ensureAgentParticipant: mockEnsureAgentParticipant,
  threadService: vi.fn(() => ({ advancePhase: vi.fn() })),
}));

// W2: the create_scope_draft handler awaits extract-then-scope before compiling.
// Mock it so the real helper never runs against this file's sequence DBs.
const { mockExtractThreadEntriesAwait } = vi.hoisted(() => ({
  mockExtractThreadEntriesAwait: vi.fn().mockResolvedValue({ attempted: 0, failed: 0, truncated: false, deadlineHit: false, lastAttemptedSeq: null, rangeEndCap: null }),
}));
vi.mock("../services/extraction.js", () => ({
  extractionService: () => ({ extractThreadEntriesAwait: mockExtractThreadEntriesAwait }),
}));

import {
  reapStaleThreadAgentActions,
  threadAgentActionService,
} from "../services/thread-agent-actions.js";
import {
  buildPostReplyIdempotencyKey,
  buildConveneWakeupDedupKey,
  buildArtifactCandidateIdempotencyKey,
} from "../services/internal-agent/tools/thread-action-keys.js";
import { THREAD_AGENT_ACTION_STATUSES } from "@armyofagents/shared";

// Codex #9 / invariant-consolidation C1: the seal persists status='ready' (Decision #99 producer
// gate) and the relay drains ONLY 'ready'. The shared status alphabet is the single source of truth;
// if 'ready' (or any persisted lifecycle state) is missing, every typed consumer treats sealed rows
// as impossible. The `satisfies ThreadAgentActionStatus` annotations on the seal/GC writes make a
// missing status a COMPILE error; this test additionally guards a non-TS removal.
describe("thread-action status contract", () => {
  it("includes every persisted lifecycle state, incl. the sealed 'ready' relay state", () => {
    for (const s of ["proposed", "ready", "committing", "committed", "suppressed_stale", "blocked_policy", "failed"]) {
      expect(THREAD_AGENT_ACTION_STATUSES).toContain(s);
    }
  });
});

describe("thread-action idempotency keys", () => {
  it("discriminates asset-backed artifact candidates by assetId", () => {
    const base = {
      threadId: "thread-1",
      agentId: "agent-1",
      title: "Deck",
      content: null,
      fileRef: null,
      turnAnchor: "4",
    };
    type AssetCandidateKeyInput = Parameters<typeof buildArtifactCandidateIdempotencyKey>[0] & { assetId: string };
    expect(buildArtifactCandidateIdempotencyKey({ ...base, assetId: "asset-a" } as AssetCandidateKeyInput))
      .not.toBe(buildArtifactCandidateIdempotencyKey({ ...base, assetId: "asset-b" } as AssetCandidateKeyInput));
  });
});

function createSequenceDb(config: { selects?: unknown[][]; inserts?: Array<unknown[] | Error>; updates?: Array<unknown[] | Error> } = {}) {
  let selectIdx = 0;
  let insertIdx = 0;
  let updateIdx = 0;
  const insertValues: unknown[] = [];
  const updateSets: unknown[] = [];

  function makeChain(getRows: () => unknown[]) {
    const chain: Record<string, unknown> = {};
    for (const method of ["from", "where", "orderBy", "limit", "values", "set", "onConflictDoNothing", "returning"]) {
      chain[method] = (arg?: unknown) => {
        if (method === "values") insertValues.push(arg);
        if (method === "set") updateSets.push(arg);
        return chain;
      };
    }
    chain.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve(getRows()));
    return chain;
  }

  const db = {
    select: () => makeChain(() => config.selects?.[selectIdx++] ?? []),
    insert: () => makeChain(() => {
      const next = config.inserts?.[insertIdx++] ?? [];
      if (next instanceof Error) throw next;
      return next;
    }),
    update: () => makeChain(() => {
      const next = config.updates?.[updateIdx++] ?? [];
      if (next instanceof Error) throw next;
      return next;
    }),
    transaction: async (callback: (tx: unknown) => unknown) => callback(db),
    __insertValues: insertValues,
    __updateSets: updateSets,
  };

  return db;
}

const thread = { id: "thread-1", companyId: "company-1" };

const baseAction = {
  id: "action-1",
  companyId: "company-1",
  threadId: "thread-1",
  runId: "run-1",
  agentId: "agent-1",
  actionType: "post_reply",
  status: "proposed",
  payload: { rawContent: "Here is the scoped recommendation.", parentEntryId: "entry-1" },
  idempotencyKey: "run-1:post_reply:1",
  freshness: { latestHumanSeq: 1 },
};

describe("threadAgentActionService", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockProcessMentions.mockClear();
    mockProcessMentions.mockResolvedValue(undefined);
    mockResolveRoleToAgentId.mockClear();
    mockResolveRoleToAgentId.mockResolvedValue(undefined);
  });

  it("returns the existing row when a duplicate propose hits the idempotency conflict", async () => {
    // Race-safe propose (fix: TOCTOU): the insert runs with onConflictDoNothing
    // and returns no row on conflict; the service then re-selects and returns the
    // pre-existing action rather than throwing a 500 unique-violation.
    const existing = { ...baseAction, id: "existing-action" };
    const db = createSequenceDb({
      selects: [[thread], [existing]],
      // insert returns [] → conflict suppressed (row already existed)
      inserts: [[]],
    });

    const result = await threadAgentActionService(db as never).proposeThreadAction({
      companyId: "company-1",
      threadId: "thread-1",
      runId: "run-1",
      agentId: "agent-1",
      actionType: "post_reply",
      payload: { rawContent: "Hello" },
      idempotencyKey: "run-1:post_reply:1",
      freshness: { latestHumanSeq: 1 },
    });

    expect(result).toEqual(existing);
    // The insert is attempted (race-safe), but onConflictDoNothing means no new
    // row is written — the existing row is returned via the follow-up select.
    expect(db.__insertValues).toHaveLength(1);
  });

  it("re-propose of a suppressed_stale row revives it to proposed and ADOPTS the fresh snapshot (no runId forward)", async () => {
    // PR-B: the commit SELECT is now THREAD-scoped, so the runId re-home is gone. We
    // keep ONE narrow case: a same-turn re-proposal (same idempotencyKey) that
    // collides with a terminal `suppressed_stale` row must revive it to `proposed`
    // so the thread-scoped SELECT (which only picks proposed/retryable-failed) can
    // re-pick it — otherwise the action is stranded. We do NOT forward runId, but we
    // DO adopt the re-proposal's freshness (Codex P2): keeping the old already-failed
    // snapshot would re-suppress the revived row on the next commit (e.g. a scope-
    // coupled action stuck on newer_scope_version even though THIS run saw the new scope).
    const freshSnap = { threadId: "thread-1", entrySeq: 7, latestScopeVersionId: "v2" };
    const existing = { ...baseAction, id: "ex", runId: "run-1", status: "suppressed_stale", blockedReason: "newer_scope_version", freshness: { threadId: "thread-1", entrySeq: 3, latestScopeVersionId: "v1" } };
    // updates[0] = the outbox key-set append (proposed_action_keys on the run row, runId set);
    // updates[1] = the suppressed_stale→proposed revive.
    const db = createSequenceDb({ selects: [[thread], [existing]], inserts: [[]], updates: [[], [{ ...existing, status: "proposed", blockedReason: null, freshness: freshSnap }]] });
    const res = (await threadAgentActionService(db as never).proposeThreadAction({
      companyId: "company-1", threadId: "thread-1", runId: "run-2", agentId: null,
      actionType: "add_scope_item", payload: { kind: "decision", title: "x" }, idempotencyKey: existing.idempotencyKey, freshness: freshSnap,
    })) as { id: string; status: string };
    expect(res.status).toBe("proposed");
    expect(db.__updateSets[1]).toMatchObject({ status: "proposed", blockedReason: null, freshness: freshSnap });
    expect(db.__updateSets[1]).not.toHaveProperty("runId"); // runId NOT forwarded
  });

  it("re-propose of a blocked_policy/run_not_sealed row revives it to proposed and ADOPTS the fresh snapshot (Codex round-8)", async () => {
    // The GC self-heal re-seals a failed/crashed producer's blocked_policy/run_not_sealed row by a
    // completed run's key-set. A same-turn re-proposal must re-stamp freshness so the re-sealed row
    // commits against what THIS (successful) run saw — else a scope-coupled action is wrongly suppressed
    // as newer_scope_version carrying the FAILED run's stale snapshot.
    const freshSnap = { threadId: "thread-1", entrySeq: 7, latestScopeVersionId: "v2" };
    const existing = { ...baseAction, id: "exb", runId: "run-1", status: "blocked_policy", blockedReason: "run_not_sealed", freshness: { threadId: "thread-1", entrySeq: 3, latestScopeVersionId: "v1" } };
    const db = createSequenceDb({ selects: [[thread], [existing]], inserts: [[]], updates: [[], [{ ...existing, status: "proposed", blockedReason: null, freshness: freshSnap }]] });
    const res = (await threadAgentActionService(db as never).proposeThreadAction({
      companyId: "company-1", threadId: "thread-1", runId: "run-2", agentId: null,
      actionType: "add_scope_item", payload: { kind: "decision", title: "x" }, idempotencyKey: existing.idempotencyKey, freshness: freshSnap,
    })) as { id: string; status: string };
    expect(res.status).toBe("proposed");
    expect(db.__updateSets[1]).toMatchObject({ status: "proposed", blockedReason: null, freshness: freshSnap });
  });

  it("re-propose of a NO-OP committed create_scope_draft (null version) revives it to proposed (Codex #270 round 10)", async () => {
    // A create_scope_draft that committed without minting a draft (no_entries/no_items —
    // e.g. extraction found no CLI) is a no-op: nothing for idempotency to protect. Its
    // run-independent, turn-anchored key would otherwise absorb every same-turn
    // re-proposal, so the draft could never be re-attempted after the founder fixes
    // extraction (until a new human entry moves the turn anchor).
    const freshSnap = { threadId: "thread-1", entrySeq: 7, latestScopeVersionId: null };
    const existing = {
      ...baseAction, id: "exn", runId: "run-1", actionType: "create_scope_draft",
      status: "committed", committedScopeVersionId: null, committedAt: new Date("2026-07-01"),
      freshness: { threadId: "thread-1", entrySeq: 3, latestScopeVersionId: null },
    };
    const db = createSequenceDb({ selects: [[thread], [existing]], inserts: [[]], updates: [[], [{ ...existing, status: "proposed", committedAt: null, freshness: freshSnap }]] });
    const res = (await threadAgentActionService(db as never).proposeThreadAction({
      companyId: "company-1", threadId: "thread-1", runId: "run-2", agentId: null,
      actionType: "create_scope_draft", payload: { summary: "retry after CLI fix" }, idempotencyKey: existing.idempotencyKey, freshness: freshSnap,
    })) as { id: string; status: string };
    expect(res.status).toBe("proposed");
    // Revived in-flight: freshness re-stamped AND the stale committedAt shed.
    expect(db.__updateSets[1]).toMatchObject({ status: "proposed", blockedReason: null, freshness: freshSnap, committedAt: null });
  });

  it("does NOT revive a committed create_scope_draft that HAS a version id (real commits stay terminal)", async () => {
    // Draft-minting and existing_draft commits both record the version id — those are
    // real effects and the idempotency key must keep absorbing same-turn re-proposals.
    const existing = {
      ...baseAction, id: "exv", runId: "run-1", actionType: "create_scope_draft",
      status: "committed", committedScopeVersionId: "v1",
    };
    const db = createSequenceDb({ selects: [[thread], [existing]], inserts: [[]], updates: [[]] }); // only the key append; NO revive
    const res = (await threadAgentActionService(db as never).proposeThreadAction({
      companyId: "company-1", threadId: "thread-1", runId: "run-2", agentId: null,
      actionType: "create_scope_draft", payload: { summary: "same turn" }, idempotencyKey: existing.idempotencyKey, freshness: { entrySeq: 1 },
    })) as { id: string; status: string };
    expect(res.status).toBe("committed"); // unchanged — not revived
    expect(db.__updateSets).toHaveLength(1); // only the outbox key append
  });

  it("does NOT revive a committed NON-create_scope_draft row with a null version (no-op revive stays scoped)", async () => {
    // A committed post_reply/convene_agent has real side-effects that are NOT recorded
    // in committedScopeVersionId — reviving one would replay them (duplicate reply /
    // duplicate wakeup). The no-op revive fires for create_scope_draft ONLY.
    const existing = { ...baseAction, id: "exr", runId: "run-1", status: "committed", committedScopeVersionId: null };
    const db = createSequenceDb({ selects: [[thread], [existing]], inserts: [[]], updates: [[]] }); // only the key append; NO revive
    const res = (await threadAgentActionService(db as never).proposeThreadAction({
      companyId: "company-1", threadId: "thread-1", runId: "run-2", agentId: "agent-1",
      actionType: "post_reply", payload: { rawContent: "Hello" }, idempotencyKey: existing.idempotencyKey, freshness: { latestHumanSeq: 1 },
    })) as { id: string; status: string };
    expect(res.status).toBe("committed"); // unchanged — not revived
    expect(db.__updateSets).toHaveLength(1); // only the outbox key append
  });

  it("does NOT revive a blocked_policy row blocked for a NON-run_not_sealed reason (revive stays narrow)", async () => {
    // Only GC-terminalized (run_not_sealed) blocks are revivable; a genuine policy block stays terminal.
    const existing = { ...baseAction, id: "exp", runId: "run-1", status: "blocked_policy", blockedReason: "some_policy" };
    const db = createSequenceDb({ selects: [[thread], [existing]], inserts: [[]], updates: [[]] }); // only the key append; NO revive
    const res = (await threadAgentActionService(db as never).proposeThreadAction({
      companyId: "company-1", threadId: "thread-1", runId: "run-2", agentId: null,
      actionType: "add_scope_item", payload: { kind: "decision", title: "x" }, idempotencyKey: existing.idempotencyKey, freshness: { entrySeq: 1 },
    })) as { id: string; status: string };
    expect(res.status).toBe("blocked_policy"); // unchanged — not revived
    expect(db.__updateSets).toHaveLength(1); // only the outbox key append
  });

  it("returns a non-suppressed_stale colliding row unchanged (revive is narrow)", async () => {
    // The revive fires ONLY for `suppressed_stale`. A colliding row in any other
    // status (here: committed) is returned as-is with NO UPDATE — the thread-scoped
    // commit already sees proposed/retryable-failed rows regardless of runId.
    const existing = { ...baseAction, id: "existing-action", runId: "run-1", status: "committed" };
    const db = createSequenceDb({
      selects: [[thread], [existing]],
      inserts: [[]],
      updates: [[]], // only the outbox key-set append; NO revive
    });

    const result = (await threadAgentActionService(db as never).proposeThreadAction({
      companyId: "company-1",
      threadId: "thread-1",
      runId: "run-2",
      agentId: "agent-1",
      actionType: "post_reply",
      payload: { rawContent: "Hello" },
      idempotencyKey: "run-1:post_reply:1",
      freshness: { latestHumanSeq: 1 },
    })) as { id: string; runId: string };

    expect(result.id).toBe("existing-action");
    expect(result.runId).toBe("run-1"); // unchanged
    // The only UPDATE is the proposed-key append (runId set); the colliding committed row is
    // NOT revived (the revive fires only for suppressed_stale).
    expect(db.__updateSets).toHaveLength(1);
    expect(db.__updateSets[0]).toHaveProperty("proposedActionKeys");
  });

  it("sealRunActions promotes this run's proposed rows to ready by key-set", async () => {
    // Outbox SEAL (Mechanism B): on run success the producer promotes the actions it
    // proposed this turn from `proposed` → `ready`, keyed by idempotencyKey (not runId), so
    // a re-proposed/collided row is sealed regardless of which run owns it. Returns the count.
    const db = createSequenceDb({ updates: [[{ id: "a1" }, { id: "a2" }]] });
    const n = await threadAgentActionService(db as never).sealRunActions({
      companyId: "company-1",
      threadId: "thread-1",
      idempotencyKeys: ["k1", "k2"],
    });
    expect(n).toBe(2);
    expect(db.__updateSets[0]).toMatchObject({ status: "ready" });
  });

  it("sealRunActions is a no-op (issues no UPDATE) on an empty key-set", async () => {
    const db = createSequenceDb({ updates: [] });
    const n = await threadAgentActionService(db as never).sealRunActions({
      companyId: "company-1",
      threadId: "thread-1",
      idempotencyKeys: [],
    });
    expect(n).toBe(0);
    expect(db.__updateSets).toHaveLength(0);
  });

  it("returns the freshly inserted row when there is no idempotency conflict", async () => {
    const inserted = { ...baseAction, id: "inserted-action" };
    const db = createSequenceDb({
      selects: [[thread]],
      inserts: [[inserted]],
    });

    const result = await threadAgentActionService(db as never).proposeThreadAction({
      companyId: "company-1",
      threadId: "thread-1",
      runId: "run-1",
      agentId: "agent-1",
      actionType: "post_reply",
      payload: { rawContent: "Hello" },
      idempotencyKey: "run-1:post_reply:2",
      freshness: { latestHumanSeq: 1 },
    });

    expect(result).toEqual(inserted);
    expect(db.__insertValues).toHaveLength(1);
  });

  it("rejects action proposals for threads outside the company", async () => {
    const db = createSequenceDb({ selects: [[]] });

    await expect(
      threadAgentActionService(db as never).proposeThreadAction({
        companyId: "company-2",
        threadId: "thread-1",
        runId: "run-1",
        agentId: "agent-1",
        actionType: "post_reply",
        payload: { rawContent: "Hello" },
        idempotencyKey: "run-1:post_reply:1",
        freshness: { latestHumanSeq: 1 },
      }),
    ).rejects.toThrow("Thread not found");

    expect(db.__insertValues).toHaveLength(0);
  });

  it("suppresses proposed actions when freshness comparison is stale", async () => {
    const db = createSequenceDb({ selects: [[baseAction]], updates: [[{ ...baseAction, status: "suppressed_stale" }]] });
    const addEntry = vi.fn();
    const createDraftFromThread = vi.fn();

    const result = await threadAgentActionService(db as never, {
      compareFreshnessSnapshot: vi.fn().mockResolvedValue({ fresh: false, reason: "newer_human_entry" }),
      discussions: { addEntry },
      scopeVersions: { createDraftFromThread },
    }).commitThreadAgentActions({
      companyId: "company-1",
      threadId: "thread-1",
      runId: "run-1",
    });

    expect(result).toEqual({ committed: 0, suppressed: 1, blocked: 0, failed: 0, lostRace: 0 });
    expect(addEntry).not.toHaveBeenCalled();
    expect(createDraftFromThread).not.toHaveBeenCalled();
    expect(db.__updateSets).toContainEqual(expect.objectContaining({
      status: "suppressed_stale",
      blockedReason: "newer_human_entry",
    }));
  });

  it("commits a fresh post_reply through discussionService.addEntry", async () => {
    const db = createSequenceDb({ selects: [[baseAction]], updates: [[{ ...baseAction, status: "committed" }]] });
    const addEntry = vi.fn().mockResolvedValue({ id: "entry-committed" });

    const result = await threadAgentActionService(db as never, {
      compareFreshnessSnapshot: vi.fn().mockResolvedValue({ fresh: true }),
      discussions: { addEntry },
      scopeVersions: { createDraftFromThread: vi.fn() },
    }).commitThreadAgentActions({
      companyId: "company-1",
      threadId: "thread-1",
      runId: "run-1",
    });

    expect(result).toEqual({ committed: 1, suppressed: 0, blocked: 0, failed: 0, lostRace: 0 });
    expect(addEntry).toHaveBeenCalledWith(
      "company-1",
      "thread-1",
      expect.objectContaining({
        inputType: "agent",
        rawContent: "Here is the scoped recommendation.",
        parentEntryId: "entry-1",
        authorAgentId: "agent-1",
      }),
      "agent:agent-1",
      {
        userId: "agent-1",
        role: "team_member",
        isHuman: false,
        principalType: "agent",
      },
    );
    expect(db.__updateSets).toContainEqual(expect.objectContaining({
      status: "committed",
      committedEntryId: "entry-committed",
    }));
  });

  it("registers the committing agent as a thread participant BEFORE addEntry (third authz chokepoint)", async () => {
    // Live-QA regression 2026-07-16: a crew agent's gated post_reply commit hit
    // assertCanPostToThread with an agent that was never registered as a
    // participant → 404 "Thread not found" → action row `failed` and the reply
    // silently never landed. The direct tool path (post-entry-tool.ts) and the
    // fake-crew path already register the participant; the commit path is the
    // third chokepoint and must do the same.
    const db = createSequenceDb({ selects: [[baseAction]], updates: [[{ ...baseAction, status: "committed" }]] });
    const addEntry = vi.fn().mockResolvedValue({ id: "entry-committed" });

    await threadAgentActionService(db as never, {
      compareFreshnessSnapshot: vi.fn().mockResolvedValue({ fresh: true }),
      discussions: { addEntry },
      scopeVersions: { createDraftFromThread: vi.fn() },
    }).commitThreadAgentActions({
      companyId: "company-1",
      threadId: "thread-1",
      runId: "run-1",
    });

    expect(mockEnsureAgentParticipant).toHaveBeenCalledWith(
      expect.anything(),
      "company-1",
      "thread-1",
      "agent-1",
    );
    // Registration must precede the post — otherwise the authz inside addEntry
    // still sees a non-participant.
    const registeredAt = mockEnsureAgentParticipant.mock.invocationCallOrder[0];
    const postedAt = addEntry.mock.invocationCallOrder[0];
    expect(registeredAt).toBeLessThan(postedAt);
  });

  it("threads sourceInfo from the action payload through addEntry on a committed post_reply (fix (f))", async () => {
    const action = {
      ...baseAction,
      payload: {
        rawContent: "Status update.",
        parentEntryId: "entry-1",
        sourceInfo: { systemNotice: true },
      },
    };
    const db = createSequenceDb({ selects: [[action]], updates: [[{ ...action, status: "committed" }]] });
    const addEntry = vi.fn().mockResolvedValue({ id: "entry-committed" });

    await threadAgentActionService(db as never, {
      compareFreshnessSnapshot: vi.fn().mockResolvedValue({ fresh: true }),
      discussions: { addEntry },
      scopeVersions: { createDraftFromThread: vi.fn() },
    }).commitThreadAgentActions({
      companyId: "company-1",
      threadId: "thread-1",
      runId: "run-1",
    });

    expect(addEntry).toHaveBeenCalledWith(
      "company-1",
      "thread-1",
      expect.objectContaining({ sourceInfo: { systemNotice: true } }),
      "agent:agent-1",
      {
        userId: "agent-1",
        role: "team_member",
        isHuman: false,
        principalType: "agent",
      },
    );
  });

  it("does NOT summon inline via processMentions on a committed post_reply — the outbox owns it (round-8 #1)", async () => {
    // The @mention summon now rides the transactional outbox inside
    // discussionService.addEntry (with hopCount:1 for this agent-authored,
    // inputType:'agent' reply) and is drained exactly-once by the worker. Calling
    // processMentions directly here on top of the outbox was a DOUBLE summon —
    // removed. (The atomic enqueue is covered by the outbox integration test.)
    const action = {
      ...baseAction,
      payload: {
        rawContent: "@Planner can you take this from here?",
        parentEntryId: "entry-1",
      },
    };
    const db = createSequenceDb({ selects: [[action]], updates: [[{ ...action, status: "committed" }]] });
    const addEntry = vi.fn().mockResolvedValue({ id: "entry-with-mention" });

    const result = await threadAgentActionService(db as never, {
      compareFreshnessSnapshot: vi.fn().mockResolvedValue({ fresh: true }),
      discussions: { addEntry },
      scopeVersions: { createDraftFromThread: vi.fn() },
    }).commitThreadAgentActions({
      companyId: "company-1",
      threadId: "thread-1",
      runId: "run-1",
    });

    expect(result).toEqual({ committed: 1, suppressed: 0, blocked: 0, failed: 0, lostRace: 0 });
    // addEntry (which owns the outbox enqueue) posts the agent reply…
    expect(addEntry).toHaveBeenCalledTimes(1);
    expect(addEntry.mock.calls[0][2]).toMatchObject({ inputType: "agent", authorAgentId: expect.anything() });
    // …and the committer no longer double-summons inline.
    expect(mockProcessMentions).not.toHaveBeenCalled();
  });

  it("does not run mention processing when a committed post_reply has no @mention (fix (f))", async () => {
    const db = createSequenceDb({ selects: [[baseAction]], updates: [[{ ...baseAction, status: "committed" }]] });
    const addEntry = vi.fn().mockResolvedValue({ id: "entry-committed" });

    await threadAgentActionService(db as never, {
      compareFreshnessSnapshot: vi.fn().mockResolvedValue({ fresh: true }),
      discussions: { addEntry },
      scopeVersions: { createDraftFromThread: vi.fn() },
    }).commitThreadAgentActions({
      companyId: "company-1",
      threadId: "thread-1",
      runId: "run-1",
    });

    expect(mockProcessMentions).not.toHaveBeenCalled();
  });

  it("commits a post_reply with an @mention — dispatch is now the outbox worker's concern, never inline (round-8 #1)", async () => {
    const action = {
      ...baseAction,
      payload: { rawContent: "@Planner please review", parentEntryId: "entry-1" },
    };
    const db = createSequenceDb({ selects: [[action]], updates: [[{ ...action, status: "committed" }]] });
    const addEntry = vi.fn().mockResolvedValue({ id: "entry-with-mention" });

    const result = await threadAgentActionService(db as never, {
      compareFreshnessSnapshot: vi.fn().mockResolvedValue({ fresh: true }),
      discussions: { addEntry },
      scopeVersions: { createDraftFromThread: vi.fn() },
    }).commitThreadAgentActions({
      companyId: "company-1",
      threadId: "thread-1",
      runId: "run-1",
    });

    // The reply commits and the committer never summons inline (the outbox does).
    expect(result).toEqual({ committed: 1, suppressed: 0, blocked: 0, failed: 0, lostRace: 0 });
    expect(mockProcessMentions).not.toHaveBeenCalled();
  });

  it("claims a post_reply as committing before writing the discussion entry", async () => {
    const db = createSequenceDb({
      selects: [[baseAction]],
      updates: [
        [{ ...baseAction, status: "committing" }],
        [{ ...baseAction, status: "committed", committedEntryId: "entry-committed" }],
      ],
    });
    const addEntry = vi.fn().mockResolvedValue({ id: "entry-committed" });

    const result = await threadAgentActionService(db as never, {
      compareFreshnessSnapshot: vi.fn().mockResolvedValue({ fresh: true }),
      discussions: { addEntry },
      scopeVersions: { createDraftFromThread: vi.fn() },
    }).commitThreadAgentActions({
      companyId: "company-1",
      threadId: "thread-1",
      runId: "run-1",
    });

    expect(result).toEqual({ committed: 1, suppressed: 0, blocked: 0, failed: 0, lostRace: 0 });
    expect(db.__updateSets[0]).toMatchObject({ status: "committing" });
    expect(addEntry).toHaveBeenCalledTimes(1);
    expect(db.__updateSets[1]).toMatchObject({
      status: "committed",
      committedEntryId: "entry-committed",
    });
  });

  it("skips a post_reply as a lost race when the fenced claim returns no row (PR-B CAS)", async () => {
    // PR-B fenced CAS: the proposed→committing claim is a compare-and-swap fenced
    // on the row's observed attempt_count + updated_at. If a concurrent
    // reaper/failure flips the row between the freshness re-check and the claim,
    // the fence no longer matches → the UPDATE returns 0 rows. The committer must
    // treat the empty result as a LOST RACE and skip the action: NO side effect
    // (addEntry) runs, and the action is NOT counted as committed/failed/suppressed —
    // it is counted as `lostRace` so the controller reschedules instead of advancing.
    const db = createSequenceDb({
      selects: [[baseAction]],
      // The claim's UPDATE ... RETURNING resolves to [] (fence mismatch / lost race).
      updates: [[]],
    });
    const addEntry = vi.fn().mockResolvedValue({ id: "entry-committed" });

    const result = await threadAgentActionService(db as never, {
      compareFreshnessSnapshot: vi.fn().mockResolvedValue({ fresh: true }),
      discussions: { addEntry },
      scopeVersions: { createDraftFromThread: vi.fn() },
    }).commitThreadAgentActions({
      companyId: "company-1",
      threadId: "thread-1",
      runId: "run-1",
    });

    // Lost race → counted as lostRace (so the controller reschedules), no side effect.
    expect(result).toEqual({ committed: 0, suppressed: 0, blocked: 0, failed: 0, lostRace: 1 });
    expect(addEntry).not.toHaveBeenCalled();
    // The claim was attempted (it set status=committing) but produced no further
    // updates — the loop short-circuited on the empty returning.
    expect(db.__updateSets).toHaveLength(1);
    expect(db.__updateSets[0]).toMatchObject({ status: "committing" });
  });

  it("proceeds with a post_reply when the fenced claim wins (returns the row) (PR-B CAS)", async () => {
    // PR-B fenced CAS, won race: the claim's UPDATE ... RETURNING resolves to the
    // row → this committer owns it → the side effect runs and the action commits.
    const db = createSequenceDb({
      selects: [[baseAction]],
      updates: [
        [{ ...baseAction, status: "committing" }], // claim wins
        [{ ...baseAction, status: "committed", committedEntryId: "entry-committed" }],
      ],
    });
    const addEntry = vi.fn().mockResolvedValue({ id: "entry-committed" });

    const result = await threadAgentActionService(db as never, {
      compareFreshnessSnapshot: vi.fn().mockResolvedValue({ fresh: true }),
      discussions: { addEntry },
      scopeVersions: { createDraftFromThread: vi.fn() },
    }).commitThreadAgentActions({
      companyId: "company-1",
      threadId: "thread-1",
      runId: "run-1",
    });

    expect(result).toEqual({ committed: 1, suppressed: 0, blocked: 0, failed: 0, lostRace: 0 });
    expect(addEntry).toHaveBeenCalledTimes(1);
    expect(db.__updateSets[0]).toMatchObject({ status: "committing" });
  });

  it("does not replay a post_reply side effect after the action was already claimed as committing", async () => {
    const claimedAction = { ...baseAction, status: "committing" };
    const db = createSequenceDb({
      selects: [
        [baseAction],
        [],
      ],
      updates: [
        [{ ...baseAction, status: "committing" }],
        new Error("lost connection after discussion entry write"),
        [{ ...baseAction, status: "failed" }],
      ],
    });
    const addEntry = vi.fn().mockResolvedValue({ id: "entry-committed" });

    const first = await threadAgentActionService(db as never, {
      compareFreshnessSnapshot: vi.fn().mockResolvedValue({ fresh: true }),
      discussions: { addEntry },
      scopeVersions: { createDraftFromThread: vi.fn() },
    }).commitThreadAgentActions({
      companyId: "company-1",
      threadId: "thread-1",
      runId: "run-1",
    });
    expect(first).toEqual({ committed: 0, suppressed: 0, blocked: 0, failed: 1, lostRace: 0 });
    expect(addEntry).toHaveBeenCalledTimes(1);
    expect(db.__updateSets[0]).toMatchObject({ status: "committing" });

    const second = await threadAgentActionService(db as never, {
      compareFreshnessSnapshot: vi.fn().mockResolvedValue({ fresh: true }),
      discussions: { addEntry },
      scopeVersions: { createDraftFromThread: vi.fn() },
    }).commitThreadAgentActions({
      companyId: "company-1",
      threadId: "thread-1",
      runId: "run-1",
    });

    expect(claimedAction.status).toBe("committing");
    expect(second).toEqual({ committed: 0, suppressed: 0, blocked: 0, failed: 0, lostRace: 0 });
    expect(addEntry).toHaveBeenCalledTimes(1);
  });

  it("converges (idempotent) when addEntry raises the source_action_id unique violation (#197)", async () => {
    // A re-commit of the SAME action (single-invocation partial crash / reaper
    // re-commit) must NOT create a second entry. addEntry raises a WRAPPED 23505
    // (postgres-js puts the code on err.cause); the branch re-selects the existing
    // entry and marks the action committed — no duplicate, not counted as failed.
    const db = createSequenceDb({
      selects: [
        [baseAction], // commit selection
        [{ id: "existing-entry" }], // re-select after the unique violation
      ],
      updates: [
        [{ ...baseAction, status: "committing" }],
        [{ ...baseAction, status: "committed", committedEntryId: "existing-entry" }],
      ],
    });
    // postgres-js emits the index name on `cause.constraint_name` (the REAL shape).
    const wrapped = Object.assign(new Error("duplicate key value"), {
      cause: { code: "23505", constraint_name: "discussion_entries_source_action_uq" },
    });
    const addEntry = vi.fn().mockRejectedValueOnce(wrapped);

    const result = await threadAgentActionService(db as never, {
      compareFreshnessSnapshot: vi.fn().mockResolvedValue({ fresh: true }),
      discussions: { addEntry },
      scopeVersions: { createDraftFromThread: vi.fn() },
    }).commitThreadAgentActions({
      companyId: "company-1",
      threadId: "thread-1",
      runId: "run-1",
    });

    // Converged, not failed.
    expect(result).toEqual({ committed: 1, suppressed: 0, blocked: 0, failed: 0, lostRace: 0 });
    expect(addEntry).toHaveBeenCalledTimes(1);
    expect(db.__updateSets).toContainEqual(
      expect.objectContaining({ status: "committed", committedEntryId: "existing-entry" }),
    );
    // No mention processing on the converge path (the prior commit already ran it).
    expect(mockProcessMentions).not.toHaveBeenCalled();
  });

  it("commits a fresh create_scope_draft through threadScopeVersionService", async () => {
    const action = {
      ...baseAction,
      actionType: "create_scope_draft",
      payload: { summary: "Scope summary", assumptions: ["A"], decisions: ["D"], openQuestions: ["Q"] },
    };
    const db = createSequenceDb({ selects: [[action]], updates: [[{ ...action, status: "committed" }]] });
    const createDraftFromThread = vi.fn().mockResolvedValue({
      status: "created",
      version: { id: "scope-version-1" },
    });

    const result = await threadAgentActionService(db as never, {
      compareFreshnessSnapshot: vi.fn().mockResolvedValue({ fresh: true }),
      discussions: { addEntry: vi.fn() },
      scopeVersions: { createDraftFromThread },
    }).commitThreadAgentActions({
      companyId: "company-1",
      threadId: "thread-1",
      runId: "run-1",
    });

    expect(result).toEqual({ committed: 1, suppressed: 0, blocked: 0, failed: 0, lostRace: 0 });
    expect(createDraftFromThread).toHaveBeenCalledWith(
      "company-1",
      "thread-1",
      { agentId: "agent-1", isHuman: false },
      // W2: the controller path always compiles with suppressFallbackTask (extraction
      // ran first — an empty compile must not synthesize a fake card).
      { summary: "Scope summary", assumptions: ["A"], decisions: ["D"], openQuestions: ["Q"], suppressFallbackTask: true },
    );
    expect(db.__updateSets).toContainEqual(expect.objectContaining({
      status: "committed",
      committedScopeVersionId: "scope-version-1",
    }));
  });

  it("create_scope_draft resolves assigneeRole and forwards proposedTasks", async () => {
    // Task 4: the handler must resolve each proposedTask's assigneeRole → crew agentId
    // (via resolveRoleToAgentId) and forward proposedTasks into createDraftFromThread.
    const action = {
      ...baseAction,
      actionType: "create_scope_draft",
      payload: {
        summary: "S",
        proposedTasks: [{ title: "X", assigneeRole: "engineer" }],
      },
    };
    const db = createSequenceDb({ selects: [[action]], updates: [[{ ...action, status: "committed" }]] });
    const createDraftFromThread = vi.fn().mockResolvedValue({
      status: "created",
      version: { id: "v1" },
    });
    // Mock resolver returns "agent-eng" for "engineer"
    mockResolveRoleToAgentId.mockResolvedValueOnce("agent-eng");

    const result = await threadAgentActionService(db as never, {
      compareFreshnessSnapshot: vi.fn().mockResolvedValue({ fresh: true }),
      discussions: { addEntry: vi.fn() },
      scopeVersions: { createDraftFromThread },
    }).commitThreadAgentActions({
      companyId: "company-1",
      threadId: "thread-1",
      runId: "run-1",
    });

    expect(result).toEqual({ committed: 1, suppressed: 0, blocked: 0, failed: 0, lostRace: 0 });
    expect(mockResolveRoleToAgentId).toHaveBeenCalledWith(
      expect.anything(),
      "company-1",
      "engineer",
    );
    expect(createDraftFromThread).toHaveBeenCalledWith(
      "company-1",
      "thread-1",
      { agentId: "agent-1", isHuman: false },
      expect.objectContaining({
        summary: "S",
        proposedTasks: [{ title: "X", assigneeAgentId: "agent-eng" }],
      }),
    );
  });

  it("commits a fresh add_scope_item as a draft scope item", async () => {
    const action = {
      ...baseAction,
      actionType: "add_scope_item",
      payload: {
        kind: "memory_candidate",
        title: "Architecture decision",
        content: "Use the versioned scope as the handoff.",
        layer: "active_context",
        category: "decision",
      },
    };
    const db = createSequenceDb({
      selects: [[action]],
      inserts: [[{ id: "scope-item-1" }]],
      updates: [[{ ...action, status: "committed" }]],
    });
    const createDraftFromThread = vi.fn().mockResolvedValue({
      status: "existing_draft",
      version: { id: "scope-version-1" },
    });

    const result = await threadAgentActionService(db as never, {
      compareFreshnessSnapshot: vi.fn().mockResolvedValue({ fresh: true }),
      discussions: { addEntry: vi.fn() },
      scopeVersions: { createDraftFromThread },
    }).commitThreadAgentActions({
      companyId: "company-1",
      threadId: "thread-1",
      runId: "run-1",
    });

    expect(result).toEqual({ committed: 1, suppressed: 0, blocked: 0, failed: 0, lostRace: 0 });
    expect(createDraftFromThread).toHaveBeenCalledWith(
      "company-1",
      "thread-1",
      { agentId: "agent-1", isHuman: false },
      {},
    );
    expect(db.__insertValues).toContainEqual(expect.objectContaining({
      companyId: "company-1",
      scopeVersionId: "scope-version-1",
      kind: "memory_candidate",
      title: "Architecture decision",
      description: "Use the versioned scope as the handoff.",
      payload: expect.objectContaining({ layer: "active_context", category: "decision" }),
      status: "draft",
    }));
    expect(db.__updateSets).toContainEqual(expect.objectContaining({
      status: "committed",
      committedScopeItemId: "scope-item-1",
    }));
  });

  it("claims add_scope_item before inserting the scope item", async () => {
    const action = {
      ...baseAction,
      actionType: "add_scope_item",
      payload: {
        kind: "memory_candidate",
        title: "Architecture decision",
        content: "Use the versioned scope as the handoff.",
      },
    };
    const db = createSequenceDb({
      selects: [[action]],
      updates: [
        [{ ...action, status: "committing" }],
        [{ ...action, status: "committed", committedScopeItemId: "scope-item-1" }],
      ],
      inserts: [[{ id: "scope-item-1" }]],
    });
    const createDraftFromThread = vi.fn().mockResolvedValue({
      status: "existing_draft",
      version: { id: "scope-version-1" },
    });

    const result = await threadAgentActionService(db as never, {
      compareFreshnessSnapshot: vi.fn().mockResolvedValue({ fresh: true }),
      discussions: { addEntry: vi.fn() },
      scopeVersions: { createDraftFromThread },
    }).commitThreadAgentActions({
      companyId: "company-1",
      threadId: "thread-1",
      runId: "run-1",
    });

    expect(result).toEqual({ committed: 1, suppressed: 0, blocked: 0, failed: 0, lostRace: 0 });
    expect(db.__updateSets[0]).toMatchObject({ status: "committing" });
    expect(db.__insertValues).toContainEqual(expect.objectContaining({
      kind: "memory_candidate",
      title: "Architecture decision",
    }));
  });

  it("converges (idempotent) when add_scope_item raises the source_action_id unique violation (#198)", async () => {
    // A re-commit of the SAME add_scope_item action (single-invocation partial
    // crash / reaper re-commit) must NOT create a second scope item. The
    // threadScopeItems insert raises a WRAPPED 23505 (postgres-js puts the code on
    // err.cause); the branch re-selects the existing scope item and marks the
    // action committed — no duplicate, NOT counted as failed.
    const action = {
      ...baseAction,
      actionType: "add_scope_item",
      payload: {
        kind: "memory_candidate",
        title: "Architecture decision",
        content: "Use the versioned scope as the handoff.",
      },
    };
    const db = createSequenceDb({
      selects: [
        [action], // commit selection
        [{ id: "existing-item", scopeVersionId: "scope-version-1" }], // re-select after the unique violation
      ],
      // The insert raises a wrapped 23505 → converge on the existing row.
      inserts: [
        Object.assign(new Error("duplicate key value"), {
          cause: { code: "23505", constraint_name: "thread_scope_items_source_action_uq" },
        }),
      ],
      updates: [
        [{ ...action, status: "committing" }],
        [{ ...action, status: "committed", committedScopeItemId: "existing-item" }],
      ],
    });
    const createDraftFromThread = vi.fn().mockResolvedValue({
      status: "existing_draft",
      version: { id: "scope-version-1" },
    });

    const result = await threadAgentActionService(db as never, {
      compareFreshnessSnapshot: vi.fn().mockResolvedValue({ fresh: true }),
      discussions: { addEntry: vi.fn() },
      scopeVersions: { createDraftFromThread },
    }).commitThreadAgentActions({
      companyId: "company-1",
      threadId: "thread-1",
      runId: "run-1",
    });

    // Converged, not failed.
    expect(result).toEqual({ committed: 1, suppressed: 0, blocked: 0, failed: 0, lostRace: 0 });
    expect(db.__updateSets).toContainEqual(
      expect.objectContaining({ status: "committed", committedScopeItemId: "existing-item" }),
    );
  });

  it("commits a fresh convene_agent as a queued wakeup after company validation", async () => {
    const action = {
      ...baseAction,
      actionType: "convene_agent",
      payload: {
        targetAgentId: "agent-2",
        reason: "Need planning input",
        context: { threadId: "thread-1", hopCount: 2 },
      },
    };
    const db = createSequenceDb({
      selects: [[action], [{ id: "agent-2", companyId: "company-1" }]],
      inserts: [[{ id: "wakeup-1" }]],
      updates: [[{ ...action, status: "committed" }]],
    });

    const result = await threadAgentActionService(db as never, {
      compareFreshnessSnapshot: vi.fn().mockResolvedValue({ fresh: true }),
      discussions: { addEntry: vi.fn() },
      scopeVersions: { createDraftFromThread: vi.fn() },
    }).commitThreadAgentActions({
      companyId: "company-1",
      threadId: "thread-1",
      runId: "run-1",
    });

    expect(result).toEqual({ committed: 1, suppressed: 0, blocked: 0, failed: 0, lostRace: 0 });
    expect(db.__insertValues).toContainEqual(expect.objectContaining({
      companyId: "company-1",
      agentId: "agent-2",
      source: "agent.dispatch",
      reason: "Need planning input",
      payload: { threadId: "thread-1", hopCount: 2 },
      // PR-B2: dedupKey is now discriminated by the STABLE sourceActionId (action.id),
      // not target+thread alone, so distinct convene actions both enqueue while a
      // same-action commit race collapses. baseAction.id === "action-1".
      dedupKey: buildConveneWakeupDedupKey({
        targetAgentId: "agent-2",
        threadId: "thread-1",
        sourceActionId: "action-1",
      }),
      status: "queued",
    }));
    expect(db.__updateSets).toContainEqual(expect.objectContaining({
      status: "committed",
    }));
  });

  it("commits a fresh create_artifact_candidate as an artifact link scope item", async () => {
    const action = {
      ...baseAction,
      actionType: "create_artifact_candidate",
      payload: {
        title: "Onboarding plan",
        artifactType: "document",
        content: "# Plan",
        fileRef: null,
        discussionId: "thread-1",
        attachToEntryId: "entry-3",
      },
    };
    const db = createSequenceDb({
      // 2nd select is the attachToEntryId in-thread validation lookup.
      selects: [[action], [{ id: "entry-3" }]],
      inserts: [[{ id: "scope-item-artifact" }]],
      updates: [[{ ...action, status: "committed" }]],
    });
    const createDraftFromThread = vi.fn().mockResolvedValue({
      status: "existing_draft",
      version: { id: "scope-version-1" },
    });
    const createArtifact = vi.fn().mockResolvedValue({
      id: "artifact-1",
      versions: [{ id: "artifact-version-1" }],
    });

    const result = await threadAgentActionService(db as never, {
      compareFreshnessSnapshot: vi.fn().mockResolvedValue({ fresh: true }),
      discussions: { addEntry: vi.fn() },
      scopeVersions: { createDraftFromThread },
      artifacts: { create: createArtifact },
    }).commitThreadAgentActions({
      companyId: "company-1",
      threadId: "thread-1",
      runId: "run-1",
    });

    expect(result).toEqual({ committed: 1, suppressed: 0, blocked: 0, failed: 0, lostRace: 0 });
    expect(createArtifact).toHaveBeenCalledWith(
      "company-1",
      "agent-1",
      expect.objectContaining({
        title: "Onboarding plan",
        type: "document",
        source: "agent",
        content: "# Plan",
        fileUrl: null,
        storageKind: "inline",
        // #197: the action id is stamped so the partial unique index dedups re-commits.
        sourceActionId: "action-1",
      }),
    );
    expect(db.__insertValues).toContainEqual(expect.objectContaining({
      companyId: "company-1",
      scopeVersionId: "scope-version-1",
      kind: "artifact_link",
      title: "Onboarding plan",
      description: "Artifact candidate created by agent",
      artifactId: "artifact-1",
      artifactVersionId: "artifact-version-1",
      status: "draft",
    }));
    expect(db.__updateSets).toContainEqual(expect.objectContaining({
      status: "committed",
      committedScopeVersionId: "scope-version-1",
      committedScopeItemId: "scope-item-artifact",
    }));
  });

  it("commits an asset-backed create_artifact_candidate with preserved asset metadata", async () => {
    const action = {
      ...baseAction,
      actionType: "create_artifact_candidate",
      payload: {
        title: "Brand deck",
        artifactType: "design",
        content: null,
        fileRef: null,
        discussionId: "thread-1",
        storageKind: "asset",
        assetId: "asset-1",
        filename: "deck.pdf",
        contentType: "application/pdf",
        extension: "pdf",
        byteSize: 1024,
        sha256: "hash-1",
      },
    };
    const db = createSequenceDb({
      selects: [[action]],
      inserts: [[{ id: "scope-item-artifact" }]],
      updates: [[{ ...action, status: "committed" }]],
    });
    const createDraftFromThread = vi.fn().mockResolvedValue({
      status: "existing_draft",
      version: { id: "scope-version-1" },
    });
    const createArtifact = vi.fn().mockResolvedValue({
      id: "artifact-1",
      versions: [{ id: "artifact-version-1" }],
    });

    const result = await threadAgentActionService(db as never, {
      compareFreshnessSnapshot: vi.fn().mockResolvedValue({ fresh: true }),
      discussions: { addEntry: vi.fn() },
      scopeVersions: { createDraftFromThread },
      artifacts: { create: createArtifact },
    }).commitThreadAgentActions({
      companyId: "company-1",
      threadId: "thread-1",
      runId: "run-1",
    });

    expect(result).toEqual({ committed: 1, suppressed: 0, blocked: 0, failed: 0, lostRace: 0 });
    expect(createArtifact).toHaveBeenCalledWith(
      "company-1",
      "agent-1",
      expect.objectContaining({
        title: "Brand deck",
        type: "design",
        source: "agent",
        content: null,
        fileUrl: null,
        storageKind: "asset",
        assetId: "asset-1",
        filename: "deck.pdf",
        contentType: "application/pdf",
        extension: "pdf",
        byteSize: 1024,
        sha256: "hash-1",
        sourceActionId: "action-1",
      }),
    );
  });

  it("converges (idempotent) when create_artifact_candidate raises the source_action_id unique violation (#197)", async () => {
    // A re-commit of the SAME artifact action must NOT create a second artifact.
    // txArtifacts.create raises a WRAPPED 23505; the tx rolls back and the branch
    // re-selects the existing artifact + its scope item and converges — no
    // duplicate, NOT counted as failed.
    const action = {
      ...baseAction,
      actionType: "create_artifact_candidate",
      payload: { title: "Onboarding plan", artifactType: "document", content: "# Plan" },
    };
    const db = createSequenceDb({
      selects: [
        [action], // commit selection
        [{ id: "existing-artifact" }], // re-select artifact by (company, source_action_id)
        [{ id: "existing-item", scopeVersionId: "scope-version-1" }], // re-select its scope item
      ],
      updates: [
        [{ ...action, status: "committing" }],
        [{ ...action, status: "committed" }],
      ],
    });
    // postgres-js emits the index name on `cause.constraint_name` (the REAL shape).
    const wrapped = Object.assign(new Error("duplicate key value"), {
      cause: { code: "23505", constraint_name: "artifacts_source_action_uq" },
    });
    const createArtifact = vi.fn().mockRejectedValueOnce(wrapped);

    const result = await threadAgentActionService(db as never, {
      compareFreshnessSnapshot: vi.fn().mockResolvedValue({ fresh: true }),
      discussions: { addEntry: vi.fn() },
      scopeVersions: {
        createDraftFromThread: vi.fn().mockResolvedValue({
          status: "existing_draft",
          version: { id: "scope-version-1" },
        }),
      },
      artifacts: { create: createArtifact },
    }).commitThreadAgentActions({
      companyId: "company-1",
      threadId: "thread-1",
      runId: "run-1",
    });

    expect(result).toEqual({ committed: 1, suppressed: 0, blocked: 0, failed: 0, lostRace: 0 });
    expect(createArtifact).toHaveBeenCalledTimes(1);
    expect(db.__updateSets).toContainEqual(
      expect.objectContaining({
        status: "committed",
        committedScopeVersionId: "scope-version-1",
        committedScopeItemId: "existing-item",
      }),
    );
  });

  it("a re-proposed post_reply with the SAME stable key returns the existing action, not a new row (cross-run dedup)", async () => {
    // End-to-end of the headline guarantee at the propose layer: run-2 re-proposes
    // the identical reply; the stable key collides on (companyId, idempotencyKey) so
    // onConflictDoNothing inserts nothing and the existing (already committed) row is
    // returned. Since it is `committed`, the commit (which selects only proposed /
    // retryable failed) will not re-run the side effect — no duplicate.
    const key = buildPostReplyIdempotencyKey({
      threadId: "thread-1",
      agentId: "agent-1",
      parentEntryId: null,
      content: "Status: green.",
      turnAnchor: "5",
    });
    const existingCommitted = { ...baseAction, id: "existing-committed", status: "committed", idempotencyKey: key };
    const db = createSequenceDb({
      selects: [[thread], [existingCommitted]], // thread check, then re-select on conflict
      inserts: [[]], // onConflictDoNothing → no row (key already exists from run-1)
    });

    const result = await threadAgentActionService(db as never).proposeThreadAction({
      companyId: "company-1",
      threadId: "thread-1",
      runId: "run-2",
      agentId: "agent-1",
      actionType: "post_reply",
      payload: { rawContent: "Status: green." },
      idempotencyKey: key,
    });

    expect(result).toEqual(existingCommitted);
    expect((result as { status: string }).status).toBe("committed");
  });

  it("claims create_artifact_candidate before creating artifact and scope item side effects", async () => {
    const action = {
      ...baseAction,
      actionType: "create_artifact_candidate",
      payload: {
        title: "Onboarding plan",
        artifactType: "document",
        content: "# Plan",
      },
    };
    const db = createSequenceDb({
      selects: [[action]],
      updates: [
        [{ ...action, status: "committing" }],
        [{ ...action, status: "committed", committedScopeItemId: "scope-item-artifact" }],
      ],
      inserts: [[{ id: "scope-item-artifact" }]],
    });
    const createArtifact = vi.fn().mockResolvedValue({
      id: "artifact-1",
      versions: [{ id: "artifact-version-1" }],
    });

    const result = await threadAgentActionService(db as never, {
      compareFreshnessSnapshot: vi.fn().mockResolvedValue({ fresh: true }),
      discussions: { addEntry: vi.fn() },
      scopeVersions: {
        createDraftFromThread: vi.fn().mockResolvedValue({
          status: "existing_draft",
          version: { id: "scope-version-1" },
        }),
      },
      artifacts: { create: createArtifact },
    }).commitThreadAgentActions({
      companyId: "company-1",
      threadId: "thread-1",
      runId: "run-1",
    });

    expect(result).toEqual({ committed: 1, suppressed: 0, blocked: 0, failed: 0, lostRace: 0 });
    expect(db.__updateSets[0]).toMatchObject({ status: "committing" });
    expect(createArtifact).toHaveBeenCalledTimes(1);
    expect(db.__insertValues).toContainEqual(expect.objectContaining({
      kind: "artifact_link",
      artifactId: "artifact-1",
    }));
  });

  it("suppresses a remaining action whose freshness goes stale mid-loop", async () => {
    // Per-action freshness re-check (fix: freshness was checked once pre-loop).
    // The artifact action commits and self-mutates the scope; the reply action,
    // evaluated AFTER that mutation, is now stale and must be suppressed — not
    // committed against a thread the human has since moved past.
    const artifactAction = {
      ...baseAction,
      id: "action-artifact",
      actionType: "create_artifact_candidate",
      payload: {
        title: "Discussion scope notes",
        artifactType: "document",
        content: "# Notes",
      },
    };
    const replyAction = {
      ...baseAction,
      id: "action-reply",
      actionType: "post_reply",
      payload: {
        rawContent: "I created discussion-scope-notes.md and attached it to the scope draft.",
      },
    };
    const db = createSequenceDb({
      selects: [[artifactAction, replyAction]],
      inserts: [[{ id: "scope-item-artifact" }]],
      updates: [
        [{ ...artifactAction, status: "committing" }], // artifact claim (fenced CAS, now first)
        [{ ...artifactAction, status: "committed" }], // artifact final updateActionStatus
        [{ ...replyAction, status: "committing" }], // reply claim — now happens BEFORE the freshness re-check (Codex round-7 reorder)
        [{ ...replyAction, status: "suppressed_stale" }], // reply suppress (claimed row we own)
      ],
    });
    let scopeMutated = false;
    const compareFreshnessSnapshot = vi.fn(async () => (
      scopeMutated
        ? { fresh: false, reason: "newer_scope_version" }
        : { fresh: true }
    ));
    const createDraftFromThread = vi.fn(async () => {
      scopeMutated = true;
      return {
        status: "created",
        version: { id: "scope-version-1" },
      };
    });
    const createArtifact = vi.fn().mockResolvedValue({
      id: "artifact-1",
      versions: [{ id: "artifact-version-1" }],
    });
    const addEntry = vi.fn().mockResolvedValue({ id: "entry-committed" });

    const result = await threadAgentActionService(db as never, {
      compareFreshnessSnapshot,
      discussions: { addEntry },
      scopeVersions: { createDraftFromThread },
      artifacts: { create: createArtifact },
    }).commitThreadAgentActions({
      companyId: "company-1",
      threadId: "thread-1",
      runId: "run-1",
    });

    expect(result).toEqual({ committed: 1, suppressed: 1, blocked: 0, failed: 0, lostRace: 0 });
    expect(compareFreshnessSnapshot).toHaveBeenCalledTimes(2);
    expect(createArtifact).toHaveBeenCalled();
    // The stale reply must NOT have been posted.
    expect(addEntry).not.toHaveBeenCalled();
    expect(db.__updateSets).toContainEqual(expect.objectContaining({
      status: "committed",
      committedScopeItemId: "scope-item-artifact",
    }));
    expect(db.__updateSets).toContainEqual(expect.objectContaining({
      status: "suppressed_stale",
      blockedReason: "newer_scope_version",
    }));
  });

  it("attaches same-run artifact candidates to the same-run agent reply", async () => {
    const artifactAction = {
      ...baseAction,
      id: "action-artifact",
      actionType: "create_artifact_candidate",
      payload: {
        title: "Discussion scope notes",
        artifactType: "document",
        content: "# Notes",
      },
    };
    const replyAction = {
      ...baseAction,
      id: "action-reply",
      actionType: "post_reply",
      payload: {
        rawContent: "I created discussion-scope-notes.md.",
      },
    };
    const db = createSequenceDb({
      selects: [[artifactAction, replyAction]],
      inserts: [[{ id: "scope-item-artifact" }], [{ id: "attachment-1" }]],
      // PR-B fenced CAS: each action now issues a claim UPDATE ... RETURNING (which
      // must return the row to win) BEFORE its final committed UPDATE — so the
      // sequence interleaves claim + committed per action.
      updates: [
        [{ ...artifactAction, status: "committing" }], // artifact claim
        [{ ...artifactAction, status: "committed" }], // artifact committed
        [{ ...replyAction, status: "committing" }], // reply claim
        [{ ...replyAction, status: "committed" }], // reply committed
      ],
    });
    const addEntry = vi.fn().mockResolvedValue({ id: "entry-committed" });

    const result = await threadAgentActionService(db as never, {
      compareFreshnessSnapshot: vi.fn().mockResolvedValue({ fresh: true }),
      discussions: { addEntry },
      scopeVersions: {
        createDraftFromThread: vi.fn().mockResolvedValue({
          status: "created",
          version: { id: "scope-version-1" },
        }),
      },
      artifacts: {
        create: vi.fn().mockResolvedValue({
          id: "artifact-1",
          versions: [{ id: "artifact-version-1" }],
        }),
      },
    }).commitThreadAgentActions({
      companyId: "company-1",
      threadId: "thread-1",
      runId: "run-1",
    });

    expect(result).toEqual({ committed: 2, suppressed: 0, blocked: 0, failed: 0, lostRace: 0 });
    expect(db.__insertValues).toContainEqual(expect.objectContaining({
      discussionEntryId: "entry-committed",
      artifactId: "artifact-1",
    }));
  });

  it("commits a fresh advance_phase action only when queued from Drive autonomy", async () => {
    const action = {
      ...baseAction,
      actionType: "advance_phase",
      payload: {
        toPhase: "assign",
        effectiveAutonomy: 2,
      },
    };
    const db = createSequenceDb({
      selects: [[action]],
      updates: [[{ ...action, status: "committed" }]],
    });
    const advancePhase = vi.fn().mockResolvedValue(undefined);

    const result = await threadAgentActionService(db as never, {
      compareFreshnessSnapshot: vi.fn().mockResolvedValue({ fresh: true }),
      discussions: { addEntry: vi.fn() },
      scopeVersions: { createDraftFromThread: vi.fn() },
      threads: { advancePhase },
    }).commitThreadAgentActions({
      companyId: "company-1",
      threadId: "thread-1",
      runId: "run-1",
    });

    expect(result).toEqual({ committed: 1, suppressed: 0, blocked: 0, failed: 0, lostRace: 0 });
    expect(advancePhase).toHaveBeenCalledWith(
      "company-1",
      "thread-1",
      "assign",
      { userId: "agent-1", role: "team_member", isHuman: false },
    );
    expect(db.__updateSets).toContainEqual(expect.objectContaining({
      status: "committed",
    }));
  });

  it("blocks a fresh advance_phase action queued below Drive autonomy", async () => {
    const action = {
      ...baseAction,
      actionType: "advance_phase",
      payload: {
        toPhase: "assign",
        effectiveAutonomy: 1,
      },
    };
    const db = createSequenceDb({
      selects: [[action]],
      updates: [[{ ...action, status: "blocked_policy" }]],
    });
    const advancePhase = vi.fn();

    const result = await threadAgentActionService(db as never, {
      compareFreshnessSnapshot: vi.fn().mockResolvedValue({ fresh: true }),
      discussions: { addEntry: vi.fn() },
      scopeVersions: { createDraftFromThread: vi.fn() },
      threads: { advancePhase },
    }).commitThreadAgentActions({
      companyId: "company-1",
      threadId: "thread-1",
      runId: "run-1",
    });

    expect(result).toEqual({ committed: 0, suppressed: 0, blocked: 1, failed: 0, lostRace: 0 });
    expect(advancePhase).not.toHaveBeenCalled();
    expect(db.__updateSets).toContainEqual(expect.objectContaining({
      status: "blocked_policy",
      blockedReason: "autonomy_insufficient",
    }));
  });

  it("marks a transiently failing action failed and bumps its attempt counter", async () => {
    // Fix (c): a per-action side-effect throw must set status=failed AND bump
    // attempt_count so the row is re-selectable on the next tick under its cap.
    const action = {
      ...baseAction,
      actionType: "post_reply",
      attemptCount: 0,
      maxAttempts: 3,
    };
    const db = createSequenceDb({
      selects: [[action]],
      updates: [
        [{ ...action, status: "committing" }],
        [{ ...action, status: "failed" }],
      ],
    });
    const addEntry = vi.fn().mockRejectedValue(new Error("transient connection drop"));

    const result = await threadAgentActionService(db as never, {
      compareFreshnessSnapshot: vi.fn().mockResolvedValue({ fresh: true }),
      discussions: { addEntry },
      scopeVersions: { createDraftFromThread: vi.fn() },
    }).commitThreadAgentActions({
      companyId: "company-1",
      threadId: "thread-1",
      runId: "run-1",
    });

    expect(result).toEqual({ committed: 0, suppressed: 0, blocked: 0, failed: 1, lostRace: 0 });
    // The failure update carries both status=failed and an attemptCount bump.
    const failedSet = db.__updateSets.find(
      (s) => (s as Record<string, unknown>).status === "failed",
    ) as Record<string, unknown>;
    expect(failedSet).toBeDefined();
    expect(failedSet.blockedReason).toBe("transient connection drop");
    expect(failedSet.attemptCount).toBeDefined();
  });

  it("re-selects a still-retryable failed row and can commit it", async () => {
    // Fix (c): the commit SELECT picks up "failed" rows under the attempt cap, so
    // a previously transient failure is retried (and now succeeds).
    const failedRetryable = {
      ...baseAction,
      actionType: "post_reply",
      status: "failed",
      attemptCount: 1,
      maxAttempts: 3,
    };
    const db = createSequenceDb({
      selects: [[failedRetryable]],
      updates: [
        [{ ...failedRetryable, status: "committing" }],
        [{ ...failedRetryable, status: "committed", committedEntryId: "entry-retry" }],
      ],
    });
    const addEntry = vi.fn().mockResolvedValue({ id: "entry-retry" });

    const result = await threadAgentActionService(db as never, {
      compareFreshnessSnapshot: vi.fn().mockResolvedValue({ fresh: true }),
      discussions: { addEntry },
      scopeVersions: { createDraftFromThread: vi.fn() },
    }).commitThreadAgentActions({
      companyId: "company-1",
      threadId: "thread-1",
      runId: "run-1",
    });

    expect(result).toEqual({ committed: 1, suppressed: 0, blocked: 0, failed: 0, lostRace: 0 });
    expect(addEntry).toHaveBeenCalledTimes(1);
  });

  it("leaves no orphan artifact when the scope draft is unavailable (transaction rollback)", async () => {
    // Fix (e): create_artifact_candidate wraps artifact+draft+item+attach in ONE
    // transaction with the draft resolved FIRST. When the draft is unavailable
    // the transaction aborts before the artifact is created — no orphan remains.
    const action = {
      ...baseAction,
      actionType: "create_artifact_candidate",
      payload: { title: "Orphan candidate", artifactType: "document", content: "# X" },
    };
    const db = createSequenceDb({
      selects: [[action]],
      updates: [
        [{ ...action, status: "committing" }],
        [{ ...action, status: "blocked_policy" }],
      ],
    });
    // Draft resolves with NO version → "scope_draft_unavailable".
    const createDraftFromThread = vi.fn().mockResolvedValue({ status: "no_entries" });
    const createArtifact = vi.fn().mockResolvedValue({
      id: "artifact-orphan",
      versions: [{ id: "v1" }],
    });

    const result = await threadAgentActionService(db as never, {
      compareFreshnessSnapshot: vi.fn().mockResolvedValue({ fresh: true }),
      discussions: { addEntry: vi.fn() },
      scopeVersions: { createDraftFromThread },
      artifacts: { create: createArtifact },
    }).commitThreadAgentActions({
      companyId: "company-1",
      threadId: "thread-1",
      runId: "run-1",
    });

    expect(result).toEqual({ committed: 0, suppressed: 0, blocked: 1, failed: 0, lostRace: 0 });
    // The artifact must NOT have been created — the draft was resolved first and
    // its absence aborted the transaction before artifactCommitter.create ran.
    expect(createArtifact).not.toHaveBeenCalled();
    expect(db.__updateSets).toContainEqual(expect.objectContaining({
      status: "blocked_policy",
      blockedReason: "scope_draft_unavailable",
    }));
  });

  it("rejects create_artifact_candidate when attachToEntryId points at another thread", async () => {
    // Fix (minor): the caller-supplied attach target must belong to THIS thread.
    // A forged cross-thread entry id is rejected up front (no artifact created).
    const action = {
      ...baseAction,
      actionType: "create_artifact_candidate",
      payload: {
        title: "Cross-thread candidate",
        artifactType: "document",
        content: "# X",
        attachToEntryId: "entry-from-other-thread",
      },
    };
    const db = createSequenceDb({
      // 2nd select is the in-thread validation lookup → empty (entry not in thread).
      selects: [[action], []],
      updates: [
        [{ ...action, status: "committing" }],
        [{ ...action, status: "blocked_policy" }],
      ],
    });
    const createArtifact = vi.fn();
    const createDraftFromThread = vi.fn();

    const result = await threadAgentActionService(db as never, {
      compareFreshnessSnapshot: vi.fn().mockResolvedValue({ fresh: true }),
      discussions: { addEntry: vi.fn() },
      scopeVersions: { createDraftFromThread },
      artifacts: { create: createArtifact },
    }).commitThreadAgentActions({
      companyId: "company-1",
      threadId: "thread-1",
      runId: "run-1",
    });

    expect(result).toEqual({ committed: 0, suppressed: 0, blocked: 1, failed: 0, lostRace: 0 });
    // No side effects ran — neither the artifact nor the scope draft were touched.
    expect(createArtifact).not.toHaveBeenCalled();
    expect(createDraftFromThread).not.toHaveBeenCalled();
    expect(db.__updateSets).toContainEqual(expect.objectContaining({
      status: "blocked_policy",
      blockedReason: "attach_target_not_in_thread",
    }));
  });
});

describe("reapStaleThreadAgentActions", () => {
  function createReaperDb(reapedRows: unknown[]) {
    const updateSets: unknown[] = [];
    const whereArgs: unknown[] = [];
    const db = {
      update: () => {
        const chain: Record<string, unknown> = {};
        chain.set = (arg: unknown) => {
          updateSets.push(arg);
          return chain;
        };
        chain.where = (arg: unknown) => {
          whereArgs.push(arg);
          return chain;
        };
        chain.returning = () => Promise.resolve(reapedRows);
        return chain;
      },
      __updateSets: updateSets,
      __whereArgs: whereArgs,
    };
    return db;
  }

  it("flips a stale committing row to failed, bumps attempt, and counts it", async () => {
    const db = createReaperDb([{ id: "stale-1" }, { id: "stale-2" }]);

    const result = await reapStaleThreadAgentActions(db as never, {
      ttlMs: 10 * 60 * 1000,
      now: new Date("2026-06-17T12:00:00Z"),
    });

    expect(result).toEqual({ reaped: 2 });
    const set = db.__updateSets[0] as Record<string, unknown>;
    expect(set.status).toBe("failed");
    expect(set.blockedReason).toBe("reaped_stale_committing");
    expect(set.attemptCount).toBeDefined();
  });

  it("reports zero when no stale rows match", async () => {
    const db = createReaperDb([]);

    const result = await reapStaleThreadAgentActions(db as never);

    expect(result).toEqual({ reaped: 0 });
  });
});
