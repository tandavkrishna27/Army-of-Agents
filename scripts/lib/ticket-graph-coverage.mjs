/**
 * ticket-graph-coverage.mjs — pure, dependency-free logic for TRACK-001.
 *
 * WHY THIS EXISTS. `check-dependency-graph.mjs` reasons over the ticket graph in
 * `docs/replatform/program-design.md`. That document is hand-maintained, and it had
 * drifted: `DAT-008`, `WRK-008` and `WRK-009` — three tickets with LANDED CODE — appeared
 * in it ZERO times. The graph checker ran, passed, and was structurally unable to see them,
 * so every reachability conclusion drawn from it was unsound.
 *
 * This is a DIFFERENT failure mode from the one `check-guard-inventory.mjs` detects. That
 * guard asks "is this script invoked?". This one is invoked, runs, and compares against a
 * stale authority. **Stale authority is not no-caller**, and counting callers will never
 * find it.
 *
 * ★ THE ASYMMETRY IS THE WHOLE DESIGN. Only one direction is a defect:
 *
 *   - a ticket FILE exists and the authority does not name it  -> the graph is MISSING A
 *     NODE, so reachability answers computed from it are wrong.            **FAILURE**
 *   - the authority names a ticket that has no file yet         -> that is the BACKLOG.
 *     19 such IDs exist today (SVC-001..007, BRW-003..006, REL-001/2/3/5, ...) and every
 *     one is planned, unbuilt work.                                        **NOT a failure**
 *
 * A symmetric check would be easier to write, would fire on every planned ticket, and would
 * be switched off within a week. `authorityOnlyIds` is therefore returned for REPORTING and
 * is deliberately never a failure condition.
 */

/**
 * Ticket ids live in the FILENAME, and a filename may name SEVERAL tickets:
 * `MIG-005-006-007-shadow-design.md` is one document owning three ids.
 *
 * ★ This expansion is the fix for a real mis-measurement: taking only the leading id made
 * `MIG-006` and `MIG-007` look file-less, which inflated the "prose-only" count from 19 to
 * 21 and would have mis-shaped this whole guard.
 *
 * Deliberately requires a THREE-DIGIT number, which excludes `E4-D12-live-dispatch-terrain.md`.
 * `E4-D12` is an epic-level DECISION id referenced by no ticket, not a ticket — `dependency-graph.mjs`
 * says outright that it does not catch that class, and demanding a graph node for it would
 * produce a permanent false failure. Excluded on purpose, not by accident.
 */
export function expandTicketIdsFromFilename(filename) {
  const m = /^([A-Z]{2,5})-(\d{3})((?:-\d{3})*)/.exec(String(filename));
  if (!m) return [];
  const [, prefix, first, rest] = m;
  const ids = [`${prefix}-${first}`];
  for (const n of String(rest || "").match(/\d{3}/g) || []) ids.push(`${prefix}-${n}`);
  return [...new Set(ids)];
}

/** Every ticket id named by any file in the ticket directories. */
export function collectTicketIdsFromFilenames(filenames) {
  const ids = new Set();
  for (const f of filenames) for (const id of expandTicketIdsFromFilename(f)) ids.add(id);
  return ids;
}

/**
 * The authority's GRAPH NODES — `#### TICKET-ID` headings only.
 *
 * Deliberately NOT "any mention of an id". `check-dependency-graph.mjs` builds its graph
 * from these headings, so a prose mention elsewhere in the document is not a node and must
 * not be counted as coverage: it would let a ticket look tracked while contributing no
 * edges to the graph that actually gets reasoned over.
 */
export function parseAuthorityNodes(markdown) {
  const nodes = new Set();
  for (const line of String(markdown).split(/\r?\n/)) {
    const m = /^####\s+([A-Z]{2,5}-\d{3})\s/.exec(line);
    if (m) nodes.add(m[1]);
  }
  return nodes;
}

/**
 * @returns {{uncovered: string[], authorityOnly: string[], fileIdCount: number, nodeCount: number}}
 *   `uncovered` is the failure set. `authorityOnly` is the backlog, reported only.
 */
export function evaluateTicketGraphCoverage({ filenames, authorityMarkdown }) {
  const fileIds = collectTicketIdsFromFilenames(filenames);
  const nodes = parseAuthorityNodes(authorityMarkdown);
  return {
    uncovered: [...fileIds].filter((id) => !nodes.has(id)).sort(),
    authorityOnly: [...nodes].filter((id) => !fileIds.has(id)).sort(),
    fileIdCount: fileIds.size,
    nodeCount: nodes.size,
  };
}
