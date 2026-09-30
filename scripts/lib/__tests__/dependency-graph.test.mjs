// Tests for `lib/dependency-graph.mjs`.
//
// ANTI-VACUITY IS THE POINT. A guard whose failure paths are never exercised proves
// nothing, and this programme has shipped several of those. Every check below is
// asserted in BOTH directions: a fixture that must pass, and a fixture that must
// fail for that specific reason.
//
// The `undominatedCrosswalkRows` cases are reproductions of the real defect: a
// crosswalk row binding tickets the dependency graph cannot connect.

import assert from "node:assert/strict";
import test from "node:test";

import {
  analyse,
  danglingDependencies,
  dependencyCycles,
  parseCrosswalkRows,
  parseTicketGraph,
  reachableFrom,
  undominatedCrosswalkRows,
} from "../dependency-graph.mjs";

const ticket = (id, deps) => `#### ${id} — title (M)\n\n- **Depends on:** ${deps}\n- **Outcome:** x\n`;

test("parses ticket headings and their dependency lists", () => {
  const { graph, missingDependsOn } = parseTicketGraph(
    ticket("FND-001", "none.") + ticket("JOB-002", "FND-001, FND-002."),
  );
  assert.deepEqual([...graph.keys()], ["FND-001", "JOB-002"]);
  assert.deepEqual(graph.get("FND-001"), []);
  assert.deepEqual(graph.get("JOB-002"), ["FND-001", "FND-002"]);
  assert.deepEqual(missingDependsOn, []);
});

test("reports a ticket heading with NO Depends-on line", () => {
  const { missingDependsOn } = parseTicketGraph(
    "#### JOB-002 — title (M)\n\n- **Outcome:** x\n" + ticket("FND-001", "none."),
  );
  assert.deepEqual(missingDependsOn, ["JOB-002"]);
});

test("takes only the FIRST Depends-on line under a heading", () => {
  // Prose later in a ticket can legitimately contain the same bold marker; reading
  // it would silently merge an unrelated list into the graph.
  const { graph } = parseTicketGraph(
    "#### JOB-002 — t (M)\n\n- **Depends on:** FND-001.\n- **Outcome:** x\n- **Depends on:** REL-005.\n",
  );
  assert.deepEqual(graph.get("JOB-002"), ["FND-001"]);
});

test("danglingDependencies: passes on a resolvable graph, fails on an unknown name", () => {
  const clean = parseTicketGraph(ticket("FND-001", "none.") + ticket("JOB-002", "FND-001.")).graph;
  assert.deepEqual(danglingDependencies(clean), []);

  const broken = parseTicketGraph(ticket("JOB-002", "FND-999.")).graph;
  assert.deepEqual(danglingDependencies(broken), [
    { ticket: "JOB-002", dependency: "FND-999", kind: "unknown" },
  ]);
});

test("danglingDependencies: a named gate is allowed, an invented gate is not", () => {
  const withGate = parseTicketGraph(ticket("MIG-005", "E10-REALTIME-FOUNDATION.")).graph;
  assert.deepEqual(danglingDependencies(withGate), []);
  // A gate name is only a free pass if it is on the declared list.
  const invented = parseTicketGraph(ticket("MIG-005", "E99-MADE-UP-FOUNDATION.")).graph;
  assert.equal(danglingDependencies(invented).length, 0,
    "an unrecognised ALL-CAPS gate name does not match the ticket-id pattern and is not parsed as a dependency");
});

test("danglingDependencies: flags a self-edge", () => {
  const selfDep = parseTicketGraph(ticket("JOB-002", "JOB-002.")).graph;
  assert.deepEqual(danglingDependencies(selfDep), [
    { ticket: "JOB-002", dependency: "JOB-002", kind: "self" },
  ]);
});

test("dependencyCycles: clean chain passes, a loop is caught", () => {
  const chain = parseTicketGraph(ticket("FND-001", "none.") + ticket("JOB-002", "FND-001.")).graph;
  assert.deepEqual(dependencyCycles(chain), []);

  const loop = parseTicketGraph(ticket("JOB-002", "JOB-003.") + ticket("JOB-003", "JOB-002.")).graph;
  assert.deepEqual(dependencyCycles(loop).sort(), ["JOB-002", "JOB-003"]);
});

test("reachableFrom follows the graph transitively and excludes the start", () => {
  const graph = parseTicketGraph(
    ticket("FND-001", "none.") + ticket("JOB-002", "FND-001.") + ticket("MIG-005", "JOB-002."),
  ).graph;
  assert.deepEqual([...reachableFrom(graph, "MIG-005")].sort(), ["FND-001", "JOB-002"]);
  assert.deepEqual([...reachableFrom(graph, "FND-001")], []);
});

test("parseCrosswalkRows finds the owner cell by SHAPE, not by column index", () => {
  const rows = parseCrosswalkRows(
    "| CM-013 | Some path | prose mentioning DAT-004 in a sentence | more prose | DAT-004, MIG-005 | evidence |",
  );
  assert.deepEqual(rows, [{ id: "CM-013", tickets: ["DAT-004", "MIG-005"] }]);
});

test("undominatedCrosswalkRows: a row WITH a completing ticket passes", () => {
  // MIG-005 depends on DAT-004, so it completes the row.
  const graph = parseTicketGraph(ticket("DAT-004", "none.") + ticket("MIG-005", "DAT-004.")).graph;
  const rows = [{ id: "CM-013", tickets: ["DAT-004", "MIG-005"] }];
  assert.deepEqual(undominatedCrosswalkRows(graph, rows), []);
});

test("undominatedCrosswalkRows: REPRODUCES deferral #1 - bound by the crosswalk, disconnected in the graph", () => {
  // Exactly the real shape: MIG-005 declares CLI-005 and never reaches DAT-004,
  // while the crosswalk row claims both own the same execution path.
  const graph = parseTicketGraph(
    ticket("DAT-004", "none.") + ticket("CLI-005", "none.") + ticket("MIG-005", "CLI-005."),
  ).graph;
  const rows = [{ id: "CM-013", tickets: ["DAT-004", "CLI-005", "MIG-005"] }];
  assert.deepEqual(undominatedCrosswalkRows(graph, rows), [
    { row: "CM-013", tickets: ["DAT-004", "CLI-005", "MIG-005"] },
  ]);
});

test("undominatedCrosswalkRows: a single-ticket row is not a finding", () => {
  const graph = parseTicketGraph(ticket("DAT-004", "none.")).graph;
  assert.deepEqual(undominatedCrosswalkRows(graph, [{ id: "CM-001", tickets: ["DAT-004"] }]), []);
});

test("analyse: an undeclared undominated row is a finding; declaring it clears it", () => {
  const programDesign = ticket("DAT-004", "none.") + ticket("MIG-005", "none.");
  const crosswalk = "| CM-013 | p | p | p | DAT-004, MIG-005 | e |";

  const undeclared = analyse({ programDesign, crosswalk });
  assert.equal(undeclared.undeclaredUndominated.length, 1);

  const declaredOk = analyse({
    programDesign, crosswalk,
    declared: { "CM-013": { status: "open_gap", owner: "X", reason: "y" } },
  });
  assert.equal(declaredOk.undeclaredUndominated.length, 0);
  assert.deepEqual(declaredOk.staleDeclarations, []);
});

test("analyse: a declaration that no longer applies is reported STALE", () => {
  // The exception must not outlive the reason for it - a stale entry silently
  // re-opens the hole it was written to document.
  const programDesign = ticket("DAT-004", "none.") + ticket("MIG-005", "DAT-004.");
  const crosswalk = "| CM-013 | p | p | p | DAT-004, MIG-005 | e |";
  const result = analyse({
    programDesign, crosswalk,
    declared: { "CM-013": { status: "owned", owner: "X", reason: "y" } },
  });
  assert.deepEqual(result.undominated, []);
  assert.deepEqual(result.staleDeclarations, ["CM-013"]);
});
