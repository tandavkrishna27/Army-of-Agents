#!/usr/bin/env node
/**
 * Tests for TRACK-001's ticket-graph coverage logic.
 *
 * Each test pins a decision that a future author could plausibly "simplify" into a defect.
 * The asymmetry test is the most important one: tightening this guard to also fail on
 * authority-only ids would make it fire on every planned ticket, and it would be disabled.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  expandTicketIdsFromFilename,
  collectTicketIdsFromFilenames,
  parseAuthorityNodes,
  evaluateTicketGraphCoverage,
} from "../ticket-graph-coverage.mjs";

test("a plain ticket filename yields its one id", () => {
  assert.deepEqual(expandTicketIdsFromFilename("WRK-009-design.md"), ["WRK-009"]);
  assert.deepEqual(expandTicketIdsFromFilename("DAT-008-result.md"), ["DAT-008"]);
});

test("a COMBINED filename expands to every id it names", () => {
  // The real mis-measurement this pins: taking only the leading id made MIG-006 and
  // MIG-007 look file-less and inflated the prose-only count from 19 to 21.
  assert.deepEqual(expandTicketIdsFromFilename("MIG-005-006-007-shadow-design.md"), [
    "MIG-005",
    "MIG-006",
    "MIG-007",
  ]);
});

test("an epic-level DECISION id is deliberately not a ticket", () => {
  // `E4-D12` is referenced by no ticket and has no graph node; demanding one would be a
  // permanent false failure. dependency-graph.mjs already states it does not catch this class.
  assert.deepEqual(expandTicketIdsFromFilename("E4-D12-live-dispatch-terrain.md"), []);
  assert.deepEqual(expandTicketIdsFromFilename("DEFERRAL-1-notes.md"), []);
  assert.deepEqual(expandTicketIdsFromFilename("README.md"), []);
});

test("graph nodes come from '#### ID' headings, not from any mention", () => {
  const md = [
    "#### WRK-009 — image hygiene",
    "- **Depends on:** none",
    "",
    "Some prose that mentions DAT-008 without giving it a node.",
    "##### WRK-010 — too deep to be a node",
  ].join("\n");
  const nodes = parseAuthorityNodes(md);
  assert.ok(nodes.has("WRK-009"));
  assert.ok(!nodes.has("DAT-008"), "a prose mention must NOT count as coverage");
  assert.ok(!nodes.has("WRK-010"), "a deeper heading is not a graph node");
});

test("a built ticket the authority cannot see is REPORTED", () => {
  const r = evaluateTicketGraphCoverage({
    filenames: ["WRK-009-design.md", "DAT-008-result.md"],
    authorityMarkdown: "#### WRK-009 — x\n- **Depends on:** none\n",
  });
  assert.deepEqual(r.uncovered, ["DAT-008"]);
});

test("★ an authority-only id is NOT a failure — that direction is the backlog", () => {
  // If this ever starts failing, someone has made the check symmetric. Do not "fix" it by
  // creating placeholder ticket files; fix the check.
  const r = evaluateTicketGraphCoverage({
    filenames: ["WRK-009-design.md"],
    authorityMarkdown: "#### WRK-009 — x\n#### SVC-001 — planned, unbuilt\n",
  });
  assert.deepEqual(r.uncovered, [], "a planned-but-unbuilt ticket must not fail the guard");
  assert.deepEqual(r.authorityOnly, ["SVC-001"], "but it IS reported, for visibility");
});

test("★ anti-vacuity: an empty tree yields zero counts, which the CLI treats as broken", () => {
  // The way this guard dies quietly is by matching nothing. The counts are what the
  // executable asserts on, so they must be observable here.
  const r = evaluateTicketGraphCoverage({ filenames: [], authorityMarkdown: "" });
  assert.equal(r.fileIdCount, 0);
  assert.equal(r.nodeCount, 0);
  assert.deepEqual(r.uncovered, []);
});

test("ids are de-duplicated across a ticket's terrain/design/result files", () => {
  const ids = collectTicketIdsFromFilenames([
    "WRK-009-terrain.md",
    "WRK-009-design.md",
    "WRK-009-result.md",
  ]);
  assert.deepEqual([...ids], ["WRK-009"]);
});
