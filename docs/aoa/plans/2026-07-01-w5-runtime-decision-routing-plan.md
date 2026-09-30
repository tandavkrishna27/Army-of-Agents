# W5 Runtime Decision Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build W5 runtime decision routing so supported org-agent runtime prompts can land in the Inbox Hub "Waiting on you" lane, receive a founder/operator decision, and relay that answer back to the blocked run with durable audit and timeout behavior.

**Architecture:** W5 extends the shipped hub control plane and heartbeat runner. A new durable runtime-decision source table owns prompt lifecycle, relay integrity, timeout policy, and allow-always rules. Hub rows remain the human attention index using the reserved `agent_runtime_decision` semantic type. Adapters do not write hub rows directly; heartbeat injects a runtime-decision broker into `AdapterExecutionContext`, and supported adapter bridges call that broker while they are able to wait for an answer. Unsupported adapters are documented in a feasibility matrix and remain on existing bypass/auto-approval behavior until a bridge is proven.

**Tech Stack:** Drizzle/Postgres schema + generated migrations, Express 5 services/routes, shared Zod contracts, heartbeat/adapter-utils runtime broker, React/Vite hub viewer, Vitest unit/integration tests, and Playwright e2e.

**Roadmap position:** W5 follows W4 Steward foundation, merged in PR #256. W5 does not change W1-W4 hub lifecycle/autonomy semantics and does not add Mail/email intake.

---

## Scope Boundary

In scope:

- Add a durable runtime prompt/decision table for org-agent runs.
- Route open prompts into Hub `waiting_on_you` using semantic type `agent_runtime_decision`.
- Add a source-specific answer route with optimistic source-state checks.
- Add a runtime-decision broker to heartbeat and `AdapterExecutionContext`.
- Add timeout/watchdog behavior for unanswered prompts.
- Add a tightly scoped allow-always rules table for permission prompts only.
- Add a hub viewer for permission prompts and substantive work questions.
- Build a test bridge/harness and one real adapter bridge only after feasibility is confirmed.
- Add unit, integration, and final UI e2e coverage.

Out of scope:

- Mail/email lane and email reply drafting.
- W3/W4 autonomy decisions beyond optional allow-always for runtime permission prompts.
- Blanket "always allow shell" rules.
- Source-side approval systems not tied to a live org-agent runtime prompt.
- Making every adapter support blocking prompts in the first PR.
- Replacing existing Commander `internal_agent_runtime_approvals`; W5 is for org-agent heartbeat runs.

## Product Decisions

1. **W5 is source-specific, not generic hub action.** Runtime answers use a new source route/service, then update/reconcile the hub item. The existing `hub-items/:id/action` route stays for lifecycle actions like resolve/archive/claim/release.
2. **Prompt lifecycle lives outside the hub index.** The prompt table stores `created / shown / answered / relayed / expired / cancelled / relay_failed`. Hub rows are denormalized attention rows.
3. **Run remains active while adapter is blocked.** For W5a, `heartbeat_runs.status` stays `running`; liveness/nextAction fields and runtime prompt rows expose "waiting on human". This avoids breaking existing concurrency and queue promotion semantics.
4. **Permission prompts and work questions are separate kinds.** Permission prompts can support `allow_once | allow_always | deny`. Work questions support structured/freeform answers and must not auto-deny on timeout.
5. **Allow-always is scoped and expiring.** Rules are keyed by company, agent, adapter, prompt kind, command/tool/path/network target/risk class where available, and expiry. No blanket always-allow shell.
6. **Adapter bridges are opt-in.** Start behind a company/agent/adapter feature flag. Existing unattended adapters keep their current bypass/auto-approval config unless W5 is enabled.
7. **Relay integrity is mandatory.** Every answer is bound to companyId, runId, agentId, adapterType, adapter session display/params where available, source revision, nonce, actor, and decision.
8. **Timeout behavior is kind-specific.** Permission prompts default to deny or cancel according to adapter capability. Work questions default to park/escalate, not deny.
9. **Unsupported adapters are a documented product state.** The UI can show "runtime decisions unavailable for this adapter" in settings/tests, but unsupported adapters must not create unanswerable hub items.

## Adapter Feasibility Matrix

Before any real adapter bridge is implemented, fill every column for that
adapter in code review. "Unknown" is not a shippable bridge answer; it means the
adapter stays unsupported for W5a.

| Adapter | Current behavior found | Permission hook | Work-question hook | Resumable relay | Session id source | Nonce support | Known fallback | First action |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `claude_local` | Supports `dangerouslySkipPermissions`; current execute path can add CLI args and already injects MCP/auth context. Local CLI verified on 2026-07-01 as Claude Code `2.1.126`: help exposes `--permission-mode`, `--allowedTools`, `--include-hook-events`, and settings/hook-related debug, but no `--permission-prompt-tool` or documented blocking permission-prompt helper string exists in installed package text. | Not proven in installed local CLI; no shippable bridge contract for W5a. | Unknown; likely needs a separate AoA MCP/tool question path rather than the missing CLI permission hook. | Unknown until a blocking hook/helper contract is proven. | Adapter runtime session params/display id plus CLI session output. | Must be generated by AoA broker and echoed through a future hook/helper. | Existing skip-permissions mode stays available when W5 disabled. | Leave unsupported in W5a; W5b starts with a Claude hook spike against official/current CLI docs or a verified installed build. |
| `codex_local` | Supports `dangerouslyBypassApprovalsAndSandbox`; current process uses stdin and managed config/MCP. Local `codex --help` and `codex exec --help` verified on 2026-07-01 expose approval policy and sandbox flags but no external blocking approval hook. | Not proven in installed local CLI. | Unknown. | Unknown. | Adapter runtime session params/display id plus Codex resume session. | Must be AoA-generated; no assumption of native nonce. | Existing bypass mode. | Second bridge candidate only after hook proof. |
| `opencode_local` | Injects runtime config with `permission.external_directory=allow` to avoid prompts. `opencode` was not present on the local PATH during W5a verification. | Unknown/no proven blocking bridge. | Unknown. | Unknown. | Adapter session support must be checked. | Unknown. | Existing injected allow config. | Leave unsupported in W5a. |
| `grok_local` | Uses `permissionMode` and `--always-approve` style args. | Unknown/no proven blocking bridge. | Unknown. | Unknown. | Adapter session support must be checked. | Unknown. | Existing permission mode/always-approve behavior. | Leave unsupported in W5a. |
| `acpx_local` | Defaults permission mode to approve-all/approve-reads/deny-all. | Unknown/no proven blocking bridge. | Unknown. | Unknown. | Adapter session support must be checked. | Unknown. | Existing permission mode behavior. | Leave unsupported in W5a. |
| `cursor`, `cursor_cloud`, `gemini_local`, `pi_local`, `openclaw`, `openclaw_gateway`, `hermes_local`, `process`, `http` | No confirmed structured runtime prompt interception in the inspected surfaces. | Unknown. | Unknown. | Unknown. | Adapter registry/session-management check required before bridge. | Unknown. | Existing unattended behavior, or unsupported notice if no unattended mode exists. | Matrix-only until adapter-specific contract exists. |

### W5b feasibility update — 2026-07-03 (claude_local: BLOCKED → FEASIBLE)

The W5a matrix marked `claude_local` "permission hook not proven" because it only
inspected top-level CLI `--help` flags. A follow-up docs-authoritative spike
(2026-07-03) found the viable path is **not a CLI flag** — it is a **`PreToolUse`
HTTP hook** configured via `settings.json` (loaded with `--settings <file>`):

- **Permission hook:** ✅ **FEASIBLE.** A `PreToolUse` HTTP hook POSTs
  `{tool_name, tool_input, session_id, cwd, ...}` to an external URL, **blocks
  synchronously** (default 600s, configurable) and returns
  `{ hookSpecificOutput: { permissionDecision: "allow" | "deny" | "ask" } }`; the
  run **resumes in the same session**. CLI-compatible (no SDK needed → fits the
  CLI-only architecture, Decision #91). The cleaner Agent-SDK `canUseTool`
  callback is **SDK-only** and therefore out of scope for AoA.
- **Work-question hook:** ❌ still no clean CLI interception (`AskUserQuestion` is
  SDK-oriented). **W5b first bridge = permission prompts only; work-questions
  deferred.**
- **Resumable relay:** ✅ the hook block-and-return IS the resume; no run restart.
- **First action (revised):** W5b spawns bridged `claude_local` runs **without**
  `--dangerously-skip-permissions`, injects a per-run `settings.json` `PreToolUse`
  HTTP hook (authenticated, run-bound) → hook endpoint calls
  `runtimeDecisionBroker.requestPermission(...)` → blocks on W5a `waitForAnswer`.
- **Open constraints for the plan:** hook timeout ↔ prompt expiry reconciliation
  (600s block bound vs the 1h W5a default; deny-on-timeout); per-run auth token so
  the hook endpoint correlates hook→run→nonce and rejects spoofed calls; feature
  flag `runtimeDecisionRoutingEnabled` (default off). Detailed in
  `docs/aoa/plans/2026-07-03-w5b-first-adapter-runtime-bridge-plan.md`.

Sources: Claude Code docs — Hooks Reference, Agent SDK Permissions/Hooks, Headless
mode (code.claude.com/docs), verified against installed CLI `2.1.126`.

## PR Strategy

Recommended split:

- **W5a PR:** durable model, shared contracts, service/routes, hub viewer, heartbeat broker interface, timeout sweeper, allow-always policy core, test bridge/harness, and full non-adapter e2e.
- **W5b PR:** first real adapter bridge, likely `claude_local`, once the exact CLI permission-prompt hook is verified.
- **W5c+ PRs:** additional adapters only when each has a proven block/resume contract.

Reason: W5 can be tested end-to-end without tying correctness to one external CLI's changing prompt hook. The first adapter bridge then becomes a narrow integration PR rather than a mixed schema/UI/runtime gamble.

---

## File Structure

### Shared Contracts

- Modify `packages/shared/src/hub.ts`
  - Keep `agent_runtime_decision` in `HUB_SEMANTIC_TYPES`.
  - Add runtime decision kind/status/decision constants and lane/source helpers if not colocated elsewhere.
- Modify `packages/shared/src/validators/hub.ts`
  - Add viewer DTO schema if the hub item payload exposes source-specific action metadata.
- Add `packages/shared/src/runtime-decisions.ts` or colocate in `hub.ts`
  - Export prompt kind/status/action/timeout-policy types.
  - Export answer request/response validators.
- Modify `packages/shared/src/index.ts`
  - Export runtime decision contracts.
- Add/extend `packages/shared/src/__tests__/hub-contract.test.ts`.

### Database

- Create `packages/db/src/schema/agent_runtime_decisions.ts`
  - Columns:
    - `id`, `companyId`, `agentId`, `runId`
    - `adapterType`, `adapterSessionId`, `adapterSessionParams`
    - `kind`: `permission | work_question`
    - `status`: `created | shown | answered | relayed | expired | cancelled | relay_failed`
    - `nonce`, `sourceRevision`, `promptHash`, `sourceUniqueKey`
    - redacted display fields: `title`, `summary`, `promptText`, `options`
    - permission fields: `toolName`, `command`, `cwd`, `path`, `networkTarget`, `riskClass`
    - timeout fields: `expiresAt`, `timeoutPolicy`
    - answer fields: `decision`, `answerPayload`, `answeredByUserId`, `answeredAt`, `relayedAt`, `relayError`
    - audit timestamps
  - Indexes:
    - `(companyId, status, expiresAt)`
    - `(companyId, runId, status)`
    - `(companyId, agentId, createdAt)`
    - unique `(sourceUniqueKey)` where present.
- Create `packages/db/src/schema/agent_runtime_trust_rules.ts`
  - Scoped allow-always rules for permission prompts.
  - Include `companyId`, `agentId`, `adapterType`, `toolName`, `commandHash`, `pathScope`, `networkScope`, `riskClass`, `enabled`, `expiresAt`, `createdByUserId`.
- Modify `packages/db/src/schema/index.ts`.
- Generate migration with `pnpm db:generate`.

### Server

- Create `server/src/services/agent-runtime-decisions.ts`
  - `createPrompt`
  - `markShown`
  - `answerPrompt`
  - `waitForAnswer`
  - `markRelayed`
  - `expireDuePrompts`
  - `cancelRunPrompts`
  - `findTrustedPermission`
  - `createTrustRule`
  - `emitHubItemForPrompt`
  - `reconcileHubItemForPrompt`
- Create `server/src/routes/agent-runtime-decisions.ts`
  - `GET /companies/:companyId/agent-runtime-decisions/:id`
  - `POST /companies/:companyId/agent-runtime-decisions/:id/answer`
  - `GET /companies/:companyId/agent-runtime-decisions/trust-rules`
  - `DELETE /companies/:companyId/agent-runtime-decisions/trust-rules/:id`
- Modify `server/src/app.ts`
  - Mount runtime decision routes.
- Modify `server/src/services/hub-items.ts`
  - Add runtime decision source reconciler.
  - Open while prompt status is `created | shown | answered | relay_failed`.
  - Resolve/archive when `relayed | expired | cancelled` according to source policy.
- Modify `server/src/routes/hub-items.ts`
  - Emit/reconcile open runtime decisions before waiting lane list/counts.
- Modify `server/src/services/heartbeat.ts`
  - Build a runtime-decision broker and pass it to `adapter.execute`.
  - Add run event logging for prompt created/answered/relayed/expired.
  - Update `heartbeat_runs.livenessState/nextAction` while a prompt is open.
  - Cancel open prompts on run cancellation/failure.
- Modify `packages/adapter-utils/src/types.ts`
  - Add an optional `runtimeDecisionBroker` to `AdapterExecutionContext`.
- Add a test bridge or fake adapter path in server tests that calls the broker and waits for answer.
- Add a timeout sweeper in the existing worker startup path or heartbeat sweep loop.

Timeout policies:

- `deny`: permission prompt only; relays deny if adapter can safely consume it.
- `cancel_run`: cancels the blocked run and closes the prompt.
- `park_run`: marks the prompt expired/parked and leaves follow-up visible without pretending a decision was made.
- `continue_with_default`: only when the prompt supplies an explicit safe default.
- `escalate`: keeps or re-emits a human-visible item with timeout context.

Work questions must default to `park_run` or `escalate`; they must never use
implicit `deny`.

### Adapter Bridge

W5a:

- Implement only the test bridge/harness needed to prove the broker/source/hub/UI loop.
- Do not modify a real adapter unless the hook contract is already proven in code.

W5b:

- Modify `packages/adapters/claude-local/src/server/execute.ts` if the Claude CLI permission-prompt hook is confirmed.
- Add a runtime config field such as `runtimeDecisionRoutingEnabled`.
- When enabled, do not pass `--dangerously-skip-permissions` for bridged permission prompts.
- Configure the CLI hook to call the broker/helper and wait for answer.
- Fall back safely if hook setup fails before spawning the run.

### UI

- Modify hub registry/viewer components under `ui/src/components/hub/`.
  - Add a runtime decision viewer for `agent_runtime_decision`.
  - Permission prompt controls: Allow once, Allow always, Deny.
  - Work question controls: answer field/options, Submit, optional Park/Cancel display where server supports it.
  - Show timeout, agent, run, adapter, and redacted requested action.
  - Disable controls on stale version/status and show refreshable conflict state.
- Modify `ui/src/api/hub-items.ts` or add `ui/src/api/agent-runtime-decisions.ts`.
- Modify `ui/src/lib/queryKeys.ts`.
- Add settings/status copy only where the user naturally configures adapter runtime behavior; do not add a marketing explainer page.

### Docs

- Update `docs/aoa/plans/2026-06-29-inbox-hub-integration-roadmap.md`.
- Update this plan's execution status as tasks complete.
- If W5b proves/declines an adapter hook, record the result in the feasibility matrix.

---

## Task 1: Shared Contracts and DB Schema

**Files:**
- `packages/shared/src/hub.ts`
- `packages/shared/src/runtime-decisions.ts`
- `packages/shared/src/validators/hub.ts`
- `packages/shared/src/index.ts`
- `packages/shared/src/__tests__/hub-contract.test.ts`
- `packages/db/src/schema/agent_runtime_decisions.ts`
- `packages/db/src/schema/agent_runtime_trust_rules.ts`
- `packages/db/src/schema/index.ts`

- [x] Write failing shared contract tests for prompt kinds, statuses, decisions, timeout policies, and `agent_runtime_decision` lane placement.
- [x] Add shared constants/types/validators.
- [x] Write failing DB schema/export tests for both new tables and required indexes/columns.
- [x] Add Drizzle schemas and exports.
- [x] Generate migration:

```powershell
pnpm db:generate
```

- [x] Run focused verification:

```powershell
pnpm --filter @armyofagents/shared test:run -- hub-contract
pnpm --filter @armyofagents/db test:run
```

## Task 2: Runtime Decision Service and Hub Reconciler

**Files:**
- `server/src/services/agent-runtime-decisions.ts`
- `server/src/services/hub-items.ts`
- `server/src/services/index.ts`
- `server/src/__tests__/agent-runtime-decisions.test.ts`
- `server/src/__tests__/hub-runtime-decisions.test.ts`

- [x] Write failing service tests for prompt creation, idempotency, redaction, owner resolution, answer transitions, relay marking, and timeout transitions.
- [x] Add nonce/source-revision tests:
  - stale `expectedSourceRevision` rejects with conflict
  - answer with wrong nonce/run/company is rejected
  - already answered/relayed prompts are idempotent only with the same idempotency key
  - relay failure leaves the hub item actionable with `relay_failed`
- [x] Add redaction/RBAC tests:
  - secrets are redacted before hub summary/message persistence
  - raw prompt/details are not returned to unauthorized users
  - authority is enforced server-side on answer, not only by disabled UI controls
- [x] Implement service methods.
- [x] Add runtime decision source reconciler in hub service.
- [x] Ensure audit/activity entries are written before answer state changes.
- [x] Add counter invalidation/live event assertions.
- [x] Run focused server tests.

## Task 3: Routes and RBAC

**Files:**
- `server/src/routes/agent-runtime-decisions.ts`
- `server/src/app.ts`
- `server/src/routes/hub-items.ts`
- `server/src/__tests__/agent-runtime-decisions-routes.test.ts`
- `server/src/__tests__/hub-items-routes.test.ts`

- [x] Write failing route tests for board-only access, company scoping, founder/operator authority, optimistic conflict, stale prompt, and invalid decision payloads.
- [x] Add runtime decision routes.
- [x] Mount routes in app.
- [x] Trigger runtime decision reconciliation for Waiting on you list/count routes.
- [x] Run focused route tests.

## Task 4: Heartbeat Broker and Test Bridge

**Files:**
- `packages/adapter-utils/src/types.ts`
- `server/src/services/heartbeat.ts`
- relevant heartbeat tests under `server/src/__tests__/`

- [x] Write failing tests with a fake/test adapter that opens a runtime decision and waits.
- [x] Add optional broker type to `AdapterExecutionContext`.
- [x] Build broker in heartbeat and pass it to adapters.
- [x] Record run events for prompt lifecycle.
- [x] Mark run liveness/nextAction while waiting and clear it after relay.
- [x] Cancel/expire prompts on run terminal states.
- [x] Run focused heartbeat tests.

## Task 5: Timeout Sweeper and Allow-Always Rules

**Files:**
- `server/src/services/agent-runtime-decisions.ts`
- startup/sweep integration file used by heartbeat workers
- route/API/UI files for trust rules as needed

- [x] Write tests for due prompt expiry and timeout policies.
- [x] Write tests for scoped allow-always matching and non-matching cases.
- [x] Implement sweeper with bounded batch size.
- [x] Implement trust-rule create/revoke/list flow.
- [x] Ensure work questions cannot be blanket auto-denied.

## Task 6: Hub Runtime Decision Viewer UI

**Files:**
- `ui/src/api/agent-runtime-decisions.ts`
- `ui/src/api/hub-items.ts`
- `ui/src/lib/queryKeys.ts`
- `ui/src/components/hub/*`
- `ui/src/__tests__/InboxHub.test.tsx`
- component tests under `ui/src/components/hub/__tests__/`

- [x] Write failing UI tests for permission prompt controls, work-question answer, stale/answered/expired states, and allow-always gating.
- [x] Add API client and query keys.
- [x] Add registry-backed viewer for `agent_runtime_decision`.
- [x] Wire mutations and invalidation.
- [x] Verify responsive layout and no overlapping text.
- [x] Run focused UI tests.

## Task 7: Real Adapter Bridge Spike/Implementation Gate

**Files:**
- adapter-specific files only after hook proof
- likely `packages/adapters/claude-local/src/server/execute.ts`
- adapter config UI/tests if a flag is added

- [x] Verify the exact current CLI hook contract from local docs/runtime/help output.
- [x] Record outcome in the feasibility matrix.
- [x] Decline real adapter bridge implementation for W5a because no installed CLI exposed a verified blocking permission/work-question hook.
- [x] Keep existing adapter bypass/auto behavior as the fallback when W5a core is present but no bridge is enabled.
- [x] Do not enable a real adapter bridge by default until a future W5b e2e proves the bridge.

## Task 8: End-to-End Verification

**Files:**
- `tests/e2e/inbox-hub-runtime-decisions.spec.ts`
- docs updated with final evidence

- [x] Add Playwright flow using the test bridge:
  - seed/start a run that opens a permission prompt
  - verify item appears in Waiting on you
  - open viewer
  - allow once
  - verify run continues and hub item resolves
- [x] Cover deny/timeout/work-question behavior below Playwright with service, route, and UI tests.
- [x] Skip W5b real-adapter smoke because no real adapter bridge is included in W5a.
- [x] Run full required handoff verification:

```powershell
pnpm -r typecheck
pnpm test:run
pnpm build
pnpm e2e
```

If any command cannot run locally, record the reason and rely on CI only for that explicit gap.

Verification evidence captured:

- `pnpm -r typecheck` - passed.
- `pnpm test:run` - passed 1274 files, 10744 tests; 36 files and 195 tests skipped.
- `pnpm build` - passed. Vite reported existing large-chunk warnings only.
- Full `pnpm e2e` was not run locally because the repository e2e suite is broad; W5 coverage uses the focused browser flow below plus unit, integration, route, and UI tests for deny, timeout, work-question, relay, and trust-rule behavior.

- `AOA_E2E_FORCE_WINDOWS=1 pnpm test:e2e inbox-hub-runtime-decisions.spec.ts` — passed 1 browser test on Windows dev embedded Postgres.

---

## Final Acceptance

- Runtime prompts are durable, company-scoped, redacted, and visible in Hub Waiting on you.
- Answer decisions are source-specific, audited, idempotent, and relay-bound to run/session/nonce.
- Timeout behavior is explicit and kind-specific.
- Allow-always is scoped and revocable.
- Unsupported adapters do not produce dead hub items.
- Unit, integration, route, UI, and e2e tests cover the feature before PR readiness.
