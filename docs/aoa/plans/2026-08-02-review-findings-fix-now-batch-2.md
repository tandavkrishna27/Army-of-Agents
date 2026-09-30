# Whole-PR Re-Review Fix-Now Batch 2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remediate the four reachable findings + two doc findings from the dual whole-PR re-review on HEAD `0a9b1cc0` (branch `claude/multitenant-cloud`, worktree `C:/Users/TK/.aoa/wt/mt-cloud`, PR #316).

**Architecture:** Six independent fixes; four small/contained runtime changes, two documentation-only. No schema change, no migration. Deployment-mode discipline is per-task — do NOT blanket-gate everything on `cloud_auth`:
- **Task 2** IS gated on `tenantIsolationEnforced()` (=== `deploymentMode === "cloud_auth"`) — a strict no-op on self-hosted `local_trusted`/`authenticated`.
- **Task 1** (reject terminated/pending agents) runs in ALL modes — it's a security-parity fix aligning the live-events WS with the preview-WS + HTTP-REST agent checks that already reject those statuses everywhere. Not cloud-gated.
- **Task 4** (personal_subscription fails closed) runs in ALL modes and DELIBERATELY changes self-hosted single-tenant behavior — that IS the finding (the credential is only reachable there; on shared infra `credentialKind` is never `personal_subscription`). Do NOT gate it on `cloud_auth` — that would make it a no-op and leave the locked-decision violation unfixed.
- **Task 3** (reject-ambiguous 409) runs in all modes but is inert unless an identifier genuinely collides across two companies.

**Tech Stack:** TypeScript, Express 5, Drizzle ORM, vitest. `setDeploymentMode`/`tenantIsolationEnforced` from `server/src/config/deployment-mode.ts` is a global mutable singleton — any test that flips it to `cloud_auth` MUST reset it to `local_trusted` in `afterEach`.

---

## Findings → Task map

| # | Finding | Verified severity | Task |
|---|---------|-------------------|------|
| 1 | Terminated/pending agent admitted on `/events/ws` (agent branch never loads the `agents` row) | Medium (High for `pending_approval` — bypasses D6 board-approval gate) | Task 1 |
| 2 | Extraction runs fail-open under the operator's ambient host CLI login on cloud (4th unguarded sink) | High | Task 2 |
| 3 | Bare-route identifier resolve is unscoped → wrong-task mutation among a dual-org member's OWN companies (NOT cross-tenant — `assertCompanyAccess` is fail-closed) | Correctness | Task 3 |
| 4 | Unpinned `personal_subscription` run fails OPEN to local instead of closed (contradicts Decision #117 §4) | Low blast radius (self-host single-tenant only) but violates a locked decision | Task 4 |
| 5 | Decision #117 stale: says `ON DELETE SET NULL` + worker-token = target primary key (migration-free); reality = `ON DELETE CASCADE` (migration 0196) + hashed `worker_token_hash` (migration **0194**) | Docs | Task 5 |
| 6 | Hand-appended migration SQL (0189/0195) conflicts with the "never hand-write migrations" rule without a documented exception | Process/docs | Task 6 |

---

## File Structure

- `server/src/realtime/live-events-ws.ts` — Task 1. **This file is git-flagged BINARY** (pre-existing NUL byte in a comment). Edits work, but `git diff` is opaque — read the file directly to verify. Add the `agents`-row load+reject to the agent branch.
- `server/src/__tests__/upgrade-auth.test.ts` — Task 1 tests (already imports `authorizeUpgrade` from live-events-ws + has an `agents`-aware mock DB).
- `server/src/services/extraction-cli.ts` — Task 2. Add a `tenantIsolationEnforced()` refusal at the top of `extractViaCli` (the universal chokepoint all four extraction sinks funnel through).
- `server/src/__tests__/extraction-cli.test.ts` — Task 2 tests.
- `server/src/services/issues.ts` — Task 3. `getByIdentifier` → `LIMIT 2` + reject-ambiguous 409 (`conflict` already imported at :40).
- `server/src/__tests__/issue-identifier-company-scope.integration.test.ts` — Task 3 test (integration; Windows-skipped — see flip/verify/revert note in the task).
- `server/src/services/heartbeat-execution-target.ts` + `server/src/services/heartbeat.ts` (call site ~:3289) — Task 4.
- `server/src/__tests__/heartbeat-execution-target-pin.test.ts` — Task 4 tests. This is the ONLY test file that imports/calls `handleExecutionTargetRoutingError` (two calls at ~:13,18); its existing calls must be UPDATED for the widened ctx, not just added to. (`heartbeat-execution-target.test.ts` does NOT call the helper.)
- `docs/architecture/decisions.md` (§117, ~:1785 and ~:1799) — Task 5.
- `AGENTS.md` (:87, Decision #19 rule) + `docs/architecture/decisions.md` (Decision #19 if present) — Task 6.

---

### Task 1: Reject terminated/pending agents on the live-events WebSocket

**Root cause:** `authorizeUpgrade` in `live-events-ws.ts` resolves an `agentApiKeys` row (unrevoked hash + matching company) and returns an `actorType:"agent"` context WITHOUT ever loading the `agents` row. The preview-WS path (`services/upgrade-auth.ts:182-195`) and the HTTP-REST path (`middleware/auth.ts`) both load the agent and reject `terminated`/`pending_approval`. `terminate()` revokes keys same-tx (so "terminated" is mostly mitigated by `isNull(revokedAt)`), but a `pending_approval` agent's keys are never revoked → it can open the company event stream and bypass the D6 board-approval gate. Pre-existing (2026-05-25), not introduced by this PR.

**Files:**
- Modify: `server/src/realtime/live-events-ws.ts` (import list ~:7-13; agent branch ~:259-280)
- Test: `server/src/__tests__/upgrade-auth.test.ts` (the `describe("authorizeUpgrade", …)` block)

- [ ] **Step 1: FIRST fix the existing test the change will break**

The `describe("live-events authorizeUpgrade", …)` block already has a test at ~:424 — `"agent bearer branch ignores an untrusted Origin"` — that seeds ONLY `key` (no `agent`) and expects `{ actorType: "agent", actorId: "agent-1" }` + `db.update` called once. After Step 3 adds the agent-row load, that query returns `[]` → `return null` → this test FAILS. Update its seed to include an active agent:

```ts
const db = makeUpgradeAuthDb({
  key: { id: "key-1", companyId: "company-1", agentId: "agent-1" },
  agent: { id: "agent-1", companyId: "company-1", status: "idle" },
});
```
(Leave its assertions unchanged — it should still return the agent actor + call `db.update` once, now that the agent is active.)

- [ ] **Step 2: Write the failing tests**

In the SAME `describe("live-events authorizeUpgrade", …)` block (NOT the `authorizeCompanyUpgrade` block — that one tests the preview-WS in `services/upgrade-auth.ts`), add the cases below. The agent branch is deployment-mode-INDEPENDENT (it runs whenever a Bearer/`?token=` token is present, before the mode-specific board branches), so `deploymentMode` in these cases is immaterial — match the existing test's `{ headers: { authorization: "Bearer …" } }` shape. The mock DB (`makeUpgradeAuthDb`) already returns `input.agent` for `table === agents`. Add:

```ts
it("authorizeUpgrade: rejects a terminated agent even with a valid key", async () => {
  const db = makeUpgradeAuthDb({
    key: { id: "k1", companyId: "c1", agentId: "a1", revokedAt: null },
    agent: { id: "a1", companyId: "c1", status: "terminated" },
  });
  const ctx = await authorizeUpgrade(
    db as never,
    { headers: { authorization: "Bearer tok" } } as never,
    "c1",
    new URL("https://x/events/ws?"),
    { deploymentMode: "cloud_auth" },
  );
  expect(ctx).toBeNull();
});

it("authorizeUpgrade: rejects a pending_approval agent even with a valid key", async () => {
  const db = makeUpgradeAuthDb({
    key: { id: "k1", companyId: "c1", agentId: "a1", revokedAt: null },
    agent: { id: "a1", companyId: "c1", status: "pending_approval" },
  });
  const ctx = await authorizeUpgrade(
    db as never,
    { headers: { authorization: "Bearer tok" } } as never,
    "c1",
    new URL("https://x/events/ws?"),
    { deploymentMode: "cloud_auth" },
  );
  expect(ctx).toBeNull();
});

it("authorizeUpgrade: rejects when the agent row is missing", async () => {
  const db = makeUpgradeAuthDb({
    key: { id: "k1", companyId: "c1", agentId: "a1", revokedAt: null },
    agent: null,
  });
  const ctx = await authorizeUpgrade(
    db as never,
    { headers: { authorization: "Bearer tok" } } as never,
    "c1",
    new URL("https://x/events/ws?"),
    { deploymentMode: "cloud_auth" },
  );
  expect(ctx).toBeNull();
});

it("authorizeUpgrade: rejects when agent.companyId != key.companyId", async () => {
  const db = makeUpgradeAuthDb({
    key: { id: "k1", companyId: "c1", agentId: "a1", revokedAt: null },
    agent: { id: "a1", companyId: "OTHER", status: "idle" },
  });
  const ctx = await authorizeUpgrade(
    db as never,
    { headers: { authorization: "Bearer tok" } } as never,
    "c1",
    new URL("https://x/events/ws?"),
    { deploymentMode: "cloud_auth" },
  );
  expect(ctx).toBeNull();
});

it("authorizeUpgrade: admits an active agent with a valid key", async () => {
  const db = makeUpgradeAuthDb({
    key: { id: "k1", companyId: "c1", agentId: "a1", revokedAt: null },
    agent: { id: "a1", companyId: "c1", status: "idle" },
  });
  const ctx = await authorizeUpgrade(
    db as never,
    { headers: { authorization: "Bearer tok" } } as never,
    "c1",
    new URL("https://x/events/ws?"),
    { deploymentMode: "cloud_auth" },
  );
  expect(ctx).toEqual({ companyId: "c1", actorType: "agent", actorId: "a1" });
});
```

> If the existing `authorizeUpgrade` agent tests pass an agent object shape or a token differently, match that shape — read the top of the file first. The agent branch reads the token from `Authorization: Bearer` or `?token=`; use whichever the existing tests use. Confirm the exact `status` string values are `"terminated"` and `"pending_approval"` by grepping the `agents` schema (`packages/db/src/schema/agents.ts`) — do NOT guess.

- [ ] **Step 3: Run the tests — verify they FAIL**

Run: `cd C:/Users/TK/.aoa/wt/mt-cloud && pnpm --filter @armyofagents/server test -- upgrade-auth`
Expected: the five new cases FAIL (the current agent branch returns the actor regardless of agent status/existence). The `active agent` case may pass by coincidence; the four rejection cases must fail. (The existing :424 test now seeds an active agent, so it stays green.)

- [ ] **Step 4: Implement the agent-row load + reject**

In `live-events-ws.ts`, add `agents` to the `@armyofagents/db` import (it currently imports `agentApiKeys, companies, companyMemberships, instanceUserRoles, organizationMemberships` — add `agents`, keep alphabetical if the block is sorted).

In the agent branch, between `if (!key || key.companyId !== companyId) { return null; }` and the `lastUsedAt` update, insert the load+reject mirroring `services/upgrade-auth.ts:182-195`:

```ts
  const agent = await db
    .select()
    .from(agents)
    .where(eq(agents.id, key.agentId))
    .then((rows) => rows[0] ?? null);

  if (
    !agent ||
    agent.companyId !== key.companyId ||
    agent.status === "terminated" ||
    agent.status === "pending_approval"
  ) {
    return null;
  }
```

Add a one-line comment above it: `// Mirror services/upgrade-auth.ts:182-195: a valid key is not enough — a terminated (key-revocation desync) or pending_approval (D6 board-approval gate) agent must not open the realtime bus.`

- [ ] **Step 5: Run the tests — verify they PASS**

Run: `pnpm --filter @armyofagents/server test -- upgrade-auth`
Expected: all cases PASS (existing, including the updated :424 test, + 5 new).

- [ ] **Step 6: Commit**

```bash
git add server/src/realtime/live-events-ws.ts server/src/__tests__/upgrade-auth.test.ts
git commit -m "fix(realtime): reject terminated/pending agents on live-events WS (mirror preview-WS agent check)"
```

---

### Task 2: Fail closed on extraction under cloud_auth

**Root cause:** Neither `resolveExtractionEngine` nor `extractViaCli` consults the deployment mode. On `cloud_auth`, any tenant's discussion/debrief/file/crew text is piped to the host `claude`/`codex` binary and generated under the OPERATOR's ambient login (`buildScrubbedCliEnv` deliberately keeps `ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN` + file-based `~/.claude` OAuth via `HOME`). This is the 4th run sink; the other three (org-agent heartbeat, Commander, crew) are already refused by the D1 unsandboxed guard. `extractViaCli` (`extraction-cli.ts:112`) is the single universal chokepoint — all four sinks (discussion via `resolveExtractionEngine`→`extractViaCli`; debrief-push, file-import, crew memory-extract directly) funnel through it. Every caller already handles a thrown `CliExtractionError` (they must — a missing CLI throws `ENOENT`→`not_installed` today), so adding one more throw path is safe by construction.

**Files:**
- Modify: `server/src/services/extraction-cli.ts` (imports; top of `extractViaCli` ~:112-118)
- Test: `server/src/__tests__/extraction-cli.test.ts`

- [ ] **Step 1: Write the failing test**

In `extraction-cli.test.ts`, add a describe block. Import `setDeploymentMode` from `../config/deployment-mode.js` and `extractViaCli` + `CliExtractionError` from `../services/extraction-cli.js` (match the file's existing import style). Reset the mode in `afterEach`:

```ts
import { setDeploymentMode } from "../config/deployment-mode.js";

describe("extractViaCli — cloud_auth fail-closed", () => {
  afterEach(() => setDeploymentMode("local_trusted"));

  it("refuses extraction on cloud_auth without spawning a CLI", async () => {
    setDeploymentMode("cloud_auth");
    await expect(extractViaCli("claude", "sys", "content")).rejects.toMatchObject({
      name: "CliExtractionError",
      kind: "not_authed",
    });
  });

  it("refuses codex extraction on cloud_auth too", async () => {
    setDeploymentMode("cloud_auth");
    await expect(extractViaCli("codex", "sys", "content")).rejects.toMatchObject({
      name: "CliExtractionError",
      kind: "not_authed",
    });
  });

  it("does NOT refuse off-cloud — the guard is a no-op on self-hosted (HERMETIC, no spawn)", async () => {
    setDeploymentMode("local_trusted");
    // Use an UNSUPPORTED tool so the guard-skip is proven WITHOUT spawning a real
    // binary: off-cloud, execution falls through to the synchronous
    // "Unsupported CLI tool" throw (extraction-cli.ts:165) — NOT the cloud
    // refusal. (Do NOT call extractViaCli("claude", …) here — on a dev box with
    // claude installed+authed it would spawn a real subprocess and could even
    // resolve, making the test slow and flaky.)
    let caught: unknown;
    try {
      await extractViaCli("bogus-tool", "sys", "content");
    } catch (e) {
      caught = e;
    }
    expect((caught as Error)?.name).toBe("CliExtractionError");
    expect(String((caught as Error)?.message)).not.toContain("AoA Cloud");
  });
});
```

> If `extraction-cli.test.ts` doesn't already import `afterEach`/`describe`/`it`/`expect` from vitest, add them. Verify the exact `not_authed` string is a member of `CliErrorKind` (it is: `extraction-cli.ts:41-46`), and that `extractViaCli("bogus-tool", …)` reaches the "Unsupported CLI tool" throw off-cloud (it does: `CLI_BINARY_MAP` has no `bogus-tool` key → the final `throw new CliExtractionError("Unsupported CLI tool …", "not_installed")` at :165).

- [ ] **Step 2: Run the test — verify it FAILS**

Run: `pnpm --filter @armyofagents/server test -- extraction-cli`
Expected: the two cloud cases FAIL (extraction currently proceeds to the binary branch and rejects with a spawn error / different kind, not the cloud refusal).

- [ ] **Step 3: Implement the guard**

In `extraction-cli.ts`, add the import (near the other `./` imports, e.g. after the `cli-spawn-safety.js` import):

```ts
import { tenantIsolationEnforced } from "../config/deployment-mode.js";
```

At the very top of `extractViaCli`, before `const { timeoutMs … } = options;`:

```ts
  // Fail closed on AoA Cloud (cloud_auth): there is no per-tenant isolated
  // extraction path yet, and the shared host's CLI login belongs to the
  // OPERATOR — running tenant content through it would generate under the
  // operator credential (the 4th unsandboxed sink; the other three are refused
  // by the D1 guard). This is the single chokepoint for all four extraction
  // sinks (discussion / debrief-push / file-import / crew memory-extract).
  // `not_authed` maps to the "unavailable on AoA Cloud" copy in
  // DiscussionDetail.extractionFailureMessage.
  if (tenantIsolationEnforced()) {
    throw new CliExtractionError(
      "Extraction is unavailable on AoA Cloud (cloud_auth): there is no per-tenant isolated extraction path yet.",
      "not_authed",
    );
  }
```

- [ ] **Step 4: Run the test — verify it PASSES**

Run: `pnpm --filter @armyofagents/server test -- extraction-cli`
Expected: all cases PASS. Then run the broader extraction suite to confirm no regression:
Run: `pnpm --filter @armyofagents/server test -- extraction`
Expected: green (all existing extraction tests run in default `local_trusted`, so the guard is a no-op for them).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/extraction-cli.ts server/src/__tests__/extraction-cli.test.ts
git commit -m "fix(extraction): fail closed on cloud_auth (no per-tenant isolated extraction path — 4th sink)"
```

---

### Task 3: Reject ambiguous bare-identifier resolves (409)

**Root cause:** `getByIdentifier` (`issues.ts:1215-1224`) filters on `identifier` alone and returns `rows[0]` with no ordering. With org-scoped prefixes, two companies in different orgs can both own `ACM-1`. Every mutating bare route re-authorizes on the resolved company via `assertCompanyAccess` (fail-closed → a true cross-tenant write is already a 403), so this is NOT a cross-tenant breach. The real risk: a dual-org member (belongs to both owning orgs) passes `assertCompanyAccess` for either, so they can PATCH/DELETE/checkout the WRONG same-named task among their OWN companies. Reject-ambiguous converts the nondeterministic wrong-task pick into a deterministic 409.

**Files:**
- Modify: `server/src/services/issues.ts` (`getByIdentifier` :1215-1224 + its doc comment :1196-1214). `conflict` is already imported at :40.
- Test: `server/src/__tests__/issue-identifier-company-scope.integration.test.ts`

- [ ] **Step 1: Convert the existing contradicting test + flip skipIf for a local run**

Read `issue-identifier-company-scope.integration.test.ts`. Its guard is `describe.skipIf(process.platform !== "linux")` (~:84) and it carries committed `initdbFlags`. To run it locally on Windows, temporarily flip the guard to `describe.skipIf(false)`. **You MUST revert this flip to EXACTLY `process.platform !== "linux"` before committing** (NOT `=== "win32"` — that would wrongly run the suite on macOS).

The file already dual-seeds `ACM-1` in two companies (different orgs), and the existing test at ~:162-168 — `"global getByIdentifier('ACM-1') still returns SOME row (deferred ambiguity…)"` — asserts it returns a row. After the Task-3 fix that call THROWS 409, so this test now directly contradicts the new behavior. **Convert it** (no new seeding needed — `ACM-1` is already dual-seeded) to assert the throw:

```ts
it("global getByIdentifier('ACM-1') throws 409 when the identifier collides across companies (reject-ambiguous)", async () => {
  if (setupError) throw new Error(String(setupError));
  await expect(svc.getByIdentifier("ACM-1")).rejects.toMatchObject({ status: 409 });
});
```

Also update the now-stale file-header comment (~:11-20) that documents the old "returns an arbitrary row / not asserting which" behavior → describe the reject-ambiguous 409 instead.

> Confirm the `conflict` error shape (`server/src/errors.ts:28`) sets `.status = 409` (it does — mirror however the file's other tests assert on thrown errors if `.status` isn't the idiom here).

- [ ] **Step 2: Run the test (with skipIf flipped) — verify it FAILS**

Run: `pnpm --filter @armyofagents/server test -- issue-identifier-company-scope`
Expected: the converted `ACM-1` case FAILS (current `getByIdentifier` returns an arbitrary row, never throws).

- [ ] **Step 3: Implement reject-ambiguous**

Replace the `getByIdentifier` body:

```ts
    getByIdentifier: async (identifier: string) => {
      const rows = await db
        .select()
        .from(issues)
        .where(eq(issues.identifier, identifier.toUpperCase()))
        .limit(2);
      if (rows.length > 1) {
        // Reject-ambiguous: the bare routes carry no company in the URL, so a
        // cross-org identifier collision (two companies both own "ACM-1") would
        // otherwise resolve to an arbitrary rows[0] and let a dual-org member
        // mutate the WRONG same-named task among their own companies. A
        // deterministic 409 is the safe resolution; company-scoped routes and
        // the task UUID are unaffected (unique (company_id, identifier) index).
        throw conflict(
          "Ambiguous task identifier — it exists in more than one company. Use a company-scoped route or the task UUID.",
        );
      }
      const row = rows[0] ?? null;
      if (!row) return null;
      const [enriched] = await withIssueLabels(db, [row]);
      return enriched;
    },
```

Update the doc comment (:1196-1214): replace the "worst case: a spurious 403/404 or the wrong task among the caller's OWN memberships" clause with a note that the resolver now REJECTS an ambiguous identifier with 409, so the wrong-task-mutation risk is closed here (not deferred to the URL-namespace redesign).

- [ ] **Step 4: Run the test — verify it PASSES; then REVERT the skipIf flip**

Run: `pnpm --filter @armyofagents/server test -- issue-identifier-company-scope`
Expected: PASS. **Then revert `skipIf(false)` back to EXACTLY `skipIf(process.platform !== "linux")`.** Verify with `git diff` that the only test-file changes are the converted test case + the updated header comment (NO lingering `skipIf(false)` edit).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/issues.ts server/src/__tests__/issue-identifier-company-scope.integration.test.ts
git commit -m "fix(issues): reject ambiguous bare-identifier resolve with 409 (close wrong-task-mutation for dual-org members)"
```

---

### Task 4: `personal_subscription` runs fail closed on routing error

**Root cause:** `handleExecutionTargetRoutingError` (`heartbeat-execution-target.ts:22-28`) rethrows only when `ctx.hasExplicitPin`. `hasExplicitPin` is computed at the heartbeat call site (`heartbeat.ts:3263`) from `environmentRuntime.executionTargetId != null` — the ENV pin only. It never consults `credentialKind`. So an UNPINNED `personal_subscription` run whose bound target is missing throws inside `chooseExecutionTargetRow` (as Decision #117 §4 mandates), but that throw is swallowed to `null` → local fallback → fail OPEN, contradicting §4 ("fails closed … never silently falls back"). Reachable only on self-hosted single-tenant (the provider resolver skips `personal_subscription` on multi_tenant), where the fallback is the founder's own host — so no cross-tenant harm — but it still violates a locked decision and is cheap to fix. `company_api_key`/`null` unpinned runs do NOT throw on the no-target case (they return `pool ?? null`), so the `.catch` only fires on a genuine throw; those keep the local fallback exactly as today. Single production call site: `heartbeat.ts`.

**Files:**
- Modify: `server/src/services/heartbeat-execution-target.ts` (:22-28)
- Modify: `server/src/services/heartbeat.ts` (:3262-3289 — the `.catch` + `handleExecutionTargetRoutingError` call)
- Test: `server/src/__tests__/heartbeat-execution-target-pin.test.ts` (the ONLY file that calls the helper — two calls at ~:13,18; `heartbeat-execution-target.test.ts` does NOT)

- [ ] **Step 1: Update existing tests + write the failing new tests**

In `heartbeat-execution-target-pin.test.ts` (imports the helper; two calls at ~:13 `{ hasExplicitPin: false }` and ~:18 `{ hasExplicitPin: true }`), the widened ctx makes `credentialKind` a REQUIRED field — leaving those calls unchanged breaks typecheck. First UPDATE both existing calls to include `credentialKind: "company_api_key"` (keep their current pass/throw expectations). Then add:

```ts
it("rethrows for an unpinned personal_subscription run (fails closed, Decision #117 §4)", () => {
  const err = new Error("no matching dedicated target");
  expect(() =>
    handleExecutionTargetRoutingError(err, { hasExplicitPin: false, credentialKind: "personal_subscription" }),
  ).toThrow(err);
});

it("returns null for an unpinned company_api_key run (local fallback unchanged)", () => {
  expect(
    handleExecutionTargetRoutingError(new Error("x"), { hasExplicitPin: false, credentialKind: "company_api_key" }),
  ).toBeNull();
});

it("returns null for an unpinned null-credential run (local fallback unchanged)", () => {
  expect(
    handleExecutionTargetRoutingError(new Error("x"), { hasExplicitPin: false, credentialKind: null }),
  ).toBeNull();
});

it("rethrows for an explicit pin regardless of credentialKind", () => {
  const err = new Error("pin unavailable");
  expect(() =>
    handleExecutionTargetRoutingError(err, { hasExplicitPin: true, credentialKind: "company_api_key" }),
  ).toThrow(err);
});
```

- [ ] **Step 2: Run the tests — verify the new personal_subscription case FAILS**

Run: `pnpm --filter @armyofagents/server test -- heartbeat-execution-target`
Expected: the `personal_subscription` rethrow case FAILS (currently returns null); the others pass once existing calls are updated to include `credentialKind`.

- [ ] **Step 3: Widen the helper**

Replace `handleExecutionTargetRoutingError`:

```ts
export function handleExecutionTargetRoutingError(
  error: unknown,
  ctx: { hasExplicitPin: boolean; credentialKind: "company_api_key" | "personal_subscription" | null },
): null {
  // Decision #117 §4: an explicit pin OR a personal_subscription run must fail
  // closed — never silently fall back to the local host (which on shared infra
  // would be a different trust domain than the credential's bound target). An
  // unpinned company_api_key / null-credential run keeps the local fallback so a
  // transient DB/routing error does not fail an otherwise-runnable run.
  if (ctx.hasExplicitPin || ctx.credentialKind === "personal_subscription") throw error;
  return null;
}
```

> Confirm the `credentialKind` union matches the type of `p4CredentialHint.credentialKind` (the value passed at the call site and to `resolveExecutionTargetForRun`). If `toExecutionTargetHint` returns a narrower/wider union, use that exact type (import it) rather than hand-writing the union, to avoid a type mismatch at the call site.

- [ ] **Step 4: Thread `credentialKind` at the heartbeat call site**

In `heartbeat.ts`, the `.catch` block (~:3262-3289):
- Change the fail-closed LOG condition so it also covers the credential-bound case: replace `const hasExplicitPin = …; if (hasExplicitPin) { logger.error(…"failing closed") } else { logger.debug(…"fell back to local") }` so the `error`-level "failing closed" branch fires when `hasExplicitPin || p4CredentialHint.credentialKind === "personal_subscription"`. Keep the existing log payload fields; you may add `credentialKind: p4CredentialHint.credentialKind` to the payload.
- Change the final call to:

```ts
      return handleExecutionTargetRoutingError(error, {
        hasExplicitPin,
        credentialKind: p4CredentialHint.credentialKind,
      });
```

- [ ] **Step 5: Run tests + typecheck — verify PASS**

Run: `pnpm --filter @armyofagents/server test -- heartbeat-execution-target`
Then: `pnpm --filter @armyofagents/server exec tsc --noEmit` (or the repo's `pnpm -r typecheck`) to confirm the call site compiles with the widened ctx.
Expected: green. The typecheck is the real gate here — if any OTHER file calls the helper (grep `handleExecutionTargetRoutingError` across `server/src`), `tsc` will flag it; update those calls too. (Verified single test caller: `heartbeat-execution-target-pin.test.ts`; single production caller: `heartbeat.ts`.)

- [ ] **Step 6: Commit**

```bash
git add server/src/services/heartbeat-execution-target.ts server/src/services/heartbeat.ts server/src/__tests__/heartbeat-execution-target-pin.test.ts
git commit -m "fix(exec): fail closed on unpinned personal_subscription routing error (Decision #117 §4)"
```

---

### Task 5: Correct the stale Decision #117 doc

**Root cause:** Two claims in Decision #117 were overtaken by later review-round fixes (migrations 0194 + 0196 + `execution_targets.ts`):
1. §117 point 1 (~:1785) states the `organization_id` FK is `ON DELETE SET NULL`. Reality: `ON DELETE CASCADE` (`execution_targets.ts:24`, migration `0196_equal_greymalkin.sql`) — SET NULL would silently promote a deleted tenant's dedicated targets into trusted shared infra.
2. §117 "Deferred" (~:1799) states worker-token rotation uses "the target's own primary key as a bearer credential, a deliberately migration-free stopgap." Reality: a rotatable SHA-256 `worker_token_hash` column (`execution_targets.ts:32-34`, added by migration **`0194_early_krista_starr.sql`** — NOT 0196) — plaintext returned once at registration; the row id is NO longer a credential; and it is NOT migration-free.

**Files:**
- Modify: `docs/architecture/decisions.md` (§117 only — do not disturb other decisions)

- [ ] **Step 1: Fix the FK claim (§117 point 1, ~:1785)**

Change `(\`ON DELETE SET NULL\`)` to `(\`ON DELETE CASCADE\`)` and append a brief reason clause after the existing sentence about system/shared targets, e.g.: "The FK is `ON DELETE CASCADE`, not `SET NULL`: `NULL organization_id` is the security-defining 'system/shared, operator-trusted' signal, so `SET NULL` would silently promote a deleted tenant's dedicated targets into trusted shared infra — cascading them away is the only safe behavior (see `packages/db/src/schema/execution_targets.ts` and migration 0196)."

- [ ] **Step 2: Fix the worker-token claim (§117 "Deferred", ~:1799)**

Replace the parenthetical "(Task 13 ships id-scoped heartbeat auth using the target's own primary key as a bearer credential, a deliberately migration-free stopgap)" with: "(Task 13 ships a rotatable per-target credential — a SHA-256 `worker_token_hash`, migration 0194; the plaintext is returned once at registration and the row id is no longer a bearer credential). The multi-worker `GvisorPoolClient` that consumes it remains deferred."

- [ ] **Step 3: Verify no other content changed**

Run: `git diff docs/architecture/decisions.md`
Expected: only the two §117 edits. No other decision touched.

- [ ] **Step 4: Commit**

```bash
git add docs/architecture/decisions.md
git commit -m "docs: correct Decision #117 (execution_targets FK CASCADE via 0196, worker_token_hash via 0194)"
```

---

### Task 6: Document the intentional hand-edited-migration exception

**Root cause:** Migrations `0189_sticky_logan.sql` and `0195_provider_org_scoped_uniqueness.sql` hand-append data backfills (`UPDATE company_secrets … / INSERT organization_memberships …`) and C14-idempotency-guarded constraint swaps (`DROP … IF EXISTS` + `DO $$ … duplicate_object`) after `db:generate`. This is correct — drizzle-kit cannot emit idempotency guards or data migrations — but it conflicts with the unqualified "Never write raw SQL migration files" rule (`AGENTS.md:87` / Decision #19) with no documented exception, so a future agent reads a rule the codebase visibly violates. The founder-approved resolution is to DOCUMENT the exception (not refactor backfills into boot reconcilers, which is out of scope for this PR). The migration files themselves already carry clear inline comments; this task adds the rule-level exception.

**Files:**
- Modify: `AGENTS.md` (:87)
- Modify: `docs/architecture/decisions.md` (Decision #19, if present — grep first)

> **Do NOT edit `CLAUDE.md`.** It is user-owned governance. The exception is documented in the agent-facing dev docs (AGENTS.md + Decision #19); the user will decide separately whether to mirror it into CLAUDE.md.

- [ ] **Step 1: Add the exception clause to `AGENTS.md:87`**

Append to the Drizzle rule so it reads (adjust to match the exact surrounding sentence):

"6. **Drizzle ORM only.** Schema changes go in `packages/db/src/schema/`. Run `pnpm db:generate`. Never hand-author schema DDL — the CREATE/ALTER statements always come from `db:generate` (no-drift enforced). **Narrow exception:** drizzle-kit cannot emit (a) idempotency guards (`IF NOT EXISTS` / `DO $$ … duplicate_object`, per C14) or (b) data-only backfills. A small number of migrations hand-APPEND these after generation (e.g. `0189`, `0195`) — always with an inline comment and always idempotent (`WHERE … IS NULL` / `ON CONFLICT DO NOTHING`). This exception covers ONLY idempotency guards and data backfills; schema DDL is never hand-written. (Decision #19)"

- [ ] **Step 2: Mirror the exception into Decision #19 (if present)**

Run: `grep -n "Decision #19" docs/architecture/decisions.md`
If Decision #19 exists there, add one sentence documenting the same narrow exception (idempotency guards + data backfills may be hand-appended post-generation; schema DDL never). If it does not exist as a numbered section, skip this step (AGENTS.md carries it).

- [ ] **Step 3: Verify**

Run: `git diff AGENTS.md docs/architecture/decisions.md`
Expected: the AGENTS.md rule clause + (optionally) one Decision #19 sentence. No unrelated edits. Confirm `CLAUDE.md` is NOT in the diff.

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md docs/architecture/decisions.md
git commit -m "docs: document the narrow hand-appended-migration exception (idempotency guards + backfills)"
```

---

## Post-batch verification (controller runs after all tasks)

- [ ] Full server unit suite: `pnpm --filter @armyofagents/server test`
- [ ] Full ui unit suite: `pnpm --filter @armyofagents/ui test`
- [ ] Repo typecheck: `pnpm -r typecheck`
- [ ] Lint: `pnpm -r lint` (or the repo's lint entry)
- [ ] Brand-check: `pnpm brand-check` (guards undocumented `AOA_*` — none added here)
- [ ] db no-drift: `pnpm db:generate` then `git status` shows no new migration (no schema change in this batch)
- [ ] Confirm `git diff` on `live-events-ws.ts` is byte-correct (binary file — read it directly, do not trust the opaque diff)
- [ ] Confirm `issue-identifier-company-scope.integration.test.ts` `skipIf` is back to EXACTLY `process.platform !== "linux"` (NOT `=== "win32"`)
- [ ] Final holistic cross-cutting review (dispatch code-reviewer over the whole batch diff)

## Out of scope (follow-up branch — do NOT touch here)

- Real gVisor / agent→org-threading initiative (the deferred P4/P5 org runtime).
- Moving migration backfills into boot reconcilers (the strict alternative to Task 6's documented exception).
- URL-namespace multi-org UX; assignment↔connection DB constraint.
