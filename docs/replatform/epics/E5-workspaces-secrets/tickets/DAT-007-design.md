# DAT-007 Design — Brokered internal tool surface over the worker path

**Epic:** `E5-workspaces-secrets`. **Source:** `program-design.md:666-670`. **Depends on:** DAT-004, JOB-002 (landed).
**Status:** DESIGN. Terrain-mapped (5 readers → synthesizer, `wf_690098cf-b06`); the load-bearing transport + memory-bypass + frozen-wire-op claims orchestrator-re-verified against `C:/e3`.

---

## 1. Outcome + the one framing truth

**The brokered internal tool surface ALREADY EXISTS and works** (#320): `brokerRegistry` (`server/src/mcp/broker-registry.ts:33` → `createToolRegistry()`) dispatched over **HTTP JSON-RPC** at `POST /companies/:cid/mcp` (`server/src/mcp/server.ts:674` `tools/call`), authenticated by the run-JWT (`verifyLocalAgentJwt`), executed by the **sole control-plane executor** (`tool-registry.ts:298-349`; the sandbox holds no DB handle). DAT-007 **relocates its reach** to a remote-worker sandbox and **hardens three things** — it does NOT rebuild the registry, store, or dispatch.

**Non-goals:** no second tool registry / memory store / task store; no new worker-protocol wire op (the frozen `WORKER_PROTOCOL_OPERATIONS` list = 10 ops, **no tool op** — re-verified `transport.ts:757-768`); no DB/memory-table access to the sandbox. Self-hosted stays byte-identical (org-RLS backstop inert behind default-off `AOA_DISTRIBUTED_EXECUTION_ENABLED`).

**★ TRANSPORT DECISION (re-verified):** the spec says "tenant-scoped control-plane API authenticated by the **run-JWT**" + "the **run-JWT audience** binds the sandbox to its job/attempt/lease/fence" (`program-design.md:669-670`). That is the **MCP JSON-RPC / run-JWT** vehicle, and the frozen-package constraint independently forbids a new `worker_run` tool wire-op. **DAT-007 rides the existing MCP transport; the fence-binding is a net-new SERVER-SIDE cross-check (reusing `resolveWorkerFenceContext`), never a new worker op.**

---

## 2. REUSE (consume unchanged) — the single most important fact

| Component | file:line | Role |
|---|---|---|
| `brokerRegistry` (the ONE registry) | `broker-registry.ts:33` / `tool-registry.ts:101-197` | memory/tasks/goals/artifacts/use_skill/ask_human; guarded by `broker-stdio-parity.test.ts` |
| Dispatch endpoint | `mcp/server.ts:674-818` (broker branch :745-768) | JSON-RPC 2.0; `(agent&&runId)||commander` + name-in-registry → broker |
| Actor→context resolver | `broker-tool-context.ts:171-245` (crew/org), :269-299 (Commander) | asserts `agent.companyId===companyId` (cross-tenant ≡ missing), branches `kind` aoa/org, else fail-closed |
| Dispatch + RBAC gate | `mcp-bridge.ts:143-250`, `tool-registry.ts:298-349`, `authorize-tool.ts` | role+capability+allowlist; Commander runtime-approval only for `actorType==="commander"` |
| Memory #118/#119 SQL gate | `memory-access-sql.ts:100-183` (`memoryAccessConditions`), `:26-37` (`actorForAgentRun`) | row-level gate keyed on `(actorType, agentId, companyId)` |
| `runInTenant` / RLS | `db/tenant-context.ts:46-60` | non-owner `aoa_app` + FORCE-RLS + tx-local org GUC (dormant behind the flag) |
| Fence resolver (the binder) | `worker-fence-context.ts:54` (`resolveWorkerFenceContext`) | re-proves org/company/job/attempt/lease/fence vs DB in-tenant |
| Run-JWT mint/verify | `agent-auth-jwt.ts:68-95` | claims `sub`=agentId, `company_id`, `run_id`, `aud` |
| Brokered transport config (no DB) | `cli-mode.ts:329-344` / :200-205 | HTTP `aoa` MCP entry, `Bearer AOA_API_KEY`, **no `DATABASE_URL`** |
| ask_human durable path | `ask-human-tool.ts:32-58`, `work-questions.ts:456-548` | Decision #109 `work_questions` + hub mirror + continuation |

---

## 3. NET-NEW — what DAT-007 builds (4 items, 2 are live-bug fixes)

**KEY DECISION #1 — no run-JWT binds job/attempt/lease/fence today → net-new binding, reused resolver.** The run-JWT (`agent-auth-jwt.ts`) binds company/agent/run only; the worker `device_session` JWT binds device/target/generation only (job/attempt/lease/fence is presented in the request body + re-proven via `resolveWorkerFenceContext`). **Implementer re-verify claim #7:** confirm JOB-002 did NOT already mint a fence-bound run-JWT (if it did, this flips to reuse).

1. **Run-scoped MCP auth seam** — for a remote-worker caller, the `/companies/:cid/mcp` auth path cross-checks the run-JWT identity against the live fence context (reuse `resolveWorkerFenceContext`, whose tuple shape = `controlDeliveryIdentityShape` `transport.ts:167-176`). A stale/replaced/wrong-tenant sandbox is denied with the SAME coarse shape the endpoint already uses (`forbidden`, cross-tenant≡missing; never a "no such job/lease" oracle). Inert self-hosted.
2. **Remote reachability wiring** — set `brokered:true` + a worker-reachable `apiBaseUrl` on `McpConfigParams` for worker-dispatched runs (`cli-mode.ts:206-213` explicitly notes "no call site sets it yet (S7/U4)" = THIS seam) + the control-plane `/mcp` host on the sandbox egress allowlist (ties DAT-005).
3. **★ Memory-gate fix (live bug — claim #3 CONFIRMED by orchestrator).** `query_memory` (`internal-agent/tools/memory-tools.ts:80-175`) trims results in-memory via `filterQueryResults({ userRole: ctx.userRole, … })`, and the crew broker sets `userRole:"founder"` (`broker-tool-context.ts:43,234` `CREW_SESSION_USER_ROLE`), so a crew agent over the broker **sees every approved company memory incl. private/invalidated/cross-dept** — violating the #118/#119 acceptance. `find_similar_memory` (:351) + `detect_conflicts` (:400) already gate correctly via `actorForAgentRun` + `memoryAccessConditions`. **FIX:** for agent actors (`actorType==="agent"` + `agentId`), route `query_memory`'s search/list through the SQL enterprise gate (`memoryAccessConditions`), not the founder-role in-memory filter — matching the proven pattern. The gate is opt-in per tool (fail-open on any tool that forgets it) — audit every broker memory tool.
4. **★ ask_human redirect (live gap — claim #4).** PRT-007's worker→host path (`job-approval-bridge.ts:151-172`) targets the WRONG aggregate: `task_run → agent_runtime_decisions` (the W5a runtime-permission table), NOT the durable `work_questions` table — so no Commander/Inbox/Task/Workspace mirror, no continuation re-wake, and `crew_run` gets `runtimeDecisionAuthority:"none"` (crew has NO ask_human authority over the worker path). No route consumes the inbound `runtime_decision_requested` event yet. **FIX:** (a) add the inbound handler; (b) redirect the binding to `askHumanForActiveRun`/`workQuestionService.create`; (c) grant `crew_run` work_question authority; (d) reconcile worker `park_run` (cancel-attempt, no retry) with durable continuation re-wake. **Implementer re-verify the exact lines.**

---

## 4. The auth + RBAC chain a tool call MUST pass

```
run-JWT (verifyLocalAgentJwt: sub=agentId, company_id, run_id)             [agent-auth-jwt.ts:95]
 → ensureProtocolAccess asserts JWT.company_id === :companyId              [server.ts:261-263]
 → [NET-NEW] fence identity: resolveWorkerFenceContext binds org/company/
     job/attempt/lease/fence, re-proven vs DB in-tenant                    [worker-fence-context.ts:54]
 → resolveBrokerToolContext asserts agent.companyId===companyId, kind aoa/org else forbidden [broker-tool-context.ts:171-188]
 → actor kind aoa|org → MemoryActor kind:"agent" (NOT userRole)            [memory-access-sql.ts:26-37]
 → RBAC authorizeToolInvocation(role, capabilities, {agentKind, allowlist}) [mcp-bridge.ts:157-204]
 → #118/#119 gate memoryAccessConditions + filterMemoryForActor            [memory-access-sql.ts:100-183]
 → effect via SOLE executor tool.execute() on the control plane            [tool-registry.ts:298-349]
```
The sandbox receives JSON tool results only; `execute` runs on the control plane with a server-built db/services container. **The sandbox never holds a DB handle** (claim #6 — `cli-mode.ts:200-205,330-337` no `DATABASE_URL`).

---

## 5. Denial without existence disclosure (coarse codes)

Tenant isolation is **structural** (`runInTenant` + FORCE-RLS) → a wrong-tenant leaseId yields the same denial as a stale one, no cross-tenant branch = no oracle. `ackAuthorityCurrent` collapses ~15 conjuncts to one boolean → `target_revoked`/`unauthorized`; lease/fence mismatch → blanket `stale_fence` (`worker-fence-context.ts:105,117`). On the MCP vehicle: cross-company → uniform `forbidden` (`broker-tool-context.ts:176-179`); unknown tool → `-32601`; registered-but-denied → in-band `isError:true`. **DAT-007's net-new fence-denial reuses this coarse shape.**

---

## 6. INERT-until-wired seams

- `cli-mode.ts:206-213` `brokered`/`apiBaseUrl` — "no call site sets it yet (S7/U4)" = the DAT-007 wiring seam.
- `runInTenant` org-GUC RLS dormant behind `AOA_DISTRIBUTED_EXECUTION_ENABLED` — the MCP broker path is company-scoped today (app-level `agent.companyId===companyId`), NOT org-RLS. DAT-007 adds the org-tenant backstop; stays inert self-hosted → byte-identical.
- `job-approval-bridge.ts` `openGovernedDecision`/`resolveGovernedDecision` — built, test-only; no route consumes the inbound event yet.

---

## 7. Fail-first TEST LIST (mirrors acceptance)

1. **Visibility per actor kind** — crew `query_memory` over broker must NOT see others' private/invalidated/cross-dept (regression for the §3.3 bypass); org actor scope-matched; external-key path stays unreachable over broker.
2. **Audience binding** — a run-JWT/fence for job A denied when presented for job B's lease/attempt; correct fence → allowed.
3. **Stale denial** — replaced generation / expired lease / superseded fence → coarse `stale_fence`/`forbidden`, no field disclosure.
4. **Replaced caller** — replayed proof/JWT → `unauthorized`, no lease-lookup leak.
5. **Wrong-tenant** — foreign-org leaseId/companyId → identical coarse denial as stale; assert `detail:{}`.
6. **No DB access** — brokered sandbox config carries no `DATABASE_URL`; result is bounded JSON.
7. **ask_human path** — remote crew/org ask_human creates a `work_questions` row (NOT `agent_runtime_decisions`) + hub mirror + continuation; crew_run authority present.
8. **Unknown-tool fail-closed** — neither registry → `-32601`; registered-but-denied → in-band `isError:true`; non-aoa/org kind → forbidden.
9. **Self-hosted byte-identical** — flag off + non-brokered config → local crew/org stdio path unchanged (broker-stdio-parity green).

---

## 8. LOAD-BEARING CLAIMS — status

1. **Transport vehicle = MCP JSON-RPC + run-JWT (no new worker wire op).** ✓ re-verified: `WORKER_PROTOCOL_OPERATIONS` = 10 ops, no tool op (`transport.ts:757-768`); spec language matches.
2. **No run-JWT binds job/attempt/lease/fence today → net-new binding, reused resolver.** ✓ (run-JWT = company/agent/run; device JWT = device/target/generation). **Implementer re-confirm claim #7 (JOB-002).**
3. **Memory bypass: `query_memory` over broker uses founder-role in-memory filter, not the enterprise gate.** ✓ re-verified (`memory-tools.ts:95-113` `filterQueryResults` userRole; crew `userRole:"founder"` `broker-tool-context.ts:43,234`; `find_similar_memory`/`detect_conflicts` :351/:400 use the SQL gate). **Live fix in scope.**
4. **ask_human wrong table:** `job-approval-bridge.ts:151-172` → `agent_runtime_decisions` not `work_questions`; `crew_run` = `none`. **Implementer re-verify the exact lines before redirecting.**
5. Cross-tenant≡missing + structural RLS = the no-disclosure backbone. ✓
6. Brokered config carries no `DATABASE_URL`. ✓ (`cli-mode.ts:200-205,330-337`).
7. Deps DAT-004 (secret mutators in `EXPECTED_GUARDED`) + JOB-002 substrate present.

**Doc drift (NOT self-fixed):** `epics/README.md` says E5=DAT-001–006; `program-design.md` defines DAT-001–007. This is the LAST E5 ticket → E5 complete on land.
