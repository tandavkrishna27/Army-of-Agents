# Connectors — Codex Round-2 Hardening Plan (revised after Codex plan review)

> **For agentic workers:** implement task-by-task; each task ends green + committed.

**Goal:** Resolve the `package.json` conflict and land the fixes that can be done *correctly and completely* now (Task 2 auth-templates, Task 4 shelf hygiene). Defer the two architecture-level security items (Task 1 per-child token isolation, Task 3 package-identity command authorization) to a dedicated **connector-security-hardening PR** — Codex's plan review proved the quick versions are wrong or bypassable.

**Codex plan review verdict:** GATE FAIL (9 P1). Key refutations captured below. Full review in the GSTACK REVIEW REPORT at the bottom.

---

## Task 0: Resolve the `package.json` conflict (merge new main)

**Why:** PR #300 (`e0029c7e0`) merged; single-file `package.json` scripts collision. Merging re-enables CI (a DIRTY PR won't run).

- [ ] `git merge origin/main --no-commit` (expect ONLY `package.json`).
- [ ] Resolve: union the `scripts` block — keep main's #300 scripts AND our `fetch-connectors` + `prebuild`.
- [ ] `pnpm install` (lockfile refresh).
- [ ] `git add package.json pnpm-lock.yaml && git commit` — "Merge origin/main (#300)".

---

## Task 2 (CORRECTED): wire catalog auth templates — Bearer-aware, credentialed-only

**Finding (P1):** `entryToCreateInput` sets header/env template keys to `""`; a custom header (`X-Api-Key`) or stdio env key installs "active" but runs unauthenticated.

**Codex corrections that reshape the fix:**
1. **Do NOT touch an `Authorization` header key.** Setting it to a raw `${TOKEN}` defeats `withSynthesizedBearerHeader` (mcp-server-spec.ts:213), which today correctly synthesizes `Bearer <token>` from an empty/absent Authorization. Only populate **non-`Authorization`** header keys + **env** keys.
2. **Only credentialed entries.** A secretless entry (`requiresSecret:false` with template keys — real in the e2e fixture) must NOT get an unresolved placeholder. Populate only when `entry.requiresSecret === true`.
3. **D5 test framing.** `buildConnectorSpecs` passes an already-expanded `${AOA_MCP_*_TOKEN}` through unchanged (mcp-connectors.ts:263) — mechanically fine (writers/CLIs consume the placeholder; the real value stays in the separate env map). Assert **"placeholder in spec, plaintext ONLY in the returned env map"**, never "the header carries the token."

**Files:**
- Modify: `server/src/routes/mcp-connectors.ts` (`entryToCreateInput`).
- Test: `server/src/__tests__/mcp-connector-install-route.test.ts`.

- [ ] **Step 0:** confirm `withSynthesizedBearerHeader` behavior (adds `Bearer` only when Authorization absent/empty) + `buildConnectorSpecs` passes placeholders through. Record.
- [ ] **Step 1 — failing tests:**
  - http entry, `requiresSecret:true`, `headerTemplateKeys:["X-Api-Key"]` → built spec header `X-Api-Key` resolves to the token; the env map holds the plaintext, the spec holds the placeholder (D5).
  - http entry, `headerTemplateKeys:["Authorization"]` → UNCHANGED (Bearer synth still fires; no double-`Bearer`).
  - stdio entry, `requiresSecret:true`, `envTemplateKeys:["ACME_TOKEN"]` → env spec key resolves to the token; D5 holds.
  - secretless entry (`requiresSecret:false`) with template keys → values stay empty (no placeholder).
- [ ] **Step 2:** run → fail.
- [ ] **Step 3 — implement:** placeholder = `"${" + envVarNameFor(entry.serverName) + "}"`.
```ts
const placeholder = entry.requiresSecret ? "${" + envVarNameFor(entry.serverName) + "}" : "";
const headerTemplate: Record<string, string> = {};
for (const key of entry.headerTemplateKeys) {
  headerTemplate[key] = key.toLowerCase() === "authorization" ? "" : placeholder; // Bearer synth owns Authorization
}
const envTemplate: Record<string, string> = {};
for (const key of entry.envTemplateKeys) envTemplate[key] = placeholder;
```
- [ ] **Step 4:** run → pass; confirm the D5 no-plaintext-on-disk test still passes.
- [ ] **Step 5:** commit.

---

## Task 4 (CORRECTED): drop reserved server names at the parser — no dep cycle

**Finding (P2):** shelf still shows a reserved-name entry (my install-chokepoint guard blocks install but not display). **Parser placement is shelf hygiene only — the install/create + delivery guards remain the security boundary.**

**Codex correction:** my drift-test is infeasible — `adapter-utils` already depends on `shared`, so `shared`→`adapter-utils` is a **workspace cycle**. Fix the dependency direction instead: **move the canonical `RESERVED_MCP_SERVER_NAMES` into `shared`**, and have `adapter-utils` **re-export** it. Then the parser imports it locally, no cycle.

**Files:**
- Move constant: define `RESERVED_MCP_SERVER_NAMES` in `packages/shared/src/` (e.g. a new `mcp-reserved.ts` or existing connector-catalog module); `packages/adapter-utils/src/mcp-server-spec.ts` re-exports it (`export { RESERVED_MCP_SERVER_NAMES } from "@armyofagents/shared"`).
- Modify: `packages/shared/src/mcp-connector-catalog.ts` — drop reserved-name entries in the parse loop (record in `dropped`, `malformed:false`).
- Verify importers still resolve: `server/src/services/mcp-connectors.ts`, `server/src/routes/mcp-connectors.ts`, `server/src/services/mcp-connector-create.ts`, adapter-utils consumers.
- Test: `packages/shared/src/__tests__/` catalog-parse reserved-drop test (no drift test needed — single source of truth now).

- [ ] **Step 1 — failing test:** catalog with `serverName:"aoa"` → dropped, not in `entries`, `malformed:false`.
- [ ] **Step 2:** run → fail.
- [ ] **Step 3 — implement:** move constant to shared + re-export from adapter-utils; add the loop guard:
```ts
if ((RESERVED_MCP_SERVER_NAMES as readonly string[]).includes(parsed.data.serverName)) { dropped.push(parsed.data.id); continue; }
```
- [ ] **Step 4:** `pnpm build` (whole workspace — proves no cycle + all importers resolve) + run test → pass.
- [ ] **Step 5:** commit.

---

## DEFERRED to the connector-security-hardening PR (do NOT attempt here)

### Deferred-1: run-scoped agent token reaches connector children (was Task 1)
Codex refutation: local targets **ignore** the `authToken` param (only `opts.env` reaches the child, execution-target.ts:128); agents **do** use `AOA_API_KEY` for REST (`AGENTS.md:37`); `codex_local` has the same leak (execute.ts:311); and a configured `config.env.AOA_API_KEY` leaks regardless because `mergeChildEnv` preserves overlay keys. **One shared process env cannot both grant the CLI REST creds and withhold them from the children it spawns.** Correct fix is a product/behavior decision — *"a connector-attached run is MCP-only (no REST token)"* — or a real per-child isolation mechanism. Needs founder sign-off on the capability tradeoff. Round-1's ambient-secret scrub already stands; this is the additional run-token vector.

### Deferred-2: package-identity command authorization for stdio installs (was Task 3)
Codex refutation: launcher-name allowlist + `@version` is bypassable (`npx evil@1.0.0`, `npx --package/--call`, `uvx --from/--with`, `node -e`); pinning ≠ publisher authorization; only catalog install validated (BYO `local_trusted` + stored rows bypass "regardless of mode"); and Decision #116's audit-per-spawn is unaddressed (the CLI spawns the child, not AoA). Correct fix: a **package-identity/integrity allowlist + closed per-launcher argv grammar + enforcement at the shared create chokepoint + delivery revalidation (fail closed) + a spawn-audit decision.** Security-design mini-project.

---

## Task 5: verify + push + respond (for the "now" scope only)

- [ ] `pnpm build` (type-clean).
- [ ] Suites: server (connector/create/install-route), shared (catalog parse). Green.
- [ ] Connector integration (real PG) + e2e (`AOA_E2E_FORCE_WINDOWS=1`) still pass. Revert skipIf after.
- [ ] `git push`.
- [ ] PR comment: F1✅/F3✅ (round 1), Task 2✅/Task 4✅ (this round), and **explicitly document Deferred-1 + Deferred-2 as known, tracked security follow-ups** (do not let them read as fixed). File the follow-up.
- [ ] `@codex review`; watch CI.

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Codex Review | `/codex review` | Independent 2nd opinion (plan) | 1 | issues_found | 9 P1 + 2 P2; plan revised |

- **CODEX:** refuted the quick Task 1 (breaks REST auth; masked by local_trusted fallback) and Task 3 (bypassable allowlist) — both re-scoped to a dedicated security PR. Corrected Task 2 (Bearer-aware, credentialed-only, D5 assertion) and Task 4 (dependency-cycle fix: move constant to shared). Task 2 + Task 4 land in this PR.
- **VERDICT:** plan revised to split — Task 2 + Task 4 CLEARED for this PR; Deferred-1 + Deferred-2 require design/founder sign-off in a follow-up.
