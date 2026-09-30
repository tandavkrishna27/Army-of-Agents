# DECISION REQUEST — CLI-008 Unit C: how a distributed (E2B) coding agent reaches `mcp__aoa__*`

**Date:** 2026-09-18
**Decision:** **CLI-008 Unit C / E7-F003 (tools row)** — *"By what topology does a distributed
worker-lane E2B coding agent reach the `mcp__aoa__*` tool surface, and what is the precondition
that must hold before that surface is turned on."*
**Ticket:** `CLI-008` (owns `E7-F003`), epic `E7 — Coding/CLI workload on E2B`.
**Adjacent, ratified, and NOT relitigated here:** the DE-08 / E8-F003 sandbox-egress ruling
(`docs/replatform/DECISION-REQUEST-de08-sandbox-egress.md`, RULED 2026-09-11: provider-level egress
denial is CONCEDED at the managed-shared tier). This paper reads that ruling as settled and prices
against it; it does not re-open it.
**Status changes made by this document:** **NONE.** No finding is closed, struck, re-dispositioned
or re-owned; no `deliveryStatus` moves; no clause in
`docs/architecture/distributed-execution-threat-controls.json` is edited; no
`scripts/gate-clause-wiring.json` enrolment is added; Unit F stays frozen and is not touched.
**Choosing among the options in §4 IS the decision being requested**, so this paper makes none of
them. **Production code written: none.**

---

## 0. The three facts stated first, before the options

1. **The distributed sandbox is tool-less by construction, today.** `buildSandboxInvocation`
   (`server/src/services/task-run-sandbox-invocation.ts:149`) stages the prompt (+ optionally the
   instructions bundle) and emits a `sh -c` argv that reads them onto the CLI's stdin. There is **no
   `--mcp-config`, no `--allowedTools mcp__aoa`, no `AOA_API_URL`/`AOA_API_KEY`** anywhere in the
   emitted claude arm (`:186-187`) or codex arm (`:211-212`), and the workload the batch builder
   submits (`server/src/services/task-run-batch-workload.ts:320-327`, validated by the frozen
   `batchWorkloadV1Schema` at `:331`) carries only `{command, args, stdinArtifactId,
   maxRuntimeSeconds}`. **Unit C is exactly this unbuilt scope** — the `E7-F003` "tools" row that
   keeps `capabilityProven` false on every real run.

2. **Two different egress surfaces are in play and the handoff conflates them.** They are priced
   separately in §2. One is a server-side, empty-by-default, structurally-unmounted classifier; the
   other is the E2B provider network model that E8-F003 measured inert on real hardware. They are
   not the same object and a mechanism must be priced against **both**.

3. **The crew "brokered" reference exists but is on a different substrate and its live pull is
   deferred.** The transport-selection seam at
   `server/src/services/internal-agent/aoa-agents/runner.ts:736`
   (`mcpParams.brokered = acquired.sandbox?.environment.driver === "sandbox"`) is production-mounted,
   but it rides the **in-process #320 crew/org runner**, not the distributed worker-daemon lane that
   `buildSandboxInvocation` feeds, and even there the live in-VM brokered tool pull is **deferred**
   (`DAT-007-result.md`: core blocked; memory context is a **pre-staged** actor-gated bundle, not a
   live brokered pull). §3 states this honestly so it is not read as "the tools already reach the
   distributed lane."

**What this settles for the decision.** The transport a distributed agent would use to reach
`mcp__aoa__*` *already exists as code* (the brokered HTTP `aoa` entry, §3), the frozen wire needs
*no new operation* to carry a tool call (§4), and the egress model *cannot* be the thing that bounds
a credentialed sandbox (§2, from the DE-08 ruling). So the open question is not "can we build a
transport" — it is **"which topology do we mount, and what must be true before the run-identity
credential that topology carries is allowed to reach the broker."** That is a founder decision.

---

## 1. The gap, measured by symbol

`E7-F003`'s "tools" row is still true at HEAD, verified against the current source, not a prior line
count:

- **The invocation is prompt-only.** `buildSandboxInvocation` builds its staged set from exactly two
  entries — `STAGED_PROMPT_PATH` (`task-run-sandbox-invocation.ts:60`) and, when present,
  `STAGED_INSTRUCTIONS_PATH` (`:64`) — and returns
  `args: ["-c", script, input.binary, ...paths]` (`:220`). The claude script is
  `exec "$0" --print - --dangerously-skip-permissions --output-format stream-json --verbose
  [--append-system-prompt-file "$2"] < "$1"` (`:186-187`). **No MCP flag appears in either arm.**
  A grep of the file for `mcp` returns nothing.

- **The workload has no env or secret channel of its own.** The distributed workload is the frozen
  `batchWorkloadV1Schema`-shaped `{command, args, stdinArtifactId, maxRuntimeSeconds}`
  (`task-run-batch-workload.ts:320-327`). It carries no `env` and no `secretHandles` — those ride the
  lease envelope / `ExecuteInput{sandboxId, command, args, env}` and the CLI-007 secret-handle path,
  **not** the workload. This matters for pricing: a tool credential does not travel *in* the
  workload; it travels as a secret handle beside it.

- **Consequence.** A distributed `claude`/`codex` run today has its identity (Unit D's instructions
  bundle) and its task (the staged prompt) but **no callable AoA tool surface** — it cannot read
  memory, create a task, ask a human, or write an artifact through `mcp__aoa__*`. Unit D deliberately
  left this open and named it a sub-case of `E7-F003` row 1
  (`CLI-008-design.md` §4a, "It does not add `--model`… no output capture"). Unit C is the row.

---

## 2. The two egress surfaces, cleanly separated — and neither is a control here

A mechanism that puts a run-identity credential inside the guest must be priced against what, if
anything, bounds where that guest can then reach. There are two candidate bounds and **both fail to
bound, for different reasons**:

### (a) The DAT-005 proxy-lane `control_plane` deny class — empty by default AND unmounted

`server/src/services/egress-policy.ts` defines a **pure** classifier
`classifyEgressDestination(...)` (`:145`) whose `control_plane` class (`classifyAddress`, `:118`) is
**config-sourced**: `resolveControlPlaneDenySet` (`:173`) reads `AOA_CONTROL_PLANE_DENY_CIDRS`
(`:176`) and returns **the empty set when the var is absent** — i.e. it **denies nothing by
default**. Two independent reasons it is not the thing that bounds a sandbox:

- **Empty by default.** Absent operator config, the `control_plane` class never matches, so even on
  the lane that *does* consult it, it blocks nothing.
- **Structurally unmounted.** The ratified DE-08 paper records this classifier as inspecting **zero
  packets** — "its only non-test importer is a module no production path reaches (STRUCTURAL, by
  caller count)" (`DECISION-REQUEST-de08-sandbox-egress.md` §0). It is a server-side proxy-lane
  primitive; the E2B guest does not route its egress through it.

**Do not treat this classifier as the thing E8-F003 measured.** It is a config-driven, default-off,
proxy-side function — not the provider network model below.

### (b) The E2B provider network allowlist — MEASURED inert, ratified as CONCEDED

E8-F003 measured, on real E2B, that **all three** provider network constructions
(`metadata.egressAllowlist`; `network.denyOut`-only; `network` default-deny + `allowOut`) are inert —
`169.254.169.254` answers HTTP 401 from inside the guest on every one
(`DECISION-REQUEST-de08-sandbox-egress.md` §0, runs `33857218680` / `34085130892` / `34528397309`).
The founder **RULED 2026-09-11** that provider-level egress denial is UNAVAILABLE at the
managed-shared tier and CONCEDED reachability of the metadata / control-plane range there, with
confidentiality carried instead by the **credential taxonomy** (host/operator/cross-tenant secrets
never enter the VM; only the run's own credentials do; blast radius = that one company's own data).

### What (a)+(b) mean for Unit C

- **Reaching the broker is not blocked.** Because E2B egress is permissive (b), a guest holding an
  `aoa` HTTP MCP config *can* reach `${AOA_API_URL}/companies/${cid}/mcp`. Unit C needs no new
  egress *allowance* to work.
- **But egress cannot bound the credential either.** The same permissiveness means a leaked or stale
  run credential inside the guest **cannot be fenced at the network layer** — there is no working
  default-deny to lean on. The frozen `sandbox.filtered_egress` capability
  (`packages/worker-protocol/src/capabilities.ts:59`) names the intent, but E8-F003 measured it does
  not deliver at this tier. **The bound on a credentialed sandbox must therefore be the credential's
  own scope, enforced server-side — not the network.** This is the load-bearing constraint on the
  recommendation.

---

## 3. The crew "brokered" reference, stated honestly

The handoff points at the crew path as prior art. It is real, but two qualifications keep it from
being read as "the distributed lane already has tools":

- **Different substrate.** `runAoaAgent` (`internal-agent/aoa-agents/runner.ts`) is the **in-process**
  crew/org runner the AoA server drives directly; on `cloud_auth` it can acquire an E2B environment
  (`acquireExecutionContext`, `:716`) whose `driver === "sandbox"`. That is the **#320 in-process
  E2B path**, *not* the worker-daemon poll/lease/supervisor lane that `buildSandboxInvocation` feeds.
  The transport-selection seam (`:736`) sets `mcpParams.brokered = driver === "sandbox"` and
  `mcpParams.apiBaseUrl = process.env.AOA_API_URL` (`:742`); `buildMcpConfig` (`:795`) and
  `buildCodexAoaMcpSpec` (`:809`) then emit the brokered `aoa` HTTP entry, and claude gets
  `["--mcp-config", cfgPath, "--strict-mcp-config", …]` injected (`:812`). **That plumbing is
  production-mounted — on the in-process substrate only.**

- **Even there, the live pull is deferred.** `DAT-007-result.md` records that the brokered tool
  surface + run-JWT auth + `#118/#119` gates *already exist* (#320), but the two pieces that make a
  **remote-worker** caller safe — item #1, the fence-bound `runId → job → active-lease/fence`
  resolver, and item #2, the worker-dispatch call site that sets `brokered:true` — did **NOT** land
  (item #1 "NOT FEASIBLE as reuse — needs a NET-NEW resolver + a design decision"; item #2 "NOTHING
  TO WIRE in this worktree"). In the interim, CLI-002 delivers the agent's memory context as a
  **pre-staged actor-gated bundle** (`CLI-002-design.md` D2), not a live brokered pull.

So the crew seam proves the **transport shape** (an HTTP `aoa` MCP entry, no `DATABASE_URL`, run-JWT
bearer) is buildable and mounted — but it does **not** prove that a *distributed, remotely-leased*
sandbox can safely present a run credential to the broker. That missing proof is precisely the
precondition §5 turns on.

---

## 4. The candidate mechanisms, priced

Each is priced against (i) the frozen `worker-protocol` wire — `WORKER_PROTOCOL_OPERATIONS` is **10
ops with no tool op** (`packages/worker-protocol/src/transport.ts:757-768`), so a tool call must ride
HTTP JSON-RPC to `/companies/:cid/mcp`, never a new wire op — and (ii) the E2B egress model of §2.

### Mechanism A — extend the crew brokered HTTP transport onto the distributed lane

Reuse `buildMcpConfig`/`buildCodexAoaMcpSpec`'s brokered `aoa` HTTP entry
(`cli-mode.ts:330`, `:339-343` → `{type:"http", url:"${apiBaseUrl}/companies/${cid}/mcp",
headers:{Authorization:"Bearer ${AOA_API_KEY}"}}`) for a **worker-dispatched** run.

- **Frozen wire:** clean. The tool call is HTTP JSON-RPC; no worker op is added.
- **Egress:** works by (b)'s permissiveness; needs no allowance.
- **What it actually requires to be SAFE:** the server-side auth seam DAT-007 item #1 — a net-new
  resolver that binds the presented **run-JWT** (`agentId/companyId/runId`) to the **live fence**
  (lease/attempt/generation) and denies a stale/replaced/wrong-tenant sandbox with the coarse
  non-disclosing shape the broker already uses. **This is DEFERRED and unbuilt**
  (`DAT-007-result.md` §2, §4). Mechanism A is therefore *not a self-contained option* — it is the
  transport half whose safety depends on item #1 landing.

### Mechanism B — an egress allowlist that admits the control plane and denies the rest

Populate a default-deny egress posture that allows only the `/mcp` host (the DAT-007 item #2 note:
"the control-plane `/mcp` host on the sandbox egress allowlist (ties DAT-005)").

- **As a control: OFF THE TABLE by the ratified DE-08 conclusion.** §2(b): all three provider
  network constructions are measured inert at the managed-shared tier; there is no working
  default-deny to build the allowlist on top of. An allowlist that cannot deny is not a control.
- **As a reachability enabler: unnecessary.** §2(b): the guest can already reach the broker without
  any allowance.
- **Verdict:** B neither bounds nor is needed; naming it as Unit C's mechanism would re-assert a
  control the founder already ruled unavailable. It is priced here only to reject it explicitly, so
  a future reader does not resurrect it.

### Mechanism C — the sandbox-side MCP shim (the literal CLI-008 Unit C scope)

Stage an `aoa` MCP config as a **third staged file** (reusing Unit B's staging channel exactly as the
prompt and instructions ride it), add `--mcp-config <staged path> --allowedTools mcp__aoa` to
`buildSandboxInvocation`'s emitted `args`, and deliver the **run-identity credential** (`AOA_API_KEY`
= the run-JWT) as a **second secret handle** (the first being CLI-007's provider key) via the
CLI-007 / `secret.proxy` (`capabilities.ts:56`) path into `ExecuteInput.env`.

- **Frozen wire:** clean — parallel to Unit D. The MCP flags are plain strings in `args`; the config
  JSON is a staged file; the non-secret `AOA_API_URL` bakes into the config `url`; only `AOA_API_KEY`
  needs the env/secret-handle channel. `git diff` of `packages/worker-protocol/src` stays empty, the
  same property Unit B and Unit D preserved.
- **Egress:** works by (b); needs no allowance.
- **DE-07 obligation.** The `AOA_API_KEY` handle is exactly a
  `Control plane <-> secret and MCP OAuth broker` crossing (DE-07,
  `distributed-execution-threat-controls.json`), whose `authorization` clause REQUIRES "handles are
  **lease- and fence-scoped**." On the distributed lane, fence-scoping the run-JWT **is** DAT-007
  item #1. So C's credential delivery is not merely paired with A's auth seam by convenience — DE-07
  makes the fence-scoping a *stated requirement* of shipping the handle at all.
- **Scope nuance (claude-first).** claude consumes `--mcp-config` natively. codex has **no**
  `--mcp-config` flag and discovers MCP from a `CODEX_HOME` config file, which CLI-002 flags as an
  open follow-up ("No `codex_local` sandbox-docker MCP staging — unwritable `CODEX_HOME`, MX3
  follow-up", `CLI-002-design.md` §5.3). Unit C's clean, provable scope is **claude first**; codex's
  in-VM MCP config staging is a distinct sub-unit.

**A and C are two halves of one mechanism, not rivals.** C is the sandbox-side plumbing (config +
credential + argv); A is the server-side auth seam (DAT-007 item #1) that makes the credential C
delivers safe to accept. B is a control the DE-08 ruling already removed. **The real question is not
"A or B or C" — it is "mount A's transport + C's plumbing, gated on item #1 — now, or after item #1."**

---

## 5. Recommendation

**Recommended: mechanism C's sandbox-side plumbing (the literal Unit C scope) reusing mechanism A's
already-built brokered HTTP transport, LANDED NOW but INERT-until-authorized — the `aoa` config,
the `AOA_API_KEY` handle and the `--mcp-config`/`--allowedTools` argv are emitted only when the
run's identity is fence-current, and fence-currency is DAT-007 item #1. Mechanism B is rejected as a
control.** Framed as the founder's choice; the reasoning:

- **Why not "block Unit C on DAT-007 entirely."** The plumbing (C) is frozen-wire-clean, reuses Unit
  B's staging and the existing brokered `aoa` config verbatim, and is independently testable
  (staged-file agreement, argv shape, `--strict-mcp-config`, claude-first). Holding it hostage to the
  auth-seam decision buys nothing and loses the ability to pin the shape before it is turned on —
  the exact ordering CLI-008 Unit A established for the verifier ("fix the judge first").
- **Why it MUST stay inert until item #1.** §2 is decisive: at the managed-shared tier there is **no
  network backstop** for a run credential inside the guest, and DE-07's `authorization` clause
  REQUIRES the handle to be lease- and fence-scoped. On the distributed lane that scoping is the
  net-new fence-bound run-JWT resolver DAT-007 item #1 — which the DAT-007 result explicitly flags
  as needing "a security-critical auth surface the design under-specified" and "a design decision."
  Turning `mcp__aoa__*` on for a distributed sandbox **before** the run-JWT is bound to a live fence
  means a stale (lease lost) or replaced (attempt superseded) sandbox can keep calling company-scoped
  tools until the JWT expires, with nothing at the network layer to stop it. The wrong-tenant case is
  already closed structurally (`agent.companyId===companyId` + RLS), but stale/replaced is exactly
  the currency gap item #1 exists to close.
- **Why B is rejected, recorded so it is not resurrected.** The DE-08 ruling measured provider egress
  denial inert on all three constructions and CONCEDED it at this tier. An egress allowlist as Unit
  C's reach-control would re-name a control the founder already ruled unavailable. Do not propose it
  again without a new run id and a positive control (the standing DE-08 instruction).

**★ The strongest argument against the recommendation.** *Landing a run-JWT-carrying secret handle
and the `--mcp-config` argv now — even flagged inert — puts the credential-delivery path one config
flip away from live, on a lane whose only safety gate (item #1) is unbuilt and under-specified.* If
the founder judges that too close to a live surface, the correct alternative is **fully block Unit C
until DAT-007 item #1 is designed and landed**, accepting that `E7-F003`'s tools row stays open and
`capabilityProven` stays structurally false in the interim. A run credential the network cannot fence
is only as safe as the server-side seam it is minted against, and that seam does not yet exist.

---

## 6. What this paper is not

It changes **no** finding status, **no** `deliveryStatus`, **no** clause text, **no** threat-model
entry, **no** gate-clause enrolment. It writes no production code. **Unit F stays frozen and this
does not touch it** — the return path / output capture (`CLI-008-unit-f-design.md`) is a separate,
unsized problem and nothing here depends on or moves it. This paper exists so the topology question
`E7-F003` leaves open — *how a distributed E2B coding agent reaches `mcp__aoa__*`, and what must be
true before its run credential reaches the broker* — can be ruled, with the transport treated as
already-built, the egress model treated as ruled (DE-08), and the auth seam (DAT-007 item #1) named
as the precondition it is.

---

## ▣ DECISION REQUEST — CLI-008 Unit C tool reachability — **AWAITING FOUNDER RULING**

Two questions; the second is the load-bearing one.

**Q1 — Transport/topology.** Confirm that a distributed (worker-lane) E2B coding agent reaches
`mcp__aoa__*` over the **existing brokered HTTP transport** (`buildMcpConfig`/`buildCodexAoaMcpSpec`
brokered `aoa` entry → `${AOA_API_URL}/companies/${cid}/mcp`, `Bearer ${AOA_API_KEY}`), carried into
`buildSandboxInvocation` as a staged config file + `--mcp-config`/`--allowedTools mcp__aoa` argv
(mechanism A transport + mechanism C plumbing), and **NOT** via a new frozen worker-protocol wire op
and **NOT** gated by a control-plane egress allowlist (mechanism B).

- ☐ **RECOMMENDED — A transport + C plumbing; B rejected.** No frozen change; egress needs no
  allowance; B is the control DE-08 already ruled unavailable.
- ☐ **Reject** — propose a different transport (would require re-opening the frozen 10-op wire and/or
  the DE-08 egress ruling; neither is recommended).

**Q2 — Sequencing / the safe-reach precondition.** Rule when Unit C's sandbox-side plumbing may land,
given DE-08 leaves no network backstop for the run credential and DE-07 requires the handle to be
lease- and fence-scoped.

- ☐ **RECOMMENDED — Land C now, INERT-until-authorized.** Emit the `aoa` config, the `AOA_API_KEY`
  second secret handle, and the MCP argv **only when the run's identity is fence-current**; make
  DAT-007 item #1 (the net-new fence-bound `runId → job → active-lease/fence` resolver) the gate that
  turns `mcp__aoa__*` on. claude-first; codex `CODEX_HOME` MCP staging is a distinct sub-unit (MX3).
  `E7-F003` tools row stays open and `capabilityProven` stays false until item #1 lands and the flag
  flips.
- ☐ **Fully block Unit C on DAT-007 item #1.** Do not land the credential-carrying plumbing at all
  until the fence-bound run-JWT resolver is designed and landed. Safer; leaves the tools row and the
  verifier's capability dimension untouched longer.
- ☐ **Turn it on without item #1.** *NOT recommended* — accepts a company-scoped tool surface reachable
  by a stale/replaced distributed sandbox for the run-JWT's lifetime, with no network backstop
  (contradicts DE-07 `authorization` and the DE-08 egress concession).

**★ Record with whichever is chosen, because a future reader will otherwise re-derive it:** the
transport already exists (`cli-mode.ts:339-343`, `buildCodexAoaMcpSpec` `:404-416`); the frozen wire
carries a tool call with **no** new op (`transport.ts:757-768`); the E2B egress model denies nothing
at the managed-shared tier (DE-08, RULED 2026-09-11) so the run credential cannot be fenced at the
network layer; and DAT-007 item #1 — the fence-bound run-JWT resolver — is the **only** thing that
scopes that credential to a live lease. Unit F is untouched.
