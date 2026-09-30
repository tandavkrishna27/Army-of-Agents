# E11 Hardening & Release — decisions

Epic-local decisions. Product-wide decisions are promoted to
`docs/architecture/decisions.md` and linked here.

**Why this file exists and what it may not do.** `docs/replatform/artifact-policy.md` line 71:
*"Autonomous agents may propose decisions in epic-local `decisions.md`; only the designated
custodian or gate owner may lock them."* That sentence is the reason the proposal below is recorded
**here** rather than in `docs/replatform/test-gates.md`: test-gates.md is the normative criteria
document (source-of-truth hierarchy item 4), and writing a candidate gate into it — even one labelled
"proposed" — puts unadopted text where a reader looks for adopted text. Nothing in this file changes
a gate. **No gate was marked mandatory or optional, and no DSK-00, D6-03 or REL-005 criterion was
edited, by the unit that wrote this.**

## E11-D01 — NOT ADOPTED: a narrowed control-plane substitute for the proposed multi-target release-acceptance clause

**Date:** 2026-09-08 · **Ticket:** none (W18, provability wave) · **Status:** `proposed` — **NOT
ADOPTED. This is a founder decision and it has not been made.** Adopting a new release gate, or
changing any gate's pass/fail semantics, criteria or optionality, is outside any agent's scope.

### 0. What was proposed, and what was measured

An independent documentation review proposed promoting to **mandatory** release acceptance a clause
requiring, in substance:

> enroll two distinct owner-desktop devices and enable one managed E2B execution target … separate
> jobs placed and executed across all three … desktop-to-cloud and cloud-to-desktop handoff.

A 5-agent provability wave measured it clause by clause. The recommendation is **DO NOT ADOPT AS
WRITTEN**. Four measured obstructions are filed as findings in this epic's `findings.md` and
declared in `scripts/finding-ownership.json`:

| Finding | What it measures |
|---|---|
| `E11-F004` (HIGH) | "one managed E2B execution target **for one organization**" is structurally inexpressible, and is ambiguous with `environments`' `"Platform default (E2B)"`, which is not an execution target at all. |
| `E11-F005` (HIGH) | Nothing in the enrolment protocol identifies a machine, so "two **distinct devices**" has no evidence source — and the deliberately omitted `deviceThumbprint` would not supply one. |
| `E11-F006` (HIGH) | The D6-04 frozen support matrix has **no device column**; two owner-desktop devices collapse into one row. |
| `E11-F007` (HIGH) | Cross-target handoff has **no mechanism in either direction**, and re-placement is declared out of scope in the source. |

### 1. ★ The review's strongest point is TRUE, verbatim-verifiable, and is not being changed

The review observed that E11 already permits a desktop-disabled, cloud-only beta. It is right, and
the tree says so in three places. Quoted verbatim; **not edited by this proposal**:

- `docs/replatform/test-gates.md`, DSK-00: **"Desktop remains optional."**
- `docs/replatform/test-gates.md`, D6-03: **"Desktop and cross-target mobility remain optional under
  their separate closure rules."**
- `docs/replatform/epics/E11-hardening-release/README.md`: **"Thus neither desktop packaging nor
  mobility blocks a cloud-only non-mobile private beta."**

That is the standing position. The substitute below does not disturb it; it is a *proposal for what
a narrowed gate could say if a founder wants one*, and it deliberately leaves desktop optional.

### 2. What the substitute KEEPS from the review — the five already-proven properties

The review's instinct is sound in one respect: the D1 lane already proves five real properties, live,
against a real stack. The substitute keeps exactly those and claims nothing beyond them. Each is a
**control-plane** property (see §5).

| # | Property | Where it is proven today |
|---|---|---|
| 1 | Fenced object commit and an authorized readback round-trip against a real object store, with a truncated upload failing closed on hash/size | `tests/d1/e6f-05-live-minio.test.mjs` (2 gates) |
| 2 | Stale-fence **non-disclosure**: a stale fence on a real lease is denied byte-identically to a nonexistent lease | `tests/d1/e6f-08-stale-fence.test.mjs` (1 gate) |
| 3 | The three mandated lease faults — pre-ACK disconnect, lost completion ACK, expired lease — each converging to a single winner with the late actor refused | `tests/d1/e6f-09-lease-faults.test.mjs` (3 gates) |
| 4 | Two interchangeable control-plane replicas over one PostgreSQL cannot double-place, exceed capacity, or disagree on a terminal; admission is DB-backed and shared | `tests/d1/e6f-11-two-replica.test.mjs` (6 gates) |
| 5 | An orphaned object left by a fence lost mid-flight is actually **deleted** | `tests/d1/e6f-14-orphan-sweep.test.mjs` (1 gate) |

All thirteen gates run on the `d1-merge-train` Linux lane and SKIP cleanly off `AOA_D1_LIVE=1`.
**W18 renamed all thirteen to say "CONTROL-PLANE gate (harness-driven; no worker daemon, no device)"
and changed no assertion, threshold or pass condition.** That rename is why this table can be
trusted: it names what the evidence is, so a reader cannot mistake it for device or worker evidence.

### 3. The FOUR edits that turn the review's text into the substitute

Edit **(1) is load-bearing**; the other three follow from findings.

1. **"two distinct owner-desktop **devices**" → "two **independently-keyed worker enrolments**".**
   This is the whole difference between a checkable condition and an uncheckable one. The system can
   evidence that two enrolments presented two distinct device keys — `verifyDeviceProof` re-derives
   `sha256(SPKI DER)` from the presented public key after verifying the signature
   (`server/src/services/worker-device-proof.ts:89-92`) — and it can evidence that each held a
   separate fence. It **cannot** evidence that two machines existed (`E11-F005`: two keystores on one
   machine yield two thumbprints; the `.strict()` ten-field `workerHelloV1Schema` carries no
   hostname, MAC, machine GUID or serial). So the substitute asserts the property that has evidence
   and drops the one that does not.
2. **"one managed E2B execution target" → dropped, not narrowed.** Per `E11-F004` there is no
   production creator of a `kind = "e2b"` execution target at any scope, and the org-scoped form is
   contradictory by schema. A gate condition should not name an object the repository cannot write.
   The E2B that runs today is an `environments` row outside job placement; if a founder wants
   coverage of *that*, it belongs to D2/E7 evidence, not to a placement-target clause.
3. **"placed and **executed** across all three" → "placed, leased, fenced and terminalised across
   each enrolled lane".** The five properties in §2 are proven by a harness that plays the worker
   itself — `tests/d1/lib/e6f-harness.mjs:8-9`: *"There is NO live worker-daemon loop: enroll/poll/ack
   are ordinary authenticated HTTP calls the harness makes itself."* A gate that says "executed" would
   be claiming something these gates do not test.
4. **"desktop-to-cloud and cloud-to-desktop handoff" → deleted; D6-05 `disabled` with negative
   evidence.** Per `E11-F007`, `grep -rni "fenced_restart|mobility"` over `server/`, `packages/` and
   `ui/` returns **zero** hits, and the retry path copies the placement snapshot verbatim with the
   comment *"re-placement is JOB-009, out of scope"*. There is no mechanism to exercise in either
   direction. D6-05 already permits `disabled`; the substitute uses that, and adds nothing.

### 4. The substitute gate text, as a proposal only

> **PROPOSED, NOT ADOPTED — no optionality, floor or pass condition anywhere in this programme is
> changed by writing it down.**
>
> **Control-plane multi-enrolment acceptance (candidate).** On one release candidate, against the
> live D1 stack: two independently-keyed worker enrolments, each against a distinct execution target
> of a kind a production path can create, complete separate jobs through
> place → lease → ack → fenced terminal, with (a) each enrolment's device proof verified from its own
> presented public key, (b) each holding its own fence, (c) a stale fence on either denied identically
> to a nonexistent lease, (d) no double-placement, capacity breach or terminal disagreement across two
> control-plane replicas, and (e) any object left by a lost fence swept. Mobility is `disabled` with
> D6-05 negative evidence. Optionality of desktop and of mobility is **unchanged** by this condition.

### 5. ★ What the substitute deliberately does NOT claim

Stated positively, so a later reader cannot infer more than was proven:

- **It does not claim which machine executed anything.** It does not claim two machines existed, that
  a desktop host ran, that a device is distinguishable from a process, or that any physical or
  virtual host was involved at all.
- **It does not claim that a worker daemon ran.** The harness is the acting party. Per
  `FINDING-daemon-provenance-is-not-row-observable.md` (§1–§7, and §8 for the desktop corollary),
  every enrolment-committed fact a real daemon writes is byte-reproducible by a test runner holding an
  enrolment code, so no row-level evidence could distinguish the two even if a daemon did run.
- **It does not claim E2B ran as a placement target.** It cannot; see `E11-F004`.
- **It does not claim cross-target mobility works, is disabled *correctly*, or has been exercised.**
  It records `disabled` and points at D6-05's existing negative-evidence rule.

### 6. ★ The parked work the ORIGINAL clause would resurrect, BY NAME

This is the cost of adopting the review's text as written, so the next reader sees it before ruling.
Ticket-file existence checked at `13caa3227` with `find docs/replatform/epics -name "<id>*"`.

| Parked work | Status on disk | Why the original clause resurrects it |
|---|---|---|
| **DSK-00 clauses 6 and 7** (no desktop installer; no desktop distribution route) | **actively CI-enforced** by `scripts/check-desktop-surface-disabled.mjs` | Mandating two enrolled desktop *devices* means desktop is enabled for a beta Organization, which reverses the guarded absence. |
| **DSK-01 … DSK-10** (per-OS desktop beta gate: signature, lifecycle, keychain, device-local credential contract, folder confinement, offline fencing, orphan output, revocation timing, installed-host journeys, diagnostic redaction) | gate text exists in `test-gates.md`; not run | DSK-00: *"If desktop execution is enabled for any beta Organization or workload, every advertised OS/version must pass this gate on the same release candidate."* |
| **DSK-003**, **DSK-004** | 2 files each; both have result docs (partial) | Named by the E11 README as required for an enabled desktop OS. |
| **MIG-001** | **zero files on disk** | Named by the E11 README as required for an enabled desktop OS. |
| **DAT-006** | design + result on disk | Named by the E11 README as required for an enabled desktop OS. |
| **desktop-covered REL-001 / REL-003 / REL-004 evidence** | **REL-001: zero files.** REL-003: 3 files, `grep -ci desktop` over its result = **0**. REL-004: 7 files, `grep -ci desktop` over its result = **1**, and that one hit (`:138`) is the kill-switch provider-axis enum listing `desktop` as a value — not desktop evidence. | E11 README: an enabled desktop OS *"additionally requires … desktop-covered REL-001/003/004 evidence"*. |
| **MIG-004** (cross-target handoff) | **zero files on disk** | E11 README: *"MIG-004 is required when mobility is advertised."* Clause (i) advertises it in both directions. |
| **A platform-scoped `kind = "e2b"` execution-target creator** | does not exist; no ticket names it | `E11-F004`. |
| **A D6-04 matrix device/enrolment dimension** | does not exist | `E11-F006` — and adding one changes every advertised row's probe and denial floors for every partner. |
| **A machine-binding attestation in `WorkerHelloV1`** | does not exist | `E11-F005`. This is a change to a **FROZEN v1** protocol schema (E1/`packages/worker-protocol`), i.e. an N/N-1 compatibility event under D5-HA03, not a ticket line. |

### 7. What a founder is actually being asked

Nothing is being asked in this file. Three options exist and all three are the gate owner's:

1. **Leave the gates as they are.** DSK-00, D6-03 and D6-05 already permit a cloud-only,
   desktop-disabled, mobility-disabled beta, and the four findings stay open as recorded debt.
2. **Adopt the §4 substitute** as a new acceptance condition, with the §6 costs it avoids.
3. **Adopt the review's clause as written**, accepting §6 in full.

Only the Integration Gate Owner may lock any of these. Until one is locked, this entry stays
`proposed` and **NOT ADOPTED**.
