#!/usr/bin/env node
/**
 * Self-test for `scripts/check-threat-control-audit-debt.mjs`.
 *
 * A GUARD THAT CANNOT BE OBSERVED GOING RED IS NOT A GUARD. Every clause below is driven
 * by a mutation of the REAL tree's collected input, and each mutation is asserted to
 * produce the specific error naming that clause — never merely "some error". The first
 * test is the positive control: the shipped tree passes with zero errors, so a mutation
 * going red is attributable to the mutation and not to a broken harness.
 *
 * Two of the tests are NEGATIVE controls (an input that must NOT red), because two of this
 * guard's rules are narrowings that could silently swallow the thing they exist to catch:
 * the range-span strip in `crossingIdsNamedBy`, and the `delivered` exemption in
 * OWNER-EXISTS.
 *
 * Usage: node --test scripts/check-threat-control-audit-debt.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  collect,
  crossingIdsNamedBy,
  evaluateAuditDebt,
  AUDIT_DEBT_JSON,
  THREAT_CONTROLS_JSON,
} from "./check-threat-control-audit-debt.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** A deep copy of the real tree's collected input, so a mutation cannot leak between tests. */
function baseInput() {
  return structuredClone(collect(REPO_ROOT));
}

function crossing(input, id) {
  const found = input.crossings.find((c) => c.id === id);
  assert.ok(found, `fixture drift: crossing ${id} is gone from ${THREAT_CONTROLS_JSON}`);
  return found;
}

/**
 * W20B — MINT AN `unaudited` CROSSING RATHER THAN BORROW ONE.
 *
 * Four tests below used to reach into the real tree for "whichever crossing is still
 * `unaudited`". That worked while sixteen were, and it silently became UNRUNNABLE the moment
 * W20B recorded the last of them and drove the pin to zero — the tests threw on `undefined`
 * rather than failing on a mutation, which is the same "a check that nothing runs" shape this
 * whole guard exists to catch. The repair is NOT to delete them (deleting a test subtracts a
 * failure) and NOT to keep a crossing unaudited so they have something to chew on. It is to
 * make each test construct the state it is about.
 *
 * The synthetic row is a real Critical with an on-disk ownerTicket, so it satisfies
 * OWNER-EXISTS and leaves the input GREEN once the pin is raised to match — which is what
 * makes the subsequent mutation the ONLY cause of any error the test then asserts.
 */
function mintUnaudited(input, id) {
  assert.ok(!input.crossings.some((c) => c.id === id), `${id} must not already exist`);
  input.crossings.push({
    id,
    severity: "Critical",
    deliveryStatus: "unaudited",
    deliveryEvidence: "unaudited: synthetic fixture row minted by the guard's own self-test.",
    ownerTickets: ["FND-005"],
  });
  input.debt.ceilings.unauditedCriticalHigh += 1;
  input.debt.auditedFloor = input.debt.auditedFloor ?? { ids: [] };
  // Deliberately NOT added to auditedFloor: an unaudited row must not be on that floor.
  const { errors } = evaluateAuditDebt(input);
  assert.deepEqual(errors, [], `minting ${id} must leave the input green:\n${report(errors)}`);
  return input.crossings.at(-1);
}

/**
 * SVC-002 — MINT A DEFERRED CROSSING RATHER THAN BORROW THE ONE THE TREE HAPPENS TO HAVE.
 *
 * The five OWNER-EXISTS tests below used to reach into the real tree for two facts: that
 * `DE-12` carried the sole declared `ownerTicketDeferrals` entry, and that `SVC-002` was an
 * id with zero files on disk. **Both expired in the same commit**, and for the reason the
 * deferral's own text predicted — it said "REMOVE THIS ENTRY the moment any of
 * SVC-002/003/005 gets a file", SVC-002 got two design documents, and the entry was removed.
 * The tests then failed not on a mutation but on fixture drift, which is the identical shape
 * W20B repaired four tests above for. Deleting them would subtract five failures; keeping a
 * deferral alive so they have something to chew on would red the real checker. The repair is
 * the same one: each test constructs the state it is about.
 *
 * The synthetic row is `partial` (so OWNER-EXISTS applies to it), owns a ticket that IS on
 * disk (so the input starts GREEN), and carries a declared deferral only where the test needs
 * one. A green start is what makes any error the test then asserts attributable to its own
 * mutation.
 */
const DEFERRAL_FIXTURE_ID = "DE-98";

// An id no `docs/replatform/epics/*/tickets/` file can ever start with, so "not on disk"
// is a property of the STRING and not of what the programme happens to have written yet.
// `findTicketIds` matches `/^([A-Z]+-\d+)/`, so this parses as a ticket id and simply has
// no file — which is exactly the state under test.
//
// ★ LINE COMMENTS, DELIBERATELY, AND THIS IS THE POINT OF E6-F020. This comment was first
// written as a JSDoc block, which cannot contain the glob above: the `*/` inside it closes
// the block. It shipped with a U+200B ZERO WIDTH SPACE wedged between the `*` and the `/`,
// so the path a reader saw was not the path on disk — the exact "legitimate use with no
// escape-based repair" that `scripts/check-invisible-control-chars.mjs` cites as its reason
// for leaving ZWSP legal. A repair does exist and this is it: `//` has no terminator, so the
// glob can be written literally. Do not restore the block form.
const ABSENT_TICKET_ID = "ZZZNOSUCH-999";

function mintPartialWithDeferral(input, { declareDeferral }) {
  assert.ok(
    !input.crossings.some((c) => c.id === DEFERRAL_FIXTURE_ID),
    `${DEFERRAL_FIXTURE_ID} must not already exist`,
  );
  assert.ok(
    !input.ticketIds.includes(ABSENT_TICKET_ID),
    `${ABSENT_TICKET_ID} must have no file on disk for this fixture to mean anything`,
  );
  input.crossings.push({
    id: DEFERRAL_FIXTURE_ID,
    severity: "Critical",
    deliveryStatus: "partial",
    deliveryEvidence: "partial: synthetic fixture row minted by the guard's own self-test.",
    ownerTickets: [ABSENT_TICKET_ID],
  });
  // W22: the floors are now EXHAUSTIVE, so an audited row that is not enrolled reds on its
  // own. Enrol the fixture, or every OWNER-EXISTS test below would be asserting against an
  // input that was already red for an unrelated reason.
  input.debt.auditedFloor.ids.push(DEFERRAL_FIXTURE_ID);
  input.debt.ownerTicketDeferrals = input.debt.ownerTicketDeferrals ?? {};
  if (declareDeferral) {
    input.debt.ownerTicketDeferrals[DEFERRAL_FIXTURE_ID] = {
      reason: "synthetic fixture deferral minted by the guard's own self-test.",
    };
    const { errors } = evaluateAuditDebt(input);
    assert.deepEqual(
      errors,
      [],
      `minting ${DEFERRAL_FIXTURE_ID} with its deferral must leave the input green:\n${report(errors)}`,
    );
  }
  return input.crossings.at(-1);
}

function hasError(errors, needle) {
  return errors.some((e) => e.includes(needle));
}

const report = (errors) => `errors:\n${errors.map((e) => `  - ${e}`).join("\n") || "  (none)"}`;

// --- POSITIVE CONTROL -------------------------------------------------------------------

test("POSITIVE CONTROL: the shipped tree passes with zero errors", () => {
  const { errors, notes } = evaluateAuditDebt(baseInput());
  assert.deepEqual(errors, [], report(errors));
  assert.ok(notes.some((n) => n.includes("still \"unaudited\" (pinned)")), notes.join("\n"));
});

// W20B REPLACEMENT, and a strictly stronger claim than the one it replaces. This test used
// to assert `pin > 0`, on the theory that a pin of zero would make the over-arm unreachable.
// That theory was wrong: at pin zero the over-arm is reached by the FIRST unaudited row to
// appear, which is the tightest the ratchet has ever been. So rather than assert a number,
// this now EXHIBITS the over-arm firing at whatever the real pin is — including zero.
test("POSITIVE CONTROL: the pin is not vacuous — the over-arm fires at the tree's real pin", () => {
  const input = baseInput();
  const before = evaluateAuditDebt(input);
  assert.deepEqual(before.errors, [], `the committed tree must be green first:\n${report(before.errors)}`);

  // One unaudited Critical appears and the pin is NOT raised to cover it.
  input.crossings.push({
    id: "DE-9001",
    severity: "Critical",
    deliveryStatus: "unaudited",
    deliveryEvidence: "unaudited: synthetic over-arm probe.",
    ownerTickets: ["FND-005"],
  });
  const { errors } = evaluateAuditDebt(input);
  assert.ok(hasError(errors, "The pin may only go DOWN"), report(errors));
  assert.ok(hasError(errors, "DE-9001"), report(errors));
});

// --- RATCHET-PIN ------------------------------------------------------------------------

test("M1 RATCHET-PIN over: a NEW unaudited Critical crossing reds", () => {
  const input = baseInput();
  input.crossings.push({
    id: "DE-99",
    severity: "Critical",
    deliveryStatus: "unaudited",
    ownerTickets: ["TEN-002"],
  });
  const { errors } = evaluateAuditDebt(input);
  assert.ok(hasError(errors, "Critical/High crossings are \"unaudited\" but the pin"), report(errors));
  assert.ok(hasError(errors, "DE-99"), report(errors));
});

test("M2 RATCHET-PIN over: an audited crossing regressing to unaudited reds", () => {
  const input = baseInput();
  crossing(input, "DE-01").deliveryStatus = "unaudited";
  const { errors } = evaluateAuditDebt(input);
  assert.ok(hasError(errors, "The pin may only go DOWN"), report(errors));
});

test("M3 RATCHET-PIN under: auditing a crossing without lowering the pin reds (self-cleaning)", () => {
  const input = baseInput();
  const target = mintUnaudited(input, "DE-9002"); // green at pin+1
  target.deliveryStatus = "partial"; // audited — and the pin is left alone
  const { errors } = evaluateAuditDebt(input);
  assert.ok(hasError(errors, "Lower ceilings.unauditedCriticalHigh to"), report(errors));
});

test("M4 RATCHET-PIN: a malformed pin reds rather than defaulting", () => {
  const input = baseInput();
  input.debt.ceilings.unauditedCriticalHigh = "sixteen";
  const { errors } = evaluateAuditDebt(input);
  assert.ok(hasError(errors, "must be a non-negative integer"), report(errors));
});

test("M5 RATCHET-PIN: a deleted pin reds rather than passing vacuously", () => {
  const input = baseInput();
  delete input.debt.ceilings.unauditedCriticalHigh;
  const { errors } = evaluateAuditDebt(input);
  assert.ok(hasError(errors, "must be a non-negative integer"), report(errors));
});

// --- AUDITED-FLOOR ----------------------------------------------------------------------

test("M6 AUDITED-FLOOR: a floor crossing returning to unaudited names itself", () => {
  const input = baseInput();
  crossing(input, "DE-07").deliveryStatus = "unaudited";
  // Raise the pin so RATCHET-PIN is satisfied and only the floor clause can speak.
  input.debt.ceilings.unauditedCriticalHigh += 1;
  const { errors } = evaluateAuditDebt(input);
  assert.ok(
    hasError(errors, "crossing DE-07 is recorded in auditedFloor but has regressed to \"unaudited\""),
    report(errors),
  );
});

test("M7 AUDITED-FLOOR: naming a crossing that does not exist reds", () => {
  const input = baseInput();
  input.debt.auditedFloor.ids.push("DE-99");
  const { errors } = evaluateAuditDebt(input);
  assert.ok(hasError(errors, "auditedFloor names DE-99, which is not a crossing"), report(errors));
});

// --- W22: THE FOUR WAYS THE FLOOR ARM USED TO FAIL OPEN ---------------------------------
//
// Each of these passed the guard before W22, and the third and fourth are the ones that
// matter: the arm was mutation-tested once already, and the mutation chose a crossing that
// WAS in the floor — i.e. it exercised the single path that worked. Every test below asserts
// a DISTINCT message, so no two of them can be satisfied by the same repair.

test("M7a AUDITED-FLOOR fail-closed: deleting the whole section reds (it used to pass vacuously)", () => {
  const input = baseInput();
  delete input.debt.auditedFloor;
  const { errors } = evaluateAuditDebt(input);
  assert.ok(hasError(errors, 'auditedFloor is missing or is not an object with an "ids" array'), report(errors));
  // And it must not bury that message under one derivative error per audited crossing.
  assert.ok(!hasError(errors, "auditedFloor is INCOMPLETE"), report(errors));
});

test("M7b DELIVERED-FLOOR fail-closed: deleting the whole section reds (it used to pass vacuously)", () => {
  const input = baseInput();
  delete input.debt.deliveredFloor;
  const { errors } = evaluateAuditDebt(input);
  assert.ok(hasError(errors, 'deliveredFloor is missing or is not an object with an "ids" array'), report(errors));
  assert.ok(!hasError(errors, "deliveredFloor is INCOMPLETE"), report(errors));
});

test("M7c AUDITED-FLOOR exhaustiveness: auditing a crossing while OMITTING it from the floor reds", () => {
  // The reviewer's first commit. Pre-W22 every clause passed: the pin's count is right, and
  // the floor loop could only ever speak about ids the floor already contained.
  const input = baseInput();
  const target = mintUnaudited(input, "DE-9004"); // green at pin+1
  target.deliveryStatus = "partial"; // audited...
  input.debt.ceilings.unauditedCriticalHigh -= 1; // ...and the pin lowered, honestly
  // ...but the measurement is enrolled nowhere.
  const { errors } = evaluateAuditDebt(input);
  assert.ok(hasError(errors, "auditedFloor is INCOMPLETE — crossing DE-9004"), report(errors));
  assert.ok(hasError(errors, 'is "partial" — i.e. it HAS been audited'), report(errors));
  // The pin is satisfied, so this must be the ONLY thing speaking.
  assert.ok(!hasError(errors, "ceilings.unauditedCriticalHigh"), report(errors));
});

test("M7d AUDITED-FLOOR: the count-preserving omit-then-regress sequence reds at BOTH steps", () => {
  // The reviewer's two-commit attack in full. X is audited and the measurement recorded;
  // a later commit returns X to `unaudited` while auditing Y, so the pin's count never
  // moves and the floor is never edited. Pre-W22, if X had been omitted from the floor in
  // step one, nothing anywhere would have noticed the discard.
  const input = baseInput();
  const x = mintUnaudited(input, "DE-9005");
  const y = mintUnaudited(input, "DE-9006"); // green at pin+2

  // Commit 1, done the ONLY way the fixed guard accepts: audit X, lower the pin, enrol X.
  x.deliveryStatus = "partial";
  input.debt.ceilings.unauditedCriticalHigh -= 1;
  input.debt.auditedFloor.ids.push(x.id);
  const afterAudit = evaluateAuditDebt(structuredClone(input));
  assert.deepEqual(afterAudit.errors, [], `commit 1 must be green:\n${report(afterAudit.errors)}`);

  // Commit 2: X's measurement is discarded and Y's replaces it. THE COUNT IS UNCHANGED.
  x.deliveryStatus = "unaudited";
  y.deliveryStatus = "partial";
  const { errors } = evaluateAuditDebt(input);
  assert.ok(
    hasError(errors, `crossing ${x.id} is recorded in auditedFloor but has regressed to "unaudited"`),
    report(errors),
  );
  assert.ok(hasError(errors, `auditedFloor is INCOMPLETE — crossing ${y.id}`), report(errors));
  // ★ The pin is exactly what it was and is NOT what catches this. If the pin arm fired,
  // this test would be passing for a reason that has nothing to do with the floor.
  assert.ok(!hasError(errors, "ceilings.unauditedCriticalHigh"), report(errors));
});

test("M7e DELIVERED-FLOOR exhaustiveness: a NEW delivered row not enrolled in the floor reds", () => {
  const input = baseInput();
  const target = mintUnaudited(input, "DE-9007"); // green at pin+1
  target.deliveryStatus = "delivered";
  input.debt.ceilings.unauditedCriticalHigh -= 1;
  input.debt.auditedFloor.ids.push(target.id); // audited floor satisfied; delivered floor not
  const { errors } = evaluateAuditDebt(input);
  assert.ok(hasError(errors, "deliveredFloor is INCOMPLETE — crossing DE-9007"), report(errors));
  assert.ok(!hasError(errors, "auditedFloor is INCOMPLETE"), report(errors));
});

test("POSITIVE CONTROL: the committed floors are exhaustive — every audited/delivered row is enrolled", () => {
  const input = baseInput();
  const { errors } = evaluateAuditDebt(input);
  assert.deepEqual(errors, [], report(errors));
  const audited = input.crossings.filter((c) => c.deliveryStatus !== "unaudited").map((c) => c.id).sort();
  assert.deepEqual([...input.debt.auditedFloor.ids].sort(), audited);
  assert.deepEqual(
    [...input.debt.deliveredFloor.ids].sort(),
    input.crossings.filter((c) => c.deliveryStatus === "delivered").map((c) => c.id).sort(),
  );
});

// --- DELIVERED-FLOOR --------------------------------------------------------------------

test("M8 DELIVERED-FLOOR: the one delivered crossing regressing reds and names the row", () => {
  const input = baseInput();
  crossing(input, "DE-02").deliveryStatus = "partial";
  const { errors } = evaluateAuditDebt(input);
  assert.ok(
    hasError(errors, "crossing DE-02 is recorded in deliveredFloor but is now \"partial\""),
    report(errors),
  );
});

test("M9 DELIVERED-FLOOR: naming a crossing that does not exist reds", () => {
  const input = baseInput();
  input.debt.deliveredFloor.ids.push("DE-99");
  const { errors } = evaluateAuditDebt(input);
  assert.ok(hasError(errors, "deliveredFloor names DE-99, which is not a crossing"), report(errors));
});

// --- OWNER-EXISTS -----------------------------------------------------------------------

test("M10 OWNER-EXISTS: deleting a declared deferral reds (the debt cannot become silent)", () => {
  const input = baseInput();
  mintPartialWithDeferral(input, { declareDeferral: true });
  delete input.debt.ownerTicketDeferrals[DEFERRAL_FIXTURE_ID];
  const { errors } = evaluateAuditDebt(input);
  assert.ok(hasError(errors, `crossing ${DEFERRAL_FIXTURE_ID} is "partial" and names no ownerTicket with a file on disk`), report(errors));
  assert.ok(hasError(errors, "its audit route terminates nowhere"), report(errors));
});

test("M11 OWNER-EXISTS: a deferral with an empty reason is not a declaration", () => {
  const input = baseInput();
  mintPartialWithDeferral(input, { declareDeferral: true });
  input.debt.ownerTicketDeferrals[DEFERRAL_FIXTURE_ID] = { reason: "   " };
  const { errors } = evaluateAuditDebt(input);
  assert.ok(hasError(errors, `crossing ${DEFERRAL_FIXTURE_ID} is "partial" and names no ownerTicket`), report(errors));
});

test("M12 OWNER-EXISTS: a crossing losing its last on-disk owner ticket reds", () => {
  const input = baseInput();
  assert.ok(!input.ticketIds.includes(ABSENT_TICKET_ID), "fixture drift: the absent-ticket sentinel now exists on disk");
  crossing(input, "DE-06").ownerTickets = [ABSENT_TICKET_ID]; // an id with zero files on disk
  const { errors } = evaluateAuditDebt(input);
  assert.ok(hasError(errors, "crossing DE-06 is \"partial\" and names no ownerTicket with a file on disk"), report(errors));
});

test("M13 OWNER-EXISTS: a STALE deferral (its ticket now exists) reds — the entry is self-cleaning", () => {
  const input = baseInput();
  mintPartialWithDeferral(input, { declareDeferral: true });
  // The deferral's whole justification is that its owner ticket has no file. Give it one.
  input.ticketIds.push(ABSENT_TICKET_ID);
  const { errors } = evaluateAuditDebt(input);
  assert.ok(hasError(errors, `the ownerTicketDeferrals entry for ${DEFERRAL_FIXTURE_ID} is STALE`), report(errors));
});

test("M14 OWNER-EXISTS: a ghost deferral (no such crossing) reds", () => {
  const input = baseInput();
  input.debt.ownerTicketDeferrals["DE-99"] = { reason: "nothing to see here" };
  const { errors } = evaluateAuditDebt(input);
  assert.ok(hasError(errors, "ownerTicketDeferrals names DE-99, which is not a crossing"), report(errors));
});

test("NEGATIVE CONTROL: the `delivered` exemption does not swallow a real orphan", () => {
  // DE-02 is `delivered` and therefore exempt from OWNER-EXISTS. Prove the exemption is
  // keyed on the STATUS and not on the id: the same row, not delivered, must red.
  const input = baseInput();
  assert.ok(!input.ticketIds.includes(ABSENT_TICKET_ID), "fixture drift: the absent-ticket sentinel now exists on disk");
  const de02 = crossing(input, "DE-02");
  de02.ownerTickets = [ABSENT_TICKET_ID];
  const stillDelivered = evaluateAuditDebt(structuredClone(input));
  assert.ok(!hasError(stillDelivered.errors, "crossing DE-02 is"), report(stillDelivered.errors));
  de02.deliveryStatus = "partial";
  const { errors } = evaluateAuditDebt(input);
  assert.ok(hasError(errors, "crossing DE-02 is \"partial\" and names no ownerTicket with a file on disk"), report(errors));
});

// --- FINDING-VISIBLE --------------------------------------------------------------------

test("M15 FINDING-VISIBLE: the DE-11 shape — an unaudited crossing a committed finding is about", () => {
  const input = baseInput();
  crossing(input, "DE-11").deliveryStatus = "unaudited";
  input.debt.ceilings.unauditedCriticalHigh += 1;
  input.debt.auditedFloor.ids = input.debt.auditedFloor.ids.filter((id) => id !== "DE-11");
  const { errors } = evaluateAuditDebt(input);
  assert.ok(hasError(errors, "crossing DE-11 is \"unaudited\""), report(errors));
  assert.ok(hasError(errors, "docs/replatform/FINDING-retention-authority-and-DE-11.md"), report(errors));
  assert.ok(hasError(errors, "over the top of an audit that was performed and written down"), report(errors));
});

test("M16 FINDING-VISIBLE: an epic register naming an unaudited crossing reds too (not only top-level docs)", () => {
  const input = baseInput();
  const target = mintUnaudited(input, "DE-9003"); // green at pin+1
  input.findingDocuments.push({
    path: "docs/replatform/epics/E0-foundation/findings.md",
    text: `## E0-F999 — a measured absence on ${target.id}`,
  });
  const { errors } = evaluateAuditDebt(input);
  assert.ok(hasError(errors, `crossing ${target.id} is "unaudited"`), report(errors));
});

test("NEGATIVE CONTROL: a RANGE SPAN names a set, not its endpoints, and must not red", () => {
  // `E0-F008` really does contain "the DE-01...DE-30 register ID set". Without the strip,
  // one sentence implicated two crossings it says nothing about — a false positive of
  // exactly the kind that gets a guard switched off.
  //
  // W20B: this used to anchor on "whichever crossing is still unaudited", which after the
  // last sixteen audits is NONE — and once every real endpoint is audited, FINDING-VISIBLE
  // cannot fire on DE-01 or DE-30 whether the strip works or not, so the test would have
  // gone quietly vacuous rather than red. It now mints BOTH span endpoints as unaudited, so
  // a missing strip has something to implicate, and it carries its own positive control.
  const input = baseInput();
  const lo = mintUnaudited(input, "DE-9010");
  const hi = mintUnaudited(input, "DE-9020");

  input.findingDocuments.push({
    path: "docs/replatform/epics/E0-foundation/findings.md",
    text: `the ${lo.id}...${hi.id} register ID set, and the ${lo.id} - ${hi.id} span, and ${lo.id} to ${hi.id}`,
  });
  const spans = evaluateAuditDebt(input);
  assert.ok(!hasError(spans.errors, `crossing ${lo.id} is "unaudited"`), report(spans.errors));
  assert.ok(!hasError(spans.errors, `crossing ${hi.id} is "unaudited"`), report(spans.errors));
  assert.deepEqual(spans.errors, [], report(spans.errors));

  // POSITIVE CONTROL — without this the assertions above pass on a document nobody read.
  // A separate, NON-span mention of the same id must still red.
  input.findingDocuments.push({
    path: "docs/replatform/epics/E0-foundation/findings.md",
    text: `## E0-F998 — ${lo.id} specifically, measured absent`,
  });
  const named = evaluateAuditDebt(input);
  assert.ok(hasError(named.errors, `crossing ${lo.id} is "unaudited"`), report(named.errors));
});

test("crossingIdsNamedBy: ranges stripped, genuine mentions kept", () => {
  assert.deepEqual(crossingIdsNamedBy("the DE-01...DE-30 register ID set"), []);
  assert.deepEqual(crossingIdsNamedBy("DE-01 — DE-30"), []);
  assert.deepEqual(crossingIdsNamedBy("DE-11 is not delivered"), ["DE-11"]);
  assert.deepEqual(crossingIdsNamedBy("affects DE-05, DE-07 and DE-10"), ["DE-05", "DE-07", "DE-10"]);
  // A range does NOT license silence about a crossing named separately in the same text.
  assert.deepEqual(crossingIdsNamedBy("the DE-01...DE-30 set, but DE-12 specifically"), ["DE-12"]);
});

test("M17 FINDING-VISIBLE: an orphan top-level FINDING document reds", () => {
  const input = baseInput();
  input.topLevelFindingDocPaths.push("docs/replatform/FINDING-nobody-registered-me.md");
  const { errors } = evaluateAuditDebt(input);
  assert.ok(hasError(errors, "docs/replatform/FINDING-nobody-registered-me.md"), report(errors));
  assert.ok(hasError(errors, "can never see it and it can never print as unowned"), report(errors));
});

// --- W22: FINDING-VISIBLE (b) WAS A RAW SUBSTRING CHECK ---------------------------------
//
// `epicText.includes(basename)` over every register's concatenated text accepted three
// things that leave the document exactly as invisible to check-finding-ownership.mjs as an
// unregistered one: a mention in prose outside any finding, a mention inside a CLOSED
// finding, and a sentence saying the document is NOT registered. The bar is now the object
// the census actually reads — an OPEN, parsed finding entry.

const ORPHAN_DOC = "docs/replatform/FINDING-w22-substring-probe.md";

/** Strip every real reference to the probe doc, then register it however the test says. */
function probeRegistration(text) {
  const input = baseInput();
  input.topLevelFindingDocPaths.push(ORPHAN_DOC);
  input.findingDocuments.push({ path: "docs/replatform/epics/E0-foundation/findings.md", text });
  return evaluateAuditDebt(input).errors;
}

const ORPHAN_ERROR = `${ORPHAN_DOC}: a top-level FINDING document is named by no OPEN finding entry`;

test("M18a FINDING-VISIBLE: a mention in PROSE ALONE does not register a document", () => {
  const errors = probeRegistration(
    `Some register preamble that mentions ${path.posix.basename(ORPHAN_DOC)} in passing.\n`,
  );
  assert.ok(hasError(errors, ORPHAN_ERROR), report(errors));
});

test("M18b FINDING-VISIBLE: a mention inside a RESOLVED finding does not register a document", () => {
  const errors = probeRegistration(
    `## E0-F997 — the probe document\n\n**Status:** resolved\n\nSee ${path.posix.basename(ORPHAN_DOC)}.\n`,
  );
  assert.ok(hasError(errors, ORPHAN_ERROR), report(errors));
});

test("M18c DOCUMENTED LIMIT: a DENIAL inside an open finding still counts as registration", () => {
  // Written down rather than left implicit, because the reviewer listed this alongside the
  // two cases above and only those two are closed. The clause's job is STRUCTURAL: it asks
  // whether an open, declared finding carries the document into the ownership census. It
  // does not — and cannot — read what the sentence means. A denial sitting inside an open
  // finding does put the document in front of that finding's owner, which is the whole
  // protection; a denial in prose or in a closed finding does not, and now reds.
  const errors = probeRegistration(
    `## E0-F996 — unrelated\n\n**Status:** open\n\n` +
      `Note that ${path.posix.basename(ORPHAN_DOC)} is NOT registered anywhere.\n`,
  );
  assert.ok(!hasError(errors, ORPHAN_ERROR), report(errors));
});

test("POSITIVE CONTROL: a genuine OPEN finding naming the document stays GREEN", () => {
  const errors = probeRegistration(
    `## E0-F995 — the probe document has an owner\n\n**Status:** open · **Severity:** LOW\n\n` +
      `This finding is the register home of ${path.posix.basename(ORPHAN_DOC)}.\n`,
  );
  assert.deepEqual(errors, [], report(errors));
});

// --- W22B: THE SUBSTRING BUG CAME BACK ONE LAYER DOWN -----------------------------------
//
// The W22 fix moved the bar to a PARSED OPEN finding but still matched with
// `f.text.includes(basename)`. Two top-level documents with overlapping names therefore
// collapsed into one: an open finding naming ONLY the longer registered BOTH, leaving the
// shorter invisible to the ownership census — the exact failure the clause exists to close.

const LONG_DOC = "docs/replatform/FINDING-other-FINDING-w22-substring-probe.md";

/** Register BOTH overlapping docs as top-level, and seed one open finding with `text`. */
function overlappingRegistration(text) {
  const input = baseInput();
  input.topLevelFindingDocPaths.push(ORPHAN_DOC, LONG_DOC);
  input.findingDocuments.push({ path: "docs/replatform/epics/E0-foundation/findings.md", text });
  return evaluateAuditDebt(input).errors;
}

const LONG_ERROR = `${LONG_DOC}: a top-level FINDING document is named by no OPEN finding entry`;

test("M18d FINDING-VISIBLE: an open finding naming ONLY the longer overlapping name leaves the shorter RED", () => {
  const errors = overlappingRegistration(
    `## E0-F994 — the longer document only\n\n**Status:** open · **Severity:** LOW\n\n` +
      `This finding is the register home of ${path.posix.basename(LONG_DOC)}.\n`,
  );
  assert.ok(hasError(errors, ORPHAN_ERROR), report(errors));
  assert.ok(!hasError(errors, LONG_ERROR), report(errors));
});

test("M18e POSITIVE CONTROL: an open finding naming EACH overlapping document stays GREEN", () => {
  const errors = overlappingRegistration(
    `## E0-F994 — the longer document\n\n**Status:** open · **Severity:** LOW\n\n` +
      `Register home of ${path.posix.basename(LONG_DOC)}.\n\n` +
      `## E0-F993 — the shorter document\n\n**Status:** open · **Severity:** LOW\n\n` +
      `Register home of ${path.posix.basename(ORPHAN_DOC)}.\n`,
  );
  assert.deepEqual(errors, [], report(errors));
});

test("M18f FINDING-VISIBLE: a PATH-QUALIFIED mention still registers (the `/` delimiter is not a false red)", () => {
  const errors = probeRegistration(
    `## E0-F992 — path-qualified\n\n**Status:** open · **Severity:** LOW\n\n` + `See \`${ORPHAN_DOC}\`.\n`,
  );
  assert.ok(!hasError(errors, ORPHAN_ERROR), report(errors));
});

test("M18 FINDING-VISIBLE: removing E8-F011's reference re-orphans the retention document", () => {
  const input = baseInput();
  for (const doc of input.findingDocuments) {
    if (doc.path.endsWith("/findings.md")) {
      doc.text = doc.text.split("FINDING-retention-authority-and-DE-11.md").join("REDACTED");
    }
  }
  const { errors } = evaluateAuditDebt(input);
  assert.ok(hasError(errors, "docs/replatform/FINDING-retention-authority-and-DE-11.md"), report(errors));
});

// --- FAIL-CLOSED ------------------------------------------------------------------------

test("M19 collect(): an absent audit-debt manifest FAILS rather than reading as an empty allow-list", () => {
  assert.throws(
    () => collect(path.join(REPO_ROOT, "scripts")),
    (e) => e instanceof Error && (e.message.includes(AUDIT_DEBT_JSON) || e.message.includes(THREAT_CONTROLS_JSON)),
  );
});
