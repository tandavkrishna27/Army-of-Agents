# DAT-007 Result — Brokered internal tool surface over the worker path

**Status:** PARTIAL — the one in-scope, verifiable live-bug fix landed + green; the ticket's core remote-reach is **BLOCKED on out-of-worktree substrate + needs a design decision** (see §2). Surfaced honestly rather than fabricated. Integration Gate Owner's call on epic status.
**Epic:** `E5-workspaces-secrets`. **Design:** [`DAT-007-design.md`](DAT-007-design.md). **Source:** `program-design.md:666-670`.
**Process:** terrain-map Workflow (5 readers → synth) → committed design → implementer subagent (instructed to STOP-and-report rather than build wrong) → **orchestrator independent re-verification of every deferral claim against the actual code** → this doc. The implementer correctly identified that 3 of the design's 4 items were misdiagnosed/out-of-scope; the orchestrator confirmed each by reading the cited code.

---

## 1. What landed (the one real, in-scope fix)

**Item #3 — the `query_memory` #118/#119 memory-visibility bypass (live security bug), FIXED fail-first.**
`query_memory` (`memory-tools.ts`) fetched via `searchMultiPath`/`list` and trimmed results in-memory with `filterQueryResults` → `filterCommanderMemoryItems`, which **short-circuits on `isFounder(userRole)`** (`memory-policy.ts`). The crew broker sets `userRole:"founder"` (`broker-tool-context.ts:43` `CREW_SESSION_USER_ROLE`), so a crew agent over the broker saw **every approved company memory incl. others' private / invalidated / cross-department rows** — the exact #118/#119 violation DAT-007's acceptance forbids. `find_similar_memory`/`detect_conflicts`/the hnsw tool already gate via `actorForAgentRun` + `memoryAccessConditions`; `query_memory` was the one broker memory reader the U2a gate missed (opt-in-per-tool footgun).
**Fix:** for `actorType==="agent" && agentId`, derive `accessConditions = memoryAccessConditions(db, actorForAgentRun(...))` and thread it into BOTH fetch paths — authoritative **in-SQL** (orchestrator-verified the service applies it: `memory.ts:271` list, `:644`/`:916`/`:973` search). Board/Commander/founder-human callers get no `accessConditions` → byte-unchanged.
**Audit of every broker memory tool:** `query_memory` was the ONLY unguarded reader; the others already gate; working-context + `suggest_memory`/`update_memory` are writes/own-scope (no cross-actor read leak).
**Fail-first proven:** the 2 agent tests were RED with `actorForAgentRun`/`memoryAccessConditions` at 0 calls; GREEN after threading. The 3 board/no-agentId cases stay byte-unchanged.

---

## 2. What did NOT land, and why (design was over-scoped — every claim orchestrator-verified)

| Design item | Verdict | Evidence (orchestrator re-verified) |
|---|---|---|
| **#4 ask_human redirect** | **NOT A BUG on this transport — already correct.** No change. | `server.ts:723-726`: the broker `ask_human`/`ask_founder` "resolves through the internal registry … delegate to the same `askHumanForActiveRun` helper" → durable `work_questions`; `ask-human-tool.ts` already authorizes `aoa`+`org`. The `agent_runtime_decisions` mapping the design cited lives in `job-approval-bridge.ts` = **JOB-011**, a *separate frozen worker CONTROL-channel* parity/shadow bridge ("never a new engine", "byte-for-byte unchanged"; `job-source-governance-matrix.test.ts`, Decision #121). Redirecting it would break the frozen contract AND add a worker-control route (contra the no-new-wire-op constraint). The terrain map + design **conflated the MCP-broker tool transport with the JOB-011 control-channel**. Locked with a characterization test. |
| **#1 run-scoped fence-binding** | **NOT FEASIBLE as "reuse" — needs a NET-NEW resolver + a design decision.** Not built. | `resolveWorkerFenceContext` requires a `VerifiedWorkerOperation` (device proof: workerId/targetId/deviceThumbprint/proofId) + a presented `{leaseId,jobId,attempt,fenceToken}` tuple + org repos. The `/mcp` request carries **only the run-JWT** (`agentId/companyId/runId` — `agent-auth-jwt.ts`), no device proof, no fence tuple, no org id. So it is NOT directly reusable. A correct fence-binding is a **net-new `runId → job → active-lease/fence` resolver** (the run-JWT is the sole credential) — a security-critical auth surface the design under-specified. (Jobs do carry `runId` in `sourceIntent`, `job-leasing.ts:111`, so the link exists.) → **spawned design-decision task.** |
| **#2 remote reachability wiring** | **NOTHING TO WIRE in this worktree.** Not built. | The `brokered`/`apiBaseUrl` seam is already built (`cli-mode.ts` U2d emits the HTTP `aoa` entry with no `DATABASE_URL` when `brokered:true`). The missing piece is the **worker-dispatch call site** that sets `brokered:true` — it lives in the dormant E2B/worker-dispatch path that **does not exist in this worktree** (terrain map: "no call site sets it yet, S7/U4"), and it depends on #1's auth seam to be safe. |

**Net:** the brokered tool surface + run-JWT auth + #118/#119 gates + `ask_human`→`work_questions` all ALREADY EXIST (#320). DAT-007's genuinely-new work is (a) the memory-gate fix (landed) and (b) the **run-scoped fence-binding + worker-dispatch call site** — both blocked on the dormant distributed-execution substrate that is out of this worktree, and the fence-binding needs an architectural decision the design mis-scoped as "reuse".

---

## 3. Gate table (the landed fix — all GREEN)

| Gate | Result |
|------|--------|
| `tsc -p server` / `-p packages/db` | clean (0 non-`plugin-sdk` errors; the ~65 pre-existing plugin-sdk errors are unchanged) |
| `memory-tools-agent-rbac.unit` + `commander-memory-tools` + `broker-ask-human-work-question` | 26 pass (incl. the fail-first agent-gate cases) |
| `broker-stdio-parity` (self-hosted byte-identical) + `broker-tool-context.unit` + `tool-registry` + `heartbeat-mcp` + `memory-write-tools` + allowlist/tenant-scope | 99 pass |
| in-SQL application of `accessConditions` (orchestrator-verified) | `memory.ts:271/644/916/973` push into WHERE |
| `check:frozen-worker-protocol-v1` / `check-distributed-execution-foundation` / boundary checks | OK / PASS / PASS (zero worker-protocol edits) |
| Linux-only (Issue #114) | `broker-internal-registry.integration` + `memory-tools-agent-rbac.integration` skip on Windows; the row-level gate assertion runs on Linux CI |

---

## 4. Residual / follow-ups

- **Run-scoped fence-binding resolver (item #1) — spawned design-decision task.** Needs: a net-new `runId → job → active-lease/fence` resolver keyed on the run-JWT (no device proof), the coarse non-disclosing denial for stale/replaced/wrong-tenant, and a decision on whether the MCP seam adopts it or a distinct auth path. Blocks the safe remote-worker tool reach.
- **Worker-dispatch call site (item #2)** — set `brokered:true` + a worker-reachable `apiBaseUrl` when the E2B/worker-dispatch path lands; depends on #1.
- These are the same class of inert-until-wired seams as DAT-005/006 (the live distributed-execution channel), but DAT-007's remote-reach cannot be *exercised* until that substrate exists — so unlike DAT-001–006 (each fully realizable + CI-green in this worktree), DAT-007's core is genuinely deferred.

---

## 5. Doc drift to surface (not self-fixed)

`epics/README.md` says E5 = DAT-001–006; `program-design.md` defines DAT-001–007. Given DAT-007's core is blocked on out-of-worktree substrate, the Integration Gate Owner should decide whether E5 is "complete" (DAT-001–006 + the DAT-007 memory fix) or DAT-007 stays open pending the distributed-execution substrate.
