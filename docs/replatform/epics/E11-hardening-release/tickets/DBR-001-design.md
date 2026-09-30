# DBR-001 — Operator database-restore entrypoint + live DR-restore rehearsal (E11-F002 successor)

**Epic:** E11 · **Plan node:** `docs/replatform/program-design.md`, `#### DBR-001`
**Depends on:** REL-003 · **Size:** (scope only) · **Status:** scoping
**Owns:** finding **E11-F002** (`epics/E11-hardening-release/findings.md`)

---

## Why this ticket exists

REL-003 (Sprint 9 unit 2) shipped the DR/migration rehearsal's **verification core** (the Lane A–E
pure + embedded-PG verifiers) and the **operator runbook**, but it did **not** ship an operator
invocation for the restore leg. `runDatabaseRestore` (`packages/db/src/backup-lib.ts`) has **zero
production/CLI callers**, is **not** barrel-exported from `@armyofagents/db`, and **no `aoa
db:restore` command exists** (only `aoa db:backup`). So a DR ticket whose acceptance says "prove
database restore" has no operator invocation for the restore half — the runbook (step 4) names the
exact `runDatabaseRestore`/`pg_restore` invocation as the interim, by hand.

That residual is E11-F002 (MED, open). It is a concrete, buildable ticket — the natural successor.

It is filed **now**, at REL-003's completion, so E11-F002 is not left `owned` by a shipped ticket —
which reads as owned by nobody and, before this landing, was invisible to the ownership guard
(finding **E4-F013**). E4-F013's landing adds the `successor` check that makes leaving it here
catchable; this stub is the ticket that check points at. E11-F002's manifest entry gains
`successor: "DBR-001"` in the same commit.

## What it must build (design written at sprint start, against the tree as it exists then)

Two parts, in order:

1. **A real operator restore entrypoint** — an `aoa db:restore` command, or an exercised harness
   wrapper over `runDatabaseRestore`/`pg_restore` that is barrel-exported and callable outside a
   test, so the restore leg has an invocation an operator actually runs (not a hand-typed
   `pg_restore`).
2. **A live staging DR-restore rehearsal** that exercises that entrypoint end to end and records the
   measured RPO/RTO against D5 — the owed live leg REL-003's verification core cannot supply on its
   own (it proves the *verifiers*, not a real restore run).

## Precondition — when this becomes REQUIRED, not before

When a staging fleet with a database + object-store backup path is deployed (the same live-infra
dependency the E7-1 canary campaign and the REL-003 rehearsal share). Until then E11-F002 stays
**open** (MED) and the runbook's hand-run invocation is the interim.

## Status

Scoping stub. No design steps and no result doc yet — deliberately. Its full design is written at
that sprint's start, per the go-book's "write the plan at sprint start" rule for work that would go
stale if planned early. This is a **genuine scoping stub for a real residual** (the missing operator
entrypoint + the owed live rehearsal), not a fig-leaf to satisfy the successor check — the review
verified the residual is real and DBR-001 is a genuine inheritor.
