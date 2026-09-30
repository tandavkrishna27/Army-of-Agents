// Self-test for the finding-ownership guard.
//
// ★ The tests that matter are the two failure modes this guard exists for:
//   - an OPEN finding with no entry at all (how E4-F007 stayed invisible while sitting in
//     the register at severity HIGH for weeks), and
//   - an entry CLAIMING a ticket that does not exist (a false claim of ownership, which is
//     worse than no claim because it converts an open question into a settled one).

import { test } from "node:test";
import assert from "node:assert/strict";

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  evaluateFindingOwnership,
  findDuplicateJsonKeys,
  parseFindings,
  parseOwnershipManifest,
} from "../finding-ownership.mjs";

const OPEN_HIGH = { id: "E4-F007", status: "open", severity: "HIGH", title: "no session renewal" };
const OPEN_LOW = { id: "E6-F005", status: "open", severity: "LOW", title: "nit" };
const RESOLVED = { id: "E1-F001", status: "resolved_in_plan", severity: "HIGH", title: "done" };

const kinds = (r) => r.problems.map((p) => p.kind);

test("★ an OPEN finding with no declaration FAILS — the E4-F007 case", () => {
  const r = evaluateFindingOwnership({ findings: [OPEN_HIGH], declared: {}, ticketIds: [] });
  assert.equal(r.ok, false);
  assert.deepEqual(kinds(r), ["undeclared_finding"]);
  assert.equal(r.problems[0].finding, "E4-F007");
  // The severity is carried so the report can lead with what actually blocks the programme.
  assert.equal(r.problems[0].detail, "HIGH");
});

test("★ claiming a ticket that does not exist FAILS — a false claim of ownership", () => {
  const r = evaluateFindingOwnership({
    findings: [OPEN_HIGH],
    declared: { "E4-F007": { status: "owned", ticket: "WRK-042", reason: "server-side renewal" } },
    ticketIds: ["WRK-008", "DAT-008"],
  });
  assert.equal(r.ok, false);
  assert.deepEqual(kinds(r), ["owner_ticket_missing"]);
  assert.equal(r.problems[0].detail, "WRK-042");
});

test("★ owned by a ticket that has ALREADY SHIPPED fails — owned by nothing", () => {
  // The state E6-F003 (HIGH, "resolve at DEP-000") and E6-F008 ("resolve before CLI-001")
  // are already in. The register reads like ownership until you check whether the owner is
  // still open, and nothing was checking. Post-E4-F013 a shipped owner with NEITHER prose
  // NOR a successor trips BOTH arms in order — "which part is still open" (owner_ticket_
  // already_complete) and "who inherits it" (successor_missing).
  const r = evaluateFindingOwnership({
    findings: [OPEN_HIGH],
    declared: { "E4-F007": { status: "owned", ticket: "DEP-000", reason: "resolve there" } },
    ticketIds: ["DEP-000"],
    completedTicketIds: ["DEP-000"],
  });
  assert.equal(r.ok, false);
  assert.deepEqual(kinds(r), ["owner_ticket_already_complete", "successor_missing"]);
  assert.equal(r.problems[0].detail, "DEP-000");
});

test("★ naming a part-shipped ticket is allowed ONLY by writing what is still open", () => {
  // The calibration case, and it is real: WRK-008 has result docs for slices 1 and 2a while
  // slice 2b is open. Failing outright would be a false positive on the first real entry,
  // and a guard that cries wolf gets switched off. Saying which part remains is a sentence
  // nobody can write honestly when the answer is "nothing".
  // Post-E4-F013 a shipped owner also needs an on-disk successor; supply a fixed valid one
  // (WRK-012 — on disk, not itself, not shipped) so THIS test isolates the prose arm.
  const declared = (extra) => ({
    "E4-F007": { status: "owned", ticket: "WRK-008", reason: "lands in the live-dispatch wiring", successor: "WRK-012", ...extra },
  });
  const args = { findings: [OPEN_HIGH], ticketIds: ["WRK-008", "WRK-012"], completedTicketIds: ["WRK-008"] };

  assert.equal(evaluateFindingOwnership({ ...args, declared: declared({}) }).ok, false);
  assert.equal(evaluateFindingOwnership({ ...args, declared: declared({ ownerStillOpen: "   " }) }).ok, false);
  assert.equal(
    evaluateFindingOwnership({ ...args, declared: declared({ ownerStillOpen: "slice 2b composes the loop" }) }).ok,
    true,
  );
});

test("owned by a ticket that exists and is still open passes", () => {
  const r = evaluateFindingOwnership({
    findings: [OPEN_HIGH],
    declared: { "E4-F007": { status: "owned", ticket: "WRK-008", reason: "renewal successor" } },
    ticketIds: ["WRK-008", "DEP-000"],
    completedTicketIds: ["DEP-000"],
  });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
});

test("owned + an existing ticket passes", () => {
  const r = evaluateFindingOwnership({
    findings: [OPEN_HIGH],
    declared: { "E4-F007": { status: "owned", ticket: "WRK-008", reason: "renewal successor" } },
    ticketIds: ["WRK-008"],
  });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
});

test("★ unowned is PERMITTED but must say why — that is the honest state, not a hidden one", () => {
  const withReason = evaluateFindingOwnership({
    findings: [OPEN_HIGH],
    declared: { "E4-F007": { status: "unowned", reason: "blocks MIG-005/006/007 ACTIVE; awaiting E3-vs-E4 call" } },
    ticketIds: [],
  });
  assert.equal(withReason.ok, true, JSON.stringify(withReason.problems));
  // And it is REPORTED, so a green run still tells the reader what is unscheduled.
  assert.deepEqual(withReason.unowned, ["E4-F007"]);

  const withoutReason = evaluateFindingOwnership({
    findings: [OPEN_HIGH],
    declared: { "E4-F007": { status: "unowned", reason: "  " } },
    ticketIds: [],
  });
  assert.equal(withoutReason.ok, false);
  assert.deepEqual(kinds(withoutReason), ["malformed_declaration"]);
});

test("★ a HIGH may not be quietly 'accepted' — a LOW may", () => {
  const high = evaluateFindingOwnership({
    findings: [OPEN_HIGH],
    declared: { "E4-F007": { status: "accepted", reason: "not worth it" } },
    ticketIds: [],
  });
  assert.equal(high.ok, false);
  assert.deepEqual(kinds(high), ["severity_not_acceptable"]);

  const low = evaluateFindingOwnership({
    findings: [OPEN_LOW],
    declared: { "E6-F005": { status: "accepted", reason: "nit; the transitive dep list is stable" } },
    ticketIds: [],
  });
  assert.equal(low.ok, true, JSON.stringify(low.problems));
});

test("a declaration for a finding that is no longer open FAILS as stale", () => {
  // A manifest carrying dead entries rots into a list nobody trusts, which is the state
  // this guard is trying to leave.
  const r = evaluateFindingOwnership({
    findings: [RESOLVED],
    declared: { "E1-F001": { status: "owned", ticket: "PRT-001", reason: "fixed" } },
    ticketIds: ["PRT-001"],
  });
  assert.equal(r.ok, false);
  assert.deepEqual(kinds(r), ["stale_declaration"]);
});

test("non-open findings need no declaration at all", () => {
  const r = evaluateFindingOwnership({ findings: [RESOLVED], declared: {}, ticketIds: [] });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.equal(r.openCount, 0);
});

test("malformed input fails closed rather than reporting OK", () => {
  for (const bad of [null, undefined, 42, "nope", {}, { findings: [], declared: null }]) {
    assert.equal(evaluateFindingOwnership(bad).ok, false, `expected failure for ${JSON.stringify(bad)}`);
  }
});

test("parseFindings reads id, status and severity from the real register shape", () => {
  const text = [
    "# Findings",
    "",
    "## E4-F007 — JOB-002 provides no sustained worker-session renewal",
    "",
    "**Status:** `open` · escalated to **E3/JOB-002** · Severity: HIGH (blocks long-running workers)",
    "",
    "Body text.",
    "",
    "## E4-F008 — something else",
    "",
    "**Status:** `open` · Severity: LOW",
  ].join("\n");
  const parsed = parseFindings(text);
  assert.equal(parsed.length, 2);
  assert.deepEqual(
    parsed.map((f) => [f.id, f.status, f.severity]),
    [["E4-F007", "open", "HIGH"], ["E4-F008", "open", "LOW"]],
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// ★★★ THE GUARD'S OWN WORST FAILURE CLASS, FOUND INSIDE THE GUARD.
//
// This test used to assert the OPPOSITE — "a finding with no parseable Status is NOT
// treated as open", ok === true — with the rationale that guessing would make the guard
// noisy and a noisy guard gets switched off.
//
// That rationale is right about GUESSING and wrong about SILENCE, and the cost was
// measured on 2026-09-03: the E0, E1 and E2 registers write their status in shapes the
// parser could not read, or (25 of 34 findings) do not write one at all, so ALL THREE
// REGISTERS WERE INVISIBLE. A synthetic HIGH, gate-blocking, undeclared finding appended
// to E0's register in E0's own documented house style left the checker printing
// `OK (17 open finding(s))` and exiting 0. Two open HIGH findings (E2-F014, E2-F015) sat
// unreadable in a `complete` epic the whole time.
//
// The third option the old comment missed is neither noisy nor a guess: REFUSE, and make a
// human write the field. That is what this now asserts.
test("★★★ a finding with no readable Status FAILS CLOSED — it is not silently 'not open'", () => {
  const parsed = parseFindings("## E9-F001 — no status line here\n\nBody.");
  assert.equal(parsed[0].status, "unknown");
  const r = evaluateFindingOwnership({ findings: parsed, declared: {}, ticketIds: [] });
  assert.equal(r.ok, false);
  assert.deepEqual(kinds(r), ["unparseable_status"]);
  assert.equal(r.problems[0].finding, "E9-F001");
});

test("★★★ the E0 house style is caught — a HIGH gate-blocker with no Status line cannot ship green", () => {
  // The exact positive control, as a permanent regression test. Written in the older
  // documented house style (`- **Severity:** / - **Blocks gate:** / - **Disposition:**`,
  // artifact-policy.md:48) with no Status field of any kind.
  const parsed = parseFindings(
    [
      "## E0-F999 — the control plane ships tenant credentials in cleartext",
      "",
      "- **Severity:** HIGH",
      "- **Blocks gate:** **Yes** — this is a gate blocker.",
      "- **Disposition:** Open — nobody owns this.",
    ].join("\n"),
  );
  const r = evaluateFindingOwnership({ findings: parsed, declared: {}, ticketIds: [] });
  assert.equal(r.ok, false, "a gate-blocking HIGH in the old house style must not pass");
  assert.deepEqual(kinds(r), ["unparseable_status"]);
  // And the severity IS readable now, so the report can lead with what blocks the programme.
  assert.equal(parsed[0].severity, "HIGH");
});

test("★ all three real-world Status shapes are read — the same field, different punctuation", () => {
  const shapes = [
    // The shape the parser already read.
    ["**Status:** open", "open"],
    ["**Status:** `open`", "open"],
    // Bold VALUE — E2-F001/002/008, E7-F004/005/006, E10-F002 all write this.
    ["**Status:** **RESOLVED 2026-08-09** — operator locked E2-D01", "resolved"],
    // Colon INSIDE the bold — E1-F004/F005/F007. The old expression required the colon
    // inside and the value outside, so it matched neither this nor the line above.
    ["- **Status: RESOLVED (resolving revision `e62921b17`).** `job.ts` now throws", "resolved"],
    // Case-folded: a register that SHOUTS its status must still be open.
    ["**Status:** OPEN", "open"],
  ];
  for (const [line, expected] of shapes) {
    const parsed = parseFindings(`## E9-F001 — probe\n\n${line}\n`);
    assert.equal(parsed[0].status, expected, `failed to read: ${line}`);
  }
});

test("★ **Severity:** HIGH is readable — the shape EVERY register uses", () => {
  // The old expression consumed the closing `**` and then demanded a letter where a SPACE
  // stood, so 82 of 108 findings — all 34 in E3, all 11 in E7 — parsed as UNKNOWN, and
  // `severity_not_acceptable` could not fire for any of them.
  for (const [line, expected] of [
    ["- **Severity:** HIGH", "HIGH"],
    ["**Severity:** Minor", "MINOR"],
    ["**Status:** `open` · Severity: HIGH (blocks long-running workers)", "HIGH"],
    ["- **Severity:** P1 STOP — locked-decision contradiction", "P1"],
    ["- **Severity:** High; blocked the E3 predecessor gate", "HIGH"],
  ]) {
    assert.equal(parseFindings(`## E9-F001 — probe\n\n**Status:** open\n${line}\n`)[0].severity, expected, line);
  }
});

test("★ a HIGH may not be 'accepted' — now that severities actually parse", () => {
  // This clause existed before but could not fire on any register that wrote `**Severity:**`.
  const parsed = parseFindings("## E9-F001 — probe\n\n**Status:** open\n- **Severity:** HIGH\n");
  const r = evaluateFindingOwnership({
    findings: parsed,
    declared: { "E9-F001": { status: "accepted", reason: "waving this away" } },
    ticketIds: [],
  });
  assert.equal(r.ok, false);
  assert.deepEqual(kinds(r), ["severity_not_acceptable"]);
});

test("★★ the coordinator's positive control: a HIGH in the BOLDED house style cannot be 'accepted'", () => {
  // MEASURED at base 203853b3a, against the original parser, both halves:
  //   `- **Severity:** HIGH` -> severity=UNKNOWN, ok=TRUE,  problems=[]                  <- waved away
  //   `- Severity: HIGH`     -> severity=HIGH,    ok=false, problems=[severity_not_acceptable]
  // The bolded form is what EVERY register writes, so the rule the guard's own comment says
  // exists "to make [waving away a HIGH] impossible to do quietly" could not fire at all.
  // Both spellings must now refuse.
  for (const severityLine of ["- **Severity:** HIGH", "- Severity: HIGH", "**Severity:** HIGH"]) {
    const findings = parseFindings(`## E9-F001 — probe\n\n**Status:** open\n${severityLine}\n`);
    assert.equal(findings[0].severity, "HIGH", severityLine);
    const r = evaluateFindingOwnership({
      findings,
      declared: { "E9-F001": { status: "accepted", reason: "waving away a HIGH" } },
      ticketIds: [],
    });
    assert.equal(r.ok, false, severityLine);
    assert.deepEqual(kinds(r), ["severity_not_acceptable"], severityLine);
  }
});

test("★★ an OPEN finding with an UNREADABLE severity FAILS — not a silent UNKNOWN", () => {
  // Scoped to open findings on purpose: the guard reasons about nothing else, and four
  // RESOLVED findings legitimately carry no readable severity.
  const open = evaluateFindingOwnership({
    findings: [{ id: "E9-F001", status: "open", severity: "UNKNOWN", title: "probe" }],
    declared: { "E9-F001": { status: "unowned", reason: "nobody yet" } },
    ticketIds: [],
  });
  assert.equal(open.ok, false);
  assert.deepEqual(kinds(open), ["severity_unreadable"]);

  const resolved = evaluateFindingOwnership({
    findings: [{ id: "E9-F001", status: "resolved", severity: "UNKNOWN", title: "probe" }],
    declared: {},
    ticketIds: [],
  });
  assert.equal(resolved.ok, true, JSON.stringify(resolved.problems));
});

test("★ a severity spelling the vocabulary does not know FAILS — a tenth style is a deliberate edit", () => {
  // Without this, the whole defect recurs the moment someone writes a fourth style: it would
  // parse to something, fail the NOT_ACCEPTABLE membership test, and go quiet again.
  const r = evaluateFindingOwnership({
    findings: [{ id: "E9-F001", status: "open", severity: "SEV1", title: "probe" }],
    declared: { "E9-F001": { status: "unowned", reason: "nobody yet" } },
    ticketIds: [],
  });
  assert.equal(r.ok, false);
  assert.deepEqual(kinds(r), ["severity_unknown_vocabulary"]);
  assert.equal(r.problems[0].detail, "SEV1");
});

test("★★ NOT_ACCEPTABLE covers the WHOLE P-scale, not just HIGH/CRITICAL", () => {
  // The hand-written list was ["HIGH","CRITICAL"], which omitted P0 and P1 entirely — 30 of
  // this repo's 108 findings. So even with the regex fixed, a P1 STOP could still have been
  // quietly `accepted`. The list is now DERIVED from SEVERITY_VOCABULARY.
  for (const severity of ["HIGH", "CRITICAL", "P0", "P1"]) {
    const r = evaluateFindingOwnership({
      findings: [{ id: "E9-F001", status: "open", severity, title: "probe" }],
      declared: { "E9-F001": { status: "accepted", reason: "nit" } },
      ticketIds: [],
    });
    assert.equal(r.ok, false, `${severity} must not be acceptable`);
    assert.deepEqual(kinds(r), ["severity_not_acceptable"], severity);
  }
  for (const severity of ["MEDIUM", "MED", "P2", "LOW", "MINOR"]) {
    const r = evaluateFindingOwnership({
      findings: [{ id: "E9-F001", status: "open", severity, title: "probe" }],
      declared: { "E9-F001": { status: "accepted", reason: "genuinely a nit" } },
      ticketIds: [],
    });
    assert.equal(r.ok, true, `${severity} must remain acceptable: ${JSON.stringify(r.problems)}`);
  }
});

test("parseFindings tolerates junk without throwing", () => {
  for (const bad of [null, undefined, 42, {}, ""]) {
    assert.deepEqual(parseFindings(bad), []);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// E4-F013 — a SHIPPED owner must ALSO name a checkable `successor`.
//
// `ownerStillOpen` (prose: which part of the shipped ticket survives) is kept and
// still required; `successor` is added as the machine-checkable pointer to the
// ticket that inherits the residual. When `owned && completed.has(ticket)`, five
// arms fire in order — owner_ticket_already_complete (no prose), then a mutually
// exclusive successor cascade: successor_missing → successor_is_self →
// successor_not_on_disk → successor_already_complete. Each arm gets a RED test here
// and a DELETE mutation in E4-F013-ownership-successor-result.md.
//
// Fixtures model V5/V6: REL-003 SHIPPED (has a result doc) owns E11-F002; DBR-001
// is its filed successor stub — it exists on disk but has NOT shipped.
const OPEN_MED = { id: "E11-F002", status: "open", severity: "MED", title: "restore has no operator entrypoint" };
const shipped = (extra) => ({
  "E11-F002": { status: "owned", ticket: "REL-003", reason: "restore leg has no operator entrypoint", ...extra },
});

test("★ E4-F013 positive control — shipped owner + prose + on-disk successor PASSES", () => {
  // Asserted BEFORE any refusal case (E1-F008: a refusal test that goes green for an
  // unrelated reason proves nothing). This IS E11-F002 after the migration.
  const r = evaluateFindingOwnership({
    findings: [OPEN_MED],
    declared: shipped({ ownerStillOpen: "restore leg owed; runDatabaseRestore has no CLI caller", successor: "DBR-001" }),
    ticketIds: ["REL-003", "DBR-001"],
    completedTicketIds: ["REL-003"],
  });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
});

test("★ E4-F013 successor_missing — a shipped owner naming NO successor FAILS", () => {
  // E11-F002 BEFORE the migration: prose alone used to pass. The original E4-F013 hole.
  const r = evaluateFindingOwnership({
    findings: [OPEN_MED],
    declared: shipped({ ownerStillOpen: "restore leg owed" }),
    ticketIds: ["REL-003", "DBR-001"],
    completedTicketIds: ["REL-003"],
  });
  assert.equal(r.ok, false);
  assert.ok(kinds(r).includes("successor_missing"), JSON.stringify(kinds(r)));
  assert.equal(r.problems.find((p) => p.kind === "successor_missing").detail, "REL-003");
});

test("★ E4-F013 successor_is_self — a shipped owner naming ITSELF reopens the exact hole", () => {
  // Mirrors dependency-graph.mjs's `dep === id` self-check. Without it, an author could
  // write E11-F002's successor as its own shipped owner REL-003 + prose and pass everything.
  const r = evaluateFindingOwnership({
    findings: [OPEN_MED],
    declared: shipped({ ownerStillOpen: "restore leg owed", successor: "REL-003" }),
    ticketIds: ["REL-003", "DBR-001"],
    completedTicketIds: ["REL-003"],
  });
  assert.equal(r.ok, false);
  assert.deepEqual(kinds(r), ["successor_is_self"]);
  assert.equal(r.problems[0].detail, "REL-003");
});

test("★ E4-F013 successor_not_on_disk — a successor with no file is a false claim of inheritance", () => {
  // The case the required mutation (DELETE the existence check) neutralises: without it
  // this bogus entry passes — the finding's exact hole, one field over.
  const r = evaluateFindingOwnership({
    findings: [OPEN_MED],
    declared: shipped({ ownerStillOpen: "restore leg owed", successor: "DBR-999" }),
    ticketIds: ["REL-003", "DBR-001"],
    completedTicketIds: ["REL-003"],
  });
  assert.equal(r.ok, false);
  assert.deepEqual(kinds(r), ["successor_not_on_disk"]);
  assert.equal(r.problems[0].detail, "DBR-999");
});

test("★ E4-F013 successor_already_complete — a SHIPPED successor is the same hole one level down", () => {
  // `completed` is already in scope, so this strengthening is free. DEP-000 exists AND has
  // a result doc → naming it as the inheritor inherits nothing.
  const r = evaluateFindingOwnership({
    findings: [OPEN_MED],
    declared: shipped({ ownerStillOpen: "restore leg owed", successor: "DEP-000" }),
    ticketIds: ["REL-003", "DBR-001", "DEP-000"],
    completedTicketIds: ["REL-003", "DEP-000"],
  });
  assert.equal(r.ok, false);
  assert.deepEqual(kinds(r), ["successor_already_complete"]);
  assert.equal(r.problems[0].detail, "DEP-000");
});

test("★ E4-F013 a NON-shipped owner needs no successor — the three repointed stubs stay green", () => {
  // Scope is `completed.has(ticket)`: WRK-012 / WRK-013 / DEP-011 have no result doc, so the
  // whole block is skipped for them and they neither need nor may carry a successor.
  const r = evaluateFindingOwnership({
    findings: [OPEN_MED],
    declared: { "E11-F002": { status: "owned", ticket: "DBR-001", reason: "successor not shipped yet" } },
    ticketIds: ["REL-003", "DBR-001"],
    completedTicketIds: ["REL-003"],
  });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
});

test("★ E4-F013 calibration preserved — a valid successor does NOT waive the prose requirement", () => {
  // The V2 calibration still bites: a shipped owner with a perfect on-disk successor but no
  // `ownerStillOpen` still fails, because "which part is still open" is left unanswered.
  const r = evaluateFindingOwnership({
    findings: [OPEN_MED],
    declared: shipped({ successor: "DBR-001" }),
    ticketIds: ["REL-003", "DBR-001"],
    completedTicketIds: ["REL-003"],
  });
  assert.equal(r.ok, false);
  assert.ok(kinds(r).includes("owner_ticket_already_complete"), JSON.stringify(kinds(r)));
});

test("★★★ a TYPO'd status FAILS CLOSED — not just an absent one", () => {
  // ROUND 2, found by external review. The first fail-closed arm caught only the synthetic
  // "unknown" the parser invents when no Status field exists. A typo sailed through:
  // `**Status:** opne` parses to "opne", is not "open", matches no manifest entry, and the
  // check exited 0 — recreating, INSIDE the fix, the blind spot the fix exists to remove.
  const parsed = parseFindings("## E9-F001 — probe\n\n**Status:** opne\n- **Severity:** HIGH\n");
  assert.equal(parsed[0].status, "opne");
  const r = evaluateFindingOwnership({ findings: parsed, declared: {}, ticketIds: [] });
  assert.equal(r.ok, false, "a status the vocabulary does not recognise must fail closed");
  assert.deepEqual(kinds(r), ["unknown_status_vocabulary"]);
  assert.equal(r.problems[0].detail, "opne");
});

test("★★ the status vocabulary admits real wordings without a table edit, but not typos of 'open'", () => {
  // 15 distinct statuses are already in use, several one-offs. A flat closed enum would red
  // CI on every new resolution wording — the cry-wolf failure that gets a guard switched
  // off. Families absorb those; `open` stays EXACT so its misspellings cannot be read as
  // closed, which is the one direction that actually loses a finding.
  const classify = (s) =>
    evaluateFindingOwnership({
      findings: [{ id: "E9-F001", status: s, severity: "LOW", title: "p" }],
      declared: {},
      ticketIds: [],
    });
  // Recognised as NOT open -> silent, no problem raised.
  for (const s of [
    "resolved",
    "resolved_in_job",
    "resolved_in_fix_round_2_red_pending_final_review",
    "superseded_after_rejected_four_field_amendment",
    "needs_changes",
    "fixed",
    "partially_resolved_in_job",
    "approved_pending_job",
    "resolved_in_some_brand_new_wording",
  ]) {
    assert.deepEqual(kinds(classify(s)), [], `${s} must be accepted as a non-open status`);
  }
  // Recognised as OPEN -> must be declared.
  assert.deepEqual(kinds(classify("open")), ["undeclared_finding"]);
  // Every misspelling of "open" must be REFUSED, never silently treated as closed.
  for (const s of ["opne", "oepn", "opened", "reopened", "OPE N", "op en"]) {
    assert.deepEqual(kinds(classify(s)), ["unknown_status_vocabulary"], `${s} must be refused`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ★★★ THE MANIFEST IS AN INPUT TOO.
//
// Three tracks conflicted in `finding-ownership.json` in a single day on 2026-09-03 and one
// of them had `git rerere` silently replay a stale resolution, producing a DUPLICATED
// `reason` key — and the `git add` ran anyway, because nothing validated the file.
//
// ★ The distinction these tests exist for: a conflict in a GUARDED field fails LOUDLY (drop
// an ownership entry and its finding becomes undeclared, so the guard reports it). A conflict
// in FREE TEXT fails SILENTLY — that replay reverted a corrected source citation inside a
// `reason` string with every guard green, because no guard reads those strings. `JSON.parse`
// accepts a duplicate key and keeps the LAST copy, so a parse alone cannot see it either.
// ─────────────────────────────────────────────────────────────────────────────

const MANIFEST = (findings) => JSON.stringify({ findings }, null, 2);

test("★ a manifest that does not parse is REFUSED, not crashed on", () => {
  const r = parseOwnershipManifest('{"findings": {<<<<<<< HEAD');
  assert.equal(r.ok, false);
  assert.equal(r.kind, "manifest_unparseable");
  // The refusal carries the parser's own words, so the reader is told WHERE, not just THAT.
  assert.ok(r.detail.length > 0);
});

test("★ a DUPLICATED key is refused — the case `JSON.parse` alone cannot see", () => {
  // Exactly the rerere-replay shape: the stale copy and the corrected copy, both present.
  const text = `{
  "findings": {
    "E3-F034": {
      "status": "unowned",
      "reason": "STALE: cites job-control.ts:1700",
      "reason": "CORRECTED: cites job-control.ts:1819-1821"
    }
  }
}`;
  // The premise, asserted rather than assumed: this parses cleanly and loses a copy.
  assert.equal(typeof JSON.parse(text), "object");
  assert.equal(JSON.parse(text).findings["E3-F034"].reason.startsWith("CORRECTED"), true);

  const r = parseOwnershipManifest(text);
  assert.equal(r.ok, false);
  assert.equal(r.kind, "manifest_duplicate_key");
  assert.match(r.detail, /findings\.E3-F034\.reason/);
});

test("duplicate keys are found in the RAW TEXT, and key-shaped text inside a VALUE is not one", () => {
  // These manifests are almost entirely long prose `reason` strings, so a value that quotes a
  // key is the common case, not a corner one — which is why this is a scanner, not a regex.
  assert.deepEqual(
    findDuplicateJsonKeys('{"reason": "the entry said \\"status\\": \\"owned\\" at the time", "status": "unowned"}'),
    [],
  );
  assert.deepEqual(findDuplicateJsonKeys('{"a": 1, "a": 2}'), [{ path: "a", count: 2 }]);
  assert.deepEqual(
    findDuplicateJsonKeys('{"a": [{"k": 1}, {"k": 1, "k": 2}]}'),
    [{ path: "a.[1].k", count: 2 }],
  );
  // The same NAME in two different objects is not a duplicate. A checker that said otherwise
  // would fire on every manifest, and a guard that cries wolf gets switched off.
  assert.deepEqual(findDuplicateJsonKeys('{"x": {"status": 1}, "y": {"status": 2}}'), []);
});

test("a manifest that parses but has the wrong SHAPE is refused", () => {
  // A merge that loses the one top-level key would otherwise report EVERY finding as
  // undeclared — which reads like a register problem rather than a file problem.
  assert.equal(parseOwnershipManifest('{"finding": {}}').kind, "manifest_shape");
  assert.equal(parseOwnershipManifest("[]").kind, "manifest_shape");
  assert.equal(parseOwnershipManifest('{"findings": []}').kind, "manifest_shape");
  assert.equal(parseOwnershipManifest('{"findings": {"E1-F001": "owned"}}').kind, "manifest_shape");
});

test("a well-formed manifest still passes through untouched", () => {
  const findings = { "E4-F007": { status: "unowned", reason: "nobody yet" } };
  const r = parseOwnershipManifest(MANIFEST(findings));
  assert.equal(r.ok, true);
  assert.deepEqual(r.findings, findings);
});

// ★ AND THE VALIDATION MUST BE CHAINED TO THE GUARD, not merely available beside it — the
// 2026-09-03 incident is precisely that a validation existed nowhere in the path the file
// actually travelled. These drive the real script end to end against a fixture repo root.

const CHECKER = path.join(
  fileURLToPath(new URL("../../", import.meta.url)),
  "check-finding-ownership.mjs",
);

function runCheckerOn(manifestText, extraArgs = []) {
  const root = mkdtempSync(path.join(tmpdir(), "finding-ownership-"));
  try {
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    mkdirSync(path.join(root, "docs/replatform/epics/E0-foundation"), { recursive: true });
    writeFileSync(path.join(root, "scripts/finding-ownership.json"), manifestText, "utf8");
    writeFileSync(
      path.join(root, "docs/replatform/epics/E0-foundation/findings.md"),
      "## E0-F001 — a finding\n\n**Status:** open\n**Severity:** LOW\n",
      "utf8",
    );
    try {
      const stdout = execFileSync(process.execPath, [CHECKER, ...extraArgs], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { code: 0, output: stdout };
    } catch (error) {
      return { code: error.status ?? 1, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("★ the SCRIPT refuses a duplicated key — validation is chained to the read", () => {
  const good = MANIFEST({ "E0-F001": { status: "unowned", reason: "nobody yet" } });
  const green = runCheckerOn(good);
  assert.equal(green.code, 0, `positive control must be green, got:\n${green.output}`);

  const corrupted = good.replace('"status": "unowned",', '"reason": "STALE REPLAY",\n      "status": "unowned",');
  const red = runCheckerOn(corrupted);
  assert.equal(red.code, 1);
  assert.match(red.output, /manifest_duplicate_key/);
  assert.match(red.output, /findings\.E0-F001\.reason/);
});

test("★ --write ALSO refuses — it must never rewrite the surviving half of a duplicate", () => {
  const corrupted = MANIFEST({ "E0-F001": { status: "unowned", reason: "kept" } })
    .replace('"status": "unowned",', '"reason": "STALE REPLAY",\n      "status": "unowned",');
  const red = runCheckerOn(corrupted, ["--write"]);
  assert.equal(red.code, 1);
  assert.match(red.output, /manifest_duplicate_key/);
});

test("the SCRIPT refuses a manifest that does not parse at all", () => {
  const red = runCheckerOn('{"findings": {\n<<<<<<< HEAD\n');
  assert.equal(red.code, 1);
  assert.match(red.output, /manifest_unparseable/);
});
