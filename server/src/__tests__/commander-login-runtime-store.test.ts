import { describe, expect, it, vi } from "vitest";
import { makeTableProxy } from "./helpers/drizzle-mock.js";

/**
 * Drizzle-backed ChallengeStore `claim` tests (Codex P1 #3 — atomic
 * single-flight). The `(provider, auth_home, status)` index is NON-unique, so
 * the claim MUST run inside one transaction serialized by
 * `pg_advisory_xact_lock` (advisory-lock precedent: first-user-bootstrap.ts).
 *
 * drizzle-orm is mocked with a CAPTURING `sql` tag (the shared stub in
 * helpers/drizzle-mock.ts discards template contents, and we need to assert
 * the lock function + key).
 */

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ op: "and", args }),
  eq: (...args: unknown[]) => ({ op: "eq", args }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    sql: strings.join("?"),
    values,
  }),
}));
vi.mock("@armyofagents/db", () => ({
  commanderLoginChallenges: makeTableProxy("commander_login_challenges"),
}));
vi.mock("@armyofagents/adapter-codex-local/server", () => ({
  runCodexLogin: vi.fn(),
  resolveSharedCodexHomeDir: vi.fn(() => "/home/.codex"),
}));
vi.mock("@armyofagents/adapter-claude-local/server", () => ({
  runClaudeLoginStreaming: vi.fn(),
  resolveClaudeConfigHome: vi.fn(() => "/home/.claude"),
  // The runner registry reads its `credentialFileName` from the adapter (one
  // spelling of the filename, shared with crew config-home provisioning), so the
  // mock has to carry it too.
  CLAUDE_CREDENTIAL_FILE_NAME: ".credentials.json",
}));
vi.mock("../utils/terminate-process.js", () => ({
  terminateByPid: vi.fn(),
  terminateByPidIfMatches: vi.fn(),
}));

import { drizzleChallengeStore } from "../services/commander-login-runtime.js";
import type { ChallengeRow } from "../services/commander-login.js";

type CapturedSql = { sql: string; values: unknown[] };

/** Fake db: `transaction(fn)` runs fn against a capturing tx. */
function makeDb(existingRows: unknown[]) {
  const executed: CapturedSql[] = [];
  const inserted: Array<Record<string, unknown>> = [];
  const deleted: unknown[] = [];
  const events: string[] = [];
  let txCount = 0;
  const tx = {
    execute: async (arg: CapturedSql) => {
      events.push("execute");
      executed.push(arg);
      return undefined;
    },
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => {
              events.push("select");
              return existingRows;
            },
          }),
        }),
      }),
    }),
    insert: () => ({
      values: async (v: Record<string, unknown>) => {
        events.push("insert");
        inserted.push(v);
      },
    }),
    delete: () => ({
      where: async (cond: unknown) => {
        events.push("delete");
        deleted.push(cond);
      },
    }),
  };
  const db = {
    transaction: async (fn: (t: typeof tx) => unknown) => {
      txCount += 1;
      return await fn(tx);
    },
  } as never;
  return { db, executed, inserted, deleted, events, get txCount() { return txCount; } };
}

function row(overrides: Partial<ChallengeRow> = {}): ChallengeRow {
  return {
    id: "ch-new",
    companyId: "c1",
    provider: "openai",
    authHome: "/home/.codex",
    loginUrl: null,
    pid: null,
    pgid: null,
    status: "pending",
    startedByUserId: "u1",
    startedAt: new Date(0),
    ...overrides,
  };
}

describe("drizzleChallengeStore.claim (atomic single-flight)", () => {
  it("runs inside ONE transaction and takes pg_advisory_xact_lock on the (provider, authHome) key first", async () => {
    const h = makeDb([]);
    const store = drizzleChallengeStore(h.db);
    await store.claim({ provider: "openai", authHome: "/home/.codex", row: row(), onExisting: () => {} });

    expect(h.txCount).toBe(1);
    expect(h.executed).toHaveLength(1);
    expect(h.executed[0]!.sql).toContain("pg_advisory_xact_lock");
    expect(h.executed[0]!.sql).toContain("hashtext");
    expect(h.executed[0]!.values).toEqual(["commander-login:openai:/home/.codex"]);
    // Lock BEFORE the pending-row read — otherwise the read races.
    expect(h.events.slice(0, 2)).toEqual(["execute", "select"]);
  });

  it("no existing pending row → inserts the new row, deletes nothing", async () => {
    const h = makeDb([]);
    const store = drizzleChallengeStore(h.db);
    const inserted = await store.claim({
      provider: "openai",
      authHome: "/home/.codex",
      row: row(),
      onExisting: () => {
        throw new Error("must not be called without an existing row");
      },
    });
    expect(inserted.id).toBe("ch-new");
    expect(h.deleted).toHaveLength(0);
    expect(h.inserted).toHaveLength(1);
    expect(h.inserted[0]).toMatchObject({ id: "ch-new", companyId: "c1", status: "pending", pid: null });
  });

  it("takeover: onExisting returns → existing row removed, then the new row inserted", async () => {
    const existing = {
      id: "ch-old",
      companyId: "c1",
      provider: "openai",
      authHome: "/home/.codex",
      loginUrl: null,
      pid: 555,
      pgid: 555,
      status: "pending",
      startedByUserId: "u1",
      startedAt: new Date(0),
    };
    const h = makeDb([existing]);
    const store = drizzleChallengeStore(h.db);
    const seen: ChallengeRow[] = [];
    await store.claim({
      provider: "openai",
      authHome: "/home/.codex",
      row: row(),
      onExisting: (r) => {
        seen.push(r);
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.pid).toBe(555); // the service gets the prior child's pid to terminate
    expect(h.deleted).toHaveLength(1);
    expect(h.inserted).toHaveLength(1);
    expect(h.events).toEqual(["execute", "select", "delete", "insert"]);
  });

  it("conflict: onExisting throws → the claim aborts, nothing deleted or inserted", async () => {
    const existing = { ...row({ id: "ch-old", companyId: "OTHER" }) };
    const h = makeDb([existing]);
    const store = drizzleChallengeStore(h.db);
    await expect(
      store.claim({
        provider: "openai",
        authHome: "/home/.codex",
        row: row(),
        onExisting: () => {
          throw new Error("conflict");
        },
      }),
    ).rejects.toThrow(/conflict/);
    expect(h.deleted).toHaveLength(0);
    expect(h.inserted).toHaveLength(0);
  });
});
