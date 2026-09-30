#!/usr/bin/env node
// BRW-004 slice (a) — CAN THE SANDBOX PROVIDER CONSTRAIN OUTBOUND EGRESS AT ALL?
//
// WHY THIS EXISTS. BRW-004's acceptance says "allowed domains ... are enforced". The design's
// §D3 costs three substrates for that enforcement and picks (c) — an in-sandbox enforcement
// point — but option (b) was "have the provider constrain outbound traffic at acquire time",
// and BRW-004-terrain §12 records it as UNPROVEN: nothing in the repository measures whether
// E2B can restrict a sandbox's outbound egress.
//
// The answer is not cosmetic. It decides the THREAT STATEMENT:
//
//   * If the provider CAN constrain egress, D3(c) is defence in depth and a browser that
//     reconfigures its own proxy is still contained by the boundary.
//   * If it CANNOT, D3(c) is the ONLY layer, and BRW-004's result doc must say so plainly
//     rather than implying a boundary that does not exist.
//
// WHAT PRODUCTION ACTUALLY DOES, and what this probe therefore replicates. AoA's only
// egress-shaped input to the provider is `SandboxProviderAcquireInput.egressAllowlist`
// (server/src/services/sandbox-provider-runtime.ts:24), and the E2B arm writes it into
// `Sandbox.create`'s `metadata` as a COMMA-JOINED STRING (:785-789). Its own producer's
// comments call it "NOT a security boundary" (mcp-connectors-env.ts:61-64). This probe
// replicates that exact spelling and MEASURES whether the claim in those comments is true,
// instead of quoting them.
//
// THE EXPERIMENT is differential, because a single sandbox cannot distinguish "the allowlist
// blocked this host" from "this host is unreachable from E2B for an unrelated reason":
//
//   sandbox A — created WITH metadata.egressAllowlist = "<allowed host>"
//   sandbox B — created WITHOUT any egressAllowlist metadata  (the CONTROL)
//
// Both run the identical target set from INSIDE the guest. The allowlist has an effect only
// if the NOT-allowlisted target behaves DIFFERENTLY in A than in B.
//
// ★ POSITIVE CONTROL (mandatory, per the programme's standing rule and design §4's last row):
// the ALLOWLISTED host must SUCCEED in sandbox A. A probe in which everything fails proves
// nothing about an allowlist — it proves the sandbox has no egress, or that curl is missing.
//
// ★ NEGATIVE CONTROL on the apparatus itself: a deliberately unresolvable host must FAIL. If
// it "succeeds", the measurement is reading something other than the network and NO verdict
// may be taken from the run.
//
// SAFETY: creates exactly two short-TTL sandboxes, always tears both down in `finally`, and
// never prints the API key. Skips cleanly (exit 0, SKIPPED) when E2B_API_KEY is absent —
// never fakes a result.
import { Sandbox } from "e2b";

const KEY = process.env.E2B_API_KEY;
const TEMPLATE = process.env.E2B_TEMPLATE || "base";
const TTL_MS = 180_000;

// The host declared on sandbox A's allowlist. Deliberately a stable, boring, HTTPS host: the
// question is about the boundary, not about the destination.
const ALLOWED_HOST = "example.com";

/**
 * The target set, run identically in BOTH sandboxes.
 *
 * `role` is what makes each row readable as evidence rather than as a number:
 *   positive_control  — must SUCCEED in A, or the run is INCONCLUSIVE
 *   question          — the measurement: does the allowlist change its outcome?
 *   apparatus_control — must FAIL, or the apparatus is broken and no verdict may be read
 *   observation       — reported, never load-bearing for the verdict
 */
const TARGETS = [
  {
    id: "allowlisted",
    role: "positive_control",
    url: `https://${ALLOWED_HOST}/`,
    why: "ON sandbox A's declared allowlist. Must succeed in A or the run proves nothing.",
  },
  {
    id: "not_allowlisted",
    role: "question",
    url: "https://api.github.com/",
    why: "NOT on the allowlist. A vs B difference here is the entire measurement.",
  },
  {
    id: "link_local_metadata",
    role: "observation",
    // The cloud instance-metadata address. NETWORK_DENIAL_CLASSES names `metadata` as its
    // highest-precedence deny class, so whether a guest can reach it at all is directly
    // relevant to how much work the in-sandbox enforcement point has to do.
    url: "http://169.254.169.254/latest/meta-data/",
    why: "The `metadata` denial class's canonical target. Reachability is an observation, not a control.",
  },
  {
    id: "unresolvable",
    role: "apparatus_control",
    // `.invalid` is reserved by RFC 2606 and can never resolve.
    url: "https://aoa-brw004-probe-must-not-resolve.invalid/",
    why: "Must FAIL. If it succeeds, the probe is not measuring the network and no verdict may be read.",
  },
];

if (!KEY) {
  console.log("SKIPPED — E2B_API_KEY is not set. No result claimed.");
  process.exit(0);
}

/**
 * Build the in-guest command for ONE target.
 *
 * ★★ ONE COMMAND PER TARGET, not one script for all four. Probe run #1 (33855470353) chained
 * all four into a single `sh -c` and the FOURTH target — the apparatus control — produced no
 * output line at all, in BOTH arms. The three earlier targets returned normally, so a
 * single-script probe silently loses whichever target sits behind whatever swallowed it, and
 * an evidence channel that can drop its own control row is not an evidence channel. Isolating
 * each target means one target's failure cannot erase another's result.
 *
 * ★★ AND IT MUST BE WRAPPED IN try/catch AT THE CALL SITE, because of E7-F014: against real
 * E2B a non-zero exit is THROWN as a `CommandExitError`, not returned. A failing curl is the
 * EXPECTED outcome for the apparatus control, so "the command threw" is data here, not an
 * error — and treating it as an error is how run #1 lost the row.
 *
 * `--max-time` bounds a hang so a silently-dropped SYN (the shape a network policy usually
 * has) is recorded as a timeout rather than stalling the run to the workflow limit.
 * `%{exitcode}` is NOT used — it needs a newer curl than the base template guarantees.
 */
function buildTargetCommand(target) {
  // `-o /dev/null` because no body is needed: the question is reachability, not content.
  // The final `exit 0` is deliberate: it keeps a FAILING curl from throwing at the SDK layer
  // so the diagnostic text still comes back, and the real curl status rides `$code` instead.
  //
  // ★★★ THE DIAGNOSTIC TEXT IS FLATTENED TO ONE LINE, and this is the defect that cost three
  // probe runs. `curl -sS -o /dev/null -w "%{http_code}"` writes the `-w` output to STDOUT and
  // the error to STDERR, and `2>&1` interleaves them. On the Linux guest the failing case came
  // back as TWO lines — `curl: (6) Could not resolve host: ...` then `000` — so a one-line
  // record could never be assembled and the row vanished. On Windows the same command emits
  // `000curl: (6) ...` on ONE line, which is why the local dry-run passed and the real sandbox
  // did not. A dry-run on a different platform is not a control for the real one; the apparatus
  // control in the real run is, and it is the only reason this was caught rather than shipped.
  //
  // `$?` is read from the ASSIGNMENT, not through a pipe: `err=$(curl ... | tr ...)` would make
  // `$?` the exit status of `tr` and every target would report success.
  const body = [
    `err=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 12 "${target.url}" 2>&1)`,
    `code=$?`,
    `msg=$(printf "%s" "$err" | tr "\\n\\t" "  ")`,
    `printf "PROBE %s %s %s END\\n" "${target.id}" "$code" "$msg"`,
    `exit 0`,
  ].join("; ");
  // Fail loudly here rather than shipping a mangled command to a real sandbox: the whole body
  // rides `sh -c '...'`, and one single quote would terminate the wrapper and turn this into
  // something that still exits 0.
  if (body.includes("'")) throw new Error("probe command contains a single quote; it would break the sh -c wrapper");
  return `sh -c '${body}'`;
}

/**
 * Parse one target's output line.
 *
 * Whitespace-separated with a leading `PROBE` marker and a trailing `END` sentinel, so a line
 * that arrives truncated is REJECTED rather than half-read. Returns null when no complete line
 * is present — which the caller records as a missing result, never as a success.
 */
function parseTargetLine(stdout, targetId) {
  // Matched over the WHOLE stdout with `[\s\S]` rather than line by line. The shell already
  // flattens the diagnostic text, so this is the second, independent defence against the same
  // defect: if anything ever reintroduces an embedded newline between the PROBE marker and the
  // END sentinel, the record is still assembled instead of silently disappearing. One fix in
  // the producer and one in the consumer, because this failure mode has already survived a
  // local dry-run once.
  const re = new RegExp(`PROBE\\s+${targetId}\\s+(\\d+)\\s+([\\s\\S]*?)\\s*END`);
  const m = re.exec(String(stdout ?? ""));
  if (!m) return null;
  const curlExit = Number.parseInt(m[1], 10);
  if (!Number.isFinite(curlExit)) return null;
  return {
    id: targetId,
    curlExit,
    // curl exit 0 means the transfer completed; `detail` then holds the HTTP status.
    reached: curlExit === 0,
    detail: m[2].replace(/\s+/g, " ").trim().slice(0, 200),
  };
}

/**
 * Create one sandbox, run the target set inside it, tear it down.
 *
 * `withAllowlist` selects the ONLY difference between the two arms.
 */
async function runArm(label, withAllowlist) {
  let sandbox = null;
  try {
    const metadata = {
      aoaProvider: "e2b",
      // Replicates production's exact spelling: a comma-joined string in metadata
      // (sandbox-provider-runtime.ts:785-789), omitted entirely when the list is empty.
      ...(withAllowlist ? { egressAllowlist: ALLOWED_HOST } : {}),
    };
    console.log(`[${label}] creating sandbox (metadata.egressAllowlist=${withAllowlist ? JSON.stringify(ALLOWED_HOST) : "OMITTED"})...`);
    sandbox = await Sandbox.create(TEMPLATE, { apiKey: KEY, timeoutMs: TTL_MS, metadata });
    console.log(`[${label}] sandboxId = ${String(sandbox.sandboxId)}`);

    // Confirm curl exists before believing any failure. Without this, a template without curl
    // reports every target as failed and would read exactly like a total egress block.
    const which = await sandbox.commands.run(`sh -c 'command -v curl || echo NO_CURL'`, {
      timeoutMs: 20_000,
    });
    const curlPath = String(which?.stdout ?? "").trim();
    if (curlPath === "" || curlPath.includes("NO_CURL")) {
      return { label, withAllowlist, apparatusOk: false, apparatusDetail: "curl is not installed in the template", results: new Map() };
    }

    const results = new Map();
    for (const target of TARGETS) {
      // ★★ EVERY TARGET'S RAW CHANNEL IS PRINTED, parsed or not. Probe runs #1 and #2 both
      // reported the apparatus control as "NO RESULT" and there was nothing in the log to say
      // why — the row was simply absent. A measurement whose failures are invisible cannot be
      // debugged, only guessed at, and guessing is what the apparatus control exists to stop.
      let stdout = "";
      let stderr = "";
      let channel = "returned";
      let note = "";
      try {
        const out = await sandbox.commands.run(buildTargetCommand(target), { timeoutMs: 60_000 });
        stdout = String(out?.stdout ?? "");
        stderr = String(out?.stderr ?? "");
        note = `exitCode=${String(out?.exitCode)}`;
      } catch (err) {
        // E7-F014: real E2B THROWS on a non-zero exit. A CommandExitError still carries the
        // command's stdout on most shapes, so read the line out of it rather than losing the row.
        channel = "threw";
        const anyErr = /** @type {Record<string, any>} */ (err ?? {});
        stdout = String(anyErr.stdout ?? anyErr.result?.stdout ?? "");
        stderr = String(anyErr.stderr ?? anyErr.result?.stderr ?? "");
        note = `${anyErr.name ?? "Error"}: ${String(anyErr.message ?? err)}`;
      }
      const parsed = parseTargetLine(stdout, target.id);
      console.log(
        `[${label}] RAW ${target.id}: channel=${channel} parsed=${parsed ? "yes" : "NO"} ${note}` +
          ` stdout=${JSON.stringify(stdout.slice(0, 400))} stderr=${JSON.stringify(stderr.slice(0, 400))}`,
      );
      if (parsed) results.set(target.id, parsed);
    }
    const missing = TARGETS.filter((t) => !results.has(t.id)).map((t) => t.id);
    return {
      label,
      withAllowlist,
      apparatusOk: missing.length === 0,
      apparatusDetail: missing.length === 0 ? "" : `no result line for: ${missing.join(", ")}`,
      results,
    };
  } finally {
    if (sandbox) {
      try {
        await Sandbox.kill(String(sandbox.sandboxId), { apiKey: KEY });
        console.log(`[${label}] sandbox torn down.`);
      } catch (err) {
        console.error(
          `[${label}] WARNING: teardown failed; the sandbox TTL will reap it.`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }
}

function describe(rec) {
  if (!rec) return "NO RESULT";
  return rec.reached
    ? `REACHED (http ${rec.detail})`
    : `FAILED (curl exit ${rec.curlExit}: ${rec.detail})`;
}

try {
  const armA = await runArm("A/allowlist", true);
  const armB = await runArm("B/control", false);

  console.log("\n================ RESULT ================");
  for (const target of TARGETS) {
    console.log(`\n${target.id}  [${target.role}]  ${target.url}`);
    console.log(`  why: ${target.why}`);
    console.log(`  A (allowlist declared): ${describe(armA.results.get(target.id))}`);
    console.log(`  B (no allowlist)      : ${describe(armB.results.get(target.id))}`);
  }

  console.log("\n---------------- VERDICT ----------------");

  // 1. The apparatus must be sound before any verdict is taken.
  const apparatusProblems = [armA, armB]
    .filter((a) => !a.apparatusOk)
    .map((a) => `${a.label}: ${a.apparatusDetail}`);
  const unresolvableA = armA.results.get("unresolvable");
  const unresolvableB = armB.results.get("unresolvable");
  if (unresolvableA?.reached || unresolvableB?.reached) {
    apparatusProblems.push("the RFC-2606 .invalid host was REACHED — the probe is not measuring the network");
  }
  if (apparatusProblems.length > 0) {
    console.log("  INCONCLUSIVE — the apparatus control failed. No claim about the boundary.");
    for (const p of apparatusProblems) console.log(`    * ${p}`);
    console.log("========================================\n");
    process.exitCode = 1;
  } else {
    // 2. The positive control must hold, or a total-failure run would read as "enforced".
    const allowedA = armA.results.get("allowlisted");
    if (!allowedA?.reached) {
      console.log(
        "  INCONCLUSIVE — the POSITIVE CONTROL failed: the ALLOWLISTED host did not succeed in\n" +
          "  sandbox A. A run where everything fails cannot distinguish an enforced allowlist from\n" +
          "  a sandbox with no egress at all. Re-run before reading anything into the other rows.",
      );
      process.exitCode = 1;
    } else {
      // 3. The measurement.
      const qA = armA.results.get("not_allowlisted");
      const qB = armB.results.get("not_allowlisted");
      if (qA?.reached && qB?.reached) {
        console.log(
          "  METADATA ALLOWLIST IS INERT — a host that is NOT on the declared allowlist was reached\n" +
            "  from inside sandbox A exactly as it was from the control sandbox B. The provider does\n" +
            "  NOT constrain outbound egress through this seam.\n" +
            "  CONSEQUENCE for BRW-004 §D3: option (b) is unavailable, so the in-sandbox enforcement\n" +
            "  point (c) is the ONLY layer, not defence in depth. The result doc must say so.\n" +
            "  SCOPE: this measures the `metadata.egressAllowlist` seam that AoA production actually\n" +
            "  uses. It says NOTHING about an E2B feature AoA does not call.",
        );
      } else if (!qA?.reached && qB?.reached) {
        console.log(
          "  ALLOWLIST IS ENFORCED — the not-allowlisted host FAILED in sandbox A and SUCCEEDED in the\n" +
            "  control sandbox B. The provider constrains outbound egress at the boundary.\n" +
            "  CONSEQUENCE for BRW-004 §D3: option (b) is available and (c) is defence in depth.\n" +
            `  A detail: ${describe(qA)}`,
        );
      } else if (!qA?.reached && !qB?.reached) {
        console.log(
          "  NOT A BOUNDARY MEASUREMENT — the not-allowlisted host failed in BOTH arms, including the\n" +
            "  control that declared no allowlist. Whatever blocked it is not the allowlist. Choose a\n" +
            "  different not-allowlisted target and re-run; do not read this as enforcement.",
        );
        process.exitCode = 1;
      } else {
        console.log(
          "  INVERTED AND UNEXPLAINED — the not-allowlisted host succeeded in A and failed in the\n" +
            "  control B. That is not a boundary; it is noise or an outage. Re-run.",
        );
        process.exitCode = 1;
      }
      const meta = armA.results.get("link_local_metadata");
      console.log(`\n  OBSERVATION — link-local metadata (169.254.169.254) from inside A: ${describe(meta)}`);
    }
    console.log("========================================\n");
  }
} catch (err) {
  console.error("PROBE ERROR:", err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  process.exitCode = 1;
}
