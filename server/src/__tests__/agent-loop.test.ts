import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────
//
// agent-loop.ts depends on:
//  - drizzle-orm `eq` (only used to build the config WHERE clause)
//  - @armyofagents/db `internalAgentConfig` (a table object passed to
//    db.select().from(...).where(...))
//  - ./conversation.js `conversationService` — getOrCreateActive + appendMessage
//  - ./cli-mode.js `cliModeService` — the streamed CLI turn
//
// MX-chatpersist asserts the agent-loop layer (which OWNS the conversation)
// persists the assistant turn. We mock conversationService + cliModeService
// and drive scripted streams; the DB is a tiny sequence stub for the config
// SELECT only.

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  and: vi.fn((...args: unknown[]) => args),
  ne: vi.fn((a: unknown, b: unknown) => ({ ne: [a, b] })),
  sql: Object.assign(
    vi.fn((strings: any, ...values: any[]) => ({ sql: strings, values })),
    { raw: vi.fn((input: any) => input) },
  ),
}));

vi.mock("@armyofagents/db", () => ({
  internalAgentConfig: { __table: "internal_agent_config", companyId: Symbol("companyId") },
  agents: { __table: "agents", id: "id", companyId: "companyId", name: "name", adapterConfig: "adapterConfig" },
}));

const appendMessage = vi.fn(async () => ({ id: "msg" }));
const getOrCreateActive = vi.fn(async () => ({ id: "conv-1" }));
const getById = vi.fn(async () => ({ id: "conv-1", companyId: "co-1", userId: "user-1" }));
const getMessageByClientSubmissionId = vi.fn(async () => null as any);
const getAssistantReplyForUserMessage = vi.fn(async () => null as any);
// PR #291 round-6/7: the durable turn claim CAS + lease + release. claimTurn
// returns an owner token (or null when lost); finishTurn/heartbeatTurn take it.
const claimTurn = vi.fn(async () => "tok-1" as string | null);
const finishTurn = vi.fn(async () => undefined);
const heartbeatTurn = vi.fn(async () => undefined);
vi.mock("../services/internal-agent/conversation.js", () => ({
  conversationService: vi.fn(() => ({
    getOrCreateActive,
    getById,
    appendMessage,
    getMessageByClientSubmissionId,
    getAssistantReplyForUserMessage,
    claimTurn,
    finishTurn,
    heartbeatTurn,
  })),
  COMMANDER_TURN_HEARTBEAT_MS: 60_000,
}));

const cliChat = vi.fn();
vi.mock("../services/internal-agent/cli-mode.js", () => ({
  cliModeService: vi.fn(() => ({ chat: cliChat })),
}));

// ── Sprint 1 additions — mock to prevent company-skills → projects → heartbeat chain ──
vi.mock("../services/company-skills.js", () => ({
  companySkillService: vi.fn(() => ({
    listCompactSkillEntries: vi.fn(async () => []),
  })),
}));
vi.mock("../services/internal-agent/commander-skills.js", () => ({
  buildCompactSkillList: vi.fn(async () => null),
}));

// ── Pre-Sprint-1 services added to agent-loop.ts but not mocked in this test ──
vi.mock("../services/internal-agent/context-assembly.js", () => ({
  contextAssemblyService: vi.fn(() => ({
    assembleContext: vi.fn(async () => ({ systemPrompt: "" })),
  })),
}));
vi.mock("../services/internal-agent/commander-context.js", () => ({
  loadCommanderPersona: vi.fn(async () => null),
}));
vi.mock("../services/internal-agent/aoa-agents/ensure-commander.js", () => ({
  ensureCommanderAgent: vi.fn(async () => "commander-id"),
}));
vi.mock("../services/internal-agent/cli-summarizer.js", () => ({
  summarizeViaCli: vi.fn(async () => ""),
}));
vi.mock("../services/memory.js", () => ({
  memoryService: vi.fn(() => ({
    searchSemantic: vi.fn(async () => []),
  })),
}));
vi.mock("../services/agent-instructions.js", () => ({
  agentInstructionsService: vi.fn(() => ({})),
}));
const assetGetById = vi.fn(async () => null as any);
vi.mock("../services/assets.js", () => ({
  assetService: vi.fn(() => ({ getById: assetGetById })),
}));

import { Readable } from "node:stream";
import { agentLoopService } from "../services/internal-agent/agent-loop.js";

// ── Helpers ────────────────────────────────────────────────────────────────

/** A db stub whose select()...where() resolves to the configured config row. */
function dbWithConfig(configRow: unknown) {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "where"]) chain[m] = () => chain;
  chain.then = (resolve: (v: unknown[]) => unknown) =>
    Promise.resolve(resolve(configRow == null ? [] : [configRow]));
  return { select: () => chain } as any;
}

function scriptStream(chunks: unknown[]) {
  cliChat.mockImplementation(async function* () {
    for (const c of chunks) yield c;
  });
}

const BASE_PARAMS = {
  companyId: "co-1",
  userId: "user-1",
  userRole: "founder",
  enabledCapabilities: [] as string[],
  content: "what is up",
};

async function drain(svc: ReturnType<typeof agentLoopService>) {
  const out: any[] = [];
  for await (const chunk of svc.chat({ ...BASE_PARAMS } as any)) out.push(chunk);
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  getOrCreateActive.mockResolvedValue({ id: "conv-1" });
  appendMessage.mockResolvedValue({ id: "msg" });
  getById.mockResolvedValue({ id: "conv-1", companyId: "co-1", userId: "user-1" });
  getMessageByClientSubmissionId.mockResolvedValue(null);
  getAssistantReplyForUserMessage.mockResolvedValue(null);
  claimTurn.mockResolvedValue("tok-1");
  finishTurn.mockResolvedValue(undefined);
  heartbeatTurn.mockResolvedValue(undefined);
});

describe("agentLoopService.chat — runtime attachment delivery (text)", () => {
  it("delivers a company-owned text file's content into the turn shown to the model", async () => {
    assetGetById.mockResolvedValue({
      companyId: "co-1",
      contentType: "text/plain",
      objectKey: "k/notes.txt",
      originalFilename: "notes.txt",
      byteSize: 14,
      composerValidated: true,
    });
    scriptStream([
      { type: "text", delta: "ok" },
      { type: "done", summary: { runId: "", toolsCalled: [], durationMs: 0, costCents: 0, tokenUsage: { inputTokens: 0, outputTokens: 0 } } },
    ]);
    const storage = {
      getObject: vi.fn(async () => ({ stream: Readable.from([Buffer.from("SECRET-CONTENT")]) })),
    };
    const svc = agentLoopService(dbWithConfig({ cliTool: "claude_cli", executionMode: "cli" }), storage);
    for await (const _ of svc.chat({ ...BASE_PARAMS, attachmentAssetIds: ["a1"] } as any)) { void _; }

    const cliParams = cliChat.mock.calls[0][0];
    // The file content + filename ride with the user turn (content/rawContent),
    // whichever channel the adapter split uses — never the persisted message row.
    const turnText = `${cliParams.content ?? ""}\n${cliParams.rawContent ?? ""}`;
    expect(turnText).toContain("SECRET-CONTENT");
    expect(turnText).toContain("notes.txt");
    const persistedUser = appendMessage.mock.calls.find((c) => (c[1] as any).role === "user");
    expect((persistedUser?.[1] as any).content).toBe("what is up");
  });

  it("discloses an image as stored-only and never reads its bytes", async () => {
    assetGetById.mockResolvedValue({
      companyId: "co-1",
      contentType: "image/png",
      objectKey: "k/pic.png",
      originalFilename: "pic.png",
      byteSize: 100,
      composerValidated: true,
    });
    scriptStream([
      { type: "text", delta: "ok" },
      { type: "done", summary: { runId: "", toolsCalled: [], durationMs: 0, costCents: 0, tokenUsage: { inputTokens: 0, outputTokens: 0 } } },
    ]);
    const getObject = vi.fn(async () => ({ stream: Readable.from([Buffer.from("PNGBYTES")]) }));
    const svc = agentLoopService(dbWithConfig({ cliTool: "claude_cli", executionMode: "cli" }), { getObject });
    for await (const _ of svc.chat({ ...BASE_PARAMS, attachmentAssetIds: ["a1"] } as any)) { void _; }

    const cliParams = cliChat.mock.calls[0][0];
    const turnText = `${cliParams.content ?? ""}\n${cliParams.rawContent ?? ""}`;
    expect(turnText).toContain("pic.png");
    expect(turnText.toLowerCase()).toMatch(/not readable|stored/);
    expect(turnText).not.toContain("PNGBYTES");
    expect(getObject).not.toHaveBeenCalled();
  });
});

describe("agentLoopService.chat — idempotent retry (clientSubmissionId)", () => {
  async function drainWithKey(svc: ReturnType<typeof agentLoopService>, key: string) {
    const out: any[] = [];
    for await (const chunk of svc.chat({ ...BASE_PARAMS, conversationId: "conv-1", clientSubmissionId: key } as any)) {
      out.push(chunk);
    }
    return out;
  }

  it("replays the original assistant reply and does NOT persist a new message or run the CLI", async () => {
    // The key was already recorded → this is a retry.
    getMessageByClientSubmissionId.mockResolvedValue({ id: "user-orig", createdAt: new Date(0) });
    getAssistantReplyForUserMessage.mockResolvedValue({ id: "asst-orig", content: "Original answer" });

    const svc = agentLoopService(dbWithConfig({ cliTool: "claude_cli", executionMode: "cli" }));
    const out = await drainWithKey(svc, "sub-42");

    // Streamed the original reply back to the caller…
    expect(out).toEqual([{ type: "run_skipped" }, { type: "text", delta: "Original answer" }]);
    // …without persisting a duplicate user message or starting a CLI turn.
    expect(appendMessage).not.toHaveBeenCalled();
    expect(cliChat).not.toHaveBeenCalled();
    // C2: the replay is looked up by explicit user-turn linkage, not by timestamp.
    expect(getAssistantReplyForUserMessage).toHaveBeenCalledWith("conv-1", "user-orig");
  });

  it("re-runs turn A (does NOT replay a later turn B's reply) when A's send died before replying — C2", async () => {
    // A persisted its user row but crashed before replying; a LATER turn B then
    // completed. Retrying A must re-run A, never return B's reply. The linkage
    // lookup returns null for A (B's reply is linked to user-B), so A re-runs.
    // The old timestamp heuristic ("first assistant after A") would wrongly
    // surface B's reply and permanently suppress A.
    getMessageByClientSubmissionId.mockResolvedValue({ id: "user-A", createdAt: new Date(0) });
    getAssistantReplyForUserMessage.mockImplementation(async (_conv: string, userId: string) =>
      userId === "user-B" ? { id: "asst-B", content: "B's answer" } : null,
    );
    scriptStream([
      { type: "text", delta: "A's fresh answer" },
      { type: "done", summary: { runId: "", toolsCalled: [], durationMs: 0, costCents: 0, tokenUsage: { inputTokens: 0, outputTokens: 0 } } },
    ]);

    const svc = agentLoopService(dbWithConfig({ cliTool: "claude_cli", executionMode: "cli" }));
    const out = await drainWithKey(svc, "sub-A");

    // A re-ran; B's reply was never streamed.
    expect(cliChat).toHaveBeenCalledTimes(1);
    expect(out.some((c) => c.type === "text" && c.delta === "A's fresh answer")).toBe(true);
    expect(out.some((c) => c.type === "text" && c.delta === "B's answer")).toBe(false);
    // The recovered reply is back-linked to A's user turn.
    const assistantCall = appendMessage.mock.calls.find((c) => (c[1] as any).role === "assistant");
    expect((assistantCall?.[1] as any).replyToUserMessageId).toBe("user-A");
  });

  it("claims the submission key: a lost insert race does NOT start a second CLI turn — C3", async () => {
    // Two same-key requests both miss the initial lookup; this one loses the
    // unique-index race so appendMessage returns undefined. It must NOT run the
    // CLI; instead it replays the winner's reply if present.
    getMessageByClientSubmissionId
      .mockResolvedValueOnce(null) // initial lookup: no row yet
      .mockResolvedValue({ id: "user-winner", createdAt: new Date(0) }); // after lost race: winner exists
    appendMessage.mockResolvedValueOnce(undefined as any); // lost the insert race
    getAssistantReplyForUserMessage.mockResolvedValue({ id: "asst-winner", content: "Winner answer" });

    const svc = agentLoopService(dbWithConfig({ cliTool: "claude_cli", executionMode: "cli" }));
    const out = await drainWithKey(svc, "sub-race");

    expect(cliChat).not.toHaveBeenCalled();
    expect(out).toEqual([{ type: "run_skipped" }, { type: "text", delta: "Winner answer" }]);
  });

  it("claims the submission key: lost race with no winner reply yet reports in-progress, no CLI — C3", async () => {
    getMessageByClientSubmissionId
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ id: "user-winner", createdAt: new Date(0) });
    appendMessage.mockResolvedValueOnce(undefined as any); // lost the insert race
    getAssistantReplyForUserMessage.mockResolvedValue(null); // winner still running

    const svc = agentLoopService(dbWithConfig({ cliTool: "claude_cli", executionMode: "cli" }));
    const out = await drainWithKey(svc, "sub-race-2");

    expect(cliChat).not.toHaveBeenCalled();
    expect(out.some((c) => c.type === "error" && /already being processed/i.test(c.message))).toBe(true);
  });

  it("replays a completed tool-only turn (empty content, toolCalls set) instead of re-running — round-3 #2", async () => {
    // A tool-only turn legitimately persists with empty content but a toolCalls
    // array. Gating replay on non-empty content would misclassify it as
    // unfinished and re-run the CLI, double-executing its tools. The linked
    // assistant row alone must count as a completed reply → replay its events.
    getMessageByClientSubmissionId.mockResolvedValue({ id: "user-tool", createdAt: new Date(0) });
    getAssistantReplyForUserMessage.mockResolvedValue({
      id: "asst-tool",
      content: null,
      toolCalls: [{ id: "t1", name: "search_tasks", input: { q: "x" }, success: true, summary: "Found 3" }],
      outputRefs: null,
      reasoning: null,
    });

    const svc = agentLoopService(dbWithConfig({ cliTool: "claude_cli", executionMode: "cli" }));
    const out = await drainWithKey(svc, "sub-tool");

    // No CLI run, no new persistence — pure replay of the recorded turn.
    expect(cliChat).not.toHaveBeenCalled();
    expect(appendMessage).not.toHaveBeenCalled();
    // The persisted tool call is streamed back as tool_call + tool_result.
    expect(out.some((c) => c.type === "tool_call" && c.name === "search_tasks")).toBe(true);
    expect(
      out.some(
        (c) => c.type === "tool_result" && c.name === "search_tasks" && c.result?.summary === "Found 3",
      ),
    ).toBe(true);
    // No empty text chunk is emitted for a content-less turn.
    expect(out.some((c) => c.type === "text")).toBe(false);
  });

  it("does NOT re-run when another worker owns the turn (reuse path, durable CAS loses) — round-6 #1", async () => {
    // The prior user row exists with no linked reply, and the durable claim CAS
    // returns false because ANOTHER process/worker owns the running turn. The
    // request must defer (in-progress here, no reply yet) and never run the CLI.
    getMessageByClientSubmissionId.mockResolvedValue({ id: "user-live", createdAt: new Date() });
    getAssistantReplyForUserMessage.mockResolvedValue(null);
    claimTurn.mockResolvedValue(null); // another instance holds the durable claim

    const svc = agentLoopService(dbWithConfig({ cliTool: "claude_cli", executionMode: "cli" }));
    const out = await drainWithKey(svc, "sub-inflight");

    expect(claimTurn).toHaveBeenCalledWith("user-live");
    expect(cliChat).not.toHaveBeenCalled();
    expect(out.some((c) => c.type === "error" && /already being processed/i.test(c.message))).toBe(true);
  });

  it("does NOT run the CLI on the FRESH path when the durable claim CAS loses — round-6 #1", async () => {
    // Fresh send: no prior row, our insert wins, but between the insert and our
    // CAS another worker claimed the same row (cross-instance). The CAS returns
    // false → we defer and never start a second CLI run. (No reply yet → in-
    // progress.)
    getMessageByClientSubmissionId.mockResolvedValue(null); // fresh at pre-check
    getAssistantReplyForUserMessage.mockResolvedValue(null);
    appendMessage.mockResolvedValueOnce({ id: "user-fresh" }); // our insert wins
    claimTurn.mockResolvedValue(null); // another worker owns the durable claim

    const svc = agentLoopService(dbWithConfig({ cliTool: "claude_cli", executionMode: "cli" }));
    const out = await drainWithKey(svc, "sub-fresh-contended");

    expect(claimTurn).toHaveBeenCalledWith("user-fresh");
    expect(cliChat).not.toHaveBeenCalled();
    expect(out.some((c) => c.type === "error" && /already being processed/i.test(c.message))).toBe(true);
  });

  it("re-runs the turn when the prior user message has no persisted reply and the CAS is won (send died mid-turn)", async () => {
    // The key was recorded, but the original send failed before any assistant
    // message was persisted (config error / CLI crash). The durable CAS reclaims
    // the row ('failed'/stale → running), so retry re-runs — NOT an empty success.
    getMessageByClientSubmissionId.mockResolvedValue({ id: "user-orig", createdAt: new Date(0) });
    getAssistantReplyForUserMessage.mockResolvedValue(null);
    claimTurn.mockResolvedValue("tok-orig"); // reclaimed the dead turn (owner token)
    scriptStream([
      { type: "text", delta: "Recovered answer" },
      { type: "done", summary: { runId: "", toolsCalled: [], durationMs: 0, costCents: 0, tokenUsage: { inputTokens: 0, outputTokens: 0 } } },
    ]);

    const svc = agentLoopService(dbWithConfig({ cliTool: "claude_cli", executionMode: "cli" }));
    const out = await drainWithKey(svc, "sub-orphan");

    // The CLI actually ran and the caller got the fresh reply.
    expect(cliChat).toHaveBeenCalledTimes(1);
    expect(out.some((c) => c.type === "text" && c.delta === "Recovered answer")).toBe(true);
    // The existing user row is reused — no duplicate user message is persisted.
    const userCalls = appendMessage.mock.calls.filter((c) => (c[1] as any).role === "user");
    expect(userCalls).toHaveLength(0);
    // The recovered assistant reply IS persisted, and the turn is marked done.
    const assistantCalls = appendMessage.mock.calls.filter((c) => (c[1] as any).role === "assistant");
    expect(assistantCalls).toHaveLength(1);
    expect((assistantCalls[0][1] as any).content).toBe("Recovered answer");
    expect(finishTurn).toHaveBeenCalledWith("user-orig", "tok-orig", "done");
  });

  it("heartbeats the durable claim (with the owner token) once the throttle interval elapses mid-stream — round-7 #1", async () => {
    // A long, actively-streaming turn must refresh its lease so it never ages
    // into the staleness window and gets reclaimed + double-run. The heartbeat is
    // throttled to COMMANDER_TURN_HEARTBEAT_MS, so we advance the clock past it
    // between chunks and assert the owner token is used.
    let t = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => t);
    getMessageByClientSubmissionId.mockResolvedValue(null); // fresh
    appendMessage.mockResolvedValueOnce({ id: "user-hb" });
    claimTurn.mockResolvedValue("tok-hb");
    cliChat.mockImplementation(async function* () {
      yield { type: "text", delta: "a" }; // baseline chunk — no heartbeat yet
      t += 61_000; // interval elapsed
      yield { type: "text", delta: "b" }; // this chunk triggers a heartbeat
      yield { type: "done", summary: { runId: "", toolsCalled: [], durationMs: 0, costCents: 0, tokenUsage: { inputTokens: 0, outputTokens: 0 } } };
    });

    const svc = agentLoopService(dbWithConfig({ cliTool: "claude_cli", executionMode: "cli" }));
    try {
      await drainWithKey(svc, "sub-hb");
      expect(heartbeatTurn).toHaveBeenCalledWith("user-hb", "tok-hb");
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("runs normally when the key has not been seen before", async () => {
    // The key was recorded, but the original send failed before any assistant
    // message was persisted (config error / CLI crash). Retry must fall through
    // to a fresh run — NOT return an empty success that suppresses the turn.
    getMessageByClientSubmissionId.mockResolvedValue({ id: "user-orig", createdAt: new Date(0) });
    getAssistantReplyForUserMessage.mockResolvedValue(null);
    scriptStream([
      { type: "text", delta: "Recovered answer" },
      { type: "done", summary: { runId: "", toolsCalled: [], durationMs: 0, costCents: 0, tokenUsage: { inputTokens: 0, outputTokens: 0 } } },
    ]);

    const svc = agentLoopService(dbWithConfig({ cliTool: "claude_cli", executionMode: "cli" }));
    const out = await drainWithKey(svc, "sub-orphan");

    // The CLI actually ran and the caller got the fresh reply.
    expect(cliChat).toHaveBeenCalledTimes(1);
    expect(out.some((c) => c.type === "text" && c.delta === "Recovered answer")).toBe(true);
    // The existing user row is reused — no duplicate user message is persisted.
    const userCalls = appendMessage.mock.calls.filter((c) => (c[1] as any).role === "user");
    expect(userCalls).toHaveLength(0);
    // The recovered assistant reply IS persisted.
    const assistantCalls = appendMessage.mock.calls.filter((c) => (c[1] as any).role === "assistant");
    expect(assistantCalls).toHaveLength(1);
    expect((assistantCalls[0][1] as any).content).toBe("Recovered answer");
  });

  it("runs normally when the key has not been seen before", async () => {
    getMessageByClientSubmissionId.mockResolvedValue(null);
    scriptStream([
      { type: "text", delta: "Fresh" },
      { type: "done", summary: { runId: "", toolsCalled: [], durationMs: 0, costCents: 0, tokenUsage: { inputTokens: 0, outputTokens: 0 } } },
    ]);
    const svc = agentLoopService(dbWithConfig({ cliTool: "claude_cli", executionMode: "cli" }));
    await drainWithKey(svc, "sub-new");

    // The first Send persists the user message carrying the key and runs the CLI.
    expect(appendMessage).toHaveBeenCalledWith(
      "conv-1",
      expect.objectContaining({ role: "user", clientSubmissionId: "sub-new" }),
    );
    expect(cliChat).toHaveBeenCalledTimes(1);
  });

  it("releases the durable claim ('failed') when config is absent after the claim — round-11 #3", async () => {
    // A keyed send claims the turn, then finds NO internal_agent_config and
    // returns an error WITHOUT running the CLI. The claim must be released so an
    // immediate retry can reclaim it — not left 'running' until the 35-min window.
    getMessageByClientSubmissionId.mockResolvedValue(null); // fresh
    appendMessage.mockResolvedValueOnce({ id: "user-noconfig" });
    claimTurn.mockResolvedValue("tok-nc");
    const svc = agentLoopService(dbWithConfig(null)); // no config row

    const out = await drainWithKey(svc, "sub-noconfig");

    // The CLI never ran; the caller got the not-configured error…
    expect(cliChat).not.toHaveBeenCalled();
    expect(out.some((c) => c.type === "error" && /not configured/i.test(c.message))).toBe(true);
    // …and the claim was released 'failed' (owner-token guarded) so a retry proceeds.
    expect(finishTurn).toHaveBeenCalledWith("user-noconfig", "tok-nc", "failed");
  });
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("agentLoopService.chat — assistant persistence (MX-chatpersist)", () => {
  it("persists the user message (existing behavior, role:user, content=params.content)", async () => {
    scriptStream([
      { type: "text", delta: "Hi" },
      { type: "done", summary: {} },
    ]);
    const svc = agentLoopService(dbWithConfig({ cliTool: "claude_cli", executionMode: "cli" }));
    await drain(svc);

    expect(appendMessage).toHaveBeenCalledWith(
      "conv-1",
      expect.objectContaining({ role: "user", content: "what is up" }),
    );
  });

  it("appends the assistant message exactly once after a clean stream with content == accumulated text", async () => {
    scriptStream([
      { type: "text", delta: "Hello " },
      { type: "text", delta: "world" },
      { type: "done", summary: { runId: "", toolsCalled: [], durationMs: 0, costCents: 0, tokenUsage: { inputTokens: 0, outputTokens: 0 } } },
    ]);
    const svc = agentLoopService(dbWithConfig({ cliTool: "claude_cli", executionMode: "cli" }));
    await drain(svc);

    const assistantCalls = appendMessage.mock.calls.filter(
      (c) => (c[1] as any).role === "assistant",
    );
    expect(assistantCalls).toHaveLength(1);
    expect(assistantCalls[0][0]).toBe("conv-1");
    expect((assistantCalls[0][1] as any).content).toBe("Hello world");

    // user message persisted before the assistant message.
    const roles = appendMessage.mock.calls.map((c) => (c[1] as any).role);
    expect(roles).toEqual(["user", "assistant"]);
  });

  it("forwards every chunk to the caller in order (streaming byte-unchanged)", async () => {
    const scripted = [
      { type: "text", delta: "Hello " },
      { type: "text", delta: "world" },
      { type: "done", summary: { runId: "r", toolsCalled: [], durationMs: 1, costCents: 2, tokenUsage: { inputTokens: 3, outputTokens: 4 } } },
    ];
    scriptStream(scripted);
    const svc = agentLoopService(dbWithConfig({ cliTool: "codex", executionMode: "cli" }));
    const out = await drain(svc);

    // The agent-loop must yield EXACTLY the scripted chunks, unchanged & in order.
    expect(out).toEqual(scripted);
  });

  it("appends NO assistant message when the stream yields only an error + done (no text)", async () => {
    scriptStream([
      { type: "error", message: "boom" },
      { type: "done", summary: {} },
    ]);
    const svc = agentLoopService(dbWithConfig({ cliTool: "codex", executionMode: "cli" }));
    const out = await drain(svc);

    const roles = appendMessage.mock.calls.map((c) => (c[1] as any).role);
    expect(roles).toEqual(["user"]); // user only — no assistant
    // the error + done still streamed through unchanged.
    expect(out).toEqual([
      { type: "error", message: "boom" },
      { type: "done", summary: {} },
    ]);
  });

  it("does NOT persist a partial assistant message when the stream throws mid-way (catch yields error+done)", async () => {
    cliChat.mockImplementation(async function* () {
      yield { type: "text", delta: "partial..." };
      throw new Error("stream blew up");
    });
    const svc = agentLoopService(dbWithConfig({ cliTool: "claude_cli", executionMode: "cli" }));
    const out = await drain(svc);

    const roles = appendMessage.mock.calls.map((c) => (c[1] as any).role);
    expect(roles).toEqual(["user"]); // user only — NO partial assistant

    // catch path: an error chunk then a done chunk.
    expect(out.some((c) => c.type === "error" && /stream blew up/.test(c.message))).toBe(true);
    expect(out[out.length - 1].type).toBe("done");
  });

  it("does NOT persist an empty/whitespace-only assistant message", async () => {
    scriptStream([
      { type: "text", delta: "   " },
      { type: "text", delta: "\n" },
      { type: "done", summary: {} },
    ]);
    const svc = agentLoopService(dbWithConfig({ cliTool: "claude_cli", executionMode: "cli" }));
    await drain(svc);

    const roles = appendMessage.mock.calls.map((c) => (c[1] as any).role);
    expect(roles).toEqual(["user"]); // whitespace-only ⇒ no assistant append
  });

  it("does NOT append an assistant message when the company has no config (not-configured error path)", async () => {
    const svc = agentLoopService(dbWithConfig(null));
    const out = await drain(svc);

    const roles = appendMessage.mock.calls.map((c) => (c[1] as any).role);
    expect(roles).toEqual(["user"]); // user persisted, then config error — no assistant
    expect(out.some((c) => c.type === "error" && /not configured/i.test(c.message))).toBe(true);
    // cli-mode is never even invoked when unconfigured.
    expect(cliChat).not.toHaveBeenCalled();
  });

  it("defaults legacy null cliTool configs to claude_cli before dispatch", async () => {
    scriptStream([
      { type: "text", delta: "Hi" },
      { type: "done", summary: { runId: "", toolsCalled: [], durationMs: 0, costCents: 0, tokenUsage: { inputTokens: 0, outputTokens: 0 } } },
    ]);
    const svc = agentLoopService(dbWithConfig({ cliTool: null, executionMode: "cli" }));
    await drain(svc);

    expect(cliChat).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.any(String),
        conversationId: "conv-1",
      }),
      expect.objectContaining({ cliTool: "claude_cli" }),
    );
  });
});
