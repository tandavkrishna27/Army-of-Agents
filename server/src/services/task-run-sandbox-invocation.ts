// server/src/services/task-run-sandbox-invocation.ts
//
// CLI-008 Unit D — THE INVOCATION SHAPE, once the prompt stops being an argv positional.
//
// Unit B built the inbound channel (control plane → object storage → download grant →
// `transport.writeFiles`) and nothing rode it. This module is the thing that rides it: it
// decides, for one canary task run, WHICH files must exist inside the sandbox and WHAT argv
// reads them. **One function returns both**, and that is not tidiness: a path in the argv that
// no staged file writes is a run that fails at exec, and a staged file no argv reads is a byte
// nobody consumes. Two functions reading the same constants would still be two functions that
// can drift. `task-run-batch-workload.test.ts` also asserts the agreement from the OUTSIDE —
// every absolute path in the emitted argv must appear in the emitted staged set, and the
// converse — so the invariant is checked as well as structured.
//
// ★ LANE. This targets the **E2B / desktop lane**. The networked/container lane has no
// `stage_files` route (E7-F011) — its boot root ships inert (`docker/worker/Dockerfile:196`
// enters the local daemon bin, and `checkWorkersEnterTheDaemonBin` actively rejects a
// `command:` override that would enter the networked one), so nothing here can reach it. When
// that lane is entered, `ProviderWireDriver.fileStagingMode` is `"none"` and `stageFiles`
// throws `UnsupportedProviderOperation`, which the supervisor turns into a FAILED attempt.
// That is the correct direction — a refusal, not a context-free success — but it is a refusal,
// and this module does not fix it.
//
// ★★ WHY `sh -c` AND NOT THE BINARY DIRECTLY. The sandbox's only execution channel is
// `createSpecFor` → `ExecuteInput{command, args}` → `transport.runCommand`, and the real E2B
// transport `shellJoin`s the whole argv into ONE quoted command string. Quoting is what makes
// argv boundaries survive that collapse — and it is also what makes a bare `<` or `|` in the
// argv a LITERAL, never a redirection. So a redirection must live INSIDE a script that a shell
// is asked to interpret, which is exactly `sh -c "<script>" …`. `ExecuteInput` still has no
// stdin field (E7-F003 row 2 is untouched); the stdin the CLI reads is a redirect the sandbox's
// own shell performs on a file this run staged.
//
// ★★★ NOTHING IS INTERPOLATED INTO THE SCRIPT. The script is a fixed literal per (adapter,
// has-instructions) pair; the binary and both paths ride as SEPARATE argv elements and are
// read back as `$0`, `$1`, `$2`. A founder-supplied `adapterConfig.command` therefore cannot
// close a quote and append a command, no matter what it contains — the property is structural,
// not a sanitizer, and `refuses to interpolate a hostile binary into the script` pins it.

/** The in-sandbox directory this run's control-plane-authored files are staged into.
 *
 * `/home/user` is E2B's default user home — the account `files.write` writes as and
 * `commands.run` executes as — and is the same root the repo's other in-sandbox paths use
 * (`/home/user/aoa-workspace`, the E2B environment runner's cwd). A `/aoa`-style root would
 * need a writable directory at `/` that the template does not create.
 *
 * ★★★ FLAT, NOT A SUBDIRECTORY, AND THAT IS DELIBERATE. `/home/user/.aoa-run/prompt.md` would be
 * tidier and it rests on an assumption this codebase cannot currently check: that
 * `sandbox.files.write` MKDIRs its parent. The E2B SDK is believed to, but the only test that
 * writes against a real sandbox (`keyed-real-e2b.test.ts`, the keyed lane) writes FLAT paths —
 * `/home/user/output.txt`, `/home/user/base.txt` — so nothing in this repo has ever exercised a
 * nested staging write, and the no-key lanes use an in-memory map that would happily accept any
 * path. Staging into a directory that does not exist fails the whole attempt closed, which is the
 * right direction but a bad trade for tidiness. So the files are siblings of the one path shape
 * that has actually run. Nest them when Unit E needs a staged directory and something proves the
 * mkdir. */
export const STAGED_INPUT_DIR = "/home/user";

/** The assembled task markdown. Was an argv positional until Unit D; that positional is what
 * `FROZEN_MAX_ARG_CHARS` refused above 8,192 characters (E7-F008). */
export const STAGED_PROMPT_PATH = `${STAGED_INPUT_DIR}/.aoa-run-prompt.md`;

/** The agent's instructions bundle entry file — the same bytes the legacy adapters hand to
 * `--append-system-prompt-file` (claude) or prepend to stdin (codex). */
export const STAGED_INSTRUCTIONS_PATH = `${STAGED_INPUT_DIR}/.aoa-run-instructions.md`;

/** CLI-008 Unit C — the brokered `aoa` MCP config the CLAUDE arm reads via `--mcp-config`.
 * Flat sibling of the prompt/instructions (the flat-not-nested rule above stands). Staged
 * ONLY for `claude_local` and ONLY when the caller supplies a config (tool surface authorized). */
export const STAGED_AOA_MCP_CONFIG_PATH = `${STAGED_INPUT_DIR}/.aoa-run-mcp.json`;

/**
 * The exit code the in-sandbox guard uses when a staged file it needs is not readable.
 *
 * ★ WHY A GUARD AT ALL, AND WHY THIS CODE. The staged-input pointer rides `extensions[]` as
 * `critical: false` (Unit B's decision, deliberately unchanged here): a worker that does not
 * understand the namespace ignores it and stages NOTHING. Before Unit D that was harmless —
 * nothing rode the channel. Now the argv depends on it, so such a worker would run
 * `sh -c '… < /home/user/.aoa-run-prompt.md'` against a file that is not there.
 *
 * `sh`'s own diagnostic for that is a redirection failure with exit 2 — indistinguishable from
 * a hundred other shell errors, and for the `cat |` shape not even that (the pipeline's status
 * is the CLI's). 78 is `EX_CONFIG` from `sysexits.h`: no CLI in scope returns it, so it names
 * this cause and only this cause, on stderr, before the agent starts. Fail closed and SAY WHY.
 */
export const STAGED_INPUT_MISSING_EXIT_CODE = 78;

/** The command every sandbox invocation runs. The adapter's real binary is `$0` inside it. */
export const SANDBOX_INVOCATION_COMMAND = "sh";

/** Where the real binary sits in the emitted argv (`sh -c <script> <binary> …`). */
export const SANDBOX_INVOCATION_BINARY_ARG_INDEX = 2;

/** One control-plane-authored file that MUST exist inside the sandbox before the argv runs.
 * Structurally assignable to `StagedInputFile` (`job-input-staging.ts`) and to the
 * `stagedFiles` element type on `RunExecutionOwnerResolver.resolve`. */
export interface SandboxStagedFile {
  /** ABSOLUTE in-sandbox path. */
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

export interface SandboxInvocation {
  /** Always {@link SANDBOX_INVOCATION_COMMAND}. */
  readonly command: string;
  readonly args: readonly string[];
  /** The files the argv above reads — same paths, same order, built here so they cannot be
   * a different list. */
  readonly stagedFiles: readonly SandboxStagedFile[];
}

/** Everything staged by this unit is UTF-8 markdown. */
const STAGED_CONTENT_TYPE = "text/markdown; charset=utf-8";
/** The staged aoa MCP config is JSON, not markdown. */
const STAGED_JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const ENCODER = new TextEncoder();

/**
 * The readable-or-refuse preamble, over the script's positional parameters.
 *
 * Emitted for `$1 … $n` where n is the number of staged paths, so it can never check a
 * parameter the invocation does not pass (an unset `$2` would expand to an empty string and
 * `[ -r "" ]` is false — a guard that fails the run for a file it never needed).
 */
function readableGuard(pathCount: number): string {
  const params = Array.from({ length: pathCount }, (_, i) => `"$${i + 1}"`).join(" ");
  return (
    `for f in ${params}; do [ -r "$f" ] || ` +
    `{ echo "[cli-008] staged input missing: $f" >&2; exit ${STAGED_INPUT_MISSING_EXIT_CODE}; }; done`
  );
}

/**
 * Build the sandbox invocation for one adapter.
 *
 * `null` for an adapter with no shape — kept as a refusal rather than a throw so widening the
 * disposition matrix without widening this switch fails closed instead of emitting a
 * claude-shaped argv for an unrelated binary.
 *
 * ★ THE SHAPES MIRROR THE LEGACY ADAPTERS, which is the whole point of Unit D. `claude` is
 * spawned `--print -` with the prompt on stdin and the bundle on
 * `--append-system-prompt-file` (`claude-local/src/server/execute.ts:736-772, :879`); `codex`
 * is spawned `exec --json -` with the bundle PREPENDED to the stdin prompt, because codex has
 * no append-system-prompt flag (`codex-local/src/server/execute.ts:498-518, :565`). The
 * distributed path now delivers the same three things through the same two flags.
 *
 * ★★ WHAT IS DELIBERATELY NOT MIRRORED: the legacy path appends a *path directive* to the
 * instructions — "resolve any relative file references from <host dir>". That directive names
 * a HOST directory which does not exist in the sandbox, and the bundle's SIBLING files
 * (`HEARTBEAT.md`, `SOUL.md`, `TOOLS.md`) are not staged either. Emitting it would send the
 * agent hunting a directory that is not there. Staging the whole bundle directory needs
 * `--add-dir` and a multi-file staging shape; that is Unit E's workspace work, and until then
 * a relative reference inside the entry file is unresolvable in the sandbox. This is a KNOWN
 * gap of Unit D, and it is a sub-case of E7-F003 row 1 rather than a new finding.
 */
export function buildSandboxInvocation(input: {
  readonly adapterType: string;
  /** The adapter's real binary, already resolved from `runtimeCommandSpec`. */
  readonly binary: string;
  /** The assembled task markdown. Already trimmed and known non-empty by the caller. */
  readonly prompt: string;
  /** The instructions bundle entry file's content, or `null` when the agent has no bundle.
   * `null` is the ONLY thing that changes the emitted shape — there is no "stage an empty
   * bundle" state, because `--append-system-prompt-file` on an empty file is a flag that
   * promises context and delivers none. */
  readonly instructions: string | null;
  /** CLI-008 Unit C — the serialized brokered `aoa` MCP config, or `null` when the distributed
   * tool surface is not authorized for this run. Staged + wired into the argv ONLY for
   * `claude_local`; ignored for every other adapter (codex staging is the deferred MX3). `null`
   * keeps the emitted invocation byte-identical to the pre-Unit-C output. */
  readonly aoaMcpConfig?: string | null;
}): SandboxInvocation | null {
  // The paths, the argv that reads them, and the bytes written to them are all derived from
  // this ONE list, in this ONE function.
  // CLI-008 Unit C: the brokered `aoa` MCP config is staged ONLY for claude_local and ONLY when
  // the caller authorized the tool surface (config !== null). It joins the SAME staged list, so
  // `paths`, the readable guard's arity, and the trailing `...paths` argv all update by
  // construction — the argv↔staged set-equality and guard-contiguity invariants hold automatically.
  const aoaMcpConfig = input.aoaMcpConfig ?? null;
  const stageAoaConfig = aoaMcpConfig !== null && input.adapterType === "claude_local";
  const staged: SandboxStagedFile[] = [
    { path: STAGED_PROMPT_PATH, bytes: ENCODER.encode(input.prompt), contentType: STAGED_CONTENT_TYPE },
    ...(input.instructions === null
      ? []
      : [
          {
            path: STAGED_INSTRUCTIONS_PATH,
            bytes: ENCODER.encode(input.instructions),
            contentType: STAGED_CONTENT_TYPE,
          },
        ]),
    ...(stageAoaConfig
      ? [
          {
            path: STAGED_AOA_MCP_CONFIG_PATH,
            bytes: ENCODER.encode(aoaMcpConfig as string),
            contentType: STAGED_JSON_CONTENT_TYPE,
          },
        ]
      : []),
  ];
  const paths = staged.map((file) => file.path);
  const guard = readableGuard(paths.length);

  let script: string;
  const hasInstructions = input.instructions !== null;
  switch (input.adapterType) {
    case "claude_local":
      // `--dangerously-skip-permissions` is required for unattended sandbox execution
      // (E7-F021, founder-authorized 2026-09-11): a distributed run has no human to answer
      // claude's permission prompt, and the flag is scoped to this throwaway sandbox only.
      // The NO-CONFIG branches are the SHIPPED literals verbatim: the W7U1 permission-posture
      // guard (scripts/lib/__tests__/w7u1-agent-output-probe.test.mjs) reads this source and
      // asserts the emitter still carries --dangerously-skip-permissions on these exact tails, so
      // they must stay literal. Unit C adds a config branch that appends the mcp segment
      // (config is the LAST staged path -> `$${paths.length}`, = $2 with no bundle, $3 with).
      if (stageAoaConfig) {
        const mcp = ` --mcp-config "$${paths.length}" --strict-mcp-config --allowedTools mcp__aoa`;
        script = hasInstructions
          ? `${guard}; exec "$0" --print - --dangerously-skip-permissions --output-format stream-json --verbose --append-system-prompt-file "$2"${mcp} < "$1"`
          : `${guard}; exec "$0" --print - --dangerously-skip-permissions --output-format stream-json --verbose${mcp} < "$1"`;
      } else {
        script = hasInstructions
          ? `${guard}; exec "$0" --print - --dangerously-skip-permissions --output-format stream-json --verbose --append-system-prompt-file "$2" < "$1"`
          : `${guard}; exec "$0" --print - --dangerously-skip-permissions --output-format stream-json --verbose < "$1"`;
      }
      break;
    case "codex_local":
      // No `--append-system-prompt-file` equivalent exists, so the bundle is concatenated
      // ahead of the prompt on stdin — what the legacy codex adapter does in process
      // (`codex-local/src/server/execute.ts:501-507`).
      //
      // ★ THE `echo` IS THE SEPARATOR, AND IT IS NOT COSMETIC. The legacy adapter joins the two
      // with a blank line; a bare `cat "$2" "$1"` gives at most the bundle's own trailing
      // newline, so the agent's standing instructions and its task run together — and if the
      // bundle has NO trailing newline (a real possibility for an operator-edited file) its last
      // line and the task's first line become one line. Inserting the blank line at the point of
      // USE rather than baking it into the staged bytes keeps the staged file byte-identical to
      // the host file, which is what lets the same object serve claude's
      // `--append-system-prompt-file`.
      //
      // A pipeline's exit status is its LAST command's, so the invocation still reports codex's
      // exit code, not `cat`'s.
      // `--skip-git-repo-check` and `--dangerously-bypass-approvals-and-sandbox` are required
      // for unattended sandbox execution (E7-F027, founder-authorized 2026-09-11): a distributed
      // run has no human to answer codex's approval prompt, and both flags are scoped to this
      // throwaway sandbox only. They are options of the `exec` subcommand, so they sit after
      // `exec --json` and before the `-` stdin positional (codex-local/src/server/execute.ts:553-566).
      script = hasInstructions
        ? `${guard}; { cat "$2"; echo; cat "$1"; } | "$0" exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -`
        : `${guard}; exec "$0" exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox - < "$1"`;
      break;
    default:
      return null;
  }

  return {
    command: SANDBOX_INVOCATION_COMMAND,
    args: ["-c", script, input.binary, ...paths],
    stagedFiles: staged,
  };
}
