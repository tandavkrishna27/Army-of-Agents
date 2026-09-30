import type { ChildProcess } from "node:child_process";
import { unlink } from "node:fs/promises";

export type CLIToolType = "claude_cli" | "codex" | "opencode";

export interface CLISession {
  /**
   * Long-lived CLI subprocess for providers with a PERSISTENT process model
   * (claude_cli: turn-1 spawns, subsequent turns pipe to the same stdin).
   * `null` for one-shot providers (codex: `codex exec` runs the turn and
   * exits, so the conversation is carried by `codexSessionId`, not a
   * process). MX-chatparse made this nullable; killSession guards on it.
   */
  cliProcess: ChildProcess | null;
  mcpProcess: ChildProcess | null; // null when CLI manages bridge internally
  cliTool: CLIToolType;
  /**
   * Codex conversation id (from a `thread.started` event). Present only for
   * codex sessions; the next turn re-spawns `codex exec … resume <id> -`.
   * Refreshed from each turn's parse. Undefined for claude (persistent
   * process) — MX-chatparse.
   *
   * INVARIANT: Only ever assigned via validateSessionId() output (see cli-mode.ts
   * onSessionId callback). Direct writes bypass the shell-injection guard — on
   * Windows, spawn uses shell:true so raw metacharacters in codex args execute
   * as shell commands. Re-validation also runs at the spawn boundary in
   * spawnAndCollect() as defense-in-depth.
   */
  codexSessionId?: string;
  companyId: string;
  userId: string;
  userRole: string;
  startedAt: Date;
  lastMessageAt: Date;
  mcpConfigPath: string;
  status: "active" | "ending";
  messageQueue: Array<{
    resolve: (v: void) => void;
    reject: (e: Error) => void;
  }>;
  processing: boolean;
}

const MAX_QUEUE_DEPTH = 5;
const KILL_GRACE_MS = 5000;

export function createCLISessionStore() {
  const sessions = new Map<string, CLISession>();

  function killSession(session: CLISession): void {
    session.status = "ending";
    // codex sessions are process-less (cliProcess === null); the guard
    // keeps SIGTERM/SIGKILL a no-op for them while claude's persistent
    // process is killed exactly as before (MX-chatparse).
    if (session.cliProcess)
      try {
        session.cliProcess.kill("SIGTERM");
      } catch {}
    if (session.mcpProcess)
      try {
        session.mcpProcess.kill("SIGTERM");
      } catch {}

    // Force kill after grace period
    setTimeout(() => {
      if (session.cliProcess)
        try {
          session.cliProcess.kill("SIGKILL");
        } catch {}
      if (session.mcpProcess)
        try {
          session.mcpProcess.kill("SIGKILL");
        } catch {}
    }, KILL_GRACE_MS);

    // Clean up temp config file (best effort)
    unlink(session.mcpConfigPath).catch(() => {});

    // Reject queued messages
    for (const queued of session.messageQueue) {
      queued.reject(new Error("Session terminated"));
    }
    session.messageQueue = [];
  }

  return {
    get(key: string): CLISession | undefined {
      return sessions.get(key);
    },

    set(key: string, session: CLISession): void {
      sessions.set(key, session);
    },

    has(key: string): boolean {
      return sessions.has(key);
    },

    delete(key: string): void {
      sessions.delete(key);
    },

    cleanup(key: string): void {
      const session = sessions.get(key);
      if (session) {
        killSession(session);
        sessions.delete(key);
      }
    },

    getStale(thresholdMs: number): string[] {
      const now = Date.now();
      const stale: string[] = [];
      for (const [key, session] of sessions) {
        if (now - session.lastMessageAt.getTime() > thresholdMs) {
          stale.push(key);
        }
      }
      return stale;
    },

    canEnqueue(key: string): boolean {
      const session = sessions.get(key);
      if (!session) return false;
      return session.messageQueue.length < MAX_QUEUE_DEPTH;
    },

    shutdownAll(): void {
      for (const [key, session] of sessions) {
        killSession(session);
        sessions.delete(key);
      }
    },

    size(): number {
      return sessions.size;
    },
  };
}

export type CLISessionStore = ReturnType<typeof createCLISessionStore>;
