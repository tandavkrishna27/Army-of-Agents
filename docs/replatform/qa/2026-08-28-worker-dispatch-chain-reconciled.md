# The worker-dispatch chain, reconciled against the current tree

**Status:** reconciliation (tracking unit — no product code) · **Date:** 2026-08-28
**Worktree:** `C:\e3` · **Branch:** `docs/replatform-program`
**Executes:** [`WAVE-4-RESEQUENCE.md`](../WAVE-4-RESEQUENCE.md) §5 **STEP 0** — "fix the tracking +
re-derive every no-owner claim", reconciled to the current tree (not applied blindly).
**Supersedes at the chain level:** the "four unowned mechanism links" framing in WAVE-4-RESEQUENCE §3
and the adapter-manager scope §9, both of which report the pre-Sprint-2.5 terrain.

---

## 0. TL;DR — the chain is materially different from WAVE-4's snapshot

WAVE-4-RESEQUENCE mapped a **seven-link** live-worker-dispatch chain and reported **four links with no
owner** (container identity, POSIX enrolment input, session acquisition, matchable hello), one
half-owned (self-model), one partial (loop composition), one enforced-but-unbuilt (provider transport).

**That snapshot is dated 2026-08-23 (commit `8274d056d`). Sprints 2.5 / 2.75 / 3 landed 2026-08-25/26,
AFTER it — and they are exactly the sprints that touch four of those links.** Re-derived from the
current tree with a citation per verdict:

| # | Link | WAVE-4 (2026-08-23) | **Current tree** | Owner (at tip) |
|---|------|---------------------|------------------|----------------|
| 3.1 | Container identity | NO OWNER | at reconcile NO OWNER → **WRK-014 BUILT-INERT** (later same day) | **WRK-014 (built, unwired)** |
| 3.2 | POSIX enrolment input | NO OWNER | **NO OWNER** (unchanged) | **WRK-015 ✅ SHIPPED** (Part 2 d1 proof → WRK-017) |
| 3.3 | Session acquisition | NO OWNER | **OWNED** — mechanism shipped; one restart residual | WRK-010 slice 2 |
| 3.4 | Matchable hello | NO OWNER | **OWNED** | WRK-011 (+ WRK-008 slice 2b) |
| 3.5 | Self-model read | HALF OWNED | **OWNED** (both halves) | WRK-008 slice 1 + slice 2b |
| 3.6 | Loop composition | PARTIAL (no start seam) | **OWNED / composed** behind the flag | WRK-008 slice 2b |
| 3.7 | Provider transport | enforced, unbuilt | **UNBUILT** (unchanged) | **none → DEP-012 (new)**; wire = DEP-011 |

**The honest consequence (WAVE-4-RESEQUENCE's own STOP condition).** The distributed-worker path is
**substantially closer than the seven-mostly-unowned-links framing implies.** The chain's *mechanism*
— session acquisition, the matchable hello, the self-model read, and the composed poll-loop+supervisor
— is **built and composed behind the default-off flag, awaiting a real exercise (Sprint 5 / E7-1).**
What is genuinely **unowned/unbuilt is three links, not four-plus**: container identity (3.1), POSIX
enrolment input (3.2), and the adapter-manager provider host (3.7). This is a different plan than
"sequence four unowned mechanism links with an owner per link." It is stated here rather than folded
into a list because it changes what the next builder does.

**One correction that colours everything:** the adapter-manager scope §9 (2026-08-28) re-states
WAVE-4's "four unowned / self-model half-owned / start seam missing" verdicts **without reconciling
them against Sprints 2.5/2.75/3** — it repeats a snapshot three sprints stale. Where that doc and the
tree disagree, the tree wins; this doc is the reconciliation of record. (The adapter-manager scope §8
provider-topology CONTRACT is unaffected and stands — it is a decision, not a terrain claim.)

---

## 1. Method

Every verdict below is **re-derived from the current tree**, not carried from WAVE-4 or the scope doc.
"Owned" = a real (non-placeholder) producer exists, shipped with a result doc. "Unowned" = the only
producer is a deliberately-unmatchable / placeholder path, or nothing produces it. Where a link moved,
the shipped result doc and the load-bearing source symbol are both cited. The `blocker`-flag-schema
defect WAVE-4 §0 warns about does not recur here: these are direct source reads, not a refuter poll.

**Timeline (the whole reason the snapshot is stale), from `git log`:**

| Artifact | Commit | Date |
|---|---|---|
| WAVE-4-RESEQUENCE.md | `8274d056d` | 2026-08-23 |
| WRK-010 slice 2 (Sprint 2.5) | `16c7dc705 … 987923f51` | 2026-08-25 |
| WRK-011 (Sprint 2.75) | `5c10a0f32 … 8d5376f83` | 2026-08-25 |
| WRK-008 slice 2b (Sprint 3) | `a62b8e06a … f8bfac157` | 2026-08-26 |
| adapter-manager scope | `fd8c8eba6 … 981a08a45` | 2026-08-28 |

---

## 2. Link by link — reconciled

### 3.1 Container identity — **STILL UNOWNED** (confirmed; the hard gate) → **WRK-014 (new)**

> **★ Update (2026-08-28, later same day): WRK-014 is now BUILT-INERT.** The verdict below (unowned at
> reconcile) drove the ticket. WRK-014 shipped the fix: a distinct `file_record` custody mode +
> `resolveCustody` arm, a crash-atomic `FileRecordStore` (identity persisted inline) + the daemon's own
> `Uint8Array`-safe codec, and a `runContainerHost` that reads `AOA_WORKER_STATE_DIR`, asserts the state
> dir writable pre-socket, builds the stores and injects them. It landed **UNWIRED** — the Dockerfile CMD
> still runs `worker-daemon.js` and no compose switched to `file_record` — so no deployed container
> changed. **WRK-015 shipped the POSIX enrolment-input fix** (the validator-level crash-loop hazard is
> gone); **activating the container path on d1** (a compose `command:` override onto `container-host.js` —
> NOT a CMD repoint, per Correction 1 — plus a first-enrol proof) is **WRK-017** (WRK-015 Part 2 split; the
> d1 harness has no worker-enrol flow). See `WRK-014-result.md` / `WRK-015-result.md`. 3.1 moves from
> "unowned" to "owned, built-inert".

WAVE-4 §3.1 stands, re-verified at tip:
- `MountedSecretKeyStore` (`packages/worker-daemon/src/identity/key-store.ts:61`) has **zero production
  constructors** — every `new MountedSecretKeyStore(...)` is under `__tests__/` (`key-store.test.ts`,
  `key-store-corrupt.test.ts`). `mounted_secret` has no runtime key-**load**.
- The only production `DeviceRecordStore` — `createOsRecordStore`
  (`packages/worker-keystore/src/identity-store.ts:114`) — is injected only by `desktop-host.ts:133,139`.
  The worker image (`docker/worker/Dockerfile:6,112`, closure = worker-daemon + worker-protocol + pino,
  CMD `node dist/bin/worker-daemon.js`) **never copies `worker-keystore`.**
- `bin/worker-daemon.ts` boots `mounted_secret` (`:281` — "every deployed compose file uses that mode");
  the enrolment block is gated `config.keyStoreMode === "os_keychain" && deps.identityStore &&
  deps.receiptStore` (`:304`), never entered on a container → no enrolment, no `generateDeviceKey`, no
  identity.

**Verdict: unowned.** The only producer of a container identity is the `mounted_secret` *label* that
passes `resolveCustody` with no key behind it. The hard gate on all later links — nothing downstream
runs on a container until this exists. **Now tracked: `#### WRK-014` + `WRK-014-design.md`.**

### 3.2 POSIX enrolment input — **✅ SHIPPED (WRK-015, 2026-08-28)**

WAVE-4 §3.2 stood, re-verified at reconcile: `assertLocalAbsolutePath`
(`packages/worker-daemon/src/enrollment/enrollment-input.ts`) normalized `/`→`\` and required
`/^[A-Za-z]:\\/`, so the `{kind:"path"}` arm threw `EnrollmentInputError` for every POSIX absolute
path (`/worker/state/ticket`). It was a DSK-001 (Windows) deliverable; the `{kind:"env"}` arm is
platform-neutral but the path arm was Windows-only. **WRK-015 SHIPPED the fix:** `assertLocalAbsolutePath`
is now platform-aware (an optional `platform` param, mirroring `file-custody.ts`), threaded from
`readEnrollmentInput`. `win32` → the drive-letter arm, unchanged; else → a POSIX arm that mirrors
`worker-protocol/policy.ts isSandboxSecretFilePath`'s SHAPE (bound, no backslash/control bytes, no
empty/`.`/`..` segments) MINUS the fixed root PLUS an explicit leading-`/` check — stated positively, not a
loosened denylist, preserving the three DSK-001 security properties (locality BEFORE the read, content-free
faults, the `enrollmentCode` redaction name). **Part 2 — the CI-exercised d1 first-enrol proof — SPLIT to
WRK-017** at WRK-015's Step-0 gate (the d1 harness has no worker-enrol flow; see `WRK-015-result.md`). **Now
tracked: `#### WRK-015` (shipped) + `WRK-015-result.md`; `#### WRK-017` + `WRK-017-design.md` for the d1
proof.**

### 3.3 Session acquisition — **MOVED to OWNED** (WRK-010 slice 2), with one unowned restart residual

WAVE-4 §3.3: "no path for an already-enrolled device to obtain a session." **Stale.** WRK-010 slice 2
(Sprint 2.5, shipped result doc) built the mechanism:
- `enrollOnce` gained an `onSessionMinted` SINK at the point `result.session` was dropped
  (`enrollment/enroll-once.ts:323`, declared `:147`) — the enrolling boot now CAPTURES its first session (integration
  `S2-A1`, real enrol → sink → `store.current()`).
- The device-proof renewal client `createSessionRenewer` (`identity/session-renewal.ts`) +
  `SESSION_RENEW_PATH` + `sessionRenew()` (`transport/client.ts`) + `createWorkerSessionLifecycle`
  (`identity/worker-session-lifecycle.ts`) — a running device renews its session without re-enrolling
  (integration `S2-A2`, `s1 !== s0`; sustained past T0+15min). **Finding E4-F007 resolved.**

**Verdict: the chain link the campaign needs is owned.** A freshly-enrolled worker gets a first session
(sink) and keeps it fresh (renewal). **Residual, honestly unowned:** a *cold restart after the code
window* cannot acquire a first session — "No live session, no live code, sessions not persisted →
re-enrolment required … owned by no ticket in this scope" (WRK-010-slice-2-result.md §5, R2). This is a
restart-resilience gap, **not a first-dispatch blocker** (a fresh enrolment gets a session), so no
ticket is minted for it here — it is recorded in §5 below as tracked-but-unowned debt.

### 3.4 Matchable hello — **MOVED to OWNED** (WRK-011 + WRK-008 slice 2b)

WAVE-4 §3.4: "the daemon's only producer is `buildDesktopHello`, deliberately unmatchable … one-shot
snapshot with no update channel … no `CapacityProbes` implementation." **Stale on all three.** WRK-011
(Sprint 2.75, shipped) + WRK-008 slice 2b (Sprint 3, shipped):
- Real route `POST /api/execution-targets/self/hello` (`server/src/routes/execution-targets.ts`, WRK-011)
  with `refreshWorkerProfile` writing `profile_snapshot` + `profile_hash` in one UPDATE
  (`packages/db/src/repositories/tenant/worker-enrollment.ts`) — **the update channel WAVE-4 said did
  not exist.**
- A PROVISIONED, matchable `buildDesktopHello({ …, provisioning })` (`enrollment/desktop-hello.ts` +
  `enrollment/hello-provisioning.ts`), composed by WRK-008 slice 2b; `offerSatisfiesWorker` **ADMITS** a
  valid `workload.batch` offer, proven through the **real `poll` service** at embedded-PG (WRK-011
  integration `A1`; daemon self-check `hello-provisioning.test.ts` Step 8c).
- `CapacityProbes` now exists: `createHostCapacityProbes` (`poll/host-probes.ts`, WRK-008 slice 2b Step 1).

**Verdict: owned.** Real daemon→real-server refresh round-trip is owed to Sprint 5 (WRK-011 §6), but the
producer is real code with a result doc, exercised end-to-end at embedded-PG.

### 3.5 Self-model read — **MOVED to OWNED** (WRK-008 slice 1 server + slice 2b daemon)

WAVE-4 §3.5: "HALF OWNED … the daemon's `ControlPlaneClient` has no method and no path for
`/api/execution-targets/self/placement-profile`." **The daemon half now exists.**
- **Server half (WRK-008 slice 1):** the real route `/execution-targets/self/placement-profile`
  (`server/src/routes/execution-targets.ts:387`) backed by `loadWorkerSelfModel`
  (`server/src/services/execution-targets.ts:604`).
- **Daemon half (WRK-008 slice 2b):** `readWorkerSelfModel` (`identity/self-model-read.ts`) calling
  `client.selfModelRead()` over `SELF_MODEL_READ_PATH = "/api/execution-targets/self/placement-profile"`
  (`transport/client.ts:73,271,420`) + `assembleWorkerSelfModel` (`identity/self-model.ts`).

**Verdict: owned (both halves are real code).** Same Sprint-5 caveat: the composed daemon reads over a
fake route in its own suite; the real daemon→real-server read is owed to Sprint 5 (WRK-008-slice-2b §9).

### 3.6 Loop composition — **MOVED to OWNED / composed** (WRK-008 slice 2b), behind the default-off flag

WAVE-4 §3.6: "`LeasingLifecycle` is stop-only … there is no start seam … `bootstrapWorkerDaemon` never
calls `.run()`." **The start seam exists.** Re-verified in source:
- `composeDispatchRuntime` (`lifecycle/dispatch-runtime.ts`) composes poll loop + supervisor + lease-
  renewal driver + durable event outbox and returns a `DispatchRuntime.start()` that calls
  `drain.start()` and `void pollLoop.run()` (`dispatch-runtime.ts:227–232`).
- `bin/worker-daemon.ts:531` calls `runtime.start()` inside the `compose: true` branch (`:515` uses
  `composeDispatchRuntime`; `:512` calls `refreshSelfHello`).
- The stop-only `LeasingLifecycle` WAVE-4 cited (`lifecycle/shutdown.ts`) is the **shutdown** interface
  (`stopLeasing`/`drain`), which is correctly stop-only. The START seam is a distinct method on
  `DispatchRuntime`. WAVE-4 conflated the two.

**Verdict: owned / composed behind the flag.** It COMPOSES and STARTS the loop; it does not yet
DEMONSTRATE a real lease/execute — that is Sprint 5 on real E2B (`E4-1`/`E4-2` stay `unwired` on
evidence; WRK-008-slice-2b §0/§9). Both shipped boot roots (container + desktop) prove inert.

### 3.7 Provider transport (adapter-manager) — **STILL UNBUILT** → **DEP-012 (new server) + DEP-011 (wire)**

WAVE-4 §3.7 stands, re-verified at tip:
- Out-of-process is machine-enforced: `staging-manifest-invariants.mjs` `checkProviderControlBoundary`
  (`:436`) requires `E2B_API_KEY` (`:120`) + `provider-ctl-net` membership to be EXACTLY the
  `adapter-manager` service (`:29,55`), forbidden on every other surface.
- `docker-compose.staging.yml:316` DECLARES `adapter-manager` (image `aoa-adapter-manager:staging`,
  `:317`; `E2B_API_KEY` injected `:322`; on `provider-ctl-net` `:345`) — but **no build produces that
  image**: `find -type d -iname "*adapter-manager*"` returns nothing; the only non-doc references are the
  compose declaration and the invariant that GUARDS it.

**Verdict: declared, enforced, unbuilt — the server had no owning ticket.** Now tracked: `#### DEP-012`
(the adapter-manager server) + `DEP-012-design.md`, with DEP-011 (the worker-side wire, owns E6-F003)
repointed onto it. The provider-topology contract is settled in the adapter-manager scope §8 and is not
relitigated here — only the build is filed as deferred.

**★ UPDATE (2026-08-28) — DEP-012 Slice 1 · Unit A BUILT (component-level).** The **create + execute wire
plumbing** now exists: `packages/provider-wire/` (the codec + the networked `SandboxProvider` driver) +
`packages/adapter-manager/` (the `createProviderServer({provider})` host), proven driver ↔ server over the
key-less `MockE2bTransport` (15 tests, 6/6 mutants killed; [`DEP-012-unit-a-result.md`](../epics/E6-deployment-test-harness/tickets/DEP-012-unit-a-result.md)).
worker-daemon is untouched. **Still unbuilt:** Unit B (the ownership fork + `execute`'s server-side gate +
the six gate-required ops + redaction), DEP-011's through-the-daemon composition seam, and Slices 3–5 (real
E2B, credential crossing, conformance, deploy/image). So 3.7 is **partially built** — the wire is de-risked;
the gate + the deploy are not.

---

## 3. What was added to the tracking (STEP 0 deliverable)

The dependency graph was blind to the chain's real gaps: WAVE-4 §4's central complaint. Fixed here —
`check-ticket-graph-coverage` remains GREEN (101 file-ids among 115 nodes; was 98/112):

| New node | File | `Depends on:` | Why the edge is justified (from source/contract) |
|---|---|---|---|
| `#### DEP-012` adapter-manager server | `epics/E6-.../tickets/DEP-012-design.md` | DEP-010 | Hosts the authoritative per-op `SandboxProvider` port DEP-010 named, moved across a boundary (adapter-manager scope §1/§8); DEP-010 transitively carries CLI-001's `E2bSandboxProvider`. |
| `#### WRK-014` container identity | `epics/E4-.../tickets/WRK-014-design.md` | WRK-002 | Completes the WRK-002 custody/device-key layer (`MountedSecretKeyStore`/`resolveCustody`/`generateDeviceKey`) for the `mounted_secret` container. |
| `#### WRK-015` POSIX enrolment input | `epics/E4-.../tickets/WRK-015-design.md` | WRK-014 | The enrolment block never executes on a container until identity exists (WAVE-4 §3.2 "unreachable until 3.1"; SPIKE F5 "sits behind F1"). |

**Edge changed:** `DEP-011` `Depends on: DEP-010` → `DEP-010, DEP-012` (its peer server is now a tracked
node; "one seam, two ends"). No invented edges — every target is a real node, and the graph stays
acyclic (`check-dependency-graph`: 0 cycles, 0 dangling).

**No findings filed.** 3.1/3.2 exist only as SPIKE probe labels F1/F5 (never filed E4-Fxxx findings) and
3.7's server had no finding (DEP-011 owns E6-F003, the *wire*), so `finding-ownership.json` is untouched
and green. These are promoted into the graph as **backlog nodes** — the same tracked-but-unbuilt status
as SVC-001..007 / REL-001/002/005. That is the WAVE-4 §4 fix: the graph now SEES them.

---

## 4. The honest remaining critical path to a live worker dispatch (and the E7-1 campaign)

Reconciled, this is shorter and differently-shaped than WAVE-4 implied. The mechanism links (3.3–3.6)
are composed and waiting behind the default-off flag; the true remaining work is three links plus the
already-known operator deploy:

1. **WRK-014 — container identity (3.1). ✅ BUILT-INERT (2026-08-28).** The hard gate; the first BUILD.
   Shipped the `file_record` custody mode + `FileRecordStore` + container host, UNWIRED (CMD/compose
   untouched). `SESS`/code — done. **WRK-015 (2) shipped the POSIX validator; WRK-017 wires the container
   path on d1.**
2. **WRK-015 — POSIX enrolment input (3.2). ✅ SHIPPED (2026-08-28).** Same container-enablement step, after
   identity; the platform-aware validator. `SESS`/code — done. Part 2 (the CI-exercised d1 first-enrol proof)
   split to **WRK-017** at the Step-0 gate (the d1 harness has no worker-enrol flow), off the critical path.
3. **DEP-012 — adapter-manager server (3.7) + DEP-011 — the worker→provider wire.** The out-of-process
   provider the container's `deps.provider` RPCs to. `SESS`/code; contract settled (scope §8).
4. **Then the composed links get their first REAL exercise:** with a container that can enrol (1,2) and a
   provider it can reach (3), the already-composed session/hello/self-model/loop (3.3–3.6) run for real —
   this is Sprint 5 / CLI-006 / `E7-1` on real E2B, which promotes `E7-1` `unwired → wired`.
5. **Operator deploy (C0):** deploy `docker-compose.staging.yml` + arm a canary (E2B key on
   adapter-manager, rollout dial, enrolled worker) — `OP`, downstream of 1–3.

So the campaign is gated on **three buildable code links (WRK-014, WRK-015, DEP-012/DEP-011), then the
operator deploy** — not "four unowned mechanism links". The frontier is real session code, and it is a
smaller programme than the snapshot framing.

---

## 5. Residuals recorded, not minted as tickets

- **3.3 cold-restart session acquisition** (WRK-010-slice-2-result.md §5, R2): an already-enrolled device
  whose process restarts after the code window cannot acquire a first session (sessions are not
  persisted). Real, and "owned by no ticket". Not minted here because it is a restart-resilience gap, not
  a first-dispatch blocker — a fresh enrolment always gets a session, so the E7-1 campaign does not need
  it. Whoever builds WRK-014 should decide whether container session-persistence subsumes it. Flagged for
  visibility; a future unit may file it (a WRK successor) if resilience becomes a release gate.
  **★ WRK-014 decided (2026-08-28): NOT subsumed.** `FileRecordStore` persists the IDENTITY + receipt
  durably (so a restarted container replays enrolment and re-acquires a session WITHIN the code window),
  but it does NOT persist the session itself — a cold restart AFTER the code window still requires
  re-enrolment, exactly as on the desktop. The gap is unchanged and remains WRK-010-slice-2's residual (a
  future WRK successor if it becomes a release gate). The E7-1 singleton canary uses a fresh enrolment, so
  it is not on the critical path.
- **Real daemon→real-server round-trips (3.4/3.5/3.6):** the daemon-side callers are proven over a **fake
  control plane** (daemon suite — real socket + real device proof, fake server) and the server-side
  routes over **embedded-PG with a synthetic client** (server suite); no test exercises the real daemon
  transport against `/self/hello` or `/self/placement-profile` (the one real daemon↔server integration,
  `composed-loop-real-server.integration.test.ts`, covers poll/lease/ACK and seeds the worker
  already-provisioned via raw SQL). The real daemon↔real-server↔real-E2B run is Sprint 5. Tracked by the
  dormant `E7-1-coding-journey` clause and `E4-1`/`E4-2` (`unwired`, evidence-gated) — already on the
  register, not a new gap.

---

## 6. Registers (all green at tip after the change)

```
check-ticket-graph-coverage : OK (101 ticket ids from files, all present among 115 graph nodes)
check-finding-ownership     : OK (11 open findings; UNOWNED E10-F001/E11-F001/E4-F014 — untouched)
check-guard-inventory       : OK (40 guard scripts)
check-gate-clause-wiring    : OK (5 wired, 9 dormant — untouched)
check-execution-census      : OK (53 *.test.mjs, 50 running — untouched)
check-dependency-graph      : OK (113 tickets, 0 dangling, 0 cycles; 3 pre-existing CM gaps — not ours)
```

No product code, no migration, no `worker-protocol` change (FROZEN), no new `AOA_*`. Docs + program
graph only.
