// Every OPEN finding must name who owns it — or say, on the record, that nobody does.
//
// ★ WHY THIS EXISTS. This programme has now had four blockers reach the top of the
// critical path unscheduled: deferral #1 (a worker receives no provider credential),
// E4-D12 (the worker does not dispatch at all), the missing composition root, and E4-F007
// (a worker cannot stay authorised past 15 minutes). THREE OF THE FOUR WERE ALREADY
// WRITTEN DOWN — E4-F007 sat in `findings.md` at severity HIGH with `Status: open`, and
// DSK-001's risk register recommended filing its successor "now, before DSK-003 is
// planned". DSK-003 shipped. It never was.
//
// So the failure is not that nobody noticed. It is that NOTICING HAD NO CONSEQUENCE.
// `check-ticket-graph-coverage.mjs` already fails when a ticket FILE has no node in the
// plan; nothing failed when an open finding had no ticket at all — the same hole, one
// register over. A finding with no ticket is indistinguishable from a finding nobody had.
//
// ★ WHY IT IS DECLARATION-BASED. The tempting version infers ownership by scanning ticket
// prose for the finding id. That inference was tried in this repo for a neighbouring guard
// and was WRONG FIVE TIMES IN BOTH DIRECTIONS — a mention in a comment read as ownership,
// and real ownership expressed in different words read as absence. So the hard direction
// (does anyone own this?) is answered by a human writing it down, and the machine verifies
// only the cheap direction: that the entry exists, is well-formed, and — when it claims a
// ticket — that the ticket actually exists on disk.
//
// That last check is the one that matters most. A FALSE CLAIM OF OWNERSHIP is worse than
// no claim, because it converts an open question into a settled one for every later reader.
//
// Pure. The caller supplies the parsed findings, the manifest, and the ticket ids.

/**
 * owned    — a ticket owns this finding. `ticket` must name a ticket whose file exists.
 * unowned  — nobody owns it yet, and that is acknowledged rather than hidden. `reason`
 *            must say what is blocked and what the decision is waiting on.
 * accepted — it will not be fixed (typically a nit). `reason` must say why that is fine.
 */
export const FINDING_OWNERSHIP_STATUSES = Object.freeze(["owned", "unowned", "accepted"]);

/** A ticket that already has a result doc has SHIPPED. Declaring a still-open finding as
 * owned by completed work is the same false-claim failure as naming a ticket that does not
 * exist, and it is the exact shape five findings in this repo are already in: E6-F003
 * (HIGH) says "resolve at DEP-000" and DEP-000 shipped; E6-F008 says "resolve before
 * CLI-001/D2" and CLI-001 shipped. They were carried past their own resolution point and
 * nothing noticed, because nothing was looking. */

/**
 * The severity vocabulary this programme's registers ACTUALLY use, and whether each value
 * is gate-blocking. Measured across all 9 registers (108 findings) on 2026-09-03:
 *
 *   P1=29  HIGH=26  MEDIUM=15  LOW=11  MED=11  MINOR=8  P2=3  P0=1
 *
 * Two scales coexist deliberately — E3 and its neighbours use a P0/P1/P2 STOP scale, the
 * rest use HIGH/MEDIUM/LOW — and `MED`/`MEDIUM` and `LOW`/`MINOR` are the same rung spelled
 * two ways. They are NOT normalised in the registers: rewriting 108 severity values across
 * frozen-evidence epics would be large, risky churn to make a parser's life easier, and the
 * P-scale is real information rather than a typo. The remedy is the same one chosen for the
 * status field — READ WHAT IS ACTUALLY WRITTEN, and REFUSE what cannot be read.
 *
 * Anything outside this table is `severity_unknown_vocabulary`: a fourth spelling must be
 * added here deliberately, by a human, rather than silently degrading to UNKNOWN and taking
 * the HIGH-may-never-be-accepted rule down with it.
 */
export const SEVERITY_VOCABULARY = Object.freeze({
  CRITICAL: { blocking: true },
  P0: { blocking: true },
  HIGH: { blocking: true },
  P1: { blocking: true },
  MEDIUM: { blocking: false },
  MED: { blocking: false },
  P2: { blocking: false },
  LOW: { blocking: false },
  MINOR: { blocking: false },
});

/** Severities that may NOT be `accepted`. Waving away a HIGH is exactly the move this
 * guard exists to make impossible to do quietly — it must be `owned`, or `unowned` with a
 * reason someone can read and argue with.
 *
 * ★ DERIVED from the vocabulary rather than hand-listed. The hand-listed version was
 * `["HIGH", "CRITICAL"]`, which silently omitted the ENTIRE P-scale — so even once the
 * severity regex is fixed, 30 of the 108 findings (P0 + P1) could still have been quietly
 * `accepted`. Deriving it means adding a blocking spelling to the table above cannot leave
 * this list behind. */
const NOT_ACCEPTABLE = Object.freeze(
  Object.keys(SEVERITY_VOCABULARY).filter((k) => SEVERITY_VOCABULARY[k].blocking),
);

/** The status value a finding gets when no `Status:` field could be read from its block.
 * It is a HARD FAILURE, not a shrug — see `unparseable_status` below. */
export const UNPARSEABLE_STATUS = "unknown";

/**
 * ★★★ FAIL CLOSED ON EVERY UNRECOGNISED STATUS, NOT JUST THE ABSENT ONE.
 *
 * The first version of the fail-closed arm caught only the synthetic `"unknown"` — the value
 * the parser invents when no `Status:` field exists at all. A TYPO sailed straight through:
 * `**Status:** opne` parses to `"opne"`, is not `"open"`, matches no manifest entry, and so
 * exits 0. **That recreates, inside the fix, the exact blind spot the fix exists to remove.**
 * Found by external review; reproduced before fixing.
 *
 * A flat closed enum would be the wrong shape here — measured, the corpus already uses
 * FIFTEEN distinct statuses, several of them one-offs like
 * `resolved_in_fix_round_2_red_pending_final_review`. Requiring a table edit for every new
 * bespoke resolution wording is the cry-wolf failure that gets a guard switched off.
 *
 * So: `open` must be spelled EXACTLY (no family, so every misspelling of it — `opne`,
 * `oepn`, `opne_` — is rejected rather than silently read as closed, which is the one
 * direction that actually loses a finding), a small set of exact non-open statuses is
 * listed, and two FAMILIES (`resolved*`, `superseded*`) absorb the open-ended resolution
 * wordings. Anything else is `unknown_status_vocabulary`.
 *
 * ★ SCOPE NOTE, deliberately conservative: this changes NO finding's open/closed
 * classification. `needs_changes` (6 findings, all in E3) is recorded here as non-open
 * because that is how the guard has always treated it — NOT because that is settled. If it
 * should count as open, that is a real decision with real consequences (six findings would
 * need declarations) and it belongs to a human, not to a parser change smuggling it in.
 */
export const NON_OPEN_STATUS_FAMILIES = Object.freeze(["resolved", "superseded"]);
export const EXACT_NON_OPEN_STATUSES = Object.freeze([
  "needs_changes",
  "approved_pending_job",
  "partially_resolved_in_job",
  "fixed",
]);

/** Statuses that MEAN open. Deliberately just `open`.
 *
 * ★ `needs_changes` was briefly moved here and the operator ruled against it. The reasoning
 * that made it tempting — "a review refused the work, so it is not resolved" — is sound in
 * the abstract and wrong for this corpus: all six findings carrying it (E3-F028..F033) are
 * genuinely RESOLVED, per the `E3-F028–E3-F033` roll-up and JOB-003's `complete` result
 * ledger. Their per-finding `Status:` lines were simply never amended. Reclassifying the
 * status would have manufactured six phantom open findings — including a P0 STOP — out of a
 * documentation lag. The lag is fixed in the register instead, where it belongs. */
export const EXACT_OPEN_STATUSES = Object.freeze(["open"]);

/** @returns {"open"|"not_open"|"unrecognised"} */
export function classifyStatus(status) {
  const value = String(status ?? "").toLowerCase();
  if (EXACT_OPEN_STATUSES.includes(value)) return "open";
  if (EXACT_NON_OPEN_STATUSES.includes(value)) return "not_open";
  if (NON_OPEN_STATUS_FAMILIES.some((f) => value.startsWith(f))) return "not_open";
  return "unrecognised";
}
/** Likewise for severity: an unclassifiable finding may not be quietly `accepted`. */
export const UNPARSEABLE_SEVERITY = "UNKNOWN";

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasReason(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * @param {{
 *   findings?: Array<{id: string, status: string, severity?: string, title?: string}>,
 *   declared?: Record<string, {status: string, ticket?: string, reason?: string, ownerStillOpen?: string, successor?: string}>,
 *   ticketIds?: string[],
 *   completedTicketIds?: string[],   // tickets with a result doc — i.e. shipped
 * }} input
 * @returns {{ok: boolean, problems: Array<{kind: string, finding: string|null, detail?: string}>,
 *            openCount: number, unowned: string[]}}
 */
/**
 * ★★★ THE MANIFEST ITSELF IS AN UNGUARDED INPUT, AND ON 2026-09-03 THAT COST A CORRECTION.
 *
 * `check-finding-ownership.mjs` used to do `JSON.parse(readFileSync(...))` and trust the
 * result. THREE separate tracks hit merge conflicts in `finding-ownership.json` in a single
 * day — it is a one-object file every track appends to — and on one of them `git rerere`
 * silently replayed a stale resolution that produced a structurally invalid entry WITH A
 * DUPLICATED `reason` KEY. **The `git add` ran anyway**, because nothing validated the file
 * on the way in.
 *
 * ★ THE DISTINCTION THAT MAKES THIS WORTH A GUARD. A conflict in a GUARDED field fails
 * LOUDLY: drop an ownership entry and the finding is undeclared, so the guard reports it on
 * the next run. A conflict inside FREE TEXT fails SILENTLY — the stale replay reverted a
 * corrected source citation inside a `reason` string, and every guard stayed green, because
 * no guard reads those strings for anything. This closes the silent half.
 *
 * ★★ AND A PARSE ALONE DOES NOT CATCH IT. `JSON.parse` accepts duplicate keys and keeps the
 * LAST one, so the corrupted manifest parsed cleanly and the losing `reason` — the corrected
 * one — vanished with no error anywhere. The duplicate must therefore be looked for in the
 * RAW TEXT, which is the only place both copies still exist.
 *
 * @param {string} text raw file contents
 * @returns {{ok: true, findings: Record<string, object>}
 *          | {ok: false, kind: "manifest_unparseable"|"manifest_duplicate_key"|"manifest_shape", detail: string}}
 */
export function parseOwnershipManifest(text) {
  if (typeof text !== "string") {
    return { ok: false, kind: "manifest_shape", detail: "manifest contents were not a string" };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    // REFUSE, rather than crashing with a bare SyntaxError stack. A guard that dies with an
    // unattributed exception is indistinguishable from a broken guard, and the difference
    // matters: one is "fix your manifest", the other is "ignore this, tooling is flaky".
    return { ok: false, kind: "manifest_unparseable", detail: String(error?.message ?? error) };
  }
  // Only well-formed JSON reaches the duplicate scan, so the scanner may assume valid syntax.
  const duplicates = findDuplicateJsonKeys(text);
  if (duplicates.length > 0) {
    return {
      ok: false,
      kind: "manifest_duplicate_key",
      detail: duplicates.map((d) => `${d.path} (repeated ${d.count} times)`).join(", "),
    };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, kind: "manifest_shape", detail: "top level is not a JSON object" };
  }
  if (!isPlainObject(parsed.findings)) {
    return {
      ok: false,
      kind: "manifest_shape",
      detail: parsed.findings === undefined
        ? "no `findings` object — a manifest that lost its only key would otherwise report EVERY finding as undeclared, which reads like a register problem rather than a file problem"
        : "`findings` is present but is not a JSON object",
    };
  }
  for (const [id, entry] of Object.entries(parsed.findings)) {
    if (!isPlainObject(entry)) {
      return { ok: false, kind: "manifest_shape", detail: `findings.${id} is not a JSON object` };
    }
  }
  return { ok: true, findings: parsed.findings };
}

/**
 * Every duplicated key in a JSON document, by path, found in the RAW TEXT.
 *
 * Deliberately a scanner and not a regex: `"reason": "... \"ticket\": ..."` puts key-shaped
 * text inside a string value, and a regex cannot tell the two apart. These manifests are
 * almost entirely long prose `reason` strings, so that is the common case, not a corner one.
 *
 * @param {string} text syntactically valid JSON
 * @returns {Array<{path: string, count: number}>}
 */
export function findDuplicateJsonKeys(text) {
  const tokens = tokenizeJson(text);
  /** @type {Array<{isObject: boolean, seen: Map<string, number>, key: string|null, index: number}>} */
  const stack = [];
  const duplicates = new Map();

  const currentPath = () => {
    const parts = [];
    for (const frame of stack) {
      if (frame.isObject) {
        if (frame.key !== null) parts.push(frame.key);
      } else {
        parts.push(`[${frame.index}]`);
      }
    }
    return parts.length > 0 ? parts.join(".") : "(root)";
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type === "{") {
      stack.push({ isObject: true, seen: new Map(), key: null, index: 0 });
      continue;
    }
    if (token.type === "[") {
      stack.push({ isObject: false, seen: new Map(), key: null, index: 0 });
      continue;
    }
    if (token.type === "}" || token.type === "]") {
      stack.pop();
      continue;
    }
    if (token.type === "," ) {
      const frame = stack[stack.length - 1];
      if (frame && !frame.isObject) frame.index += 1;
      continue;
    }
    if (token.type !== "string") continue;
    const frame = stack[stack.length - 1];
    // A string is a KEY only when it sits directly in an object and is followed by a colon.
    if (!frame || !frame.isObject || tokens[i + 1]?.type !== ":") continue;
    const name = token.raw;
    const seen = (frame.seen.get(name) ?? 0) + 1;
    frame.seen.set(name, seen);
    frame.key = name;
    if (seen > 1) duplicates.set(currentPath(), seen);
  }

  return [...duplicates].map(([path, count]) => ({ path, count }));
}

const JSON_PUNCTUATION = new Set(["{", "}", "[", "]", ":", ","]);
const JSON_WHITESPACE = new Set([" ", "\n", "\r", "\t"]);

/** Minimal JSON tokenizer. Values other than strings are not interpreted — only their extent
 * matters, because the only thing being looked for is which strings are keys. */
function tokenizeJson(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (JSON_WHITESPACE.has(ch)) { i += 1; continue; }
    if (JSON_PUNCTUATION.has(ch)) { tokens.push({ type: ch }); i += 1; continue; }
    if (ch === '"') {
      let j = i + 1;
      let raw = "";
      while (j < text.length && text[j] !== '"') {
        if (text[j] === "\\") { raw += text[j] + (text[j + 1] ?? ""); j += 2; continue; }
        raw += text[j];
        j += 1;
      }
      tokens.push({ type: "string", raw });
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < text.length && !JSON_WHITESPACE.has(text[j]) && !JSON_PUNCTUATION.has(text[j])) j += 1;
    tokens.push({ type: "literal" });
    i = j > i ? j : i + 1;
  }
  return tokens;
}

export function evaluateFindingOwnership(input) {
  const problems = [];
  if (!isPlainObject(input)) {
    return { ok: false, problems: [{ kind: "malformed_input", finding: null }], openCount: 0, unowned: [] };
  }
  const { findings, declared, ticketIds } = input;
  if (!Array.isArray(findings) || !isPlainObject(declared)) {
    return { ok: false, problems: [{ kind: "malformed_input", finding: null }], openCount: 0, unowned: [] };
  }
  const tickets = new Set(Array.isArray(ticketIds) ? ticketIds : []);
  const completed = new Set(Array.isArray(input.completedTicketIds) ? input.completedTicketIds : []);

  // ★★★ FAIL CLOSED ON AN UNREADABLE STATUS. This arm is the fix for the guard's own
  // worst failure class, found INSIDE the guard that exists to catch it.
  //
  // Until 2026-09-03 a finding whose `Status:` could not be parsed was silently treated as
  // NOT OPEN, and the E0, E1 and E2 registers write their status in shapes the parser did
  // not read — or, for 25 of their 34 findings, do not write one at all. So all three
  // registers were INVISIBLE. Measured by positive control: a synthetic HIGH, gate-blocking,
  // undeclared finding appended to `E0-foundation/findings.md` in E0's OWN documented house
  // style (`- **Severity:** / - **Blocks gate:** / - **Disposition:**`) left
  // `node scripts/check-finding-ownership.mjs` reporting `OK (17 open ...)` and exiting 0.
  // The same finding with a `**Status:**` line correctly failed `undeclared_finding`.
  //
  // The old behaviour was a deliberate choice with a stated rationale — "guessing would make
  // the guard noisy, and a noisy guard gets switched off". That rationale is sound about
  // GUESSING and wrong about SILENCE: the third option, refusing to proceed until a human
  // writes the field, is neither noisy nor a guess. It is also the only version that cannot
  // rot, because a register that drifts back to the old style now fails on the next PR
  // rather than going quiet again.
  //
  // A FALSE CLAIM OF ENFORCEMENT IS WORSE THAN A MISSING CHECK: for 108 findings across 9
  // registers this guard reported a confident `OK` while reading the status of only 73.
  for (const finding of [...findings].filter((f) => isPlainObject(f))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    if (finding.status === UNPARSEABLE_STATUS) {
      problems.push({ kind: "unparseable_status", finding: finding.id, detail: finding.register });
    } else if (classifyStatus(finding.status) === "unrecognised") {
      // A TYPO is the dangerous case: `opne` is not `open`, matches no manifest entry, and
      // under the first version of this arm exited 0 — losing the finding exactly as a
      // missing status line did. Catching only the absent field left the blind spot inside
      // the fix built to remove it.
      problems.push({ kind: "unknown_status_vocabulary", finding: finding.id, detail: String(finding.status) });
    }
  }

  // ★ ONE notion of "open", not two. This filter used to compare the literal string while
  // `classifyStatus` had its own opinion — two definitions of the same concept in one file,
  // which is the "two guards disagreeing about what a thing IS" class this branch already
  // fixed once between `parseFindings` and the uniqueness extractor. Now the classifier is
  // the single source, so adding a status to EXACT_OPEN_STATUSES cannot leave the filter
  // behind.
  const open = findings.filter((f) => isPlainObject(f) && classifyStatus(f.status) === "open");
  const openIds = new Set(open.map((f) => f.id));
  const unowned = [];

  // ★★ AN OPEN FINDING'S SEVERITY MUST BE READABLE AND KNOWN. The second axis of the same
  // failure, and it composes with the first: `unparseable_status` decides whether a finding
  // is VISIBLE at all; this decides whether a visible one's severity is KNOWABLE.
  //
  // Until 2026-09-03 the severity regex could not read `**Severity:** HIGH` — the bolded
  // house style — so 82 of 108 findings parsed as UNKNOWN, `String(undefined).toUpperCase()`
  // was never in NOT_ACCEPTABLE, and the rule the guard's own comment says exists "to make
  // [waving away a HIGH] impossible to do quietly" COULD NOT FIRE for any of them.
  //
  // ★ It was a DEAD LEVER, NOT A BREACH. All eight `accepted` declarations parse LOW or
  // MINOR against their register text; nobody waved away a HIGH through this hole. Said
  // explicitly because the register is exactly where an overstatement would stick.
  //
  // Scoped to OPEN findings: this guard reasons about nothing else, and four resolved
  // findings legitimately carry no readable severity. Flipping one back to open demands one.
  for (const finding of [...open].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    const severity = String(finding.severity ?? "").toUpperCase();
    if (severity === UNPARSEABLE_SEVERITY) {
      problems.push({ kind: "severity_unreadable", finding: finding.id, detail: finding.register });
    } else if (!Object.prototype.hasOwnProperty.call(SEVERITY_VOCABULARY, severity)) {
      problems.push({ kind: "severity_unknown_vocabulary", finding: finding.id, detail: severity });
    }
  }

  for (const finding of [...open].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    const entry = declared[finding.id];
    // Default-deny. A new open finding is born UNDECLARED, and undeclared fails — which is
    // the whole mechanism: the blocker announces itself the first time CI runs after it is
    // filed, rather than the day someone happens to re-read the register.
    if (!isPlainObject(entry)) {
      problems.push({ kind: "undeclared_finding", finding: finding.id, detail: finding.severity });
      continue;
    }
    if (!FINDING_OWNERSHIP_STATUSES.includes(entry.status) || !hasReason(entry.reason)) {
      problems.push({ kind: "malformed_declaration", finding: finding.id, detail: String(entry.status) });
      continue;
    }
    if (entry.status === "owned") {
      if (typeof entry.ticket !== "string" || entry.ticket.length === 0) {
        problems.push({ kind: "malformed_declaration", finding: finding.id, detail: "ticket missing" });
        continue;
      }
      // The check that stops a false claim of ownership becoming a settled fact.
      if (!tickets.has(entry.ticket)) {
        problems.push({ kind: "owner_ticket_missing", finding: finding.id, detail: entry.ticket });
        continue;
      }
      // An open finding owned by SHIPPED work is owned by nothing. This is the state five
      // findings here are already in, and the reason it went unnoticed is that the natural
      // reading of the register ("resolve at DEP-000") looks like ownership right up until
      // you check whether DEP-000 is still open.
      //
      // CALIBRATION, learned while authoring the first manifest: "has a result doc" is NOT
      // the same as "finished". WRK-008 has result docs for slices 1 and 2a while slice 2b
      // is still open, so failing outright would have produced a false positive on the very
      // first real entry — and a guard that cries wolf gets switched off, which is a worse
      // outcome than no guard. So the rule is not "you may not name a shipped ticket"; it is
      // "if you name one, say IN WRITING what part of it is still open (ownerStillOpen) AND
      // name the ticket that inherits the residual (successor)." (E4-F013.)
      //
      // ownerStillOpen is PROSE — nobody can write it honestly when the answer is "nothing".
      // successor is a CHECKABLE POINTER, held to the SAME existence bar owner_ticket_missing
      // uses: it must exist on disk, must not be the shipped owner itself (that re-opens the
      // exact hole one field over — mirrors dependency-graph.mjs's `dep === id` self-check),
      // and must not have shipped either (a shipped successor is the same hole one level down).
      // The check is EXISTENCE-ONLY: it forces a real ticket node+dep skeleton (the graph
      // guards do the rest), but it cannot verify the named ticket is the CORRECT inheritor —
      // that stays author/review responsibility.
      if (completed.has(entry.ticket)) {
        if (!hasReason(entry.ownerStillOpen)) {
          problems.push({ kind: "owner_ticket_already_complete", finding: finding.id, detail: entry.ticket });
        }
        if (!hasReason(entry.successor)) {
          problems.push({ kind: "successor_missing", finding: finding.id, detail: entry.ticket });
        } else if (entry.successor === entry.ticket) {
          problems.push({ kind: "successor_is_self", finding: finding.id, detail: entry.successor });
        } else if (!tickets.has(entry.successor)) {
          problems.push({ kind: "successor_not_on_disk", finding: finding.id, detail: entry.successor });
        } else if (completed.has(entry.successor)) {
          problems.push({ kind: "successor_already_complete", finding: finding.id, detail: entry.successor });
        }
      }
      continue;
    }
    // An unreadable or off-vocabulary severity is already reported by the pass above, for
    // EVERY open finding rather than only the accepted ones — so this arm can trust that a
    // severity reaching it is one the table knows.
    if (entry.status === "accepted" && NOT_ACCEPTABLE.includes(String(finding.severity).toUpperCase())) {
      problems.push({ kind: "severity_not_acceptable", finding: finding.id, detail: finding.severity });
      continue;
    }
    if (entry.status === "unowned") unowned.push(finding.id);
  }

  // A manifest that keeps entries for findings that are no longer open rots into a list
  // nobody trusts, and an untrusted list is the state this guard is trying to leave.
  for (const id of Object.keys(declared).sort()) {
    if (!openIds.has(id)) {
      problems.push({ kind: "stale_declaration", finding: id });
    }
  }

  return { ok: problems.length === 0, problems, openCount: open.length, unowned };
}

/**
 * The `Status:` shapes that occur in this repo's registers, in match order.
 *
 * All three are the SAME explicit field in different punctuation, so reading them is not
 * inference — it is not the ticket-prose scanning the header rejects. What is deliberately
 * NOT here is any attempt to divine open-ness from `- **Disposition:**` prose ("Open —
 * non-blocking hardening", "Resolved (items 1–3) … Item 4 remains open/optional"). That is
 * the guessing this guard's header records as having been WRONG FIVE TIMES IN BOTH
 * DIRECTIONS for a neighbouring guard. A block with no status field is a hard failure
 * instead — see `unparseable_status`.
 */
const STATUS_PATTERNS = Object.freeze([
  // `**Status:** open` · `**Status:** \`open\`` · `**Status:** **RESOLVED 2026-08-09**`
  // The bold-value form is E2-F001/002/008 and E7-F004/005/006 and E10-F002.
  /\*\*Status:\*\*\s*[`*]{0,2}\s*([A-Za-z0-9_]+)/,
  // `- **Status: RESOLVED (resolving revision \`e62921b17\`).**` — colon INSIDE the bold.
  // E1-F004/F005/F007. The old expression required the colon inside and the value outside,
  // so it read neither this nor the bold-value form above.
  /\*\*Status:\s*([A-Za-z0-9_]+)/,
]);

/** `**Severity:** HIGH` · `Severity: HIGH` · `- **Severity:** P1 STOP`.
 * The old expression (`/Severity:\s*\*{0,2}([A-Za-z]+)/`) could not read the bolded form at
 * all: after `Severity:` it consumed the closing `**` and then required a letter where a
 * SPACE stood. 82 of 108 findings — every one in E3 and E7 — parsed as UNKNOWN. */
const SEVERITY_PATTERN = /\*{0,2}Severity:\*{0,2}\s*[`*]{0,2}\s*([A-Za-z][A-Za-z0-9]*)/;

/**
 * Parse `findings.md` text into finding records, KEEPING each finding's own block text.
 *
 * Deliberately tolerant about everything except the two fields the guard reasons over.
 * A heading with no readable `Status:` yields `status: "unknown"`, which the evaluator
 * treats as a HARD FAILURE (`unparseable_status`) rather than as "not open" — the silent
 * version is what made three whole registers invisible.
 *
 * ★ WHY THE BLOCK TEXT IS EXPORTED. `check-threat-control-audit-debt.mjs`'s FINDING-VISIBLE
 * clause used to ask `epicText.includes(basename)` over the CONCATENATED text of every
 * register — so a filename appearing in ordinary prose, inside a CLOSED finding, or in a
 * sentence saying the document is NOT registered, all satisfied a guard whose stated
 * protection is that `check-finding-ownership.mjs` can reach the document. It cannot reach
 * prose, and it reasons about nothing that is not open. That guard needs to ask a question
 * about ONE PARSED, OPEN FINDING'S OWN TEXT — and a second parser written next door is the
 * "two guards disagreeing about what a thing IS" failure this file already fixed once. So
 * the extent of a finding block is published here, from the one parser, rather than
 * re-derived there.
 *
 * @returns {Array<{id: string, title: string, status: string, severity: string, text: string}>}
 */
export function parseFindingBlocks(text) {
  if (typeof text !== "string") return [];
  const out = [];
  for (const block of text.split(/\n(?=## )/)) {
    const heading = /^## ([A-Z0-9]+-F\d+)\s*[—-]\s*(.*)/.exec(block);
    if (!heading) continue;
    let status;
    for (const pattern of STATUS_PATTERNS) {
      const match = pattern.exec(block);
      if (match) {
        status = match[1];
        break;
      }
    }
    const severity = SEVERITY_PATTERN.exec(block);
    out.push({
      id: heading[1],
      title: heading[2].trim(),
      // Lower-cased so `**Status:** OPEN` is open. The evaluator compares against the
      // literal "open"; without folding, a register that shouts its status is invisible
      // for exactly the same reason the three registers above were.
      status: status ? status.toLowerCase() : UNPARSEABLE_STATUS,
      severity: severity ? severity[1].toUpperCase() : UNPARSEABLE_SEVERITY,
      text: block,
    });
  }
  return out;
}

/** The record shape the ownership evaluator consumes: the same parse, without the block. */
export function parseFindings(text) {
  return parseFindingBlocks(text).map(({ text: _block, ...finding }) => finding);
}
