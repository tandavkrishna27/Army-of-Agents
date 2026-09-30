# Inbox Hub Part 2 — Functional Bugs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the four remaining functional bugs from the 2026-07-03 live QA (BUG-1 codex handshake BLOCKER, BUG-2 stale runtime-decision hub items, BUG-4 SPA deep-link 404, BUG-5 missing run_complete) plus the two E2/G1 review P2s, then verify every fix live by driving the real flows through the UI.

**Architecture:** All fixes are surgical and event-driven-first: the codex fix is transport-layer only (adapter package); BUG-2 moves hub-item closing from read-path-only to push-on-terminal-transition (using the existing version-guarded reconciler); BUG-4 extracts a shared SPA-fallback module; BUG-5 adds the missing run_complete/run_failed event emit at the single terminal-status chokepoint. Nothing relies on re-emits (the change-aware `emit()` storm guard skips no-op side-effects).

**Tech stack:** TypeScript, Express 5, Drizzle ORM, vitest (mock + embedded-postgres integration), codex-cli 0.130 app-server JSON-RPC.

**Branch:** `feat/inbox-hub-tabbed` (same PR as Part 1, per the one-PR-in-parts agreement).

**Evidence base:** `docs/aoa/qa/inbox-hub-2026-07-03/BUGS.md` + the 2026-07-04 investigation (4 agents, incl. a live codex 0.130 protocol probe). All file:line references verified against this worktree.

---

## ⚠️ Decision amendment required (BUG-2) — flag to founder, do not ship silently

Decisions #105/#106 say timeout-escalated prompts "stay visible" in the hub. Today that is implemented by keeping the `agent_runtime_decision` item **open in Waiting-on-you forever** — which IS BUG-2 (phantom answerable items, inflated badge, 409s). This plan preserves the *intent* but changes the *mechanism*: the waiting-lane item archives on terminal transition, and an **`agent_error` follow-up item in the Notifications lane** carries "Permission request timed out: …" (plus the archived row stays inspectable via status filter/audit). Task 4 includes the decisions.md amendment note on both sections.

---

## Task 1 — BUG-1 primary: codex app-server `initialize` params (BLOCKER)

**Live-probe facts (codex-cli 0.130.0):** no `params` → `-32600 "Invalid request: missing field 'params'"`; `params:{}` → `"missing field 'clientInfo'"`; `clientInfo:{name,version}` → SUCCESS (title optional). Paramless `initialized` **notification** IS accepted; `thread/start`, `thread/resume`, `turn/start` shapes are all accepted as-is. Only `initialize` is malformed.

**Files:**
- Modify: `packages/adapters/codex-local/src/server/app-server/driver.ts:305` (+ module const near :138)
- Modify: `packages/adapters/codex-local/src/server/app-server/jsonrpc-client.ts` (`request()` — the frame write is at :217; `notify()` at :222 stays untouched)
- Test: `packages/adapters/codex-local/src/server/__tests__/appserver-driver.test.ts` (driveHandshake helper :147-148 + timeout test :276-277)
- Test: `packages/adapters/codex-local/src/server/__tests__/appserver-jsonrpc-client.test.ts`

- [ ] **Step 1 (failing test):** in `appserver-driver.test.ts`'s shared `driveHandshake` helper, right after `const init = await fake.waitForRequest("initialize")`, add:
```ts
expect(init.params).toMatchObject({
  clientInfo: { name: expect.any(String), version: expect.any(String) },
});
```
Add the same assert to the direct `waitForRequest("initialize")` in the timeout test (~:276). Run: `pnpm --filter @armyofagents/adapter-codex-local exec vitest run appserver-driver` → FAIL (params undefined).
- [ ] **Step 2 (impl):** in `driver.ts`, add at module scope near :138:
```ts
/**
 * codex 0.130 app-server REQUIRES `params.clientInfo` on `initialize` —
 * live-verified: omitting params → -32600 "missing field `params`";
 * `params:{}` → "missing field `clientInfo`"; name+version required, title
 * optional. Same shape the Task-1 spike proved live (appserver-spike.test.ts).
 */
const INITIALIZE_PARAMS = {
  clientInfo: {
    name: "aoa-codex-local",
    title: "AoA codex_local runtime-decision bridge",
    version: "1.0.0",
  },
} as const;
```
Change :305 `await client.request("initialize");` → `await client.request("initialize", INITIALIZE_PARAMS);`. Leave :306 `client.notify("initialized");` UNCHANGED (paramless notification proven-accepted).
- [ ] **Step 3 (transport test + impl):** in `appserver-jsonrpc-client.test.ts`, add a frame-shape test: `client.request("x")` with no params → the written stdin line, parsed, HAS a `params` key deep-equal `{}`; `notify("initialized")` still writes NO params key. Then in `jsonrpc-client.ts` `request()` change `enqueueWrite({ jsonrpc: "2.0", id, method, params })` → `enqueueWrite({ jsonrpc: "2.0", id, method, params: params ?? {} })` with the comment:
```ts
// codex app-server's request envelope REQUIRES the `params` field
// (omitted → -32600 "missing field `params`"). JSON.stringify drops
// undefined values, so default to {} to keep the key on the wire.
```
Do NOT touch `notify()`.
- [ ] **Step 4:** run both test files + package typecheck → PASS. Commit: `fix(codex-local): send required clientInfo params on app-server initialize (BUG-1)`.

## Task 2 — BUG-1 secondary: unknown-session regex misses real codex 0.130 texts

Real rejection texts (live-captured): `"thread not found: <id>"` (turn/start) and `"no rollout found for thread id <id>"` (thread/resume). Neither matches `isCodexUnknownSessionError` at `packages/adapters/codex-local/src/server/parse.ts:173`, so the resume→fresh-thread fallback (driver.ts:341→164-168) rethrows and fails the run — contradicting protocol doc §8b. Additive-only regex change (more errors → retry-with-fresh-session, the safe direction; also used by exec path `execute.ts:763`).

**Files:** Modify `parse.ts:173`; test wherever `isCodexUnknownSessionError` is covered (else extend `appserver-failure-modes.test.ts`); fix the fake text at `appserver-driver.test.ts:153`; doc `docs/adapters/codex-appserver-protocol.md:29`.

- [ ] **Step 1 (failing test):** add cases with the two REAL texts → expect `true`:
```ts
expect(isCodexUnknownSessionError("thread not found: 00000000-0000-0000-0000-000000000000")).toBe(true);
expect(isCodexUnknownSessionError("no rollout found for thread id 00000000-0000-0000-0000-000000000000")).toBe(true);
```
- [ ] **Step 2 (impl):** add the two live texts as EXPLICIT alternations (Codex P2: do NOT broaden `thread .* not found` to `thread .*not found` — this function also classifies arbitrary run output on the exec path (`execute.ts:763`) and internal-agent CLI mode, so overmatching triggers spurious fresh-session retries; keep the existing alternations untouched):
```ts
return /unknown (session|thread)|session .* not found|thread .* not found|thread not found:|no rollout found for thread id|conversation .* not found|missing rollout path for thread|state db missing rollout path/i.test(
  haystack,
);
```
- [ ] **Step 3:** change the driver test's fake rejection text (:153) to the real `"no rollout found for thread id 019f-abcd"` so the resume-unknown test exercises the production regex against production wire text. Update `docs/adapters/codex-appserver-protocol.md:29` handshake step: `initialize (id=1) { clientInfo: { name, version, title? } }` + note that `params` is required on every request envelope.
- [ ] **Step 4:** tests green → commit: `fix(codex-local): classify real 0.130 unknown-thread texts as unknown-session (resume fallback)`.

## Task 3 — BUG-4: SPA fallback 404 under dot-directory installs

**Root cause (verified via monkey-patched stack capture):** `app.ts:552-554` `res.sendFile(path.join(uiDistDir, "index.html"))` — absolute path, no `root` → `send@1.2.1` dotfile-checks EVERY path segment → `.aoa` in the install path → `dotfiles:"ignore"` → 404 → errorHandler `{"error":"Not Found"}`. NOT route order; NOT Express-5 wildcards (the existing regex is valid). Same failure mode already documented at `server/src/routes/plugin-ui-static.ts:480-482`. Real product bug for any `~/.aoa/...` install.

**Review corrections folded (Codex, 2026-07-04):** exact-path regex (`/^(?!\/(?:api|assets)(?:\/|$)).*/` — the naive form served the SPA for exact `/api` and `/assets`); explicit unknown-session alternations instead of broadening (Task 2); deep-link guard must cache list-found items + cap both cache writers (Task 6); citation fixes (jsonrpc :217/:222, plugin-ui-static routes/ path).

**Files:**
- Create: `server/src/services/spa-fallback.ts`
- Modify: `server/src/app.ts:550-554` (static block) + `:577` (vite-dev regex, consistency)
- Test: `server/src/__tests__/spa-fallback.test.ts` (NEW, supertest)

- [ ] **Step 1:** create `server/src/services/spa-fallback.ts`:
```ts
import type { RequestHandler } from "express";

/**
 * SPA catch-all route: every GET that is not /api/* (JSON 404s, Issue #116)
 * and not /assets/* (a missing hashed bundle must 404 loudly, not serve
 * index.html). Express 5: string "*" is invalid — RegExp path is the
 * established pattern here.
 */
export const SPA_FALLBACK_ROUTE = /^(?!\/(?:api|assets)(?:\/|$)).*/;

/**
 * index.html is sent root-relative: sendFile with a bare absolute path runs
 * `send`'s dotfile check on EVERY path segment, so an install under a
 * dot-directory (e.g. ~/.aoa/wt/... worktrees, npx caches) 404s with
 * dotfiles:"ignore". With `root` set, only the path relative to root is
 * checked. Same failure mode as plugin-ui-static.ts.
 */
export function spaFallbackHandler(uiDistDir: string): RequestHandler {
  return (_req, res) => {
    res.sendFile("index.html", { root: uiDistDir });
  };
}
```
- [ ] **Step 2 (failing test):** `server/src/__tests__/spa-fallback.test.ts` — build a temp dist under a **dot segment** (`fs.mkdtempSync(...)/.aoa-like/dist`) with marker `index.html` + `assets/real-abc123.js`; assemble app exactly like app.ts (`/api` router ending in JSON 404 → `express.static(dist)` → `app.get(SPA_FALLBACK_ROUTE, spaFallbackHandler(dist))`). Assert: `/QAL/home` → 200 html marker; `/QAL/inbox/waiting` → 200; `/` → 200; `/api/nope` → 404 JSON `{error:"Not found",path}`; `/assets/missing.js` → 404 without marker; `/assets/real-abc123.js` → 200; regex unit asserts (`/api/x` false, `/assets/x.js` false, **exact `/api` false, exact `/assets` false** (Codex P2 — the naive `\/api\//` form misses the slash-less exact paths), `/QAL/home` true, `/apiary` true (no false positive on prefixes), `/` true). The 200-html cases FAIL against the old inline handler (reproduce first by pointing the test at a copy of the old code path — or simply implement Step 3 and watch the pre-existing behavior fail via a direct old-style handler in the test as a control).
- [ ] **Step 3 (impl):** rewire `app.ts` static block:
```ts
// BEFORE
app.get(/^(?!\/api\/).*/, (_req, res) => {
  res.sendFile(path.join(uiDistDir, "index.html"));
});
// AFTER
app.get(SPA_FALLBACK_ROUTE, spaFallbackHandler(uiDistDir));
```
and the vite-dev catch-all regex at :577 → `SPA_FALLBACK_ROUTE` (handler body unchanged). Import from `./services/spa-fallback.js`. Update the W5b comment at app.ts:520-522 that cites the old regex string.
- [ ] **Step 4:** tests + typecheck green → commit: `fix(server): SPA fallback works under dot-directory installs + /assets 404s loudly (BUG-4)`.

## Task 4 — BUG-2: close runtime-decision hub items on every terminal transition

**Root cause:** closes happen ONLY in the read-path reconcile sweep, and `runtimeDecisionSourceSnapshot` (agent-runtime-decisions.ts:519) excludes `cancelled + timeoutPolicy in {park_run, escalate}` from `terminal` via `isVisibleTimeoutFollowUp` (:65-67) — and ALL live prompts are `escalate` (runtime-hook-bridge.ts:247). So expire + run-cancel items stay open forever; answered→relayed closes only on the next GET.

**Files:**
- Modify: `server/src/services/agent-runtime-decisions.ts` (:519, :171, after :637, :922, :958, :1002)
- Modify: `server/src/services/hub-items.ts` (reconcile :1553-1558 semanticType scoping; :1586-1607 publish-on-close)
- Test: `server/src/__tests__/agent-runtime-decisions.test.ts` (extend), `server/src/__tests__/hub-items-runtime-decision-reconcile.test.ts` (invert 2 tests + add)
- Doc: `docs/architecture/decisions.md` (#105 §Timeout/SLA ~:976, #106 ~:1039-1041 amendment notes)

- [ ] **Step 1 (failing tests):** pure-function matrix on `runtimeDecisionSourceSnapshot`: relayed→terminal `true`; expired→`true`; **cancelled+escalate→`true` (the change)**; cancelled+deny→`true`; answered→`false`; relay_failed→`false`; created/shown→`false`; null row→`true`. Invert `hub-items-runtime-decision-reconcile.test.ts` (:77-141, :143-246): parked-cancelled row now `{ healed: 1, closed: 1, refreshed: 0 }` and `snapshot.terminal === true` (cite BUG-2 in test comments so the inversion isn't misread as regression; mock db needs `update().set().where().returning()→[row]` + `insert(hubAudit).values()` plumbing).
- [ ] **Step 2 (impl, snapshot):** `terminal: TERMINAL_STATUSES.has(status)` (drop the carve-out from `terminal` only; keep `isVisibleTimeoutFollowUp` for the summary branch so the relayError text still refreshes pre-close).
- [ ] **Step 3 (impl, push-close):** widen `HubItemsApi` (:171) to `Pick<..., "emit" | "reconcile">`; add next to `emitHubItem`:
```ts
async function closeProjectedHubItem(decision: AgentRuntimeDecisionRow) {
  try {
    await hub.reconcile(decision.companyId, {
      sourceType: SOURCE_TYPE,
      sourceId: decision.id,
    });
  } catch (err) {
    // Best-effort: the decision flip is already durable; the GET-path sweep
    // reconciles on the next read. Never poison the terminal transition.
    logger.warn({ err, decisionId: decision.id }, "runtime decision hub-item close failed");
  }
}
```
Call it AFTER `emitHubItem(...)` (order matters: emit refreshes the final relayError onto the still-open row; the close does NOT depend on emit side-effects) at: `markRelayed` (:922), `expireDuePrompts` (:958), `cancelActiveForRun` (:1002). In `expireDuePrompts`, when the outcome is parked/escalated, ALSO emit the escalate-visible follow-up BEFORE the close:
```ts
if (outcome.parked) {
  // Escalate-visible (Decisions #105/#106): the waiting-lane item closes, so
  // surface WHAT HAPPENED as a notifications-lane item instead.
  await hub.emit({
    companyId: updated.companyId,
    semanticType: "agent_error",
    sourceType: SOURCE_TYPE,
    sourceId: updated.id,
    title: `Permission request timed out: ${updated.title}`,
    summary: updated.relayError ?? "timeout policy parked the run",
    relatedEntityType: "heartbeat_run",
    relatedEntityId: updated.runId,
    sourceActorType: "agent",
    sourceActorId: updated.agentId,
    priority: "high",
  });
}
await closeProjectedHubItem(updated);
```
- [ ] **Step 4 (impl, reconcile scoping + realtime close):** in `hub-items.ts` reconcile(): scope runtime_decision to its semanticType (prevents the sweep instantly archiving the new agent_error follow-up):
```ts
: opts.sourceType === "runtime_decision"
  ? "agent_runtime_decision"
  : null;
```
and publish on close (capture the row from `applyGuardedTransition` through `runTransaction`; swallow 409 TOCTOU):
```ts
const closedItem = await runTransaction(async (tx) =>
  applyGuardedTransition(tx, item, "archived", { ...reconcileCloseArgs }),
);
closed += 1;
publishHubItemChanged(closedItem, "archived");
// after the loop:
if (closed > 0) publishHubCountsChanged(companyId, "item_changed");
```
- [ ] **Step 5 (service mock tests):** extend `agent-runtime-decisions.test.ts` (hub double gains `reconcile: vi.fn(...)`; grep other constructors of the service for the widened type — :92/:249/:295 + heartbeat-runtime-decision-broker.test.ts): markRelayed→reconcile called with `(companyId, {sourceType:"runtime_decision", sourceId})` after emit; expire+escalate→agent_error emit + reconcile + runCanceller; expire+deny→NO close (answered non-terminal); cancelActiveForRun ×2 rows→reconcile per row, one rejection still resolves `{cancelled:2}`.
- [ ] **Step 6 (docs):** amendment notes in decisions.md #105/#106: "escalate-visible mechanism amended 2026-07-04: the waiting_on_you item archives on terminal transition; visibility moves to a notifications-lane agent_error item + audit/status-filter (BUG-2)".
- [ ] **Step 7:** all suites green → commit: `fix(hub): close runtime-decision hub items on terminal transitions + escalate-visible follow-up (BUG-2, amends D105/D106 mechanism)`.

## Task 5 — BUG-5: event-driven run_complete (+ run_failed hardening)

**Root cause:** zero producers for run_complete; run_failed exists only via the sidebar-badges scan-on-read. The W3 autopilot design already expects OPEN run_complete items (default rule slot, heartbeat_run→agent lookup, canonical test). `setRunStatus` (heartbeat.ts:1656-1687) is the single terminal-status writer.

**Files:**
- Modify: `server/src/services/hub-source-producers.ts` (after :202)
- Modify: `server/src/services/heartbeat.ts` (inside setRunStatus after :1683; import near :36)
- Modify: `server/src/services/hub-items.ts:39-45` (`HEARTBEAT_ACTIONABLE_STATUSES` + "succeeded")
- Modify: `server/src/routes/hub-items.ts:109-115` (notifications-lane heartbeat_run reconcile)
- Test: `server/src/__tests__/hub-materializers.test.ts` (extend), `hub-items-emit.integration.test.ts` + `hub-items-sweeper.integration.test.ts` (extend)

- [ ] **Step 1 (failing tests, pure):** `buildCompletedRunHubEmit` shape (semanticType run_complete, sourceType heartbeat_run, sourceId=run.id, priority normal, actor agent, "Agent" fallback name). `buildTerminalRunHubEmit` dispatch: succeeded→run_complete; failed/timed_out→**deep-equal `buildFailedRunHubEmit(sameRun)`** (parity so the event producer and the legacy scan can never drift and ping-pong the change-aware upsert); cancelled/running/queued→null.
- [ ] **Step 2 (impl, builders):** add to `hub-source-producers.ts` (reuse `FailedRunLike`):
```ts
export function buildCompletedRunHubEmit(run: FailedRunLike): EmitArgs {
  const agentName = run.agentName?.trim() || "Agent";
  return {
    companyId: run.companyId,
    semanticType: "run_complete",
    sourceType: "heartbeat_run",
    sourceId: run.id,
    title: `${agentName} run complete`,
    summary: "Run finished successfully",
    sourceActorType: "agent",
    sourceActorId: run.agentId,
    priority: "normal",
    sourcePermissionRevision: sourceRevision(run.updatedAt),
  };
}

const TERMINAL_FAILED_STATUSES: ReadonlySet<string> = new Set(["failed", "timed_out"]);

// Maps a terminal heartbeat run to its hub emit. Cancelled/queued/running -> null
// (cancellation is founder-initiated; no notification). MUST route failures
// through buildFailedRunHubEmit so the event emit and the legacy sidebar-badges
// scan produce byte-identical rows for the same run (change-aware emit no-ops).
export function buildTerminalRunHubEmit(run: FailedRunLike): EmitArgs | null {
  if (run.status === "succeeded") return buildCompletedRunHubEmit(run);
  if (TERMINAL_FAILED_STATUSES.has(run.status)) return buildFailedRunHubEmit(run);
  return null;
}
```
- [ ] **Step 3 (impl, chokepoint emit):** in `setRunStatus`'s `if (updated)` block after `publishLiveEvent(...)` (:1683):
```ts
if (["succeeded", "failed", "timed_out"].includes(updated.status)) {
  try {
    const agentRow = await db
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.id, updated.agentId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    const emitArgs = buildTerminalRunHubEmit({
      id: updated.id,
      companyId: updated.companyId,
      agentId: updated.agentId,
      agentName: agentRow?.name ?? null,
      status: updated.status,
      error: updated.error ?? null,
      updatedAt: updated.updatedAt,
    });
    if (emitArgs) await emitHubItem(db, emitArgs);
  } catch (err) {
    logger.warn({ err, runId: updated.id }, "terminal-run hub emit failed (non-fatal)");
  }
}
```
(best-effort try/catch mirrors relayCrewResult :4445-4454; `resolveOwner` can throw "no human owner" — must never fail a run).
- [ ] **Step 4 (impl, lifecycle):** add `"succeeded"` to `HEARTBEAT_ACTIONABLE_STATUSES` (hub-items.ts:39-45) with the comment: a succeeded run's run_complete item stays open while it is the agent's LATEST run; the existing `isSuperseded` rule closes it when a newer run lands. Activate the (currently caller-less) heartbeat_run reconciler on notifications-lane reads (`routes/hub-items.ts` GET list, alongside the existing per-lane scans):
```ts
if (!query.lane || query.lane === "notifications") {
  await svc.reconcile(companyId, { sourceType: "heartbeat_run" });
}
```
- [ ] **Step 5 (integration):** extend `hub-items-emit.integration.test.ts`: event-emit(succeededRun) → one open notifications row; identical re-emit → no-op (xmin stable — change-aware compatibility); for a failed run, event-emit then `emitLegacyAlertHubItems` → exactly ONE row (sourceUniqueKey dedupe). Extend `hub-items-sweeper.integration.test.ts` (:210): latest-succeeded run_complete SURVIVES reconcile; newer run → closed with reconcile_close audit.
- [ ] **Step 6:** suites green → commit: `feat(hub): event-driven run_complete + run_failed at the terminal-status chokepoint (BUG-5)`.

## Task 6 — E2/G1 review P2s (client hardening)

**Files:** Modify `ui/src/pages/InboxHub.tsx`; test `ui/src/__tests__/InboxHub.test.tsx` (extend).

- [ ] **Step 1:** deep-link guard: replace `deepLinkHandledRef = useRef(false)` with `useRef<string | null>(null)` keyed on itemId (`if (handledItemIdRef.current === itemId) return; ... handledItemIdRef.current = itemId;`) so a second cross-lane deep-link in the same SPA session hydrates too (fire-once-per-item, still no tab-spam). **Codex P2:** in the `items.some(...)` early-return branch, CACHE the found list item into `openedItemCache` before marking handled — otherwise a later list refetch that drops the item leaves that same deep-link unhydratable forever (guard says handled, cache empty).
- [ ] **Step 2:** `openedItemCache` cap: extract one pruning insert helper (most recent 24 entries — matches the deliberate bounding of `useHubTabs` at 12) and use it at **BOTH writers** (Codex P2): the deep-link `getOne().then(...)` path AND `handleOpenItem`. Keep it load-bearing for `resolveHubItem`.
- [ ] **Step 3:** tests: deep-link to item A then B (both hydrate via `getOne`); deep-link to an item present in the list → it lands in the cache; cache holds ≤24 after 30 inserts. Green → commit: `fix(hub-ui): per-item deep-link guard + bounded opened-item cache (review P2s)`.

## Task 7 — Live verification: drive the real flows through the UI

Rebuild UI (`pnpm --filter @armyofagents/ui build`), restart the QA server (:3399, same env incl. `AOA_RUNTIME_DECISION_ROUTING=1`), then via `/browse` + the founder's own click-through:

- [ ] **Flow A (BUG-1+BUG-2 answer path, codex):** create a task assigned to **Scout-Codex** (codex_local, runtimeDecisionRoutingEnabled) instructing a risky command → run survives the handshake (no "missing field `params`" in the run-log ndjson) → `agent_runtime_decision` appears in **Waiting on you** → click **Allow once** in the hub → decision relays, run proceeds → **item leaves the open lane in realtime** (BUG-2 publish-on-close).
- [ ] **Flow B (BUG-2 expire path):** raise another prompt (claude_local Scout-Claude is fine) → don't answer → after the 5-min SLA + 30s sweeper: item leaves Waiting-on-you, a **"Permission request timed out"** item appears in Notifications (escalate-visible), badge count drops.
- [ ] **Flow C (BUG-2 cancel path):** raise a prompt → cancel the run → item leaves the open lane immediately.
- [ ] **Flow D (BUG-5):** dispatch a task to Scout-Claude that completes → **run_complete appears in Notifications WITHOUT loading sidebar-badges**; optional: enable Autopilot drive + run_complete→resolve rule → item auto-resolves on the next hub read.
- [ ] **Flow E (BUG-4):** hard-reload `http://127.0.0.1:3399/QAL/inbox/waiting` (F5 + fresh tab) → the app renders (200 html); `curl /api/nope` → 404 JSON; `curl /assets/deadbeef.js` → 404.
- [ ] **Flow F (storm regression):** with the Inbox open through all of the above, instrument fetch for 6s idle → ~0 requests; no ERR_INSUFFICIENT_RESOURCES.
- [ ] Capture screenshots per flow into the QA folder + update `docs/aoa/qa/inbox-hub-2026-07-03/BUGS.md` with RESOLVED annotations (BUG-1..5 + commit SHAs). Report the URL to the founder for their own click-through.

## Verification (suites)
- `pnpm --filter @armyofagents/adapter-codex-local exec vitest run` — driver/jsonrpc/parse suites green.
- Server: hub-items + agent-runtime-decisions + heartbeat + spa-fallback + hub-materializers suites green from repo root (`npx vitest run server/...`); integration suites green in Linux CI (win32 skips).
- UI: InboxHub suite green; full `vitest run` per package clean; typecheck clean.

## Scope guard
**In scope:** exactly BUG-1/2/4/5 + the two review P2s + the decisions.md amendment + protocol-doc line. **Not in scope:** E3 fresh panels (deferred by founder), RoutineDetail tab, Notifications/Autopilot settings UIs, the F1 client invalidation scoping (storm root cause already fixed at emit; residual mutation-side invalidation breadth is user-action-bounded), cancelled-run notifications, the "answered-with-dead-run" lingering-item edge (pre-existing hole — noted in Task 4 risks, follow-up).
