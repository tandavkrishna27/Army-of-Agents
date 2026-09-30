# SVC-008a — The provider-port process primitive: a launch you can witness, a status you can read, and a stop that cannot lie — DESIGN

**Epic:** E9 (by id) · **Lane:** E4/CLI provider port · **Start SHA:** `2431d2683`
**Owns:** nothing yet — see §10. It is the specified resolution of
**[E7-F034](../../E7-coding-e2b/findings.md#e7-f034)** and the hard dependency of **SVC-008b**.
**Status:** designed, NOT implemented. Four open questions (§9) are stated, not settled.
**Revision (2026-09-09, post-review):** §1.4 and §4.6 are new and they **change the design** — the
witness-free default this ticket exists to delete was also present one layer BELOW where the first
draft looked (`mapState`), and in two further values the first draft itself specified. §2.5 settles
the unsupported-mode contract and deletes `provider_unsupported`. See §12.

> **★ THE DIRECTORY IS NOT THE JURISDICTION.** This file sits beside `SVC-008-design.md` so the
> pair its §11.2 split created stays adjacent and so the existing `#### SVC-008` graph node covers
> both (`findTicketIds`'s `/^([A-Z]+-\d+)/` reads `SVC-008a-design.md` as ticket **`SVC-008`** —
> §10 depends on that fact). **The WORK is E4/CLI's** — it lands on `SandboxProvider` and five
> implementers, and SVC-008 §9.5(ii) already ruled it "E4/CLI's port, not E9's". **The DEFECT it
> resolves is E7's** — E7-F034, filed into E7's register by an E9 branch for exactly this reason.
> Read location as convenience, never as ownership.

---

## 0. What this is, in one paragraph, and the three things it is not

**`SandboxProvider` has no concept of a process inside a sandbox.** `execute` is a completion
oracle — it resolves only when the command has already exited — and `cancel`/`kill` are
sandbox-scoped and, on the only real provider, are one metadata read that always answers
affirmatively. SVC-008a adds the missing scope: **`startProcess` / `processStatus` /
`signalProcess`, behind a `processSupervisionMode` field**, and — separately and unconditionally —
**repairs the verdict derivation of the existing `cancel`/`kill` so an affirmative stop requires a
witness**.

It is **not** the daemon service supervisor (SVC-008b), **not** the desired-state reconciler
(SVC-002), and **not** an application-health probe (§8). It emits no event, advertises no
capability, and widens no constant.

### 0.1 The non-frozen precedent, verified here rather than inherited

SVC-008 §0.2 claims a shipped precedent for adding a `SandboxProvider` method without a frozen-package
edit. **Re-opened at `2431d2683` and it holds.** `packages/worker-daemon/src/supervisor/provider.ts`
carries two such surfaces, each a method (or pair) plus a mode field, each explicitly outside the
frozen union:

| Surface | Mode field | The comment that says why it is not frozen |
|---|---|---|
| `digestArtifact` / `exportArtifact` | `artifactExportMode` (`provider.ts:433`) | `:408` — *"NOT in `advertisedOperations`: that set is typed to the FROZEN `ProviderOperation` union and these are not frozen operations."* |
| `stageFiles` | `fileStagingMode` (`provider.ts:460`) | `:437` — *"NOT in `advertisedOperations`, for the same reason the export pair is not."* |

`ArtifactExportMode` (`:72`) and `FileStagingMode` (`:103`) are both **defined locally in
`provider.ts`**, not imported from `@armyofagents/worker-protocol`, and each carries a docstring
saying that entering the frozen vocabulary would be an E4-D02 STOP. The mandatory-shape rule is
stated in both blocks: *"the METHODS are present on every implementer and only SUPPORT is optional —
'mandatory means no absent path'"*, with an unsupported call throwing `UnsupportedProviderOperation`
(`e2b-provider.ts:495`, `:524`).

**`ProcessSupervisionMode` follows that pattern exactly**, is defined locally in `provider.ts`, and
therefore needs **no `packages/worker-protocol` edit and no Protocol Custodian decision**. §3 states
the check a reader runs to confirm that after the fact.

### 0.2 Method, and the caveat that must survive

Written against source re-opened at `2431d2683`; every line number below was opened, not inherited.

**★ THE `e2b` SDK IS NOT INSTALLED IN THIS CHECKOUT, AND NEITHER IS ANYTHING ELSE.** Measured:
`packages/sandbox-e2b-provider/package.json:40` pins `"e2b": "^2.30.5"`, and there is **no
`node_modules` tree anywhere in the worktree** — not at the root, not in the package. So the SDK's
source cannot be read here either, only its consumer. **Everything this document says about what
E2B can do is a reading of `real-transport.ts` and its own recorded observations, not a provider
measurement.** SVC-008 §3.4 clause 3 and §9.4/§9.5 carry the same label; it is **not** upgraded
here, and §4.2 is deliberately structured so the half that depends on the unverified question is
separable from the half that does not.

---

## 1. Why it exists — two independent drivers, and the single sentence under both

### 1.1 Driver one: E9 cannot proceed (measured, SVC-008 §1.3c/d)

- **`execute` returns a completion, not an acknowledgement.** `SandboxProvider.execute`
  (`provider.ts:393`) resolves to `ExecuteResult` (`:258-265`) carrying `exitCode`/`signal`/
  `timedOut`. There is no `start`, no handle, no pid, and nowhere for one to go. Down the stack it
  is the same shape: `RealE2bTransport.runCommand` (`real-transport.ts:107-175`) awaits
  `sandbox.commands.run(full, …)`, which this file's own comment records — from real E2B run
  33789547290 — as `start()` then `CommandHandle.wait()` (`:128-129`). **The promise settles only
  when the command exits.** A supervisor built on it records a hung launch as a started instance.
- **`inspect` and `health` answer about the SANDBOX.** `inspect` → `transport.getInfo`; `health` →
  `transport.isRunning` → `sandbox.isRunning()`. A sandbox is up from the moment `create` resolves,
  so a health loop sourced from either streams `healthy` for a process that may never have started.

### 1.2 Driver two: a live batch defect — E7-F034 (MEDIUM, open, filed 2026-09-09)

Re-verified at source, independently of the finding:

```
RealE2bTransport.signal(sandboxId, _kind)            real-transport.ts:177-187
  -> await this.#sdk.getInfo(sandboxId, {apiKey})    // a READ, and its RESULT IS DISCARDED
  -> return { delivered: true }                      // ...and on throw, ALSO { delivered: true }
```

`_kind` is never read. `E2bSandboxProvider.cancel` (`e2b-provider.ts:378-381`) and `.kill`
(`:383-386`) are both that same read, mapped `delivered ? "stopped" : "ignored"`, so **`outcome` is
`"stopped"` unconditionally and `"ignored"` is not producible by the real provider.** Two call sites
branch on exactly that value and neither `if` can be true in production:
`CleanupAuthority.#convergeOne` (`cleanup-authority.ts:284-292`) and its deliberate mirror
`per-op-adapter.ts:267-270`.

**Verified consequence for the operator signal.** `escalate()` (`cleanup-authority.ts:241-247`) is
called from **exactly three places, all inside `#convergeOne`** (`:276`, `:286`, `:290`) — a
whole-tree grep for `escalate()` outside `__tests__` returns those three and the declaration and
nothing else. The first is unconditional; the second and third are inside the dead `if`. Therefore
`cleanup_escalation{escalation_stage=…}` (`metrics.ts:45`, emitted at `supervisor.ts:399` and
`startup-reconcile.ts:444`) **can only ever report `"cancel"` in production**, while the two pinning
tests assert `"destroy"` (`startup-sandbox-classification.test.ts:108`,
`supervisor-cancel-escalation.test.ts:40`) — a value production cannot emit.

### 1.3 ★★★ The one sentence under both drivers

**`StopOutcome` is a two-valued type with no inhabitant for "I witnessed nothing"**
(`provider.ts:146`: `"stopped" | "ignored"`). An implementation that cannot observe anything is
therefore *forced* to pick one of two affirmative claims — and `RealE2bTransport` picks the one that
reads as success, from a `catch` block where the read it performed had already failed. **The lie is
not a slip; the type makes it mandatory.**

★ And the honest answer was *nearly* in hand and thrown away: `signal`'s `getInfo` returns an
`E2bSandboxRecord` whose `state` is `"running" | "paused" | "stopped"` (`transport.ts:20`, `:25-29`).
The function fetches it and discards it. **Half A of §4.2 costs zero additional provider calls; it
reads the value the current code already paid for.** ★★★ **But that value is not itself a witness —
§1.4, which the first draft of this document got wrong by citing `transport.ts:20` without opening
the function that produces it.**

### 1.4 ★★★ The same defect, one layer below where §1.3 looked — and it is the reason for §4.6

`E2bRecordState` is a *three*-valued type with no inhabitant for "I could not read this either", and
the function that mints it **defaults to the affirmative-stop value**:

```
mapState(raw)                                        real-transport.ts:61-66
  const s = typeof raw === "string" ? raw.toLowerCase() : "";   // absent/non-string -> ""
  if (s.includes("run"))  return "running";
  if (s.includes("paus")) return "paused";
  return "stopped";                                  // <- THE DEFAULT BRANCH
toRecord(info)                                       real-transport.ts:68-75
  state: mapState(info?.state ?? info?.status)       // BOTH absent -> undefined -> ""
```

So an **absent, renamed, or unrecognized** state field on the `getInfo` payload — an SDK field
rename across the `^2.30.5` range, a partial/error-shaped response body, a future `"hibernated"` —
yields `state: "stopped"`. Under §4.2 Half A *as first drafted* that becomes `observed: "stopped"`
becomes `StopOutcome: "stopped"`: **an affirmative stop derived from a read that witnessed nothing
about the sandbox's state.** That is E7-F034's exact class, reconstructed inside its own repair. The
first draft would have shipped the defect it was written to delete.

★ **And it is already live, in a second direction.** `E2bSandboxProvider.list` projects
`hasLiveLease: record.state === "running"` (`e2b-provider.ts:425`), and `reconcile.ts:73`'s
`defaultIsOrphan` is `!summary.hasLiveLease`. A running sandbox whose state field this parser does
not recognize is therefore classified an **orphan and torn down** — a destructive decision taken
without a witness, in the opposite direction from the stop verdict. The neighbouring
`startup-reconcile.ts:391-394` already models the honest alternative for the *lease* probe
(`state === "unreachable"` → `disposition: "indeterminate"`, *"leaving to reaper"*); the *provider
record* has no such inhabitant. §9.4 owns that half; §4.2 owns the stop half.

---

## 2. The port surface

### 2.1 The declaration

```ts
// packages/worker-daemon/src/supervisor/provider.ts
// --- optional process supervision (gated on `processSupervisionMode`) -----------------
//
// NOT in `advertisedOperations`, for the same reason the export pair and stageFiles are
// not: that set is typed to the FROZEN `ProviderOperation` union. Support is declared by
// the mode below. The METHODS are present on every implementer and only SUPPORT is
// optional — "mandatory means no absent path".

/** Whether this provider can launch a process it can later observe and signal. */
export type ProcessSupervisionMode = "none" | "handle";   // defined LOCALLY, like the two above

/** Opaque, provider-minted. Never parsed by a caller; never logged unredacted. */
export type ProcessHandle = string;

// ★ ONE sandbox identifier, and it is the one inside `ExecuteInput` — exactly as `execute`
// takes it (`provider.ts:393`). A separate `sandboxId` parameter alongside an `ExecuteInput`
// that already carries one lets the two disagree, and an authority wrapper would then
// validate one sandbox while the provider launches in another.
startProcess(input: ExecuteInput, ctx: ProviderOpContext): Promise<ProcessStartResult>;
processStatus(sandboxId: string, handle: ProcessHandle, ctx: ProviderOpContext): Promise<ProcessStatusResult>;
signalProcess(sandboxId: string, handle: ProcessHandle, kind: "cancel" | "kill", ctx: ProviderOpContext): Promise<ProcessSignalResult>;
readonly processSupervisionMode: ProcessSupervisionMode;
```

`ExecuteInput` is reused verbatim (`provider.ts:246-251`) — a launch takes the same
sandbox/command/args/env a blocking execute takes. Nothing about the *request* differs; everything
about the *return* does. ★ **`startProcess` takes it as the WHOLE request** rather than as a payload
beside a redundant `sandboxId`, so the launch target is single-sourced and unambiguous; the two
handle-taking methods keep an explicit `sandboxId` because a `ProcessHandle` is opaque and does not
carry one. (Review, Codex P1 — the first draft's `startProcess(sandboxId, input, ctx)` permitted
`sandboxId !== input.sandboxId`.)

### 2.2 ★★★ The return types — the heart of this ticket

**One rule, and every type below is a mechanical consequence of it: a value returned by this port
may assert only what the implementation actually witnessed.** The way to enforce that in a type
system is to make "I witnessed nothing" a *representable value*, so no implementation is ever
cornered into an affirmative one.

```ts
/** WHAT THE PROVIDER SAW. Not what it did, not what it hoped. */
export type ProcessObservation =
  | { readonly state: "running"; readonly observedAt: number }
  | { readonly state: "exited"; readonly exitCode: number | null; readonly signal: string | null; readonly observedAt: number }
  | { readonly state: "gone"; readonly observedAt: number }
  | { readonly state: "unknown"; readonly reason: ProcessUnknownReason };

/** EVERY member names a read that was ATTEMPTED and did not answer. Nothing here names a
 *  call that was never made — see §2.5 for why `provider_unsupported` is not a member. */
export type ProcessUnknownReason =
  | "read_failed"            // the status read itself threw
  | "sandbox_unreachable"    // the sandbox could not be described
  | "handle_unrecognized"    // the provider does not know this handle
  | "state_unrecognized";    // ★ the read ANSWERED, and its answer named no state we recognize (§1.4)

export interface ProcessStartResult {
  readonly providerOpId: string;
  /** ★ NON-EMPTY by contract. See rule 5 — an empty string is "present", and the tree's own
   *  id-minting idiom (`String(x ?? "")`, real-transport.ts:104, :71) produces one. */
  readonly handle: ProcessHandle;      // presence IS the acknowledgement
  readonly acknowledgedAt: number;
}

export interface ProcessStatusResult {
  readonly providerOpId: string;
  readonly observation: ProcessObservation;
}

export interface ProcessSignalResult {
  readonly providerOpId: string;
  /** About the CALL only. ★ `"unsupported"` means THIS SIGNAL KIND is not deliverable on a
   *  provider that DOES supervise processes (real E2B has no in-sandbox graceful cancel
   *  distinct from teardown — `real-transport.ts:177-179`). It does NOT mean
   *  `processSupervisionMode === "none"`; that case throws and never returns (§2.5). */
  readonly accepted: "accepted" | "refused" | "unsupported";
  readonly observation: ProcessObservation;                    // about the PROCESS, from a re-read
}
```

Six deliberate shapes, each refusing a specific way to lie:

1. **`startProcess` has no `started: boolean`.** A boolean lets an implementation return `false` and
   a caller read it as "started, sort of". **Presence of a handle is the acknowledgement; absence is
   an exception** (`ProcessLaunchNotAcknowledged`, a new error class alongside
   `UnsupportedProviderOperation`). There is no third state to misread.
2. **`ProcessSignalResult` has no `outcome: "stopped"`.** The word "stopped" is *deleted from this
   port*. `accepted` describes only whether the provider took the request, and it is structurally
   incapable of being laundered into a claim about the process because it has no member that names
   one. The stop verdict is derived by the caller from `observation`, and only from `observation`.
3. **The signal result carries an observation the implementation obtained by re-reading**, not by
   asserting. An implementation that cannot re-read returns `{state: "unknown", reason: …}` — the
   value E7-F034's `catch` branch has nowhere to put today.
4. **`"unknown"` carries a `reason`.** A bare unknown invites "probably fine"; a reason of
   `read_failed` does not. It is also what makes a metric or log line about an unknown *actionable*
   rather than merely absent.
5. **★ `handle` is non-empty, and that is a CONTRACT clause, not a nicety.** Rule 1 makes
   *presence* the acknowledgement — so the design is only sound if "present" cannot be satisfied by
   a value that means nothing. **It can be, today, twice**: the tree's idiom for minting an id from
   an SDK response is `String(sandbox?.sandboxId ?? "")` (`real-transport.ts:104`) and
   `String(info?.sandboxId ?? info?.sandbox_id ?? "")` (`:71`), and an empty string **is present**.
   An implementation that mirrors that idiom in `startProcess` returns a handle-shaped
   acknowledgement of a launch it did not witness — §1.4's defect wearing rule 1's clothes.
   **A response from which no non-empty handle can be read is `ProcessLaunchNotAcknowledged`,
   never `handle: ""`.** T8 clause 8 asserts it; A5/B5 (§7) pin it.
6. **★ No member of `ProcessUnknownReason` names an un-made call.** Every reason is a read that was
   attempted and failed to answer, which is what makes the §2.3 handling uniform (*escalate, retry,
   never conclude*). Folding capability into it would give one value two incompatible handlings —
   §2.5.

### 2.3 ★ What each caller may conclude — and what it may not

| Value | The caller MAY conclude | The caller MAY NOT conclude | What it must do |
|---|---|---|---|
| `startProcess` resolves with a handle | *The provider accepted a launch on this sandbox and minted a handle for it.* | **Not** that the process is running now, and **not** that it ever ran a line — it may have exited between ack and this instant. | Advance the instance to `starting` only. A `healthy`-class claim requires a `processStatus`. |
| `startProcess` throws | *No launch was established.* | — | No instance-started record. Terminal `failed` + cleanup. (SVC-008 §4.2a.) |
| `observation.state === "running"` | *At `observedAt`, the process existed and had not exited.* | **Not** that it is serving, ready, or correct. Liveness is not health (§8). | May be reported as process liveness. Mapping liveness onto `service_health` is SVC-008b's decision, not this port's. |
| `observation.state === "exited"` | *The process ran and finished; `exitCode`/`signal` are its real status.* | **Not** that the outcome was success or failure — the exit code decides, and *whether an exit should be replaced* is SVC-004's. | Terminal, with the code carried through. |
| `observation.state === "gone"` | *The provider answered, and the process is not there.* | **Not** an exit status. A gone process has no code; inventing one is the `real-transport.ts:158-166` failure the E7-F014 repair already refused. | Treat as stopped, `exitCode: null`. ★ **An implementation may NOT source this from a boolean whose `false` branch also swallows an error** — `RealE2bTransport.isRunning` (`:263-268`) is exactly that shape (`catch { return false }`, which `e2b-provider.ts:601` already turns into `status: "unhealthy"`), so a `processStatus` built on it would report an affirmative absence from a read that threw. §4.6 row 4. |
| `observation.state === "unknown"` | **Nothing about the process.** Only that a read was attempted and did not answer. | ★ **Not** "stopped", **not** "still running", **not** "probably gone". This is the whole point of the value. | **Escalate.** Never conclude, never emit a process-scoped event, never skip a rung. |
| `accepted === "accepted"` | *The provider took the signal request.* | **Not** that anything stopped. | Read `observation`. If it is `unknown`, escalate. |
| `accepted === "refused"` | *The request was not taken.* | **Not** that the process is unaffected — read `observation`. | Escalate immediately; do not wait out a graceful window that cannot be running. |
| `accepted === "unsupported"` | *The provider supervises processes but cannot deliver **this signal kind**.* ★ It does **not** mean `processSupervisionMode === "none"` — that case throws (§2.5). | **Not** that the process is unaffected. | Skip the graceful window, go to the next rung, and still read `observation`. |

**The derived stop predicate, stated once so no caller re-derives it wrong:**

```
stopped     iff observation.state is "exited" or "gone"
still up    iff observation.state is "running"
undetermined iff observation.state is "unknown"     -> ESCALATE, never conclude
```

★ **Compare with today.** `cancel` returns `outcome: "stopped"` — an affirmative claim of effect —
from a function that read metadata and *from the catch branch where even that read failed*. Under
this port the same implementation returns `{accepted: "accepted", observation: {state: "unknown",
reason: "read_failed"}}`, which no caller can read as success. That is the entire fix, and it is a
type fix, not a courtesy.

### 2.4 What is deliberately NOT on this port

- **No `pid`.** A pid is a provider-internal detail whose meaning differs per runtime; exposing it
  invites callers to reason about it. `ProcessHandle` is opaque.
- **No stdout/stderr bytes.** The port's no-bytes property (`ExecuteResult`'s `stdoutRef`/
  `stderrRef` are opaque references) is preserved. **Where a *detached* process's output refs come
  from is unsettled and is §9.2**, not quietly assumed.
- **No TTL extension.** Still absent, still §9.4 of SVC-008, still unfixed by this ticket.
- **No health probe.** `processStatus` witnesses *liveness*. Application readiness is nobody's
  ticket today (§8).

### 2.5 ★★ The unsupported-mode contract — ONE behaviour: it THROWS

The first draft encoded both answers and so specified a contradiction: §2.2 listed
`provider_unsupported` as a `ProcessUnknownReason`, test B3 required
`{state: "unknown", reason: "provider_unsupported"}` when `processSupervisionMode === "none"`, and
test N1 required all three methods to **throw** `UnsupportedProviderOperation` in that same mode.
Five providers would have been implemented against it and no faithful `"none"` provider could
satisfy both. (Review, Codex P1.)

**Ruled: `processSupervisionMode === "none"` THROWS `UnsupportedProviderOperation` from all three
methods. `provider_unsupported` is DELETED from `ProcessUnknownReason`.** Four reasons, and the
first is the one that decides it:

1. **★ It is the same rule as B1, applied to its own type.** `provider_unsupported` is the one
   member of `ProcessUnknownReason` that is **not a read outcome** — no call was made, so nothing
   was attempted and nothing failed. Keeping it makes `unknown` mean two incompatible things with
   two incompatible handlings: a failed read must be **escalated and retried**, an unsupported
   capability must **never be called again**. A caller applying §2.3's uniform *"escalate, never
   conclude"* to an unsupported provider retries forever. This document's whole thesis is that a
   value may assert only what was witnessed; a value asserting *"nothing was witnessed"* about a
   read that never happened is the same category error one level up.
2. **Capability is knowable statically, so no caller needs to discover it per-call.**
   `processSupervisionMode` is a readonly field on the port. A caller branches on the field; it does
   not probe. `HealthMode`, `ArtifactExportMode` and `FileStagingMode` are all consumed that way
   today.
3. **It is the shipped precedent, verbatim.** `stageFiles`, `digestArtifact` and `exportArtifact`
   each throw `UnsupportedProviderOperation` in `"none"` mode (`e2b-provider.ts:495`, `:524`;
   `provider.ts:437-457`), and `e2b-provider.ts:490-494` explains the shape precisely — *"a contract
   stub, NOT a live check"*. §0.1 already binds this ticket to that precedent for the mode field;
   taking the precedent's mechanism and inverting its failure behaviour would be a silent fork.
4. **Loud beats composable here, because the alternative composes into silence.** A returned
   `unknown` is indistinguishable at the call site from a transient read failure, and §2.3's
   prescribed response to a transient read failure is *escalate* — so a caller that wired up a
   `"none"` provider by mistake would emit an escalation storm instead of failing at the first
   call. The throw is unmissable, names the operation, and is caught by N1.

**What this costs, stated rather than smuggled:** `signalProcess` on a `"none"` provider cannot
return a `ProcessSignalResult`, so `accepted: "unsupported"` no longer covers that case. It is
**kept, with its meaning narrowed** to the case that is real and distinct: a provider that *does*
supervise processes but cannot deliver **this signal kind** — which is real E2B's own situation
(`real-transport.ts:177-179`: no in-sandbox graceful cancel distinct from teardown). §2.2's
docstring and §2.3's `accepted` rows say so; B4′ (§7) pins it.

**Sections made to agree:** §2.2 (member deleted, `accepted` docstring), §2.3 (rows below), §4.4
(N1's driver, already a throw), §5 clause 7, §7 rows B3 and N1.

| Value | The caller MAY conclude | What it must do |
|---|---|---|
| `UnsupportedProviderOperation` thrown | *This provider does not supervise processes, and never will within this process's lifetime.* | Branch on `processSupervisionMode` before calling. Never retry, never escalate — there is nothing to escalate to. |
| `accepted === "unsupported"` | *The provider supervises processes but cannot deliver this KIND of signal.* | Skip the graceful window and go to the next rung. **Still read `observation`** — the process may have stopped for other reasons. |

---

## 3. How it stays non-frozen — and the check a reader runs

Three properties, each mechanically checkable without trusting this document:

1. **No frozen-package edit.** `git diff --stat` on the landing commit touches **zero** files under
   `packages/worker-protocol/`. `PROVIDER_OPERATIONS` gains no member; `advertisedOperations` stays
   typed to the frozen union.
2. **The mode field is local.** `grep -n "ProcessSupervisionMode" packages/worker-daemon/src/supervisor/provider.ts`
   returns the type's own `export type` line — not an `import … from "@armyofagents/worker-protocol"`.
   That is the same shape `ArtifactExportMode` (`:72`) and `FileStagingMode` (`:103`) already have.
3. **No absent path.** `grep -c "processSupervisionMode"` over each implementer package returns ≥1
   for **every** `SandboxProvider` implementer in §4.1 — the methods exist everywhere and only
   *support* is optional, which is the precedent's own stated rule.

**No Protocol Custodian STOP.** SVC-008 §0.1 established that the frozen wire already carries every
service event, payload, status and capacity field this pair eventually needs; SVC-008a adds no wire
surface at all, because it adds no event.

---

## 4. Every implementer, and what each one honestly declares

### 4.1 The inventory

`SandboxProvider` is implemented in four places (whole-tree grep for `implements SandboxProvider`
plus the two factory functions that return the shape), and the E2B lane has a second seam beneath it
with two implementations. **Both seams are in scope; the harness seam is not, and §4.5 says why.**

| # | Implementer | File | `processSupervisionMode` | Notes |
|---|---|---|---|---|
| 1 | `E2bSandboxProvider` | `sandbox-e2b-provider/src/e2b-provider.ts:210` | **`"handle"` or `"none"` — §9.1 decides** | Delegates to the transport seam below. |
| 2 | `NetworkedProviderDriver` | `provider-wire/src/driver.ts:76` | **`"none"`, honestly** | §4.4. |
| 3 | `createNoopProvider` | `worker-daemon/src/supervisor/noop-provider.ts:69` | `"none"` | Already declares `artifactExportMode`/`fileStagingMode` `"none"` at `:72-73`; one more line. |
| 4 | `createFakeSandboxProvider` (worker-daemon test support double) | `worker-daemon/src/__tests__/support/fake-provider.ts` | **script-driven, default `"none"`** | Mirrors `healthMode`/`artifactExportMode`/`fileStagingMode` at `:207-210`. §4.3. |
| 5 | `RealE2bTransport` | `sandbox-e2b-provider/src/real-transport.ts:77` | (transport seam) | §4.2. |
| 6 | `MockE2bTransport` | `sandbox-e2b-provider/src/mock-transport.ts:53` | (transport seam) | §4.3. |
| 7 | `HostileSandboxProvider` (hostile reference driver) | `sandbox-fake-provider/src/hostile-driver.ts:163` | **n/a — harness seam** | Participates in Half A only. §4.5. |
| 8 | `FakeSandboxProvider` | `sandbox-fake-provider/src/fake-driver.ts:170` | **n/a — harness seam** | Same. §4.5. |

### 4.2 ★ E2B — two halves, and only one of them depends on the unverified question

This is the structural decision of the ticket. E7-F034's repair and SVC-008b's primitive are **not
the same change**, and separating them is what lets SVC-008a ship something true even if §9.1
answers "no".

**Half A — verdict honesty. No new SDK capability. Unconditionally shippable.**

**★ It is TWO edits, not one, and the second is the one the first draft missed.** Reading the record
instead of discarding it is worthless while the record's own `state` is manufactured — §1.4. So Half
A widens the state type FIRST, then derives the verdict from it.

**A-i. `E2bRecordState` gains an `unknown` inhabitant, and `mapState` stops defaulting.**

```ts
// transport.ts:20
/** The lifecycle state a transport reports. ★ `unknown` = the transport got an answer it
 *  cannot classify, or no answer at all, for THIS field. It is not a lifecycle state; it is
 *  the absence of one, and it exists so no parser is cornered into inventing a lifecycle. */
export type E2bRecordState = "running" | "paused" | "stopped" | "unknown";
```

```ts
// real-transport.ts:61 — recognition is EXPLICIT and the fallthrough is honest.
function mapState(raw: unknown): E2bRecordState {
  if (typeof raw !== "string") return "unknown";       // absent / renamed / non-string
  const s = raw.toLowerCase();
  if (s.includes("run")) return "running";
  if (s.includes("paus")) return "paused";
  if (s.includes("stop") || s.includes("kill") || s.includes("terminat")) return "stopped";
  return "unknown";                                    // ★ NOT "stopped"
}
```

★ `transport.ts` is **local to `packages/sandbox-e2b-provider`** and is not a frozen package, so this
is the §3 non-frozen property unchanged; `E2bRecordState` is not `SANDBOX_STATES` and not
`StopOutcome`, neither of which is widened (§8 stands).

**A-ii. `E2bSignalResult` (`transport.ts:44-46`) currently carries only `delivered: boolean`.**
Replace it:

```ts
export interface E2bSignalResult {
  /** What the transport OBSERVED after the signal attempt — never what it assumed. */
  readonly observed: "stopped" | "still_running" | "unknown";
}
```

`RealE2bTransport.signal` keeps its single `getInfo` and **stops discarding the answer**:

| Situation | Today | Half A |
|---|---|---|
| `getInfo` throws | `{delivered: true}` | `{observed: "unknown"}` |
| record `state === "running"` (or `"paused"`) | `{delivered: true}` | `{observed: "still_running"}` |
| record `state === "stopped"` | `{delivered: true}` | `{observed: "stopped"}` |
| ★ **record `state === "unknown"`** — the payload answered but named no state this parser recognizes, or carried no state field at all (A-i) | `{delivered: true}` → **`"stopped"`** | `{observed: "unknown"}` |

★ **The last row is the B1 repair and it is the reason A-i exists.** Without it, an SDK field rename
anywhere in the `"e2b": "^2.30.5"` range silently restores E7-F034 — with the honest type in place,
the honest value returned everywhere else, and this document claiming the defect was fixed.

**A-iii. The compile-time forcing function, and the one place it must NOT be silenced.**
`E2bSandboxProvider.mapState` (`e2b-provider.ts:166-175`) is an exhaustive `switch` closing on
`const exhaustive: never = state`, so A-i **reds the build** until every consumer of a record state
decides what an indeterminate one means. That red is the mechanism, not a cost. Two consumers, and
they are ruled differently because they fail in opposite directions:

- **`inspect` (`:439-453`)** — an indeterminate record is a **partial read**, not a lifecycle fact
  and not an absence. It must **throw**, and specifically **NOT** `SandboxNotFoundError`: mapping an
  unreadable record onto "this sandbox does not exist" would hand the cleanup authority the same
  affirmative-from-nothing it hands `cancel` today. A new `SandboxRecordIndeterminateError` beside
  `SandboxNotFoundError`, propagated (not swallowed), is the honest shape.
- **`list` (`:419-431`) and its `hasLiveLease` projection** — ruled **out of scope and NOT
  silenced**: §9.4. The landing commit must not map `unknown` onto either `hasLiveLease` boolean
  under cover of clearing the red, because both booleans are affirmative (`false` tears a live
  sandbox down, `true` leaks an orphan). The interim rule is stated in §9.4 and carries a comment
  naming it at the call site.

`E2bSandboxProvider.cancel`/`.kill` map `observed === "stopped" ? "stopped" : "ignored"`.
**`StopOutcome` is NOT widened** — it is not a frozen type (it is declared at `provider.ts:146`, and
a grep for `StopOutcome` across `packages/worker-protocol/src/` returns nothing), but it does not
need to be: `"ignored"`'s existing contract is already *"the sandbox did not comply and the
supervisor must escalate"*, which is exactly the correct handling for both `still_running` and
`unknown`. Mapping unknown onto the **escalating** value is fail-safe; mapping it onto the
terminating value is the current defect.

★ **What Half A costs, measured.** One extra `getInfo` per converge (the `kill` rung now runs);
`cleanupEpoch` reaches 3 instead of 1 — and a whole-tree grep shows `cleanupEpoch()` has exactly
**one** consumer, a log field at `supervisor.ts:406`, so nothing branches on it; the unconditional
forced `destroy` after the `if` (`cleanup-authority.ts:293-307`, `per-op-adapter.ts:271-275`) is
unchanged. **For a CLASSIFIABLE record, no resource behaviour changes.** What changes is the
observable: see §6.

★★★ **CORRECTION (post-implementation). This paragraph said "no resource behaviour changes at
all", and that is FALSE for one class — the one this design itself introduced two sub-sections
later.** §4.2 A-iii makes `inspect` THROW on a record whose lifecycle state cannot be classified.
Before this ticket such a record was laundered by the old `mapState` default into `"stopped"` — a
terminal `SandboxState` — and ran the ordinary ladder to a forced `destroy`. It now reaches
`CleanupAuthority`'s ownership gate, `#requireOwned` re-raises, `#convergeOne` reports `"failed"`,
and **no destroy is issued**: the resource is deliberately left to the next pass and, failing that,
to the reaper. That is the intended non-destructive disposition (no teardown against a record whose
ownership could not be established), but it is unambiguously a resource-behaviour change, and it is
the one an operator most needs to know about. `E2bSandboxProvider.indeterminateRecordCount()` is
how often it fires. §6's "None." for `CleanupAuthority` is likewise superseded — see the §6 note.

**Half B — the process handle. SDK-conditional, and the condition is §9.1.**

`E2bTransport` (`transport.ts:138-168`) gains `startProcess` / `processStatus` / `signalProcess`
mirroring §2.1 at the transport scope. `RealE2bTransport` implements them **if and only if** the
pinned `e2b` version exposes a background launch handle and an in-sandbox signal to it. Its own
comment (`real-transport.ts:128-129`) records that `commands.run()` is `start()` then
`CommandHandle.wait()`, so a handle exists inside the SDK and this transport collapses it — **but
whether it is reachable through the public API, what it carries, and whether a signal can be
delivered to it were NOT verified** (§0.2: the package is not installed and there is no
`node_modules` tree to read). **If the answer is no, `E2bSandboxProvider.processSupervisionMode` is
`"none"` and that is the finding**, recorded in §9.1 and echoed into E7-F034 — not papered over by
specifying a primitive the provider cannot implement.

★ **Half A does not depend on Half B, and it is the load-bearing half.** Half A changes shipped
batch behaviour and is covered by existing ladder tests plus the new conformance test. Half B is a
port surface whose only consumer is SVC-008b; §10 records the zero-production-caller residual
honestly rather than hiding it behind a gate clause that would pass vacuously.

### 4.3 The doubles — ★ this is where E7-F034 actually lives

`MockE2bTransport.signal` (`mock-transport.ts:140-147`) **honours `kind`**, returns
`{delivered: false}` under the `ignoreCancel`/`ignoreKill` fault directives, and **sets
`record.state = "stopped"`** — a state transition `RealE2bTransport` never performs. It is not a
faithful stand-in; it is a **strictly more capable** one, in exactly the dimension under test. The
worker-daemon support double is the same shape one layer up: its own header says a fake that could
not inject *"an ignored cancel, an ignored kill"* would be a defect (`support/fake-provider.ts:9-11`),
and it duly sets `state = "cancelling"` and returns `"ignored"` under `ignoreCancel` (`:414-431`) —
behaviour production cannot produce.

**Under this design the doubles are constrained by construction, not by discipline:**

- `MockE2bTransport.signal` returns `observed: "still_running"` under a fault directive,
  `"stopped"` otherwise, and `"stopped"` for an absent record (gone *is* a witness). It gains
  a fault directive for **`observed: "unknown"`** — because a double that cannot represent the
  production case is the defect this ticket exists to close, and today no double can produce it.
  ★ It gains a **second** directive, for a record whose `state` is `"unknown"` (§4.2 A-i), so T8
  clause 6 has a no-key arm: the mock's records are minted from its own store and never pass
  through `mapState`, so without this directive the unrecognized-payload case would be testable on
  the keyed arm only — i.e. skipped in the CI that actually runs.
- The worker-daemon support double gains a `processSupervisionMode` script field defaulting to
  `"none"`, plus scriptable `startProcess` refusal, `processStatus` verdicts including `unknown`,
  and a `signalProcess` whose observation is scripted independently of its `accepted` — so a test
  can exercise the "accepted but nothing stopped" case that is real E2B's *only* case.
- **No double may be more capable than the real transport in the stop dimension.** That is not a
  review rule; §5's conformance test asserts it.

### 4.4 The networked driver — `"none"`, and said out loud

`NetworkedProviderDriver` declares `processSupervisionMode: "none"` with a docstring modelled
verbatim on its own `fileStagingMode` comment (`driver.ts:84-93`):

> *"`start_process` is NOT a member of the frozen `ProviderOperation` vocabulary (deliberately — see
> `ProcessSupervisionMode`), and `#post` is typed to that vocabulary, so this driver has no wire route
> to reach a remote provider's process supervision. Giving the adapter-manager wire an inbound
> process route is its own piece of work; claiming support without one would silently drop every
> signal and report a launch nobody made."*

**Consequence, stated rather than smuggled: the containerized/networked lane cannot supervise a
service** until an adapter-manager route exists. That is the identical, accepted cost CLI-008 Unit B
paid for `stageFiles`, and this ticket does not take it on.

### 4.5 ★ The existing conformance harness CANNOT carry Half B — and that is not an oversight

`packages/sandbox-provider-contract` drives a **single `invoke(op, args)` dispatcher keyed by the
frozen `ProviderOperation` union** (`port.ts:8`, `:151-152`), and its header states the surface is
*"EXACTLY the eight mandatory + three optional registered operations"*. `FakeSandboxProvider` and
`HostileSandboxProvider` sit behind that seam. **A non-frozen operation is therefore not expressible
through the harness at all** — the same structural reason `NetworkedProviderDriver` cannot reach
`stageFiles`.

So:

- The hostile reference driver and the fake driver participate in **Half A only** — the honest
  `cancel`/`kill` verdict, which *is* a frozen operation. Their `converge` bodies
  (`hostile-driver.ts:250-270`) already model ignore-cancel/ignore-kill; what changes is that a
  driver may report `"stopped"` **only** when its own record shows the resource terminal.
- **Half B's conformance is a NEW per-op suite over `SandboxProvider` implementers**, not a clause
  bolted onto `runSandboxProviderContract`. §5.

### 4.6 ★★★ The re-walk — every value this design specifies, asked the same question

§1.4 was found by opening a function this document **cited but did not read** (`transport.ts:20` was
quoted for its inhabitants; `real-transport.ts:61-66`, which produces them, was never opened). One
instance of that is a miss; assuming it is the only one is the error. So: **every value named by
§2.2 and §4.2, walked, with the question "can this be produced without a witness?" asked of each,
and each answer traced to the line that would produce it.**

| # | Value the design specifies | Witness-free? | The line that produces it | Ruling |
|---|---|---|---|---|
| 1 | `E2bSignalResult.observed` | **YES — B1** | `mapState`'s default branch, `real-transport.ts:65`, via `toRecord:73` | §4.2 A-i/A-ii. Fixed. |
| 2 | `ProcessStartResult.handle` (§2.2 rule 1: *presence IS the acknowledgement*) | **YES — and it attacks the design's own load-bearing rule** | The tree's id-minting idiom, `String(sandbox?.sandboxId ?? "")` (`real-transport.ts:104`) and `String(info?.sandboxId ?? info?.sandbox_id ?? "")` (`:71`). **`""` is present.** A `startProcess` written in the house idiom acknowledges a launch it did not witness. | §2.2 rule 5: non-empty by contract; no readable handle ⇒ `ProcessLaunchNotAcknowledged`. T8 clause 8, tests A5/B5. |
| 3 | `ProcessObservation.state === "exited"` with `exitCode` | No — E7-F014's repair already refused to manufacture one (`real-transport.ts:155-166`: the status is READ off `CommandExitError`, and a non-number stays a throw). | — | Inherit that rule verbatim; §7 B3′ pins it. |
| 4 | `ProcessObservation.state === "gone"` | **YES** | `RealE2bTransport.isRunning` (`:263-268`) is `catch { return false }`, and `e2b-provider.ts:601` already turns that `false` into `status: "unhealthy"`. A `processStatus` sourced from it reports an affirmative absence from a read that threw. | §2.3's `gone` row: may not be sourced from a boolean whose `false` branch swallows an error. T8 clause 9. |
| 5 | `ProcessObservation.state === "running"` | No — the only path to it is a positive match on a state string. | `mapState`'s `includes("run")` | Sound after A-i. |
| 6 | `ProcessObservation.observedAt` | Synthesizable (`Date.now()`), but it timestamps the READ, not the state, and it is **structurally absent from the `unknown` arm** — the arm with no read to timestamp. | §2.2 | Sound as written; recorded so it is not re-litigated. |
| 7 | `ProcessUnknownReason.provider_unsupported` | **YES — it names a call that was never made at all** | Nothing; that is the point. | **Deleted** — §2.5. This is B2 falling out of B1's rule rather than being settled beside it. |
| 8 | `ProcessSignalResult.accepted === "accepted"` | Yes, trivially — but §2.3 forbids concluding anything about the process from it, and §2.2 rule 2 removes every member that could name one. | — | Contained by construction. B4 pins that a caller derives nothing from it. |
| 9 | `ProcessStatusResult.providerOpId` / `ProcessStartResult.providerOpId` | Bookkeeping; asserts nothing about the process. | `#nextOpId` | Out of scope. |
| 10 | `E2bSandboxRecord.sandboxId` (Half A reads the record) | **YES** — `String(info?.sandboxId ?? info?.sandbox_id ?? "")`, `real-transport.ts:71`: an unreadable payload yields a record identifying nothing. | `toRecord:71` | **Not this ticket's value**, but the same idiom as row 2 and it feeds `list`/`inspect`. Recorded in §9.4 with row 11. |
| 11 | `ResourceSummary.hasLiveLease` (Half A's blast radius, §1.4) | **YES, destructively** — `record.state === "running"` (`e2b-provider.ts:425`) → `defaultIsOrphan` (`reconcile.ts:73`) tears down a live sandbox whose state field was unreadable. | `:425` | **§9.4** — out of scope, named, and explicitly not silenced by the A-iii compile red. |

**Three of eleven were producible without a witness inside a document written to delete exactly
that** — and one of them (row 2) sat in the rule the design calls its own heart. The lesson is
recorded rather than absorbed: **citing a type's inhabitants is not reading the function that mints
them**, and a rule about representability is only as strong as the emptiest value that satisfies it.

★ Worth recording, because it explains where E7-F034 was able to live: the `stageFiles` precedent
gave the programme a **mode-field mechanism** and **no cross-implementer conformance mechanism** —
`grep -rln stageFiles packages/*/src` returns per-package tests and no shared suite. A non-frozen
method has, until now, had nowhere to be conformance-tested. That gap is the habitat.

---

## 5. ★★★ The conformance test — what it asserts, and what it would have caught

**Name:** T8 (inherited from SVC-008 §6, which E7-F034 already names as its resolution test),
implemented here and **strengthened in two ways SVC-008's version was not**.

**Shape.** A single invariant suite, run twice: once over every `E2bTransport` implementation and
once over every `SandboxProvider` implementation.

1. **Discovery is a DIRECTORY WALK, not a hand-listed pair.** The suite reads
   `packages/sandbox-e2b-provider/src/*.ts` for `implements E2bTransport` (today: `real-transport.ts:77`,
   `mock-transport.ts:53`) and the four `SandboxProvider` sites of §4.1. **A hand-listed pair is the
   version a future third implementer silently escapes** — the REL-004 anti-orphan lesson.
2. **Anti-vacuity.** The suite fails if discovery returns fewer than two transports or fewer than
   four providers. A suite that finds nothing to check reports OK forever; that is the failure class
   this programme keeps re-learning, not a clean tree.
3. **The negative invariant — an affirmative stop requires a witness.** For each implementation:
   configure the target so the signal cannot stop it, signal, then read status. Assert the follow-up
   observation is **not** `exited`/`gone`, and that the mapped `StopOutcome` is **not** `"stopped"`.
4. **★ THE POSITIVE CONTROL — the half SVC-008's T8 did not have.** For each implementation:
   configure a target that genuinely stops, signal, read status, assert `"stopped"`. **Without this,
   a transport hardcoded to `observed: "unknown"` passes clause 3 perfectly and asserts nothing** —
   the same inversion that made the current `delivered: true` pass every ladder test. A checker
   needs a precision test as much as a recall test.
5. **★ THE UNKNOWN CASE, asserted as representable.** For each implementation: force the status read
   to fail, assert the observation is `{state: "unknown", reason: "read_failed"}` and that the
   mapped `StopOutcome` is `"ignored"`. **No implementation may be unable to produce `unknown`** —
   this is what stops the type's honest inhabitant from being decorative.
6. **★★★ THE PARTIAL / UNRECOGNIZED PAYLOAD — the clause that pins B1.** Drive `getInfo` with each
   of four payloads a real SDK can return and this parser cannot classify: `{}` (no state field at
   all), `{state: undefined}`, `{state: 42}` (non-string), and `{state: "hibernated"}` (a plausible
   future/renamed member). For each: assert the record's `state` is **`"unknown"`**, that
   `signal`'s `observed` is **`"unknown"`**, and that the mapped `StopOutcome` is **`"ignored"`**.
   ★ **Assert the negative explicitly — `StopOutcome !== "stopped"` — because that is the value the
   pre-fix default produced, and a test that only checks the positive would pass on the defect for
   three of the four payloads.** This is the clause the first draft of T8 did not have, because the
   first draft did not know `mapState` had a default branch.
7. **The unsupported mode throws.** For every `SandboxProvider` implementer declaring
   `processSupervisionMode: "none"`, assert all three methods reject with
   `UnsupportedProviderOperation` — and assert **no** implementation returns an observation whose
   reason names unsupportedness, since §2.5 deleted that inhabitant. A `grep` for
   `provider_unsupported` over `packages/*/src` returning zero is part of the clause: a deleted
   inhabitant that survives in one implementer is a fork.
8. **★ THE EMPTY HANDLE — row 2 of §4.6.** For every implementer with
   `processSupervisionMode: "handle"`, drive `startProcess` against a launch response from which no
   handle can be read (`{}`, `{pid: undefined}`) and assert it **rejects with
   `ProcessLaunchNotAcknowledged`**. Assert **no** returned `ProcessStartResult` anywhere in the
   suite carries `handle === ""`. Without this clause, an implementation written in the tree's own
   `String(x ?? "")` idiom passes every other clause while acknowledging launches that never
   happened.
9. **★ `gone` requires an answer — row 4 of §4.6.** Force the underlying liveness read to **throw**
   (not to report absence) and assert the observation is `{state: "unknown", reason: "read_failed"}`
   — **not** `"gone"`. Then have the read *answer* that the process is absent and assert `"gone"`.
   The two arms together are what distinguish an absence from a failure to look, which
   `RealE2bTransport.isRunning`'s `catch { return false }` currently cannot.
10. **Arms and skipping.** The `MockE2bTransport` arm runs in the no-key core. The `RealE2bTransport`
   arm runs **only** when `E2B_API_KEY` is present and **must report SKIPPED, never passed, when it
   is absent** — a keyless "green" on the arm whose entire purpose is to disagree with the double
   would be this same failure class one level up. Windows runs it via `AOA_RUN_WIN_INTEGRATION=1`;
   otherwise Linux CI.

### 5.1 ★ What it would have caught, precisely

Run against the tree as it stands today, clause 3 **reds on the real arm and passes on the mock**:
`MockE2bTransport` under `ignoreCancel` reports the record still running; `RealE2bTransport` returns
`{delivered: true}` → `outcome: "stopped"`. **The arms disagree, and that disagreement is E7-F034.**

**Which existing test it replaces the job of — and which it does not.** E7-F034 measured the ladder
coverage exactly: **5 vitest cases, 4 files, 3 distinct doubles, and only ONE uses
`MockE2bTransport`.** Three of the five (`supervisor-cancel-escalation.test.ts`,
`startup-sandbox-classification.test.ts` ×2) run against `worker-daemon/src/__tests__/support/fake-provider.ts`
and **never touch E2B code at all** — they are *correct* unit tests of `CleanupAuthority` whose only
fault is that production never supplies their precondition. T8 does not replace them and they are
not the defect. **The overstated claim belongs to case 4 alone**: `sandbox-e2b-provider`'s
`conformance.test.ts` calls itself the no-key core's central proof of the driver's monotonic
convergence, and for the escalation rung it validates `MockE2bTransport`'s behaviour, not
`RealE2bTransport`'s. **T8 is the test that makes that one suite's claim checkable**, by asserting
the same invariant of both and letting them disagree.

---

## 6. Migration path for the existing callers

| Caller | Code change | Behaviour change | Observable change |
|---|---|---|---|
| **`CleanupAuthority.#convergeOne`** (`cleanup-authority.ts:270-308`) | **None.** It keeps calling the frozen `cancel`/`kill`; the verdict beneath it becomes honest. ★ It cannot use `signalProcess` — it converges sandboxes discovered by reconcile/list, for which **no process handle exists**. | On real E2B, `cancel` now returns `"ignored"`, so the `kill` rung at `:284-292` **executes for the first time in production**. `kill` also returns `"ignored"`, so the stage reaches `destroy`. The forced destroy after the `if` is unchanged. | **`cleanup_escalation{escalation_stage}` starts reporting `"destroy"` where it reported `"cancel"`.** §6.1. |
| **`per-op-adapter.perOpToInvokeDriver`** (`per-op-adapter.ts:265-276`) | None. | Same escalation, by design — it is the deliberate mirror. | `faultInjected: stop.outcome === "ignored"` (`:319`, `:365`), permanently `false` today, becomes `true` on the real transport. ★ **Check the flag's meaning before landing**: it names an injected *fault*, and "the provider has no graceful stop" is a *property*, not a fault. §9.3. |
| **`Supervisor.escalateCleanup`** (`supervisor.ts:349-415`) | None. | None — it delegates to `converge`. | `cleanupEpoch` in the converged-cleanup log line goes 1 → 3. Log-only: a whole-tree grep shows `cleanupEpoch()` has exactly one consumer (`supervisor.ts:406`). |
| **`EffectAuthority`** (`effect-authority.ts:64-68`) | **Adds three fence-gated passthroughs** for the new trio, matching how it already wraps `stageFiles`. A port method reachable *around* the fence would be worse than one that does not exist. | None today (no caller). | None. |
| **SVC-008b's service loop** | The consumer. Uses `startProcess`/`processStatus`/`signalProcess` and the §2.3 conclusion table. | Out of scope here. | Out of scope here. |

★★★ **CORRECTION (post-implementation): the `CleanupAuthority` row's "None." is WRONG, and it is
wrong in a way that leaked a paid sandbox.** §4.2 A-iii makes `inspect` throw on an unclassifiable
record, and `#requireOwned` gates **cancel, kill AND destroy** on `inspect` — while `#convergeOne`
caught only `ResourceNotAvailableError`. So the throw escaped `converge()` before the unconditional
forced `destroy`: a **disarmed reaper**, strictly worse than the defect being repaired, which leaked
nothing. Worse, `Supervisor.escalateCleanup` consumes the terminal `run.cleanedUp` latch *before*
calling `converge`, so the escaping rejection also suppressed the retry — the sandbox survived until
an external reaper found it. `SandboxRecordIndeterminateError` therefore lives on the port and
`#convergeOne` reports `"failed"` for it **at every rung**: retryable, never a false convergence, and
no teardown against a record whose ownership could not be established. A first pass covered the
CANCEL rung only, which handled the single-shot case and left the *ordering* case — a record readable
at cancel and unreadable at kill or destroy — leaking exactly as before; the pinning tests therefore
drive the ORDER of classification, not a single indeterminate fixture
(`svc-008a-escalation-reachability.test.ts`). The `Supervisor.escalateCleanup` row's "None." holds
only because `converge` no longer rejects.

### 6.1 ★ The new observable, and why it is an improvement rather than noise

Today an operator reading `cleanup_escalation` on the E2B fleet sees `escalation_stage="cancel"` on
every converge, which reads as *"everything stopped politely."* **That reading is false and
unfalsifiable**: a real E2B sandbox that resists teardown is indistinguishable from one that
complied. After Half A the same operator sees `"destroy"` on every converge, which reads as *"this
provider has no graceful stop; every cancellation is a hard teardown"* — **which is true, and is the
single most useful fact about the lane.** The metric stops being a compliance signal and becomes a
capability signal, and it becomes *differential* the moment a provider with a real graceful stop
joins the fleet.

**No existing assertion breaks.** A grep for `escalation_stage`/`escalationStage` across the two
test packages returns seven assertions, all expecting `"kill"`, `"destroy"` or `"none"`; **none
expects `"cancel"`.** The two production-metric pins already assert `"destroy"` — the value
production could not previously emit — so Half A makes them true rather than red.

---

## 7. Test plan — each with the failing case that must be OBSERVED RED first

| # | Test | Observed RED before the fix | Mutant that must re-red it after |
|---|---|---|---|
| **A1** | **★ THE E7-F034 REGRESSION — a cancel that cannot stop must no longer report stopped.** Drive `E2bSandboxProvider.cancel` over a `RealE2bTransport` whose `getInfo` resolves a `state: "running"` record; assert `outcome === "ignored"`. Then over one whose `getInfo` **throws**; assert `outcome === "ignored"`, not `"stopped"`. | **Red today, twice, and the second is the finding in one line:** both cases return `{delivered: true}` → `"stopped"`, the second from the `catch` (`real-transport.ts:181-186`). Run it and watch an affirmative stop come out of a read that threw. | Restore `return { delivered: true }` in either branch → red. ★ Return `"stopped"` for `state: "paused"` → red (a paused sandbox's process was not stopped). |
| **A2** | **The `kill` rung executes.** Over the same running-record transport, run `CleanupAuthority.converge`; assert `cancel` **and** `kill` were both invoked and `escalationStage() === "destroy"`. | Red today: `cancel` returns `"stopped"`, the `if` at `:284` is false, `kill` is never called, stage stays `"cancel"`. Assert the call count and watch it be 0. | Map `unknown` → `"stopped"` instead of `"ignored"` → the rung goes dead again → red. |
| **A3** | **The metric reports what happened.** Same run; assert `cleanup_escalation{escalation_stage="destroy"}`. | Red today (`"cancel"`). ★ Run it **before** Half A and read the label, not an exception — the current value is the defect made visible. | Emit the stage before converging instead of after → red. |
| **A4** | **★★★ THE B1 REGRESSION — an unreadable state is not a stop.** Drive `E2bSandboxProvider.cancel` over a `RealE2bTransport` whose `getInfo` resolves each of `{}`, `{state: undefined}`, `{state: 42}`, `{state: "hibernated"}`; assert `outcome === "ignored"` **and** `outcome !== "stopped"` for all four. | **Red today, four times** — `mapState` (`real-transport.ts:61-66`) defaults to `"stopped"` for every one of them. ★ Run it against Half A **as first drafted** (read the record, no `unknown` inhabitant) and watch it stay red: this is the case the verdict repair alone does not fix. | Restore `return "stopped"` as `mapState`'s fallthrough → red. ★ Add `"unknown"` to the type but map it to `observed: "stopped"` in `signal` → red. |
| **A5** | **★ No affirmative id is minted from an unreadable payload.** Assert `toRecord`-shaped id minting and (Half B) `startProcess` never produce an empty-string identifier: a `getInfo` payload with no `sandboxId`/`sandbox_id`, and a launch response with no handle, must fail rather than resolve `""`. | Red today for the record (`real-transport.ts:71` resolves `""`), and red against any `startProcess` written in that same idiom — build that variant first and watch a caller treat `handle: ""` as a started process. | Reintroduce `String(x ?? "")` on either → red. |
| **B1** | **`startProcess` acknowledges without waiting.** With `processSupervisionMode: "handle"`, assert `startProcess` resolves **before** the command exits (fake clock: resolve, advance, then observe `running`). | Red against any implementation built on `execute`, which resolves only at exit. Build that variant first and watch the resolve land after the exit. | Make `startProcess` await the command → the resolve lands at exit → red. |
| **B2** | **A launch that cannot be acknowledged THROWS.** Script a refusing provider; assert `ProcessLaunchNotAcknowledged` and that **no handle** is returned. | Red against a first implementation returning `{handle: "", ok: false}` — build that and watch a caller treat an empty handle as a start. | Return a handle plus a boolean instead of throwing → red. |
| **B3** | **`processStatus` never launders a sandbox answer into a process answer.** With a live sandbox and an exited process, assert `observation.state === "exited"` and that `exitCode` was READ, never defaulted (§4.6 row 3). ★ **With `processSupervisionMode: "none"`, assert it REJECTS with `UnsupportedProviderOperation`** — §2.5; the first draft required `{reason: "provider_unsupported"}` here and simultaneously required a throw at N1, which no implementation could satisfy. | Red against the naive implementation that falls back to `isRunning`/`getInfo`. Build it and watch a `running` appear for a process that exited — §1.1's defect, in miniature. | Fall back to `provider.health` when the process op is unsupported → red. Return `unknown` instead of throwing in `"none"` mode → red (and N1 agrees rather than contradicts). |
| **B3′** | **★ A failure to look is not an absence.** Force the liveness read to **throw**; assert `{state: "unknown", reason: "read_failed"}`, **not** `"gone"`. Then have it answer absence; assert `"gone"`. | Red against a `processStatus` built on `RealE2bTransport.isRunning` (`:263-268`, `catch { return false }`) — the shape `e2b-provider.ts:601` already ships as `status: "unhealthy"`. Build it and watch a thrown read become an affirmative "not there". | Collapse both arms back to one boolean → red. |
| **B4** | **`signalProcess` derives nothing from `accepted`.** Script `accepted: "accepted"` with `observation.state: "running"`; assert the caller's derived verdict is *not stopped*. | Red against an implementation that returns a `stopped`-shaped value on acceptance — i.e. against E7-F034 rebuilt one layer up. | Add an `outcome: "stopped"` field to `ProcessSignalResult` and read it → red (and the field's absence is the design). |
| **T8** | **★★★ THE CONFORMANCE TEST — §5.** Directory walk; negative invariant; **positive control**; **unknown representable**; **★ partial/unrecognized payload (clause 6)**; unsupported-mode throw (clause 7); **★ no empty handle (clause 8)**; `gone` requires an answer (clause 9); both arms; real arm SKIPPED without a key. | **Red today because the arms disagree** — the mock reports still-running under `ignoreCancel`, the real transport reports stopped. That disagreement is E7-F034. | Hardcode `delivered: true` on the real transport → arms disagree → red. Hardcode `observed: "unknown"` everywhere → **caught by the positive control**, which is why it exists. ★ **Delete the real arm and keep the mock** → green and meaningless; there is no automated mutant for that, which is why discovery must be a directory walk rather than a hand-listed pair. |
| **T8′** | **Anti-vacuity of T8 itself.** Assert the walk discovered ≥2 transports and ≥4 providers, and that each discovered implementation ran every clause. | Not red today — it is a guard, and it is labelled as one rather than presented as a defect this unit fixes. | Point the walk at an empty directory → red (today it would report OK). |
| **B4′** | **★ `accepted: "unsupported"` means the signal KIND, not the mode.** On a `"handle"`-mode provider that cannot deliver a graceful cancel (real E2B, `real-transport.ts:177-179`), assert `signalProcess(…, "cancel")` returns `accepted: "unsupported"` **and still carries a re-read `observation`**; assert the caller skips the graceful window but does **not** conclude anything about the process. | Red against an implementation that returns `"unsupported"` with a synthesized observation, or that omits the observation entirely. | Return `"unsupported"` from a `"none"`-mode provider instead of throwing → red (§2.5). |
| **N1** | **The networked driver's `"none"` is honest and enforced.** Assert `NetworkedProviderDriver.processSupervisionMode === "none"` and that all three methods throw `UnsupportedProviderOperation` — ★ **the same behaviour B3 now requires**, so a `"none"` provider has exactly one contract to satisfy. | Red against a driver that declares `"handle"` and no-ops — the exact shape CLI-008 Unit B refused for `stageFiles`. | Declare `"handle"` → red. Return an `unknown` observation instead of throwing → red. |

**Not tested here, deliberately:** the emission of any `service_*` event, the supervise loop, the
budget, the capability constant. Those are SVC-008b's T0–T7 and this unit must not appear to cover
them.

---

## 8. What this does NOT do

- **It is not the supervisor.** No `service-lifecycle.ts`, no `runLifecycle` branch, no
  `run-op-deadline.ts` arm, no event emitted, no `SUPERVISABLE_WORKLOAD_CAPABILITIES` edit. **All
  SVC-008b.** After SVC-008a, a service job is still unplaceable and no service is supervised.
- **It is not the reconciler.** Desired state, duplicate placement, how many instances should exist
  — **SVC-002**.
- **It is not health.** `processStatus` witnesses **liveness** (does this process still exist).
  Application readiness — a probe, an endpoint, a `/healthz` — is a different question that **no
  ticket owns today**, and mapping liveness onto `service_health` is SVC-008b's decision. ★ Recorded
  as a named gap rather than absorbed: `running` is not `healthy`, and a design that quietly equates
  them rebuilds §1.1's defect with better types.
- **It does not fix the five-minute effect-authority window, the 240-second run-op ceiling, or the
  absent TTL extension.** SVC-008 §11.4 lists those as three independent blockers; **SVC-008a
  resolves none of them.** Even with this port shipped, a service run longer than five minutes still
  ends in a billable orphan until SVC-008 §9.1 is ruled on.
- **It does not give the networked lane process supervision** (§4.4).
- **It does not widen `StopOutcome`, `ProviderOperation`, or any frozen schema** (§3). ★ It **does**
  widen one type — `E2bRecordState` gains `"unknown"` (§4.2 A-i) — and the distinction is stated
  rather than buried: that type is declared in `packages/sandbox-e2b-provider/src/transport.ts:20`,
  is local to that package, and is neither `SANDBOX_STATES` (`provider.ts:130-139`) nor
  `StopOutcome` (`:146`) nor anything under `packages/worker-protocol/`. §3's three mechanical
  checks are unaffected; a reader running them still finds zero frozen-package files touched.
  **The `SANDBOX_STATES`/`ResourceSummary` widening that a full repair of §1.4's second direction
  would need is exactly what §9.4 declines to do here.**

---

## 9. Open questions

**9.1 — ★ Can the pinned `e2b` version express a detached process with a handle, and can a signal
reach it?** This is the condition on Half B and it is **not settled here**, for the reason §0.2
states: the SDK is not installed and there is no `node_modules` tree in this checkout, so the only
evidence is `real-transport.ts:128-129`'s recorded observation (from real E2B run 33789547290) that
`commands.run()` is `start()` then `CommandHandle.wait()`. That establishes a handle exists *inside*
the SDK; it does not establish that the public API exposes a background launch, what the handle
carries, or that an in-sandbox SIGTERM/SIGKILL to it is reachable. **Whoever answers should answer
by running it, not by reading it.** ★ **If the answer is no, that is the finding**: `E2bSandboxProvider`
declares `processSupervisionMode: "none"` honestly, Half A ships anyway, and SVC-008b falls to its
§3.4 fallback — a service that can never be reported healthy and can never be stopped gracefully,
which SVC-008 §5.1 clause 5 says does not earn the capability widening. **Do not specify a primitive
the provider cannot implement; record that it cannot.**

**9.2 — Where do a detached process's stdout/stderr refs come from?** `ExecuteResult` carries
`stdoutRef`/`stderrRef` allocated when the command completes. A process that has not completed has
no completion to carry them. Options: allocate at launch and return them on `ProcessStartResult`
(requires the provider to name a sink before it has output), or carry them only on the terminal
observation (leaving a running service's output unaddressable until it stops). **Not decided** — it
touches E5's object-byte capture and choosing here would pre-empt it. §2.4 records the omission
rather than assuming an answer.

**9.3 — Is `faultInjected: stop.outcome === "ignored"` still the right predicate after Half A?**
(`per-op-adapter.ts:319`, `:365`.) It is permanently `false` today and becomes permanently `true` on
the real transport — which is *accurate* about the outcome and *wrong* about the word: an injected
**fault** is a test directive, and "this provider has no graceful stop" is a **property**. Leaving it
would replace a dead flag with a mislabelled one. **Not decided here**; it is a small call that
belongs with whoever lands the adapter, and it must be made deliberately rather than inherited.

**9.4 — ★ What does an indeterminate record project as, in `list`/`inspect`?** Opened by §4.2 A-iii's
compile red and measured in §1.4 and §4.6 rows 10-11. `ResourceSummary.hasLiveLease` is a
**boolean**, and after A-i there is a record state that is neither leased nor unleased. **Both
booleans are affirmative claims made from nothing**, and they fail in opposite directions: `false`
sends a live sandbox whose state field was unreadable to `defaultIsOrphan` (`reconcile.ts:73`) and
then to teardown; `true` leaks a genuinely dead one past every converge. The honest resolution is a
third disposition, and the tree already has the shape for it one file away —
`startup-reconcile.ts:391-394` maps an `unreachable` lease probe to `disposition: "indeterminate"`
and *"leaving to reaper"*.

**Why it is not settled here.** That third value lives on `ResourceSummary`/`SandboxState`
(`provider.ts:130-139`), which are consumed by `startup-reconcile`, `reconcile`,
`provider-wire/projection.ts` and the contract harness — a cross-package widening whose blast radius
is larger than everything else in this ticket combined, in a lane SVC-008a does not own. Specifying
it here would be the mistake §4.5 refused.

**★ What the landing commit MUST do anyway, so this is a deferral and not a hole.** The A-iii red
must **not** be cleared by mapping `unknown` onto either boolean silently. The interim rule is:
`hasLiveLease: record.state === "running" || record.state === "unknown"` — the **non-destructive**
direction, matching the `indeterminate → leave to the reaper` precedent above — carrying a
`// SVC-008a §9.4` comment at `e2b-provider.ts:425` and a counter or log field so an operator can
see how often it fires. **An indeterminate record must never silently become an orphan verdict**,
which is what ships today. Whoever answers 9.4 replaces the boolean; until then the interim rule
loses orphans to the reaper rather than tearing down live work, and says so out loud.

---

## 10. Register obligations for the landing commit

- **E7-F034 stays `open` and stays `unowned`, and its entry is amended to point here.** ★ The reason
  is mechanical and worth stating because it is a real constraint on this manifest:
  `findTicketIds` (`scripts/check-finding-ownership.mjs:40-54`) extracts ids with
  `/^([A-Z]+-\d+)/`, so **`SVC-008a-design.md` yields the ticket id `SVC-008`, not `SVC-008a`** —
  verified by running the regex. Declaring `"ticket": "SVC-008a"` would red `owner_ticket_missing`;
  declaring `"ticket": "SVC-008"` would name the ticket that **explicitly refused jurisdiction**
  (SVC-008 §10, §9.5 ii), which is the false claim of ownership `finding-ownership.mjs` exists to
  prevent. The same shape is already on the record for `REL-FOUNDATION-GATE`. **So the pointer is
  prose, in both the finding and the manifest reason, and the status is unchanged.** It closes when
  Half A ships and T8 is green with both arms — not when this design lands.
- **E9-F002's §1.5 is amended** to name the split: blockers (4) and (5) are owned by **SVC-008a**
  (this file) and blockers (1), (2), (5)-consumption by **SVC-008b**. The finding stays `open` and
  stays owned by `SVC-008`; nothing in the manifest changes.
- **The `#### SVC-008` node in `docs/replatform/program-design.md` is amended** to record the split.
  ★ **A `#### SVC-008a` node is NOT added**: `ticket-graph-coverage.mjs`'s node regex is
  `/^####\s+([A-Z]{2,5}-\d{3})\s/`, which does not match `SVC-008a`, and its file regex resolves
  this file to `SVC-008` — so the existing node already covers it and a new one would be invisible
  to the guard that exists to see nodes.
- **No gate-clause entry is added.** `countProductionCallers`
  (`scripts/check-gate-clause-wiring.mjs`) returns 0 for a symbol that does not exist and an
  `unwired` clause with count 0 **passes**, so a clause naming `startProcess` today would assert
  nothing. ★ **And a residual is recorded here rather than hidden:** Half B ships with **zero
  production callers** — SVC-008b is the only consumer. That is this programme's known failure
  class, and the mitigations are named, not assumed: T8's directory walk exercises every
  implementer without a production caller; Half A *does* have production callers and is the
  load-bearing half; and the gate clause is added by **SVC-008b's** implementation commit, naming
  `runServiceLifecycle`, when a caller exists.
- **E7-F034's amendment records the WIDENED root cause** (§1.4): the defect is not only the
  `catch { return { delivered: true } }` the finding measured — the record that `catch` discards is
  itself minted by a parser that **defaults to the affirmative-stop value**, so the finding's own
  resolution would have reproduced it. ★ **No new finding is filed for this**, and that is a
  deliberate call rather than an omission: it is the same function, the same class and the same
  repair as E7-F034, and splitting it into a second entry would let one half be closed while the
  other shipped. **§9.4's `hasLiveLease` projection is the part that is genuinely a different
  defect** — a destructive orphan verdict rather than a lenient stop verdict, in a lane this ticket
  does not own — and it is carried as an open question with a mandatory interim rule (§9.4) until
  whoever owns `ResourceSummary` can be handed it.
- **No `ownerTicketDeferrals` entry is created or removed.**

---

## 11. The plain statement

**Today the provider port cannot say "I don't know", so it says "stopped".** Every production
cancellation on the real E2B lane is a hard teardown reported as a graceful stop, from a metadata
read that may itself have failed; the escalation rung that would have caught it is unreachable; and
the only double that could have exposed it is more capable than the thing it stands in for.

SVC-008a's smaller half fixes that with no new provider capability at all — the honest answer is
already fetched and discarded. Its larger half adds the process scope SVC-008b needs, **conditional
on a question about the E2B SDK that this checkout cannot answer** (§9.1). If that question answers
no, the honest outcome is a provider that declares `processSupervisionMode: "none"` and a service
supervisor that does not earn its capability — which is a worse product and a true one.

---

## 12. Revision log — what review changed, and the one that changes the design

**2026-09-09, post-review.** Four changes, listed with what each would have cost if it had shipped.

1. **★★★ §1.4 + §4.2 A-i/A-iii + §4.6 + T8 clause 6 + test A4 — the witness this ticket rests on
   failed open, one layer below where the design looked.** `mapState` (`real-transport.ts:61-66`)
   defaults to `"stopped"`, so an absent, renamed or unrecognized state field made Half A's
   `observed`, and therefore `StopOutcome`, affirmatively `"stopped"` from a read that witnessed
   nothing about the state. **The first draft cited `transport.ts:20` for the type's inhabitants and
   never opened the function that mints them.** Shipped, it would have rebuilt E7-F034 inside
   E7-F034's own repair, with the honest type in place and this document claiming the fix.
   Half A is now two edits, and the type edit is first.
2. **★★ §4.6 — the re-walk the miss demanded**, since one instance of "cited but not opened" is
   evidence of a method, not an accident. It found **two more**: `ProcessStartResult.handle`, where
   the tree's own `String(x ?? "")` idiom satisfies §2.2 rule 1's *"presence IS the
   acknowledgement"* with an empty string (→ rule 5, T8 clause 8, test A5); and
   `ProcessObservation.state === "gone"`, sourceable from `isRunning`'s `catch { return false }`
   (`:263-268`) — a shipped shape, already visible as `health`'s `"unhealthy"` at
   `e2b-provider.ts:601` (→ §2.3, T8 clause 9, test B3′). **Three of eleven specified values were
   producible without a witness inside a document written to delete exactly that.**
3. **★★ §2.5 — the unsupported-mode contract was self-contradictory** (B3 required an `unknown`
   observation, N1 required a throw, §2.2 and §4.4 encoded both; five providers, no satisfiable
   contract). **Ruled: it throws**, and `provider_unsupported` is deleted from
   `ProcessUnknownReason` — not as a coin-flip between two workable options, but because it was the
   one member of that union naming a call that was never made, which is change 1's rule applied to
   the design's own type. `accepted: "unsupported"` survives with a **narrowed** meaning (this
   signal *kind*, on a provider that does supervise) — a case real E2B actually has.
4. **§2.1 — `startProcess` takes `ExecuteInput` alone**, not `(sandboxId, input)`, which permitted
   the validated and the launched sandbox to differ (Codex P1).

**Unchanged, deliberately:** the non-frozen mode-field precedent (§0.1), T8's directory walk +
anti-vacuity + positive control (§5), the SDK caveat (§0.2, §9.1), and the SVC-008a/008b scope split
(§8, §10). Review strengthened those; nothing here weakens them. §9.4 is new and is a **deferral
with a mandatory interim rule**, not a hole.
