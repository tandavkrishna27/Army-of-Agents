import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/**
 * Shared contract between the playwright config (which exports the control
 * path to the webServer env as AOA_E2E_FAKE_CODEX_CONTROL) and the specs
 * (which rewrite the control file before each Commander send).
 *
 * The fake CLI (tests/e2e/fixtures/fake-codex/fake-codex.mjs) reads this file
 * fresh on every spawn. Commander's codex path is one process per chat turn
 * (`codex exec --json … -` exits after the turn), so "write control file,
 * then send" fully scripts the next reply.
 *
 * Deterministic tmpdir path — identical computation in the runner process
 * (specs), the config process, and the fake CLI's fallback, so no plumbing
 * beyond the env var is needed (mirrors helpers/fake-claude.ts).
 */
export const FAKE_CODEX_CONTROL_PATH = path.join(
  os.tmpdir(),
  "aoa-e2e-fake-codex-control.json",
);

export interface FakeCodexControl {
  /** thread_id the shim echoes in thread.started; the resume turn reuses it. */
  sessionId?: string;
  /** reasoning summary text — emitted as an item.completed reasoning item. Omit for none. */
  reasoning?: string;
  /** the assistant reply — emitted as an item.completed agent_message item. */
  text: string;
  /** usage echoed in turn.completed. */
  usage?: { input?: number; cached?: number; output?: number };
  /** MCP-style tool calls emitted before the assistant reply. */
  toolCalls?: Array<{
    name: string;
    input?: unknown;
    envelope: {
      success: boolean;
      data: unknown;
      summary: string;
    };
  }>;
  /**
   * Force a failure: "model-400" simulates the gpt-5.3-codex ChatGPT-account
   * rejection (the bug the model-pin fix addresses); "generic" emits a generic
   * error. Omit for success.
   */
  fail?: "model-400" | "generic";
}

export function writeFakeCodexControl(c: FakeCodexControl): void {
  fs.writeFileSync(FAKE_CODEX_CONTROL_PATH, JSON.stringify(c), "utf8");
}

/**
 * Invocation record (plan-review fix #2/#3): the fake-codex shim appends one
 * JSON line per spawn describing HOW Commander actually invoked codex, so
 * specs can PROVE the real cli-mode contract instead of trusting the shim's
 * own defaulting (e.g. assert turn 2 actually sent `resume <sessionId>`, and
 * every turn sent `exec --json … -` with the model/effort flags + a
 * per-session CODEX_HOME holding config.toml).
 */
export const FAKE_CODEX_INVOCATIONS_PATH = path.join(
  os.tmpdir(),
  "aoa-e2e-fake-codex-invocations.jsonl",
);

export interface FakeCodexInvocation {
  argv: string[];
  stdin: string;
  codexHome: string | null;
  configTomlExists: boolean;
}

/** Read all recorded invocations (oldest first). Empty if none yet. */
export function readFakeCodexInvocations(): FakeCodexInvocation[] {
  try {
    return fs
      .readFileSync(FAKE_CODEX_INVOCATIONS_PATH, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as FakeCodexInvocation);
  } catch {
    return [];
  }
}

/** Clear the invocation log — call before a send to scope assertions to it. */
export function clearFakeCodexInvocations(): void {
  try {
    fs.rmSync(FAKE_CODEX_INVOCATIONS_PATH, { force: true });
  } catch {
    /* nothing to clear */
  }
}
