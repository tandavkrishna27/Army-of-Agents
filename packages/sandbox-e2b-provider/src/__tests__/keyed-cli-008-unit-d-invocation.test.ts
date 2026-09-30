import { describe, expect, it } from "vitest";

// -----------------------------------------------------------------------------
// CLI-008 Unit D — THE KEYED LANE THAT ACTUALLY RUNS THE SHAPE.
//
// WHY THIS FILE EXISTS. Unit D (`b9ab89e36`) took the prompt out of argv: the
// workload's `command` became `sh`, its `args` became `["-c", script, binary,
// ...stagedPaths]`, and the prompt + instructions bundle began riding Unit B's
// staging channel as bytes. Its author said so plainly in the design doc: **no run
// of that shape had ever executed in a real E2B sandbox.** Three load-bearing
// claims were argued from the legacy adapters and from `real-transport.ts`, never
// observed:
//
//   1. the `shellJoin` collapse — `sandbox.commands.run()` takes ONE command
//      STRING, so the argv is quoted and re-joined. Does the assembled `sh -c`
//      script survive that round trip with its positional parameters intact?
//   2. the stdin redirect — `< "$1"` inside the script is supposed to put the
//      staged prompt on the CLI's stdin. Does it, byte for byte?
//   3. `--append-system-prompt-file "$2"` — does `$2` expand to the staged
//      instructions path as its OWN argv element, rather than being swallowed
//      into a neighbouring token by the quoting?
//
// This programme's repeated and expensive lesson is that argued-not-observed is
// exactly where the defects live. So this lane observes them, against REAL E2B.
//
// ★ THE PROBE, AND WHY IT IS NOT THE REAL CLI. The bare `base` template has no
// `claude` and no `codex` binary, and installing one would make this lane an
// agent-execution test rather than an invocation-shape test. So `$0` is a staged
// shell probe that records the argv it received and the stdin it was handed, and
// the assertions are made against those recordings. That is the right boundary:
// everything between `buildSandboxInvocation` and the binary's own `main` is under
// test here, and nothing beyond it is claimed. What the real `claude` CLI does
// with that argv and that stdin is a SEPARATE question, measured separately and
// recorded in the ticket doc — it is not inferred here.
//
// ★★ NO DUPLICATED SHAPE. The script under test is imported from the module that
// emits it in production (`task-run-sandbox-invocation.ts` — a zero-import pure
// leaf, so the cross-package test import drags in nothing). A copy of the script
// pasted into this file would be a test of the copy, which is the precise mistake
// this lane exists to stop making. The import is STATIC, so a rename or a moved
// path reds the ordinary no-key suite too, not just the keyed dispatch.
//
// ★★★ LANE. E2B / desktop. E7-F011: the networked/container lane has no
// `stage_files` route and refuses with `stage_input_failed`, so nothing here
// reaches it and nothing here claims to.
//
// Runs ONLY with `E2B_API_KEY` present (operator-supplied, via the keyed
// workflow's repo secret); otherwise SKIPS cleanly — never faked.
// -----------------------------------------------------------------------------

import {
  buildSandboxInvocation,
  STAGED_INSTRUCTIONS_PATH,
  STAGED_INPUT_MISSING_EXIT_CODE,
  STAGED_PROMPT_PATH,
} from "../../../../server/src/services/task-run-sandbox-invocation.js";
import type { E2bStagedFile, E2bTransport } from "../transport.js";

const HAS_KEY = typeof process.env.E2B_API_KEY === "string" && process.env.E2B_API_KEY.length > 0;
const describeKeyed = HAS_KEY ? describe : describe.skip;
const TEMPLATE = process.env.E2B_TEMPLATE && process.env.E2B_TEMPLATE.length > 0 ? process.env.E2B_TEMPLATE : "base";

const ENC = new TextEncoder();
const DEC = new TextDecoder();

/** Where the argv/stdin recorder lives inside the sandbox, and where it writes. */
const PROBE_PATH = "/home/user/aoa-unit-d-probe.sh";
const PROBE_ARGV_OUT = "/home/user/aoa-unit-d-argv.txt";
const PROBE_STDIN_OUT = "/home/user/aoa-unit-d-stdin.txt";

/**
 * The stand-in binary. It records ONE argv element per line and copies its stdin
 * verbatim to a file, then exits 0.
 *
 * `cat > file` (not `cat >> file`) so a re-run cannot append onto a previous run's
 * bytes and turn a delivery failure into a passing assertion.
 */
const PROBE_SCRIPT = [
  "#!/bin/sh",
  `: > ${PROBE_ARGV_OUT}`,
  `for a in "$@"; do printf '%s\\n' "$a" >> ${PROBE_ARGV_OUT}; done`,
  `cat > ${PROBE_STDIN_OUT}`,
  "exit 0",
  "",
].join("\n");

async function realTransport(): Promise<E2bTransport> {
  // Dynamic so the no-key run neither loads the `e2b` SDK nor requires a key.
  const { RealE2bTransport } = await import("../real-transport.js");
  return new RealE2bTransport({});
}

/** Create a sandbox and guarantee teardown, so a failed assertion never leaks one. */
async function withSandbox(fn: (t: E2bTransport, sandboxId: string) => Promise<void>): Promise<void> {
  const t = await realTransport();
  const { sandboxId } = await t.create({
    templateId: TEMPLATE,
    timeoutMs: 120_000,
    metadata: { aoa_lane: "cli-008-unit-d" },
    envVars: {},
  });
  try {
    await fn(t, sandboxId);
  } finally {
    await t.terminate(sandboxId).catch(() => undefined);
  }
}

function toE2bFiles(files: readonly { path: string; bytes: Uint8Array }[]): E2bStagedFile[] {
  return files.map((f) => ({ path: f.path, bytes: f.bytes }));
}

/** Stage the recorder and make it executable — `files.write` does not set the bit. */
async function installProbe(t: E2bTransport, sandboxId: string): Promise<void> {
  await t.writeFiles(sandboxId, [{ path: PROBE_PATH, bytes: ENC.encode(PROBE_SCRIPT) }]);
  const chmod = await t.runCommand({
    sandboxId,
    command: "chmod",
    args: ["+x", PROBE_PATH],
    envVars: {},
    timeoutMs: 30_000,
  });
  expect(chmod.exitCode).toBe(0);
}

async function readText(t: E2bTransport, sandboxId: string, path: string): Promise<string> {
  return DEC.decode(await t.readFile(sandboxId, path));
}

describeKeyed("CLI-008 Unit D — the invocation shape, executed in a REAL E2B sandbox", () => {
  it(
    "claude shape: the sh -c script survives shellJoin, the prompt arrives intact on stdin, and $2 is the staged bundle path",
    async () => {
      // A prompt with the things that break naive quoting: a single quote, a double
      // quote, a `$`, a backtick, a newline, and a shell metacharacter. If the
      // collapse mangles anything, this is where it shows.
      const prompt = [
        "# Task",
        "Ship it; don't `break` \"quoting\" $HOME | & > <",
        "unicode: ✓ é 日本語",
        "trailing line",
      ].join("\n");
      const instructions = "# Standing instructions\nAlways answer in one word.";

      const inv = buildSandboxInvocation({
        adapterType: "claude_local",
        binary: PROBE_PATH,
        prompt,
        instructions,
      });
      expect(inv).not.toBeNull();
      if (inv === null) return;

      await withSandbox(async (t, sandboxId) => {
        await installProbe(t, sandboxId);
        // The unit's OWN staged files, at the unit's OWN paths.
        await t.writeFiles(sandboxId, toE2bFiles(inv.stagedFiles));

        // ── THE RUN. Exactly the command + args the production builder emits. ──
        const res = await t.runCommand({
          sandboxId,
          command: inv.command,
          args: [...inv.args],
          envVars: {},
          timeoutMs: 60_000,
        });
        expect(res.exitCode).toBe(0);

        // (3) `$2` became its own argv element and points at the staged bundle.
        const argv = (await readText(t, sandboxId, PROBE_ARGV_OUT)).split("\n").filter((l) => l.length > 0);
        expect(argv).toEqual([
          "--print",
          "-",
          "--output-format",
          "stream-json",
          "--verbose",
          "--append-system-prompt-file",
          STAGED_INSTRUCTIONS_PATH,
        ]);

        // (2) The prompt arrived on stdin, byte for byte — no mangling, no
        // truncation, no shell expansion of `$HOME` or the backticks.
        const stdin = await readText(t, sandboxId, PROBE_STDIN_OUT);
        expect(stdin).toBe(prompt);

        // The staged bundle is readable at the path the flag names, with the exact
        // bytes staged — `--append-system-prompt-file` has something real to open.
        expect(await readText(t, sandboxId, STAGED_INSTRUCTIONS_PATH)).toBe(instructions);
        expect(await readText(t, sandboxId, STAGED_PROMPT_PATH)).toBe(prompt);
      });
    },
    240_000,
  );

  it(
    "codex shape: the lines never fuse — but the separator is one newline or two DEPENDING on the bundle's trailing newline (E7-F013)",
    async () => {
      // ★ THIS CASE FOUND SOMETHING. `task-run-sandbox-invocation.ts` says the
      // `echo` exists because "the legacy adapter joins the two with a blank
      // line", and inserts it "at the point of USE". MEASURED, that holds only
      // when the staged bundle ends with a newline:
      //
      //   bundle WITHOUT trailing "\n" → `cat` emits no newline, `echo` supplies
      //     the ONLY one → `bundle\nprompt`. One newline. NOT a blank line.
      //   bundle WITH trailing "\n" → `cat`'s newline + `echo`'s → `bundle\n\nprompt`.
      //     A blank line, matching legacy.
      //
      // The legacy codex adapter is unconditional: it builds
      // `${instructionsContents}\n\n…` (`codex-local/src/server/execute.ts:505`),
      // a blank line either way. So in the no-trailing-newline case — the exact
      // case the comment names as the motivating risk — the distributed path and
      // the legacy path differ by one newline. Filed as E7-F013 (LOW).
      //
      // The disaster the guard was written to prevent DOES NOT occur: the
      // bundle's last line and the prompt's first line are on separate lines in
      // both branches. Both branches are pinned below so neither can drift
      // silently, and so the finding stays measured rather than remembered.
      const prompt = "FIRST_LINE_OF_PROMPT\ndo the thing";
      const bare = "# Standing instructions\nLAST_LINE_OF_BUNDLE";

      await withSandbox(async (t, sandboxId) => {
        await installProbe(t, sandboxId);

        for (const [label, instructions, expected] of [
          ["no trailing newline", bare, `${bare}\n${prompt}`],
          ["trailing newline", `${bare}\n`, `${bare}\n\n${prompt}`],
        ] as const) {
          const inv = buildSandboxInvocation({
            adapterType: "codex_local",
            binary: PROBE_PATH,
            prompt,
            instructions,
          });
          expect(inv, label).not.toBeNull();
          if (inv === null) return;

          await t.writeFiles(sandboxId, toE2bFiles(inv.stagedFiles));
          const res = await t.runCommand({
            sandboxId,
            command: inv.command,
            args: [...inv.args],
            envVars: {},
            timeoutMs: 60_000,
          });
          expect(res.exitCode, label).toBe(0);

          const argv = (await readText(t, sandboxId, PROBE_ARGV_OUT)).split("\n").filter((l) => l.length > 0);
          expect(argv, label).toEqual(["exec", "--json", "-"]);

          const stdin = await readText(t, sandboxId, PROBE_STDIN_OUT);
          expect(stdin, label).toBe(expected);
          // The property that matters, stated separately so a future separator
          // change that still concatenates cannot pass this quietly.
          expect(stdin.split("\n"), label).toContain("LAST_LINE_OF_BUNDLE");
          expect(stdin.split("\n"), label).toContain("FIRST_LINE_OF_PROMPT");
          expect(stdin, label).not.toContain("LAST_LINE_OF_BUNDLEFIRST_LINE_OF_PROMPT");
        }
      });
    },
    300_000,
  );

  it(
    `refuses with exit ${STAGED_INPUT_MISSING_EXIT_CODE} when a worker ignored the staging pointer and wrote nothing`,
    async () => {
      // Unit B's pointer rides `extensions[]` as `critical: false`, so a worker
      // that does not understand the namespace stages NOTHING and the argv reads
      // files that are not there. The in-script guard is supposed to name that
      // cause and fail closed BEFORE the agent starts. Observed here by running
      // the real invocation with the probe installed and the unit's files
      // deliberately NOT staged.
      const inv = buildSandboxInvocation({
        adapterType: "claude_local",
        binary: PROBE_PATH,
        prompt: "unused",
        instructions: "unused",
      });
      expect(inv).not.toBeNull();
      if (inv === null) return;

      await withSandbox(async (t, sandboxId) => {
        await installProbe(t, sandboxId);
        // NOTE: inv.stagedFiles deliberately NOT written.

        let stderr = "";
        // ★ WHICH SURFACE CARRIES A NON-ZERO EXIT WAS UNOBSERVED WHEN THIS CASE WAS
        // WRITTEN, AND THE ANSWER WAS A DEFECT. The `e2b` SDK's `commands.run`
        // throws `CommandExitError` on a non-zero exit, and `runCommand` did NOT
        // catch it (it mapped only timeouts and rethrew everything else), so this
        // case measured `carrier = throw, exitCode = 78` — filed as E7-F014, because
        // the throw reached the supervisor's execute-catch and the 78 was discarded
        // into `exitCode: null`. Unit D's acceptance criterion 5 ("an ATTRIBUTABLE
        // failure … exit 78 with a named cause on stderr") was met at the script
        // level and nowhere above it.
        //
        // The carrier is now CONVERTED at the transport (`real-transport.ts`
        // narrows on `CommandExitError` and reads the status off it), so the shape
        // below is retained — it still accepts either surface and still asserts the
        // SUBSTANCE from whichever one carried it — but the carrier itself is now
        // PINNED to "result" at the end of the case. Keeping the tolerant read means
        // a regression reports the substance it recovered instead of dying on an
        // unhandled rejection, and the pin is what makes it fail.
        let exitCode: number | null = null;
        let carrier: "result" | "throw" = "result";
        try {
          const res = await t.runCommand(
            {
              sandboxId,
              command: inv.command,
              args: [...inv.args],
              envVars: {},
              timeoutMs: 60_000,
            },
            { onStderr: (chunk) => { stderr += chunk; } },
          );
          exitCode = res.exitCode;
        } catch (err) {
          carrier = "throw";
          const e = err as { message?: unknown; exitCode?: unknown; stderr?: unknown };
          stderr += typeof e.stderr === "string" ? e.stderr : "";
          if (typeof e.exitCode === "number") exitCode = e.exitCode;
          const text = typeof e.message === "string" ? e.message : String(err);
          if (exitCode === null) {
            const m = /exit (?:status|code)\s*:?\s*(\d+)/i.exec(text);
            if (m) exitCode = Number(m[1]);
          }
        }
        // eslint-disable-next-line no-console
        console.log(`[cli-008 unit-d] non-zero exit carrier = ${carrier}, exitCode = ${String(exitCode)}`);

        expect(exitCode).toBe(STAGED_INPUT_MISSING_EXIT_CODE);
        expect(stderr).toContain("[cli-008] staged input missing");
        expect(stderr).toContain(STAGED_PROMPT_PATH);

        // ★★ THE E7-F014 PIN, AND THE POINT OF UNIT D's CRITERION 5. The refusal must
        // arrive as a RESULT, because only a result carries the code past
        // `E2bSandboxProvider.execute` into the supervisor's ordinary terminal. A
        // throw here is exactly the defect: it lands in the supervisor's execute-catch
        // and the 78 becomes `exitCode: null`. This is the assertion that reds if the
        // conversion is reverted.
        expect(carrier).toBe("result");
      });
    },
    240_000,
  );

  it(
    "E7-F014 — a command that RUNS and exits non-zero comes back as a RESULT carrying the real exit code",
    async () => {
      // The narrowest statement of the fix, independent of Unit D's script: an
      // ordinary command that exits non-zero is a NORMAL outcome and must be
      // returned, not thrown. Before the fix this case throws `CommandExitError`
      // out of `runCommand` and never reaches an assertion.
      //
      // 42 is arbitrary and distinctive — a fabricated code (the SDK's own `1`, or
      // the seam's `null`) cannot pass, so the case proves the status was READ off
      // the error rather than defaulted.
      await withSandbox(async (t, sandboxId) => {
        let stderr = "";
        let stdout = "";
        const res = await t.runCommand(
          {
            sandboxId,
            command: "sh",
            args: ["-c", 'printf "out\n"; printf "boom\n" >&2; exit 42'],
            envVars: {},
            timeoutMs: 60_000,
          },
          {
            onStdout: (chunk) => { stdout += chunk; },
            onStderr: (chunk) => { stderr += chunk; },
          },
        );

        expect(res.exitCode).toBe(42);
        // `crashed: exitCode !== 0` was DEAD CODE against real E2B (the branch could
        // not be reached, because a non-zero exit never returned). It is alive now.
        expect(res.crashed).toBe(true);
        // A non-zero exit is NOT a timeout and NOT a signal — the fault mappings must
        // not have been borrowed to carry it.
        expect(res.timedOut).toBe(false);
        expect(res.signal).toBeNull();
        // Streaming still binds on the converted path (the chunks are delivered
        // before `wait()` throws, and the conversion must not drop them).
        expect(stdout).toContain("out");
        expect(stderr).toContain("boom");
      });
    },
    240_000,
  );

  it(
    "E7-F014 — a zero exit is untouched, and a genuine sandbox FAULT still THROWS rather than being reported as an exit code",
    async () => {
      // ★★★ THE OTHER HALF OF THE FIX, AND THE ONE THAT MATTERS MORE. Collapsing a
      // fault into "exited N" would be strictly worse than losing an exit code: it
      // manufactures a plausible result for an infrastructure failure. The
      // conversion is narrowed to `CommandExitError` — the SDK class that carries a
      // completed `CommandResult` — and the SDK draws the same line itself inside
      // `CommandHandle.wait()`: a command that produced no exit status throws
      // `iterationError` or a bare `SandboxError("Process exited without a result")`,
      // neither of which is a `CommandExitError`.
      //
      // Observed here by running against a sandbox that has been TERMINATED. There is
      // no exit status anywhere in that story, so the ONLY correct behaviours are to
      // throw, or to report the uniform not-found signal. What must NEVER happen is a
      // resolved result carrying a number.
      const t = await realTransport();
      const { sandboxId } = await t.create({
        templateId: TEMPLATE,
        timeoutMs: 120_000,
        metadata: { aoa_lane: "cli-008-unit-d" },
        envVars: {},
      });
      try {
        // Control: the happy path is unchanged by the conversion.
        const ok = await t.runCommand({
          sandboxId,
          command: "sh",
          args: ["-c", "exit 0"],
          envVars: {},
          timeoutMs: 60_000,
        });
        expect(ok.exitCode).toBe(0);
        expect(ok.crashed).toBe(false);

        await t.terminate(sandboxId);

        let threw = false;
        let fabricated: unknown = "NOTHING_RETURNED";
        try {
          const res = await t.runCommand({
            sandboxId,
            command: "sh",
            args: ["-c", "exit 0"],
            envVars: {},
            timeoutMs: 30_000,
          });
          fabricated = res;
        } catch {
          threw = true;
        }
        // eslint-disable-next-line no-console
        console.log(`[e7-f014] fault carrier threw = ${String(threw)}, returned = ${JSON.stringify(fabricated)}`);
        expect(threw, "a fault against a terminated sandbox must not resolve to a result").toBe(true);
        expect(fabricated).toBe("NOTHING_RETURNED");
      } finally {
        await t.terminate(sandboxId).catch(() => undefined);
      }
    },
    240_000,
  );
});
