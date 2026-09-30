#!/usr/bin/env tsx
// server/src/cli/verify-e7-1-distributed-run.ts
//
// evidence-verifier A — the operator entrypoint.
//
//   DATABASE_URL=... tsx server/src/cli/verify-e7-1-distributed-run.ts <runId> \
//       [--org <organizationId>] [--company <companyId>] [--require-capability]
//
// Reads a dispatched heartbeat run + its distributed-kernel evidence and prints the
// per-clause verdict. Exit 0 iff the run PROVABLY completed the distributed journey
// (a worker leased it, ran it, and its terminal was projected — with no leaked
// secret); exit 1 otherwise, naming the failing clause(s).
//
// ★ TWO DIMENSIONS, TWO EXIT CODES.
//
// `ok` (exit 0/1) answers "was the distributed journey corroborated" — the MECHANISM.
// It reads NOTHING about the workload, the argv, the exit code, stdout, or anything the
// agent produced, so a `claude` that exits 127 with no tools and a context-free prompt
// passes it (E7-F003). That is not a bug in `ok`; `ok` answers a different question.
//
// `capabilityProven` answers "did anything the agent produced reach AoA" — the
// CAPABILITY. It is ALWAYS printed and ALWAYS in `verdict-json`. `--require-capability`
// makes an unproven capability exit 3.
//
// ★ AND IT ANSWERS THAT QUESTION IMPERFECTLY, IN A MEASURED WAY (W7U2, RESTATED W21B).
//
// ★★ WHAT THIS PARAGRAPH USED TO SAY, AND WHY IT IS WRONG NOW. Until W21 it read: "arm 2
// counts `task_outputs` rows by `created_by_run_id` with no provenance filter, and an
// ordinary heartbeat path writes such a row for any run that freshly starts a declared dev
// server — so `capability: PROVEN` can be reached with zero agent output". W21 changed the
// predicate and did not change this header, so the CLI's own doc asserted a defect the code
// no longer had. Corrected rather than deleted, because a stale doc beside a changed
// predicate is how the next reader mis-sizes the gate.
//
// ARM 2 NOW counts a `task_outputs` row only when an APPLIED `output_projection` receipt on
// this run's `distributed_job_id` AND `distributed_attempt_id` names it — the receipt only
// `jobOutputBridge` `projectAcceptedOutput` writes, behind a live lease fence — so the E7-F020
// platform-write path is excluded structurally. E7-F020 stays OPEN on a stated residual (an
// UPSERT collision on a platform `external_id`), and the limit is PRINTED with every verdict
// and carried in `verdict-json` (`capabilityLimitations`), so it survives being quoted from
// either.
//
// ★★ AND THE PARAGRAPH ABOVE WENT STALE A SECOND TIME, WHICH IS THE POINT OF SAYING SO HERE.
// W21C bound BOTH arms to the run's ATTEMPT rather than its job (E7-F031): a job carries
// `max_attempts` (default 3) and every attempt shares the job id, so a RETRY attempt's output —
// or its committed `workspace_patch` — used to print `capability: PROVEN` for a run that
// produced nothing. This header said `distributed_job_id` alone and would have asserted the
// old, wider predicate. Same failure the block above records for W21, one commit later: a doc
// that narrates a predicate is a claim about the predicate, and it does not move on its own.
// The SECRET SCANNER's `task_outputs` and `job_artifacts` surfaces are deliberately NOT
// attempt-bound — they want recall, so a sibling attempt's output is still scanned. Do not
// "make them consistent".
//
// ★ CORRECTED W21D. This line used to say flatly that the scanner is not attempt-bound. That
// is false of ONE of clause 4's four surfaces: `listJobEvents` is keyed on `attempt_id`, so a
// sibling attempt's event payloads are NEVER scanned. The commit that wrote this reassurance
// is the same commit that FILED that gap as E7-F032 (open, not fixed) — the disclosure and
// the reassurance shipped together and contradicted each other.
//
// ★★★ AND A GREEN IS STILL NOT EVIDENCE OF A WORKING GATE, for a reason that is not the
// predicate: E7-F018 measured that `projectAcceptedOutput` has ZERO production callers and
// that nothing checked in makes any run a distributed run, so arm 2 reads 0 on every real
// run. The bar is CLOSED where it was falsely open. That is not the same as working.
//
// --require-capability is OFF BY DEFAULT, deliberately. Output capture is unbuilt
// (CLI-008 Unit F: the E2B driver passes no stream handlers, stdoutRef/stderrRef are
// fabricated literals, observeRun is uncomposed, buildWorkspacePatch and
// createResultCommitter have zero production callers), so the counts are STRUCTURALLY
// zero and the flag on-by-default would be a gate nobody can pass — which in this
// repository is how a guard gets bypassed, argued around, and then deleted. This is the
// flag the campaign flips once Unit F lands; until then it is an operator opt-in, and
// the always-printed CAPABILITY line — with the E7-F020 limit under it — is what stops a
// green run being read as capability, and a green CAPABILITY being read as agent output.
//
// ★★★ THIS IS NOW A RULING, NOT AN OMISSION — DECISION E7-D-CAPABILITY-DISCLOSURE
// (founder, 2026-09-09). `capabilityProven` STAYS UNWIRED AS A PRINTED DISCLOSURE. It is
// computed on every run, printed on every verdict and carried in `verdict-json`, and it
// GATES NOTHING: `--require-capability` remains an operator opt-in and no workflow, script
// or gate clause passes it.
//
// The reason is this repository's own precedent, not an estimate of the work. A gate nobody
// can pass gets deleted, argued around, and then bypassed — and E7-F018 measured that NO
// CHECKED-IN CONFIGURATION MAKES ANY RUN DISTRIBUTED, so both arms read 0 structurally.
// Arming the flag today would therefore mint exactly that gate: always-red, for a reason
// having nothing to do with the agent under test, on the first campaign that needs it green.
// A disclosure that is always printed and never lies is worth more here than a gate that is
// always red and will be relaxed.
//
// ★ THE CONDITION FOR REVISITING IS NAMED, so this does not become permanent by default:
// flip `--require-capability` on by default (and wire it into a gate clause) when BOTH
//   (a) E7-F018 is CLOSED — some checked-in configuration actually makes a run distributed
//       and a producer exists for at least one arm; AND
//   (b) the rollout dial is ARMED in a real deployment, not merely armable.
// Until both hold, do not read the absence of a gate here as an oversight, and do not
// "fix" it by turning the flag on. Nothing about the computation, the arms or the
// separation of `capabilityProven` from `ok` is changed by this ruling.
//
// Exit codes: 0 = verdict clean · 1 = mechanism FAIL (or an unreadable verifier)
//             2 = usage · 3 = mechanism PASS but capability unproven, with
//                            --require-capability set.
//
// This FLIPS NO GATE. It produces the machine-checkable verdict a human cites when
// deciding to flip `E7-1-coding-journey` in `scripts/gate-clause-wiring.json`. The
// full journey observation + non-canary isolation remain the operator's (design §5).
//
// RLS: the distributed kernel tables carry FORCE RLS. Run with a DATABASE_URL whose
// role can read the run's tenant rows; otherwise clause 5 fails SAFE-CLOSED (missing
// corroboration → refuse to bless), never a false PASS. It performs only SELECTs.
//
// SECURITY (Decision #104): A never receives or logs the E2B key / redeemed value.
// Clause 4 uses leak-CLASS matchers and prints match-class + field id + count only —
// never a raw matched substring.

import { createDb } from "@armyofagents/db";
import {
  createE7DistributedRunVerifier,
  e7VerifyExitCode,
  formatVerifyResult,
} from "../services/e7-distributed-run-verifier.js";
import { createDrizzleE7RunVerifierStore } from "../services/e7-distributed-run-verifier-store.js";

function parseArgs(argv: readonly string[]): {
  runId?: string;
  organizationId?: string;
  companyId?: string;
  requireCapability: boolean;
} {
  const out: { runId?: string; organizationId?: string; companyId?: string; requireCapability: boolean } = {
    requireCapability: false,
  };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--org" || arg === "--organization") {
      out.organizationId = rest[++i];
    } else if (arg === "--company") {
      out.companyId = rest[++i];
    } else if (arg === "--require-capability") {
      out.requireCapability = true;
    } else if (!arg.startsWith("--") && out.runId === undefined) {
      out.runId = arg;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const { runId, organizationId, companyId, requireCapability } = parseArgs(process.argv);

  if (!runId) {
    console.error(
      "usage: verify-e7-1-distributed-run <runId> [--org <organizationId>] [--company <companyId>] [--require-capability]",
    );
    process.exit(2);
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL is required");
    process.exit(2);
  }

  const db = createDb(dbUrl);
  const verifier = createE7DistributedRunVerifier({ store: createDrizzleE7RunVerifierStore(db) });

  const expected =
    organizationId || companyId ? { organizationId, companyId } : undefined;
  const result = await verifier.verify({ runId, expected });

  // Print the human-readable verdict + a machine-parseable JSON line (SHAPE only;
  // no raw secret can appear in either — see clause 4 / formatVerifyResult).
  console.log(formatVerifyResult(result));
  console.log(`\nverdict-json: ${JSON.stringify(result)}`);

  // The decision is a PURE function (`e7VerifyExitCode`) so every branch is reachable in a
  // test; reaching them here would need a live DATABASE_URL. This block only reports.
  const code = e7VerifyExitCode(result, requireCapability);
  if (code === 3) {
    console.error(
      "--require-capability: this run does NOT prove the agent could work (see the capability clause above)",
    );
  }
  process.exit(code);
}

void main().catch((error) => {
  // An unreadable verifier is NOT a bless. Fail closed with a non-promotion exit.
  console.error(`verify-e7-1-distributed-run failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
