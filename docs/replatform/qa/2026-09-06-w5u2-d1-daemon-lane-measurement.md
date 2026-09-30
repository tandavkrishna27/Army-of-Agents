# W5U2 — the D1 daemon lane is bigger than four changes. Here is the measurement.

**Unit:** W5U2 (`replatform/w5u2-d1-daemon-lane`) · **Branch parent:** `docs/replatform-program` @ `e1f723df2`
**Verdict: STOP — Step Zero did not clear. (a) and (c) are refuted; (b) clears.**
Nothing in `docker-compose.d1.yml`, `scripts/d1-dispatch-expectation.json` or
`scripts/lib/d1-compose-invariants.mjs` was changed by this unit. This document is the
whole deliverable.

The unit brief said, in its own words: *"A truthful 'this is bigger than four changes,
here is why' is a SUCCESS for this unit."* This is that report.

---

## 0. What the unit was asked to do, and what Step Zero was for

The brief proposed closing the "the worker-daemon has never run" gap in CI with four
changes, all claimed to be test infrastructure:

1. an `/op/<op>` route on the D1 `fake-provider` — *"a shim beside the existing route"*;
2. a compose diff repointing **one** worker (`worker-b`) to `networked-host.js` and adding
   `AOA_WORKER_DISPATCH_ENABLED` + `AOA_WORKER_EVENT_OUTBOX_PATH`;
3. an update to `scripts/d1-dispatch-expectation.json`;
4. an update to `checkWorkersEnterTheDaemonBin` in `scripts/lib/d1-compose-invariants.mjs`.

Step Zero required three things to be measured **before** building:

- **(a)** is the `/op` shim a route alias, or more than that?
- **(b)** do **all six** `compose-dispatch.ts` gates pass in the proposed configuration?
- **(c)** can the networked driver's **owned-labels capability** gate be satisfied against a
  **fake** provider?

**(b) clears. (a) and (c) do not.** Detail, with the commands and their real output, below.

---

## 1. Premises that survived measurement

These were checked, not assumed, at `e1f723df2`.

| Premise from the brief | Verdict | Evidence |
|---|---|---|
| The D1 lane drives real `/api/worker-control/*` against real Postgres + real MinIO | **TRUE** | `tests/d1/e6f-*.test.mjs`, `docker-compose.d1.yml` |
| `worker-b` already enrols and persists a device identity via a `command:` override onto `dist/bin/container-host.js`, and `worker-a` is the deliberate negative control | **TRUE** | `docker-compose.d1.yml` `worker-b.command`; `tests/d1/container-enrol.test.mjs` header: *"a container running the SHIPPED worker image, with NO test double anywhere in the path … PERSISTED the result to its own volume"* |
| The worker image already contains `worker-networked-host` at `/worker-net-app/dist/bin/networked-host.js` | **TRUE** | `scripts/d1-dispatch-expectation.json` `$comment` + the `providerUrl` rows |
| `scripts/d1-dispatch-expectation.json` already anticipates this change as *"a separate attributable compose diff"* | **TRUE** | that file, `worker-{a,b}.dispatchEnabled.reason` |
| No daemon has ever composed dispatch, taken a lease and driven a supervisor lifecycle in CI | **TRUE** | `tests/d1/lib/e6f-harness.mjs` header: *"There is NO live worker-daemon loop"* |

One premise from the wider programme record needed re-checking because gate 5 depends on
it, and it has **changed since it was written**:

- `docs/replatform/WAVE-4-BLOCKER-worker-session-lifetime.md` states a worker loses
  authority at T0+15min with *"no device-session renewal route"*. **That is no longer true at
  tip.** The route exists — `router.post("/worker-control/session/renew", …)` at
  `server/src/routes/worker-control.ts:313` — and `createWorkerSessionToken` now has **four**
  call sites, not the two that document counted: `worker-enrollment.ts:369` and `:489` plus
  `server/src/services/worker-session-renewal.ts:92` and
  `server/src/services/worker-hello-refresh.ts:112`. The daemon side exists
  (`packages/worker-daemon/src/identity/session-renewal.ts`,
  `identity/worker-session-lifecycle.ts`) and is composed in
  `packages/worker-daemon/src/bin/worker-daemon.ts:349-361` **exactly when
  `shouldComposeSession` is true** — i.e. precisely in the configuration this unit proposed.
  That document should be marked superseded by whoever owns it; this unit did not edit it.

---

## 2. (b) — THE SIX GATES CLEAR. This is the part of the brief that was right.

`decideDispatchComposition` (`packages/worker-daemon/src/lifecycle/compose-dispatch.ts`)
refuses in order: `no_provider` → `dispatch_disabled` → `no_worker_identity` →
`no_event_outbox_path` → `no_session` → `no_self_model`.

| # | Gate | Satisfied by | Status |
|---|---|---|---|
| 1 | `no_provider` | `makeRunProvider`, built by `networked-host.js` when `AOA_WORKER_PROVIDER_URL` is set — which `worker-b` **already sets** | clears with the `command:` repoint |
| 2 | `dispatch_disabled` | the new `AOA_WORKER_DISPATCH_ENABLED` | clears |
| 3 | `no_worker_identity` | `worker-b`'s existing `file_record` custody + real enrolment | **already clears today** |
| 4 | `no_event_outbox_path` | the new `AOA_WORKER_EVENT_OUTBOX_PATH` (must live under the writable named volume `/worker`; the container is `read_only: true`) | clears |
| 5 | `no_session` | enrolment mints a session; `createWorkerSessionLifecycle` is composed under `shouldComposeSession` and renews it | clears — see §1 |
| 6 | `no_self_model` | `admitSelfModelRead` needs `status='active'` + a generation match + `registeredProfile` + `providerConstraintProfile`; `docker/control-plane/seed-d1-worker-enrolment.mjs` writes **all four**, with a genuinely recomputed `providerDigest` so `verifyAndBrandProviderConstraintProfileV1` brands it | clears |

Measured by running the real decision function over the proposed configuration, with both
negative controls and the positive control:

```
=== (b) the six dispatch gates, walked over the PROPOSED worker-b config ===
proposed worker-b (all four compose-provided facts present) -> {"compose":true,"selfModel":{}}
NEGATIVE CONTROL: AOA_WORKER_EVENT_OUTBOX_PATH removed     -> {"compose":false,"reason":"no_event_outbox_path"}
NEGATIVE CONTROL: AOA_WORKER_DISPATCH_ENABLED removed      -> {"compose":false,"reason":"dispatch_disabled"}
POSITIVE CONTROL: worker-a today (no networked bin, no flag) -> {"compose":false,"reason":"no_provider"}
```

The brief's mandated negative control — *remove `AOA_WORKER_EVENT_OUTBOX_PATH` and observe
compose-dispatch refuse with `no_event_outbox_path`* — is the second line, and it holds.
Gates 5 and 6 were traced through the source and the seed, **not executed live** — no D1
stack was brought up by this unit (Docker + Linux only). They are reported as *traced*, not
*observed*.

---

## 3. (a) — REFUTED. The `/op` shim is not a route alias; it is a second adapter-manager.

### 3.1 The two contracts disagree on four independent axes

| Axis | `NetworkedProviderDriver` (`packages/provider-wire/src/driver.ts`) | D1 `fake-provider` (`docker/d1/fake-provider-entry.mjs`) |
|---|---|---|
| Route | `POST ${baseUrl}/op/${op}` | `POST /invoke` |
| Request body | `{args, ctx, capability?}` (`encodeOpRequest`) | `{providerId, op, args}` |
| Response body | `{ok: <result>}` \| `{err: <SerializedError>}` (`decodeOpResponse`) | `{ok: true, result: <…>}` |
| Result **type** | the per-op `SandboxProvider` port: `CreateResult{sandboxId, providerOpId, resourceLabels}`, `ExecuteResult{providerOpId, exitCode, signal, timedOut, stdoutRef, stderrRef}`, `StopResult`, `CleanupResult`, `RedactedResourceProjection`, `RedactedListResult` | the invoke-driver port: a `ProviderOpResult` union — `{kind:"created", resource, deduplicated}`, `{kind:"executed", terminalState, faultInjected, timedOut}`, `{kind:"acknowledged", op, faultInjected}`, … |

Measured against the real shipped code:

```
=== (a1) what NetworkedProviderDriver PUTS ON THE WIRE for create ===
POST <base>/op/create  body={"args":{"sandboxId":"sbx-1","resourceLabels":{},"env":{},"command":"true"},"ctx":{"deadlineMs":30000,"idempotencyKey":"idem-1"}}

=== (a3) feed the fake route's OK BODY to the REAL wire decoder ===
fake /invoke 200 body: {"ok":true,"result":{"kind":"created","resource":{"providerId":"p","resourceId":"r-1"},"deduplicated":false}}
decodeOpResponse(...) === true   typeof=boolean
CreateResult requires { sandboxId, providerOpId, resourceLabels } -> the decoder returned a BOOLEAN.

=== (a4) the fake provider's REAL per-op results (its own port) ===
create  -> {"kind":"created","resource":{"providerId":"p1","resourceId":"p1-res-1"},"deduplicated":false}
execute -> {"kind":"executed","terminalState":"succeeded","faultInjected":false,"timedOut":false}
destroy -> {"kind":"acknowledged","op":"destroy","faultInjected":false}
```

Note the third line of (a3): the response-envelope mismatch is **not loud**. `{ok: true, …}`
decodes to the boolean `true` and is returned **as** the `CreateResult`. A naive alias would
not 500; it would hand the supervisor a boolean typed as a sandbox handle.

### 3.2 The adapter this needs does not exist, and the one that does runs the other way

`packages/worker-daemon/src/supervisor/provider.ts` states the direction explicitly: the
contract package's `SandboxProviderDriver` is *"reached FROM this port through the shipped
`perOpToInvokeDriver` adapter … **never the reverse**."* The shim needs the reverse —
invoke-driver → per-op port — and no such adapter is in the tree.

### 3.3 The shim must FABRICATE the exit code the acceptance projection turns into a terminal

`ExecuteResult` requires `exitCode: number | null`, `signal`, `stdoutRef`, `stderrRef`. The
fake's `executed` result carries **none of them** (see (a4) above). Every one would have to
be invented by the shim.

### 3.4 The fake-provider image cannot host the wire codec without importing the e2b closure

`docker/d1/fake-provider.Dockerfile` copies exactly two workspace packages:

```
COPY packages/sandbox-fake-provider/ packages/sandbox-fake-provider/
COPY packages/worker-protocol/ packages/worker-protocol/
```

`@armyofagents/provider-wire` — which owns `decodeOpRequest`/`encodeOkResponse`/
`encodeErrResponse` — declares `@armyofagents/sandbox-e2b-provider` and
`@armyofagents/worker-daemon` as **runtime** dependencies (the error vocabulary is imported
from `@armyofagents/sandbox-e2b-provider/errors.js`). Putting the wire in the fake-provider
image drags the e2b SDK closure and worker-daemon into it — the exact confinement
(`scripts/lib/adapter-manager-boundary.mjs`, E4-D01, DEP-006) that the real provider host
exists to keep in one place.

### 3.5 The right host already exists and cannot run here

`packages/adapter-manager/src/server.ts` **is** the `/op/:op` server, and it is
provider-agnostic (`createProviderServer({ provider })`). But its only composition root,
`packages/adapter-manager/src/bin/adapter-manager.ts`, accepts **`e2b` and nothing else** —
`AOA_ADAPTER_MANAGER_SANDBOX_PROVIDER` unset/`none`/anything-but-`e2b` is a hard refusal,
and `e2b` additionally requires a template and a real provider-control credential. In the
D1 stack's four `internal: true` networks there is no egress, so the real adapter-manager
cannot boot there at all.

**So the honest shape of item (1) is:** a second implementation of the adapter-manager's
request surface, plus a port adapter that does not exist, plus fabricated execute fields,
hosted in an image deliberately built to be unable to host it. That is not a shim.

---

## 4. (c) — REFUTED. The owned-labels capability is unobtainable in the D1 stack.

`makeNetworkedRunProvider` (`packages/worker-networked-host/src/make-run-provider.ts`)
**throws** without a capability, and the supervisor's networked branch
(`supervisor.ts:534-546`) terminalizes the attempt `failed / no_run_capability` before
`create` is ever called. So a capability-less networked run does not reach the acceptance
path; it reaches a different terminal.

The capability has **two independent** preconditions, and the D1 stack satisfies **neither**.

### 4.1 The capability rides only on a secret-handle resolve, and the D1 job has no handles

`synthesiseRunSecrets` (`packages/worker-daemon/src/lease/secret-redemption.ts:135`) only
redeems handles whose `materialization.kind === "env"` **and**
`usePolicy === "sandbox_local_only"`, with an env target in
`PROVIDER_AUTH_ENV_TARGETS = {ANTHROPIC_API_KEY, OPENAI_API_KEY}`. The capability is folded
in from those resolve replies and from nowhere else.

The lease envelope's `secretHandles` comes from
`repos.jobControl.listActiveExecutionSecretHandles(...)` (`server/src/services/job-leasing.ts:621`).
The D1 seeds — `tests/d1/lib/e6f-harness.mjs seedScenario` and
`docker/control-plane/seed-d1-worker-enrolment.mjs` — create **no** such row (there is no
`job_secret_handles` insert anywhere under `tests/d1/`, `docker/d1/` or
`docker/control-plane/`).

```
=== (c1) the D1 seeded job carries ZERO secret handles -> what does the run get? ===
synthesiseRunSecrets([], …) = {"env":{},"canaries":[]}
'capability' key present? false

=== (c2) the networked factory with no capability ===
NetworkedProviderCapabilityError: worker-networked-host: refusing to build a run provider — no owned-labels capability was minted for this run
```

Creating one is not a one-liner: the broker must actually **resolve** it, which needs an
encrypted `company_secrets` row + version + binding reachable under the D1 tenant roles.

### 4.2 The control plane has no mint key in D1, so the mint is omitted even if a handle existed

`applyOwnedLabelsCapability` (`server/src/services/owned-labels-mint.ts:115`) returns the
outcome **unchanged** when `controlPlaneSigningKey` is absent. The key is loaded once, from
`AOA_CONTROL_PLANE_SIGNING_KEY_FILE` (`server/src/index.ts:960`).

That variable is set in `docker-compose.staging.yml` (lines 77, 128) and **nowhere in
`docker-compose.d1.yml`**. No ed25519 key material is committed under `docker/d1/` — only
the throwaway TLS `public.crt`/`private.key`.

```
=== (c3) the control-plane mint with NO AOA_CONTROL_PLANE_SIGNING_KEY_FILE (the D1 compose today) ===
applyOwnedLabelsCapability(resolved, ctx, {controlPlaneSigningKey: undefined}) ->
  ownedLabelsCapability present? false
  identical object returned?     true
```

Even with a key, the D1 `/op` server would be **keyless and therefore UNGATED** —
`server.ts` reduces the whole gate to `gated = controlPlanePublicKey !== undefined`. So the
lane would exercise the capability's *mint and carriage*, never its *verification*. That is
worth saying out loud before anyone reads a green lane as "the gate works".

---

## 5. The guard question the brief asked, answered — and a correction to it

The brief said guard (4), `checkWorkersEnterTheDaemonBin`, *"currently PINS the old command"*
and asked why the pin exists and whether a new form would still protect it.

### 5.1 It is TWO guards, not one

Running the real invariants over the brief's proposed diff, applied in memory to `worker-b`
only:

```
--- baseline (committed compose) ---
[]
--- with the proposed worker-b diff ---
VIOLATION: worker 'worker-b' 'command' enters the NETWORKED-HOST bin ("node /worker-net-app/dist/bin/networked-host.js"). D1 workers must run the daemon bin: combined with the AOA_WORKER_PROVIDER_URL this compose already sets, that override would give D1 a live provider dialling the in-net fake-provider, whose fabricated exit 0 is indistinguishable from a real run on every other gate.
VIOLATION: worker 'worker-b' declares 'AOA_WORKER_KEY_STORE_MODE: file_record' but does not enter the container-host bin. The daemon bin injects no record stores, so resolveCustody refuses file_record pre-socket and the container exits 1 before its healthcheck can answer.
```

The second is `checkWorkerCustodyBootRoot`, which the brief did not mention.

### 5.2 The pin exists to prevent exactly the false evidence this programme is built to avoid

`checkWorkersEnterTheDaemonBin` states its own reason, and §3.3 above independently confirms
it: *"whose **fabricated exit 0** is indistinguishable from a real run on every other gate."*
The fake's `execute` result has no exit code at all, so a shim must invent one. The pin is
not incidental scaffolding — it is the thing standing between a green D1 lane and a reader
concluding a real run happened.

**This unit therefore did not change it.** A weaker form of that guard could only be
justified alongside a *replacement* discriminator that keeps a fake-backed lane from ever
being cited as a real run, and designing that discriminator is not inside a four-change
unit. Absent one, changing the guard would be deleting the protection.

### 5.3 `checkWorkerCustodyBootRoot`'s marker is a textual proxy that is wrong for this bin

`CONTAINER_HOST_BIN_MARKER = "container-host"`, and the guard asserts an equivalence between
`AOA_WORKER_KEY_STORE_MODE: file_record` and entering a bin whose path contains that
substring. The property it is really asserting is *"this boot root injects FileRecordStores"*.

`packages/worker-networked-host/src/bin/networked-host.ts` **does** inject them — it calls
`runContainerHost(...)`, wrapping only the `bootstrap` seam. But `"networked-host"` does not
contain `"container-host"`, so the guard reports a violation for a configuration that would
in fact boot correctly. That is a **false** violation, and it is worth fixing on its own
merits by whoever next touches that file — independently of anything in this unit. It is
recorded here rather than filed, because this unit does not own
`scripts/finding-ownership.json` or any `findings.md`.

---

## 6. What it would actually take — the honest inventory

| # | Change | Class | In the brief? |
|---|---|---|---|
| 1 | A `/op/:op` server for the fake provider: wire codec + a new invoke→per-op adapter + fabricated `ExecuteResult` fields + redacted `inspect`/`list` projections | **new production-adjacent code**, not test infra | claimed as a shim |
| 2 | A home for it that may import `provider-wire` without dragging the e2b closure into the fake-provider image | image/boundary design | no |
| 3 | `worker-b` compose diff: `command:` + 2 env vars, outbox under `/worker` | test infra | yes |
| 4 | `AOA_CONTROL_PLANE_SIGNING_KEY_FILE` + committed throwaway ed25519 key + mounts on **both** control-plane replicas | test infra | no |
| 5 | A D1 job for `worker-b`'s org/target carrying an `env`/`sandbox_local_only` secret handle, **and** an encrypted company-secret row the broker can actually resolve under the D1 roles | test infra, non-trivial | no |
| 6 | `scripts/d1-dispatch-expectation.json` rows for `worker-b` | test infra | yes |
| 7 | `checkWorkersEnterTheDaemonBin` — **and a replacement discriminator** so a fake-backed lane can never be cited as a real run | guard + design | partly |
| 8 | `checkWorkerCustodyBootRoot`'s `container-host` marker (independent latent bug, §5.3) | guard | no |

Three of eight were in the brief. Item 1 alone is a unit.

---

## 7. What this does NOT say

- It does **not** say the D1 daemon lane is a bad idea. Gate analysis (b) says the daemon
  would compose, and that is genuinely most of the way there.
- It does **not** say the four changes are wrong — items 3, 6 and part of 7 are correct as
  described. It says four is not the whole set, and the two that were left out (1 and 5) are
  the expensive ones.
- It does **not** claim anything about E7-1, which stays red either way.

## 8. Reproducing the measurements

Every block quoted above came from throwaway scripts that imported the **real shipped
modules** — no copies, no simulations — run from the worktree root after
`pnpm install` + building `worker-protocol`, `worker-daemon`, `sandbox-provider-contract`,
`sandbox-e2b-provider`, `provider-capability`, `provider-wire`, `sandbox-fake-provider`,
`worker-networked-host`. The entry points are:

- §2 `decideDispatchComposition` — `packages/worker-daemon/src/lifecycle/compose-dispatch.ts`
- §3 `encodeOpRequest` / `decodeOpResponse` — `packages/provider-wire/src/codec.ts`;
  `createFakeSandboxProvider` — `packages/sandbox-fake-provider/src/index.ts`
- §4 `synthesiseRunSecrets` — `packages/worker-daemon/src/lease/secret-redemption.ts`;
  `makeNetworkedRunProvider` — `packages/worker-networked-host/src/make-run-provider.ts`;
  `applyOwnedLabelsCapability` — `server/src/services/owned-labels-mint.ts`
- §5 `evaluateComposeInvariants` — `scripts/lib/d1-compose-invariants.mjs`, over
  `docker-compose.d1.yml` parsed by `scripts/lib/yaml-lite.mjs`, with the proposed diff
  applied in memory

The scripts themselves were scratch and are not committed; the module paths above are the
whole recipe.
