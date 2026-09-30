# Marketplace P1/P2 Fixes — Round 3

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three bugs found by Codex in the third review of PR #94: (1) `requireFounderApproval` setting never consulted by `resolveInstallDecision`, (2) request-path operations stay `"pending"` forever blocking polling clients, and (3) duplicate `##` headers in skill markdown silently drop content in `computeSectionDiff`.

**Architecture:** Task 1 extends `resolveInstallDecision`'s settings parameter with `requireFounderApproval` and adds the corresponding branch (team_lead → "request"). Task 2 adds `"requested"` to the `status` type (TypeScript-only, no migration needed since the column is `text().$type<>()`) and immediately transitions the request-path operation to that terminal state. Task 3 adds a `deduplicateHeaders` helper to `marketplace-merge.ts` that makes duplicate section headers unique before Map construction.

**Tech Stack:** TypeScript, Drizzle ORM, Express 5.x, Vitest.

---

## File Map

| File | Task | Change |
|------|------|--------|
| `server/src/routes/marketplace-installs.ts` | 1, 2 | Extend `resolveInstallDecision` call + add status transition |
| `server/src/services/marketplace-install/operation-store.ts` | 2 | Add `"requested"` to `OperationRow.status` union + patch type |
| `packages/db/src/schema/marketplace_install_operations.ts` | 2 | Add `"requested"` to `$type<>` |
| `server/src/services/marketplace-merge.ts` | 3 | Add `deduplicateHeaders`, use it in `computeSectionDiff` |
| `server/src/__tests__/marketplace-installs-request.test.ts` | 1, 2 | Extend existing tests |
| `server/src/__tests__/marketplace-merge.test.ts` | 3 | **Create** — unit tests for merge functions |

---

## Task 1: Honor `requireFounderApproval` in `resolveInstallDecision`

**Context:**
`MarketplaceSettings` (in `packages/shared/src/marketplace.ts`) has `requireFounderApproval: boolean` (default `false`). When `true`, team leads who would normally get `"allow"` should instead get `"request"` — only founders bypass this gate. The function `resolveInstallDecision` currently accepts only `{ allowTeamLeadPlugins, teamMemberCanRequestInstall }` in its settings parameter and never reads `requireFounderApproval`.

The call site in `marketplace-installs.ts` line 159 passes the full `MarketplaceSettings` object, so the setting is available — it just isn't threaded into the function.

**Files:**
- Modify: `server/src/routes/marketplace-installs.ts:67-75` (`resolveInstallDecision` function)
- Modify: `server/src/__tests__/marketplace-installs-request.test.ts` (extend existing tests)

- [ ] **Step 1: Write the failing tests**

Add these tests inside the existing `describe("resolveInstallDecision", ...)` block in `server/src/__tests__/marketplace-installs-request.test.ts`:

```typescript
  describe("requireFounderApproval", () => {
    const strictSettings = {
      allowTeamLeadPlugins: true,
      teamMemberCanRequestInstall: true,
      requireFounderApproval: true,
    };

    it("returns 'request' for team_lead when requireFounderApproval=true", () => {
      expect(resolveInstallDecision("team_lead", "skill", strictSettings)).toBe("request");
    });

    it("returns 'request' for team_lead on plugin when requireFounderApproval=true (even if allowTeamLeadPlugins=true)", () => {
      expect(resolveInstallDecision("team_lead", "plugin", strictSettings)).toBe("request");
    });

    it("returns 'allow' for founder even when requireFounderApproval=true", () => {
      expect(resolveInstallDecision("founder", "skill", strictSettings)).toBe("allow");
    });

    it("returns 'allow' for team_lead when requireFounderApproval=false", () => {
      const noApproval = { ...strictSettings, requireFounderApproval: false };
      expect(resolveInstallDecision("team_lead", "skill", noApproval)).toBe("allow");
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd "C:\Users\TK\OneDrive\Desktop\Claude Data\Paperclip-AoA\AoA-2.5\.claude\worktrees\marketplace-v1"
pnpm --filter server test -- --reporter=verbose marketplace-installs-request
```

Expected: the 4 new `requireFounderApproval` tests FAIL — `resolveInstallDecision` doesn't accept `requireFounderApproval` in its settings parameter yet.

- [ ] **Step 3: Implement the fix**

In `server/src/routes/marketplace-installs.ts`, replace `resolveInstallDecision` (lines 67–75) with:

```typescript
/**
 * Resolve the install access decision for a role + type + settings combination.
 * Returns:
 *   "allow"   — proceed with install
 *   "request" — needs approval: team_member with request permission, OR
 *               team_lead when requireFounderApproval=true
 *   "deny"    — insufficient permissions: return 403
 */
export function resolveInstallDecision(
  role: string,
  type: string,
  settings: {
    allowTeamLeadPlugins: boolean;
    teamMemberCanRequestInstall: boolean;
    requireFounderApproval: boolean;
  },
): "allow" | "request" | "deny" {
  if (role === "founder") return "allow";
  if (settings.requireFounderApproval && role === "team_lead") return "request";
  if (canInstallType(role, type, settings.allowTeamLeadPlugins)) return "allow";
  if (role === "team_member" && settings.teamMemberCanRequestInstall) return "request";
  return "deny";
}
```

The call site at line 159 already passes the full `MarketplaceSettings` object (which includes `requireFounderApproval`), so no change is needed there.

Also update two places in `marketplace-installs-request.test.ts`:

**a) The pure-function test `settings` constant** — add `requireFounderApproval: false`:
```typescript
const settings = { allowTeamLeadPlugins: false, teamMemberCanRequestInstall: true, requireFounderApproval: false };
```

**b) The `marketplaceSettingsService` mock** — add `requireFounderApproval: false`:
```typescript
get: vi.fn().mockResolvedValue({
  allowTeamLeadPlugins: false,
  teamMemberCanRequestInstall: true,
  requireFounderApproval: false,
}),
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter server test -- --reporter=verbose marketplace-installs-request
```

Expected: all tests pass (the existing 14 + 4 new = 18 total).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/marketplace-installs.ts \
        server/src/__tests__/marketplace-installs-request.test.ts
git commit -m "fix(marketplace): honor requireFounderApproval in resolveInstallDecision

When requireFounderApproval=true, team leads now get decision='request'
instead of 'allow', routing them through the founder-approval flow.
Founders always retain direct install access."
```

---

## Task 2: Add `"requested"` terminal status for request-path operations

**Context:**
When `decision === "request"`, the route creates an operation row with `status: "pending"` and returns without dispatching an installer. That row stays `"pending"` forever. Clients polling `GET /install/:operationId` until a terminal state loop indefinitely.

The fix: add `"requested"` as a valid status value (TypeScript-only — no DB migration needed because the column is `text().$type<>()` with no check constraint), then immediately transition the request-path operation to `status: "requested"` + `completedAt: now`. Polling clients see a terminal state and stop.

**Files:**
- Modify: `packages/db/src/schema/marketplace_install_operations.ts:39`
- Modify: `server/src/services/marketplace-install/operation-store.ts:26` (`OperationRow.status`) and `:96-105` (`updateOperation` patch type)
- Modify: `server/src/routes/marketplace-installs.ts` (request path: add `updateOperation` call)
- Modify: `server/src/__tests__/marketplace-installs-request.test.ts` (update status assertion)

- [ ] **Step 1: Write the failing test**

In `server/src/__tests__/marketplace-installs-request.test.ts`, update the existing response-shape test and add a new one:

Find the test `"returns 202 with operationId and queued:true"` and change the status assertion from:
```typescript
expect(res.body.status).toBe("pending");
```
to:
```typescript
expect(res.body.status).toBe("requested");
```

Also add `updateOperation` to the mocked index module so we can assert it was called. At the top of the route tests section, add to the `vi.mock("../services/marketplace-install/index.js", ...)` factory:

```typescript
updateOperation: vi.fn().mockResolvedValue(undefined),
```

And add this import alongside the existing ones:
```typescript
import { updateOperation } from "../services/marketplace-install/index.js";
```

Add this new test in the route describe block:
```typescript
  it("transitions the operation to status='requested' so polling clients see a terminal state", async () => {
    const app = buildApp();
    await request(app)
      .post("/api/companies/c1/marketplace/install")
      .send({ catalogItemId: "skill:aoa-curated/code-review" });

    expect(updateOperation).toHaveBeenCalledOnce();
    const [, patch] = vi.mocked(updateOperation).mock.calls[0];
    expect(patch.status).toBe("requested");
    expect(patch.completedAt).toBeInstanceOf(Date);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --filter server test -- --reporter=verbose marketplace-installs-request
```

Expected: the status assertion (`"requested"`) fails, and the `updateOperation` call assertion fails.

- [ ] **Step 3: Add `"requested"` to the schema type**

In `packages/db/src/schema/marketplace_install_operations.ts`, change line 39 from:

```typescript
    status: text("status").$type<"pending" | "running" | "success" | "failure">().notNull().default("pending"),
```

to:

```typescript
    status: text("status").$type<"pending" | "running" | "success" | "failure" | "requested">().notNull().default("pending"),
```

No migration needed — `$type<>()` is TypeScript-only and the DB column has no check constraint.

- [ ] **Step 4: Update `OperationRow.status` and patch type in `operation-store.ts`**

In `server/src/services/marketplace-install/operation-store.ts`:

Change line 26:
```typescript
  status: "pending" | "running" | "success" | "failure";
```
to:
```typescript
  status: "pending" | "running" | "success" | "failure" | "requested";
```

Change the `updateOperation` patch type at line 96:
```typescript
export async function updateOperation(
  db: Db,
  id: string,
  patch: Partial<Pick<OperationRow, "status" | "resultEntityId" | "errorMessage" | "cascadeResults" | "completedAt">>,
): Promise<void> {
```
(No change needed here — `status` is already in the Pick, and `OperationRow.status` now includes `"requested"`.)

- [ ] **Step 5: Update the request path in `marketplace-installs.ts`**

After creating the operation in the `decision === "request"` block, add an `updateOperation` call. The `updateOperation` function is already exported from `../services/marketplace-install/index.js` (via `operation-store.ts`).

First, add `updateOperation` to the existing import in `marketplace-installs.ts`:

```typescript
import {
  startInstallOperation,
  dispatchInstall,
  installSkill,
  installAgent,
  installTeam,
  installMarketplacePlugin,
  findOperationById,
  updateOperation,
  type Installers,
} from "../services/marketplace-install/index.js";
```

Then, after the `requestedOp` is created and before the notification is fired, add the status transition (fire-and-forget like the notification — DB error here shouldn't block the 202 response):

Replace the current request block:
```typescript
        void marketplaceNotifications
          .installRequested(db, companyId, catalogItem.name, userId, requestedOp.id)
          .catch((err) => logger.error({ err }, "marketplace installRequested notification failed"));
        res.status(202).json({
          queued: true,
          operationId: requestedOp.id,
          status: requestedOp.status,
          message: "Install request submitted. A founder will review it.",
        });
        return;
```

With:
```typescript
        // Transition to terminal "requested" status so polling clients stop waiting.
        // Fire-and-forget — a failure here is logged but doesn't block the 202 response.
        void updateOperation(db, requestedOp.id, {
          status: "requested",
          completedAt: new Date(),
        }).catch((err) => logger.error({ err }, "marketplace: failed to set status=requested"));

        void marketplaceNotifications
          .installRequested(db, companyId, catalogItem.name, userId, requestedOp.id)
          .catch((err) => logger.error({ err }, "marketplace installRequested notification failed"));
        res.status(202).json({
          queued: true,
          operationId: requestedOp.id,
          status: "requested",
          message: "Install request submitted. A founder will review it.",
        });
        return;
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
pnpm --filter server test -- --reporter=verbose marketplace-installs-request
```

Expected: all tests pass (should be 19 or 20 total: 18 from Task 1 + 2 new).

Run the full server suite to check for regressions:
```bash
pnpm --filter server test
```

Expected: same or fewer failures than baseline (~31 files / ~28 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/schema/marketplace_install_operations.ts \
        server/src/services/marketplace-install/operation-store.ts \
        server/src/routes/marketplace-installs.ts \
        server/src/__tests__/marketplace-installs-request.test.ts
git commit -m "fix(marketplace): add 'requested' terminal status for install-request operations

Request-path operations stayed pending forever, causing polling clients to
loop indefinitely. Add 'requested' as a valid status value (TypeScript-only,
no migration needed) and immediately transition the operation after creation
so polling clients see a terminal state and stop."
```

---

## Task 3: Fix duplicate `##` headers in `computeSectionDiff`

**Context:**
`splitSections` returns a `Section[]` with ALL sections including duplicates. `computeSectionDiff` then does:

```typescript
const mineSections = new Map(splitSections(mine).map((s) => [s.header, s]));
```

If a markdown has two `## Examples` sections, the second silently overwrites the first in the Map. The first section's content is dropped in all merge operations.

The fix: add a `deduplicateHeaders` helper that makes header keys unique by appending ` [2]`, ` [3]` etc. to repeated headers before Map construction. Both `mine` and `theirs` use the same deduplication logic, so the n-th occurrence of `## Examples` in mine is correctly matched against the n-th occurrence in theirs.

**Files:**
- Modify: `server/src/services/marketplace-merge.ts`
- Create: `server/src/__tests__/marketplace-merge.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `server/src/__tests__/marketplace-merge.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { splitSections, computeSectionDiff, applyMergeDecisions } from "../services/marketplace-merge.js";

describe("splitSections", () => {
  it("returns a preamble section for content before first ##", () => {
    const md = "intro text\n## Section A\ncontent A";
    const sections = splitSections(md);
    expect(sections[0].header).toBe("__preamble__");
    expect(sections[0].content).toBe("intro text");
    expect(sections[1].header).toBe("Section A");
  });

  it("returns ALL sections including duplicates", () => {
    const md = "## Examples\nfirst\n## Examples\nsecond";
    const sections = splitSections(md);
    expect(sections).toHaveLength(3); // preamble + 2 × Examples
    expect(sections[1].header).toBe("Examples");
    expect(sections[2].header).toBe("Examples");
  });

  it("returns single preamble when no ## headers", () => {
    const md = "just text here";
    const sections = splitSections(md);
    expect(sections).toHaveLength(1);
    expect(sections[0].header).toBe("__preamble__");
  });
});

describe("computeSectionDiff — unique headers", () => {
  it("marks unchanged sections correctly", () => {
    const mine = "## Overview\nSame text";
    const theirs = "## Overview\nSame text";
    const diff = computeSectionDiff(mine, theirs);
    const overview = diff.find((d) => d.header === "Overview" || d.header.startsWith("Overview"));
    expect(overview?.state).toBe("unchanged");
  });

  it("marks changed sections correctly", () => {
    const mine = "## Overview\nOld text";
    const theirs = "## Overview\nNew text";
    const diff = computeSectionDiff(mine, theirs);
    const overview = diff.find((d) => d.header === "Overview" || d.header.startsWith("Overview"));
    expect(overview?.state).toBe("changed");
    expect(overview?.mine).toContain("Old text");
    expect(overview?.theirs).toContain("New text");
  });

  it("marks added sections (in theirs but not mine)", () => {
    const mine = "## Overview\ntext";
    const theirs = "## Overview\ntext\n## Usage\nnew section";
    const diff = computeSectionDiff(mine, theirs);
    const usage = diff.find((d) => d.header === "Usage" || d.header.startsWith("Usage"));
    expect(usage?.state).toBe("added");
  });

  it("marks removed sections (in mine but not theirs)", () => {
    const mine = "## Overview\ntext\n## Deprecated\nold stuff";
    const theirs = "## Overview\ntext";
    const diff = computeSectionDiff(mine, theirs);
    const deprecated = diff.find((d) => d.header === "Deprecated" || d.header.startsWith("Deprecated"));
    expect(deprecated?.state).toBe("removed");
  });
});

describe("computeSectionDiff — duplicate headers (the bug)", () => {
  it("preserves BOTH sections when mine has two sections with the same header", () => {
    const mine = "## Examples\nfirst example\n## Examples\nsecond example";
    const theirs = "## Examples\nfirst example\n## Examples\nthird example";
    const diff = computeSectionDiff(mine, theirs);

    // Should have 3 entries: preamble (unchanged/added) + Examples + Examples [2]
    // The first Examples should be unchanged, the second should be changed
    const exampleDiffs = diff.filter((d) => d.header.startsWith("Examples"));
    expect(exampleDiffs).toHaveLength(2);

    const first = exampleDiffs[0];
    const second = exampleDiffs[1];

    expect(first.state).toBe("unchanged");
    expect(second.state).toBe("changed");
    expect(second.mine).toContain("second example");
    expect(second.theirs).toContain("third example");
  });

  it("does NOT drop the first section when theirs has a single version of a duplicate header", () => {
    // mine has two ## Examples; theirs has one. First should match, second should be "removed".
    const mine = "## Examples\nfirst\n## Examples\nsecond";
    const theirs = "## Examples\nfirst";
    const diff = computeSectionDiff(mine, theirs);

    // preamble diff + Examples (unchanged) + Examples [2] (removed)
    const exampleDiffs = diff.filter((d) => d.header.startsWith("Examples"));
    expect(exampleDiffs).toHaveLength(2);
    expect(exampleDiffs[0].state).toBe("unchanged");
    expect(exampleDiffs[1].state).toBe("removed");
  });
});

describe("applyMergeDecisions", () => {
  it("keeps mine when decision is 'mine'", () => {
    const mine = "## Overview\nmy content";
    const theirs = "## Overview\ntheir content";
    const diff = computeSectionDiff(mine, theirs);
    const result = applyMergeDecisions(diff, { Overview: "mine" });
    expect(result).toContain("my content");
    expect(result).not.toContain("their content");
  });

  it("keeps theirs when decision is 'theirs'", () => {
    const mine = "## Overview\nmy content";
    const theirs = "## Overview\ntheir content";
    const diff = computeSectionDiff(mine, theirs);
    const result = applyMergeDecisions(diff, { Overview: "theirs" });
    expect(result).toContain("their content");
    expect(result).not.toContain("my content");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --filter server test -- --reporter=verbose marketplace-merge
```

Expected: the duplicate-headers tests FAIL (`exampleDiffs` has length 1, not 2).

The unique-header tests and `applyMergeDecisions` tests should PASS already (no bug there).

- [ ] **Step 3: Implement the fix in `marketplace-merge.ts`**

Add a `deduplicateHeaders` helper function after `splitSections`, and use it in `computeSectionDiff`:

```typescript
/**
 * Make section headers unique within an array by appending " [2]", " [3]", etc.
 * to repeated headers. This ensures duplicate ## headings in a markdown file
 * are each independently tracked in the diff Map, rather than the later one
 * silently overwriting the earlier one.
 *
 * The n-th occurrence of a header in mine is matched against the n-th occurrence
 * in theirs, which is the best-effort alignment for docs with repeated headings.
 */
export function deduplicateHeaders(sections: Section[]): Section[] {
  const counts = new Map<string, number>();
  return sections.map((s) => {
    const count = (counts.get(s.header) ?? 0) + 1;
    counts.set(s.header, count);
    return count === 1 ? s : { ...s, header: `${s.header} [${count}]` };
  });
}
```

Then update `computeSectionDiff` to use it. Replace lines 50–52:

```typescript
export function computeSectionDiff(mine: string, theirs: string): SectionDiff[] {
  const mineSections = new Map(splitSections(mine).map((s) => [s.header, s]));
  const theirSections = new Map(splitSections(theirs).map((s) => [s.header, s]));
```

With:

```typescript
export function computeSectionDiff(mine: string, theirs: string): SectionDiff[] {
  const mineSections = new Map(deduplicateHeaders(splitSections(mine)).map((s) => [s.header, s]));
  const theirSections = new Map(deduplicateHeaders(splitSections(theirs)).map((s) => [s.header, s]));
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter server test -- --reporter=verbose marketplace-merge
```

Expected: all tests pass. The duplicate-header tests should now show 2 entries.

- [ ] **Step 5: Run the full server suite**

```bash
pnpm --filter server test
```

Expected: same or fewer failures than baseline (~31 files / ~28 tests failing).

- [ ] **Step 6: Commit**

```bash
git add server/src/services/marketplace-merge.ts \
        server/src/__tests__/marketplace-merge.test.ts
git commit -m "fix(marketplace): preserve duplicate ## headers in computeSectionDiff

Map construction from header text silently dropped the first of any two
sections with identical headers. Add deduplicateHeaders() helper that
appends [2], [3] etc. to repeated headers before Map conversion so both
sections are independently tracked and diffed."
```
