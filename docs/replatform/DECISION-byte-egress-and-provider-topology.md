# DECISION — byte egress, and the provider topology it is coupled to

**Answers:** [`DECISION-REQUEST-byte-egress.md`](./epics/E8-browser-automation/DECISION-REQUEST-byte-egress.md) (Lane B, BRW-003)
and the provider-topology fork in [`WAVE-4-RESEQUENCE.md`](./WAVE-4-RESEQUENCE.md) §3.7 (Lane A).
**Status:** gate CLOSED — the verification this turned on is answered. **Crosses:** E4 (port), E5
(artifact pipeline), E8 (needs the bytes). **Budgeted in:** none of them, still.

---

## ★ NET DECISION AS OF REVISION 2 — read this, not the archaeology below

Two revisions have withdrawn parts of the original analysis. Rather than make a reader
reconstruct the truth from three layers, here it is in one place. **§0-§4 below are retained as
history; where they disagree with this section, this section wins.**

**The decision:** the provider reads the file from inside its sandbox and PUTs it **directly to
object storage** under a short-lived, prefix-scoped, **worker-minted** presigned grant. The
`SandboxProvider` port carries a **grant inbound** and a **reference outbound**, and **never
bytes**.

**Two provider operations, not one.** The frozen grant request requires `expectedSha256` AND
`maxBytes`, so the worker must know the digest and size *before* it can ask for a grant — and
only the provider can see inside the sandbox. The sequence is therefore: digest-and-size →
mint grant → export-under-grant → commit.

**NO FROZEN PROTOCOL CHANGE IS REQUIRED.** The capability is advertised through
`artifact.direct_upload`, which already exists in the frozen `KNOWN_WORKER_CAPABILITIES`
(`capabilities.ts:47-60`) and is used by nothing. The two operations live in
`packages/worker-daemon`'s port, which is not frozen. **There is no E4-D02 STOP, no custodian
approval, and no D0-T04 corpus.** (REVISION 1 said otherwise; REVISION 2 corrects it.)

**Option B remains rejected** — desktop browser evidence must not become a second project.

### What is IN CODE today (verified, not asserted)

| Piece | State |
|---|---|
| Grant TTL clamped to a 300s ceiling | **wired** — `artifact-transfer-grant.ts` |
| Grant INTENT recorded at mint | **wired** — `recordArtifactGrantIntent`, fence-guarded |
| Retention control-plane-owned at commit | **wired** — `resolveStoredRetention` in `artifact-commit.ts` |
| Migration 0265 (granted partial-unique + expiry index) | landed, idempotency-verified |
| Sweep eligibility decision + runner | **built, and NOTHING CALLS THE RUNNER** |

### What has to be done, in order

1. **DAT-011 — wire the sweep trigger.** Designed, not built. This is the only piece that is
   *built but dead*, and therefore the first thing to fix.
2. **DAT-009 slice 1 — the contract capability**, fake-provider implementation and conformance.
   **UNBLOCKED** by REVISION 2; it was held behind a custodian STOP that does not apply.
3. **Advertisement data — ★ NOT YET. Doing this now would make every browser job UNPLACEABLE.**

   Verified while attempting it. The frozen matcher computes
   `effective = capabilityCeiling ∩ reportedCapabilities` and then requires **every** entry of
   `requirements.capabilities` to be in that intersection, or `matches()` returns `false`
   (`capabilities.ts:481-489`). Today **nothing** is on either side: no target's
   `capabilityCeiling` contains `artifact.direct_upload` (grepped across the D1 compose, D1
   seeds and `docker/d1/`), and no worker reports it.

   So requiring it — the one-line change at `job-submission.ts:143`, which currently sends
   `["browser.chromium"]` — would send every browser job to a permanent no-match.

   Two things that make this SMALLER than it looks, both already true:
   - `artifact.direct_upload` is **already accepted** by the request→frozen translation
     (`job-placement.ts:181-185` passes all twelve frozen names through verbatim), so **no code
     change is needed there**. The translation also fails closed on an unknown name.
   - The plumbing is therefore pure data on both sides.

   **Ordered prerequisites, all of which must land first:**
   1. ~~a REAL provider implements export — `E2bSandboxProvider` currently declares
      `artifactExportMode: "none"` and declines (DAT-009 slice 1 §4);~~ ✅ **DONE 2026-09-04
      (PR #353)** — `E2bSandboxProvider` declares `"grant_upload"` and implements both methods,
      proven against a real E2B sandbox. Nothing about the decision changes: the port still
      carries a grant inbound and a reference outbound, and never bytes. Prerequisites 2 and 3
      below are untouched, so no job is routed to it yet;
   2. targets advertise it in `capabilityCeiling` (operator action via the admin route);
   3. workers REPORT it in `reportedCapabilities` — which flows from the daemon's hello builder,
      and the daemon's only production builder is `buildDesktopHello`, whose own header says it
      emits a worker that *"can never be matched work"* (spike F3).

   Only then does requiring it in `requiredCapabilities` become correct. **Requiring before
   advertising is the failure direction**, and it fails silently: the job simply never leases.
4. **DAT-009 slice 3 — the worker-side consumer**: digest → grant → export → commit. The first
   production consumer of the DAT-002 grant pipeline.
5. **Lane B: BRW-003 is fully unblocked** — both the metadata half and the byte-movement half.

### Still open, and NOT part of this decision

- `maxBytes` and `checksumSha256` are handed to `presignPut` and **used by neither**, so a
  presigned PUT admits an unbounded write of arbitrary content for its whole TTL
  (`DAT-009-terrain.md` §9). Its own ticket — binding them moves a tested failure earlier.
- Retention is **stored** trustworthily and **enforced** nowhere (DAT-010 §5).

---

## 0. The two escalations are ONE decision

Lane B asked "how does a byte leave a sandbox?" and costed three options. Lane A asked "how does a
real provider reach the daemon at all?". **The byte-egress document mentions `adapter-manager`,
out-of-process and the credential ban exactly zero times** — not Lane B's error, since that
constraint lives in a file E8 does not own. But it means Option A was costed against a provider
topology that may not hold.

Decided together, in dependency order, below.

## 1. DECISION

**Option D — the provider uploads directly to object storage under a worker-minted, short-lived,
prefix-scoped presigned grant; the port carries a grant INBOUND and a reference OUTBOUND, never
bytes.**

Concretely: **worker mints → hands the opaque grant into the provider → provider reads the
in-sandbox file and PUTs it → worker commits.**

**Option B is rejected** (founder decision): desktop browser evidence must not become a second
project, and Lane B's own reasoning is decisive — bypassing the cleanup-authority guarantee leaves
it *stated and no longer true*.

**Option A is not chosen**, but is the fallback if §4's residuals prove unworkable.

## 2. Why D is not a compromise — it is the declared architecture

`docs/architecture/distributed-execution-authority.md:11` (echoed at
`E0-foundation/implementation-plan.md:378`):

> Snapshots, logs, traces, downloads, checkpoints, artifacts | S3-compatible object storage |
> **Transfer through short-lived prefix-scoped grants**

Moving bytes through the provider port would be the **deviation**. The option set omitted the
design the programme had already committed to.

Against Lane B's four walls, all of which stay standing:

| Wall | Under Option D |
|---|---|
| (a) the port has no file operation | it needs none — it carries a grant + a reference |
| (b) the command channel excludes bytes | **honoured**, not amended |
| (c) `denyControlPlane` is a frozen literal | irrelevant — object storage is not the control plane, and the uploader is the provider, not the guest |
| (d) the E2B seam is not surfaced | it stays unsurfaced; `readFile` is used *inside* the provider implementation |

Both §3 constraints of the request resolve for free: the **cleanup-authority no-customer-bytes proof
is untouched** (no bytes traverse `inspect`), and **bounded memory stops being a port problem**.

## ★ 3. The verification this turned on — ANSWERED, twice

**Can a grant be redeemed by a party other than the worker that requested it?** **Yes.**

- The issued grant carries **no principal, no `workerId`, no `leaseId`, no fence token** — verified
  by reading the frozen schema (`packages/worker-protocol/src/artifacts.ts:411-428`). The fence
  tuple exists only on the *request* (`:365-393`) and is consumed at mint.
- Redemption needs no additional auth: `server/src/storage/s3-provider.ts:142` returns
  `headers: {}`.
- **Live proof:** `tests/d1/lib/e6f-harness.mjs:1503-1521` redeems a presigned PUT **from a
  different container than the one that minted it**, sending only two checksum headers and no
  credential.

**What is NOT possible:** the provider minting its own grant. Both mint paths authenticate a worker
device identity and hard-check `body.workerId !== auth.workerId`
(`artifact-transfer-grant.ts:61`). That is *correct* and the design keeps it: authority stays with
the worker; the provider receives a capability, never a principal.

## ★ 4. Four residuals the design MUST answer — three of which correct Lane A's own framing

**4.1 — The port DOES change. "Only a reference" was wrong.** For the provider to upload, a grant
must travel **inbound**, and `ProviderOpContext` is `{deadlineMs, idempotencyKey}`
(`provider.ts:139-142`) with no field for it. The change is **additive and byte-free** (grant in,
reference out) and lands in `packages/worker-daemon`'s port — **not** in the frozen
`packages/worker-protocol`, so it is not an E4-D02 STOP. But "no port change" would have been a
false claim.

**4.2 — There is no process boundary today.** Lane A described the provider as running
"out-of-process behind `adapter-manager`". In this tree the provider is an **in-process injected
object** (`supervisor.ts:88`), and `provider.ts:16-21` says the port is transport-agnostic
precisely so a networked driver can bind it **later**, that driver being "explicitly out of CORE".
`adapter-manager` appears **only** in `docker-compose.staging.yml` and
`staging-manifest-invariants.mjs` — declared and enforced-against, with zero implementation in
`packages/` or `server/src`. Both facts hold: the manifest *forbids the credential on worker
surfaces*, and the code has *no boundary yet*. Design against what exists; if a boundary is
introduced, the grant crosses it **as a bearer secret**.

**4.3 ★ A PRESIGNED PUT OUTLIVES THE FENCE THAT AUTHORISED IT.** The fence is checked **only at
mint** (`artifact-transfer-grant.ts:83-90` — `lockActiveFence`), and the signed URL then stands for
up to 300s carrying no fence material. If the lease is lost or the attempt superseded mid-flight,
**the PUT still succeeds** — S3 knows nothing about fences — landing bytes in the *ordinary*
`organizations/<org>/jobs/<job>/attempts/<n>/` prefix, after which commit refuses `stale_fence`.
DAT-006 quarantine does **not** cover this: it writes to a distinct `quarantine/` root
(`artifacts.ts:81-83`). No sweeper for uncommitted ordinary-prefix objects was found.

This window exists today. Handing the grant to a longer-lived process **widens** it, so the design
owns it: shortest viable TTL, and either a sweeper or an explicit accepted-orphan policy.

**4.4 — This is the FIRST production consumer, not an extension of a working pipeline.**
`artifactTransferGrant(...)` (`transport/client.ts:168`) has **zero callers** outside its own
declaration and one client test; `result-commit.ts:25-26` records the live grant→PUT→commit
round-trip as a documented CLI-003 non-goal (DAT-002 slice 7). The only real presigned PUT ever
performed is the D1 harness. **A complete, tested server half says nothing about the caller half
existing** — the failure shape this programme keeps re-learning.

## ★ 4b. REVISION 1 — this IS an E4-D02 STOP. §4.1 said it was not, and that was wrong.

Found while writing DAT-009 slice 1's design, by reading the contract package rather than
reasoning about it.

§4.1 concluded "not an E4-D02 STOP" from the fact that `ProviderOpContext` lives in
`packages/worker-daemon`. That is true and it is not the binding constraint. **The provider
OPERATION VOCABULARY is frozen:**

- `PROVIDER_OPERATIONS`, `CORE_PROVIDER_OPERATIONS` and
  `OPTIONAL_PROVIDER_OPERATIONS = ["checkpoint","restore","health"]` are all defined in
  `packages/worker-protocol/src/capabilities.ts:125-153` — the FROZEN package.
- The contract package states it plainly: it is defined "OVER the frozen E1 `PROVIDER_OPERATIONS`
  vocabulary; **it invents no operation**" (`sandbox-provider-contract/src/port.ts:4-9`).
- Advertisement is doubly pinned: `supportedOperations` is
  `z.array(providerOperationSchema).min(CORE.length).max(PROVIDER_OPERATIONS.length)`
  (`capabilities.ts:178`) — an unknown value fails the enum, and the array length ceiling is
  fixed at the current vocabulary size.

**So a provider capability that can be ADVERTISED cannot be added without changing the frozen
protocol.**

### The fork — for the Protocol/Schema Custodian, not for this lane

**(i) Add `digest` + `export` to `OPTIONAL_PROVIDER_OPERATIONS`.** An E4-D02 STOP: custodian
sign-off plus D0-T04 evidence. Gives real negotiation — a target profile advertises support, and
placement can route a browser job only to a target that can return its evidence.

**(ii) Add methods to worker-daemon's `SandboxProvider` only**, declining via the existing
`UnsupportedProviderOperation`. No frozen change. But the capability is **unadvertisable**, so
placement cannot route on it: a browser job lands on a non-exporting target, does all its work,
and fails at the end with no evidence.

**Recommendation: (i).** `OPTIONAL_PROVIDER_OPERATIONS` exists for exactly this shape —
checkpoint/restore/health are the same thing: real capabilities that some providers have and
others do not. And the `.max(PROVIDER_OPERATIONS.length)` ceiling shows the schema was written
expecting that list to be authoritative. Option (ii) buys speed by making a capability invisible
to the component whose job is to match work to capability, which is the same class of mistake as
`buildDesktopHello` emitting a worker that can never be matched.

**Rejected without further consideration:** carrying the export as an opaque `params` payload on
an existing operation such as `execute`. It would hide a byte-moving capability inside a black-box
map and make the port's "no bytes" property stated-but-false — the failure mode this whole decision
exists to avoid.

### Consequence for sequencing

DAT-009 slice 1 (contract capability + fake provider + conformance) **cannot be built as specified
until this fork is resolved**, because the operation it would conform is not expressible. Slices 2
(fence-window policy) and 3 (the worker-side consumer) are unaffected in their server-side halves
and remain available.

## ★★★ 4c. REVISION 2 — THE FROZEN CHANGE IS UNNECESSARY. Option (ii) was rejected for a FALSE reason.

The founder authorised the E4-D02 frozen change. **It should not be made**, and the reason is an
error in REVISION 1's own fork analysis.

REVISION 1 rejected option (ii) — worker-daemon methods only, no frozen change — because the
capability would be **"unadvertisable"**, so placement could not route a browser job to a target
able to return its evidence. **That premise is false.**

### `artifact.direct_upload` already exists, frozen, and means exactly this

`KNOWN_WORKER_CAPABILITIES` (`capabilities.ts:47-60`) is the closed v1 capability vocabulary and
already contains **`artifact.direct_upload`** — alongside `secret.proxy`,
`provider.checkpoint_v1`, `sandbox.filtered_egress` and the rest. It is documented as part of the
closed twelve in `PRT-006-result.md:17` and it appears in the frozen conformance vectors
(`docs/contracts/worker-protocol/v1/conformance.json:1552,1608,1730,1769`).

**Nothing in the application uses it.** It is a first-class advertisable slot that means precisely
"this can upload an artifact directly" — which is Option D in four words.

The matching path is complete without any change: a job declares
`requiredCapabilities` (`job-leasing.ts:370`), a target advertises `capabilityCeiling`, and
matching clamps one against the other. So placement CAN route on this today.

### What that changes

- **The capability is advertised through the existing frozen vocabulary**, not through a new
  provider operation.
- **The two operations live in `packages/worker-daemon`'s port**, which is not frozen — the
  additive grant-in/reference-out change of §4.1.
- **No E4-D02 STOP. No custodian. No D0-T04 corpus. No superseding E1 QA record or handoff.**

### Why this matters more than the effort saved

Measured during the terrain: `git diff b7a842870 HEAD -- packages/worker-protocol/src ':!*.test.ts'`
is **EMPTY**. The frozen package's runtime source has **never been changed since the freeze**.
This would have been the first.

And the nearest precedent is a precedent for *refusing*. E3-F004 (`E3-job-control/findings.md:99-131`)
records a legitimate need that made the frozen check fail; the operator decision was to *"keep the
frozen fixture byte-identical but correct the checker"*, with *"changing the fixture … or bypassing
the check is not authorized"*. **Four tickets — DAT-001, WRK-007, BRW-001, WRK-008 slice 1 — hit
this fork and all four routed around it.** This is the fifth, and it routes around too.

> **The lesson, for the third time this session: check whether the mechanism already exists before
> costing a new one.** The real provider existed. The upload grant existed. The capability existed.
> Each time the honest answer made the work smaller, and each time I had already written down a
> plan that assumed otherwise.

### What is still required

`browserArtifactRetention`-style advertisement is not free of work: `artifact.direct_upload` must
be **added to the relevant targets' `capabilityCeiling`** (server-owned, written by the existing
admin `PUT …/placement-profile` route) and **declared in browser jobs' `requiredCapabilities`**.
Both are data, not protocol.

**DAT-009 slice 1 is UNBLOCKED** and no longer waits on a custodian.

## 5. Deployment prerequisite

`presignPut`/`presignGet` are **optional** on the storage port (`server/src/storage/types.ts:62-67`)
and both grant services throw when absent. On `local_disk` deployments there is **no egress path at
all**. That is a deployment prerequisite to state in the runbook, not a design flaw — but the
current fallback is "throw", and browser evidence would simply not work there.

## 6. Where the obligation lives

A capability — *given an upload grant and an in-sandbox path, export the file and return a
reference* — belongs in `packages/sandbox-provider-contract`, implemented per provider, **not** as a
byte-moving method on `SandboxProvider`. That is what keeps Lane B's "E2B only" objection from
applying: a desktop provider implements the same capability against its own storage.

## 7. What each lane does now

- **Lane B:** BRW-003 is unblocked to design against this record. Bytes are the provider's problem;
  BRW-003 owns metadata, ordering, retention/redaction, and the reference→artifact commit.
- **Lane A:** owns the port's additive grant-in/reference-out change (4.1), the fence-window policy
  (4.3), and the first production grant consumer (4.4).

---

## ★ 8. LANE B RE-VERIFICATION — two claims in this record do not hold

Appended, not edited, so the original reasoning stays readable. Both were found while designing
BRW-003 against this record, and both were verified by opening the files.

### 8.1 ★ WITHDRAWN — my "second Custodian STOP" claim was wrong, and Lane A was right

**What I claimed:** that §4.1's exemption does not hold, because
`HANDOFF-lane-b-browser-service.md` §7 ("Frozen — never edit") lists the worker-daemon
`SandboxProvider` port alongside `packages/worker-protocol/`; therefore the grant-in/reference-out
change was a second Protocol/Schema Custodian STOP rather than Lane A's to make.

**Why it was wrong.** That document is titled *"Lane B kickoff"* and addresses "you" throughout.
§7 is a **LANE-B-SCOPED prohibition, not a global freeze** — it tells Lane B not to edit that port,
which §7 of THIS record assigns to Lane A. I generalised a scoped instruction into a programme-wide
one and escalated on the strength of it.

**Demonstrated by the work landing:** DAT-009 slice 1 implemented the export capability in
`packages/worker-daemon` with **`packages/worker-protocol` untouched** — no frozen change, no
custodian STOP, no D0-T04 corpus — because `artifact.direct_upload` is an **already-existing frozen
capability name**. `packages/sandbox-provider-contract` was left alone for the sharper reason that
its driver is keyed by the frozen `ProviderOperation` union, so a conformance case there *would*
have required a frozen change.

**What survives:** the E4-D02 STOP on the OPERATION VOCABULARY is real and was correctly avoided —
`OPTIONAL_PROVIDER_OPERATIONS` is frozen at three values and `supportedOperations` is doubly
pinned, which is exactly why the two new methods are declared by an `artifactExportMode` field
rather than added to `advertisedOperations`.

### 8.2 The `stdoutRef` precedent is a NON-guarantee, and slice 7 is COMPLETE

**(a)** §1/§4.1 justify the reference shape as "exactly what `stdoutRef`/`stderrRef` already do".
`grep -a` finds `stdoutRef` **nowhere in `packages/worker-protocol`**. Its only definition is
`packages/worker-daemon/src/supervisor/provider.ts:176` — an unbounded, unvalidated `string`: no
length cap, no grammar, no zod schema, no resolver, and no production reader. The E2B provider
emits literal placeholders (`ref:stdout:<sandboxId>`) and discards the stream. A 5 MB string
satisfies that "reference". **An export reference modelled on it inherits a non-guarantee** and
must instead be a bounded, strictly-validated scalar — the argument for it cannot be "analogous to
stdoutRef".

**(b)** §4.4 records the live grant → PUT → commit round-trip as a DAT-002 slice-7 non-goal.
**Slice 7 is COMPLETE**: `DAT-002-live-minio-result.md:3` — "COMPLETE + Linux-CI-green",
`d1-merge-train` run `31885553697` = success, 13/13; `tests/d1/e6f-05-live-minio.test.mjs` proves
the https round-trip against MinIO-over-TLS plus a toxiproxy truncated-upload fail-closed case.
The stale wording survives in `DAT-002-result.md:3`, never amended — that is the propagation path
into this document. §4.4's conclusion (this is the first production CONSUMER) still stands; only
its slice-7 premise is stale.

### 8.3 What Lane B does with this

Stream metadata does NOT need the port. It rides the frozen `event_upload` transport op
(`packages/worker-protocol/src/transport.ts:762`) through the worker's existing `EventSequencer`,
durable outbox and per-run redaction (`supervisor/redaction.ts`) — a stdout pipe would have
bypassed all three. BRW-002's runner header claimed the host reads its NDJSON on stdout; that
contract was false against the port's stated invariant (`provider.ts:169`) and is corrected.
