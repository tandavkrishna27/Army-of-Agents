# TRACK-001 Result — the dependency graph can no longer drift behind the work

**Status:** LANDED. **Start SHA:** `dabb99b23` ([`TRACK-001-design.md`](./TRACK-001-design.md)).
**Motivated by:** [`WAVE-4-RESEQUENCE.md`](../../../WAVE-4-RESEQUENCE.md) §1.2, §5 step 0.

---

## 1. What landed

`scripts/check-ticket-graph-coverage.mjs` (+ pure logic in `scripts/lib/ticket-graph-coverage.mjs`)
fails when a ticket FILE exists whose id has no `#### ID` node in `program-design.md`. Wired into
the `policy` job in the **same step** as `check-dependency-graph.mjs`, declared in
`guard-inventory.json`, and backed by 8 unit tests pinning each design decision.

Four nodes added to the authority: `WRK-008`, `WRK-009`, `DAT-008`, `TRACK-001`.

## 2. Acceptance

| Clause | Artifact | State |
|---|---|---|
| A built ticket the authority cannot see FAILS | fail-first run named exactly `DAT-008`, `TRACK-001`, `WRK-008`, `WRK-009` | done, proven failing first |
| An authority-only id does NOT fail | unit test pinning the asymmetry | done |
| A combined filename expands to every id | unit test on `MIG-005-006-007-shadow-design.md` | done |
| An epic DECISION id is not demanded | unit test on `E4-D12-live-dispatch-terrain.md` | done |
| Coverage counts headings, not mentions | unit test: a prose mention is not coverage | done |
| An empty result set is treated as broken | CLI exits 1 on zero ids or zero nodes | done |
| The guard is actually invoked | `pr.yml` policy step + `guard-inventory.json` | done |

Verification: `check-ticket-graph-coverage`, `check-dependency-graph`, `check-guard-inventory`,
`check-test-inventory`, `check-ci-lanes`, `check-d1-compose`, `check-worker-daemon-boundary` all
pass. New suite 8/8; the existing `dependency-graph` suite is 14/14 and unaffected by the authority
edits. Test-inventory pin bumped 42 to 43, exactly one number, no tree shrank.

## 3. The guard caught its own ticket on its first run

The fail-first run reported four ids, not the three the design predicted: `TRACK-001` was the
fourth, because writing its design doc created a ticket file. That is the correct behaviour and it
was left that way rather than carved out — a guard whose author exempts himself teaches everyone
else that exemptions are available.

## ★ 4. A number in the design doc was imprecise, and the two measures differ

The design said **19 prose-only tickets**. The shipped guard reports **15**. Both are correct and
they count different things:

- **19** — ids appearing *anywhere* in `program-design.md` (including prose) with no ticket file.
- **15** — actual **graph nodes** (`#### ID` headings) with no ticket file.

**15 is the meaningful number**, because `check-dependency-graph.mjs` builds its graph from headings
only; a prose mention contributes no edges and is not tracking. Recorded here rather than quietly
editing the design, since the design is the historical record of what was believed at Start SHA.

Either way the conclusion is unchanged: that direction is the **backlog**, not drift, and it is not
a failure condition.

## ★ 5. CM-013 did NOT flip — the conservative edges did their job

The design's central risk was that adding `DAT-008` with edges to `MIG-005/006/007` would make
crosswalk row `CM-013` *dominated*, so the graph would assert that inherited deferral #1 is closed
when DAT-008 landed slices 1-4 only.

`DAT-008` was therefore added depending on `DAT-004, DAT-005` — what is actually true — and **no**
edge was added from the MIG tickets. Post-change, `check-dependency-graph.mjs` still reports
*"4 undominated rows all declared"*, so CM-013 remains a declared `open_gap`. The node now exists,
and the debt is still recorded as debt.

The node text says so explicitly, so a reader of the graph cannot mistake DAT-008 for complete.
`WRK-008`'s node likewise states that slice 2 is outstanding.

## ★ 6. New information the fix surfaced

With the graph readable, `check-dependency-graph.mjs` reports **three declared open gaps whose
owner is `UNASSIGNED`: `CM-008`, `CM-009`, `CM-012`.** Only CM-009 was previously known to me.

These are recorded debt with no owner — the same shape as inherited deferral #1 before DAT-008
existed. Assigning them is an Integration Gate Owner decision and is **not** taken here.

## 7. Out of scope, deliberately

- **The 15 backlog ids.** Planned, unbuilt work (§4).
- **E4-D12-class gaps** — epic-level decision ids referenced by no ticket. `dependency-graph.mjs`
  already states it does not catch these; this ticket does not change that, and a green run must
  not be read as covering them.
- **Assigning owners to CM-008 / CM-009 / CM-012** (§6).
