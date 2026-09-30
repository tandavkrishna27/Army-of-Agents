import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  extractCodexSessionId,
  parseCodexJsonl,
  createCodexSessionIdCapture,
} from "./parse.js";
import { appendWithCap, MAX_CAPTURE_BYTES } from "@armyofagents/adapter-utils/server-utils";
import { execute } from "./execute.js";

const THREAD_ID = "codex-session-head-only";

describe("extractCodexSessionId", () => {
  it("returns the thread_id from a thread.started JSONL line", () => {
    const line = JSON.stringify({ type: "thread.started", thread_id: THREAD_ID });
    expect(extractCodexSessionId(line)).toBe(THREAD_ID);
  });

  it("finds thread.started even when other JSONL lines surround it", () => {
    const chunk = [
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "x" } }),
      JSON.stringify({ type: "thread.started", thread_id: THREAD_ID }),
      JSON.stringify({ type: "turn.completed", usage: {} }),
    ].join("\n");
    expect(extractCodexSessionId(chunk)).toBe(THREAD_ID);
  });

  it("returns null when no thread.started event is present", () => {
    const chunk = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "x" } });
    expect(extractCodexSessionId(chunk)).toBeNull();
  });

  it("returns null for non-JSON / partial lines", () => {
    expect(extractCodexSessionId("{not json")).toBeNull();
    expect(extractCodexSessionId("")).toBeNull();
  });
});

describe("createCodexSessionIdCapture — carry buffer across split chunks (A-M17 / Codex P2)", () => {
  it("captures the session id when thread.started is split across two chunks", () => {
    const headLine = JSON.stringify({ type: "thread.started", thread_id: THREAD_ID });
    // Split the head line mid-way so neither chunk contains a complete line.
    const mid = Math.floor(headLine.length / 2);
    const first = headLine.slice(0, mid); // no newline yet → partial line
    const second = headLine.slice(mid) + "\n"; // completes the line

    const capture = createCodexSessionIdCapture();
    expect(capture.feed(first)).toBeNull(); // partial — nothing yet
    expect(capture.feed(second)).toBe(THREAD_ID); // completed line → captured
    expect(capture.sessionId).toBe(THREAD_ID);
  });

  it("captures when the split also straddles surrounding lines", () => {
    const before = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "x" } });
    const headLine = JSON.stringify({ type: "thread.started", thread_id: THREAD_ID });
    const after = JSON.stringify({ type: "turn.completed", usage: {} });

    const full = `${before}\n${headLine}\n${after}\n`;
    // Cut at a point inside the head line so it lands across the chunk boundary.
    const cut = before.length + 1 + Math.floor(headLine.length / 2);

    const capture = createCodexSessionIdCapture();
    capture.feed(full.slice(0, cut)); // ...partial head line at the tail
    capture.feed(full.slice(cut)); // completes head line + remaining
    expect(capture.sessionId).toBe(THREAD_ID);
  });

  it("captures a complete line delivered in a single chunk (no regression)", () => {
    const headLine = JSON.stringify({ type: "thread.started", thread_id: THREAD_ID }) + "\n";
    const capture = createCodexSessionIdCapture();
    expect(capture.feed(headLine)).toBe(THREAD_ID);
    expect(capture.sessionId).toBe(THREAD_ID);
  });

  it("stops scanning once captured (later chunks are not re-parsed for a new id)", () => {
    const headLine = JSON.stringify({ type: "thread.started", thread_id: THREAD_ID }) + "\n";
    const otherStart = JSON.stringify({ type: "thread.started", thread_id: "second-thread" }) + "\n";
    const capture = createCodexSessionIdCapture();
    capture.feed(headLine);
    capture.feed(otherStart);
    // First id wins; the buffer is not still accumulating a competing session.
    expect(capture.sessionId).toBe(THREAD_ID);
  });

  it("returns null when the final line is never terminated by a newline", () => {
    const headLine = JSON.stringify({ type: "thread.started", thread_id: THREAD_ID });
    const capture = createCodexSessionIdCapture();
    // No trailing newline → the line stays in carry, never scanned.
    expect(capture.feed(headLine)).toBeNull();
    expect(capture.sessionId).toBeNull();
  });
});

describe("session id survives the 4MB stdout capture cap", () => {
  it("simulates the cap dropping the head: parse loses sessionId but the live extractor keeps it", () => {
    // thread.started is the FIRST line; the cap keeps the TAIL, so a parse of
    // the capped buffer drops the head and yields a null sessionId.
    const headLine = JSON.stringify({ type: "thread.started", thread_id: THREAD_ID });
    const trailingLine = JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "x".repeat(256) },
    });

    // Stream the head, then enough trailing chunks to push past the 4MB cap.
    let captured = "";
    let live: string | null = null;
    const feed = (chunk: string) => {
      captured = appendWithCap(captured, chunk);
      if (!live) live = extractCodexSessionId(chunk);
    };

    feed(headLine + "\n");
    let bytes = headLine.length;
    while (bytes <= MAX_CAPTURE_BYTES + 64 * 1024) {
      feed(trailingLine + "\n");
      bytes += trailingLine.length + 1;
    }

    // The capped buffer no longer contains the head event.
    expect(captured.length).toBeLessThanOrEqual(MAX_CAPTURE_BYTES);
    expect(captured).not.toContain("thread.started");
    expect(parseCodexJsonl(captured).sessionId).toBeNull();

    // But the live extractor captured it from the head chunk before capping.
    expect(live).toBe(THREAD_ID);
  });
});

async function writeOversizedCodexCommand(commandPath: string): Promise<string> {
  // Emits thread.started FIRST, then >4MB of trailing JSONL so the adapter's
  // stdout capture cap drops the head event before parseCodexJsonl runs.
  const script = `#!/usr/bin/env node
const headLine = JSON.stringify({ type: "thread.started", thread_id: ${JSON.stringify(THREAD_ID)} });
process.stdout.write(headLine + "\\n");
const filler = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "y".repeat(512) } }) + "\\n";
let written = headLine.length;
const target = ${MAX_CAPTURE_BYTES} + 256 * 1024;
while (written < target) {
  process.stdout.write(filler);
  written += filler.length;
}
process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2, cached_input_tokens: 0 } }) + "\\n");
`;
  const jsPath = commandPath + ".js";
  await fs.writeFile(jsPath, script, "utf8");
  await fs.chmod(jsPath, 0o755);

  if (process.platform === "win32") {
    const cmdPath = commandPath + ".cmd";
    await fs.writeFile(cmdPath, `@node "%~dp0agent.js" %*\r\n`, "utf8");
    return cmdPath;
  }

  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
  return commandPath;
}

describe("execute resolves the live-captured session id when stdout exceeds the cap", () => {
  it("returns a non-null sessionId / sessionParams even though the head thread.started was truncated", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-codex-session-cap-"));
    const workspace = path.join(root, "workspace");
    const commandBase = path.join(root, "agent");
    const codexHome = path.join(root, "codex-home");
    await fs.mkdir(workspace, { recursive: true });
    const commandPath = await writeOversizedCodexCommand(commandBase);

    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;

    try {
      const result = await execute({
        runId: "run-codex-session-cap",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Codex Coder",
          adapterType: "codex_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          timeoutSec: 30,
          graceSec: 1,
        },
        context: {},
        executionTarget: { type: "local" },
        runtimeCommandSpec: null,
        authToken: "secret-run-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      // The parsed sessionId would be null here (head truncated), but the live
      // extractor rescues it.
      expect(result.sessionId).toBe(THREAD_ID);
      expect(result.sessionParams).toMatchObject({ sessionId: THREAD_ID, cwd: workspace });
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
