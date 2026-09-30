# BRW-003b — Capture, events, ordering, and the export seam — DESIGN

**Epic:** E8 · **Lane:** B · **Start SHA:** the commit that adds this file
**Index:** [`BRW-003-design.md`](./BRW-003-design.md)
**Blocked by:** **003a's mutation tests must all be killed first** — this builds on the split
semantics, and a surviving mutant there reopens the re-commit hole silently underneath this work.

**Discharges:** stream metadata, screenshots, DOM snapshots (where allowed), trace, video (pending
the §5 decision), downloads; payloads bounded; redaction explicit; ordering tied to event sequence.
Tests: screenshot/trace hash, large download, stale-fence.

---

## 1. Stream metadata — worker events, not stdout

The provider port is FROZEN and its invariant is explicit (`supervisor/provider.ts:169`): **"No
stdout/stderr content crosses this boundary."** The E2B provider returning placeholder
`ref:stdout:<id>` values and discarding the stream is that invariant WORKING.

Metadata rides the frozen `event_upload` op (`worker-protocol/src/transport.ts:762`). **No new event
kind is needed, therefore no STOP on that axis** — `WORKER_EVENT_TYPES` already carries
`browser_observation` and `artifact_prepared`, both `.strict()`.

BRW-002's runner emits NDJSON that nothing reads (its header claimed otherwise and is corrected).
This ticket translates those lines into worker events. **What reads the runner's output is itself
part of the seam** (§6) — stated, not assumed.

## 2. Payload bounding — the per-event half is frozen, the aggregate half is not

**Per-event is already tight and frozen:** `browserObservationPayloadV1Schema` (`events.ts:97-103`)
caps `artifactIds` at 128, `url` at 4096, `title` at 1000 — roughly 11 KB worst case.

**★ The aggregate bound is the live gap, and it collides here first.** `app.ts:340` is a bare
`express.json({ verify: captureRawBody })` — **no limit, so the 100 KB default** — while the 20 MB
parser at `:295` is path-scoped to the import routes. Worker-control mounts after it at `:453`. A
500-event browser batch is ~355 KB, so ~144 events fit. Worse, `event-upload.ts:146-147,193`
classifies `request_too_large` as **terminal**, which `event-outbox-drain.ts:307-308` answers with
`stopStream` — **the stream stops permanently.**

Fix the parser limit for that mount. One line, and it makes `worker-control.ts:409-414`'s own
`payload_too_large` branch reachable instead of dead.

## 3. ★ Redaction — a DECISION, not an omission

The canary scrubber is literal `split`/`join` over supplied canaries, never a regex
(`redaction.ts:31-38`), and has **zero production seeders** — `supervisor.ts:283` says so outright.
It structurally cannot reach a private URL: an `?access_token=` inside a `browser_observation.url`
(up to 4096 chars) survives untouched.

> **DECISION: strip query and fragment from every URL before emit.** Asserted **server-side**,
> because the worker-side scrubber is a verified no-op today. Recorded in the result doc as a
> decision with its reason, not as silent behaviour.

## 4. Ordering — commit-side only, and CONSUMED

**Commit-side works today, no wire change:** `worker-fence-context.ts:123` puts
`attemptId: context.lease.attemptId` into `fenceIdentity`, spread into the mutator at
`artifact-commit.ts:139`.

**Ingest-side is dropped because it does not typecheck:** `job_events.attemptId` is a **uuid**
(`schema/job_events.ts:42`); `job_artifacts.attempt` is an **integer** (`:40`). Linking them needs a
`job_attempts` bridge nobody opened. Consequence stated rather than hidden: **an artifact committed
before its announcing event is stamped NULL until a backfill.**

`versionNumber` cannot carry the order — `job-control.ts:2557-2558` self-documents it as a
best-effort ordinal that concurrent attempts may share.

**The ordered READ has a live, already-authorized home.** `getJobDetail` (`job-operations.ts:167-198`)
selects `jobEvents` with **no `orderBy`** and has **no artifacts section at all**. This ticket adds
the artifacts section, ordered by the new column. That is the production consumer that keeps the
clause non-vacuous — `listForJob` (`tenant/index.ts:213-215`) has zero callers and no ORDER BY, and
is **not** it.

**Gaps are legal.** A failed capture between two successes leaves a hole, so ordering means
**monotonic, not contiguous** — and the test says so, rather than asserting contiguity and passing
by luck.

## 5. Capture — the Playwright lifecycle is two-sided and OPPOSITE

Verified against `playwright-core@1.59.1`, which the lockfile pins and CI installs
`--frozen-lockfile`:

| Artifact | Constraint |
|---|---|
| trace | `flush()` is `abort()` + fs sync, **no zip** (`tracing.js:269-272`). Not `stop({path})`-ed before close ⇒ **silently discarded** |
| downloads | `_deleteAllDownloads` unlinks each artifact file during `close()` (`browserContext.js:421`) |
| **video** | `saveAs` only drains via `reportFinished()` (`artifact.js:64-76`), which for video happens **during** close ⇒ **`saveAs` before close DEADLOCKS** |

`finish()` (`run-session.ts:145-193`) collects downloads, closes, and returns — **there is no
post-close phase.** Required change: **`flushBeforeClose()` → `close()` → `collectAfterClose()`.**

**Trace: IN.** `recordTrace` appears **nowhere** in `packages/browser-runtime` today, while the
frozen workload requires it and BRW-001 persists it at submit (`browser-job-config.ts:147`). It also
yields the scarce thing, given the index's rule: **`recordTrace=true` with no trace artifact is
server-provable**, needing no worker honesty.

### ★ Video — the open decision

The risk is not size. It is that the naive ordering **deadlocks a browser session into a hung
worker** — a different risk class from a missing artifact.

- **If video ships:** the ordering test is this ticket's **highest-value test** and must
  **fail-first against the deadlocking order**, not merely pass against the correct one.
- **If video splits:** `recordVideo=true` must **REFUSE the job**, never silently ignore the toggle.
  Silently ignoring a frozen toggle is precisely the defect this ticket exists to fix, and
  re-shipping it under another ticket number does not make it honest.

**"DOM snapshots where allowed" refuses at GRANT, not only at commit.** The grant request carries
`artifactId` but **not** `kind`, which is exactly why `artifact_prepared` must precede the grant —
the control plane cannot refuse a kind it has not been told about.

## 6. The export seam — ★ IT IS NO LONGER HYPOTHETICAL

DAT-009 slice 1 **shipped the capability** (Lane A), so this ticket designs against a real
signature rather than a named interface awaiting a ruling. In
`packages/worker-daemon/src/supervisor/provider.ts`:

```ts
type ArtifactExportMode = "none" | "grant_upload";

digestArtifact(sandboxId, path, ctx): Promise<{ sha256, sizeBytes }>   // metadata ONLY
exportArtifact(sandboxId, path, grant, ctx): Promise<{ objectKey }>    // a REFERENCE
readonly artifactExportMode: ArtifactExportMode;
```

Three things this confirms about the design that were previously assumptions:

1. **Two-phase, as forced by the frozen grant request.** `digestArtifact` exists precisely because
   `artifactTransferGrantRequestV1Schema` requires BOTH `expectedSha256` and `maxBytes` before a
   grant can be minted, and only the provider can see inside the sandbox.
2. **The reference is genuinely a reference.** `{ objectKey }` — a structured field, not a free
   string. Strictly stronger than `stdoutRef`, which is an unbounded unvalidated string with no
   cap, grammar, schema, resolver or production reader. The port's own comment states the property:
   *"the digest step DESCRIBES the file, the export step MOVES it provider -> object storage, and
   neither hands bytes to the daemon."*
3. **No frozen change was needed.** Support is declared by `artifactExportMode`, NOT by
   `advertisedOperations` — that set is typed to the frozen `ProviderOperation` union, so adding
   to it would have been the E4-D02 STOP. The mode field routes around it without touching
   `packages/worker-protocol`.

### ★ THE GRANT IS A BEARER CAPABILITY — a handling rule, not a note

The port says it outright: *"anyone holding it can write that object key until it expires"*, and
`RedactedResourceProjection` — the only shape cleanup authority ever returns — excludes
`objectGrants` alongside `command`/`env`/`logs`/`secrets`.

**So a grant must never reach a projection, a log line, or an error message.** For BRW-003b that
is concrete: the browser metadata events this ticket emits must not carry it, and the
URL-stripping decision in §3 covers query strings generally — but a grant appearing in an error
path would bypass that entirely. Asserted, not assumed.

**One shared presigned-PUT helper, one test.** The exporter must send `x-amz-checksum-sha256`
itself (`s3-provider.ts:120-142` sets `ChecksumAlgorithm` and returns `headers: {}`). That
knowledge lives in exactly one place today — `tests/d1/lib/e6f-harness.mjs` `putPresignedBytes` —
and the harness runs as piped source text, so the helper must be simultaneously importable and
embeddable.

## 6a. ★ DO NOT REQUIRE THE CAPABILITY — it makes every browser job UNPLACEABLE

Verified by Lane A while attempting it, and it lands directly on this ticket.

The frozen matcher computes `effective = capabilityCeiling ∩ reportedCapabilities` and then requires
**every** entry of `requirements.capabilities` to be in that intersection, or `matches()` returns
`false` (`capabilities.ts:481-489`). **Today nothing is on either side**: no target's
`capabilityCeiling` contains `artifact.direct_upload`, and no worker reports it.

So the one-line change at `job-submission.ts:143` — which currently sends `["browser.chromium"]` —
would send **every browser job to a permanent no-match**. And it fails SILENTLY: the job never
leases. That is the same silent-non-lease class BRW-001 exists to prevent, pointed at this epic.

**Ordered prerequisites, ALL of which must land before requiring it:**

1. a REAL provider implements export — `E2bSandboxProvider` currently declares
   `artifactExportMode: "none"` and declines (DAT-009 slice 1 §4);
2. targets advertise it in `capabilityCeiling` (operator action via the admin route);
3. workers REPORT it in `reportedCapabilities` — and the daemon's only production hello builder is
   `buildDesktopHello`, whose own header says it emits a worker that *"can never be matched work"*.

**BRW-003b does NOT touch `requiredCapabilities`.** Requiring before advertising is the failure
direction. The translation already passes `artifact.direct_upload` through verbatim
(`job-placement.ts:181-185`) and fails closed on an unknown name, so nothing needs changing there
either — the plumbing is pure data on both sides, waiting on the three steps above.

## 7. ★ Deployment prerequisite — the sandbox has no browser

`e2b/e2b.Dockerfile` is `FROM node:22` plus apt basics plus
`npm i -g @anthropic-ai/claude-code @openai/codex`, and its build guard asserts **those two CLIs**
resolve. There is **no Playwright and no Chromium**. BRW-002's browser clauses are green because the
**CI runner** has Chromium; **the deployment target does not.**

Add Chromium to the template **and a `command -v`-style build assertion** — the same shape of guard
that already exists for `claude`/`codex`, whose absence for Chromium is exactly why this went
unnoticed.

Second prerequisite, unchanged: **`local_disk` deployments have no egress path at all** (`presignPut`
is optional; both grant services throw when absent). Both belong in an operator runbook, and there
isn't one.

## 8. Tests — each with its red state

| Case | Assertion | Red state |
|---|---|---|
| screenshot/trace **hash** | `recordTrace=true` ⇒ a trace artifact exists with the store-observed digest | no capture exists at all |
| **large download** | ceiling enforced **at commit** | `maxBytes` is **not** enforced at write — no `ContentLength`, no content-length-range — so a grant-time test would falsely prove a bound that does not exist |
| **stale-fence** | commit refuses; the record stays discoverable | quarantine is **triply dormant**; this ticket does **not** fake that leg |
| ordering | ordered-by-new-column ≠ ordered-by-any-other-key, on a deliberately reversed fixture | `getJobDetail` has no artifacts section |
| bounding | a batch above the mount's limit is refused as `payload_too_large`, not silently terminal | the 100 KB default makes that branch unreachable |
| redaction | a URL carrying `?access_token=` emits with query stripped | verified no-op today |
| video (if in) | **fail-first against the deadlocking order** | no post-close phase exists |

**Precedence pinned, not assumed:** the mutator's comment says fence-first, but `artifact-commit.ts`
runs the store round-trip and the size ceiling **outside** it — so an oversized object under a
terminal-but-resolvable fence returns **`malformed`, not `stale_fence`**.

**Mandatory parity mutation:** `GOVERNED_EFFECT_OPS` (`per-op-adapter.ts:74`) and
`CLEANUP_DENIAL_LABEL` (`:76-82`) are hand-maintained with **no parity guard** — an operation omitted
from either is silently exempt from post-fence withdrawal and cleanup denial, suite green.

## 9. A live false claim of enforcement, sitting on this ticket's own test

`check-artifact-commit-vectors.mjs:11-13` claims *"two independent implementations (the server and
this reference) pin to one fixture, neither can silently diverge."* **Already false** —
`artifact-commit.ts:121` rejects `actualSizeBytes > maxArtifactBytes` and the reference models no
ceiling. It sits directly on the "large download" case. Fix: add the ceiling to the reference **and**
a server-side fixture consumer, so the header becomes true rather than louder.
