// W5c Task 1 — live GO/NO-GO harness for the `codex app-server` runtime-decision bridge.
//
// This proves, against a REAL `codex app-server` process, the blocking approve/deny
// loop that the W5c bridge depends on:
//   initialize -> initialized -> thread/start -> turn/start
//   -> server sends `item/commandExecution/requestApproval` (has BOTH method + id)
//   -> client answers with a JSON-RPC response { id, result: { decision } }
//   -> server sends `item/fileChange/requestApproval` -> client answers.
//
// The live half NEVER runs in CI (codex isn't installed/authed on runners): it is
// gated on AOA_CODEX_APPSERVER_LIVE === "1" and describe.skip'd otherwise.
//
// The parser half (JSONL framing + fixture-shape assertions) always runs — it needs
// no codex and locks in the exact protocol shapes recorded in
// docs/adapters/codex-appserver-protocol.md.
//
// Chosen approval policy: "untrusted".
//   - benign/trusted commands (e.g. `echo hi`) AUTO-approve (no request fires)
//   - risky commands (network access) PROMPT via item/commandExecution/requestApproval
//   - file writes PROMPT via item/fileChange/requestApproval
//   ("on-request" prompts for EVERY command incl. `echo` — rejected as the policy.)
//
// v2 decision enums (codex 0.130):
//   command:     accept | acceptForSession | acceptWithExecpolicyAmendment
//                | applyNetworkPolicyAmendment | decline | cancel
//   file-change: accept | acceptForSession | decline | cancel

import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LIVE = process.env.AOA_CODEX_APPSERVER_LIVE === "1";
const APPROVAL_POLICY = "untrusted";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Parser-level tests (always run — no codex required)
// ---------------------------------------------------------------------------

/**
 * Newline-delimited JSON-RPC frame reader. Frames may split across stdout
 * chunks AND multiple frames may arrive in one chunk, so we carry a partial-line
 * buffer and split on "\n". This mirrors the read loop the bridge must use.
 */
function makeFrameReader(onFrame: (obj: any) => void) {
  let buf = "";
  return (chunk: string) => {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      onFrame(JSON.parse(line));
    }
  };
}

describe("codex app-server JSONL framing", () => {
  it("reassembles frames split across chunks and splits multiple frames in one chunk", () => {
    const seen: any[] = [];
    const feed = makeFrameReader((f) => seen.push(f));
    // frame 1 split across two chunks; frames 2 + 3 arrive together in one chunk;
    // frame 3 left as a trailing partial (no newline yet).
    feed('{"jsonrpc":"2.0","id":1,"resu');
    feed('lt":{"ok":true}}\n{"method":"turn/completed"}\n{"method":"turn/');
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    expect(seen[1]).toEqual({ method: "turn/completed" });
    feed('started"}\n');
    expect(seen).toHaveLength(3);
    expect(seen[2]).toEqual({ method: "turn/started" });
  });

  it("distinguishes a server approval REQUEST (has method + id) from a notification (method only)", () => {
    const req = { jsonrpc: "2.0", method: "item/commandExecution/requestApproval", id: 0, params: {} };
    const notif = { jsonrpc: "2.0", method: "turn/completed", params: {} };
    const isServerRequest = (m: any) => m.method !== undefined && m.id !== undefined;
    expect(isServerRequest(req)).toBe(true);
    expect(isServerRequest(notif)).toBe(false);
  });
});

describe("codex app-server recorded turn fixture", () => {
  const fixture = JSON.parse(
    fs.readFileSync(path.join(__dirname, "fixtures", "appserver-turn.json"), "utf8"),
  );
  const frames: any[] = fixture.frames;
  const byMethod = (m: string) => frames.filter((f) => f.method === m);

  it("contains a real thread id and a captured stream", () => {
    expect(typeof fixture.threadId).toBe("string");
    expect(frames.length).toBeGreaterThan(20);
  });

  it("carries both approval-request kinds as JSON-RPC server requests (method + id)", () => {
    const cmd = byMethod("item/commandExecution/requestApproval");
    const file = byMethod("item/fileChange/requestApproval");
    expect(cmd).toHaveLength(1);
    expect(file).toHaveLength(1);
    expect(cmd[0].id).toBeDefined();
    expect(file[0].id).toBeDefined();
    // command approval params shape
    expect(cmd[0].params).toMatchObject({
      threadId: expect.any(String),
      turnId: expect.any(String),
      itemId: expect.any(String),
    });
    expect(typeof cmd[0].params.command).toBe("string");
    // file-change approval params shape
    expect(file[0].params).toMatchObject({
      threadId: expect.any(String),
      turnId: expect.any(String),
      itemId: expect.any(String),
    });
  });

  it("emits the core notification stream (started/items/deltas/tokenUsage/completed)", () => {
    expect(byMethod("thread/started")).toHaveLength(1);
    expect(byMethod("item/started").length).toBeGreaterThan(0);
    expect(byMethod("item/completed").length).toBeGreaterThan(0);
    expect(byMethod("item/agentMessage/delta").length).toBeGreaterThan(0);
    expect(byMethod("turn/completed").length).toBeGreaterThan(0);
    const itemTypes = new Set(
      frames
        .filter((f) => f.method === "item/started" || f.method === "item/completed")
        .map((f) => f.params?.item?.type),
    );
    for (const t of ["commandExecution", "fileChange", "agentMessage", "reasoning"]) {
      expect(itemTypes.has(t)).toBe(true);
    }
  });

  it("reports token usage with a cachedInputTokens field (required for correct cost)", () => {
    const tu = byMethod("thread/tokenUsage/updated");
    expect(tu.length).toBeGreaterThan(0);
    const bd = tu[0].params.tokenUsage.total;
    // Exact field names — camelCase. Cached tokens ARE present.
    expect(bd).toMatchObject({
      totalTokens: expect.any(Number),
      inputTokens: expect.any(Number),
      cachedInputTokens: expect.any(Number),
      outputTokens: expect.any(Number),
      reasoningOutputTokens: expect.any(Number),
    });
    expect(tu[0].params.tokenUsage.last).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Live harness (gated on AOA_CODEX_APPSERVER_LIVE=1)
// ---------------------------------------------------------------------------

type Frame = Record<string, any>;

interface LiveResult {
  threadId: string | null;
  sawCommandApproval: boolean;
  commandDecision: string | null;
  turn1: string | null;
  sawFileChangeApproval: boolean;
  fileChangeDecision: string | null;
  turn2: string | null;
}

/**
 * Drive a real `codex app-server`: force a command approval (network → decline)
 * then a file-change approval (write → accept), proving the blocking loop both ways.
 */
function driveAppServer(): Promise<LiveResult> {
  return new Promise((resolve, reject) => {
    const tmp = fs
      .mkdtempSync(path.join(os.tmpdir(), "w5c-live-"))
      .replace(/\\/g, "/");
    const child = spawn("codex", ["app-server"], {
      shell: true,
      cwd: tmp,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const res: LiveResult = {
      threadId: null,
      sawCommandApproval: false,
      commandDecision: null,
      turn1: null,
      sawFileChangeApproval: false,
      fileChangeDecision: null,
      turn2: null,
    };
    let phase: "init" | "turn1" | "turn2" | "done" = "init";
    let settled = false;

    const send = (obj: Frame) => child.stdin.write(JSON.stringify(obj) + "\n");

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve(res);
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      reject(err);
    };

    // Overall guard: two model turns, generous headroom for slow model latency.
    const timer = setTimeout(() => finish(), 200_000);

    const startTurn1 = () => {
      phase = "turn1";
      send({
        jsonrpc: "2.0",
        id: 10,
        method: "turn/start",
        params: {
          threadId: res.threadId,
          approvalPolicy: APPROVAL_POLICY,
          input: [
            {
              type: "text",
              text:
                'Run exactly this shell command as your only action and nothing else, immediately, without asking me: powershell -Command "Invoke-WebRequest -Uri https://example.com -UseBasicParsing | Out-Null" . This needs network access.',
            },
          ],
        },
      });
    };
    const startTurn2 = () => {
      phase = "turn2";
      send({
        jsonrpc: "2.0",
        id: 20,
        method: "turn/start",
        params: {
          threadId: res.threadId,
          approvalPolicy: APPROVAL_POLICY,
          input: [
            {
              type: "text",
              text:
                "Create a new file named notes.txt in the current working directory containing the single line 'hello from w5c'. Use your file editing/patch tool to write it. Do this immediately as your only action; do not ask me for confirmation.",
            },
          ],
        },
      });
    };

    const handle = (msg: Frame) => {
      // initialize response
      if (msg.id === 1 && msg.result !== undefined) {
        send({ jsonrpc: "2.0", method: "initialized" });
        send({
          jsonrpc: "2.0",
          id: 2,
          method: "thread/start",
          params: { cwd: tmp, approvalPolicy: APPROVAL_POLICY },
        });
        return;
      }
      // thread/start response → capture thread id → turn 1
      if (msg.id === 2 && msg.result !== undefined) {
        res.threadId =
          msg.result?.thread?.id ?? msg.result?.threadId ?? null;
        startTurn1();
        return;
      }
      if (msg.method === "thread/started" && !res.threadId) {
        res.threadId = msg.params?.threadId ?? msg.params?.thread?.id ?? null;
      }

      // COMMAND approval request (server request: method + id) → decline
      if (msg.id !== undefined && msg.method === "item/commandExecution/requestApproval") {
        res.sawCommandApproval = true;
        res.commandDecision = "decline";
        send({ jsonrpc: "2.0", id: msg.id, result: { decision: "decline" } });
        return;
      }
      // FILE-CHANGE approval request → accept
      if (msg.id !== undefined && msg.method === "item/fileChange/requestApproval") {
        res.sawFileChangeApproval = true;
        res.fileChangeDecision = "accept";
        send({ jsonrpc: "2.0", id: msg.id, result: { decision: "accept" } });
        return;
      }

      // turn completion drives phase progression
      if (msg.method === "turn/completed" || msg.method === "turn/failed") {
        if (phase === "turn1") {
          res.turn1 = msg.method;
          startTurn2();
          return;
        }
        if (phase === "turn2") {
          res.turn2 = msg.method;
          phase = "done";
          finish();
          return;
        }
      }
    };

    const feed = makeFrameReader((f) => {
      try {
        handle(f);
      } catch (e) {
        fail(e as Error);
      }
    });
    child.stdout.on("data", (d) => feed(d.toString()));
    child.on("error", (e) => fail(e));

    // kick off
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "aoa-w5c-live", title: null, version: "0.0.0" },
        capabilities: null,
      },
    });
  });
}

const liveDescribe = LIVE ? describe : describe.skip;

liveDescribe("codex app-server LIVE approval loop (AOA_CODEX_APPSERVER_LIVE=1)", () => {
  it(
    "delivers a blocking command approval (decline) then a file-change approval (accept)",
    async () => {
      const r = await driveAppServer();
      expect(r.threadId).toBeTruthy();

      // Command approval: fired, we declined, turn resolved.
      expect(r.sawCommandApproval).toBe(true);
      expect(r.commandDecision).toBe("decline");
      expect(r.turn1).toBe("turn/completed");

      // File-change approval: fired, we accepted, turn resolved.
      expect(r.sawFileChangeApproval).toBe(true);
      expect(r.fileChangeDecision).toBe("accept");
      expect(r.turn2).toBe("turn/completed");
    },
    220_000,
  );
});
