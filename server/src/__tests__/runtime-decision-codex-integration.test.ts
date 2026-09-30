/**
 * W5c Task 9 — runtime-decision ↔ codex `app-server` INTEGRATION loop.
 *
 * Wires the REAL runtime-decision broker (`createHeartbeatRuntimeDecisionBroker`
 * over the REAL `agentRuntimeDecisionService`, backed by an in-memory repo) with
 * a MOCK (scripted) codex `app-server` (the REAL `createJsonRpcClient` driven
 * over a pair of `PassThrough` streams) through the REAL driver
 * (`driveCodexAppServer`) + REAL approval bridge (`handleApprovalRequest`) + REAL
 * accumulator (`createAppServerResultAccumulator`).
 *
 * The point of Task 9 is that NOTHING between the founder's decision and codex's
 * `{ decision }` answer is stubbed: broker, service state machine (answer /
 * relay / cancel / allow_always trust-rule), driver approval routing, bridge
 * path trust boundary + outcome mapping, and the JSON-RPC transport are all real.
 * Only the DB (→ in-memory repo) and the codex process (→ scripted frames) are
 * substituted, mirroring how `heartbeat-runtime-decision-broker.test.ts`
 * substitutes the DB.
 *
 * Determinism: no real sleeps. The in-memory repo fires `onDecisionCreated` the
 * instant the broker persists a prompt; the test's "founder" answers/cancels
 * that row (through the REAL `answerPrompt` / `cancelActiveForRun`) synchronously
 * BEFORE `waitForAnswer`'s first poll, so the bounded wait resolves on its first
 * `getDecision` with no timer advance.
 */
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import {
  agentRuntimeDecisionService,
  type AgentRuntimeDecisionRow,
  type AgentRuntimeTrustRuleRow,
} from "../services/agent-runtime-decisions.js";
import { createHeartbeatRuntimeDecisionBroker } from "../services/heartbeat.js";

// The app-server primitives are not re-exported from the codex adapter's public
// `./server` entry (they are internal to the W5c bridge). Server may import the
// adapter; here we reach the source modules by relative path (test-only — no
// production re-export is added). Vitest resolves these TS sources directly.
import {
  driveCodexAppServer,
  type AppServerDriverClient,
} from "../../../packages/adapters/codex-local/src/server/app-server/driver.js";
import { createAppServerResultAccumulator } from "../../../packages/adapters/codex-local/src/server/app-server/parse-events.js";
import { handleApprovalRequest } from "../../../packages/adapters/codex-local/src/server/app-server/approval-bridge.js";
import { createJsonRpcClient } from "../../../packages/adapters/codex-local/src/server/app-server/jsonrpc-client.js";

// ---------------------------------------------------------------------------
// Fixtures / ids
// ---------------------------------------------------------------------------

const COMPANY_ID = "11111111-1111-1111-1111-111111111111";
const AGENT_ID = "22222222-2222-2222-2222-222222222222";
const RUN_ID = "33333333-3333-3333-3333-333333333333";
const ACTOR_USER_ID = "44444444-4444-4444-4444-444444444444";
const CWD = process.platform === "win32" ? "C:\\work\\proj" : "/work/proj";
const TIMEOUT_MS = 300 * 1000;

const run = { id: RUN_ID, companyId: COMPANY_ID, agentId: AGENT_ID };
const agent = {
  id: AGENT_ID,
  companyId: COMPANY_ID,
  name: "Builder",
  adapterType: "codex_local",
  adapterConfig: {},
};
const runtime = {
  sessionId: "session-legacy",
  sessionDisplayId: "session-display",
  sessionParams: { session: "session-display" },
  taskKey: "issue:1",
};

// ---------------------------------------------------------------------------
// In-memory DecisionRepo — faithful to realRepo's contract (upsert-on-conflict,
// source_unique_key uniqueness, guarded updates, trust-rule answer). This keeps
// the REAL service's state machine while removing the DB.
// ---------------------------------------------------------------------------

type Insert = Record<string, unknown>;

function makeInMemoryRepo() {
  const rows = new Map<string, AgentRuntimeDecisionRow>();
  const byUniqueKey = new Map<string, string>();
  const trustRules: AgentRuntimeTrustRuleRow[] = [];
  let seq = 0;

  /** Fired synchronously after a NEW prompt row is persisted. */
  let onDecisionCreated: ((row: AgentRuntimeDecisionRow) => void) | null = null;

  function clone(row: AgentRuntimeDecisionRow): AgentRuntimeDecisionRow {
    return { ...row };
  }

  const repo = {
    async createDecision(input: Insert): Promise<AgentRuntimeDecisionRow> {
      const uniqueKey = input.sourceUniqueKey as string | null | undefined;
      // Upsert semantics: an existing NON-terminal row for the same unique key is
      // updated + revision-bumped (mirrors onConflictDoUpdate setWhere). Here the
      // integration never re-creates a live prompt, so a fresh insert is the path.
      if (uniqueKey && byUniqueKey.has(uniqueKey)) {
        const existingId = byUniqueKey.get(uniqueKey)!;
        const existing = rows.get(existingId)!;
        if (["created", "shown", "relay_failed"].includes(existing.status)) {
          const updated: AgentRuntimeDecisionRow = {
            ...existing,
            ...(input as Partial<AgentRuntimeDecisionRow>),
            id: existing.id,
            sourceRevision: existing.sourceRevision + 1,
            updatedAt: new Date(),
          };
          rows.set(existing.id, updated);
          return clone(updated);
        }
        return clone(existing);
      }
      const id = `decision-${++seq}`;
      const now = new Date();
      const row = {
        id,
        companyId: input.companyId,
        agentId: input.agentId,
        runId: input.runId,
        adapterType: input.adapterType,
        adapterSessionId: input.adapterSessionId ?? null,
        adapterSessionParams: input.adapterSessionParams ?? null,
        kind: input.kind,
        status: input.status ?? "created",
        nonce: input.nonce,
        sourceRevision: input.sourceRevision ?? 0,
        promptHash: input.promptHash,
        sourceUniqueKey: uniqueKey ?? null,
        title: input.title,
        summary: input.summary ?? null,
        promptText: input.promptText ?? null,
        toolName: input.toolName ?? null,
        command: input.command ?? null,
        commandHash: input.commandHash ?? null,
        cwd: input.cwd ?? null,
        path: input.path ?? null,
        networkTarget: input.networkTarget ?? null,
        riskClass: input.riskClass ?? null,
        options: input.options ?? null,
        expiresAt: input.expiresAt ?? null,
        timeoutPolicy: input.timeoutPolicy,
        decision: input.decision ?? null,
        answerPayload: input.answerPayload ?? null,
        answerIdempotencyKey: input.answerIdempotencyKey ?? null,
        answeredByUserId: input.answeredByUserId ?? null,
        answeredAt: input.answeredAt ?? null,
        relayedAt: input.relayedAt ?? null,
        relayError: input.relayError ?? null,
        createdAt: now,
        updatedAt: now,
      } as AgentRuntimeDecisionRow;
      rows.set(id, row);
      if (uniqueKey) byUniqueKey.set(uniqueKey, id);
      if (row.status === "created" && onDecisionCreated) {
        onDecisionCreated(clone(row));
      }
      return clone(row);
    },

    async getDecision(companyId: string, decisionId: string) {
      const row = rows.get(decisionId);
      if (!row || row.companyId !== companyId) return null;
      return clone(row);
    },

    async listActiveForRun(input: { companyId: string; runId: string }) {
      return [...rows.values()]
        .filter(
          (r) =>
            r.companyId === input.companyId &&
            r.runId === input.runId &&
            ["created", "shown", "answered", "relay_failed"].includes(r.status),
        )
        .map(clone);
    },

    // R1 zombie-decision guard: this integration exercises a LIVE run.
    async getRunStatus(_runId: string) {
      return "running";
    },

    async listTrustRules(input: {
      companyId: string;
      adapterType?: string;
      includeDisabled?: boolean;
    }) {
      return trustRules.filter(
        (r) =>
          r.companyId === input.companyId &&
          (!input.adapterType || r.adapterType === input.adapterType) &&
          (input.includeDisabled || r.enabled),
      );
    },

    async createTrustRule(input: Insert) {
      const rule = {
        id: `rule-${trustRules.length + 1}`,
        companyId: input.companyId,
        agentId: input.agentId ?? null,
        adapterType: input.adapterType,
        toolName: input.toolName ?? null,
        commandHash: input.commandHash ?? null,
        pathScope: input.pathScope ?? null,
        networkScope: input.networkScope ?? null,
        riskClass: input.riskClass ?? null,
        enabled: input.enabled ?? true,
        expiresAt: input.expiresAt ?? null,
        createdByUserId: input.createdByUserId,
        lastUsedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as AgentRuntimeTrustRuleRow;
      trustRules.push(rule);
      return rule;
    },

    async revokeTrustRule() {
      return null;
    },

    async markTrustRuleUsed(input: { ruleId: string; usedAt: Date }) {
      const rule = trustRules.find((r) => r.id === input.ruleId);
      if (rule) rule.lastUsedAt = input.usedAt;
    },

    async updateDecision(
      decisionId: string,
      patch: Partial<AgentRuntimeDecisionRow>,
      guard?: { sourceRevision?: number; statuses?: string[] },
    ) {
      const row = rows.get(decisionId);
      if (!row) return null;
      if (guard?.sourceRevision !== undefined && row.sourceRevision !== guard.sourceRevision) {
        return null;
      }
      if (guard?.statuses && !guard.statuses.includes(row.status)) return null;
      const updated = { ...row, ...patch, updatedAt: new Date() } as AgentRuntimeDecisionRow;
      rows.set(decisionId, updated);
      return clone(updated);
    },

    async answerWithTrustRule(
      decisionId: string,
      patch: Partial<AgentRuntimeDecisionRow>,
      guard: { sourceRevision: number; statuses: string[] },
      trustRule: Insert,
    ) {
      const decision = await repo.updateDecision(decisionId, patch, guard);
      if (!decision) return { decision: null, rule: null };
      const rule = await repo.createTrustRule(trustRule);
      return { decision, rule };
    },

    async listDueForExpiry() {
      return [];
    },

    // --- test affordances ---
    setOnDecisionCreated(cb: (row: AgentRuntimeDecisionRow) => void) {
      onDecisionCreated = cb;
    },
    peek(decisionId: string) {
      const row = rows.get(decisionId);
      return row ? clone(row) : null;
    },
    trustRuleCount() {
      return trustRules.length;
    },
  };

  return repo;
}

// ---------------------------------------------------------------------------
// REAL broker + REAL service (in-memory repo). Returns the broker plus a
// `founder` who delivers decisions / cancels through the REAL service.
// ---------------------------------------------------------------------------

function buildBrokerHarness() {
  const repo = makeInMemoryRepo();
  // REAL service with in-memory repo + no-op hub/activity so no DB is touched.
  const service = agentRuntimeDecisionService({} as never, {
    repo: repo as never,
    hubItems: { emit: async () => ({ id: "hub-1" }) } as never,
    activityLogger: async () => {},
    runCanceller: async () => {},
    now: () => new Date(),
  });

  const events: string[] = [];
  const broker = createHeartbeatRuntimeDecisionBroker({
    run,
    agent,
    runtime,
    runtimeDecisions: service,
    appendRunEvent: async (e) => {
      events.push(e.eventType);
    },
    markRunWaiting: async () => {},
    clearRunWaiting: async () => {},
    // pollIntervalMs unused for requestPermissionBounded (it passes timeoutMs),
    // and the founder answers before the first poll anyway.
    pollIntervalMs: 5,
  });

  return { repo, service, broker, events };
}

// ---------------------------------------------------------------------------
// MOCK app-server over a REAL createJsonRpcClient + PassThrough streams.
//
// The driver's client is the REAL createJsonRpcClient. Its `stdin` is a
// PassThrough the mock-server READS (to learn client requests); its `stdout` is
// a PassThrough the mock-server WRITES (to push frames at the client). We script
// the handshake so the driver reaches turn-driving, then the test pushes
// approval requests + terminal turn frames.
//
// createJsonRpcClient takes onNotification / onServerRequest at CONSTRUCTION,
// but the driver registers its handlers LATER via the register* hooks. Real
// Task-7 wiring passes the driver's handlers straight into spawnAppServerClient's
// onNotification/onServerRequest; here we build the client with forwarding shims
// that delegate to whatever the driver later registers, so the wiring is faithful.
// ---------------------------------------------------------------------------

function makeWiredMockAppServer() {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const clientRequests: Array<{ id: number; method: string; params: unknown; done?: boolean }> = [];
  const clientResponses: Array<{ id: number; result: unknown }> = [];
  const clientNotifications: Array<{ method: string; params: unknown }> = [];

  let notificationHandler: ((method: string, params: unknown) => void) | undefined;
  let serverRequestHandler:
    | ((id: number | string, method: string, params: unknown) => void | Promise<void>)
    | undefined;

  const client = createJsonRpcClient({
    stdin: clientToServer as never,
    stdout: serverToClient as never,
    onNotification: (m, p) => notificationHandler?.(m, p),
    onServerRequest: (id, m, p) => serverRequestHandler?.(id, m, p),
  });

  let carry = "";
  clientToServer.on("data", (chunk: Buffer) => {
    carry += chunk.toString();
    let idx: number;
    while ((idx = carry.indexOf("\n")) >= 0) {
      const line = carry.slice(0, idx).trim();
      carry = carry.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.method !== undefined && msg.id !== undefined) {
        clientRequests.push({ id: msg.id, method: msg.method, params: msg.params });
      } else if (msg.method !== undefined) {
        clientNotifications.push({ method: msg.method, params: msg.params });
      } else if (msg.id !== undefined) {
        clientResponses.push({ id: msg.id, result: msg.result });
      }
    }
  });

  function writeToClient(msg: Record<string, unknown>) {
    serverToClient.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  }

  async function flush() {
    for (let i = 0; i < 30; i++) await Promise.resolve();
    await new Promise((r) => setImmediate(r));
    for (let i = 0; i < 30; i++) await Promise.resolve();
  }

  async function respondToClientRequest(method: string, result: unknown) {
    for (let i = 0; i < 200; i++) {
      const req = clientRequests.find((r) => r.method === method && !r.done);
      if (req) {
        req.done = true;
        writeToClient({ id: req.id, result });
        await flush();
        return { id: req.id, params: req.params };
      }
      await flush();
    }
    throw new Error(
      `client never sent ${method}; saw: ${clientRequests.map((r) => r.method).join(",")}`,
    );
  }

  return {
    client: client as unknown as AppServerDriverClient,
    clientRequests,
    clientResponses,
    clientNotifications,
    writeToClient,
    flush,
    respondToClientRequest,
    setNotificationHandler(cb: (m: string, p: unknown) => void) {
      notificationHandler = cb;
    },
    setServerRequestHandler(
      cb: (id: number | string, m: string, p: unknown) => void | Promise<void>,
    ) {
      serverRequestHandler = cb;
    },
    close() {
      client.close();
      clientToServer.end();
      serverToClient.end();
    },
  };
}

function startDriveWired(
  mock: ReturnType<typeof makeWiredMockAppServer>,
  broker: ReturnType<typeof createHeartbeatRuntimeDecisionBroker>,
) {
  const accumulator = createAppServerResultAccumulator();
  const logs: string[] = [];
  const promise = driveCodexAppServer({
    runId: RUN_ID,
    cwd: CWD,
    input: [{ type: "text", text: "do the thing" }],
    approvalPolicy: "untrusted",
    timeoutSec: 0,
    client: mock.client,
    accumulator,
    onServerApproval: (method, params) =>
      handleApprovalRequest(method, params, {
        broker,
        bridged: true,
        timeoutMs: TIMEOUT_MS,
        cwd: CWD,
        onLog: (m) => logs.push(m),
      }),
    registerServerRequestHandler: mock.setServerRequestHandler,
    registerNotificationHandler: mock.setNotificationHandler,
  });
  return { promise, accumulator, logs };
}

async function driveHandshakeWired(
  mock: ReturnType<typeof makeWiredMockAppServer>,
  threadId: string,
) {
  await mock.respondToClientRequest("initialize", { userAgent: "mock" });
  await mock.respondToClientRequest("thread/start", { thread: { id: threadId } });
  await mock.respondToClientRequest("turn/start", { turn: { id: "turn-1" } });
}

describe("W5c Task 9 — runtime-decision ↔ codex app-server integration loop", () => {
  it("APPROVE (command): founder allow_once → bridge answers accept → turn completes", async () => {
    const { repo, service, broker } = buildBrokerHarness();
    const mock = makeWiredMockAppServer();

    // Founder records allow_once on the REAL service the instant the prompt lands.
    let answeredDecisionId: string | null = null;
    repo.setOnDecisionCreated((row) => {
      answeredDecisionId = row.id;
      void service.answerPrompt({
        companyId: COMPANY_ID,
        decisionId: row.id,
        actorUserId: ACTOR_USER_ID,
        expectedSourceRevision: row.sourceRevision,
        nonce: row.nonce,
        kind: "permission",
        decision: "allow_once",
      });
    });

    const { promise, accumulator } = startDriveWired(mock, broker);
    await driveHandshakeWired(mock, "thread-approve");

    // Mock app-server sends a command approval request (id=101).
    mock.writeToClient({
      id: 101,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-approve", turnId: "turn-1", itemId: "cmd-1", command: "pnpm test", cwd: CWD },
    });
    await mock.flush();

    // The bridge answered `accept` — the mock app-server received it.
    expect(mock.clientResponses).toContainEqual({ id: 101, result: { decision: "accept" } });

    // The REAL service row was answered + relayed by the broker.
    expect(answeredDecisionId).not.toBeNull();
    const finalRow = repo.peek(answeredDecisionId!);
    expect(finalRow?.decision).toBe("allow_once");
    expect(finalRow?.status).toBe("relayed");

    // Script an agent message + turn/completed so drive() resolves.
    mock.writeToClient({
      method: "item/completed",
      params: { item: { type: "agentMessage", id: "msg-1", text: "ran it" } },
    });
    mock.writeToClient({ method: "turn/completed", params: { threadId: "thread-approve" } });
    await mock.flush();

    const result = await promise;
    expect(result.summary).toBe("ran it");
    expect(result.errorMessage).toBeNull();
    expect(result.sessionId).toBe("thread-approve");
    mock.close();
  });

  it("DECLINE (command): founder deny → bridge answers decline → turn/failed surfaces error", async () => {
    const { repo, service, broker } = buildBrokerHarness();
    const mock = makeWiredMockAppServer();

    repo.setOnDecisionCreated((row) => {
      void service.answerPrompt({
        companyId: COMPANY_ID,
        decisionId: row.id,
        actorUserId: ACTOR_USER_ID,
        expectedSourceRevision: row.sourceRevision,
        nonce: row.nonce,
        kind: "permission",
        decision: "deny",
      });
    });

    const { promise } = startDriveWired(mock, broker);
    await driveHandshakeWired(mock, "thread-decline");

    mock.writeToClient({
      id: 202,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-decline", turnId: "turn-1", itemId: "cmd-2", command: "curl evil.example", cwd: CWD },
    });
    await mock.flush();

    // The decline reached the mock server.
    expect(mock.clientResponses).toContainEqual({ id: 202, result: { decision: "decline" } });

    // codex rejects the command → the turn fails.
    mock.writeToClient({
      method: "turn/failed",
      params: { turn: { error: { message: "exec command rejected by user", code: "E_REJECTED" } } },
    });
    await mock.flush();

    const result = await promise;
    expect(result.errorMessage).toBe("exec command rejected by user");
    expect(result.errorCode).toBe("E_REJECTED");
    mock.close();
  });

  it("allow_always: founder → bridge answers acceptForSession + a session trust rule is created", async () => {
    const { repo, service, broker } = buildBrokerHarness();
    const mock = makeWiredMockAppServer();

    const answeredIds: string[] = [];
    repo.setOnDecisionCreated((row) => {
      answeredIds.push(row.id);
      void service.answerPrompt({
        companyId: COMPANY_ID,
        decisionId: row.id,
        actorUserId: ACTOR_USER_ID,
        expectedSourceRevision: row.sourceRevision,
        nonce: row.nonce,
        kind: "permission",
        decision: "allow_always",
      });
    });

    const { promise } = startDriveWired(mock, broker);
    await driveHandshakeWired(mock, "thread-always");

    // First command approval — founder chose allow_always.
    mock.writeToClient({
      id: 301,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-always", turnId: "turn-1", itemId: "cmd-a", command: "pnpm build", cwd: CWD },
    });
    await mock.flush();

    // Bridge maps allow_always → acceptForSession (protocol §4 "approve + remember").
    expect(mock.clientResponses).toContainEqual({ id: 301, result: { decision: "acceptForSession" } });
    // A concrete-scope trust rule was persisted by the REAL service (allow_always path).
    expect(repo.trustRuleCount()).toBe(1);

    // A SECOND command approval for the SAME command in the same session: codex
    // remembers session approvals server-side, so it would not normally re-ask.
    // But if the driver DID receive a second request, the REAL service's trust
    // rule short-circuits it to `answered` WITHOUT surfacing a new founder prompt
    // (createPrompt matches the rule → status "answered", decision allow_always).
    // Prove that path: send a second request; assert it maps to acceptForSession
    // AND that onDecisionCreated did NOT fire again (no new founder prompt).
    const promptCountBefore = answeredIds.length;
    mock.writeToClient({
      id: 302,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-always", turnId: "turn-1", itemId: "cmd-a2", command: "pnpm build", cwd: CWD },
    });
    await mock.flush();

    expect(mock.clientResponses).toContainEqual({ id: 302, result: { decision: "acceptForSession" } });
    // No new founder prompt was surfaced (trust rule auto-answered the 2nd request).
    expect(answeredIds.length).toBe(promptCountBefore);

    mock.writeToClient({ method: "turn/completed", params: {} });
    await mock.flush();
    await promise;
    mock.close();
  });

  it("CANCEL mid-approval: broker cancel → RuntimeDecisionCancelledError → bridge declines, driver settles (no hang)", async () => {
    const { repo, service, broker } = buildBrokerHarness();
    const mock = makeWiredMockAppServer();

    // Founder does NOT answer; instead the run is cancelled mid-approval. Cancel
    // the active decision through the REAL service the instant the prompt lands.
    repo.setOnDecisionCreated((row) => {
      void service.cancelActiveForRun({
        companyId: COMPANY_ID,
        runId: row.runId,
        reason: "run cancelled",
      });
    });

    const { promise } = startDriveWired(mock, broker);
    await driveHandshakeWired(mock, "thread-cancel");

    mock.writeToClient({
      id: 401,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-cancel", turnId: "turn-1", itemId: "cmd-c", command: "rm -rf /", cwd: CWD },
    });
    await mock.flush();

    // waitForAnswer saw status "cancelled" → RuntimeDecisionCancelledError →
    // bridge caught it → decline reached the mock server.
    expect(mock.clientResponses).toContainEqual({ id: 401, result: { decision: "decline" } });

    // Task-8 coupling: closing the transport (child termination on cancel) makes
    // the driver unwind via its onClose → synthesized turn/failed. drive() must
    // RESOLVE (not hang) even though no real turn/completed ever arrives.
    mock.close();
    await mock.flush();

    const result = await promise; // resolves — the assertion is "does not hang".
    expect(result).toBeDefined();
    expect(result.errorMessage).toBe("app-server closed");
  });

  it("fileChange APPROVE (in-tree) + DECLINE (out-of-tree without prompting)", async () => {
    const { repo, service, broker } = buildBrokerHarness();
    const mock = makeWiredMockAppServer();

    let promptCount = 0;
    repo.setOnDecisionCreated((row) => {
      promptCount++;
      void service.answerPrompt({
        companyId: COMPANY_ID,
        decisionId: row.id,
        actorUserId: ACTOR_USER_ID,
        expectedSourceRevision: row.sourceRevision,
        nonce: row.nonce,
        kind: "permission",
        decision: "allow_once",
      });
    });

    const { promise } = startDriveWired(mock, broker);
    await driveHandshakeWired(mock, "thread-file");

    // (1) IN-TREE file change: item/started supplies the path BEFORE the approval
    //     request (which carries only itemId). Driver enriches → bridge validates
    //     in-tree → founder allow_once → accept.
    mock.writeToClient({
      method: "item/started",
      params: {
        item: {
          type: "fileChange",
          id: "fc-1",
          changes: [{ path: "src/app.ts", kind: { type: "add" }, diff: "x\n" }],
          status: "inProgress",
        },
      },
    });
    await mock.flush();

    mock.writeToClient({
      id: 501,
      method: "item/fileChange/requestApproval",
      params: { threadId: "thread-file", turnId: "turn-1", itemId: "fc-1", startedAtMs: 1, reason: null, grantRoot: null },
    });
    await mock.flush();

    expect(mock.clientResponses).toContainEqual({ id: 501, result: { decision: "accept" } });
    expect(promptCount).toBe(1); // in-tree change surfaced exactly one founder prompt

    // (2) OUT-OF-TREE file change: item/started supplies an escaping path. The
    //     bridge must DECLINE without surfacing a founder prompt at all.
    mock.writeToClient({
      method: "item/started",
      params: {
        item: {
          type: "fileChange",
          id: "fc-2",
          changes: [{ path: "../../etc/passwd", kind: { type: "add" } }],
          status: "inProgress",
        },
      },
    });
    await mock.flush();

    mock.writeToClient({
      id: 502,
      method: "item/fileChange/requestApproval",
      params: { threadId: "thread-file", turnId: "turn-1", itemId: "fc-2", startedAtMs: 2, reason: null, grantRoot: null },
    });
    await mock.flush();

    expect(mock.clientResponses).toContainEqual({ id: 502, result: { decision: "decline" } });
    // No SECOND founder prompt — the out-of-tree write was denied without prompting.
    expect(promptCount).toBe(1);

    mock.writeToClient({ method: "turn/completed", params: {} });
    await mock.flush();
    await promise;
    mock.close();
  });
});
