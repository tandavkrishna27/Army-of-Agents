/**
 * CLI-002/D4 + D5 — the staging orchestrator.
 *
 * Proves, against a provider-neutral in-memory `FileStagingTransport` stub (no key):
 *   - out-of-scope adapters fail closed BEFORE staging (nothing written, attributable
 *     reason) — the acceptance clause's "never a silent host fallback";
 *   - v1 adapters stage the `## Context` block + approved inputs;
 *   - unsupported/unapproved files are rejected BEFORE exec via skipped[]-with-reason
 *     and NEVER staged;
 *   - the staged env passes the U5 allowlist so DATABASE_URL / master-key / GitHub-PAT
 *     / E2B_API_KEY + host paths are ABSENT even when the overlay carried them;
 *   - adapter/tool/context versions are recorded (D5);
 *   - a fake CLI's mutation of a staged known file is observable via the seam.
 *
 * The disposition gate + U5 allowlist run REAL; only the memory-actor resolver is
 * mocked (its #118/#119 behaviour is covered by sandbox-coding-memory-bundle.test.ts).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Memory-bundle actor resolver + drizzle/db mocked so the orchestrator's memory step
// runs deterministically without a real DB. filterMemoryForActor stays REAL.
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  isNull: vi.fn((a: unknown) => ({ isNull: a })),
  or: vi.fn((...args: unknown[]) => ({ or: args })),
  gt: vi.fn((a: unknown, b: unknown) => ({ gt: [a, b] })),
  desc: vi.fn((a: unknown) => ({ desc: a })),
  inArray: vi.fn((a: unknown, b: unknown) => ({ inArray: [a, b] })),
  notInArray: vi.fn((a: unknown, b: unknown) => ({ notInArray: [a, b] })),
  sql: Object.assign(vi.fn(() => ({ sql: true })), { raw: vi.fn() }),
}));
function tableProxy(name: string) {
  return new Proxy({}, { get(_t, prop) { return `${name}.${String(prop)}`; } });
}
vi.mock("@armyofagents/db", () => ({ memoryItems: tableProxy("memoryItems") }));
vi.mock("../services/memory-access-sql.js", () => ({
  actorForAgentRun: vi.fn(async () => ({ kind: "agent", agentId: "crew-1", departmentIds: ["dept-1"] })),
  memoryAccessConditions: vi.fn(() => []),
}));

import { stageCodingRun, type FileStagingTransport } from "../services/sandbox-coding-staging.js";

// A provider-neutral in-memory staging transport (mirrors the CLI-001 mock fs).
function makeStubTransport() {
  const fs = new Map<string, Uint8Array>();
  const writeFiles = vi.fn(async (_sid: string, files: readonly { path: string; bytes: Uint8Array }[]) => {
    for (const f of files) fs.set(f.path, Uint8Array.from(f.bytes));
  });
  const transport: FileStagingTransport = {
    writeFiles,
    readFile: async (_sid, path) => {
      const b = fs.get(path);
      if (!b) throw new Error(`not found: ${path}`);
      return b;
    },
    listDir: async (_sid, path) => [...fs.keys()].filter((p) => p.startsWith(path)),
  };
  return { transport, fs, writeFiles };
}

// A DB whose select resolves to one company-visibility memory row.
function makeMemoryDb() {
  const chain: any = {};
  const ret = () => chain;
  chain.from = ret;
  chain.where = ret;
  chain.orderBy = ret;
  chain.limit = () => Promise.resolve([
    { id: "m1", title: "Company norm", content: "We ship weekly", layer: "domain", visibility: "company", departmentId: null, projectId: null, goalId: null, taskId: null, ownerType: null, ownerId: null, agentId: null, invalidatedAt: null },
  ]);
  return { select: vi.fn(() => chain) };
}

const dec = (b: Uint8Array) => new TextDecoder().decode(b);

const SECRET_OVERLAY = {
  ANTHROPIC_API_KEY: "sk-ant-xxx",
  DATABASE_URL: "postgres://secret",
  AOA_SECRETS_MASTER_KEY: "master-xxx",
  GITHUB_PAT: "ghp_xxx",
  E2B_API_KEY: "e2b-xxx",
  HOST_SECRET_PATH: "/etc/shadow",
  // U5 ADMITS these host-workspace-path keys (the sandbox path must strip them —
  // a real host filesystem path here would violate "host paths absent").
  AOA_WORKSPACE_WORKTREE_PATH: "C:\\Users\\dev\\worktrees\\wt-42",
  AOA_WORKSPACE_CWD: "/home/dev/repo",
};

describe("CLI-002/D4 — staging orchestrator (fail-closed + reject-before-exec)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("fails closed on an out-of-scope adapter BEFORE staging (nothing written)", async () => {
    const { transport, writeFiles } = makeStubTransport();
    const result = await stageCodingRun({
      db: makeMemoryDb() as any,
      companyId: "co-1",
      agentId: "crew-1",
      adapterType: "hermes_local",
      deploymentMode: "cloud_auth",
      provider: "anthropic",
      transport,
      sandboxId: "sbx-1",
      source: "task body",
      envOverlay: SECRET_OVERLAY,
    });
    expect(result.admitted).toBe(false);
    expect(result.rejectionReason).toContain("hermes_local");
    expect(result.stagedPaths).toEqual([]);
    expect(writeFiles).not.toHaveBeenCalled(); // never a silent host fallback
    expect(result.record.adapterDisposition).toBe("out_of_scope");
    // U5 still keeps the secrets out of any staged env.
    expect(result.stagedEnv).not.toHaveProperty("DATABASE_URL");
    expect(result.stagedEnv).not.toHaveProperty("E2B_API_KEY");
  });

  it("admits a v1 adapter and stages the ## Context block", async () => {
    const { transport, fs } = makeStubTransport();
    const result = await stageCodingRun({
      db: makeMemoryDb() as any,
      companyId: "co-1",
      agentId: "crew-1",
      adapterType: "claude_local",
      deploymentMode: "cloud_auth",
      provider: "anthropic",
      transport,
      sandboxId: "sbx-1",
      source: "Build the SSO form",
      instructions: "Follow the approved spec",
      envOverlay: SECRET_OVERLAY,
      toolVersion: "claude 2.1.126",
      contextMode: "standard",
    });
    expect(result.admitted).toBe(true);
    const ctxPath = "/home/user/.aoa/context.md";
    expect(result.stagedPaths).toContain(ctxPath);
    const block = dec(fs.get(ctxPath)!);
    expect(block).toContain("## Context");
    expect(block).toContain("Build the SSO form");
    expect(block).toContain("Follow the approved spec");
    expect(block).toContain("Company norm"); // actor-gated memory folded in
  });

  it("rejects unsupported + unapproved inputs BEFORE exec; stages only approved", async () => {
    const { transport, fs } = makeStubTransport();
    const enc = (s: string) => new TextEncoder().encode(s);
    const result = await stageCodingRun({
      db: makeMemoryDb() as any,
      companyId: "co-1",
      agentId: "crew-1",
      adapterType: "codex_local",
      deploymentMode: "cloud_auth",
      provider: "openai",
      transport,
      sandboxId: "sbx-1",
      source: "task",
      declaredInputs: [
        { id: "ok-src", path: "/work/main.ts", bytes: enc("export const x = 1;") },
        { id: "bad-bin", path: "/work/logo.png", bytes: enc("\x89PNG"), contentType: "image/png" },
        { id: "unapproved", path: "/work/notes.md", bytes: enc("secret"), approved: false },
      ],
    });
    expect(result.stagedPaths).toContain("/work/main.ts");
    expect(result.stagedPaths).not.toContain("/work/logo.png");
    expect(result.stagedPaths).not.toContain("/work/notes.md");
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { id: "bad-bin", type: "declared_input", reason: "unsupported_type" },
        { id: "unapproved", type: "declared_input", reason: "not_approved" },
      ]),
    );
    // Unsupported file never reached the sandbox.
    expect(fs.has("/work/logo.png")).toBe(false);
  });

  it("U5: DATABASE_URL / master-key / GitHub-PAT / E2B_API_KEY / host paths are ABSENT; provider key present", async () => {
    const { transport } = makeStubTransport();
    const result = await stageCodingRun({
      db: makeMemoryDb() as any,
      companyId: "co-1",
      agentId: "crew-1",
      adapterType: "claude_local",
      deploymentMode: "cloud_auth",
      provider: "anthropic",
      transport,
      sandboxId: "sbx-1",
      envOverlay: SECRET_OVERLAY,
    });
    expect(result.stagedEnv).toHaveProperty("ANTHROPIC_API_KEY", "sk-ant-xxx");
    for (const forbidden of ["DATABASE_URL", "AOA_SECRETS_MASTER_KEY", "GITHUB_PAT", "E2B_API_KEY", "HOST_SECRET_PATH", "AOA_WORKSPACE_WORKTREE_PATH", "AOA_WORKSPACE_CWD"]) {
      expect(result.stagedEnv, `${forbidden} must be absent`).not.toHaveProperty(forbidden);
    }
  });

  it("D5: records adapter/tool/context versions", async () => {
    const { transport } = makeStubTransport();
    const result = await stageCodingRun({
      db: makeMemoryDb() as any,
      companyId: "co-1",
      agentId: "crew-1",
      adapterType: "claude_local",
      deploymentMode: "cloud_auth",
      provider: "anthropic",
      transport,
      sandboxId: "sbx-1",
      source: "task",
      toolVersion: "claude 2.1.126",
      contextMode: "full",
    });
    expect(result.record.adapterType).toBe("claude_local");
    expect(result.record.adapterDisposition).toBe("v1");
    expect(result.record.adapterProvider).toBe("anthropic");
    expect(result.record.toolVersion).toBe("claude 2.1.126");
    expect(result.record.contextMode).toBe("full");
    expect(result.record.contextDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.record.memoryActorResolved).toBe(true);
    expect(result.record.memoryItemCount).toBe(1);
    expect(result.record.stagedFileCount).toBeGreaterThan(0);
  });

  it("a fake CLI mutation of a staged known file is observable through the seam", async () => {
    const { transport, fs } = makeStubTransport();
    await stageCodingRun({
      db: makeMemoryDb() as any,
      companyId: "co-1",
      agentId: "crew-1",
      adapterType: "claude_local",
      deploymentMode: "cloud_auth",
      provider: "anthropic",
      transport,
      sandboxId: "sbx-1",
      source: "task",
      declaredInputs: [{ id: "out", path: "/work/output.txt", bytes: new TextEncoder().encode("original") }],
    });
    expect(dec(await transport.readFile("sbx-1", "/work/output.txt"))).toBe("original");
    // Simulate the fake CLI writing the known file, then read the mutation back.
    fs.set("/work/output.txt", new TextEncoder().encode("MUTATED"));
    expect(dec(await transport.readFile("sbx-1", "/work/output.txt"))).toBe("MUTATED");
  });
});
