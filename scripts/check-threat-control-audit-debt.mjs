#!/usr/bin/env node
/**
 * check-threat-control-audit-debt.mjs — W20.
 *
 * A CHECK THAT NOTHING RUNS IS NOT A CHECK. A REGISTER NOTHING COUNTS IS NOT A REGISTER.
 *
 * `docs/architecture/distributed-execution-threat-controls.json` holds thirty trust-boundary
 * crossings, every one of them Critical or High. Two existing guards touch it and NEITHER
 * could see the debt sitting in it:
 *
 *   - `scripts/check-distributed-execution-foundation.mjs` validates the SHAPE of
 *     `deliveryStatus` (known value, evidence present, findings cited, no `delivered` claim
 *     a live finding contradicts). It imposes NO CAP, NO DEADLINE AND NO COUNT on
 *     `unaudited`. Twenty-eight Critical/High controls sat unaudited with policy green.
 *   - `scripts/check-finding-ownership.mjs` globs only `docs/replatform/epics/<epic>/findings.md`
 *     (`findRegisters`, :29-37). A top-level `docs/replatform/FINDING-*.md` is outside that
 *     glob, so a committed hand audit could never print as unowned. One did: the retention
 *     audit of DE-11 concluded all four of that crossing's controls were absent while the
 *     register row said, in those words, "no delivery audit has been performed for this
 *     crossing". Two committed records of one crossing said opposite things and nothing
 *     anywhere asked.
 *
 * This guard gives noticing a consequence, in five clauses. Every one of them is a
 * COUNTING or CROSS-REFERENCE rule over committed text. NOTHING HERE READS A TEST, RUNS A
 * CONTROL, OR ESTABLISHES THAT ANY `delivered` OR `partial` CLAIM IS TRUE. A green run here
 * means the debt is declared and is not growing. It does NOT mean the controls hold, and a
 * future unit must not cite this guard as evidence that any of them do.
 *
 *   RATCHET-PIN       the number of Critical/High crossings that are `unaudited` must EQUAL
 *                     the pin in distributed-execution-audit-debt.json. Over the pin (a new
 *                     unaudited row, or a regression) reds; UNDER it also reds, so auditing
 *                     a crossing forces the pin down in the same commit. Exact-pin, not
 *                     slack-ceiling: a ceiling with slack silently absorbs a regression.
 *   AUDITED-FLOOR     a crossing recorded as audited may never return to `unaudited`. That
 *                     direction discards a recorded measurement. The floor must EXIST and
 *                     must contain EVERY audited crossing — see `checkFloor` for why an
 *                     iterate-the-floor version failed open in exactly this direction.
 *   DELIVERED-FLOOR   a crossing recorded `delivered` must still be `delivered`. This is the
 *                     "a delivered row regressing" arm, pinned as a SET so the error names
 *                     which row moved. Same existence and exhaustiveness rules.
 *   OWNER-EXISTS      a crossing that is not `delivered` must name at least one ownerTicket
 *                     with a file on disk, or carry a declared deferral with a reason. An
 *                     audit route that terminates nowhere is declared debt, never silence.
 *   FINDING-VISIBLE   (the DE-11 shape) a crossing named by a committed finding document may
 *                     not be `unaudited`; and every top-level `FINDING-*.md` must be named by
 *                     an OPEN, PARSED finding entry in an epic register, so the ownership
 *                     census can reach it. Prose, or a closed finding, does not count.
 *
 * Usage:
 *   node scripts/check-threat-control-audit-debt.mjs
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { classifyStatus, parseFindingBlocks } from "./lib/finding-ownership.mjs";

export const THREAT_CONTROLS_JSON = "docs/architecture/distributed-execution-threat-controls.json";
export const AUDIT_DEBT_JSON = "docs/architecture/distributed-execution-audit-debt.json";
export const EPICS_RELATIVE_PATH = "docs/replatform/epics";
export const REPLATFORM_RELATIVE_PATH = "docs/replatform";

/** The severities this guard counts. Medium/Low crossings exist in the schema's vocabulary
 * but none are present today; if one is added it is deliberately NOT ratcheted here. */
export const RATCHETED_SEVERITIES = new Set(["Critical", "High"]);

/** The one status that means "nobody has looked". */
export const UNAUDITED = "unaudited";

/**
 * A crossing id as a literal token in finding prose.
 *
 * ★ RANGE SPANS ARE STRIPPED FIRST, and this is a real correction rather than a
 * convenience. `E0-F008` contains the phrase "the DE-01...DE-30 register ID set" — a name
 * for the WHOLE SET, not a claim about DE-01 or DE-30. Tokenising it naively made the
 * FINDING-VISIBLE clause implicate two crossings on a sentence that says nothing about
 * either, which is a false positive of exactly the kind that gets a guard switched off.
 * The strip is deliberately narrow: only `DE-n <span punctuation> DE-m`, nothing else.
 */
export const CROSSING_ID_RE = /\bDE-\d+\b/g;
const CROSSING_RANGE_RE = /\bDE-\d+\s*(?:\.\.\.|\.\.|…|—|–|-{1,2}|to)\s*DE-\d+\b/g;

/** @returns {string[]} crossing ids named by `text`, range spans excluded. */
export function crossingIdsNamedBy(text) {
  if (typeof text !== "string") return [];
  return [...new Set(text.replace(CROSSING_RANGE_RE, " ").match(CROSSING_ID_RE) ?? [])];
}

/** A character that can sit INSIDE a filename token, so a match touching one is part of a longer name. */
const NAME_CHAR = /[A-Za-z0-9._-]/;
const WORD_CHAR = /[A-Za-z0-9_-]/;
const ALNUM = /[A-Za-z0-9]/;

/**
 * Does `text` name `basename` as a WHOLE filename or path token?
 *
 * ★★ W22B — `text.includes(basename)` was still a substring test one layer down. With two
 * top-level documents whose names overlap, an open finding naming only the LONGER
 * (`FINDING-other-FINDING-probe.md`) also satisfied the shorter (`FINDING-probe.md`), leaving
 * the shorter document exactly as invisible to the ownership census as an unregistered one —
 * the failure this clause exists to close.
 *
 * The two ends are NOT symmetric, and conflating them is how the first attempt at this fix
 * red-lit a real registration. A path prefix (`docs/replatform/FINDING-probe.md`) is a
 * legitimate mention, so `/` delimits on the left while `.`/`-` do not. On the right the
 * common case is ordinary prose — "See FINDING-probe.md." — so a SENTENCE-ENDING period must
 * delimit, while an extension-continuing one (`FINDING-probe.md.bak`) must not.
 *
 * @param {unknown} text
 * @param {string} basename
 * @returns {boolean}
 */
export function namesFileToken(text, basename) {
  if (typeof text !== "string" || typeof basename !== "string" || basename.length === 0) return false;
  for (let from = 0; ; ) {
    const at = text.indexOf(basename, from);
    if (at === -1) return false;
    const end = at + basename.length;
    const before = at > 0 ? text[at - 1] : "";
    const after = end < text.length ? text[end] : "";
    const afterNext = end + 1 < text.length ? text[end + 1] : "";
    const leftDelimited = !NAME_CHAR.test(before);
    const rightDelimited = !WORD_CHAR.test(after) && !(after === "." && ALNUM.test(afterNext));
    if (leftDelimited && rightDelimited) return true;
    from = at + 1;
  }
}

/** Every `findings.md` under the epic tree — the same notion `check-finding-ownership.mjs` uses. */
export function findEpicRegisters(root) {
  const epics = path.join(root, EPICS_RELATIVE_PATH);
  if (!existsSync(epics)) return [];
  return readdirSync(epics, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => `${EPICS_RELATIVE_PATH}/${e.name}/findings.md`)
    .filter((rel) => existsSync(path.join(root, rel)))
    .sort();
}

/** Top-level `docs/replatform/FINDING-*.md` — the documents no register glob reaches. */
export function findTopLevelFindingDocs(root) {
  const dir = path.join(root, REPLATFORM_RELATIVE_PATH);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && /^FINDING-.+\.md$/.test(e.name))
    .map((e) => `${REPLATFORM_RELATIVE_PATH}/${e.name}`)
    .sort();
}

/** Ticket ids with at least one file on disk — the same notion `check-ticket-graph-coverage.mjs`
 * and `check-finding-ownership.mjs` use, so the three guards cannot disagree about what a
 * ticket existing means. */
export function findTicketIds(root) {
  const epics = path.join(root, EPICS_RELATIVE_PATH);
  if (!existsSync(epics)) return [];
  const ids = new Set();
  for (const epic of readdirSync(epics, { withFileTypes: true })) {
    if (!epic.isDirectory()) continue;
    const dir = path.join(epics, epic.name, "tickets");
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      const m = /^([A-Z]+-\d+)/.exec(file);
      if (m) ids.add(m[1]);
    }
  }
  return [...ids].sort();
}

/** Read the tree into the pure evaluator's input shape. Throws (fail-closed) on an absent or
 * unparseable register or manifest — an absent manifest must never read as an empty
 * allow-list. */
export function collect(root) {
  const readJson = (rel) => {
    const abs = path.join(root, rel);
    if (!existsSync(abs)) throw new Error(`${rel} is missing (an absent manifest is a FAIL, not an empty allow-list)`);
    return JSON.parse(readFileSync(abs, "utf8"));
  };

  const findingDocuments = [];
  for (const rel of [...findEpicRegisters(root), ...findTopLevelFindingDocs(root)]) {
    findingDocuments.push({ path: rel, text: readFileSync(path.join(root, rel), "utf8") });
  }

  return {
    crossings: readJson(THREAT_CONTROLS_JSON).crossings ?? [],
    debt: readJson(AUDIT_DEBT_JSON),
    ticketIds: findTicketIds(root),
    findingDocuments,
    epicRegisterPaths: findEpicRegisters(root),
    topLevelFindingDocPaths: findTopLevelFindingDocs(root),
  };
}

/**
 * One floor arm: EXISTS, is EXHAUSTIVE, names only real crossings, and none of its members
 * has moved in the forbidden direction.
 *
 * ★★★ W22 — THE ARM FAILED OPEN IN THE EXACT DIRECTION IT EXISTS TO PREVENT, and it had
 * already been mutation-tested. The mutation used a crossing that WAS in the floor, so it
 * exercised the one path that worked. Two holes, both found by external review:
 *
 *   (a) NOT EXHAUSTIVE. The loop iterated the floor, so it could only ever speak about ids
 *       the floor already contained. Audit a crossing, lower the pin, and simply OMIT it
 *       from `auditedFloor`: every clause passes. A later commit then returns THAT crossing
 *       to `unaudited` while auditing a different one — the pin's count is preserved, the
 *       floor is untouched, and a recorded measurement has been discarded with policy green.
 *       The floor advertised "a recorded measurement may not be discarded" and did not
 *       deliver it. The fix inverts the direction of the check: the EXPECTED set is derived
 *       from the register, and the floor must contain all of it. A measurement is therefore
 *       enrolled the moment it is recorded, not when someone remembers to enrol it.
 *   (b) `?? []` MEANT DELETING THE WHOLE SECTION PASSED. Zero iterations, zero errors — the
 *       "a check that nothing runs is not a check" shape, inside a guard whose own header
 *       names that failure class. An absent floor now FAILS, matching `collect`'s stated
 *       fail-closed posture for an absent manifest one level up.
 *
 * When the section itself is unreadable the membership and exhaustiveness passes are SKIPPED
 * rather than run against an empty set: thirty derivative errors would bury the one that
 * says what actually happened.
 */
function checkFloor({ errors, byId, section, floor, expectedIds, expectedWhy, regressed, regressionMessage }) {
  const ids = floor == null ? undefined : floor.ids;
  if (floor == null || typeof floor !== "object" || Array.isArray(floor) || !Array.isArray(ids)) {
    errors.push(
      `${AUDIT_DEBT_JSON}: ${section} is missing or is not an object with an "ids" array. ` +
        "An absent floor is a FAIL, not an empty allow-list: deleting the section would otherwise retire " +
        "this arm with zero iterations and zero errors, which is the failure class this guard exists to catch.",
    );
    return;
  }

  const recorded = new Set(ids);
  for (const id of ids) {
    const crossing = byId.get(id);
    if (!crossing) {
      errors.push(`${AUDIT_DEBT_JSON}: ${section} names ${id}, which is not a crossing in ${THREAT_CONTROLS_JSON}`);
      continue;
    }
    if (regressed(crossing)) errors.push(regressionMessage(id, crossing));
  }

  for (const id of expectedIds) {
    if (recorded.has(id)) continue;
    errors.push(
      `${AUDIT_DEBT_JSON}: ${section} is INCOMPLETE — crossing ${id} ${expectedWhy(byId.get(id))} in ` +
        `${THREAT_CONTROLS_JSON} but is absent from ${section}. The floor must name EVERY such crossing in the ` +
        "SAME commit that records it; a measurement enrolled nowhere can be discarded later while the pin's " +
        "count stays constant, and nothing would notice.",
    );
  }
}

/**
 * The whole verdict, as a pure function of already-read text.
 * @returns {{errors: string[], notes: string[]}}
 */
export function evaluateAuditDebt(input) {
  const errors = [];
  const notes = [];
  const crossings = Array.isArray(input.crossings) ? input.crossings : [];
  const debt = input.debt ?? {};
  const byId = new Map(crossings.map((c) => [c?.id, c]));
  const ticketIds = new Set(input.ticketIds ?? []);

  // --- RATCHET-PIN ---------------------------------------------------------------------
  const ratcheted = crossings.filter((c) => RATCHETED_SEVERITIES.has(c?.severity));
  const unauditedIds = ratcheted.filter((c) => c?.deliveryStatus === UNAUDITED).map((c) => c.id).sort();
  const pin = debt?.ceilings?.unauditedCriticalHigh;
  if (!Number.isInteger(pin) || pin < 0) {
    errors.push(
      `${AUDIT_DEBT_JSON}: ceilings.unauditedCriticalHigh must be a non-negative integer (got ${JSON.stringify(pin)})`,
    );
  } else if (unauditedIds.length > pin) {
    errors.push(
      `${THREAT_CONTROLS_JSON}: ${unauditedIds.length} Critical/High crossings are "${UNAUDITED}" but the pin in ${AUDIT_DEBT_JSON} is ${pin}. ` +
        `The pin may only go DOWN. Over-pin crossings: ${unauditedIds.join(", ")}`,
    );
  } else if (unauditedIds.length < pin) {
    errors.push(
      `${THREAT_CONTROLS_JSON}: only ${unauditedIds.length} Critical/High crossings are "${UNAUDITED}" but the pin in ${AUDIT_DEBT_JSON} is still ${pin}. ` +
        `Lower ceilings.unauditedCriticalHigh to ${unauditedIds.length} in THIS commit — a pin with slack silently absorbs the next regression.`,
    );
  } else {
    notes.push(`audit debt: ${unauditedIds.length} of ${ratcheted.length} Critical/High crossings are still "${UNAUDITED}" (pinned).`);
  }

  // --- AUDITED-FLOOR -------------------------------------------------------------------
  const auditedIds = crossings
    .filter((c) => c?.id != null && c.deliveryStatus != null && c.deliveryStatus !== UNAUDITED)
    .map((c) => c.id);
  checkFloor({
    errors,
    byId,
    section: "auditedFloor",
    floor: debt?.auditedFloor,
    expectedIds: auditedIds,
    expectedWhy: (crossing) => `is "${crossing.deliveryStatus}" — i.e. it HAS been audited`,
    regressed: (crossing) => crossing.deliveryStatus === UNAUDITED,
    regressionMessage: (id) =>
      `${THREAT_CONTROLS_JSON}: crossing ${id} is recorded in auditedFloor but has regressed to "${UNAUDITED}"; ` +
      "a recorded measurement may not be discarded",
  });

  // --- DELIVERED-FLOOR -----------------------------------------------------------------
  const deliveredIds = crossings.filter((c) => c?.id != null && c.deliveryStatus === "delivered").map((c) => c.id);
  checkFloor({
    errors,
    byId,
    section: "deliveredFloor",
    floor: debt?.deliveredFloor,
    expectedIds: deliveredIds,
    expectedWhy: () => 'is "delivered"',
    regressed: (crossing) => crossing.deliveryStatus !== "delivered",
    regressionMessage: (id, crossing) =>
      `${THREAT_CONTROLS_JSON}: crossing ${id} is recorded in deliveredFloor but is now "${crossing.deliveryStatus}"; ` +
      "a delivered control may not silently regress",
  });

  // --- OWNER-EXISTS --------------------------------------------------------------------
  const deferrals = debt?.ownerTicketDeferrals ?? {};
  const deferredIds = Object.keys(deferrals).filter((k) => !k.startsWith("$"));
  for (const crossing of crossings) {
    if (!crossing || crossing.deliveryStatus === "delivered") continue;
    const owners = Array.isArray(crossing.ownerTickets) ? crossing.ownerTickets : [];
    const onDisk = owners.filter((t) => ticketIds.has(t));
    if (onDisk.length > 0) continue;
    const deferral = deferrals[crossing.id];
    if (deferral == null || typeof deferral.reason !== "string" || deferral.reason.trim() === "") {
      errors.push(
        `${THREAT_CONTROLS_JSON}: crossing ${crossing.id} is "${crossing.deliveryStatus}" and names no ownerTicket with a file on disk ` +
          `(ownerTickets: ${owners.length > 0 ? owners.join(", ") : "none"}); its audit route terminates nowhere. ` +
          `Give it an owner, or declare the debt in ${AUDIT_DEBT_JSON} ownerTicketDeferrals with a reason.`,
      );
    }
  }
  for (const id of deferredIds) {
    const crossing = byId.get(id);
    if (!crossing) {
      errors.push(`${AUDIT_DEBT_JSON}: ownerTicketDeferrals names ${id}, which is not a crossing in ${THREAT_CONTROLS_JSON} (a ghost deferral)`);
      continue;
    }
    const owners = Array.isArray(crossing.ownerTickets) ? crossing.ownerTickets : [];
    if (owners.some((t) => ticketIds.has(t))) {
      errors.push(
        `${AUDIT_DEBT_JSON}: the ownerTicketDeferrals entry for ${id} is STALE — ` +
          `${owners.filter((t) => ticketIds.has(t)).join(", ")} now has a file on disk. Remove the entry in the landing commit.`,
      );
    }
  }

  // --- FINDING-VISIBLE -----------------------------------------------------------------
  // (a) The DE-11 shape: a crossing a committed finding document is about may not claim
  //     that nobody has looked at it.
  const namedBy = new Map();
  for (const doc of input.findingDocuments ?? []) {
    for (const id of crossingIdsNamedBy(doc.text)) {
      if (!namedBy.has(id)) namedBy.set(id, new Set());
      namedBy.get(id).add(doc.path);
    }
  }
  for (const [id, docs] of [...namedBy.entries()].sort()) {
    const crossing = byId.get(id);
    if (!crossing || crossing.deliveryStatus !== UNAUDITED) continue;
    errors.push(
      `${THREAT_CONTROLS_JSON}: crossing ${id} is "${UNAUDITED}" — i.e. it asserts nobody has looked — while committed finding ` +
        `document(s) ${[...docs].sort().join(", ")} are about that crossing. A register may not claim no delivery audit has ` +
        "been performed over the top of an audit that was performed and written down.",
    );
  }
  // (b) A top-level FINDING-*.md that no epic register names can never print as unowned,
  //     because check-finding-ownership.mjs cannot see it. Make that structurally impossible.
  //
  // ★★ W22 — THIS WAS A RAW SUBSTRING CHECK OVER EVERY REGISTER'S CONCATENATED TEXT, and it
  // therefore reported a protection it did not provide. The filename appearing in ordinary
  // prose, inside a CLOSED finding, or inside a sentence saying the document is NOT
  // registered, all satisfied it — while the document stayed exactly as structurally
  // invisible to `check-finding-ownership.mjs` as before, because that census reasons about
  // OPEN, PARSED findings and about nothing else. The bar must therefore be the same object
  // the census reads: an OPEN finding entry whose own block names the file. The parse is
  // `finding-ownership.mjs`'s own (`parseFindingBlocks` + `classifyStatus`), not a second
  // one written here — two parsers disagreeing about what a finding IS is the failure this
  // repo has already paid for twice.
  const openFindingBlocks = (input.findingDocuments ?? [])
    .filter((d) => d.path.endsWith("/findings.md"))
    .flatMap((d) => parseFindingBlocks(d.text).map((f) => ({ ...f, register: d.path })))
    .filter((f) => classifyStatus(f.status) === "open");
  for (const rel of input.topLevelFindingDocPaths ?? []) {
    const basename = path.posix.basename(rel);
    if (!openFindingBlocks.some((f) => namesFileToken(f.text, basename))) {
      errors.push(
        `${rel}: a top-level FINDING document is named by no OPEN finding entry in any epic findings register, so ` +
          "scripts/check-finding-ownership.mjs (which globs only docs/replatform/epics/*/findings.md and reasons only " +
          "about open findings) can never see it and it can never print as unowned. A mention in prose, or inside a " +
          "finding that is already resolved, does not carry the document into the ownership census. File an OPEN " +
          "finding in the owning epic's register that names this document by filename.",
      );
    }
  }

  return { errors, notes };
}

function main() {
  const root = process.cwd();
  let result;
  try {
    result = evaluateAuditDebt(collect(root));
  } catch (error) {
    console.error(`threat-control audit debt: FAIL\n  ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
    return;
  }
  for (const note of result.notes) console.log(`  ${note}`);
  if (result.errors.length > 0) {
    console.error("threat-control audit debt: FAIL");
    for (const e of result.errors) console.error(`  - ${e}`);
    process.exit(1);
    return;
  }
  console.log("threat-control audit debt: PASS");
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("check-threat-control-audit-debt.mjs")) {
  main();
}
