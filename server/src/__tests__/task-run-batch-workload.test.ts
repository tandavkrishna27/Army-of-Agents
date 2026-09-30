// task-run-batch-workload.test.ts — CLI-006 / Blocker A.
//
// The builder is the ONLY thing that decides what a canary task run executes inside a
// sandbox, and argv is the only channel. Every arm here corresponds to a way the previous
// design would have produced a run that PASSES the acceptance verifier while proving
// nothing: a claude-shaped argv for an `http` agent, a one-second deadline, a silently
// truncated prompt, or a non-deterministic digest that 409s on replay.
import { describe, expect, it } from "vitest";
import { batchWorkloadV1Schema } from "@armyofagents/worker-protocol";
import { CODING_ADAPTER_DISPOSITIONS } from "../services/sandbox-coding-disposition.js";
import { resolveHeartbeatRunTimeoutPolicy } from "../services/heartbeat-stop-metadata.js";
// ★ VALUE import of the worker-daemon originals, in TEST ONLY. Production mirrors these two
// numbers (see task-run-batch-workload.ts) so the control plane ships no runtime import of
// this barrel; this assertion is what makes the mirror safe instead of a second source of truth.
import {
  RUN_OP_DEADLINE_FLOOR_MS,
  RUN_OP_DEADLINE_CEILING_MS,
} from "@armyofagents/worker-daemon";
import {
  SANDBOX_INVOCATION_COMMAND,
  STAGED_INSTRUCTIONS_PATH,
  STAGED_INPUT_MISSING_EXIT_CODE,
  STAGED_PROMPT_PATH,
  STAGED_AOA_MCP_CONFIG_PATH,
  SANDBOX_INVOCATION_BINARY_ARG_INDEX,
} from "../services/task-run-sandbox-invocation.js";
import {
  FROZEN_MAX_ARG_CHARS,
  MAX_STAGED_FILE_BYTES,
  SUBMISSION_MAX_INPUT_BYTES,
  TASK_RUN_DEFAULT_MAX_RUNTIME_SECONDS,
  buildTaskRunBatchWorkload,
  maxRuntimeSecondsForPolicy,
  resolveTaskRunMaxRuntimeSeconds,
  type TaskRunBatchWorkloadInput,
  TASK_RUN_MIN_ENFORCEABLE_SECONDS,
  TASK_RUN_MAX_ENFORCEABLE_SECONDS,
} from "../services/task-run-batch-workload.js";

const PROMPT = "## Task AOA-1\n\nShip the thing.";

// CLI-008 Unit C — a realistic brokered `aoa` MCP config document. Its bytes are opaque to
// the builder (buildSandboxInvocation stages the string verbatim); what S2 owns is that a
// config handed to buildTaskRunBatchWorkload reaches the staged file and the argv, and that
// the empty-is-absent fold + flag-off inertness are decided at THIS layer.
const AOA_MCP_CONFIG = JSON.stringify({
  mcpServers: {
    aoa: {
      type: "http",
      url: "https://api.example/companies/c1/mcp",
      headers: { Authorization: "Bearer ${AOA_API_KEY}" },
    },
  },
});

function input(over: Partial<TaskRunBatchWorkloadInput> = {}): TaskRunBatchWorkloadInput {
  return {
    adapterType: "claude_local",
    runtimeCommandSpec: { command: "claude" },
    adapterConfig: {},
    currentTaskMarkdown: PROMPT,
    ...over,
  };
}

// ★ THE MATRIX IS THE SOURCE OF TRUTH, NOT A HAND-COPIED LIST.
//
// A hardcoded list of refused adapters was the first draft, and mutation testing killed it:
// deleting the `dispositionForAdapter` gate from the builder left all of those tests GREEN,
// because `buildArgsFor` already returns `null` for anything that is not one of the two
// shapes and produces the SAME `adapter_not_v1_scope` reason. The two guards are
// behaviourally equivalent today, so no example-based test can tell them apart.
//
// What a hardcoded list cannot catch is DRIFT: the day the matrix admits a third adapter to
// `v1`, the argv switch would silently refuse it and the distributed path would go dark for
// that adapter with no test going red. Deriving the cases from
// `CODING_ADAPTER_DISPOSITIONS` — the same matrix `execution-secret-handle-mint.ts` gates
// the credential on — is what makes "the builder admits exactly the v1 bucket" checkable
// rather than asserted.
describe("the disposition gate (derived from the matrix, not a copy of it)", () => {
  const ENTRIES = Object.entries(CODING_ADAPTER_DISPOSITIONS);
  const V1 = ENTRIES.filter(([, d]) => d.bucket === "v1").map(([type]) => type);
  const NON_V1 = ENTRIES.filter(([, d]) => d.bucket !== "v1");

  it("the matrix still has a non-empty v1 bucket (else every case below is vacuous)", () => {
    expect(V1.length).toBeGreaterThan(0);
    expect(NON_V1.length).toBeGreaterThan(0);
  });

  it.each(V1)("ADMITS %s — the matrix says v1, so the builder must have an argv shape", (adapterType) => {
    const result = buildTaskRunBatchWorkload(
      input({ adapterType, runtimeCommandSpec: { command: "bin" } }),
    );
    expect(result.ok, `${adapterType} is v1 in the matrix but the builder refused it`).toBe(true);
  });

  // The canary fork in heartbeat.ts has NO adapter gate, so every one of these reaches the
  // builder. `http` is the sharpest case: `command: "http"` passes
  // `z.string().min(1).max(256)`, so without a gate the supervisor would run a nonexistent
  // binary inside a sandbox while the real webhook stayed suppressed.
  it.each(NON_V1.map(([type, d]) => [type, d.bucket] as const))(
    "refuses %s (%s bucket)",
    (adapterType) => {
      const result = buildTaskRunBatchWorkload(
        input({ adapterType, runtimeCommandSpec: { command: adapterType } }),
      );
      expect(result).toEqual({ ok: false, reason: "adapter_not_v1_scope" });
    },
  );

  it("refuses an unregistered adapter type (fail closed on the unknown)", () => {
    const result = buildTaskRunBatchWorkload(input({ adapterType: "totally_new_local" }));
    expect(result).toEqual({ ok: false, reason: "adapter_not_v1_scope" });
  });

  it("covers every REGISTERED adapter type — no type escapes the gate untested", () => {
    // `evaluateDispositionCoverage` already proves the matrix covers the registry; this
    // proves the BUILDER is exercised against every entry of that matrix, so a newly
    // registered adapter cannot reach the seam without a decision recorded here.
    expect(new Set([...V1, ...NON_V1.map(([t]) => t)]).size).toBe(ENTRIES.length);
  });
});

describe("the command", () => {
  // ★ SINCE UNIT D `workload.command` IS `sh`, AND THE REAL BINARY IS AN ARGV ELEMENT. That is
  // not a loosening of "never the registry key" — it is where the guarantee moved to, because
  // a stdin REDIRECTION has to be interpreted by a shell and `shellJoin` quotes every token
  // (so a bare `<` in the argv would be a literal, never a redirect). The assertions below
  // follow the binary to its new position rather than being deleted.
  it("uses the adapter's real binary from the runtime command spec", () => {
    const result = buildTaskRunBatchWorkload(input());
    expect(result.ok && result.workload.command).toBe(SANDBOX_INVOCATION_COMMAND);
    expect(result.ok && result.workload.args[SANDBOX_INVOCATION_BINARY_ARG_INDEX]).toBe("claude");
  });

  it("honors a founder adapterConfig.command override (already resolved into the spec)", () => {
    const result = buildTaskRunBatchWorkload(
      input({ runtimeCommandSpec: { command: "/opt/bin/claude-pinned" } }),
    );
    expect(result.ok && result.workload.args[SANDBOX_INVOCATION_BINARY_ARG_INDEX]).toBe(
      "/opt/bin/claude-pinned",
    );
  });

  // ★★★ THE PROPERTY THE `sh -c` SHAPE HAS TO EARN. The script is a fixed literal and the
  // binary rides as a SEPARATE argv element read back as `$0`, so a founder-supplied command
  // cannot close a quote and append a second command — structurally, not by sanitizing. If a
  // future edit ever interpolates the binary into the script string, this goes red.
  //
  // ★★ EVERY SCRIPT BRANCH, NOT ONE. There are four (two adapters x with/without an
  // instructions bundle), and mutation testing proved why that matters: interpolating the
  // binary into the WITH-instructions claude branch alone left a single-case version of this
  // test green, because the fixture had no bundle and took the other branch.
  it.each([
    ["claude_local", undefined],
    ["claude_local", "# bundle"],
    ["codex_local", undefined],
    ["codex_local", "# bundle"],
  ])("refuses to interpolate a hostile binary into the %s script (instructions: %s)", (adapterType, instructions) => {
    const hostile = `claude'; rm -rf / #`;
    const result = buildTaskRunBatchWorkload(
      input({ adapterType, runtimeCommandSpec: { command: hostile }, instructions }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const script = result.workload.args[1]!;
    expect(script).not.toContain("rm -rf");
    expect(script).not.toContain(hostile);
    expect(result.workload.args[SANDBOX_INVOCATION_BINARY_ARG_INDEX]).toBe(hostile);
  });

  // The same property for the CONTENT, which is the larger surface: a prompt full of shell
  // metacharacters is bytes in a file the script never sees, not text the script embeds.
  it.each([
    ["claude_local", "claude", undefined],
    ["claude_local", "claude", "# bundle $(id)"],
    ["codex_local", "codex", undefined],
    ["codex_local", "codex", "# bundle $(id)"],
  ])("never puts task content into the %s script (instructions: %s)", (adapterType, binary, instructions) => {
    const nasty = "$(touch /tmp/pwned) `id` '; echo hi; '";
    const result = buildTaskRunBatchWorkload(
      input({
        adapterType,
        runtimeCommandSpec: { command: binary },
        currentTaskMarkdown: nasty,
        instructions,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const joined = result.workload.args.join("\u0000");
    expect(joined).not.toContain("touch /tmp/pwned");
    expect(joined).not.toContain("bundle $(id)");
    const staged = result.stagedFiles.find((file) => file.path === STAGED_PROMPT_PATH);
    expect(new TextDecoder().decode(staged!.bytes)).toBe(nasty);
  });

  // 5 of the 14 registered adapters have no `getRuntimeCommandSpec`, so `runtimeCommandSpec`
  // is `null`. A null is a REFUSAL — never a fallback to the registry key.
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a spec with no command", {}],
    ["a non-string command", { command: 7 }],
    ["a whitespace-only command", { command: "   " }],
  ])("refuses %s", (_label, spec) => {
    const result = buildTaskRunBatchWorkload(
      input({ runtimeCommandSpec: spec as TaskRunBatchWorkloadInput["runtimeCommandSpec"] }),
    );
    expect(result).toEqual({ ok: false, reason: "no_runtime_command_spec" });
  });

  it("never emits the adapter TYPE as the command (the shadow comparator's bug)", () => {
    const result = buildTaskRunBatchWorkload(input());
    expect(result.ok && result.workload.command).not.toBe("claude_local");
  });
});

describe("the per-adapter argv shapes (CLI-008 Unit D)", () => {
  it("emits the claude shape, reading the prompt from a STAGED FILE on stdin", () => {
    const result = buildTaskRunBatchWorkload(input({ adapterType: "claude_local" }));
    expect(result.ok && result.workload.command).toBe("sh");
    expect(result.ok && result.workload.args).toEqual([
      "-c",
      expect.stringContaining(
        'exec "$0" --print - --dangerously-skip-permissions --output-format stream-json --verbose < "$1"',
      ),
      "claude",
      STAGED_PROMPT_PATH,
    ]);
  });

  it("emits the codex shape — NOT the claude flags, which are meaningless to it", () => {
    const result = buildTaskRunBatchWorkload(
      input({ adapterType: "codex_local", runtimeCommandSpec: { command: "codex" } }),
    );
    expect(result.ok && result.workload.args).toEqual([
      "-c",
      expect.stringContaining(
        'exec "$0" exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox - < "$1"',
      ),
      "codex",
      STAGED_PROMPT_PATH,
    ]);
    expect(result.ok && result.workload.args.join(" ")).not.toContain("--append-system-prompt-file");
  });

  // ★ THE UNATTENDED-RUN POSTURE (E7-F021 / E7-F027, founder-authorized 2026-09-11). A distributed
  // run has no human at the terminal, so the CLI must not stop on a permission/approval prompt.
  // These assertions go RED the instant a posture flag is dropped from the emitted script — which
  // is the whole point of asserting the flag by exact byte here rather than trusting the source.
  it.each([
    ["claude_local", "claude", undefined],
    ["claude_local", "claude", "# Be excellent"],
  ])("the %s script skips permission prompts for unattended execution (instructions: %s)", (adapterType, binary, instructions) => {
    const result = buildTaskRunBatchWorkload(
      input({ adapterType, runtimeCommandSpec: { command: binary }, instructions }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workload.args[1]).toContain("--dangerously-skip-permissions");
  });

  it.each([
    ["codex_local", "codex", undefined],
    ["codex_local", "codex", "# Be excellent"],
  ])("the %s script bypasses approvals for unattended execution (instructions: %s)", (adapterType, binary, instructions) => {
    const result = buildTaskRunBatchWorkload(
      input({ adapterType, runtimeCommandSpec: { command: binary }, instructions }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workload.args[1]).toContain("--skip-git-repo-check");
    expect(result.workload.args[1]).toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  // ★ THE ASSERTION THIS DESCRIBE EXISTS FOR, and it is not example-based. Every absolute path
  // the argv names must be a path this build also STAGES. A future shape that adds a third
  // file — an MCP config (Unit C), a workspace manifest (Unit E) — and forgets to stage it would
  // place a leasable attempt whose sandbox reads a file nobody wrote. Deriving the expectation
  // from the emitted argv rather than from a fixture is what makes that a red test rather than
  // a comment.
  it.each([
    ["claude_local", "claude", undefined, undefined],
    ["claude_local", "claude", "# Be excellent", undefined],
    ["claude_local", "claude", undefined, "aoa"],
    ["claude_local", "claude", "# Be excellent", "aoa"],
    ["codex_local", "codex", undefined, undefined],
    ["codex_local", "codex", "# Be excellent", undefined],
    // a config handed to a codex run is dropped, not staged — the set-equality proves it
    // stages no byte the argv does not read (and reads no path it does not stage).
    ["codex_local", "codex", undefined, "aoa"],
  ])(
    "every absolute path in the %s argv is staged (instructions: %s, config: %s)",
    (adapterType, binary, instructions, configToken) => {
      const aoaMcpConfig = configToken === "aoa" ? AOA_MCP_CONFIG : undefined;
      const result = buildTaskRunBatchWorkload(
        input({ adapterType, runtimeCommandSpec: { command: binary }, instructions, aoaMcpConfig }),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const stagedPaths = result.stagedFiles.map((file) => file.path);
      const argvPaths = result.workload.args.filter((arg) => arg.startsWith("/"));
      expect(argvPaths.length).toBeGreaterThan(0);
      for (const argvPath of argvPaths) {
        expect(stagedPaths.includes(argvPath), `${argvPath} is in the argv but nothing stages it`).toBe(true);
      }
      // …and the converse: a staged byte no argv reads is a byte nobody consumes.
      expect([...stagedPaths].sort()).toEqual([...argvPaths].sort());
    },
  );

  it("carries the adapter's real binary as an argv element, never the registry key", () => {
    const result = buildTaskRunBatchWorkload(input());
    expect(result.ok && result.workload.args[SANDBOX_INVOCATION_BINARY_ARG_INDEX]).toBe("claude");
    expect(result.ok && result.workload.args).not.toContain("claude_local");
  });

  it("leaves stdinArtifactId null (zero consumers anywhere in the daemon)", () => {
    const result = buildTaskRunBatchWorkload(input());
    expect(result.ok && result.workload.stdinArtifactId).toBeNull();
  });
});

describe("the instructions bundle (CLI-008 Unit D)", () => {
  const INSTRUCTIONS = "# SOUL\n\nYou are the CFO agent.";

  it("stages the bundle and points --append-system-prompt-file at the STAGED path", () => {
    const result = buildTaskRunBatchWorkload(input({ instructions: INSTRUCTIONS }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workload.args[1]).toContain('--append-system-prompt-file "$2"');
    expect(result.workload.args).toContain(STAGED_INSTRUCTIONS_PATH);
    const staged = result.stagedFiles.find((file) => file.path === STAGED_INSTRUCTIONS_PATH);
    expect(new TextDecoder().decode(staged!.bytes)).toBe(INSTRUCTIONS);
  });

  // codex has no append-system-prompt flag; the legacy adapter prepends the bundle to the
  // stdin prompt, and so does this.
  it("prepends the bundle to codex's stdin instead of inventing a flag it does not have", () => {
    const result = buildTaskRunBatchWorkload(
      input({ adapterType: "codex_local", runtimeCommandSpec: { command: "codex" }, instructions: INSTRUCTIONS }),
    );
    expect(result.ok && result.workload.args[1]).toContain(
      '{ cat "$2"; echo; cat "$1"; } | "$0" exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -',
    );
  });

  // ★★★ THE SEPARATOR, ASSERTED ON WHAT THE CLI RECEIVES — NOT ON THE SCRIPT'S TEXT.
  //
  // The legacy codex adapter builds its prefix as `${instructionsContents}\n\n` (verified at
  // `codex-local/src/server/execute.ts:503-507`), so concatenating the two staged files with
  // nothing between them is a BEHAVIOUR CHANGE against the shipped path, not a formatting nit.
  // A bundle whose last heading fuses into the task's first line has not arrived intact, which
  // is the one thing this unit exists to deliver.
  //
  // ★★ AND THE FIXTURE HAS NO TRAILING NEWLINE, ON PURPOSE. A bundle that happens to end in one
  // passes with or without the separator, so a test written that way proves nothing — the shape
  // of every dead guard this programme has filed. The case that can only pass WITH the separator
  // is the one asserted.
  //
  // `stdinFromScript` reads the emitted script and computes the bytes the CLI's stdin actually
  // receives, so the assertion is on the OBSERVABLE result. It throws on a script it does not
  // recognise, which is the anti-vacuity control: a shape change cannot make this test silently
  // stop testing anything.
  function stdinFromScript(script: string, bundle: string, prompt: string): string {
    if (script.includes('{ cat "$2"; echo; cat "$1"; } | "$0"')) return `${bundle}\n${prompt}`;
    if (script.includes('cat "$2" "$1" | "$0"')) return `${bundle}${prompt}`;
    if (script.includes('exec "$0" exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox - < "$1"'))
      return prompt;
    throw new Error(`stdinFromScript does not understand this script: ${script}`);
  }

  it("★ keeps the codex bundle and the task on separate lines when the bundle has NO trailing newline", () => {
    const bundle = "# SOUL\n\nYou are the CFO agent."; // deliberately no trailing newline
    const prompt = "# Task AOA-1";
    expect(bundle.endsWith("\n")).toBe(false);

    const result = buildTaskRunBatchWorkload(
      input({
        adapterType: "codex_local",
        runtimeCommandSpec: { command: "codex" },
        instructions: bundle,
        currentTaskMarkdown: prompt,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const stdin = stdinFromScript(result.workload.args[1]!, bundle, prompt);
    // The load-bearing assertion: the bundle's last line and the task's first line are NOT one
    // line. Removing the separator fuses them into "You are the CFO agent.# Task AOA-1".
    expect(stdin).not.toContain("agent.# Task");
    expect(stdin.split("\n")).toContain("You are the CFO agent.");
    expect(stdin.split("\n")).toContain("# Task AOA-1");
    // …and the staged bytes are still EXACTLY the host file's — the separator lives at the point
    // of use, so the same object can also serve claude's `--append-system-prompt-file`.
    const staged = result.stagedFiles.find((file) => file.path === STAGED_INSTRUCTIONS_PATH);
    expect(new TextDecoder().decode(staged!.bytes)).toBe(bundle);
  });

  it("a bundle that DOES end in a newline gets the legacy blank line, not a single one", () => {
    // The legacy prefix is `${contents}\n\n`. A bundle already ending in `\n` plus the
    // separator reproduces exactly that.
    const bundle = "# SOUL\n\nYou are the CFO agent.\n";
    const prompt = "# Task AOA-1";
    const result = buildTaskRunBatchWorkload(
      input({
        adapterType: "codex_local",
        runtimeCommandSpec: { command: "codex" },
        instructions: bundle,
        currentTaskMarkdown: prompt,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(stdinFromScript(result.workload.args[1]!, bundle, prompt)).toBe(`${bundle}\n${prompt}`);
  });

  it("the no-bundle codex shape feeds the prompt alone (no phantom separator)", () => {
    const prompt = "# Task AOA-1";
    const result = buildTaskRunBatchWorkload(
      input({ adapterType: "codex_local", runtimeCommandSpec: { command: "codex" }, currentTaskMarkdown: prompt }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(stdinFromScript(result.workload.args[1]!, "", prompt)).toBe(prompt);
  });

  it.each([
    ["absent", undefined],
    ["null", null],
    ["empty", ""],
    ["whitespace-only", "  \n "],
  ])("stages NO bundle and emits NO bundle flag when it is %s", (_label, instructions) => {
    const result = buildTaskRunBatchWorkload(input({ instructions }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stagedFiles.map((file) => file.path)).toEqual([STAGED_PROMPT_PATH]);
    expect(result.workload.args.join(" ")).not.toContain("--append-system-prompt-file");
  });

  // ★ The guard in the script is what turns "the pointer extension is critical:false, so an
  // older worker stages nothing" from a mystery into an answer. Without it the failure is a
  // bare `sh` redirection error (exit 2) or — for the codex `cat |` shape — the CLI's own exit
  // code with an empty prompt, which looks like a successful context-free run.
  it("guards every staged path it reads, with an attributable exit code", () => {
    for (const instructions of [undefined, INSTRUCTIONS]) {
      // ★ the config dimension: a claude run with a staged aoa config has THREE staged files;
      // the guard must guard the config positional too, or an older worker stages nothing and
      // the sandbox reads a file nobody wrote. codex never stages it, so its count is unchanged.
      for (const aoaMcpConfig of [undefined, AOA_MCP_CONFIG]) {
        for (const [adapterType, binary] of [["claude_local", "claude"], ["codex_local", "codex"]]) {
          const result = buildTaskRunBatchWorkload(
            input({ adapterType, runtimeCommandSpec: { command: binary }, instructions, aoaMcpConfig }),
          );
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          const script = result.workload.args[1]!;
          const guard = script.slice(0, script.indexOf("done") + 4);
          for (let i = 1; i <= result.stagedFiles.length; i += 1) {
            expect(guard, `${adapterType} does not guard $${i}`).toContain(`"$${i}"`);
          }
          // …and never a parameter it does not pass: `[ -r "" ]` is false, so guarding an unset
          // positional would fail every run for a file it never needed.
          expect(guard).not.toContain(`"$${result.stagedFiles.length + 1}"`);
          expect(script).toContain(`exit ${STAGED_INPUT_MISSING_EXIT_CODE}`);
        }
      }
    }
  });
});

describe("the brokered aoa MCP config (CLI-008 Unit C S2)", () => {
  function build(over: Partial<TaskRunBatchWorkloadInput> = {}) {
    const result = buildTaskRunBatchWorkload(input(over));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    return { workload: result.workload, stagedFiles: result.stagedFiles };
  }

  it("stages the config for a claude run and points --mcp-config at the STAGED positional", () => {
    const { workload, stagedFiles } = build({ aoaMcpConfig: AOA_MCP_CONFIG });
    const staged = stagedFiles.find((file) => file.path === STAGED_AOA_MCP_CONFIG_PATH);
    expect(staged, "the config was not staged").toBeTruthy();
    expect(new TextDecoder().decode(staged!.bytes)).toBe(AOA_MCP_CONFIG);
    expect(staged!.contentType).toContain("application/json");
    // no instructions bundle, so the prompt is $1 and the config is the second staged file → $2.
    const configIndex = stagedFiles.findIndex((file) => file.path === STAGED_AOA_MCP_CONFIG_PATH) + 1;
    expect(configIndex).toBe(2);
    expect(workload.args[1]).toContain(`--mcp-config "$${configIndex}"`);
    expect(workload.args[1]).toContain("--strict-mcp-config");
    expect(workload.args[1]).toContain("--allowedTools mcp__aoa");
  });

  it("stages the config AFTER the instructions bundle (config becomes $3, bundle stays $2)", () => {
    const { workload, stagedFiles } = build({ instructions: "# SOUL", aoaMcpConfig: AOA_MCP_CONFIG });
    const configIndex = stagedFiles.findIndex((file) => file.path === STAGED_AOA_MCP_CONFIG_PATH) + 1;
    expect(configIndex).toBe(3);
    expect(workload.args[1]).toContain(`--mcp-config "$${configIndex}"`);
    // the two staged pointers do not collide: the bundle flag still reads $2.
    expect(workload.args[1]).toContain('--append-system-prompt-file "$2"');
  });

  // ★ THE NORMALIZATION S2 OWNS. buildSandboxInvocation only does `?? null`, so an empty or
  // whitespace-only document would reach it as a non-null string and be staged as a zero-byte
  // config that `--mcp-config` points at — a flag that promises a tool surface and delivers a
  // parse error. buildTaskRunBatchWorkload folds empty/whitespace to ABSENT, exactly as it does
  // for the instructions bundle. These cases can ONLY pass if that fold is present.
  it.each([
    ["empty", ""],
    ["whitespace-only", "  \n\t "],
  ])("treats a %s config as ABSENT — no staged file, no flags", (_label, aoaMcpConfig) => {
    const withConfig = build({ aoaMcpConfig });
    const baseline = build({});
    expect(withConfig).toEqual(baseline);
    expect(withConfig.stagedFiles.map((f) => f.path)).not.toContain(STAGED_AOA_MCP_CONFIG_PATH);
    expect(withConfig.workload.args.join(" ")).not.toContain("--mcp-config");
  });

  // The inert guarantee: with the tool-surface flag off (every caller today), a null/absent
  // config yields a workload byte-identical to the pre-Unit-C shape.
  it.each([
    ["absent", undefined],
    ["null", null],
  ])("is byte-identical to the no-config baseline when the config is %s", (_label, aoaMcpConfig) => {
    expect(build({ aoaMcpConfig })).toEqual(build({}));
  });

  // codex has no --mcp-config channel; a config handed to a codex run is dropped, not staged,
  // so the codex shape stays byte-identical whether or not a config is present.
  it("never stages the config for a codex run", () => {
    const codex = { adapterType: "codex_local", runtimeCommandSpec: { command: "codex" } };
    const withConfig = build({ ...codex, aoaMcpConfig: AOA_MCP_CONFIG });
    const baseline = build({ ...codex });
    expect(withConfig).toEqual(baseline);
    expect(withConfig.stagedFiles.map((f) => f.path)).not.toContain(STAGED_AOA_MCP_CONFIG_PATH);
    expect(withConfig.workload.args.join(" ")).not.toContain("mcp__aoa");
  });
});

describe("the prompt", () => {
  it("carries the REAL assembled task markdown, trimmed, as STAGED BYTES", () => {
    const result = buildTaskRunBatchWorkload(input({ currentTaskMarkdown: `\n\n${PROMPT}\n\n` }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const staged = result.stagedFiles.find((file) => file.path === STAGED_PROMPT_PATH);
    expect(new TextDecoder().decode(staged!.bytes)).toBe(PROMPT);
  });

  // ★★★ E7-F008 — THE ONLY LIVE REFUSAL AMONG THE OPEN FINDINGS, CLOSED HERE.
  //
  // The prompt used to be an argv positional, so `FROZEN_MAX_ARG_CHARS = 8192` refused it:
  // `prompt_too_large`, a task that could not dispatch distributed AT ALL. Measured then:
  // minimal framing accepted 7,736 description characters and refused 7,737. It is a staged
  // file now, so the frozen per-element ceiling does not reach it.
  //
  // This asserts the far side of the old cliff and then some — 8x it, which is what the
  // finding's own chunked-argv remedy would have bought, and 100x it, which no argv shape
  // could have carried at all.
  it.each([
    ["one character past the OLD cliff", FROZEN_MAX_ARG_CHARS + 1],
    ["8x the old cliff (what chunked argv would have bought)", FROZEN_MAX_ARG_CHARS * 8],
    ["100x the old cliff (beyond any argv shape)", FROZEN_MAX_ARG_CHARS * 100],
  ])("dispatches a prompt at %s", (_label, length) => {
    const prompt = "x".repeat(length);
    const result = buildTaskRunBatchWorkload(input({ currentTaskMarkdown: prompt }));
    expect(result.ok, "E7-F008 has regressed: a large prompt cannot dispatch").toBe(true);
    if (!result.ok) return;
    const staged = result.stagedFiles.find((file) => file.path === STAGED_PROMPT_PATH);
    expect(staged!.bytes.byteLength).toBe(length);
    // …and the frozen schema still accepts the argv, because the prompt is not in it.
    expect(batchWorkloadV1Schema.safeParse(result.workload).success).toBe(true);
  });

  it.each([
    ["absent", undefined],
    ["null", null],
    ["non-string", 42],
    ["empty", ""],
    ["whitespace-only", "   \n\t "],
  ])("refuses a %s prompt rather than running an empty task", (_label, markdown) => {
    const result = buildTaskRunBatchWorkload(input({ currentTaskMarkdown: markdown }));
    expect(result).toEqual({ ok: false, reason: "empty_prompt" });
  });

  it("accepts a prompt exactly at the staging ceiling", () => {
    const result = buildTaskRunBatchWorkload(
      input({ currentTaskMarkdown: "x".repeat(MAX_STAGED_FILE_BYTES) }),
    );
    expect(result.ok).toBe(true);
  });

  // REFUSE, never truncate: a truncated prompt still creates a sandbox, still terminalizes,
  // and still satisfies the acceptance verifier while the agent works from a mutilated task.
  // The ceiling moved from the frozen argv element's to the staging path's; the DIRECTION did
  // not, and a refusal still exists — so this is a guard that moved, not a guard that was
  // deleted.
  it("REFUSES a prompt past the staging ceiling — it does not truncate it", () => {
    const oversized = "x".repeat(MAX_STAGED_FILE_BYTES + 1);
    const result = buildTaskRunBatchWorkload(input({ currentTaskMarkdown: oversized }));
    expect(result).toEqual({ ok: false, reason: "staged_input_too_large" });
  });

  it("REFUSES an instructions bundle past the staging ceiling too", () => {
    const result = buildTaskRunBatchWorkload(
      input({ instructions: "y".repeat(MAX_STAGED_FILE_BYTES + 1) }),
    );
    expect(result).toEqual({ ok: false, reason: "staged_input_too_large" });
  });

  // HONESTY ABOUT THE 64 KiB BACKSTOP. It cannot fire today, and this test says WHY rather
  // than pretending to exercise it. The worst-case JSON expansion of a JS string is 6 bytes
  // per UTF-16 unit (a control char escapes to a six-character `backslash-u-XXXX`); a
  // non-BMP emoji is only 2 bytes per unit. So ONE arg capped at 8192 units reaches at most
  // ~48 KiB, and both argv shapes carry exactly one large arg. The `workload_too_large` arm
  // is a backstop for a future shape with a SECOND large arg (Unit 2's system-prompt
  // delivery is the obvious one). If either constant moves — so the backstop becomes
  // reachable, or so the cap stops guaranteeing the bound — this assertion tells you.
  it("the frozen arg ceiling structurally guarantees the 64 KiB submission bound", () => {
    const WORST_CASE_JSON_BYTES_PER_UNIT = 6; // the widest JSON escape for one UTF-16 unit
    const worstCaseOneArg = FROZEN_MAX_ARG_CHARS * WORST_CASE_JSON_BYTES_PER_UNIT;

    // Empirical, not assumed: 8192 control chars really do encode to 6 bytes each.
    const probe = String.fromCharCode(1).repeat(FROZEN_MAX_ARG_CHARS);
    expect(new TextEncoder().encode(JSON.stringify(probe)).byteLength).toBe(
      worstCaseOneArg + 2, // + the two surrounding quotes
    );

    // A control-char prompt at the exact ceiling therefore still BUILDS — the backstop does
    // not fire, which is the fact this test pins.
    const built = buildTaskRunBatchWorkload(input({ currentTaskMarkdown: probe }));
    expect(built.ok).toBe(true);
    if (built.ok) {
      const encoded = new TextEncoder().encode(JSON.stringify(built.workload)).byteLength;
      expect(encoded).toBeLessThanOrEqual(SUBMISSION_MAX_INPUT_BYTES);
    }

    // ONE large arg can never reach the bound; TWO could. That is the backstop's remit.
    expect(worstCaseOneArg).toBeLessThan(SUBMISSION_MAX_INPUT_BYTES);
    expect(worstCaseOneArg * 2).toBeGreaterThan(SUBMISSION_MAX_INPUT_BYTES);
  });

});

describe("maxRuntimeSeconds", () => {
  // ★ THE ONE-SECOND TRAP. `defaultTimeoutSecForAdapter` returns 0 for EVERY adapter, so an
  // unconfigured agent has `effectiveTimeoutSec === 0`. A bare `clamp(sec, 1, 86400)` would
  // yield 1 — every default-configured agent killed after one second, terminalizing `failed`
  // while the verifier's clauses still pass.
  it("applies the 240s default when no timeout is configured (NOT a 1s clamp of the 0 default)", () => {
    const result = buildTaskRunBatchWorkload(input({ adapterConfig: {} }));
    expect(result.ok && result.workload.maxRuntimeSeconds).toBe(
      TASK_RUN_DEFAULT_MAX_RUNTIME_SECONDS,
    );
    expect(result.ok && result.workload.maxRuntimeSeconds).not.toBe(1);
  });

  it("applies the 240s default for a null/absent adapter config", () => {
    for (const adapterConfig of [null, undefined]) {
      const result = buildTaskRunBatchWorkload(input({ adapterConfig }));
      expect(result.ok && result.workload.maxRuntimeSeconds).toBe(240);
    }
  });

  it("honors a configured timeout inside the enforceable band", () => {
    const result = buildTaskRunBatchWorkload(input({ adapterConfig: { timeoutSec: 120 } }));
    expect(result.ok && result.workload.maxRuntimeSeconds).toBe(120);
  });

  // ★ A configured value BELOW what the worker can enforce is raised, not passed through.
  // 45s was the previous fixture here and silently became a 60s run: the workload said 45,
  // the supervisor's floor said 60. Declaring the enforced number is the whole point.
  it("raises a sub-floor configured timeout to the enforceable floor", () => {
    const result = buildTaskRunBatchWorkload(input({ adapterConfig: { timeoutSec: 45 } }));
    expect(result.ok && result.workload.maxRuntimeSeconds).toBe(TASK_RUN_MIN_ENFORCEABLE_SECONDS);
  });

  it("clamps a configured timeout to the 240s ENFORCEABLE ceiling", () => {
    const result = buildTaskRunBatchWorkload(input({ adapterConfig: { timeoutSec: 7_200 } }));
    expect(result.ok && result.workload.maxRuntimeSeconds).toBe(240);
  });

  // ★ THE FLOOR HAS EXACTLY ONE PRODUCER, AND IT IS NOT claude_local.
  //
  // A `{ timeoutSec: 45.9 }` case against `claude_local` looks like it tests the floor and
  // does not: `resolveHeartbeatRunTimeoutPolicy` ALREADY applies `Math.floor` on its
  // non-http branch, so `effectiveTimeoutSec` is integral before this module sees it, and
  // deleting our `Math.floor` leaves that test green (mutation-verified). The ONLY fractional
  // producer is the `http` branch (`timeoutMs / 1000`, no floor) — which the disposition gate
  // keeps out of `buildTaskRunBatchWorkload` entirely. So the floor is exercised HERE, at the
  // exported resolver, against the producer that actually emits a fraction. If a future
  // widening ever routes a fractional policy to the builder, `.int()` would 400 the
  // submission; this is the assertion that keeps the backstop honest and non-vacuous.
  it("floors a fractional timeout — the frozen schema is .int()", () => {
    // ★ The inputs MUST sit inside [MIN, MAX]_ENFORCEABLE. 45.9s and 1.5s were used here
    // before the enforceable floor existed; both now clamp to 60 whether or not flooring
    // happens, which would make this assertion vacuous — the exact trap the mutation sweep
    // caught once already. 90.9s floors to 90 and survives the clamp, so the .int() backstop
    // stays observable.
    expect(resolveTaskRunMaxRuntimeSeconds("http", { timeoutMs: 90_900 })).toBe(90);
    expect(resolveTaskRunMaxRuntimeSeconds("http", { timeoutMs: 239_400 })).toBe(239);

    // The upstream producer for the gated adapters is already integral — this pins WHY the
    // claude_local form of this test would be vacuous, so nobody re-adds it.
    expect(resolveHeartbeatRunTimeoutPolicy("claude_local", { timeoutSec: 45.9 })
      .effectiveTimeoutSec).toBe(45);
    expect(resolveHeartbeatRunTimeoutPolicy("http", { timeoutMs: 45_900 })
      .effectiveTimeoutSec).toBe(45.9);

    // A sub-1 configured value: the wire clamp raises it to 1, then the ENFORCEABLE floor
    // raises it to 60. The property under test is unchanged — it never reaches 0, which the
    // frozen `.min(1)` would reject — only the surviving bound moved.
    expect(resolveTaskRunMaxRuntimeSeconds("http", { timeoutMs: 500 }))
      .toBe(TASK_RUN_MIN_ENFORCEABLE_SECONDS);

    // …whereas a sub-1 timeoutSec floors to 0 UPSTREAM, so timeoutConfigured is false and the
    // 240s default applies. Not 1 — the difference between the two branches matters.
    expect(resolveTaskRunMaxRuntimeSeconds("claude_local", { timeoutSec: 0.5 })).toBe(240);
  });

  // The widened `number | null` on HeartbeatRunTimeoutPolicy: a null/NaN must fall to the
  // 240s DEFAULT, never to Math.max(1, null) === 1 — the one-second trap in a second guise.
  // Unreachable through the public resolver today, which is exactly why it is tested here.
  it.each([
    ["a null effectiveTimeoutSec", null],
    ["a NaN effectiveTimeoutSec", Number.NaN],
    ["an Infinity effectiveTimeoutSec", Number.POSITIVE_INFINITY],
  ])("falls to the 240s default for %s even when timeoutConfigured is true", (_l, effectiveTimeoutSec) => {
    expect(
      maxRuntimeSecondsForPolicy({ effectiveTimeoutSec, timeoutConfigured: true }),
    ).toBe(TASK_RUN_DEFAULT_MAX_RUNTIME_SECONDS);
  });

  it("always emits an integer within the frozen 1..86400 bound", () => {
    for (const [adapterType, config] of [
      ["claude_local", { timeoutSec: 1 }],
      ["claude_local", { timeoutSec: 45 }],
      ["claude_local", { timeoutSec: 599 }],
      ["claude_local", { timeoutSec: 600 }],
      ["claude_local", { timeoutSec: 601 }],
      ["claude_local", { timeoutSec: 86_400 }],
      ["claude_local", { timeoutSec: 999_999 }],
      ["http", { timeoutMs: 1 }],
      ["http", { timeoutMs: 2_500 }],
      ["http", { timeoutMs: 599_999 }],
      ["http", { timeoutMs: 999_999_999 }],
    ] as const) {
      const timeoutSec = JSON.stringify(config);
      const seconds = resolveTaskRunMaxRuntimeSeconds(adapterType, config);
      expect(Number.isInteger(seconds), `timeoutSec=${timeoutSec}`).toBe(true);
      expect(seconds).toBeGreaterThanOrEqual(1);
      expect(seconds).toBeLessThanOrEqual(240);
    }
  });
});

describe("determinism", () => {
  // `job-submission.ts` hashes the whole command INCLUDING `input`; a differing digest under
  // the same idempotencyKey (= run.id) throws 409. Any timestamp, nonce or randomUUID here
  // would turn every redelivery into a hard conflict.
  it("produces a byte-identical workload from identical inputs", () => {
    const a = buildTaskRunBatchWorkload(input());
    const b = buildTaskRunBatchWorkload(input());
    expect(a.ok && b.ok).toBe(true);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("emits keys in a fixed order across adapters", () => {
    const claude = buildTaskRunBatchWorkload(input({ adapterType: "claude_local" }));
    const codex = buildTaskRunBatchWorkload(
      input({ adapterType: "codex_local", runtimeCommandSpec: { command: "codex" } }),
    );
    expect(claude.ok && Object.keys(claude.workload)).toEqual([
      "command",
      "args",
      "stdinArtifactId",
      "maxRuntimeSeconds",
    ]);
    expect(codex.ok && Object.keys(codex.workload)).toEqual(
      claude.ok ? Object.keys(claude.workload) : [],
    );
  });

  it("does not mutate its input", () => {
    const adapterConfig = { timeoutSec: 45 };
    const spec = { command: "claude" };
    buildTaskRunBatchWorkload(input({ adapterConfig, runtimeCommandSpec: spec }));
    expect(adapterConfig).toEqual({ timeoutSec: 45 });
    expect(spec).toEqual({ command: "claude" });
  });
});

describe("the frozen schema has the last word", () => {
  it("every accepted workload re-parses against batchWorkloadV1Schema", () => {
    for (const adapterType of ["claude_local", "codex_local"]) {
      const result = buildTaskRunBatchWorkload(input({ adapterType }));
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(batchWorkloadV1Schema.safeParse(result.workload).success).toBe(true);
    }
  });

  it("emits no field the strict frozen schema does not declare", () => {
    const result = buildTaskRunBatchWorkload(input());
    expect(result.ok && Object.keys(result.workload).sort()).toEqual([
      "args",
      "command",
      "maxRuntimeSeconds",
      "stdinArtifactId",
    ]);
  });
});

describe("declared budget == enforced budget (anti-drift)", () => {
  // The defect this pins: the builder used to declare 600s while the worker enforced 240s, and
  // `job-leasing.ts` derives the LEASE deadline from the declared value — so the lease outlived
  // the execution deadline by six minutes and a task using its declared budget died early.
  it("mirrors the worker's enforced bounds exactly", () => {
    expect(TASK_RUN_MIN_ENFORCEABLE_SECONDS * 1000).toBe(RUN_OP_DEADLINE_FLOOR_MS);
    expect(TASK_RUN_MAX_ENFORCEABLE_SECONDS * 1000).toBe(RUN_OP_DEADLINE_CEILING_MS);
  });

  it("never declares a budget the worker would clamp", () => {
    const enforce = (declaredSeconds: number) =>
      Math.min(RUN_OP_DEADLINE_CEILING_MS, Math.max(RUN_OP_DEADLINE_FLOOR_MS, declaredSeconds * 1000));
    for (const cfg of [
      undefined,
      {},
      { timeoutSec: 1 },
      { timeoutSec: 45 },
      { timeoutSec: 240 },
      { timeoutSec: 600 },
      { timeoutSec: 86_400 },
    ]) {
      const declared = resolveTaskRunMaxRuntimeSeconds("claude_local", cfg ?? null);
      expect(enforce(declared)).toBe(declared * 1000);
    }
  });
});
