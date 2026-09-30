# WRK-013 — A durable lease-candidate source for the startup reconciler (E4-F009 successor)

**Epic:** E4 · **Plan node:** `docs/replatform/program-design.md`, `#### WRK-013`
**Depends on:** WRK-008 slice 2b · **Size:** (scope only) · **Status:** scoping
**Owns:** finding **E4-F009** (`epics/E4-worker-daemon/findings.md`)

---

## Why this ticket exists

WRK-008 slice 2b (Sprint 3) composes the poll loop, supervisor, renewal driver and durable event
outbox, but **deliberately does not compose `createStartupReconciler`** (E4 clause 3,
"survives restart"). §4.2 established there is ONE real blocker:
`StartupReconcilerDeps.leaseCandidates` (`supervisor/startup-reconcile.ts:256-257`) has no durable
local source — the event outbox persists **events**, not offers, so the lease-authority probe would
run over `[]` on every boot: a guard that passes because it evaluated nothing (the failure this
programme has hit five times). Reconstructing offers from the event stream is its own ticket, not a
line in a composition ticket.

The other candidate blocker was **withdrawn** on a re-read of the frozen schema:
`ownershipSelector.organizationId` **is** constructible at boot — it is a field of the registered
target profile the self-model read now surfaces, and the frozen schema's `superRefine` guarantees
it non-null for `scope === "organization"`/`"owner"` targets
(`worker-protocol/src/capabilities.ts:307-321`). So the wiring is **conditional** (available for
org- and owner-scoped targets, skipped with a named reason for platform-scoped ones), not
impossible.

It is filed **now**, at WRK-008's completion, so E4-F009 is not left `owned` by a shipped ticket —
which reads as owned by nobody and fails nothing (finding **E4-F013**). WRK-008 slice 2b's result
doc repoints E4-F009's manifest `ticket` to this id.

## What it must build (design written at sprint start, against the tree as it exists then)

A durable local lease-candidate source — a store of accepted lease offers a restarting daemon can
replay into `StartupReconcilerDeps.leaseCandidates` — so the lease-authority probe runs over real
prior state rather than `[]`. Then compose `createStartupReconciler` at boot, conditionally on
`selfModel.registeredTargetProfile.organizationId !== null`, and promote **E4-3-survives-restart**.

## Precondition — when this becomes REQUIRED, not before

When a composed daemon runs leases for real (post-Sprint-5) and a restart mid-lease is a real
operational event whose recovery must be proven. E4-F009 stays **open** (MED) until then.

## Status

Scoping stub. No design steps and no result doc yet — deliberately. Its full design is written at
that sprint's start.
