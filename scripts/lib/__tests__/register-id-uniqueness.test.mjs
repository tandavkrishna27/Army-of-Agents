// Self-test for the register-id uniqueness guard.
//
// ★ The tests that matter are the three defects that were live in this repo on 2026-09-03,
// all of the same shape and none of them caught by anything:
//   - `## Decision #104` twice in the LOCKED decisions register, one day apart, on unrelated
//     subjects, cited as load-bearing in four places in CLAUDE.md;
//   - `## E1-F008` twice in one findings register, both severity HIGH, where the ownership
//     guard keys by id so one silently SHADOWED the other;
//   - and the false positive this guard produced on its FIRST run, which is pinned here too:
//     a range roll-up heading is not a second definition.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";

import {
  evaluateIdUniqueness,
  extractHeadingIds,
  FINDING_HEADING,
  DECISION_HEADING,
  EPIC_DECISION_HEADING,
  DECISION_TABLE_ROW,
  DA_HEADING,
  DECISION_REVISION,
  DECISION_REVISION_BODY,
  FINDING_ID_RANGE_HEADING,
} from "../register-id-uniqueness.mjs";
import { parseFindings } from "../finding-ownership.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const kinds = (r) => r.problems.map((p) => p.kind);

test("★ the real Decision #104 collision FAILS when undeclared", () => {
  const r = evaluateIdUniqueness({
    sources: [
      {
        file: "docs/architecture/decisions.md",
        kind: "decision",
        ids: [{ id: "103", line: 800 }, { id: "104", line: 854 }, { id: "104", line: 913 }],
      },
    ],
  });
  assert.equal(r.ok, false);
  assert.deepEqual(kinds(r), ["duplicate_id"]);
  assert.equal(r.problems[0].id, "104");
  // BOTH locations are reported: you cannot decide which side keeps the number without
  // being able to read both entries.
  assert.match(r.problems[0].detail, /decisions\.md:854 and .*decisions\.md:913/);
});

test("★ the real E1-F008 collision FAILS — the ownership guard keys by id, so one shadows the other", () => {
  const r = evaluateIdUniqueness({
    sources: [
      {
        file: "docs/replatform/epics/E1-worker-protocol/findings.md",
        kind: "finding",
        ids: [{ id: "E1-F007", line: 112 }, { id: "E1-F008", line: 96 }, { id: "E1-F008", line: 132 }],
      },
    ],
  });
  assert.equal(r.ok, false);
  assert.deepEqual(kinds(r), ["duplicate_id"]);
  assert.equal(r.problems[0].id, "E1-F008");
});

test("★ a duplicate ACROSS registers is caught too, not just within one", () => {
  const r = evaluateIdUniqueness({
    sources: [
      { file: "a/findings.md", kind: "finding", ids: [{ id: "E9-F001", line: 3 }] },
      { file: "b/findings.md", kind: "finding", ids: [{ id: "E9-F001", line: 7 }] },
    ],
  });
  assert.equal(r.ok, false);
  assert.deepEqual(kinds(r), ["duplicate_id"]);
  assert.match(r.problems[0].detail, /a\/findings\.md:3 and b\/findings\.md:7/);
});

test("kinds are separate namespaces — a finding and a decision may share a number", () => {
  const r = evaluateIdUniqueness({
    sources: [
      { file: "decisions.md", kind: "decision", ids: [{ id: "104", line: 1 }] },
      { file: "epic/decisions.md", kind: "epic-decision", ids: [{ id: "E2-D01", line: 1 }] },
      { file: "findings.md", kind: "finding", ids: [{ id: "E1-F001", line: 1 }] },
    ],
  });
  assert.equal(r.ok, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// The waiver: default-deny, with a written declaration.

test("★ a DECLARED duplicate passes and is reported, so it cannot be forgotten", () => {
  // ★ UPDATED: this test used to pass a waiver carrying only a `reason`, which pinned the
  // WEAKER contract an external review then found (the P2): keyed on the id alone, a waiver
  // turned that id into a permanent blind spot, so a THIRD occurrence hid behind it. A
  // waiver now has to declare `occurrences` and have it match exactly.
  const sources = [
    { file: "decisions.md", kind: "decision", ids: [{ id: "104", line: 854 }, { id: "104", line: 913 }] },
  ];
  const r = evaluateIdUniqueness({
    sources,
    waived: {
      "decision:104": {
        reason: "awaiting an operator decision",
        occurrences: 2,
        // ★ UPDATED AGAIN (round 2): a count alone catches only ADD and REMOVE. A waiver now
        // also binds to the IDENTITIES reviewed, so replacing one definition with a different
        // one breaks it. `sources` above carries no `text`, so both identities are empty.
        identities: ["", ""],
      },
    },
  });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.deepEqual(r.waived, ["decision:104"]);
});

test("★ a waiver with NO reason is an allow-list entry in a declaration's clothes — it FAILS", () => {
  const sources = [
    { file: "decisions.md", kind: "decision", ids: [{ id: "104", line: 854 }, { id: "104", line: 913 }] },
  ];
  for (const bad of [{}, { reason: "" }, { reason: "   " }, null, "yes"]) {
    const r = evaluateIdUniqueness({ sources, waived: { "decision:104": bad } });
    assert.equal(r.ok, false, `expected failure for waiver ${JSON.stringify(bad)}`);
  }
});

test("★ a waiver may not outlive its duplicate — stale_waiver", () => {
  // Otherwise the file rots into a list of collisions that were fixed years ago, and an
  // untrusted list is the state these guards exist to leave.
  const r = evaluateIdUniqueness({
    sources: [{ file: "decisions.md", kind: "decision", ids: [{ id: "104", line: 854 }] }],
    waived: { "decision:104": { reason: "fixed last week, entry never removed" } },
  });
  assert.equal(r.ok, false);
  assert.deepEqual(kinds(r), ["stale_waiver"]);
});

test("malformed input fails closed rather than reporting OK", () => {
  for (const bad of [null, undefined, 42, "nope", { sources: null }, { sources: [null] }, { sources: [{}] }]) {
    assert.equal(evaluateIdUniqueness(bad).ok, false, `expected failure for ${JSON.stringify(bad)}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Heading extraction.

test("★ a RANGE roll-up heading is not a second definition — the guard's own first false positive", () => {
  // `docs/replatform/epics/E3-job-control/findings.md:1252` is
  // `## E3-F028–E3-F033 — RESOLVED (JOB-003 final acceptance 2026-08-12)`: a resolution
  // roll-up over six findings. The first draft of FINDING_HEADING ended in `\b`, matched
  // `E3-F028` out of it, and reported a duplicate that does not exist. A guard that cries
  // wolf gets switched off — a worse outcome than no guard.
  const ids = extractHeadingIds(
    [
      "## E3-F028 - Bounded pools are not bound to one advisory-lock authority domain",
      "body",
      "## E3-F028–E3-F033 — RESOLVED (JOB-003 final acceptance 2026-08-12)",
    ].join("\n"),
    FINDING_HEADING,
  );
  assert.deepEqual(ids.map((x) => ({ id: x.id, line: x.line })), [{ id: "E3-F028", line: 1 }]);
});

test("heading extraction reads the real shapes and ignores body-text CITATIONS", () => {
  assert.deepEqual(
    extractHeadingIds("## Decision #104 — Keyless (2026-06-26)\nSee Decision #45 and #92.\n", DECISION_HEADING).map((x) => ({ id: x.id, line: x.line })),
    [{ id: "104", line: 1 }],
  );
  assert.deepEqual(
    extractHeadingIds("### E2-D01 — locked\ntext about E2-D03\n", EPIC_DECISION_HEADING).map((x) => ({ id: x.id, line: x.line })),
    [{ id: "E2-D01", line: 1 }],
  );
  assert.deepEqual(extractHeadingIds("## E1-F008 - frozen-consumer checker\n", FINDING_HEADING).map((x) => ({ id: x.id, line: x.line })), [
    { id: "E1-F008", line: 1 },
  ]);
  for (const bad of [null, undefined, 42, {}]) assert.deepEqual(extractHeadingIds(bad, FINDING_HEADING), []);
});

test("★★ this guard and the ownership guard must agree on what a finding IS", () => {
  // `findTicketIds` carries an explicit comment about using the same notion of "a ticket
  // exists" as its neighbour "so the two guards cannot disagree". The same applies here,
  // and it is exactly where the range-roll-up false positive came from: `parseFindings`
  // requires `\s*[—-]` after the id — a class holding an EM dash and a hyphen but NOT the
  // EN dash the roll-up heading uses — so it never saw that heading and this guard did.
  // Run over the REAL registers, so drift in either extractor reds this test.
  const epics = path.join(ROOT, "docs/replatform/epics");
  if (!existsSync(epics)) return;
  for (const entry of readdirSync(epics, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(epics, entry.name, "findings.md");
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    assert.deepEqual(
      extractHeadingIds(text, FINDING_HEADING).map((x) => x.id),
      parseFindings(text).map((f) => f.id),
      `${entry.name}: the uniqueness extractor and parseFindings disagree about which headings are findings`,
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ★★★ THE 77% GAP — the guard's own failure class, inside the guard built to stop it.
//
// The first version read only `## Decision #N` headings: 35 of the 153 decision ids in
// `docs/architecture/decisions.md`. The other 118 are 91 `| N | … |` TABLE ROWS (decisions
// #1-91) and 27 `### DA-N:` headings. Verified by positive control before the fix: a
// synthetic duplicate table row and a synthetic duplicate `### DA-3:` BOTH shipped green.
//
// The gap was invisible precisely BECAUSE the guard worked on the case it was built for --
// `#104` is one of the 35. Found by external review (Codex) of `dae86d157e`.

test("★★★ a duplicate TABLE-ROW decision FAILS — 91 of 153 ids were unscanned", () => {
  const ids = extractHeadingIds("| 6 | six | r |\n| 7 | seven | r |\n| 7 | SYNTHETIC dup | r |\n", DECISION_TABLE_ROW);
  assert.deepEqual(ids.map((x) => x.id), ["6", "7", "7"]);
  const r = evaluateIdUniqueness({ sources: [{ file: "decisions.md", kind: "decision", ids }] });
  assert.equal(r.ok, false);
  assert.deepEqual(kinds(r), ["duplicate_id"]);
  assert.equal(r.problems[0].id, "7");
});

test("★★★ a duplicate DA-N heading FAILS — the other 27 unscanned ids", () => {
  const ids = extractHeadingIds("### DA-3: Discussions Replace Debrief\n### DA-3: SYNTHETIC dup\n", DA_HEADING);
  assert.deepEqual(ids.map((x) => x.id), ["DA-3", "DA-3"]);
  const r = evaluateIdUniqueness({ sources: [{ file: "decisions.md", kind: "da-decision", ids }] });
  assert.equal(r.ok, false);
  assert.deepEqual(kinds(r), ["duplicate_id"]);
});

test("★★ a heading colliding with its own TABLE entry FAILS — they are ONE namespace", () => {
  // `## Decision #80` and table row `| 80 |` are the same numbering continued in a different
  // shape, so they must share a namespace. Putting table rows in their own kind would have
  // closed the COUNT while leaving this collision — the shape the reviewer named — wide open.
  const r = evaluateIdUniqueness({
    sources: [
      { file: "decisions.md", kind: "decision", ids: [{ id: "80", line: 198 }] },
      { file: "decisions.md", kind: "decision", ids: [{ id: "80", line: 2191 }] },
    ],
  });
  assert.equal(r.ok, false);
  assert.deepEqual(kinds(r), ["duplicate_id"]);
});

test("★ DA-1 and decision 1 do NOT collide — separate namespaces", () => {
  const r = evaluateIdUniqueness({
    sources: [
      { file: "decisions.md", kind: "decision", ids: [{ id: "1", line: 17 }] },
      { file: "decisions.md", kind: "da-decision", ids: [{ id: "DA-1", line: 233 }] },
    ],
  });
  assert.equal(r.ok, true);
});

test("★★ a (revised …) heading is NOT a duplicate — the real id-14 pattern", () => {
  // `## Decision #14 (revised 2026-04-21)` restates table row 14 ("Status: Revised. Original
  // locked version superseded."). A revision names the SAME decision — that is what a
  // revision IS — so counting it would be a false positive on a documented pattern, and a
  // guard that cries wolf gets switched off.
  const text = "| 14 | MCP inbound may create tasks | r |\n## Decision #14 (revised 2026-04-21)\n";
  const defs = extractHeadingIds(text, DECISION_HEADING, { skip: DECISION_REVISION });
  assert.deepEqual(defs, [], "the revision heading must not be read as a definition");
  const rows = extractHeadingIds(text, DECISION_TABLE_ROW);
  const revs = extractHeadingIds(text, DECISION_REVISION).map((x) => ({ ...x, file: "decisions.md", kind: "decision" }));
  const r = evaluateIdUniqueness({
    sources: [{ file: "decisions.md", kind: "decision", ids: [...defs, ...rows] }],
    revisions: revs,
  });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
});

test("★★ (revised) is not an escape hatch — a revision of nothing FAILS", () => {
  // Without this, "(revised)" would be the way to smuggle a duplicate past the check:
  // excluded from the count, and validated by nothing.
  const r = evaluateIdUniqueness({
    sources: [{ file: "decisions.md", kind: "decision", ids: [{ id: "14", line: 37 }] }],
    revisions: [{ id: "999", kind: "decision", file: "decisions.md", line: 2191 }],
  });
  assert.equal(r.ok, false);
  assert.deepEqual(kinds(r), ["revision_without_original"]);
  assert.equal(r.problems[0].id, "999");
});

// ─────────────────────────────────────────────────────────────────────────────
// The P2 — a waiver keyed on the id ALONE makes that id a permanent blind spot.

test("★★ a waiver must declare occurrences — a reason alone is not a binding", () => {
  const sources = [
    { file: "decisions.md", kind: "decision", ids: [{ id: "104", line: 854 }, { id: "104", line: 913 }] },
  ];
  const r = evaluateIdUniqueness({ sources, waived: { "decision:104": { reason: "awaiting a decision" } } });
  assert.equal(r.ok, false);
  assert.deepEqual(kinds(r), ["malformed_waiver"]);
  for (const bad of [0, 1, "2", 2.5, null]) {
    const q = evaluateIdUniqueness({ sources, waived: { "decision:104": { reason: "r", occurrences: bad } } });
    assert.equal(q.ok, false, `occurrences=${JSON.stringify(bad)} must be rejected`);
  }
});

test("★★★ a THIRD occurrence cannot hide behind a waiver for the first two", () => {
  // The reviewer's P2: with the waiver keyed on the id alone, adding an unrelated third
  // `## Decision #104` — or swapping one of the two known ones for different content —
  // stayed green, so the waived id became a permanent blind spot.
  const waived = { "decision:104": { reason: "awaiting a decision", occurrences: 2, identities: ["A", "B"] } };
  const two = [{ id: "104", line: 854, text: "A" }, { id: "104", line: 913, text: "B" }];
  assert.equal(
    evaluateIdUniqueness({ sources: [{ file: "d.md", kind: "decision", ids: two }], waived }).ok,
    true,
    "the declared two must still pass",
  );
  const three = [...two, { id: "104", line: 2191, text: "C" }];
  const r = evaluateIdUniqueness({ sources: [{ file: "d.md", kind: "decision", ids: three }], waived });
  assert.equal(r.ok, false, "a third occurrence must break the waiver");
  assert.deepEqual(kinds(r), ["waiver_count_mismatch"]);
  assert.match(r.problems[0].detail, /declares 2 occurrence\(s\), found 3/);
});

test("★★★ ANTI-RECURRENCE: every decision-id shape in the REAL file is scanned", () => {
  // The gap this closes was not a bug in a pattern — it was a pattern that DID NOT EXIST.
  // So the durable guard is a coverage assertion against the real document: every line that
  // looks like a decision id must be claimed by an extractor, as a definition or a revision.
  // A FOURTH shape added later fails here instead of going quietly unscanned.
  const file = path.join(ROOT, "docs/architecture/decisions.md");
  if (!existsSync(file)) return;
  const text = readFileSync(file, "utf8");
  const claimed =
    extractHeadingIds(text, DECISION_HEADING, { skip: DECISION_REVISION }).length +
    extractHeadingIds(text, DECISION_TABLE_ROW).length +
    extractHeadingIds(text, DA_HEADING).length +
    extractHeadingIds(text, DECISION_REVISION).length;
  // Counted with expressions that do NOT reuse the exported patterns — a coverage test that
  // reuses the thing it audits proves nothing.
  const lines = text.split(/\r?\n/);
  const looksLikeAnId = lines.filter(
    (l) => /^\|\s*\d+\s*\|/.test(l) || /^#{2,4}\s+Decision\s+#\d+/.test(l) || /^#{2,4}\s+DA-\d+:/.test(l),
  ).length;
  assert.equal(
    claimed,
    looksLikeAnId,
    `the extractors claim ${claimed} decision ids but the document has ${looksLikeAnId} id-shaped lines — a shape is unscanned`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// ★★★ ROUND 2 — the fix closed the case that motivated it and left the adjacent
// case open. Both found by external review of `676b87aa9`.

test("★★★ (revised) may not be a disguise — a duplicate with revision-ish prose is NOT a revision", () => {
  // MEASURED against the FIRST version of DECISION_REVISION (`#(\d+)\b[^\n]*\(revised\b`):
  // all three of these were treated as revisions and skipped, and `revision_without_original`
  // then PASSED each, because it verified only that some original with that id exists.
  // I built that check for this exact attack and it validated the wrong property.
  assert.equal(DECISION_REVISION.test("## Decision #14 (revised 2026-04-21)"), true, "the genuine form must qualify");
  for (const disguise of [
    "## Decision #125 — different decision (revised wording)",
    "## Decision #125 — a totally unrelated duplicate (revised)",
    "## Decision #125 (revised)",
    "## Decision #125 (revised soon)",
  ]) {
    assert.equal(DECISION_REVISION.test(disguise), false, `must NOT qualify as a revision: ${disguise}`);
  }
});

test("★★ a disguised duplicate falls through to the DEFINITION count and collides", () => {
  // The safe direction: failing either revision gate means the heading is an ordinary
  // definition, so the duplicate is REPORTED rather than skipped.
  const text = "## Decision #125 — the real one (2026-06-25)\n\nbody\n## Decision #125 — different decision (revised wording)\n\nbody\n";
  const defs = extractHeadingIds(text, DECISION_HEADING, { skip: DECISION_REVISION });
  assert.equal(defs.length, 2, "the disguised heading must still be counted as a definition");
  const r = evaluateIdUniqueness({ sources: [{ file: "decisions.md", kind: "decision", ids: defs }] });
  assert.equal(r.ok, false);
  assert.deepEqual(kinds(r), ["duplicate_id"]);
});

test("★★ gate 2 is load-bearing — the right heading form with no body declaration is NOT a revision", () => {
  // Proven live against the real corpus: `## Decision #125 (revised 2026-09-03)` with an
  // ordinary body is still reported as a duplicate. One gate was demonstrably not enough,
  // so the body must declare the revision too.
  const genuine = "## Decision #14 (revised 2026-04-21)\n\n**Status:** Revised. Original locked version superseded.\n";
  const fake = "## Decision #14 (revised 2026-04-21)\n\nA totally unrelated decision, no declaration.\n";
  assert.equal(DECISION_REVISION_BODY.test(genuine), true);
  assert.equal(DECISION_REVISION_BODY.test(fake), false);
});

test("★★★ a waiver binds to the occurrences REVIEWED, not merely to how many there were", () => {
  // The count catches ADD and REMOVE only. Replacing either reviewed definition with a
  // different one at another line left `places.length === 2`, so the waiver kept applying
  // and the promised swap detection never ran.
  const identities = ["## Decision #104 — Optimistic concurrency", "## Decision #104 — Keyless-except-embeddings"];
  const waived = { "decision:104": { reason: "awaiting a decision", occurrences: 2, identities } };
  const reviewed = [
    { id: "104", line: 854, text: identities[0] },
    { id: "104", line: 913, text: identities[1] },
  ];
  assert.equal(
    evaluateIdUniqueness({ sources: [{ file: "d.md", kind: "decision", ids: reviewed }], waived }).ok,
    true,
    "the reviewed pair must still pass",
  );

  // Same COUNT, one definition REPLACED.
  const swapped = [reviewed[0], { id: "104", line: 2191, text: "## Decision #104 — A COMPLETELY DIFFERENT THING" }];
  const r = evaluateIdUniqueness({ sources: [{ file: "d.md", kind: "decision", ids: swapped }], waived });
  assert.equal(r.ok, false, "a swapped occurrence must break the waiver");
  assert.deepEqual(kinds(r), ["waiver_identity_mismatch"]);

  // LINE DRIFT must NOT break it — identity is the source text, not file:line, because
  // every edit above a definition shifts its line and a guard that cries wolf gets
  // switched off.
  const drifted = [
    { id: "104", line: 999, text: identities[0] },
    { id: "104", line: 1500, text: identities[1] },
  ];
  assert.equal(
    evaluateIdUniqueness({ sources: [{ file: "d.md", kind: "decision", ids: drifted }], waived }).ok,
    true,
    "pure line drift must not break a waiver",
  );
});

test("★ a waiver missing `identities` is malformed — the binding is required, not optional", () => {
  const ids = [
    { id: "104", line: 854, text: "## Decision #104 — A" },
    { id: "104", line: 913, text: "## Decision #104 — B" },
  ];
  const r = evaluateIdUniqueness({
    sources: [{ file: "d.md", kind: "decision", ids }],
    waived: { "decision:104": { reason: "awaiting", occurrences: 2 } },
  });
  assert.equal(r.ok, false);
  assert.deepEqual(kinds(r), ["malformed_waiver"]);
});

// ─────────────────────────────────────────────────────────────────────────────
// ★★★ THE ID-RANGE HEADING IS REFUSED. One idiom, three distinct failures in a day.

test("★★★ an id-range heading is REFUSED — it names six findings and is addressable as none", () => {
  const r = evaluateIdUniqueness({
    sources: [],
    rangeHeadings: [{ file: "E3/findings.md", line: 1252, from: "E3-F028", to: "E3-F033" }],
  });
  assert.equal(r.ok, false);
  assert.deepEqual(kinds(r), ["id_range_heading"]);
  assert.equal(r.problems[0].id, "E3-F028..E3-F033");
});

test("★★ the range pattern matches the real form and NOT ordinary finding headings", () => {
  // The dash matters: the real heading uses an EN dash, which is exactly why
  // `parseFindings` (whose class holds an EM dash and a hyphen) never saw it and the two
  // extractors disagreed. All three dashes are covered here.
  for (const h of [
    "## E3-F028–E3-F033 — RESOLVED (JOB-003 final acceptance 2026-08-12)",
    "## E3-F028—E3-F033 — RESOLVED",
    "## E3-F028-E3-F033 — RESOLVED",
  ]) {
    assert.equal(FINDING_ID_RANGE_HEADING.test(h), true, `must be refused: ${h}`);
  }
  for (const h of [
    "## E3-F028 - Bounded pools are not bound to one advisory-lock authority domain",
    "## E1-F009 — the frozen matcher's five placement guards had NO falsifiable test",
    "## Resolution round — JOB-003 final acceptance, 2026-08-12 (findings F028 through F033)",
  ]) {
    assert.equal(FINDING_ID_RANGE_HEADING.test(h), false, `must NOT be refused: ${h}`);
  }
});

test("★★ the replacement heading is claimed by NO id extractor", () => {
  // The point of re-heading rather than deleting: the prose survives, but nothing tries to
  // address it as a finding. If this ever regressed, the roll-up would start shadowing a
  // real id again.
  const heading = "## Resolution round — JOB-003 final acceptance, 2026-08-12 (findings F028 through F033)";
  assert.deepEqual(extractHeadingIds(heading, FINDING_HEADING), []);
  assert.deepEqual(extractHeadingIds(heading, DECISION_HEADING), []);
  assert.deepEqual(extractHeadingIds(heading, DA_HEADING), []);
  assert.equal(FINDING_ID_RANGE_HEADING.test(heading), false);
});
