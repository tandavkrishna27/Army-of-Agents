# Human Context Bundle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reusable, company-scoped Human Context Bundle that gives Commander and future crew orchestration a reliable view of a human's identity, role, reporting context, and capability documents.

**Architecture:** Add a new backend service that composes existing team/profile/role/dependency data with human capability documents. Expose it first through a board/debug REST endpoint and a Commander/internal-agent tool; defer broad worker-agent or external MCP exposure until auth/RBAC and agent tool access are clearer. Keep this distinct from Memory: it is operational profile context, not approved company memory.

**Tech Stack:** Express 5 routes, Drizzle/Postgres services, shared TypeScript contracts, Zod validators, internal-agent tool registry, React UI polish, Vitest, Playwright E2E.

---

## Scope Decisions

- All capability documents are included in the bundle, including custom docs.
- The bundle includes stable human context only:
  - identity/profile fields
  - role, department, reports-to, system-admin flag, explicit grants
  - reporting/dependency counts and direct report summaries
  - capability document metadata and content
- The bundle does not include full recent activity or task lists in v1.
- The bundle may include assigned/created task counts because those already exist in `MemberDependencies`.
- v1 access:
  - Board users with company access can preview/debug via REST.
  - Commander/internal-agent can read via a dedicated tool.
  - External MCP and ordinary worker agents are not exposed in v1.
- The Commander/internal-agent tool returns both the structured `HumanContextBundle` JSON and the rendered markdown, so future orchestration can choose between precise fields and prompt-ready context.
- UI polish for the Capabilities tab header height is included as a small prerequisite task because the current two-panel header alignment is visibly inconsistent.

## Investigation Summary

- Human profile and role data already live in `teamService.listTeam()` and are returned by `GET /companies/:companyId/team/users/:userId`.
- Human dependencies already live in `teamService.getDependencies()` and include direct human reports, direct agent trees, assigned task count, and created task count.
- Capability documents now live in `humanCapabilitiesService.listDocuments()`.
- Current MCP resources expose tasks, goals, memory, and artifacts, but not humans.
- Current internal-agent query tools expose tasks, goals, agents, departments, budget, activity, and company identity, but not human profiles.
- `context-packaging.ts` currently includes assigned agent configuration for task context but not human assignee/owner context.
- Decision #95 warns against broad worker-agent access until team-under-Commander tool access is concrete. Commander is already tool-based, so Commander is the right first consumer.

## File Structure

- Modify `packages/shared/src/types/team.ts`
  - Add `HumanContextBundle`, `HumanContextIdentity`, `HumanContextAuthority`, `HumanContextResponsibility`, and `HumanContextCapabilityDocument`.
- Modify `packages/shared/src/types/index.ts`, `packages/shared/src/index.ts`
  - Export the new types.
- Create `server/src/services/human-context.ts`
  - Compose profile, role, dependencies, and capability docs into one bundle.
  - Add `toMarkdown(bundle)` for agent prompt/tool display.
- Modify `server/src/services/index.ts`
  - Export `humanContextService`.
- Modify `server/src/routes/team.ts`
  - Add `GET /companies/:companyId/team/users/:userId/agent-context`.
- Create `server/src/__tests__/human-context-service.test.ts`
  - Unit coverage for bundle composition and markdown output.
- Create `server/src/__tests__/human-context-routes.test.ts`
  - Route coverage for board preview/debug access.
- Modify `server/src/services/internal-agent/tools/query-tools.ts`
  - Add Commander tool `query_human_context`.
- Modify `server/src/services/internal-agent/types.ts`
  - Add `humanContext` to the internal-agent `ServiceContainer`.
- Modify `server/src/services/internal-agent/service-container.ts`
  - Instantiate `humanContextService(db)` in the tool service container.
- Modify relevant internal-agent tests or create `server/src/__tests__/query-human-context-tool.test.ts`
  - Cover tool call shape and result summary.
- Modify `ui/src/pages/HumanDetail.tsx`
  - Normalize Capabilities left/right header height to 42px.
- Modify `tests/e2e/human-profile.spec.ts`
  - Keep panel height checks and add header-height alignment assertion.

---

## Task 1: Shared Human Context Contract

**Files:**
- Modify: `packages/shared/src/types/team.ts`
- Modify: `packages/shared/src/types/index.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Add shared types**

Add these interfaces in `packages/shared/src/types/team.ts` near the existing human capability types:

```ts
export interface HumanContextIdentity {
  userId: string;
  email: string | null;
  displayName: string | null;
  title: string | null;
  bio: string | null;
  location: string | null;
  timezone: string | null;
  socialLinks: HumanSocialLink[];
}

export interface HumanContextAuthority {
  role: UserRole;
  departmentId: string | null;
  departmentName: string | null;
  reportsToUserId: string | null;
  reportsToName: string | null;
  isSystemAdmin: boolean;
  explicitGrants: PermissionKey[];
}

export interface HumanContextResponsibility {
  directHumanReports: Array<{
    userId: string;
    displayName: string | null;
    email: string | null;
    role: UserRole;
  }>;
  directAgentTrees: Array<{
    rootAgentId: string;
    rootAgentName: string;
    subAgentCount: number;
    agentIds: string[];
  }>;
  assignedTaskCount: number;
  createdTaskCount: number;
}

export interface HumanContextCapabilityDocument {
  id: string;
  slug: string;
  filename: string;
  title: string;
  kind: HumanCapabilityDocumentKind;
  content: string;
  isStandard: boolean;
  updatedAt: Date;
  updatedByUserId: string | null;
}

export interface HumanContextBundle {
  companyId: string;
  userId: string;
  generatedAt: Date;
  identity: HumanContextIdentity;
  authority: HumanContextAuthority;
  responsibility: HumanContextResponsibility;
  capabilities: HumanContextCapabilityDocument[];
  markdown: string;
}
```

- [ ] **Step 2: Export the types**

Update `packages/shared/src/types/index.ts` and `packages/shared/src/index.ts` so the new interfaces are exported with the other team types.

- [ ] **Step 3: Run focused typecheck**

Run:

```powershell
pnpm --filter @armyofagents/shared typecheck
```

Expected: exits `0`.

---

## Task 2: Human Context Service

**Files:**
- Create: `server/src/services/human-context.ts`
- Modify: `server/src/services/index.ts`
- Test: `server/src/__tests__/human-context-service.test.ts`

- [ ] **Step 1: Write failing service test**

Create `server/src/__tests__/human-context-service.test.ts` with a mocked DB/service setup that proves:

```ts
expect(bundle.identity.displayName).toBe("Ada Lovelace");
expect(bundle.authority.role).toBe("team_lead");
expect(bundle.authority.departmentName).toBe("Product");
expect(bundle.authority.reportsToName).toBe("Grace Founder");
expect(bundle.responsibility.directHumanReports).toHaveLength(1);
expect(bundle.capabilities.map((doc) => doc.filename)).toContain("skills.md");
expect(bundle.markdown).toContain("## Identity");
expect(bundle.markdown).toContain("## Authority");
expect(bundle.markdown).toContain("## Capability Documents");
expect(bundle.markdown).toContain("Product strategy");
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
pnpm exec vitest run server/src/__tests__/human-context-service.test.ts
```

Expected: FAIL because `human-context.ts` does not exist.

- [ ] **Step 3: Implement `humanContextService`**

Create `server/src/services/human-context.ts`:

```ts
import type { Db } from "@armyofagents/db";
import type { HumanContextBundle } from "@armyofagents/shared";
import { notFound } from "../errors.js";
import { humanCapabilitiesService } from "./human-capabilities.js";
import { teamService } from "./team.js";

function line(value: string | null | undefined, fallback = "Not set") {
  return value && value.trim() ? value.trim() : fallback;
}

function renderHumanContextMarkdown(bundle: Omit<HumanContextBundle, "markdown">): string {
  const parts: string[] = [];
  parts.push("# Human Context");
  parts.push("## Identity");
  parts.push(`- Name: ${line(bundle.identity.displayName)}`);
  parts.push(`- Email: ${line(bundle.identity.email)}`);
  parts.push(`- Title: ${line(bundle.identity.title)}`);
  parts.push(`- Bio: ${line(bundle.identity.bio)}`);
  parts.push(`- Location: ${line(bundle.identity.location)}`);
  parts.push(`- Timezone: ${line(bundle.identity.timezone)}`);

  if (bundle.identity.socialLinks.length > 0) {
    parts.push("- Social links:");
    for (const link of bundle.identity.socialLinks) {
      parts.push(`  - ${line(link.label, link.type)}: ${link.url}`);
    }
  }

  parts.push("## Authority");
  parts.push(`- Role: ${bundle.authority.role}`);
  parts.push(`- Department: ${line(bundle.authority.departmentName)}`);
  parts.push(`- Reports to: ${line(bundle.authority.reportsToName)}`);
  parts.push(`- System admin: ${bundle.authority.isSystemAdmin ? "yes" : "no"}`);
  parts.push(`- Explicit grants: ${bundle.authority.explicitGrants.length ? bundle.authority.explicitGrants.join(", ") : "none"}`);

  parts.push("## Responsibilities");
  parts.push(`- Direct human reports: ${bundle.responsibility.directHumanReports.length}`);
  parts.push(`- Direct agent trees: ${bundle.responsibility.directAgentTrees.length}`);
  parts.push(`- Active assigned tasks: ${bundle.responsibility.assignedTaskCount}`);
  parts.push(`- Active created tasks: ${bundle.responsibility.createdTaskCount}`);

  parts.push("## Capability Documents");
  for (const doc of bundle.capabilities) {
    parts.push(`### ${doc.title} (${doc.filename})`);
    parts.push(doc.content.trim() ? doc.content.trim() : "_Empty document._");
  }

  return parts.join("\n");
}

export function humanContextService(db: Db) {
  const team = teamService(db);
  const capabilities = humanCapabilitiesService(db);

  async function getBundle(companyId: string, userId: string, actorUserId: string | null = null): Promise<HumanContextBundle> {
    const summary = await team.listTeam(companyId, actorUserId);
    const member = summary.members.find((row) => row.userId === userId);
    if (!member) throw notFound("Team member not found");

    const manager = member.parentId ? summary.members.find((row) => row.userId === member.parentId) : null;
    const dependencies = await team.getDependencies(companyId, userId);
    const capabilityBundle = await capabilities.listDocuments(companyId, userId, actorUserId);
    const generatedAt = new Date();

    const withoutMarkdown = {
      companyId,
      userId,
      generatedAt,
      identity: {
        userId,
        email: member.email,
        displayName: member.displayName,
        title: member.title,
        bio: member.bio,
        location: member.location,
        timezone: member.timezone,
        socialLinks: member.socialLinks,
      },
      authority: {
        role: member.role,
        departmentId: member.departmentId,
        departmentName: member.departmentName,
        reportsToUserId: member.parentId,
        reportsToName: manager?.displayName ?? manager?.email ?? null,
        isSystemAdmin: member.isSystemAdmin,
        explicitGrants: member.permissions,
      },
      responsibility: {
        directHumanReports: dependencies.teamMembers,
        directAgentTrees: dependencies.agentTrees,
        assignedTaskCount: dependencies.assignedTaskCount,
        createdTaskCount: dependencies.createdTaskCount,
      },
      capabilities: capabilityBundle.documents.map((doc) => ({
        id: doc.id,
        slug: doc.slug,
        filename: doc.filename,
        title: doc.title,
        kind: doc.kind,
        content: doc.content,
        isStandard: doc.isStandard,
        updatedAt: doc.updatedAt,
        updatedByUserId: doc.updatedByUserId,
      })),
    };

    return {
      ...withoutMarkdown,
      markdown: renderHumanContextMarkdown(withoutMarkdown),
    };
  }

  return { getBundle, renderHumanContextMarkdown };
}
```

- [ ] **Step 4: Export service**

Update `server/src/services/index.ts`:

```ts
export { humanContextService } from "./human-context.js";
```

- [ ] **Step 5: Run service test**

Run:

```powershell
pnpm exec vitest run server/src/__tests__/human-context-service.test.ts
```

Expected: PASS.

---

## Task 3: Board Preview REST Endpoint

**Files:**
- Modify: `server/src/routes/team.ts`
- Test: `server/src/__tests__/human-context-routes.test.ts`

- [ ] **Step 1: Write failing route test**

Create route tests proving:

```ts
await request(app)
  .get(`/api/companies/${companyId}/team/users/${targetUserId}/agent-context`)
  .expect(200);

expect(mockHumanContextService.getBundle).toHaveBeenCalledWith(companyId, targetUserId, "founder-1");
expect(res.body.bundle.markdown).toContain("## Capability Documents");
```

Also test:

```ts
await request(app)
  .get(`/api/companies/${otherCompanyId}/team/users/${targetUserId}/agent-context`)
  .expect(403);
```

- [ ] **Step 2: Run route test to verify it fails**

Run:

```powershell
pnpm exec vitest run server/src/__tests__/human-context-routes.test.ts
```

Expected: FAIL because route does not exist.

- [ ] **Step 3: Add route**

In `server/src/routes/team.ts`, import `humanContextService` from `services/index.js`, instantiate it next to `team` and `humanCapabilities`, and add:

```ts
router.get("/companies/:companyId/team/users/:userId/agent-context", async (req, res) => {
  const companyId = req.params.companyId as string;
  const userId = req.params.userId as string;
  assertCompanyAccess(req, companyId);
  if (req.actor.type !== "board") {
    res.status(403).json({ error: "Board authentication required" });
    return;
  }
  const actorUserId = req.actor.userId ?? null;
  const bundle = await humanContext.getBundle(companyId, userId, actorUserId);
  res.json({ bundle });
});
```

- [ ] **Step 4: Run route test**

Run:

```powershell
pnpm exec vitest run server/src/__tests__/human-context-routes.test.ts
```

Expected: PASS.

---

## Task 4: Commander/Internal-Agent Tool

**Files:**
- Modify: `server/src/services/internal-agent/tools/query-tools.ts`
- Test: `server/src/__tests__/query-human-context-tool.test.ts`

- [ ] **Step 1: Write failing tool test**

Add a test that creates query tools with a mocked context and executes:

```ts
const tool = createQueryTools().find((candidate) => candidate.name === "query_human_context");
const result = await tool!.execute({ userId: "user-1" }, ctx);
expect(result.success).toBe(true);
expect(result.data.identity.displayName).toBe("Ada Lovelace");
expect(result.data.markdown).toContain("## Authority");
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
pnpm exec vitest run server/src/__tests__/query-human-context-tool.test.ts
```

Expected: FAIL because tool does not exist.

- [ ] **Step 3: Add tool**

In `createQueryTools()`, add:

```ts
{
  name: "query_human_context",
  description: "Read a company human's operational context bundle: identity, authority, responsibilities, and capability documents. Intended for Commander and crew orchestration, not broad worker context injection.",
  parameters: {
    type: "object",
    properties: {
      userId: { type: "string", description: "Human user id to read" },
    },
    required: ["userId"],
  },
  category: "query",
  requiredRole: "team_member",
  requiresConfirmation: false,
  execute: async (params: unknown, ctx) => {
    const { userId } = (params ?? {}) as Record<string, unknown>;
    if (typeof userId !== "string" || !userId.trim()) {
      return { success: false, error: "userId is required", data: null, summary: "Missing userId" };
    }
    const bundle = await ctx.services.humanContext.getBundle(ctx.companyId, userId, ctx.userId ?? null);
    return {
      success: true,
      data: bundle,
      summary: `Human context loaded for ${bundle.identity.displayName ?? bundle.identity.email ?? bundle.userId}`,
    };
  },
}
```

- [ ] **Step 4: Add `humanContext` to the internal-agent service container**

In `server/src/services/internal-agent/types.ts`, import the service type:

```ts
import { humanContextService } from "../human-context.js";
```

Then add this field to `ServiceContainer`:

```ts
humanContext: ReturnType<typeof humanContextService>;
```

In `server/src/services/internal-agent/service-container.ts`, import:

```ts
import { humanContextService } from "../human-context.js";
```

Then add this field inside `createServiceContainer(db)`:

```ts
humanContext: humanContextService(db),
```

- [ ] **Step 5: Run tool test**

Run:

```powershell
pnpm exec vitest run server/src/__tests__/query-human-context-tool.test.ts
```

Expected: PASS.

---

## Task 5: Capabilities Header Polish

**Files:**
- Modify: `ui/src/pages/HumanDetail.tsx`
- Test: `tests/e2e/human-profile.spec.ts`

- [ ] **Step 1: Update markup/classes**

Make the document list header and document detail header use the same 42px height.

Use classes equivalent to:

```tsx
<div className="flex h-[42px] shrink-0 items-center justify-between gap-2 border-b border-border px-4">
```

For the left panel, remove duplicate outer header margin/padding so the `Documents` header aligns visually with the right panel.

- [ ] **Step 2: Keep scroll behavior**

Ensure the list body remains:

```tsx
<div className="min-h-0 flex-1 overflow-y-auto p-3">
```

Ensure the detail body remains:

```tsx
<div className="min-h-0 flex-1 overflow-auto p-4">
```

- [ ] **Step 3: Extend E2E assertion**

In `tests/e2e/human-profile.spec.ts`, after locating `capabilities-document-list` and `capabilities-document-detail`, assert header heights:

```ts
const listHeaderHeight = await documentListPanel.locator("[data-testid='capabilities-document-list-header']").evaluate((el) => el.getBoundingClientRect().height);
const detailHeaderHeight = await documentDetailPanel.locator("[data-testid='capabilities-document-detail-header']").evaluate((el) => el.getBoundingClientRect().height);
expect(Math.abs(listHeaderHeight - 42)).toBeLessThanOrEqual(1);
expect(Math.abs(detailHeaderHeight - 42)).toBeLessThanOrEqual(1);
```

- [ ] **Step 4: Run focused E2E**

Run:

```powershell
$env:AOA_E2E_FORCE_WINDOWS='1'; $env:AOA_E2E_PORT='3214'; pnpm test:e2e -- human-profile.spec.ts
```

Expected: PASS.

---

## Task 6: Focused Verification

**Files:**
- All files touched above.

- [ ] **Step 1: Run focused backend tests**

Run:

```powershell
pnpm exec vitest run server/src/__tests__/human-context-service.test.ts server/src/__tests__/human-context-routes.test.ts server/src/__tests__/query-human-context-tool.test.ts server/src/__tests__/human-capabilities-service.test.ts server/src/__tests__/human-capabilities-routes.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run shared and server typecheck**

Run:

```powershell
pnpm --filter @armyofagents/shared typecheck
pnpm --filter @armyofagents/server typecheck
pnpm --filter @armyofagents/ui typecheck
```

Expected: all exit `0`.

- [ ] **Step 3: Run focused E2E**

Run:

```powershell
$env:AOA_E2E_FORCE_WINDOWS='1'; $env:AOA_E2E_PORT='3214'; pnpm test:e2e -- human-profile.spec.ts
```

Expected: PASS.

- [ ] **Step 4: Run full handoff checks**

Run:

```powershell
pnpm -r typecheck
pnpm test:run
pnpm build
```

Expected: all exit `0`.

---

## Out Of Scope

- No new DB migration for v1 human context bundle.
- No broad external MCP resource/tool for humans yet.
- No ordinary worker-agent exposure until worker tool access is designed.
- No indexing human capabilities into Memory.
- No recent activity or full task list in the bundle.
- No privacy labels per document yet.

## Review Notes

- The service boundary is the most important part. It prevents REST, Commander tools, and future MCP from each inventing their own human context shape.
- The bundle intentionally includes role/authority because agents need to know who owns, approves, and manages work.
- The bundle intentionally includes all capability docs because custom docs are part of the human knowledge surface.
- Access is deliberately narrow in v1: board preview plus Commander/internal-agent. This matches the user's concern that ordinary agents should not all get broad human profile context by default.
- Later scopes can add:
  - `find_humans_by_capability`
  - external MCP `get-human-context`
  - document-level visibility flags
  - activity/work-state bundle
  - task context injection for human assignee/creator/manager
