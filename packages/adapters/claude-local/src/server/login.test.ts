import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { runClaudeLoginStreaming } from "./login.js";

function makeFakeHandle() {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { writable: true, on: () => {}, write: () => true };
  return { child, pid: 1, pgid: 1, startedAt: new Date(), terminate: () => {} };
}

describe("runClaudeLoginStreaming", () => {
  it("pipes stdin because claude's login blocks on a pasted code", () => {
    let captured: unknown;
    runClaudeLoginStreaming({
      runId: "r1",
      env: { CLAUDE_CONFIG_DIR: "/tmp/claude-home" } as NodeJS.ProcessEnv,
      ensureDir: () => {},
      spawn: (_r, _c, _a, opts) => {
        captured = opts.stdio;
        return makeFakeHandle() as never;
      },
    });
    expect(captured).toEqual(["pipe", "pipe", "pipe"]);
  });

  it("runs `claude auth login`", () => {
    let argv: string[] = [];
    runClaudeLoginStreaming({
      runId: "r1",
      env: { CLAUDE_CONFIG_DIR: "/tmp/claude-home" } as NodeJS.ProcessEnv,
      ensureDir: () => {},
      spawn: (_r, _c, a, _o) => { argv = a; return makeFakeHandle() as never; },
    });
    expect(argv).toEqual(["auth", "login", "--claudeai"]);
  });

  it("exposes submitCode so the paste-code bridge can deliver the code", () => {
    const written: string[] = [];
    const handle = makeFakeHandle();
    (handle.child as Record<string, unknown>).stdin = {
      writable: true, on: () => {}, write: (s: string) => { written.push(s); return true; },
    };
    const r = runClaudeLoginStreaming({
      runId: "r1",
      env: { CLAUDE_CONFIG_DIR: "/tmp/claude-home" } as NodeJS.ProcessEnv,
      ensureDir: () => {},
      spawn: () => handle as never,
    });
    expect(r.submitCode("ABC-123")).toBe(true);
    expect(written).toEqual(["ABC-123\n"]);
  });
});
