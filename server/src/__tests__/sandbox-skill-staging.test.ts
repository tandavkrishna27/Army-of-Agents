/**
 * U6.7 — stage the agent's own skill bundles into the sandbox; the managed
 * marketplace-skills root (and its cross-company siblings) is never mounted.
 *
 * Builds a fixture "managed marketplace-skills root" on disk with TWO company
 * subtrees: the run agent's own skill (`companyA/my-skill`, with an ancillary
 * `references/x.md`) and a cross-company sibling (`companyB/other-skill`).
 * Only `my-skill` is resolved into a `RuntimeSkillEntry[]` (mirroring what
 * `listRuntimeSkillEntries` — scoped to the agent's `skillKeys` — would
 * produce), so `other-skill`/`companyB` are never even read into memory, let
 * alone staged.
 *
 * `syncAdapterExecutionTargetDirectory` is spied (not fully mocked — the real
 * implementation still runs) so every call's `localDir` can be inspected
 * against the REAL managed-root detector (`isInsideManagedMarketplaceSkillsRoot`,
 * `managed-skills-root.ts`) as a regression guard against a future refactor
 * that starts pointing `localDir` at the shared install root.
 *
 * The fake sandbox runner interprets the exact two shell scripts
 * `syncAdapterExecutionTargetDirectory` emits for a `provider-sandbox` target
 * (`ensureAdapterExecutionTargetDirectory`'s `mkdir -p … && [ -d … ]` and
 * `syncAdapterExecutionTargetFile`'s `mkdir -p "$(dirname …)" && base64 -d >
 * …"` — see `packages/adapter-utils/src/execution-target.ts`) rather than a
 * general shell/tar emulator (that's `sandbox-provider-runtime.ts`'s fake,
 * which models `stageRepoIntoSandbox`'s different tar-based script shape).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionTarget } from "@armyofagents/adapter-utils";
import type { RuntimeSkillEntry } from "../services/company-skills.js";
import { isInsideManagedMarketplaceSkillsRoot } from "../services/marketplace-install/managed-skills-root.js";

const syncCalls: Array<{ localDir: string; remoteDir: string }> = [];

vi.mock("@armyofagents/adapter-utils", async (importActual) => {
  const actual = await importActual<typeof import("@armyofagents/adapter-utils")>();
  return {
    ...actual,
    syncAdapterExecutionTargetDirectory: async (
      input: Parameters<typeof actual.syncAdapterExecutionTargetDirectory>[0],
    ) => {
      syncCalls.push({ localDir: input.localDir, remoteDir: input.remoteDir });
      return actual.syncAdapterExecutionTargetDirectory(input);
    },
  };
});

/**
 * A minimal `AdapterProviderSandboxRunner` double that interprets exactly the
 * two shell scripts `syncAdapterExecutionTargetDirectory` emits for a
 * provider-sandbox target, backed by an in-memory file map.
 */
class FakeProviderSandboxRunner {
  files = new Map<string, Buffer>();
  dirs = new Set<string>(["/"]);
  calls: Array<{ command: string; args: string[] }> = [];

  async execute(input: {
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    stdin?: string;
  }): Promise<{ exitCode: number | null; signal: string | null; timedOut: boolean; stdout: string; stderr: string }> {
    const args = input.args ?? [];
    this.calls.push({ command: input.command, args });
    const script = args[1] ?? "";

    // ensureAdapterExecutionTargetDirectory: `mkdir -p 'X' && [ -d 'X' ]`
    const ensureDirMatch = script.match(/^mkdir -p '(.+)' && \[ -d '(.+)' \]$/);
    if (ensureDirMatch) {
      this.dirs.add(ensureDirMatch[1]);
      return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" };
    }

    // syncAdapterExecutionTargetFile: `mkdir -p "$(dirname 'X')" && base64 -d > 'X'`
    const writeFileMatch = script.match(/^mkdir -p "\$\(dirname '(.+)'\)" && base64 -d > '(.+)'$/);
    if (writeFileMatch) {
      const targetPath = writeFileMatch[2];
      this.files.set(targetPath, Buffer.from(input.stdin ?? "", "base64"));
      return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" };
    }

    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: `FakeProviderSandboxRunner: unrecognized script "${script}"`,
    };
  }
}

function buildTarget(runner: FakeProviderSandboxRunner, remoteCwd: string): AdapterExecutionTarget {
  return {
    type: "provider-sandbox",
    provider: "fake",
    providerLeaseId: "lease-u6-7",
    remoteCwd,
    runner,
  };
}

describe("stageAgentSkillsIntoSandbox (U6.7)", () => {
  let managedRootFixture: string;

  beforeEach(() => {
    syncCalls.length = 0;
    managedRootFixture = fs.mkdtempSync(path.join(os.tmpdir(), "aoa-managed-skills-fixture-"));
  });

  afterEach(() => {
    fs.rmSync(managedRootFixture, { recursive: true, force: true });
  });

  it("stages the agent's own SKILL.md + ancillary files under <remoteCwd>/.claude/skills/<key>/…", async () => {
    // Fixture managed marketplace-skills root with TWO company subtrees.
    const ownSkillDir = path.join(managedRootFixture, "companyA", "my-skill");
    fs.mkdirSync(path.join(ownSkillDir, "references"), { recursive: true });
    fs.writeFileSync(path.join(ownSkillDir, "SKILL.md"), "# My Skill\n");
    fs.writeFileSync(path.join(ownSkillDir, "references", "x.md"), "reference content\n");

    const siblingSkillDir = path.join(managedRootFixture, "companyB", "other-skill");
    fs.mkdirSync(siblingSkillDir, { recursive: true });
    fs.writeFileSync(path.join(siblingSkillDir, "SKILL.md"), "# Other Skill (cross-company)\n");

    // Simulates listRuntimeSkillEntries scoped to this agent's
    // skillKeys=["my-skill"] — companyB/other-skill is never read into a
    // RuntimeSkillEntry at all, by construction.
    const agentSkills: RuntimeSkillEntry[] = [
      {
        key: "my-skill",
        name: "My Skill",
        markdown: fs.readFileSync(path.join(ownSkillDir, "SKILL.md"), "utf8"),
        trustLevel: "trusted",
        files: [
          {
            path: "references/x.md",
            content: fs.readFileSync(path.join(ownSkillDir, "references", "x.md"), "utf8"),
          },
        ],
      },
    ];

    const runner = new FakeProviderSandboxRunner();
    const remoteCwd = "/workspace/run-u6-7";
    const target = buildTarget(runner, remoteCwd);

    const { stageAgentSkillsIntoSandbox } = await import(
      "../services/internal-agent/aoa-agents/sandbox-skill-staging.js"
    );

    await stageAgentSkillsIntoSandbox({
      runId: "run-u6-7",
      target,
      remoteCwd,
      skills: agentSkills,
    });

    const remoteSkillsDir = `${remoteCwd}/.claude/skills`;
    const stagedPaths = [...runner.files.keys()]
      .filter((p) => p.startsWith(`${remoteSkillsDir}/`))
      .map((p) => p.slice(remoteSkillsDir.length + 1));

    expect(stagedPaths).toEqual(
      expect.arrayContaining(["my-skill/SKILL.md", "my-skill/references/x.md"]),
    );
    expect(runner.files.get(`${remoteSkillsDir}/my-skill/SKILL.md`)?.toString("utf8")).toBe(
      "# My Skill\n",
    );
    expect(runner.files.get(`${remoteSkillsDir}/my-skill/references/x.md`)?.toString("utf8")).toBe(
      "reference content\n",
    );

    // The cross-company sibling is ABSENT from everything staged.
    expect(stagedPaths.some((p) => p.includes("other-skill"))).toBe(false);
    expect(stagedPaths.some((p) => p.includes("companyB"))).toBe(false);
    expect([...runner.files.keys()].some((p) => p.includes("other-skill"))).toBe(false);
    expect([...runner.files.keys()].some((p) => p.includes("companyB"))).toBe(false);

    // NEGATIVE: the managed root itself is NEVER a
    // syncAdapterExecutionTargetDirectory `localDir` — only the per-run built
    // tmp `.claude/skills` dir is. Checked against BOTH this test's own
    // fixture root (the concrete scenario) and the REAL managed-root detector
    // (the invariant a future refactor could actually violate).
    expect(syncCalls.length).toBeGreaterThan(0);
    for (const call of syncCalls) {
      const resolvedLocalDir = path.resolve(call.localDir);
      expect(resolvedLocalDir.startsWith(path.resolve(managedRootFixture))).toBe(false);
      expect(isInsideManagedMarketplaceSkillsRoot(call.localDir)).toBe(false);
    }
  });

  it("is a no-op (no sync call, no files) when the agent has no resolved skills", async () => {
    const runner = new FakeProviderSandboxRunner();
    const remoteCwd = "/workspace/run-empty";
    const target = buildTarget(runner, remoteCwd);

    const { stageAgentSkillsIntoSandbox } = await import(
      "../services/internal-agent/aoa-agents/sandbox-skill-staging.js"
    );

    await stageAgentSkillsIntoSandbox({ runId: "run-empty", target, remoteCwd, skills: [] });

    expect(runner.files.size).toBe(0);
    expect(syncCalls.length).toBe(0);
  });

  it("never throws when the sandbox runner rejects every command (best-effort)", async () => {
    const remoteCwd = "/workspace/run-failing";
    const failingRunner = {
      async execute() {
        throw new Error("sandbox unreachable");
      },
    };
    const target: AdapterExecutionTarget = {
      type: "provider-sandbox",
      provider: "fake",
      providerLeaseId: "lease-failing",
      remoteCwd,
      runner: failingRunner as unknown as FakeProviderSandboxRunner,
    };

    const { stageAgentSkillsIntoSandbox } = await import(
      "../services/internal-agent/aoa-agents/sandbox-skill-staging.js"
    );

    const skills: RuntimeSkillEntry[] = [
      { key: "my-skill", name: "My Skill", markdown: "# My Skill\n", trustLevel: "trusted" },
    ];

    await expect(
      stageAgentSkillsIntoSandbox({ runId: "run-failing", target, remoteCwd, skills }),
    ).resolves.toBeUndefined();
  });
});
