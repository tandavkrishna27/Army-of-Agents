# FINDING — a container daemon's rows are indistinguishable from a harness-enrolled synthetic device

**Raised by:** U1-PROVENANCE, the step-zero measurement for the daemon-boot evidence lane.
**Status:** FINDING. **STOP condition hit.** No lane code was written.
**Answer:** **INDISTINGUISHABLE.** Every enrolment-committed fact a real container daemon
writes into the control plane is byte-reproducible by a test runner holding an enrolment
code. **No daemon lane, on any of the four proposed routes, can produce row-level evidence
better than the daemon's own stdout.**

**Executed, not traced:** the forgeability half — `server/src/__tests__/u1-daemon-provenance-forgeability.test.ts`,
4/4 green, four mutations each observed red (§7).
**Traced, not executed:** the live D1 half. No Docker in this environment; the probe is
written and committed at `tests/d1/u1-provenance-probe.mjs` for an operator to run.

> ## ★ REGISTER HOME — recorded by W20, 2026-09-08
>
> This document's **release-gate consequence** is filed as `E11-F005` in
> [`epics/E11-hardening-release/findings.md`](./epics/E11-hardening-release/findings.md) (`unowned`,
> HIGH, declared in `scripts/finding-ownership.json`); that register also names this document by
> filename at `:288`, and `epics/E11-hardening-release/decisions.md:124` cites §1–§7 plus §8. The
> **mechanism** stays here, so the premise lives in exactly one place.
>
> That reference is now **load-bearing rather than incidental**:
> `scripts/check-threat-control-audit-debt.mjs` reds if any top-level
> `docs/replatform/FINDING-*.md` is named by no epic findings register — because
> `scripts/check-finding-ownership.mjs` globs only `docs/replatform/epics/*/findings.md`
> (`findRegisters`, `:29-37`) and so can never see a top-level document on its own. `E11-F005`'s
> own manifest entry states that invisibility as its reason for extending U1 rather than filing a
> second provenance finding; the guard is what stops the next such document from being invisible
> by accident rather than by that entry's good judgement. **Removing the filename from the E11
> register now reds CI** (`M18` in `scripts/check-threat-control-audit-debt.test.mjs` pins the
> equivalent case for the sibling document).

---

## 0. Why this question decides the lane

`tests/d1/e6f-09-lease-faults.test.mjs:324` already asserts an applied `attempt_terminal`
receipt in D1 CI **today**, produced from the test runner over the real fenced route with no
daemon anywhere. So the obvious evidence set — a lease, an ack, a terminal projection — is
already producible with no daemon at all.

The lane's entire value therefore rests on one premise: **that a real container daemon writes
some row-level fact a synthetic device cannot.** This document measures that premise. It is
false.

---

## 1. (a) — YES, the persisted thumbprint is derived from a key the enroller holds

The derivation and the write, traced end to end.

The container mints the key in-process. `packages/worker-daemon/src/enrollment/enroll.ts:131-137`:

> ```ts
> function loadOrCreateKey(keyStore: DeviceKeyStore): DeviceKey {
>   const existing = keyStore.load();
>   if (existing) return existing;
>   const created = generateDeviceKey();
> ```

`packages/worker-daemon/src/identity/device-key.ts:38-40` computes the thumbprint as
`sha256(SPKI DER)`:

> ```ts
> function deviceThumbprintOf(spki: Buffer): string {
>   return createHash("sha256").update(spki).digest("hex");
> }
> ```

The private half signs the enrolment body (`enroll.ts:135` `signDeviceProof`), and the server
**re-derives the thumbprint from the presented public key after verifying that signature** —
`server/src/services/worker-device-proof.ts:89-92`:

> ```ts
> if (!verify(null, Buffer.from(canonical), publicKey, signature)) throw deviceProofError();
> return {
>   publicKey: input.proof.publicKey,
>   deviceThumbprint: createHash("sha256").update(publicKeyBytes).digest("hex"),
> ```

and writes it — `server/src/services/worker-enrollment.ts:458-470`:

> ```ts
> await authority.insertWorker({
>   id: request.hello.workerId,
>   …
>   devicePublicKey: verified.publicKey,
>   deviceThumbprint: verified.deviceThumbprint,
> ```

So `workers.device_thumbprint` genuinely proves **key possession at enrolment time**.

**But key possession is not provenance.** It says the enroller held a private key. It says
nothing about where that key was minted, and the property holds identically for a synthetic
device — measured, not argued, in §7 test case (a).

★ **Also from that same insert, and decisive for §4:** the worker row's **primary key is the
client-supplied `hello.workerId`** (`id: request.hello.workerId`). The control plane does not
mint a worker id; it only refuses one already taken (`:452-457`). Nothing about the row
originates on the server.

---

## 2. (b) — YES, `leases.worker_id` is joinable to the thumbprint. It is also, today, empty for the only real daemon.

**The mechanism is real.** `server/src/services/job-leasing.ts:525` writes
`workerId: pollInput.auth.workerId`, where `auth` has passed `authorityCurrent`
(`job-leasing.ts:256-273`), which re-checks on **every poll**:

> ```ts
> return worker.id === auth.workerId
>   …
>   && worker.deviceThumbprint === auth.deviceThumbprint
>   && worker.devicePublicKey === auth.publicKey
> ```

and `auth.deviceThumbprint` comes from a **live device-proof signature** on that very request
— `server/src/middleware/worker-session-auth.ts:144`:

> ```ts
> if (proof.deviceThumbprint !== claims.deviceThumbprint) fail();
> ```

The join is FK-enforced: `packages/db/src/schema/leases.ts:93-97` binds
`(organization_id, worker_id) → workers(organization_id, id)` `ON DELETE RESTRICT`, and
`leases_authority_atomic_check` (`:53-66`) forbids a placed lease with a null `worker_id`.

**★ But it is vacuous for the one real container daemon in the tree.** worker-b never polls,
so no lease can ever carry its `worker_id`:

- Dispatch composition is gated on `config.dispatchEnabled`, parsed from
  `AOA_WORKER_DISPATCH_ENABLED` and defaulting to `false`
  (`packages/worker-daemon/src/config/config.ts:159-161`). `docker-compose.d1.yml` sets it
  **nowhere** (grep for `AOA_WORKER_DISPATCH_ENABLED` in that file: zero hits).
- worker-b is also built with **no provider**: `runContainerHost` passes
  `provider: deps.provider`, and the direct-invocation entry
  (`packages/worker-daemon/src/bin/container-host.ts:155`) passes none. The file says so at
  `:92-96` — *"ABSENT for the shipped container (E4-D01: the daemon image cannot carry a
  provider package…)"*.

So (b) is **true as a mechanism and unreachable in practice**. Anyone planning to assert on
a `leases` row joined to a real daemon's thumbprint must first build the two things that gate
it — which is the E7-1 substrate, not evidence about it.

**And it gets worse for the lane, independently of the flags:** the container's hello is
*designed* to be unleasable. `desktop-hello.ts:6-8` — *"it exists to emit a desktop that
**can never be matched work**"* — with `reportedCapabilities: []` and
`policyHash: UNPROVISIONED_POLICY_HASH` (`:171-176`, `:188`). The daemon only becomes
matchable by first clearing the composition gates and refreshing its self-model
(`bin/worker-daemon.ts:521-544`), at which point its `profile_snapshot` becomes **the same
provisioned shape the harness already sends**. The daemon's one structurally distinctive row
value disappears exactly when the row becomes useful.

---

## 3. (c) — what is readable from a worker container without exec

| Surface | Reachable without `exec` into the worker? | What it is worth |
|---|---|---|
| `docker compose logs worker-b` | **Yes** | The daemon's own stdout. This is the evidence class the lane exists to improve on. |
| `/worker/identity.json`, `/worker/receipt.json` | **No.** The named volume `d1-worker-b-state` needs either `exec` into worker-b (what `container-enrol.test.mjs:56-67` does) or a *second* container mounting the volume. | **Self-written by the daemon** — `record-codec.ts:131-141` shows the receipt is `{v, workerId, targetId, deviceThumbprint}` with **no server signature**. Anything that can write the volume can write these. |
| Health/metrics on `:9464` | **No.** `config.ts:205-210` refuses any non-loopback bind, and worker-b declares no `ports:` mapping (`docker-compose.d1.yml:361-420`). | — |
| Control-plane rows | **Yes** (via the CP container, as `container-enrol.test.mjs:70-81` does) | The subject of §4. |

Every non-exec surface is either the daemon's own narration or the control plane's rows.

---

## 4. (d) — NO other row-level discriminator exists

Enumerated exhaustively over everything the enrolment path commits.

| Candidate | Real difference today | Forgeable? |
|---|---|---|
| `workers.id` | — | **Client-supplied verbatim** (`worker-enrollment.ts:459`) |
| `workers.device_public_key` / `device_thumbprint` | — | Each side mints its own Ed25519 key with the same `node:crypto` primitive; the server binds whichever key signed |
| `workers.profile_snapshot.agentVersion` | `"0.1.0"` vs the harness fixture's `"e6f-03-harness"` | **Yes** — `z.string().min(1).max(100)`, `packages/worker-protocol/src/capabilities.ts:372`; no server code validates it |
| `workers.profile_snapshot.platform.runtime` | `"desktop"` vs the fixture's `"worker"` | **Yes** — `z.string().min(1).max(100)`, `capabilities.ts:110` |
| `workers.profile_snapshot.reportedCapabilities` / `capacity` / `policyHash` | unprovisioned-shaped vs matchable-shaped | **Yes**, and see §2: the difference is the daemon being *unusable*, and it vanishes on provisioning |
| `workers.profile_hash` | — | `sha256(JSON.stringify(hello))` (`worker-enrollment.ts:409`) — a function of the forgeable snapshot |
| `worker_enrollment_codes.semantic_idempotency_key` | daemon's is **derived**, the harness's fixture default is `randomUUID()` | **Yes.** The strongest-looking candidate, and it fails: `enrollment/idempotency.ts:12-13` states outright *"**No secret is an input.** The enrollment code is deliberately excluded"*. It is `sha256("aoa.worker.enroll.idem.v1\|workerId\|targetId\|generation")` over three values the row itself carries. |
| `worker_enrollment_codes.semantic_digest` | — | The server's own hash over the request (`worker-enrollment.ts:114-131`); identical inputs give identical output |
| the enrolment ticket | — | `docker/d1/worker-b.enrollment-ticket` is **committed in plaintext**. Anyone with the repo has worker-b's code. |
| a peer address / TLS identity / user agent | **none recorded** | n/a — see below |
| an attestation quote, TPM, cgroup or machine-id fact | **none exists** | n/a — see below |

**Nothing about the transport is recorded.** A grep for `remoteAddress`, `req.ip`,
`x-forwarded-for`, `socket.remote`, `userAgent`, `user-agent` across
`server/src/routes/worker-control.ts`, `server/src/services/worker-enrollment.ts` and
`server/src/middleware/worker-session-auth.ts` returns **zero hits**. That is pinned as a
source-scan test case (§7, case 4), so a future addition — which *would* be a genuine
discriminator — turns it red.

**Nothing attests the environment.** A grep for `attestation`, `attest(`, `tpm`,
`/proc/self/cgroup`, `machine-id`, `machineId`, `dmi`, `containerId`, `hostname()` across
`packages/worker-daemon/src`, `packages/worker-protocol/src` and the server's worker path
returns **zero real hits** (every match is the substring "admin"/"admits" in prose).

★ **And the absence is deliberate, not an oversight.** `desktop-hello.ts:62-69`:

> *"The opaque runtime label. A CONSTANT, never `process.version`: `runtime` is a
> provider-neutral tag, and emitting a Node build string would put a **fingerprintable value
> on the wire for no benefit** — and would break the byte-stability a replayed enrolment
> depends on."*

The protocol was designed to carry no fingerprint of its execution environment. **That design
choice and the daemon-evidence lane are mutually exclusive**, and the design choice is right:
byte-stability across enrolment replays is what prevents the double-mint, and a
per-environment fact would break it.

---

## 5. The probe and its mutation

`tests/d1/u1-provenance-probe.mjs` (operator-runnable, `AOA_D1_LIVE=1`, never faked) reads
the discriminating facts twice:

- **A** — worker-b's target, read-only: the shipped image running `dist/bin/container-host.js`,
  which read a POSIX ticket off a read-only mount, minted a key **in-container**, and enrolled
  over the real toxiproxy link.
- **B** — a synthetic device the probe enrols itself from the test-runner container into its
  own hermetic org, **forging the daemon's hello field-for-field and the daemon's derived
  idempotency key** rather than using the harness's `"e6f-03-harness"` / `randomUUID()`
  fixture defaults.

It normalizes away only what differs *by construction* (ids, timestamps, key bytes) and diffs
the rest. **It was not executed** — this environment has no Docker
(`failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine`).

The forgery it performs **was** executed, offline, against the server's own code — §7.

---

## 6. What this kills

**Every unit whose evidence is "a daemon booted in a container, and here is the row that
proves it".** Concretely:

- A daemon lane cannot beat `docker compose logs`. The rows it would assert on are
  reproducible by the test runner that would be asserting on them.
- The four proposed routes differ only in *how* the daemon is brought up. None of them
  changes what the control plane records, because the control plane records nothing about
  who connected.
- `tests/d1/container-enrol.test.mjs` remains valuable **for what it actually is**: a
  bring-up regression check whose real load-bearing property is stated in its own header
  (*"A `file_record` enrol failure calls `proc.exit(1)` … so `docker compose up -d --wait`
  FAILS"*). It is not, and cannot be, provenance evidence.

**What would rescue a daemon lane** — and each is a build, not a measurement:

1. A control-plane-issued challenge bound to something the container has and a test runner
   does not (there is nothing like this today, and §4's design note argues against putting it
   in the hello).
2. A recorded transport fact — peer address, or a client certificate issued only to the
   image. Adding one turns §7 case 4 red on purpose.
3. Accepting that the daemon's own stdout **is** the evidence, and making the lane cheap
   accordingly.

Do not adopt (1) or (2) on the strength of this document alone: both change the enrolment
threat model, and (1) collides with the replay byte-stability that prevents double-mint.

---

## 7. The measurement, and the mutations that prove it non-vacuous

`server/src/__tests__/u1-daemon-provenance-forgeability.test.ts` — 4 cases, all green:

```
$ npx vitest run server/src/__tests__/u1-daemon-provenance-forgeability.test.ts
 Test Files  1 passed (1)
      Tests  4 passed (4)
```

It builds the container path with **the daemon's own exported functions** (`generateDeviceKey`,
`buildDesktopHello`, `deriveEnrollmentIdempotencyKey`, `signDeviceProof`) and the synthetic
path as plain literals reproducing `tests/d1/lib/e6f-harness.mjs`, then runs both through the
**server's** `verifyDeviceProof` and the **server's** `profile_hash` / `semantic_digest`
formulas.

Four mutations, each observed RED, each with three named positive controls staying GREEN:

| # | Mutation | RED | GREEN controls |
|---|---|---|---|
| M1 | forged `agentVersion` → `"e6f-03-harness"` | case (d): `expected { protocolVersion: 1, …(9) } to strictly equal …` on the snapshot diff | (a), non-vacuity, transport-scan |
| M2 | forged `idempotencyKey` → `randomUUID()` | case (d): `expected '08ea3730-…' to be '37648c6a-6904-542c-a7e8-9a00c90f6394'` | (a), non-vacuity, transport-scan |
| M3 | injected a `remoteAddress` read into `worker-enrollment.ts` | case (c/d): `expected [ Array(1) ] to strictly equal []` | (a), (d), non-vacuity |
| M4 | `worker-device-proof.ts:92` thumbprint → `sha256("mutant")` | case (a): `expected '137b58a5…' to be 'faa2778f…'` | (d), non-vacuity, transport-scan |

M2's expected value, `37648c6a-6904-542c-a7e8-9a00c90f6394`, is the daemon's derived key for
the fixture identity — a deterministic UUIDv5-shaped digest of three public values, which is
precisely why a synthetic can reproduce it.

All four source mutations were reverted; `git status` shows only the new files.

---

## 8. The DESKTOP host is covered by this result too — one shared hello producer (W18, 2026-09-08)

This section adds an instance, not a claim. It was written when a documentation review proposed a
release-acceptance clause requiring that an operator *"enroll two distinct owner-desktop devices"*,
and the question arose whether §1–§7's verdict — measured on the **container** daemon — says
anything about a **desktop** one.

**It does, and the reason is one shared producer.** Traced at `13caa3227`:

```
packages/worker-keystore/src/bin/desktop-host.ts:26,120   imports + calls bootstrapWorkerDaemon
  -> packages/worker-daemon/src/bin/worker-daemon.ts:215   export async function bootstrapWorkerDaemon
    -> :332                                                const runEnrollment = deps.enrollOnceFn ?? enrollOnce
      -> packages/worker-daemon/src/enrollment/enroll-once.ts:265   buildDesktopHello({...})
```

The container daemon reaches `buildDesktopHello` through the same `bootstrapWorkerDaemon`. There is
**one** enrolment-hello producer in the repository, and both hosts are its callers. Since §1–§4
measured that every enrolment-committed fact is a function of the hello plus a key the enroller
holds, and since the desktop host produces the *same* hello through the *same* function, a desktop
host's committed rows are indistinguishable from a harness-enrolled synthetic device for exactly the
reasons already given. **No new measurement is required for the desktop case; it is the container
case with a different `bin`.**

**★ AND THE DESKTOP CASE IS STRICTLY WEAKER.** §6 says a container daemon's stdout is the best
available evidence. For desktop there is not even a distributed artefact whose boot could be
attested:

- **No installer package is produced.** `docs/deploy/distribution.md` still records that there is
  no desktop installer, and that is not a documentation accident — it is CI-enforced.
- **CI guards the ABSENCE of a desktop distribution surface.**
  `scripts/check-desktop-surface-disabled.mjs` implements DSK-00 clauses 6 and 7: the distribution
  doc must keep saying *"no desktop installer"* and *"docker + npm only"* (`REQUIRED_DOC_PHRASES`,
  `:41`), and a sweep of `server/src/routes` must find no route serving a desktop
  `package|update|manifest|installer|download|release|artifact` (`:54-59`). Its own header states
  why a script and not a grep step: *"you cannot import a route that does not exist."*

So a "desktop device" in this tree today is a process someone started from a source checkout. It has
no signed artefact, no installed identity, and — per §4 and per `workerHelloV1Schema`'s `.strict()`
ten fields (`packages/worker-protocol/src/capabilities.ts:366-379`) — no machine-identifying fact in
the enrolment protocol at all. Two desktop enrolments prove **two keystores**, never two machines,
because `loadOrCreateKey` (`packages/worker-daemon/src/enrollment/enroll.ts:131-137`) mints per
keystore.

**Scope of this section.** It extends §6's "what this kills" list by one entry — *any unit whose
evidence is "two desktop devices enrolled, and here are the rows that prove they were two machines"*
— and it changes nothing in §1–§7. The **release-gate consequence** is filed separately, and
declared in `scripts/finding-ownership.json`, as `E11-F005` in
`docs/replatform/epics/E11-hardening-release/findings.md`; this document remains the home of the
mechanism so the premise lives in exactly one place.
