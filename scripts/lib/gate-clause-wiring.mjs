// An epic gate clause may not claim a capability whose production path has no caller.
//
// ★ WHY THIS EXISTS. The 2026-08-25 exit-gate audit verdicted ~70 gate clauses across
// E0..E11 and found **17 UNPROVABLE** — the clause names a capability, a ticket delivered
// the mechanism, and no boot root reaches it. Not "untested": unreachable. Examples that
// were all reported inside `complete` epics:
//   createPollLoop, createSupervisor, createStartupReconciler, openEventOutboxStore,
//   createEventOutboxDrain, createResultCommitter, createPatchApplyService,
//   createFenceAwareEgressProxy, jobApprovalBridge, jobBudgetCostBridge, jobAuditBridge,
//   jobOutputBridge, createExecutionTargetRevocationFanout, createDistributedExecutionDrain
//
// The pattern the audit named: **every ticket doc was honest; the aggregation was not.**
// `bin/worker-daemon.ts` says "INERT" four times. CLI-006's result says its volume clauses
// "are NOT claimed here". SVC-001 says "storage half only". Nobody over-claimed at the
// ticket level. What over-claimed was "epic complete", counted by TICKETS SHIPPED rather
// than by whether the capability runs.
//
// ★ WHY DECLARATION-BASED. The tempting version parses the gate prose and infers which
// symbol each clause names. That inference was tried in this repo for a neighbouring guard
// and was WRONG FIVE TIMES IN BOTH DIRECTIONS. So a human states the mapping, and the
// machine verifies only the cheap, mechanical half: does that symbol have a caller that is
// not a test and not a comment.
//
// ★ WHY `unwired` IS ALLOWED. A guard that forbids honest debt gets deleted. `unwired` is
// permitted and REPORTED ON A GREEN RUN, so a dormant capability stays visible instead of
// silently passing as complete. What is forbidden is claiming `wired` when nothing calls it.
//
// Pure. The caller supplies the manifest and a callerCount lookup.

/**
 * wired   — a production caller exists. The guard verifies it and FAILS if the count is 0.
 * unwired — deliberately dormant. `reason` must say what would have to change. Reported.
 */
export const GATE_CLAUSE_STATUSES = Object.freeze(["wired", "unwired"]);

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasReason(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * @param {{
 *   declared?: Record<string, {status: string, symbol?: string, epic?: string, reason?: string}>,
 *   callerCounts?: Record<string, number>,   // symbol -> production caller count
 * }} input
 * @returns {{ok: boolean, problems: Array<{kind: string, clause: string|null, detail?: string}>,
 *            wiredCount: number, unwired: string[]}}
 */
export function evaluateGateClauseWiring(input) {
  const problems = [];
  if (!isPlainObject(input)) {
    return { ok: false, problems: [{ kind: "malformed_input", clause: null }], wiredCount: 0, unwired: [] };
  }
  const { declared, callerCounts } = input;
  if (!isPlainObject(declared) || !isPlainObject(callerCounts)) {
    return { ok: false, problems: [{ kind: "malformed_input", clause: null }], wiredCount: 0, unwired: [] };
  }

  const unwired = [];
  let wiredCount = 0;

  for (const clause of Object.keys(declared).sort()) {
    const entry = declared[clause];
    if (!isPlainObject(entry) || !GATE_CLAUSE_STATUSES.includes(entry.status)) {
      problems.push({ kind: "malformed_declaration", clause, detail: String(entry && entry.status) });
      continue;
    }
    if (typeof entry.symbol !== "string" || entry.symbol.length === 0) {
      problems.push({ kind: "malformed_declaration", clause, detail: "symbol missing" });
      continue;
    }
    const count = callerCounts[entry.symbol];
    if (typeof count !== "number") {
      // A symbol nobody measured is not evidence of anything. Fail rather than assume.
      problems.push({ kind: "symbol_not_measured", clause, detail: entry.symbol });
      continue;
    }
    if (entry.status === "wired") {
      // THE CHECK THIS GUARD EXISTS FOR.
      if (count === 0) {
        problems.push({ kind: "claimed_wired_but_no_caller", clause, detail: `${entry.symbol} has 0 production callers` });
        continue;
      }
      wiredCount += 1;
      continue;
    }
    // unwired
    if (!hasReason(entry.reason)) {
      problems.push({ kind: "malformed_declaration", clause, detail: "unwired needs a reason" });
      continue;
    }
    // ★ An `unwired` entry that has SINCE acquired a caller is good news the manifest is
    // hiding. Surface it so the clause gets promoted rather than staying pessimistic - a
    // register nobody updates in either direction stops being believed.
    //
    // `expectedReferences` exists because a non-zero count does not always mean reachable.
    // `runBrowserSession` is referenced once, by `runner.ts`, which nothing invokes because
    // no package depends on `browser-runtime` at all. Acknowledging a KNOWN count keeps the
    // promote-check sharp — it still fires the moment a NEW reference appears — without
    // forcing a false `wired`. The number must be typed out, so nobody can wave away an
    // arbitrary quantity of references by accident.
    const expected = typeof entry.expectedReferences === "number" ? entry.expectedReferences : 0;
    if (count > expected) {
      problems.push({
        kind: "unwired_but_now_has_caller",
        clause,
        detail: `${entry.symbol} has ${count} reference(s), expected ${expected} - promote to wired, or raise expectedReferences and say why`,
      });
      continue;
    }
    unwired.push(clause);
  }

  return { ok: problems.length === 0, problems, wiredCount, unwired };
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// W4U1 — A REGISTER STRING THAT DESCRIBES SOURCE MUST BE CHECKED AGAINST SOURCE.
//
// ★ WHY THIS EXISTS. `E5-2-fenced-object-commit-worker-half`'s `reason` asserted, in prose,
// "BOTH shipped providers declare artifactExportMode=none (e2b-provider.ts:178,
// provider-wire/src/driver.ts:83)". PR #353 changed the E2B provider to `"grant_upload"` and
// implemented export for real. The register string did not move, because NOTHING READ IT.
// It sat there — printed on every green `policy` run as the standing answer to "can a byte
// leave the sandbox at all" — describing a provider that had changed underneath it.
//
// That is the same failure class `evaluateGateClauseWiring` above exists for (a claim
// nothing verifies), one field over: there the claim is `status: "wired"`; here it is a
// sentence. The `symbol` half is mechanical and has stayed honest. The prose half was not,
// and rotted in weeks.
//
// ★ WHAT IT CHECKS, AND WHAT IT DELIBERATELY DOES NOT.
// CHECKS: (a) the declared value matches what the source file actually declares; (b) the
// clause's own `reason` prose states that same value; (c) prose that names a watched
// property carries no value the clause has not declared — so the sentence and the structured
// field cannot drift apart in either direction; and (d) a clause whose prose names a watched
// property at all must declare a claim for it, so an unregistered sentence cannot walk in
// through the front door.
// DOES NOT: pin LINE NUMBERS. A line citation rots on every unrelated edit above it, and a
// guard that reds on unrelated edits gets switched off — this repo's own stated calibration.
// The defect this closes was SEMANTIC (`none` vs `grant_upload`), not positional. Line
// citations in `reason` stay author/review responsibility, and saying so is cheaper than
// letting someone believe they are covered.
//
// Pure. The caller measures the source values and supplies them.
// ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Provider capability properties whose register claims are machine-checked.
 *
 * A clause whose `reason` NAMES one of these must declare a claim for it — otherwise the
 * guard would check a new structured field while the actual stale-prone sentence sat
 * untouched beside it, which is the shape of a check that checks nothing.
 */
export const WATCHED_PROVIDER_PROPERTIES = Object.freeze(["artifactExportMode", "fileStagingMode"]);

/** The key a measured source value is filed under. `file` is repo-relative, POSIX slashes. */
export function providerCapabilityClaimKey(claim) {
  return `${String(claim && claim.file)}::${String(claim && claim.property)}`;
}

/** `artifactExportMode=none` · `artifactExportMode: "grant_upload"` · `artifactExportMode = grant_upload`.
 * Deliberately NOT anchored to a code shape — this reads PROSE, where the value may be bare,
 * back-ticked or quoted. `=(?!=)` keeps `=== "none"` (a comparison, not a claim) out. */
function proseClaimPattern(property) {
  return new RegExp(
    "\\b" + property + "\\b\\s*(?::|=(?!=))\\s*[\"'`]?([A-Za-z_][A-Za-z0-9_]*)[\"'`]?",
    "g",
  );
}

function proseMentionsProperty(reason, property) {
  return new RegExp("\\b" + property + "\\b").test(reason);
}

/**
 * @param {{
 *   declared?: Record<string, {reason?: string, providerCapabilityClaims?: unknown}>,
 *   sourceValues?: Record<string, string|null|string[]>,  // key -> literal | null (absent) | [..] (ambiguous)
 * }} input
 * @returns {{ok: boolean, problems: Array<{kind: string, clause: string|null, detail?: string}>,
 *            claimCount: number}}
 */
export function evaluateProviderCapabilityClaims(input) {
  const problems = [];
  if (!isPlainObject(input)) {
    return { ok: false, problems: [{ kind: "malformed_input", clause: null }], claimCount: 0 };
  }
  const { declared, sourceValues } = input;
  if (!isPlainObject(declared) || !isPlainObject(sourceValues)) {
    return { ok: false, problems: [{ kind: "malformed_input", clause: null }], claimCount: 0 };
  }

  let claimCount = 0;

  for (const clause of Object.keys(declared).sort()) {
    const entry = declared[clause];
    if (!isPlainObject(entry)) continue; // already reported by evaluateGateClauseWiring
    const raw = entry.providerCapabilityClaims;
    if (raw !== undefined && !Array.isArray(raw)) {
      problems.push({
        kind: "malformed_capability_claim",
        clause,
        detail: "providerCapabilityClaims must be an array",
      });
      continue;
    }
    const claims = Array.isArray(raw) ? raw : [];
    const reason = typeof entry.reason === "string" ? entry.reason : "";

    /** property -> the set of values this clause has DECLARED. Drives (b) and (c). */
    const declaredValues = new Map();
    let malformed = false;

    for (const claim of claims) {
      if (!isPlainObject(claim)) {
        problems.push({ kind: "malformed_capability_claim", clause, detail: "claim is not an object" });
        malformed = true;
        continue;
      }
      const { file, property, expect } = claim;
      if (typeof file !== "string" || file.length === 0) {
        problems.push({ kind: "malformed_capability_claim", clause, detail: "file missing" });
        malformed = true;
        continue;
      }
      if (typeof property !== "string" || !WATCHED_PROVIDER_PROPERTIES.includes(property)) {
        problems.push({
          kind: "malformed_capability_claim",
          clause,
          detail:
            "property must be one of " +
            WATCHED_PROVIDER_PROPERTIES.join("|") +
            "; got " +
            JSON.stringify(property),
        });
        malformed = true;
        continue;
      }
      if (typeof expect !== "string" || expect.length === 0) {
        problems.push({ kind: "malformed_capability_claim", clause, detail: `${file}: expect missing` });
        malformed = true;
        continue;
      }
      claimCount += 1;
      if (!declaredValues.has(property)) declaredValues.set(property, new Set());
      declaredValues.get(property).add(expect);

      // (a) THE CHECK THIS GUARD EXISTS FOR — declaration vs source.
      const measured = sourceValues[providerCapabilityClaimKey(claim)];
      if (measured === undefined) {
        problems.push({ kind: "capability_claim_not_measured", clause, detail: `${file} ${property}` });
        continue;
      }
      if (measured === null) {
        problems.push({
          kind: "capability_claim_source_missing",
          clause,
          detail: `${file} declares no ${property}`,
        });
        continue;
      }
      if (Array.isArray(measured)) {
        problems.push({
          kind: "capability_claim_source_ambiguous",
          clause,
          detail: `${file} declares ${property} more than once (${measured.join(", ")})`,
        });
        continue;
      }
      if (measured !== expect) {
        problems.push({
          kind: "capability_claim_source_mismatch",
          clause,
          detail: `${file} declares ${property} = ${JSON.stringify(measured)}, register claims ${JSON.stringify(expect)}`,
        });
      }
    }

    if (malformed) continue;

    // (b) the prose must STATE each declared value. Without this the sentence — the thing
    // that actually rotted — stays unchecked beside a checked field.
    for (const [property, values] of declaredValues) {
      const stated = new Set();
      for (const match of reason.matchAll(proseClaimPattern(property))) stated.add(match[1]);
      for (const value of [...values].sort()) {
        if (!stated.has(value)) {
          problems.push({
            kind: "capability_claim_absent_from_reason",
            clause,
            detail: `reason never states ${property} = ${JSON.stringify(value)}`,
          });
        }
      }
      // (c) and it must state NOTHING ELSE for that property.
      for (const value of [...stated].sort()) {
        if (!values.has(value)) {
          problems.push({
            kind: "capability_claim_unbacked_in_reason",
            clause,
            detail: `reason states ${property} = ${JSON.stringify(value)}, which no claim on this clause declares`,
          });
        }
      }
    }

    // (d) prose that names a watched property with NO claim at all is the loophole that
    // would let the next stale sentence in through the front door.
    for (const property of WATCHED_PROVIDER_PROPERTIES) {
      if (declaredValues.has(property)) continue;
      if (proseMentionsProperty(reason, property)) {
        problems.push({
          kind: "capability_claim_undeclared",
          clause,
          detail: `reason names ${property} but the clause declares no providerCapabilityClaims for it`,
        });
      }
    }
  }

  return { ok: problems.length === 0, problems, claimCount };
}
