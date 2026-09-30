# CLI-008 Unit B (build) — wire the four orphans into one channel

> **For agentic workers:** implement task-by-task, in order. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make a file authored by the control plane appear inside the sandbox before the agent runs.
Every component already exists; **none of them is called.** This unit is wiring.

**Design authority:** [`2026-09-03-cli-008-unit-b-channel-decision.md`](./2026-09-03-cli-008-unit-b-channel-decision.md)
— **§8 first** (the measured byte path), then §1–§3 (why the port, not the vocabulary) and §7.

**The canary still cannot flip after this.** No MCP config, no instructions bundle, no workspace, no
output capture — this delivers the *channel* those need. `capabilityProven` stays false.

---

## The four orphans this composes

| Component | State | Where |
|---|---|---|
| `JobArtifactsRepository.insert` | plain, **unguarded**, **zero callers** — production or test | `packages/db/src/repositories/tenant/index.ts:249-252` |
| `ControlPlaneClient.artifactTransferGrant` | built, **one caller — a unit test** | `worker-daemon/src/__tests__/artifact-commit-client.test.ts:80` |
| `transport.writeFiles` | implemented in **both** mock and real drivers, **no caller on this path** | `sandbox-e2b-provider/src/transport.ts:151`, `real-transport.ts:187` |
| the download branch of `artifact_transfer_grant` | **fence-independent and fully built**, route wired, service composed | `server/src/services/artifact-transfer-grant.ts:185-228` |

★ **A fifth orphan is the one outcome this unit must not produce.** Every symbol it adds is born with
its caller, and Task 6 enrols the chain in `gate-clause-wiring.json` so a removed caller reds.

---

## Task 1 ★: Settle the byte-source conflict by MEASUREMENT

The two sweeps disagree. Sweep 1 rejected an inline `extensions[]` payload; sweep 2 recommended it,
measuring the ceiling at ~49 KB. **Do not pick by preference.** This task decides it with numbers, and
everything after it is identical either way on the provider side.

**Files:** Create `server/src/__tests__/cli-008-unit-b-byte-source.integration.test.ts`

- [ ] **Step 1: Measure what each source can actually carry.** For `extensions[]`: binary-search the
  largest bundle that survives `batchWorkloadV1Schema` **and** the 65,536-byte submission bound, with
  a realistic workload around it. For object storage + grant: confirm there is no comparable ceiling.
  Record both numbers in the test.

- [ ] **Step 2: Measure what units C and D actually need.** Assemble a *real* MCP config for the
  `aoa` server and a *real* instructions bundle from `server/src/onboarding-assets/`. Report their
  byte sizes. ★ Do not estimate them — read the real assets.

- [ ] **Step 3: Write the decision into the test file as a comment**, with both numbers, and state
  which source this unit uses and why. If C+D fit inside the extensions ceiling with room to spare,
  say so; if they do not, say that. **The measurement decides.**

★ Whatever wins, a repository does **not** fit either (a repo is 10²–10³× these ceilings), so Unit E
remains a pull from inside the sandbox regardless. Do not let this task grow into solving E.

- [ ] **Step 4:** Commit — `test(cli-008): measure the byte-source ceilings before choosing one`.

---

## Task 2: The control-plane staging write, born with its caller

**Files:** a new service beside `server/src/services/artifact-transfer-grant.ts`

- [ ] **Step 1:** A named function that stages a bundle for a job: `putObject` for the bytes, then
  `jobArtifacts.insert({ status: "committed", … })` inside `runInTenant(org)`.

★ **Both barriers are real and both are satisfied by writing that way** — measured: a foreign
`organization_id` fails `42501` (RLS), a ghost job fails `23503` (composite FK). Neither is a reason
to reach for the fenced path, which cannot be constructed here at all.

- [ ] **Step 2 ★:** Assert, in a test on real serving roles, that this write succeeds **with no lease
  row and no fence ever having existed** — that property is the whole reason this path was chosen, and
  it is the one a future refactor is most likely to break by "tidying" the write behind a guard.

- [ ] **Step 3:** Give it its caller in the same commit. If the canary path is not ready to call it,
  say so and stop — **do not land a fifth orphan.**

- [ ] **Step 4:** Commit.

---

## Task 3: `stageFiles` on the port, and the local mode field

**Files:** `packages/worker-daemon/src/supervisor/provider.ts`; the E2B provider; the fake provider

- [ ] **Step 1:** Add `stageFiles` to the `SandboxProvider` port and a `readonly fileStagingMode`
  beside `artifactExportMode`. **Model it on `exportArtifact`/`artifactExportMode` exactly**
  (`provider.ts:368-387`) — that pair is the shipped precedent for growing this port
  (`d5885053f`, DAT-009 slice 1).

★ **Do NOT touch `PROVIDER_OPERATIONS` or `OPTIONAL_PROVIDER_OPERATIONS`.** `advertisedOperations` is
typed to the frozen vocabulary precisely so a non-frozen capability cannot enter it and does not need
to. Measured cost of doing it the other way: 1 red test as optional, 27 as core — and the real price
is the conformance suite auto-advertising a fourth optional op through a fake driver that cannot
serve it.

- [ ] **Step 2:** Implement it in the E2B provider over the existing `transport.writeFiles`, and in
  the fake provider. Confirm `git diff packages/worker-protocol/src` is **EMPTY** and say so in the
  commit message, as `d5885053f` did.

- [ ] **Step 3:** Commit.

---

## Task 4: The daemon fetches, the provider stages

**Files:** `worker-daemon/src/supervisor/supervisor.ts`; the control-plane client

- [ ] **Step 1:** The daemon mints a download grant for the staged bundle and passes it — **opaque, no
  bytes** — into the provider. ★ **Grant in, reference out.** A bytes-shaped signature would route
  payloads through a daemon that is dependency-pinned precisely so it does not handle them.

- [ ] **Step 2:** The provider redeems the grant and writes with `writeFiles`, before `execute`.

- [ ] **Step 3 ★:** Check the boundary guard after every edit —
  `node scripts/check-worker-daemon-boundary.mjs`. Measured: even an `import type` of the provider
  package fails it, and so does a non-literal dynamic import. The guard is strict and it is right.

- [ ] **Step 4:** Commit.

---

## Task 5 ★★: End to end, through the mock transport

**Files:** an integration test

- [ ] **Step 1:** Stage a bundle from the control plane, run a job to the point of `execute`, and
  assert the file **is present inside the sandbox** with the right bytes — read it back through
  `transport.readFile`. No E2B key needed: the mock transport models an in-memory filesystem.

- [ ] **Step 2 ★:** Mutation-check the chain. Break each link in turn — skip the insert, skip the
  grant, skip the `writeFiles` call — and confirm **exactly one** test reds for each. A chain proven
  only at its ends is not proven.

- [ ] **Step 3:** Assert the negative: with no staged bundle, `execute` still runs. Staging must be
  optional, or every existing run breaks.

- [ ] **Step 4:** Commit.

---

## Task 6: Enrol the chain, so it cannot quietly rot

**Files:** `scripts/gate-clause-wiring.json`

- [ ] **Step 1:** Add a `wired` clause naming the staging entry point. Four components sat orphaned
  here for months because nothing counted their callers; this is the register that would have caught
  it (`E10-2-legacy-reconciliation` is the precedent).

- [ ] **Step 2 ★:** Prove the guard bites — rename the caller, confirm `check-gate-clause-wiring.mjs`
  **exits 1** naming the symbol, restore, confirm exit 0. Report both codes.

- [ ] **Step 3:** Commit.

---

## Task 7: Verification

- [ ] **Step 1:** `node scripts/ci-local.mjs` — the ~3.5-minute gate. **A first filter, not a
  verdict:** it caught neither of Unit 2.5's two real CI failures.
- [ ] **Step 2:** `AOA_RUN_WIN_INTEGRATION=1` sharded suite; reproduce any failure in isolation before
  attributing it. `tsc` does **not** cover `server/src/__tests__`.
- [ ] **Step 3:** `node scripts/check-worker-daemon-boundary.mjs` and
  `node scripts/check-frozen-worker-protocol-v1` explicitly.
- [ ] **Step 4:** Report back — do not push. Include Task 1's measured numbers, Task 5's three
  mutation results, Task 6's two exit codes, and confirmation that
  `git diff packages/worker-protocol/src` is empty.

---

## Self-review

**Coverage.** Byte source → Task 1 (measured, not chosen). Control-plane write → Task 2. Port growth →
Task 3. The daemon/provider seam → Task 4. That the chain works → Task 5. That it stays wired → Task 6.

**Deliberately NOT done.** No MCP config, no instructions bundle, no workspace, no output capture —
those are C, D, E and F. This unit delivers the channel and nothing that rides it, so **nothing here
moves `capabilityProven`**, and the PR must say so.

**Placeholders.** None. Task 1's outcome is deliberately unstated because it is a measurement, and
prescribing its answer would be the failure this unit's own design section warns about.
