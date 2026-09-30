/**
 * dependency-graph.mjs — pure, dependency-free parsing + analysis of the
 * re-platform programme's ticket dependency graph.
 *
 * WHY THIS EXISTS. Twice the programme sequenced work behind a blocker it never
 * scheduled: inherited deferral #1 (the provider-credential seam) and E4-D12 (live
 * worker dispatch). Both were found by accident, mid-implementation, by a human
 * reading code. Nothing detected either, because the dependency graph lives only as
 * prose.
 *
 * WHAT IT ACTUALLY CATCHES, and what it does not. A naive "every named dependency
 * exists" check would NOT have caught deferral #1: MIG-005/006/007 declare
 * `CLI-005, JOB-010..014, MIG-008` and every one of those names resolves. The real
 * defect is a DISAGREEMENT BETWEEN TWO DOCUMENTS — `current-main-crosswalk.md`'s
 * CM-013 row binds `DAT-004, DAT-005, … MIG-005, MIG-006, MIG-007` together, while
 * the ticket graph in `program-design.md` has no path from MIG-005 to DAT-004.
 *
 * So the load-bearing check is `undominatedCrosswalkRows`: within one crosswalk row,
 * SOME ticket must transitively depend on all the others (the row's work has a
 * completing ticket). Plain connectivity would be vacuous — the ticket graph is one
 * connected blob through FND-001.
 *
 * E4-D12 is a DIFFERENT class and this file does not claim to catch it: it is an
 * epic-level decision id referenced by no ticket at all, so it has no edge to check.
 * Stated rather than implied, so nobody reads a green run as covering it.
 */

/** Gate names that may appear as a dependency without being a ticket. */
export const NAMED_GATES = new Set(["E10-REALTIME-FOUNDATION", "E6-D1-FOUNDATION"]);

const TICKET_HEADING = /^####\s+([A-Z]{3,4}-\d{3})\s/;
const DEPENDS_ON = /^-\s+\*\*Depends on:\*\*\s*(.+?)\s*$/;
const TICKET_ID = /\b([A-Z]{3,4}-\d{3})\b/g;

/**
 * Parse `program-design.md` into `{ id -> string[] }`. A ticket whose `Depends on:`
 * says "none" maps to an empty array — distinct from a ticket with no line at all,
 * which is reported separately as `missingDependsOn`.
 */
export function parseTicketGraph(markdown) {
  const graph = new Map();
  const missingDependsOn = [];
  const lines = String(markdown).split(/\r?\n/);
  let current = null;
  let sawDependsOn = false;

  const closeCurrent = () => {
    if (current && !sawDependsOn) missingDependsOn.push(current);
  };

  for (const line of lines) {
    const heading = TICKET_HEADING.exec(line);
    if (heading) {
      closeCurrent();
      current = heading[1];
      sawDependsOn = false;
      if (!graph.has(current)) graph.set(current, []);
      continue;
    }
    if (!current || sawDependsOn) continue;
    const depends = DEPENDS_ON.exec(line);
    if (!depends) continue;
    sawDependsOn = true;
    const body = depends[1];
    if (/^none\b/i.test(body)) continue;
    graph.set(current, [...body.matchAll(TICKET_ID)].map((m) => m[1]));
  }
  closeCurrent();
  return { graph, missingDependsOn };
}

/** Parse the crosswalk's `| CM-0NN | … |` rows into `{ id, tickets[] }`. The owner
 * column is located by NAME rather than index so a column insertion cannot silently
 * make this read the wrong cell. */
export function parseCrosswalkRows(markdown) {
  const rows = [];
  for (const line of String(markdown).split(/\r?\n/)) {
    if (!/^\|\s*CM-\d{3}\s*\|/.test(line)) continue;
    const cells = line.split("|").map((cell) => cell.trim());
    const id = cells.find((cell) => /^CM-\d{3}$/.test(cell));
    // The owner cell is the one that is EXCLUSIVELY a ticket list: comma-separated
    // ids and nothing else. Prose cells mention ids but never in isolation.
    const owner = cells.find((cell) =>
      cell.length > 0 && /^[A-Z]{3,4}-\d{3}(\s*,\s*[A-Z]{3,4}-\d{3})*$/.test(cell));
    if (!id) continue;
    rows.push({ id, tickets: owner ? [...owner.matchAll(TICKET_ID)].map((m) => m[1]) : [] });
  }
  return rows;
}

/** Names referenced as a dependency that are neither a ticket nor a named gate. */
export function danglingDependencies(graph) {
  const problems = [];
  for (const [id, deps] of graph) {
    for (const dep of deps) {
      if (dep === id) problems.push({ ticket: id, dependency: dep, kind: "self" });
      else if (!graph.has(dep) && !NAMED_GATES.has(dep)) {
        problems.push({ ticket: id, dependency: dep, kind: "unknown" });
      }
    }
  }
  return problems;
}

/** Every ticket reachable from `start` by following dependencies (excluding itself). */
export function reachableFrom(graph, start) {
  const seen = new Set();
  const stack = [...(graph.get(start) ?? [])];
  while (stack.length > 0) {
    const next = stack.pop();
    if (seen.has(next)) continue;
    seen.add(next);
    for (const dep of graph.get(next) ?? []) stack.push(dep);
  }
  return seen;
}

/** Dependency cycles, reported as the ticket that closes the loop. */
export function dependencyCycles(graph) {
  const cycles = [];
  for (const id of graph.keys()) {
    if (reachableFrom(graph, id).has(id)) cycles.push(id);
  }
  return cycles;
}

/**
 * Crosswalk rows where NO ticket transitively depends on all the others.
 *
 * This is the deferral-#1 detector. A row asserts that a set of tickets together
 * own one current-main execution path; if none of them completes the others, the
 * plan is claiming a relationship the ticket graph cannot express — which is exactly
 * how MIG-005 came to be scheduled without ever depending on DAT-004.
 */
export function undominatedCrosswalkRows(graph, rows) {
  const findings = [];
  for (const row of rows) {
    const tickets = row.tickets.filter((id) => graph.has(id));
    if (tickets.length < 2) continue;
    const dominator = tickets.find((candidate) => {
      const reach = reachableFrom(graph, candidate);
      return tickets.every((other) => other === candidate || reach.has(other));
    });
    if (!dominator) findings.push({ row: row.id, tickets });
  }
  return findings;
}

/** Full analysis. `declared` is the reviewed-exception map for undominated rows. */
export function analyse({ programDesign, crosswalk, declared = {} }) {
  const { graph, missingDependsOn } = parseTicketGraph(programDesign);
  const rows = parseCrosswalkRows(crosswalk);
  const undominated = undominatedCrosswalkRows(graph, rows);
  return {
    ticketCount: graph.size,
    crosswalkRowCount: rows.length,
    missingDependsOn,
    dangling: danglingDependencies(graph),
    cycles: dependencyCycles(graph),
    undominated,
    undeclaredUndominated: undominated.filter((finding) => !declared[finding.row]),
    // A declaration for a row that is no longer undominated is stale: the exception
    // outlived the reason for it, and a stale allowlist entry silently re-opens the
    // hole it was written to document.
    staleDeclarations: Object.keys(declared)
      .filter((id) => !undominated.some((finding) => finding.row === id)),
  };
}
