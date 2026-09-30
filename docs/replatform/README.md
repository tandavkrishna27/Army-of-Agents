# AoA Re-platform Program Workspace

This folder is the durable operating record for moving AoA from an in-process/local execution architecture to a cloud control plane with separately deployed workers.

The program is a selective re-platform, not a blank-slate product rewrite. The existing AoA domain model and user experience are preserved unless an epic explicitly changes them.

## Start here

1. [`program-design.md`](program-design.md) — approved architecture, 94-ticket backlog, dependency graph, and delivery waves.
2. [`current-main-crosswalk.md`](current-main-crosswalk.md) — frozen PR #320 execution sinks and their bridge/cutover/disable owners.
3. [`accepted-caveats.md`](accepted-caveats.md) — approved E2B limitations, the Firecracker exclusion, and the non-waivable invariants around them.
4. [`test-gates.md`](test-gates.md) — quantitative D0–D6, named partial, and desktop release gates.
5. [`artifact-policy.md`](artifact-policy.md) — where plans, results, decisions, findings, QA evidence, and handoffs belong.
6. [`agent-execution-guide.md`](agent-execution-guide.md) — assignment preconditions, cross-cutting rules, and copy-ready prompts for agents.
7. [`epics/README.md`](epics/README.md) — live epic status and navigation.
8. [`templates/`](templates/) — mandatory formats for execution records.

## Source-of-truth hierarchy

1. Locked product-wide decisions: `docs/architecture/decisions.md`.
2. Approved re-platform architecture: `docs/replatform/program-design.md`.
3. Frozen observed migration baseline: `docs/replatform/current-main-crosswalk.md`; it describes current behavior but cannot override items 1–2.
4. Approved caveats and normative gates: `docs/replatform/accepted-caveats.md` and `docs/replatform/test-gates.md`.
5. Epic implementation contract: `docs/replatform/epics/<epic>/implementation-plan.md`.
6. Epic-local decisions and findings: the epic’s `decisions.md` and `findings.md`.
7. Execution evidence: ticket results, QA results, and handoffs inside the epic folder.

If two artifacts disagree, the higher item wins until an explicit decision updates it.

## Epic status values

- `backlog`: program design exists; implementation plan has not been approved.
- `planning`: implementation plan is being written or reviewed.
- `planned`: implementation plan is approved and dependencies are being checked.
- `in_progress`: one or more epic tickets are executing.
- `gate_review`: implementation tickets are complete and integration evidence is under review.
- `complete`: the epic exit gate passed and a completion handoff is recorded.
- `blocked`: a concrete external dependency prevents progress and is recorded in findings.

The Integration Gate Owner updates [`epics/README.md`](epics/README.md) and the epic README. Individual agents do not declare an epic complete from their own ticket results.

## Continuing after E0 and E1

The program can continue in the same agent conversation or in a fresh one. This folder is the durable handoff, so progress must not depend on retained chat context.

1. Execute E0 and commit its ticket results, QA records, decisions, findings, and completion handoff.
2. After E0, revalidate and execute E1 while E2 is planned/executed as an independent lane; neither lane waits for the other unless a newly recorded interface finding requires it.
3. After E1 and E2 are both green, write and approve just-in-time plan slices in this order:
   1. Reconcile the completed E1/E2 handoffs and freeze their shared inputs.
   2. E3/E4 core bootstrap through JOB-003 and WRK-004.
   3. E6 `E6-D1-FOUNDATION` through DEP-004.
   4. E3 Job control and E4 Worker daemon remainder.
   5. E5 Workspaces/secrets.
   6. E6 remaining deployment/test work, MIG-003 plus the named `E10-REALTIME-FOUNDATION` gate, and the E10 desktop-foundation tickets whose dependencies are green.
   7. E7 Coding/E2B and, when desktop is in the advertised beta matrix, E10 desktop distribution; CLI-006 waits for the passing `E10-REALTIME-FOUNDATION` handoff in every case.
   8. E8 Browser automation and E9 Service agents; both are mandatory for private beta and proceed in parallel after E7.
   9. E10 current-path/target migration and handoff remainder. Commander, crew, one-shot, lease/resource, and enabled-workload cutovers are mandatory; only desktop and cross-target mobility may remain hard off with conditional negative evidence.
   10. E11 Hardening/release.
4. Execute a plan only when every dependency gate named in the program design is green on main.

Do not fully groom all remaining epics in advance. Findings from E0 and E1—especially protocol constraints, tenancy boundaries, deployment topology, and test-harness behavior—must inform E2 and later plans.

Use this prompt to resume in a fresh agent task:

> Read `docs/replatform/README.md`, `program-design.md`, `accepted-caveats.md`, `test-gates.md`, `agent-execution-guide.md`, the dependency completion handoffs, decisions, findings, and QA results. Verify their gates, then produce the implementation plan for the next unblocked ticket set according to `artifact-policy.md`.

## Recording rule

Do not paste raw secrets, provider tokens, customer source, private browser state, or unredacted logs into this folder. Store durable evidence as redacted summaries and link to controlled CI/object-storage artifacts when bytes must be retained.
