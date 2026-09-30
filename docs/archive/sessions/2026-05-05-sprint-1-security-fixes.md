# Sprint 1 Security Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close 9 active-exploit security findings (cross-tenant IDOR, RCE, XSS, supply-chain) via 7 PRs landing in a defined order on `main`.

**Architecture:** Each PR is a self-contained fix grounded in concrete file:line edits from the validated 2026-05-05 review. PRs share helpers where it makes sense (e.g., `assertCanManageInstanceSettings` is lifted in PR 4 and consumed by `instance-settings.ts` + `feedback.ts` + `adapters.ts` + `filesystem.ts`). All 7 PRs are independently revertable; no DB migrations, no schema changes, no breaking API surface.

**Tech Stack:** Express 5.x, Drizzle ORM (test mocks via `helpers/drizzle-mock.ts`), Vitest, supertest for route tests, Zod validators, isomorphic-dompurify (new), helmet (new), GitHub Actions, Changesets.

**Spec:** `docs/superpowers/specs/2026-05-05-sprint-1-security-fixes-design.md`

---

## File Structure

**Files modified across all PRs:**

| Path | PR | Purpose |
|---|---|---|
| `.github/workflows/release.yml` | 6a | SHA-pin third-party actions, especially `changesets/action` |
| `.github/workflows/docker.yml` | 6a | SHA-pin all 4 `docker/*` actions |
| `.github/workflows/pr.yml` | 6a, 6b | SHA pins + permissions block (6a) + grep-guard job (6b) |
| `.github/workflows/release-smoke.yml` | 6a | SHA pins + permissions block |
| `.github/workflows/refresh-lockfile.yml` | 6a | SHA pins |
| `.github/dependabot.yml` | 6a | New file — weekly Action updates |
| `packages/shared/src/marketplace.ts` | 6a | Default `pluginUpdatePolicy: "notify_all"` |
| `packages/shared/src/validators/project.ts` | 1 | Tighten `executionWorkspacePolicy` |
| `server/src/routes/projects.ts` | 1 | Role gate on PATCH/POST + audit log helper |
| `server/src/services/workspace-runtime.ts` | 1 | Audit log when running workspace command |
| `packages/shared/src/validators/approval.ts` | 2 | Strip `decidedByUserId`, add `.strict()` |
| `server/src/routes/approvals.ts` | 2 | Load + assertCompanyAccess + actor.userId |
| `cli/src/commands/client/approval.ts` | 2 | Remove `--decided-by-user-id` flag |
| `server/src/services/agents.ts` | 3 | New `getKeyById` method |
| `server/src/routes/agents.ts` | 3 | Load + assertCompanyAccess on 3 key handlers |
| `server/src/routes/authz.ts` | 4 | Add `assertCanManageInstanceSettings` export |
| `server/src/routes/instance-settings.ts` | 4 | Replace local copy with import |
| `server/src/routes/feedback.ts` | 4 | Replace local copy with import |
| `server/src/routes/filesystem.ts` | 4 | Add gate to all 5 handlers + bound `reveal` |
| `server/src/routes/adapters.ts` | 4 | Replace 9 `assertBoard(req);` calls |
| `server/src/routes/memory-asset-render.ts` | 5 | DOMPurify sanitization |
| `server/src/app.ts` | 5 | Mount helmet-light |
| `server/package.json` | 5 | Add `helmet`, `isomorphic-dompurify` |
| `scripts/check-assertboard-pairing.mjs` | 6b | New — assertBoard pairing checker |

**Files created (tests):**

| Path | PR |
|---|---|
| `server/src/__tests__/sniffs-shell-command-fields.test.ts` | 1 |
| `server/src/__tests__/projects-routes-rce.test.ts` | 1 |
| `packages/shared/src/validators/__tests__/approval.test.ts` | 2 |
| `server/src/__tests__/approvals-routes-cross-tenant.test.ts` | 2 |
| `server/src/__tests__/agents-keys-routes.test.ts` | 3 |
| `server/src/__tests__/filesystem-routes.test.ts` | 4 |
| `server/src/__tests__/adapters-routes-instance-admin.test.ts` | 4 |
| `server/src/__tests__/memory-asset-render-xss.test.ts` | 5 |
| `server/src/__tests__/__fixtures__/docx-with-javascript-href.docx` | 5 (binary fixture) |
| `server/src/__tests__/app-security-headers.test.ts` | 5 |
| `scripts/__tests__/check-assertboard-pairing.test.mjs` | 6b |

---

## Common Patterns

These are referenced by tasks below — read once, apply throughout.

### Pattern A: Route test scaffolding

```ts
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

vi.mock("../services/index.js", () => ({
  // mock only the services this route uses
  someService: () => ({ method: vi.fn() }),
  logActivity: vi.fn(),
}));

function makeApp(actor: any, mountFn: (app: express.Express) => void) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).actor = actor; next(); });
  mountFn(app);
  return app;
}

const founderActor = {
  type: "board",
  source: "session",
  userId: "user-founder",
  companyIds: ["company-A"],
  isInstanceAdmin: false,
};
const teamMemberActor = { ...founderActor, userId: "user-tm" };
const localImplicitActor = { ...founderActor, source: "local_implicit" };
const instanceAdminActor = { ...founderActor, isInstanceAdmin: true };
const foreignActor = { ...founderActor, userId: "user-other", companyIds: ["company-B"] };
const agentActor = {
  type: "agent",
  agentId: "agent-1",
  companyId: "company-A",
  source: "agent_key",
};
```

### Pattern B: Mocking permissions service for `assertRole`

`assertRole` calls `permissionService(db).getEffectiveRole(companyId, userId)`. To control the returned role:

```ts
vi.mock("../services/permissions.js", () => ({
  permissionService: () => ({
    getEffectiveRole: vi.fn().mockResolvedValue("team_member"), // or "founder", "team_lead"
    isFounder: vi.fn().mockResolvedValue(false),
    isTeamLeadForDepartment: vi.fn().mockResolvedValue(false),
  }),
}));
```

### Pattern C: TDD step quintet

Each task ending in code change uses the same 5-step shape:
1. Write the failing test
2. Run to verify FAIL
3. Implement minimal code
4. Run to verify PASS
5. Commit

Test command: `pnpm -F @armyofagents/server test <test-file-name>` (replace package filter for shared/cli)

### Pattern D: Changeset

For every PR, the final task creates `.changeset/<slug>.md`:
```markdown
---
"@armyofagents/server": patch
---

<one-sentence summary>. Closes <finding-IDs>.
```

---

## PR 6a — Supply chain hardening

**Branch:** `fix/security-supply-chain`
**Findings:** C16 (Actions SHA pinning), C11 step 1 (`notify_all` default).
**Why first:** Zero runtime impact, closes the moving-tag mass-exploit vector and the auto-update mass-exploit vector immediately.

### Task 6a.1: Resolve SHA pins for third-party actions

**Files:** none modified yet — this is a reconnaissance task that produces a SHA list for subsequent tasks.

- [ ] **Step 1: Identify all third-party `uses:` in workflows**

Run:
```bash
grep -rEn 'uses:\s+[^a]' .github/workflows/ | grep -v 'actions/' | sort -u
```
Expected: lines including `changesets/action@v1`, `docker/login-action@v3`, `docker/setup-buildx-action@v3`, `docker/metadata-action@v5`, `docker/build-push-action@v6`, `pnpm/action-setup@v4`.

- [ ] **Step 2: Resolve each tag to its commit SHA via gh CLI**

For each action, run (substituting owner/repo and tag):
```bash
gh api repos/changesets/action/git/refs/tags/v1.4.10 --jq '.object.sha'
gh api repos/docker/login-action/git/refs/tags/v3.4.0 --jq '.object.sha'
gh api repos/docker/setup-buildx-action/git/refs/tags/v3.10.0 --jq '.object.sha'
gh api repos/docker/metadata-action/git/refs/tags/v5.7.0 --jq '.object.sha'
gh api repos/docker/build-push-action/git/refs/tags/v6.18.0 --jq '.object.sha'
gh api repos/pnpm/action-setup/git/refs/tags/v4.1.0 --jq '.object.sha'
gh api repos/actions/checkout/git/refs/tags/v4.2.2 --jq '.object.sha'
gh api repos/actions/setup-node/git/refs/tags/v4.4.0 --jq '.object.sha'
gh api repos/actions/upload-artifact/git/refs/tags/v4.6.2 --jq '.object.sha'
```

If a specific minor version is currently in use, query that tag (the `v1`/`v3` style is shorthand — `gh api .../v1` returns the latest matching `v1.x.y` tag's SHA).

- [ ] **Step 3: Record the SHA → tag mapping**

Save the result locally to a scratch file (not committed). Tasks 6a.2–6a.5 will use this mapping.

### Task 6a.2: SHA-pin `release.yml`

**Files:**
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: Replace each `uses:` with SHA + version comment**

For every line like `uses: changesets/action@v1`, change to:
```yaml
uses: changesets/action@<40-char-sha> # v1.4.10
```

The five third-party + four `actions/*` references in `release.yml` to update:
- `actions/checkout@v4` (line 47)
- `pnpm/action-setup@v4` (line 53)
- `actions/setup-node@v4` (line 58)
- `changesets/action@v1` (line 75) — **highest priority**

- [ ] **Step 2: Verify file is well-formed YAML**

Run: `yq '.jobs' .github/workflows/release.yml > /dev/null`
Expected: exit code 0, no parse errors.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci(release): SHA-pin all uses: references (closes part of C16)"
```

### Task 6a.3: SHA-pin `docker.yml`

**Files:**
- Modify: `.github/workflows/docker.yml`

- [ ] **Step 1: Replace 5 `uses:` references with SHA + version comment**

References to update (per grep against `main`):
- `actions/checkout@v4` (line 26)
- `docker/login-action@v3` (line 29)
- `docker/setup-buildx-action@v3` (line 35)
- `docker/metadata-action@v5` (line 40)
- `docker/build-push-action@v6` (line 50)

- [ ] **Step 2: Verify YAML**

Run: `yq '.jobs' .github/workflows/docker.yml > /dev/null`
Expected: exit code 0.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/docker.yml
git commit -m "ci(docker): SHA-pin docker/* and actions/checkout (closes part of C16)"
```

### Task 6a.4: SHA-pin remaining workflows

**Files:**
- Modify: `.github/workflows/pr.yml`, `release-smoke.yml`, `refresh-lockfile.yml`

- [ ] **Step 1: Replace `uses:` references in `pr.yml`**

Replace all `actions/checkout@v4`, `actions/setup-node@v4`, `actions/upload-artifact@v4`, `pnpm/action-setup@v4` with SHA-pinned versions. There are ~12 references; grep first:
```bash
grep -n 'uses:' .github/workflows/pr.yml
```

- [ ] **Step 2: Replace in `release-smoke.yml` and `refresh-lockfile.yml`**

Same approach for the smaller files.

- [ ] **Step 3: Verify all three files are well-formed**

```bash
for f in .github/workflows/pr.yml .github/workflows/release-smoke.yml .github/workflows/refresh-lockfile.yml; do
  yq '.jobs' "$f" > /dev/null || echo "FAIL: $f"
done
```
Expected: no FAIL output.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/pr.yml .github/workflows/release-smoke.yml .github/workflows/refresh-lockfile.yml
git commit -m "ci: SHA-pin actions/* and pnpm/* across all workflows (closes part of C16)"
```

### Task 6a.5: Add `permissions: { contents: read }` blocks

**Files:**
- Modify: `.github/workflows/pr.yml`, `release-smoke.yml`

- [ ] **Step 1: Add to top of `pr.yml`**

After the `name:` line, add:
```yaml
permissions:
  contents: read
```

- [ ] **Step 2: Add to top of `release-smoke.yml`**

Same pattern.

- [ ] **Step 3: Verify YAML**

Run: `yq '.permissions' .github/workflows/pr.yml`
Expected: `contents: read`

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/pr.yml .github/workflows/release-smoke.yml
git commit -m "ci: explicit permissions: contents: read on pr.yml + release-smoke.yml (closes part of C16)"
```

### Task 6a.6: Add `dependabot.yml`

**Files:**
- Create: `.github/dependabot.yml`

- [ ] **Step 1: Create the file**

```yaml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: "/"
    schedule:
      interval: weekly
    open-pull-requests-limit: 5
```

- [ ] **Step 2: Verify YAML**

Run: `yq '.updates' .github/dependabot.yml`
Expected: array with one entry.

- [ ] **Step 3: Commit**

```bash
git add .github/dependabot.yml
git commit -m "ci: add dependabot for github-actions weekly updates (closes part of C16)"
```

### Task 6a.7: Change marketplace `pluginUpdatePolicy` default

**Files:**
- Modify: `packages/shared/src/marketplace.ts:152`

- [ ] **Step 1: Find the default**

Run: `grep -n 'pluginUpdatePolicy' packages/shared/src/marketplace.ts`
Expected: line containing `pluginUpdatePolicy: "auto_minor"`.

- [ ] **Step 2: Change to `notify_all`**

Edit line 152:
```ts
// before
pluginUpdatePolicy: "auto_minor",
// after
pluginUpdatePolicy: "notify_all",
```

- [ ] **Step 3: Run shared package tests**

Run: `pnpm -F @armyofagents/shared test`
Expected: PASS — if any test pinned `auto_minor` as the default, update the test to expect `notify_all` and reflect the new behavior.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/marketplace.ts
git commit -m "feat(marketplace): default pluginUpdatePolicy to notify_all (closes C11 step 1)"
```

### Task 6a.8: Final changeset and PR open

**Files:**
- Create: `.changeset/security-supply-chain-hardening.md`

- [ ] **Step 1: Write the changeset**

```markdown
---
"@armyofagents/server": patch
"@armyofagents/shared": patch
---

ci: SHA-pin all GitHub Actions, add Dependabot for weekly updates, add `permissions: contents: read` to pr.yml and release-smoke.yml. Closes the moving-tag supply-chain attack vector (C16). Marketplace `pluginUpdatePolicy` now defaults to `notify_all` to close the auto-update mass-exploit vector pending full integrity verification (C11 step 1).
```

- [ ] **Step 2: Run smoke check on workflows**

Run: `pnpm verify`
Expected: PASS (this won't exercise the workflow files, but ensures nothing else broke).

- [ ] **Step 3: Commit, push, open PR**

```bash
git add .changeset/security-supply-chain-hardening.md
git commit -m "chore: changeset for security supply-chain hardening"
git push -u origin fix/security-supply-chain
gh pr create --title "fix(security): supply chain hardening (C16 + C11 step 1)" --body "..."
```

---

## PR 1 — RCE projects

**Branch:** `fix/security-rce-projects`
**Finding:** C1 — RCE via `executionWorkspacePolicy.provisionCommand`.

### Task 1.1: Add `sniffsShellCommandFields` helper with TDD

**Files:**
- Create: `server/src/__tests__/sniffs-shell-command-fields.test.ts`
- Modify: `server/src/routes/projects.ts` (add helper at top of file, after imports)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { sniffsShellCommandFields } from "../routes/projects.js";

describe("sniffsShellCommandFields", () => {
  it("returns false for null", () => {
    expect(sniffsShellCommandFields(null)).toBe(false);
  });
  it("returns false for undefined", () => {
    expect(sniffsShellCommandFields(undefined)).toBe(false);
  });
  it("returns false for empty object", () => {
    expect(sniffsShellCommandFields({})).toBe(false);
  });
  it("returns false for object without workspaceStrategy", () => {
    expect(sniffsShellCommandFields({ defaultMode: "shared_workspace" })).toBe(false);
  });
  it("returns true when provisionCommand is set", () => {
    expect(sniffsShellCommandFields({
      workspaceStrategy: { type: "git_worktree", provisionCommand: "echo ok" },
    })).toBe(true);
  });
  it("returns true when teardownCommand is set", () => {
    expect(sniffsShellCommandFields({
      workspaceStrategy: { teardownCommand: "rm -rf .cache" },
    })).toBe(true);
  });
  it("returns true when cleanupCommand is set", () => {
    expect(sniffsShellCommandFields({
      workspaceStrategy: { cleanupCommand: "git clean -fd" },
    })).toBe(true);
  });
});
```

- [ ] **Step 2: Run test, verify FAIL**

Run: `pnpm -F @armyofagents/server test sniffs-shell-command-fields`
Expected: FAIL with "sniffsShellCommandFields is not a function" or "is not exported".

- [ ] **Step 3: Add the helper to `routes/projects.ts`**

Near the top of `server/src/routes/projects.ts`, after imports:

```ts
export function sniffsShellCommandFields(policy: unknown): boolean {
  if (!policy || typeof policy !== "object") return false;
  const p = policy as Record<string, unknown>;
  const ws = (p.workspaceStrategy ?? {}) as Record<string, unknown>;
  return typeof ws.provisionCommand === "string"
      || typeof ws.teardownCommand === "string"
      || typeof ws.cleanupCommand === "string";
}
```

- [ ] **Step 4: Run test, verify PASS**

Run: `pnpm -F @armyofagents/server test sniffs-shell-command-fields`
Expected: PASS, all 7 tests green.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/projects.ts server/src/__tests__/sniffs-shell-command-fields.test.ts
git commit -m "feat(routes): add sniffsShellCommandFields helper for project workspace policy"
```

### Task 1.2: Tighten `executionWorkspacePolicy` validator

**Files:**
- Modify: `packages/shared/src/validators/project.ts:49`

- [ ] **Step 1: Read the current type definition**

Run: `cat packages/shared/src/types/execution-workspace.ts`
Note the shape of `ProjectExecutionWorkspacePolicy`.

- [ ] **Step 2: Replace the loose validator field with a strict Zod schema**

In `packages/shared/src/validators/project.ts`, replace `executionWorkspacePolicy: z.record(z.unknown()).nullable().optional()` with a discriminated structure that mirrors the type. Example shape (adapt to real type):

```ts
const workspaceStrategySchema = z.object({
  type: z.enum(["git_worktree", "shared", "ephemeral"]).optional(),
  baseRef: z.string().optional(),
  provisionCommand: z.string().optional(),
  teardownCommand: z.string().optional(),
  cleanupCommand: z.string().optional(),
  workspaceRuntime: z.record(z.unknown()).optional(),
  ttlDays: z.number().int().positive().optional(),
}).strict();

const executionWorkspacePolicySchema = z.object({
  enabled: z.boolean().optional(),
  defaultMode: z.enum(["per_task", "shared", "none", "shared_workspace", "isolated_workspace"]).optional(),
  workspaceStrategy: workspaceStrategySchema.optional(),
  branchPolicy: z.record(z.unknown()).optional(),
  runtimePolicy: z.record(z.unknown()).optional(),
  cleanupPolicy: z.record(z.unknown()).optional(),
}).strict();

// In updateProjectSchema and createProjectSchema:
executionWorkspacePolicy: executionWorkspacePolicySchema.nullable().optional(),
```

Use `.strict()` so unknown fields are rejected.

- [ ] **Step 3: Run shared validator tests**

Run: `pnpm -F @armyofagents/shared test`
Expected: PASS. If existing tests fail because they used a permissive shape, update them to match the new strict schema.

- [ ] **Step 4: Run server tests to catch consumers**

Run: `pnpm -F @armyofagents/server test`
Expected: PASS. If route tests fail because they passed previously-permissive `executionWorkspacePolicy` blobs, fix them.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/validators/project.ts
git commit -m "fix(validators): strict schema for executionWorkspacePolicy (closes part of C1)"
```

### Task 1.3: Apply role gate on PATCH `/projects/:id`

**Files:**
- Modify: `server/src/routes/projects.ts:143-178`

- [ ] **Step 1: Add imports if needed**

At the top of `server/src/routes/projects.ts`, ensure these imports exist:
```ts
import { assertRole } from "../middleware/rbac.js";
```
(`assertCompanyAccess` is already imported.)

- [ ] **Step 2: Insert the role gate after `assertCompanyAccess`**

Before line 152 (`const project = await svc.update(id, req.body);`), add:

```ts
if (sniffsShellCommandFields(req.body.executionWorkspacePolicy)) {
  if (req.actor.type === "agent" || req.actor.type === "mcp") {
    res.status(403).json({ error: "Agents and MCP keys cannot configure workspace commands" });
    return;
  }
  await assertRole(db, req, existing.companyId, "founder");
}
```

- [ ] **Step 3: Apply the same gate to POST `/projects` (around line 84)**

After the existing `assertCompanyAccess` (or equivalent) in the POST handler, add the same conditional block referencing `req.body.executionWorkspacePolicy`.

- [ ] **Step 4: Type-check**

Run: `pnpm -F @armyofagents/server typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/projects.ts
git commit -m "fix(routes): require founder role for shell-command edits on projects (C1)"
```

### Task 1.4: Add audit log when running workspace commands

**Files:**
- Modify: `server/src/services/workspace-runtime.ts:452-473` (`runWorkspaceCommand`)

- [ ] **Step 1: Locate `runWorkspaceCommand`**

Run: `grep -n 'function runWorkspaceCommand\|export.*runWorkspaceCommand' server/src/services/workspace-runtime.ts`

- [ ] **Step 2: Add structured warn log at the top of the function body**

Before the `executeProcess` call, add:
```ts
logger.warn(
  {
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    commandKind: input.kind, // or whatever field labels which command (provision/teardown/cleanup)
    command: input.command,
  },
  "Running workspace shell command",
);
```
(Adapt field names to whatever the function actually receives.)

- [ ] **Step 3: Type-check**

Run: `pnpm -F @armyofagents/server typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add server/src/services/workspace-runtime.ts
git commit -m "feat(workspace-runtime): audit log shell command execution (defense for C1)"
```

### Task 1.5: Route tests for the role gate

**Files:**
- Create: `server/src/__tests__/projects-routes-rce.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

vi.mock("../services/index.js", () => ({
  projectsService: () => ({
    getById: vi.fn().mockResolvedValue({ id: "p1", companyId: "company-A", name: "P" }),
    update: vi.fn().mockResolvedValue({ id: "p1", companyId: "company-A", name: "P" }),
    create: vi.fn(),
  }),
  instanceSettingsService: () => ({
    getExperimental: vi.fn().mockResolvedValue({ enableIsolatedWorkspaces: true }),
  }),
  logActivity: vi.fn(),
}));

const teamMemberRole = vi.fn().mockResolvedValue("team_member");
const teamLeadRole = vi.fn().mockResolvedValue("team_lead");
const founderRole = vi.fn().mockResolvedValue("founder");

vi.mock("../services/permissions.js", () => ({
  permissionService: () => ({
    getEffectiveRole: vi.fn().mockImplementation(async (_c, userId: string) => {
      if (userId === "user-fnd") return "founder";
      if (userId === "user-lead") return "team_lead";
      return "team_member";
    }),
    isFounder: vi.fn().mockResolvedValue(false),
    isTeamLeadForDepartment: vi.fn().mockResolvedValue(false),
  }),
}));

import { projectRoutes } from "../routes/projects.js";

function makeApp(actor: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).actor = actor; next(); });
  app.use("/api", projectRoutes({} as any));
  return app;
}

const baseActor = (userId: string) => ({
  type: "board",
  source: "session",
  userId,
  companyIds: ["company-A"],
  isInstanceAdmin: false,
});

describe("PATCH /projects/:id with provisionCommand", () => {
  const policyWithCmd = {
    workspaceStrategy: { type: "git_worktree", provisionCommand: "id > /tmp/pwn" },
  };

  it("403 for team_member", async () => {
    const app = makeApp(baseActor("user-tm"));
    const res = await request(app)
      .patch("/api/projects/p1")
      .send({ executionWorkspacePolicy: policyWithCmd });
    expect(res.status).toBe(403);
  });

  it("403 for team_lead", async () => {
    const app = makeApp(baseActor("user-lead"));
    const res = await request(app)
      .patch("/api/projects/p1")
      .send({ executionWorkspacePolicy: policyWithCmd });
    expect(res.status).toBe(403);
  });

  it("200 for founder", async () => {
    const app = makeApp(baseActor("user-fnd"));
    const res = await request(app)
      .patch("/api/projects/p1")
      .send({ executionWorkspacePolicy: policyWithCmd });
    expect(res.status).toBe(200);
  });

  it("403 for agent actor", async () => {
    const app = makeApp({ type: "agent", agentId: "a1", companyId: "company-A", source: "agent_key" });
    const res = await request(app)
      .patch("/api/projects/p1")
      .send({ executionWorkspacePolicy: policyWithCmd });
    expect(res.status).toBe(403);
  });

  it("200 for team_lead WITHOUT provisionCommand (regression guard)", async () => {
    const app = makeApp(baseActor("user-lead"));
    const res = await request(app)
      .patch("/api/projects/p1")
      .send({ name: "renamed" });
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run test, verify all 5 PASS**

Run: `pnpm -F @armyofagents/server test projects-routes-rce`
Expected: all PASS. If any fail, debug — the gate logic is at fault.

- [ ] **Step 3: Commit**

```bash
git add server/src/__tests__/projects-routes-rce.test.ts
git commit -m "test(projects): RCE gate route tests for executionWorkspacePolicy (C1)"
```

### Task 1.6: Final changeset and PR open

- [ ] **Step 1: Write the changeset**

Create `.changeset/security-rce-provision-command.md`:
```markdown
---
"@armyofagents/server": patch
"@armyofagents/shared": patch
---

fix(security): require founder role to set workspace shell commands (provision/teardown/cleanup) on projects, and reject agent/MCP actors entirely. Validator tightened to a strict Zod schema. Closes C1 (RCE via executionWorkspacePolicy.provisionCommand).
```

- [ ] **Step 2: Final verify**

Run: `pnpm verify`
Expected: PASS.

- [ ] **Step 3: Smoke test the negative path locally**

Start the server. Acquire a `team_member` token. Run:
```bash
curl -X PATCH http://localhost:3232/api/projects/<id> \
  -H "Authorization: Bearer <team_member_token>" \
  -H "Content-Type: application/json" \
  -d '{"executionWorkspacePolicy":{"workspaceStrategy":{"provisionCommand":"id > /tmp/pwn"}}}'
```
Expected: HTTP 403.

- [ ] **Step 4: Commit, push, open PR**

```bash
git add .changeset/security-rce-provision-command.md
git commit -m "chore: changeset for C1 RCE fix"
git push -u origin fix/security-rce-projects
gh pr create --title "fix(security): RCE via executionWorkspacePolicy.provisionCommand (C1)" --body "..."
```

---

## PR 2 — Cross-tenant approvals + decidedByUserId

**Branch:** `fix/security-cross-tenant-approvals`
**Findings:** C3 (cross-tenant IDOR), C4 (spoofable `decidedByUserId`).

### Task 2.1: Strict approval validators with TDD

**Files:**
- Create: `packages/shared/src/validators/__tests__/approval.test.ts`
- Modify: `packages/shared/src/validators/approval.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { resolveApprovalSchema, requestApprovalRevisionSchema } from "../approval.js";

describe("resolveApprovalSchema", () => {
  it("accepts decisionNote alone", () => {
    expect(resolveApprovalSchema.safeParse({ decisionNote: "ok" }).success).toBe(true);
  });
  it("accepts empty body", () => {
    expect(resolveApprovalSchema.safeParse({}).success).toBe(true);
  });
  it("rejects body containing decidedByUserId (strict)", () => {
    const result = resolveApprovalSchema.safeParse({
      decisionNote: "ok",
      decidedByUserId: "alice@evil.com",
    });
    expect(result.success).toBe(false);
  });
});

describe("requestApprovalRevisionSchema", () => {
  it("accepts decisionNote alone", () => {
    expect(requestApprovalRevisionSchema.safeParse({ decisionNote: "needs work" }).success).toBe(true);
  });
  it("rejects body containing decidedByUserId", () => {
    const result = requestApprovalRevisionSchema.safeParse({
      decisionNote: "x",
      decidedByUserId: "x",
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test, verify FAIL**

Run: `pnpm -F @armyofagents/shared test approval`
Expected: FAIL — current schema allows the field with default `"board"`.

- [ ] **Step 3: Tighten the validator**

Edit `packages/shared/src/validators/approval.ts:13-23`:
```ts
export const resolveApprovalSchema = z
  .object({
    decisionNote: z.string().optional().nullable(),
  })
  .strict();

export type ResolveApproval = z.infer<typeof resolveApprovalSchema>;

export const requestApprovalRevisionSchema = z
  .object({
    decisionNote: z.string().optional().nullable(),
  })
  .strict();
```

- [ ] **Step 4: Run test, verify PASS**

Run: `pnpm -F @armyofagents/shared test approval`
Expected: all 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/validators/approval.ts packages/shared/src/validators/__tests__/approval.test.ts
git commit -m "fix(validators): strip decidedByUserId from approval schemas (C4)"
```

### Task 2.2: Add company-access check to `/approve`

**Files:**
- Modify: `server/src/routes/approvals.ts:123-216`

- [ ] **Step 1: Replace handler body**

In the `POST /approvals/:id/approve` handler, replace:
```ts
router.post("/approvals/:id/approve", validate(resolveApprovalSchema), async (req, res) => {
  assertBoard(req);
  const id = req.params.id as string;
  const approval = await svc.approve(id, req.body.decidedByUserId ?? "board", req.body.decisionNote);
  // ...
```

With:
```ts
router.post("/approvals/:id/approve", validate(resolveApprovalSchema), async (req, res) => {
  assertBoard(req);
  const id = req.params.id as string;
  const existing = await svc.getById(id);
  if (!existing) {
    res.status(404).json({ error: "Approval not found" });
    return;
  }
  assertCompanyAccess(req, existing.companyId);

  const decidedBy = req.actor.userId ?? "local-board";
  const approval = await svc.approve(id, decidedBy, req.body.decisionNote);
  // ...
```

- [ ] **Step 2: Type-check**

Run: `pnpm -F @armyofagents/server typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/approvals.ts
git commit -m "fix(routes): cross-tenant guard + actor-derived decidedBy on /approvals/:id/approve (C3, C4)"
```

### Task 2.3: Same fix on `/reject` and `/request-revision`

**Files:**
- Modify: `server/src/routes/approvals.ts:218-244`, `:246-280`

- [ ] **Step 1: Apply identical pattern to `/reject`**

Replace:
```ts
const approval = await svc.reject(id, req.body.decidedByUserId ?? "board", req.body.decisionNote);
```

With the load + assertCompanyAccess + actor-derived block (same shape as Task 2.2, calling `svc.reject` instead of `svc.approve`).

- [ ] **Step 2: Apply identical pattern to `/request-revision`**

Same structural edit on the third handler.

- [ ] **Step 3: Type-check**

Run: `pnpm -F @armyofagents/server typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/approvals.ts
git commit -m "fix(routes): cross-tenant guard on /reject and /request-revision (C3, C4)"
```

### Task 2.4: Remove `--decided-by-user-id` from CLI

**Files:**
- Modify: `cli/src/commands/client/approval.ts:24-200`

- [ ] **Step 1: Remove the field from the interface**

Edit line 24-27, remove `decidedByUserId?: string`:
```ts
interface ApprovalDecisionOptions extends BaseClientOptions {
  decisionNote?: string;
}
```

- [ ] **Step 2: Remove the option declaration from each command**

Lines 143, 165, 187 — remove `.option("--decided-by-user-id <id>", "Decision actor user ID")`. Each of `approve`, `reject`, `request-revision` has this option.

- [ ] **Step 3: Remove the field from each `parse()` call**

Lines 149, 171, 193 — remove `decidedByUserId: opts.decidedByUserId,` from the payload object passed to `parse()`. Each parse becomes:
```ts
const payload = resolveApprovalSchema.parse({
  decisionNote: opts.decisionNote,
});
```

- [ ] **Step 4: Run CLI tests**

Run: `pnpm -F @armyofagents/cli test`
Expected: PASS. If a test referenced `--decided-by-user-id`, update or remove it.

- [ ] **Step 5: Commit**

```bash
git add cli/src/commands/client/approval.ts
git commit -m "fix(cli): remove --decided-by-user-id option from approval commands (C4)"
```

### Task 2.5: Cross-tenant route tests

**Files:**
- Create: `server/src/__tests__/approvals-routes-cross-tenant.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

const getById = vi.fn();
const approve = vi.fn();
const reject = vi.fn();
const requestRevision = vi.fn();

vi.mock("../services/index.js", () => ({
  approvalService: () => ({ getById, approve, reject, requestRevision, listForCompany: vi.fn() }),
  issueApprovalsService: () => ({ listIssuesForApproval: vi.fn().mockResolvedValue([]) }),
  trustScoreService: () => ({ updateOnReview: vi.fn() }),
  heartbeatService: () => ({ wakeup: vi.fn().mockResolvedValue(null) }),
  logActivity: vi.fn(),
}));

import { approvalRoutes } from "../routes/approvals.js";

function makeApp(actor: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).actor = actor; next(); });
  app.use("/api", approvalRoutes({} as any));
  return app;
}

const companyAActor = {
  type: "board",
  source: "session",
  userId: "user-A",
  companyIds: ["company-A"],
  isInstanceAdmin: false,
};
const companyBActor = { ...companyAActor, userId: "user-B", companyIds: ["company-B"] };

describe("/approvals cross-tenant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("403 when companyA user tries to approve a companyB approval", async () => {
    getById.mockResolvedValue({ id: "ap1", companyId: "company-B", status: "pending" });
    const app = makeApp(companyAActor);
    const res = await request(app).post("/api/approvals/ap1/approve").send({});
    expect(res.status).toBe(403);
    expect(approve).not.toHaveBeenCalled();
  });

  it("403 cross-tenant on /reject", async () => {
    getById.mockResolvedValue({ id: "ap1", companyId: "company-B", status: "pending" });
    const app = makeApp(companyAActor);
    const res = await request(app).post("/api/approvals/ap1/reject").send({});
    expect(res.status).toBe(403);
  });

  it("403 cross-tenant on /request-revision", async () => {
    getById.mockResolvedValue({ id: "ap1", companyId: "company-B", status: "pending" });
    const app = makeApp(companyAActor);
    const res = await request(app).post("/api/approvals/ap1/request-revision").send({});
    expect(res.status).toBe(403);
  });

  it("404 on unknown approval id", async () => {
    getById.mockResolvedValue(null);
    const app = makeApp(companyAActor);
    const res = await request(app).post("/api/approvals/missing/approve").send({});
    expect(res.status).toBe(404);
  });

  it("200 same-company; decidedByUserId derived from actor", async () => {
    getById.mockResolvedValue({ id: "ap1", companyId: "company-A", status: "pending", requestedByAgentId: null, type: "test" });
    approve.mockResolvedValue({ id: "ap1", companyId: "company-A", status: "approved" });
    const app = makeApp(companyAActor);
    const res = await request(app).post("/api/approvals/ap1/approve").send({ decisionNote: "ok" });
    expect(res.status).toBe(200);
    expect(approve).toHaveBeenCalledWith("ap1", "user-A", "ok");
  });

  it("400 when body contains decidedByUserId (strict schema rejects)", async () => {
    const app = makeApp(companyAActor);
    const res = await request(app)
      .post("/api/approvals/ap1/approve")
      .send({ decisionNote: "ok", decidedByUserId: "alice@evil.com" });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test, verify all PASS**

Run: `pnpm -F @armyofagents/server test approvals-routes-cross-tenant`
Expected: all 6 PASS.

- [ ] **Step 3: Commit**

```bash
git add server/src/__tests__/approvals-routes-cross-tenant.test.ts
git commit -m "test(approvals): cross-tenant + actor-derived decidedBy + strict schema (C3, C4)"
```

### Task 2.6: Final changeset and PR open

- [ ] **Step 1: Write the changeset**

Create `.changeset/security-approvals-cross-tenant.md`:
```markdown
---
"@armyofagents/server": patch
"@armyofagents/shared": patch
"@armyofagents/cli": patch
---

fix(security): close cross-tenant IDOR on /approvals/:id/approve|reject|request-revision (C3) and remove the spoofable `decidedByUserId` body field (C4). Decider is now derived from `req.actor.userId` server-side; CLI no longer accepts `--decided-by-user-id`.
```

- [ ] **Step 2: Smoke test**

```bash
# from companyA token, target companyB approval id
curl -X POST http://localhost:3232/api/approvals/<companyB_approval_id>/approve \
  -H "Authorization: Bearer <companyA_token>" \
  -H "Content-Type: application/json" -d '{"decisionNote":"ok"}'
```
Expected: 403.

- [ ] **Step 3: Commit, push, open PR**

```bash
git add .changeset/security-approvals-cross-tenant.md
git commit -m "chore: changeset for C3+C4 fixes"
git push -u origin fix/security-cross-tenant-approvals
gh pr create --title "fix(security): cross-tenant approvals (C3) + decidedByUserId spoof (C4)" --body "..."
```

---

## PR 3 — Cross-tenant agent keys

**Branch:** `fix/security-cross-tenant-agent-keys`
**Finding:** C5.

### Task 3.1: Add `getKeyById` method to agents service

**Files:**
- Modify: `server/src/services/agents.ts`

- [ ] **Step 1: Locate the agents service**

Run: `grep -n 'export.*agentsService\|listKeys\|revokeKey' server/src/services/agents.ts | head`
Find where `listKeys`/`revokeKey` are defined.

- [ ] **Step 2: Add the new method next to `listKeys`/`revokeKey`**

```ts
async getKeyById(keyId: string): Promise<{ id: string; agentId: string; name: string; createdAt: Date } | null> {
  const rows = await db.select({
    id: agentApiKeys.id,
    agentId: agentApiKeys.agentId,
    name: agentApiKeys.name,
    createdAt: agentApiKeys.createdAt,
  })
  .from(agentApiKeys)
  .where(eq(agentApiKeys.id, keyId))
  .limit(1);
  return rows[0] ?? null;
},
```
(Confirm `agentApiKeys` is the correct table import; check `packages/db/src/schema/agent_api_keys.ts` for the field names.)

- [ ] **Step 3: Type-check**

Run: `pnpm -F @armyofagents/server typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add server/src/services/agents.ts
git commit -m "feat(agents): add getKeyById service method (precondition for C5 fix)"
```

### Task 3.2: Fix three handlers in `agents.ts`

**Files:**
- Modify: `server/src/routes/agents.ts:1244-1281`

- [ ] **Step 1: Replace GET handler**

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

- [ ] **Step 2: Replace POST handler**

```ts
router.post("/agents/:id/keys", validate(createAgentKeySchema), async (req, res) => {
  assertBoard(req);
  const agent = await svc.getById(req.params.id);
  if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }
  assertCompanyAccess(req, agent.companyId);

  const key = await svc.createApiKey(agent.id, req.body.name);
  await logActivity(db, {
    companyId: agent.companyId,
    actorType: "user",
    actorId: req.actor.userId ?? "board",
    action: "agent.key_created",
    entityType: "agent",
    entityId: agent.id,
    details: { keyId: key.id, name: key.name },
  });
  res.status(201).json(key);
});
```

- [ ] **Step 3: Replace DELETE handler**

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

- [ ] **Step 4: Type-check**

Run: `pnpm -F @armyofagents/server typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/agents.ts
git commit -m "fix(routes): cross-tenant guard on /agents/:id/keys handlers (C5)"
```

### Task 3.3: Route tests

**Files:**
- Create: `server/src/__tests__/agents-keys-routes.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import express from "express";
import request from "supertest";
import { describe, expect, it, vi, beforeEach } from "vitest";

const getById = vi.fn();
const listKeys = vi.fn();
const createApiKey = vi.fn();
const revokeKey = vi.fn();
const getKeyById = vi.fn();

vi.mock("../services/index.js", () => ({
  agentsService: () => ({
    getById, listKeys, createApiKey, revokeKey, getKeyById,
    // stub out other methods so route construction succeeds
    list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(),
  }),
  logActivity: vi.fn(),
  // stub other services router uses
  heartbeatService: () => ({ wakeup: vi.fn() }),
}));

import { agentRoutes } from "../routes/agents.js";

function makeApp(actor: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).actor = actor; next(); });
  app.use("/api", agentRoutes({} as any));
  return app;
}

const companyAActor = {
  type: "board",
  source: "session",
  userId: "user-A",
  companyIds: ["company-A"],
  isInstanceAdmin: false,
};
const companyBActor = { ...companyAActor, userId: "user-B", companyIds: ["company-B"] };

describe("/agents/:id/keys cross-tenant", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("403 GET keys for foreign-company agent", async () => {
    getById.mockResolvedValue({ id: "ag1", companyId: "company-B" });
    const app = makeApp(companyAActor);
    const res = await request(app).get("/api/agents/ag1/keys");
    expect(res.status).toBe(403);
    expect(listKeys).not.toHaveBeenCalled();
  });

  it("403 POST keys for foreign-company agent", async () => {
    getById.mockResolvedValue({ id: "ag1", companyId: "company-B" });
    const app = makeApp(companyAActor);
    const res = await request(app).post("/api/agents/ag1/keys").send({ name: "k" });
    expect(res.status).toBe(403);
    expect(createApiKey).not.toHaveBeenCalled();
  });

  it("403 DELETE for foreign-company agent", async () => {
    getById.mockResolvedValue({ id: "ag1", companyId: "company-B" });
    const app = makeApp(companyAActor);
    const res = await request(app).delete("/api/agents/ag1/keys/k1");
    expect(res.status).toBe(403);
    expect(revokeKey).not.toHaveBeenCalled();
  });

  it("404 DELETE when key belongs to a different agent in same company", async () => {
    getById.mockResolvedValue({ id: "ag1", companyId: "company-A" });
    getKeyById.mockResolvedValue({ id: "k1", agentId: "ag2", name: "k", createdAt: new Date() });
    const app = makeApp(companyAActor);
    const res = await request(app).delete("/api/agents/ag1/keys/k1");
    expect(res.status).toBe(404);
    expect(revokeKey).not.toHaveBeenCalled();
  });

  it("200 GET keys for own-company agent (regression guard)", async () => {
    getById.mockResolvedValue({ id: "ag1", companyId: "company-A" });
    listKeys.mockResolvedValue([]);
    const app = makeApp(companyAActor);
    const res = await request(app).get("/api/agents/ag1/keys");
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run test, verify PASS**

Run: `pnpm -F @armyofagents/server test agents-keys-routes`
Expected: all 5 PASS.

- [ ] **Step 3: Commit**

```bash
git add server/src/__tests__/agents-keys-routes.test.ts
git commit -m "test(agents): cross-tenant guards on /agents/:id/keys (C5)"
```

### Task 3.4: Final changeset and PR open

- [ ] **Step 1: Changeset**

`.changeset/security-agent-keys-cross-tenant.md`:
```markdown
---
"@armyofagents/server": patch
---

fix(security): close cross-tenant IDOR on /agents/:id/keys (GET, POST, DELETE). Agent loaded + assertCompanyAccess; DELETE additionally validates the key belongs to the named agent. Adds getKeyById service method. Closes C5.
```

- [ ] **Step 2: Smoke test**

```bash
curl -X POST http://localhost:3232/api/agents/<companyB_agent_id>/keys \
  -H "Authorization: Bearer <companyA_token>" \
  -d '{"name":"x"}'
```
Expected: 403.

- [ ] **Step 3: Commit, push, open PR**

```bash
git add .changeset/security-agent-keys-cross-tenant.md
git commit -m "chore: changeset for C5 fix"
git push -u origin fix/security-cross-tenant-agent-keys
gh pr create --title "fix(security): cross-tenant agent keys (C5)" --body "..."
```

---

## PR 4 — Instance admin gate

**Branch:** `fix/security-instance-admin-gate`
**Findings:** C2 (filesystem auth), C6 (adapter install RCE).

### Task 4.1: Add `assertCanManageInstanceSettings` to `routes/authz.ts`

**Files:**
- Modify: `server/src/routes/authz.ts`

- [ ] **Step 1: Append the new export**

At the end of `server/src/routes/authz.ts`, add:
```ts
export function assertCanManageInstanceSettings(req: Request) {
  if (req.actor.type !== "board") {
    throw forbidden("Board access required");
  }
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
    return;
  }
  throw forbidden("Instance admin access required");
}
```

- [ ] **Step 2: Type-check**

Run: `pnpm -F @armyofagents/server typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/authz.ts
git commit -m "feat(authz): export assertCanManageInstanceSettings (precondition for C2 + C6)"
```

### Task 4.2: Replace local copy in `instance-settings.ts`

**Files:**
- Modify: `server/src/routes/instance-settings.ts:9-17`

- [ ] **Step 1: Add the import**

At the top, add `assertCanManageInstanceSettings` to the existing `./authz.js` import (currently imports `getActorInfo`):
```ts
import { assertCanManageInstanceSettings, getActorInfo } from "./authz.js";
```

- [ ] **Step 2: Delete the local function definition**

Remove lines 9-17 (the local `function assertCanManageInstanceSettings(...)`).

- [ ] **Step 3: Type-check**

Run: `pnpm -F @armyofagents/server typecheck`
Expected: no errors. Existing call sites at lines 24+ continue to work because the import name matches.

- [ ] **Step 4: Run tests**

Run: `pnpm -F @armyofagents/server test instance-settings`
Expected: PASS — behavior unchanged.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/instance-settings.ts
git commit -m "refactor(instance-settings): use shared assertCanManageInstanceSettings"
```

### Task 4.3: Replace local copy in `feedback.ts`

**Files:**
- Modify: `server/src/routes/feedback.ts:15-21`

- [ ] **Step 1: Add the import**

Add `assertCanManageInstanceSettings` to the existing import from `./authz.js` (or create the import).

- [ ] **Step 2: Delete the local function (lines 15-21 plus the comment)**

Remove the comment-block + `function assertCanManageInstanceSettings(...)` definition. Single call site at line 167 already references the same name → works after import.

- [ ] **Step 3: Run tests**

Run: `pnpm -F @armyofagents/server test feedback`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/feedback.ts
git commit -m "refactor(feedback): use shared assertCanManageInstanceSettings"
```

### Task 4.4: Add gate to filesystem routes

**Files:**
- Modify: `server/src/routes/filesystem.ts`

- [ ] **Step 1: Add import**

At the top:
```ts
import { assertCanManageInstanceSettings } from "./authz.js";
```

- [ ] **Step 2: Add gate at top of every handler**

For each of the 5 handlers (`/filesystem/browse`, `/mkdir`, `/home`, `/reveal`, `/drives`), insert as the first line of the handler body:
```ts
assertCanManageInstanceSettings(req);
```

- [ ] **Step 3: Bound `/filesystem/reveal` spawn target**

In the `/filesystem/reveal` handler, after the gate, add:
```ts
const homeDir = os.homedir();
if (!resolvedPath.startsWith(homeDir)) {
  res.status(400).json({ error: "Path outside home directory" });
  return;
}
```
(Adapt to wherever `resolvedPath` is computed. The intent: refuse to spawn `xdg-open` against arbitrary paths.)

- [ ] **Step 4: Type-check + run any existing filesystem tests**

Run: `pnpm -F @armyofagents/server typecheck && pnpm -F @armyofagents/server test filesystem`
Expected: PASS or "no tests found" (test file is created in a later task).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/filesystem.ts
git commit -m "fix(routes): require instance admin for /filesystem/* handlers (C2)"
```

### Task 4.5: Replace `assertBoard` with `assertCanManageInstanceSettings` in adapters

**Files:**
- Modify: `server/src/routes/adapters.ts`

- [ ] **Step 1: Add import**

At the top:
```ts
import { assertCanManageInstanceSettings } from "./authz.js";
```

- [ ] **Step 2: Replace 9 call sites**

The 9 occurrences of `assertBoard(req);` are at lines 198, 220, 251, 310, 429, 477, 544, 589, 629 (verified by grep on `main`). Replace each with:
```ts
assertCanManageInstanceSettings(req);
```

To do all at once safely:
```bash
# Verify count first
grep -c 'assertBoard(req);' server/src/routes/adapters.ts
# Expected: 9

# Apply replacement
sed -i.bak 's/assertBoard(req);/assertCanManageInstanceSettings(req);/g' server/src/routes/adapters.ts
diff server/src/routes/adapters.ts.bak server/src/routes/adapters.ts | head -40
rm server/src/routes/adapters.ts.bak
```

- [ ] **Step 3: Remove the now-unused `assertBoard` import** (if it's only used in those replaced lines)

Run: `grep -n 'assertBoard' server/src/routes/adapters.ts`
If only the import line shows, remove it.

- [ ] **Step 4: Type-check**

Run: `pnpm -F @armyofagents/server typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/adapters.ts
git commit -m "fix(routes): require instance admin for adapter operations (C6)"
```

### Task 4.6: Filesystem route tests

**Files:**
- Create: `server/src/__tests__/filesystem-routes.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { filesystemRoutes } from "../routes/filesystem.js";

function makeApp(actor: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).actor = actor; next(); });
  app.use("/api", filesystemRoutes());
  return app;
}

const nonAdminBoard = {
  type: "board",
  source: "session",
  userId: "user-A",
  companyIds: ["company-A"],
  isInstanceAdmin: false,
};
const localImplicit = { ...nonAdminBoard, source: "local_implicit" };
const instanceAdmin = { ...nonAdminBoard, isInstanceAdmin: true };

describe("filesystem routes — instance admin gate", () => {
  it("403 browse for non-admin board user", async () => {
    const res = await request(makeApp(nonAdminBoard)).get("/api/filesystem/browse?path=/tmp");
    expect(res.status).toBe(403);
  });
  it("403 mkdir for non-admin", async () => {
    const res = await request(makeApp(nonAdminBoard))
      .post("/api/filesystem/mkdir").send({ path: "/tmp/x" });
    expect(res.status).toBe(403);
  });
  it("403 reveal for non-admin", async () => {
    const res = await request(makeApp(nonAdminBoard))
      .post("/api/filesystem/reveal").send({ path: "/tmp" });
    expect(res.status).toBe(403);
  });
  it("403 drives for non-admin", async () => {
    const res = await request(makeApp(nonAdminBoard)).get("/api/filesystem/drives");
    expect(res.status).toBe(403);
  });
  it("200 browse for local_implicit (local_trusted regression guard)", async () => {
    const res = await request(makeApp(localImplicit)).get("/api/filesystem/browse?path=/tmp");
    // Status will be 200 OR 400 (path validation), but never 403
    expect(res.status).not.toBe(403);
  });
  it("403 reveal with path outside home dir", async () => {
    const res = await request(makeApp(instanceAdmin))
      .post("/api/filesystem/reveal").send({ path: "/etc/passwd" });
    expect([400, 403]).toContain(res.status);
  });
});
```

- [ ] **Step 2: Run test, verify PASS**

Run: `pnpm -F @armyofagents/server test filesystem-routes`
Expected: all 6 PASS.

- [ ] **Step 3: Commit**

```bash
git add server/src/__tests__/filesystem-routes.test.ts
git commit -m "test(filesystem): instance-admin gate on all 5 handlers (C2)"
```

### Task 4.7: Adapter route tests

**Files:**
- Create: `server/src/__tests__/adapters-routes-instance-admin.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

vi.mock("../services/index.js", () => ({
  // mock the adapter-install service entry points the routes use
  adapterRegistryService: () => ({
    listInstalled: vi.fn().mockResolvedValue([]),
    install: vi.fn().mockResolvedValue({ ok: true }),
    reload: vi.fn(),
    reinstall: vi.fn(),
    remove: vi.fn(),
  }),
  logActivity: vi.fn(),
}));

import { adaptersRoutes } from "../routes/adapters.js";

function makeApp(actor: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).actor = actor; next(); });
  app.use("/api", adaptersRoutes({} as any));
  return app;
}

const nonAdminBoard = {
  type: "board",
  source: "session",
  userId: "user-A",
  companyIds: ["company-A"],
  isInstanceAdmin: false,
};
const instanceAdmin = { ...nonAdminBoard, isInstanceAdmin: true };
const localImplicit = { ...nonAdminBoard, source: "local_implicit" };

describe("adapter routes — instance admin gate", () => {
  it("403 install as non-admin", async () => {
    const res = await request(makeApp(nonAdminBoard))
      .post("/api/adapters/install").send({ packageName: "x" });
    expect(res.status).toBe(403);
  });

  it("200 install as instance admin", async () => {
    const res = await request(makeApp(instanceAdmin))
      .post("/api/adapters/install").send({ packageName: "x" });
    expect([200, 201]).toContain(res.status);
  });

  it("200 install as local_implicit (regression guard)", async () => {
    const res = await request(makeApp(localImplicit))
      .post("/api/adapters/install").send({ packageName: "x" });
    expect([200, 201]).toContain(res.status);
  });

  // optionally one more endpoint to verify the pattern was applied widely
  it("403 list-installed as non-admin", async () => {
    const res = await request(makeApp(nonAdminBoard)).get("/api/adapters/installed");
    expect(res.status).toBe(403);
  });
});
```

(Adjust endpoint paths to match the real ones in `adapters.ts`.)

- [ ] **Step 2: Run test, verify PASS**

Run: `pnpm -F @armyofagents/server test adapters-routes-instance-admin`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add server/src/__tests__/adapters-routes-instance-admin.test.ts
git commit -m "test(adapters): instance-admin gate (C6)"
```

### Task 4.8: Final changeset and PR open

- [ ] **Step 1: Changeset**

`.changeset/security-instance-admin-gate.md`:
```markdown
---
"@armyofagents/server": patch
---

fix(security): require instance-admin (or local_implicit) for filesystem routes (C2) and adapter operations (C6). Lifts `assertCanManageInstanceSettings` to `routes/authz.ts` so `instance-settings.ts` and `feedback.ts` use the same shared helper. `/filesystem/reveal` additionally bounds spawn targets to the home directory.
```

- [ ] **Step 2: Smoke tests**

```bash
# In cloud_auth mode without auth header
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3232/api/filesystem/browse?path=/Users
# Expected: 403 (or 401 — both are "rejected")

# Non-admin board user
curl -X POST -H "Authorization: Bearer <non_admin_token>" -d '{"packageName":"evil-pkg"}' http://localhost:3232/api/adapters/install
# Expected: 403
```

- [ ] **Step 3: Commit, push, open PR**

```bash
git add .changeset/security-instance-admin-gate.md
git commit -m "chore: changeset for C2 + C6 fixes"
git push -u origin fix/security-instance-admin-gate
gh pr create --title "fix(security): instance-admin gate on filesystem + adapters (C2, C6)" --body "..."
```

---

## PR 5 — XSS DOCX + helmet-light

**Branch:** `fix/security-xss-docx-and-headers`
**Findings:** C8 (DOCX `javascript:` href XSS), helmet-light baseline.

### Task 5.1: Add deps

**Files:**
- Modify: `server/package.json`

- [ ] **Step 1: Add the deps**

```bash
pnpm -F @armyofagents/server add helmet isomorphic-dompurify
```

- [ ] **Step 2: Verify install**

Run: `pnpm -F @armyofagents/server list helmet isomorphic-dompurify`
Expected: both listed.

- [ ] **Step 3: Commit**

```bash
git add server/package.json pnpm-lock.yaml
git commit -m "deps(server): add helmet + isomorphic-dompurify (precondition for C8)"
```

### Task 5.2: Sanitize mammoth output

**Files:**
- Modify: `server/src/routes/memory-asset-render.ts:31-66`

- [ ] **Step 1: Add import**

At the top, add:
```ts
import DOMPurify from "isomorphic-dompurify";
```

- [ ] **Step 2: Sanitize after `mammoth.convertToHtml`**

Replace lines 59-62:
```ts
const result = await mammoth.convertToHtml({ buffer });
res.setHeader("Content-Type", "text/html; charset=utf-8");
res.send(`<article class="docx-rendered">${result.value}</article>`);
```

With:
```ts
const result = await mammoth.convertToHtml({ buffer });
const sanitized = DOMPurify.sanitize(result.value, {
  ALLOWED_URI_REGEXP: /^(?:https?|mailto|tel|#)/i,
  FORBID_TAGS: ["script", "iframe", "object", "embed", "form"],
  FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "onfocus"],
});
res.setHeader("Content-Type", "text/html; charset=utf-8");
res.setHeader("X-Content-Type-Options", "nosniff");
res.send(`<article class="docx-rendered">${sanitized}</article>`);
```

- [ ] **Step 3: Type-check**

Run: `pnpm -F @armyofagents/server typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/memory-asset-render.ts
git commit -m "fix(routes): sanitize DOCX HTML output via DOMPurify (C8)"
```

### Task 5.3: Mount helmet-light

**Files:**
- Modify: `server/src/app.ts:142`

- [ ] **Step 1: Add import**

Near the top of `server/src/app.ts`:
```ts
import helmet from "helmet";
```

- [ ] **Step 2: Mount helmet right after `httpLogger`**

After `app.use(httpLogger);` (line 142), insert:
```ts
app.use(helmet({
  contentSecurityPolicy: false,        // deferred to Sprint 2 (C7)
  crossOriginEmbedderPolicy: false,    // can break legitimate embeds; revisit Sprint 2
  crossOriginOpenerPolicy: false,
  crossOriginResourcePolicy: false,
}));
```

- [ ] **Step 3: Type-check**

Run: `pnpm -F @armyofagents/server typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add server/src/app.ts
git commit -m "feat(app): mount helmet with light defaults (defense for C7/C8)"
```

### Task 5.4: Build the DOCX fixture

**Files:**
- Create: `server/src/__tests__/__fixtures__/docx-with-javascript-href.docx` (binary)
- Create: `server/src/__tests__/__fixtures__/build-docx-fixture.mjs` (one-off generator, kept as documentation)

- [ ] **Step 1: Write the fixture-generation script**

```js
// server/src/__tests__/__fixtures__/build-docx-fixture.mjs
import JSZip from "jszip";
import { writeFileSync } from "node:fs";

const zip = new JSZip();

zip.file("[Content_Types].xml",
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);

zip.file("_rels/.rels",
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);

zip.file("word/_rels/document.xml.rels",
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdJS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="javascript:alert(1)" TargetMode="External"/>
  <Relationship Id="rIdSafe" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com" TargetMode="External"/>
</Relationships>`);

zip.file("word/document.xml",
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    <w:p><w:hyperlink r:id="rIdJS"><w:r><w:t>click me</w:t></w:r></w:hyperlink></w:p>
    <w:p><w:hyperlink r:id="rIdSafe"><w:r><w:t>safe link</w:t></w:r></w:hyperlink></w:p>
  </w:body>
</w:document>`);

const buf = await zip.generateAsync({ type: "nodebuffer" });
writeFileSync(new URL("./docx-with-javascript-href.docx", import.meta.url), buf);
console.log("wrote fixture");
```

- [ ] **Step 2: Generate the fixture**

```bash
pnpm -F @armyofagents/server exec node server/src/__tests__/__fixtures__/build-docx-fixture.mjs
ls -la server/src/__tests__/__fixtures__/docx-with-javascript-href.docx
```
Expected: file size around 1-2 KB.

- [ ] **Step 3: Commit fixture + generator**

```bash
git add server/src/__tests__/__fixtures__/docx-with-javascript-href.docx
git add server/src/__tests__/__fixtures__/build-docx-fixture.mjs
git commit -m "test(fixtures): DOCX with javascript: hyperlink for C8 tests"
```

### Task 5.5: DOCX sanitization tests

**Files:**
- Create: `server/src/__tests__/memory-asset-render-xss.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import express from "express";
import request from "supertest";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

const fixtureBuffer = await readFile(
  new URL("./__fixtures__/docx-with-javascript-href.docx", import.meta.url),
);

const getAsset = vi.fn().mockResolvedValue({
  id: "asset-1",
  storageKey: "k",
  mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
});

vi.mock("../services/memory-assets.js", () => ({
  memoryAssetsService: () => ({ get: getAsset }),
}));

import { memoryAssetRenderRoutes } from "../routes/memory-asset-render.js";

function makeApp() {
  const app = express();
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board", source: "session", userId: "u",
      companyIds: ["company-A"], isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", memoryAssetRenderRoutes({
    db: {} as any,
    storage: {
      async getObject(_companyId: string, _key: string) {
        const stream = (await import("node:stream")).Readable.from([fixtureBuffer]);
        return { stream, contentLength: fixtureBuffer.byteLength };
      },
    },
  }));
  return app;
}

describe("memory asset render DOCX XSS sanitization", () => {
  it("strips javascript: href", async () => {
    const res = await request(makeApp())
      .get("/api/companies/company-A/memory/assets/asset-1/render");
    expect(res.status).toBe(200);
    expect(res.text).not.toMatch(/javascript:/i);
  });

  it("preserves https: hyperlink (regression guard)", async () => {
    const res = await request(makeApp())
      .get("/api/companies/company-A/memory/assets/asset-1/render");
    expect(res.text).toMatch(/href="https:\/\/example\.com"/);
  });

  it("includes X-Content-Type-Options: nosniff", async () => {
    const res = await request(makeApp())
      .get("/api/companies/company-A/memory/assets/asset-1/render");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });
});
```

- [ ] **Step 2: Run, verify PASS**

Run: `pnpm -F @armyofagents/server test memory-asset-render-xss`
Expected: 3 PASS.

- [ ] **Step 3: Commit**

```bash
git add server/src/__tests__/memory-asset-render-xss.test.ts
git commit -m "test(memory-asset-render): DOMPurify strips javascript: hrefs (C8)"
```

### Task 5.6: Helmet headers test

**Files:**
- Create: `server/src/__tests__/app-security-headers.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, expect, it } from "vitest";
import request from "supertest";
import express from "express";
import helmet from "helmet";

describe("app security headers", () => {
  it("emits the helmet-light defaults", async () => {
    const app = express();
    app.use(helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      crossOriginOpenerPolicy: false,
      crossOriginResourcePolicy: false,
    }));
    app.get("/health", (_req, res) => res.json({ ok: true }));

    const res = await request(app).get("/health");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run, verify PASS**

Run: `pnpm -F @armyofagents/server test app-security-headers`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add server/src/__tests__/app-security-headers.test.ts
git commit -m "test(app): helmet-light header defaults"
```

### Task 5.7: Final changeset and PR open

- [ ] **Step 1: Changeset**

`.changeset/security-xss-docx-helmet.md`:
```markdown
---
"@armyofagents/server": patch
---

fix(security): sanitize mammoth DOCX HTML output via DOMPurify to strip `javascript:` hyperlinks and dangerous tags (C8). Mount helmet with light defaults (X-Content-Type-Options: nosniff, X-Frame-Options: SAMEORIGIN, Referrer-Policy: no-referrer, X-Powered-By removed). Strict CSP deferred to Sprint 2 with C7.
```

- [ ] **Step 2: Smoke test**

```bash
curl -I http://localhost:3232/api/health
# Expected: response includes x-content-type-options: nosniff, x-frame-options: SAMEORIGIN
```

- [ ] **Step 3: Commit, push, open PR**

```bash
git add .changeset/security-xss-docx-helmet.md
git commit -m "chore: changeset for C8 + helmet-light"
git push -u origin fix/security-xss-docx-and-headers
gh pr create --title "fix(security): DOCX javascript: href sanitization + helmet-light (C8)" --body "..."
```

---

## PR 6b — CI grep guards

**Branch:** `fix/security-ci-guards`
**Lands LAST** — after PRs 1-5 have cleaned up `assertBoard` sites so the guard passes cleanly.

### Task 6b.1: `assertBoard` pairing checker script

**Files:**
- Create: `scripts/check-assertboard-pairing.mjs`

- [ ] **Step 1: Write the script**

```js
#!/usr/bin/env node
// scripts/check-assertboard-pairing.mjs
//
// Fails CI if a route handler calls `assertBoard(req);` without a paired
// access check (`assertCompanyAccess` or `assertCanManageInstanceSettings`)
// within 5 lines OR an explicit opt-out comment.
//
// Allowed opt-out: `// rbac: instance-admin-not-required`

import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { execSync } from "node:child_process";

const files = execSync("git ls-files server/src/routes/*.ts", { encoding: "utf8" })
  .trim()
  .split("\n");

let failed = 0;
const violations = [];

for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes("assertBoard(req);")) continue;

    // Look for opt-out comment on the same line or up to 2 lines before
    const surrounding = lines.slice(Math.max(0, i - 2), i + 1).join("\n");
    if (surrounding.includes("rbac: instance-admin-not-required")) continue;

    // Look ahead 5 lines for a paired check
    const lookahead = lines.slice(i + 1, i + 6).join("\n");
    if (lookahead.match(/assertCompanyAccess|assertCanManageInstanceSettings/)) continue;

    violations.push(`${file}:${i + 1} -- assertBoard(req); without paired access check`);
    failed++;
  }
}

if (failed > 0) {
  console.error(`::error::${failed} unpaired assertBoard call(s):`);
  for (const v of violations) console.error(`  ${v}`);
  console.error('Add `assertCompanyAccess(req, ...)` or `assertCanManageInstanceSettings(req)` within 5 lines, or annotate with `// rbac: instance-admin-not-required` if intentional.');
  process.exit(1);
}
console.log(`OK — ${files.length} route files checked, all assertBoard calls properly paired.`);
```

- [ ] **Step 2: Make executable + run locally**

```bash
chmod +x scripts/check-assertboard-pairing.mjs
node scripts/check-assertboard-pairing.mjs
```
Expected: `OK -- N route files checked, all assertBoard calls properly paired.`
(If failures appear, those are real issues — fix them before continuing this task.)

- [ ] **Step 3: Commit**

```bash
git add scripts/check-assertboard-pairing.mjs
git commit -m "feat(scripts): assertBoard pairing checker"
```

### Task 6b.2: Tests for the pairing script

**Files:**
- Create: `scripts/__tests__/check-assertboard-pairing.test.mjs`

- [ ] **Step 1: Write the tests**

```js
import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function runOn(scenario) {
  const dir = mkdtempSync(join(tmpdir(), "assertboard-test-"));
  mkdirSync(join(dir, "server", "src", "routes"), { recursive: true });
  writeFileSync(join(dir, "server", "src", "routes", "x.ts"), scenario);

  // Must run inside a git repo for `git ls-files` to work; init one
  execSync("git init -q", { cwd: dir });
  execSync("git add -A && git -c user.email=t@t -c user.name=t commit -q -m x", { cwd: dir });

  const scriptPath = join(process.cwd(), "scripts", "check-assertboard-pairing.mjs");
  let output = "";
  let exit = 0;
  try {
    output = execSync(`node ${scriptPath}`, { cwd: dir, encoding: "utf8" });
  } catch (e) {
    exit = e.status ?? 1;
    output = (e.stdout?.toString() ?? "") + (e.stderr?.toString() ?? "");
  }
  rmSync(dir, { recursive: true, force: true });
  return { exit, output };
}

describe("check-assertboard-pairing", () => {
  it("passes when assertBoard is followed by assertCompanyAccess", () => {
    const r = runOn(`
      assertBoard(req);
      const x = await svc.getById(id);
      assertCompanyAccess(req, x.companyId);
    `);
    expect(r.exit).toBe(0);
  });

  it("passes when assertBoard is followed by assertCanManageInstanceSettings", () => {
    const r = runOn(`
      assertBoard(req);
      assertCanManageInstanceSettings(req);
    `);
    expect(r.exit).toBe(0);
  });

  it("fails when assertBoard has no paired check", () => {
    const r = runOn(`
      assertBoard(req);
      const x = await svc.list();
      res.json(x);
    `);
    expect(r.exit).toBe(1);
    expect(r.output).toContain("unpaired");
  });

  it("passes when opt-out comment is present", () => {
    const r = runOn(`
      // rbac: instance-admin-not-required
      assertBoard(req);
      res.json({ok:true});
    `);
    expect(r.exit).toBe(0);
  });
});
```

- [ ] **Step 2: Run, verify PASS**

Run: `pnpm vitest run scripts/__tests__/check-assertboard-pairing.test.mjs`
Expected: 4 PASS.

- [ ] **Step 3: Commit**

```bash
git add scripts/__tests__/check-assertboard-pairing.test.mjs
git commit -m "test(scripts): assertBoard pairing checker tests"
```

### Task 6b.3: Wire grep guards into `pr.yml`

**Files:**
- Modify: `.github/workflows/pr.yml`

- [ ] **Step 1: Add a `security-lint` job**

In `.github/workflows/pr.yml`, add a new job (or extend the existing policy job):

```yaml
  security-lint:
    name: security-lint
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@<sha> # v4.2.2
      - name: Migration DDL must use IF NOT EXISTS
        run: |
          VIOLATIONS=$(grep -EHrn '^CREATE (UNIQUE )?(TABLE|INDEX)\s+"' packages/db/src/migrations/ | grep -v 'IF NOT EXISTS' || true)
          if [ -n "$VIOLATIONS" ]; then
            echo "::error::Migration DDL must use IF NOT EXISTS:"
            echo "$VIOLATIONS"
            exit 1
          fi
      - name: assertBoard must be paired with access check
        run: node scripts/check-assertboard-pairing.mjs
```

(Use the SHA-pinned `actions/checkout@<sha>` from Task 6a.4.)

- [ ] **Step 2: Verify YAML**

Run: `yq '.jobs."security-lint"' .github/workflows/pr.yml`
Expected: parsed object with `steps` array.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/pr.yml
git commit -m "ci: add security-lint job for migration + assertBoard guards"
```

### Task 6b.4: Final changeset and PR open

- [ ] **Step 1: Changeset**

`.changeset/security-ci-guards.md`:
```markdown
---
"@armyofagents/server": patch
---

ci: add `security-lint` job to pr.yml that fails on (a) migration DDL without `IF NOT EXISTS` (the bug class fixed in PR #121, recurrence prevention for C14 follow-up), and (b) `assertBoard(req);` calls not paired with `assertCompanyAccess` or `assertCanManageInstanceSettings` (recurrence prevention for C3, C5, C6).
```

- [ ] **Step 2: Run all guards locally**

```bash
node scripts/check-assertboard-pairing.mjs
grep -EHrn '^CREATE (UNIQUE )?(TABLE|INDEX)\s+"' packages/db/src/migrations/ | grep -v 'IF NOT EXISTS' || echo "OK: all migrations use IF NOT EXISTS"
```
Expected: OK on both.

- [ ] **Step 3: Commit, push, open PR**

```bash
git add .changeset/security-ci-guards.md
git commit -m "chore: changeset for CI security guards"
git push -u origin fix/security-ci-guards
gh pr create --title "ci(security): grep guards for migration IF NOT EXISTS + assertBoard pairing" --body "..."
```

---

## Self-Review Checklist

After all 7 PRs are open and ready for review:

1. **Spec coverage:** every section of the spec maps to a task above? ✓
   - Section 1 (PR cluster definitions) → all 7 PRs above
   - Section 2 (test approach) → tests in PRs 1, 2, 3, 4, 5, 6b
   - Section 3 (verification gates) → smoke tests in each PR's final task
   - Section 4 (rollout order) → encoded as the document's section order
   - Section 5 (rollback plan) → no per-task work; documented in spec
2. **Type consistency:** `assertCanManageInstanceSettings` is exported from `routes/authz.ts` (Task 4.1), imported in 4.2/4.3/4.4/4.5. `sniffsShellCommandFields` exported from `routes/projects.ts` (Task 1.1), imported in 1.5. `getKeyById` added in Task 3.1, used in 3.2.
3. **Placeholder check:** no TBD/TODO/"add appropriate handling" anywhere. Test code is concrete; commands are concrete; SHA placeholders in workflow tasks are explicitly marked `<sha>` with the resolution command in Task 6a.1.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-05-sprint-1-security-fixes.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Best for a multi-PR sprint where each PR is its own atomic unit.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
