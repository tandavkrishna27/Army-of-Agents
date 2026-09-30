// task-run-instructions-bundle.test.ts — CLI-008 Unit D.
//
// Two properties, and both are about PARITY WITH THE SHIPPED PATH rather than about tidiness.
//
// 1. Three outcomes are kept apart: no bundle, a bundle in hand, and a bundle that is
//    configured but could not be read. Collapsing the third into the first is the failure the
//    whole unit is written to avoid — a canary agent running in a sandbox without its identity,
//    producing plausible work, terminalizing cleanly, and satisfying every clause.
//
// 2. The configured path reaches `readFile` VERBATIM, because that is what both v1 adapters do
//    (`claude-local/.../execute.ts:629`, `codex-local/.../execute.ts:503` — both verified). A
//    resolver that is cleverer than the adapters stages bytes no legacy run has ever used.

import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  INSTRUCTIONS_FILE_PATH_KEY,
  resolveTaskRunInstructionsBundle,
} from "../services/task-run-instructions-bundle.js";

const ABS = path.resolve("/srv/aoa/agents/cfo/AGENTS.md");
const BUNDLE = "# AGENTS\n\nYou are the CFO agent.";

describe("no bundle configured", () => {
  it.each([
    ["a null config", null],
    ["an undefined config", undefined],
    ["an empty config", {}],
    ["an empty string", { [INSTRUCTIONS_FILE_PATH_KEY]: "" }],
    ["a whitespace-only string", { [INSTRUCTIONS_FILE_PATH_KEY]: "   " }],
    ["a non-string", { [INSTRUCTIONS_FILE_PATH_KEY]: 42 }],
  ])("reports configured:false for %s, and never touches the filesystem", async (_label, adapterConfig) => {
    const readFile = vi.fn(async () => BUNDLE);
    const result = await resolveTaskRunInstructionsBundle({
      adapterConfig: adapterConfig as Record<string, unknown> | null | undefined,
      readFile,
    });
    expect(result).toEqual({ ok: true, configured: false });
    expect(readFile).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ★★★ THE PARITY PROPERTY, PINNED ON THE DIVERGENT CASE.
//
// Codex raised this as a P2 and it was right. An earlier version resolved a RELATIVE
// `instructionsFilePath` against `adapterConfig.cwd`; both adapters pass the raw string to
// `fs.readFile`, which resolves against the SERVER PROCESS's directory. (`adapterConfig.cwd` is
// the CHILD process's cwd — `execute.ts:192` / `:249` — used for spawning, not for this read.)
// So a canary could read a DIFFERENT file from its legacy fallback, or succeed where legacy
// would have failed: a canary green for the wrong reason.
//
// ★★ EVERY FIXTURE BELOW IS A CASE WHERE THE TWO BEHAVIOURS DISAGREE. A relative path with no
// cwd, or with a cwd that happens to match the process directory, passes under BOTH behaviours
// and proves nothing — the same shape as a trailing-newline fixture for a separator test.
// ─────────────────────────────────────────────────────────────────────────────
describe("★ the path reaches readFile EXACTLY as configured (parity with the adapters)", () => {
  const RELATIVE = "agents/cfo/AGENTS.md";
  const FOREIGN_CWD = path.resolve("/srv/aoa/somewhere-else");

  it("passes a RELATIVE path through unresolved, even when adapterConfig.cwd is absolute", async () => {
    // Anti-vacuity: the two candidate behaviours must actually differ for this fixture.
    expect(path.resolve(FOREIGN_CWD, RELATIVE)).not.toBe(RELATIVE);

    const readFile = vi.fn(async () => BUNDLE);
    const result = await resolveTaskRunInstructionsBundle({
      adapterConfig: { [INSTRUCTIONS_FILE_PATH_KEY]: RELATIVE, cwd: FOREIGN_CWD },
      readFile,
    });

    // What the ADAPTER would read…
    expect(readFile).toHaveBeenCalledWith(RELATIVE);
    // …and NOT what the route-level bundle editor service would resolve.
    expect(readFile).not.toHaveBeenCalledWith(path.resolve(FOREIGN_CWD, RELATIVE));
    expect(result).toEqual({ ok: true, configured: true, hostPath: RELATIVE, content: BUNDLE });
  });

  it("a relative path with NO cwd is read, not refused — legacy would read it too", async () => {
    // The earlier version returned `unresolvable_path` here. That is the opposite asymmetry:
    // distributed refuses while legacy runs. Safe, but still not parity, and it silently took
    // every agent with a relative path off the distributed path.
    const readFile = vi.fn(async () => BUNDLE);
    const result = await resolveTaskRunInstructionsBundle({
      adapterConfig: { [INSTRUCTIONS_FILE_PATH_KEY]: RELATIVE },
      readFile,
    });
    expect(readFile).toHaveBeenCalledWith(RELATIVE);
    expect(result.ok).toBe(true);
  });

  it("does NOT expand ~ — the adapters do not, so a tilde path is read as the literal it is", async () => {
    const readFile = vi.fn(async () => BUNDLE);
    await resolveTaskRunInstructionsBundle({
      adapterConfig: { [INSTRUCTIONS_FILE_PATH_KEY]: "~/aoa/AGENTS.md" },
      readFile,
    });
    expect(readFile).toHaveBeenCalledWith("~/aoa/AGENTS.md");
  });

  it("trims surrounding whitespace, exactly as `asString(...).trim()` does at both read sites", async () => {
    const readFile = vi.fn(async () => BUNDLE);
    await resolveTaskRunInstructionsBundle({
      adapterConfig: { [INSTRUCTIONS_FILE_PATH_KEY]: `  ${ABS}  ` },
      readFile,
    });
    expect(readFile).toHaveBeenCalledWith(ABS);
  });

  it("an ABSOLUTE path is unaffected by cwd (the case where both behaviours agree)", async () => {
    const readFile = vi.fn(async () => BUNDLE);
    await resolveTaskRunInstructionsBundle({
      adapterConfig: { [INSTRUCTIONS_FILE_PATH_KEY]: ABS, cwd: FOREIGN_CWD },
      readFile,
    });
    expect(readFile).toHaveBeenCalledWith(ABS);
  });
});

describe("★★★ a configured bundle that cannot be produced is a REFUSAL, never an absence", () => {
  it("reports unreadable when the read throws", async () => {
    const result = await resolveTaskRunInstructionsBundle({
      adapterConfig: { [INSTRUCTIONS_FILE_PATH_KEY]: ABS },
      readFile: async () => {
        throw new Error("ENOENT: no such file or directory");
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unreadable");
    // Attributable: the operator learns WHICH file and WHY.
    expect(result.detail).toContain(ABS);
    expect(result.detail).toContain("ENOENT");
  });

  it("a relative path that does not exist is `unreadable` — attributable, and legacy-identical", async () => {
    const result = await resolveTaskRunInstructionsBundle({
      adapterConfig: { [INSTRUCTIONS_FILE_PATH_KEY]: "agents/cfo/AGENTS.md" },
      readFile: async () => {
        throw new Error("ENOENT: no such file or directory");
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unreadable");
    expect(result.detail).toContain("agents/cfo/AGENTS.md");
  });

  // ★ THE DISCRIMINATION ITSELF, asserted as a property rather than per-case. If a future
  // "simplification" folded a refusal into `{ok:true, configured:false}` — the shape a
  // `string | null` return would force — this is the test that goes red.
  it("a refusal is never mistakable for 'this agent has no bundle'", async () => {
    const absent = await resolveTaskRunInstructionsBundle({ adapterConfig: {}, readFile: async () => BUNDLE });
    const refused = await resolveTaskRunInstructionsBundle({
      adapterConfig: { [INSTRUCTIONS_FILE_PATH_KEY]: ABS },
      readFile: async () => {
        throw new Error("EACCES");
      },
    });
    expect(absent.ok).toBe(true);
    expect(refused.ok).toBe(false);
    expect(absent).not.toEqual(refused);
  });

  it("never throws, whatever the reader does", async () => {
    for (const thrown of [new Error("boom"), "a string", null, undefined]) {
      await expect(
        resolveTaskRunInstructionsBundle({
          adapterConfig: { [INSTRUCTIONS_FILE_PATH_KEY]: ABS },
          readFile: async () => {
            throw thrown;
          },
        }),
      ).resolves.toMatchObject({ ok: false });
    }
  });
});
