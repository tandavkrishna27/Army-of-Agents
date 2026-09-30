# Team Management Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add direct member creation, system admin role, invite lifecycle (resend/revoke), human detail page, reassignment-before-removal flow, org tree ghost nodes, and activity logging to the team management system.

**Architecture:** Extend `companyMemberships` with `isSystemAdmin` boolean flag. Add `POST /team/members` for direct-add, `POST /invites/:id/resend` and `PATCH /invites/:id/revoke` for invite lifecycle. New `HumanDetail` page at `/team/:userId` with Overview + Settings tabs. Removal flow blocks until all reports (humans individually, agent trees in bulk) are reassigned. Pending invites render as ghost nodes in org tree.

**Tech Stack:** Drizzle ORM (PostgreSQL), Express, React, TailwindCSS, Vitest, React Query

---

## File Structure

### New Files
- `ui/src/pages/HumanDetail.tsx` — Human detail page with Overview + Settings tabs
- `ui/src/components/team/AddMemberDialog.tsx` — Direct-add form + invite link toggle (replaces InviteDialog)
- `ui/src/components/team/ReassignmentDialog.tsx` — Reassignment dialog for removal flow
- `ui/src/components/team/TransferAdminDialog.tsx` — System admin transfer confirmation dialog
- `server/src/__tests__/team-direct-add.test.ts` — Tests for direct member creation
- `server/src/__tests__/team-system-admin.test.ts` — Tests for system admin logic
- `server/src/__tests__/team-invite-lifecycle.test.ts` — Tests for resend/revoke

### Modified Files
- `packages/db/src/schema/company_memberships.ts` — Add `isSystemAdmin` boolean column
- `packages/db/src/schema/index.ts` — Re-export if needed (verify)
- `packages/shared/src/types/team.ts` — Add `isSystemAdmin` to `TeamMemberSummary`, add `AddMemberInput` type, update `TeamInviteSummary`
- `packages/shared/src/validators/team.ts` — Add `addMemberSchema`, `transferAdminSchema`
- `packages/shared/src/validators/index.ts` — Re-export new validators
- `packages/shared/src/types/index.ts` — Re-export new types
- `server/src/services/team.ts` — Add `addMember()`, `transferAdmin()`, `getReportsFor()`, `getDependencies()`, `reassignAndRemove()`
- `server/src/services/access.ts` — Add `resendInvite()`, `revokeInvite()`
- `server/src/routes/team.ts` — Add `POST /team/members`, `POST /team/transfer-admin`, `GET /team/users/:userId`, `GET /team/users/:userId/dependencies`, `POST /team/users/:userId/reassign-and-remove`
- `server/src/routes/access.ts` — Add `POST /invites/:id/resend`, `PATCH /invites/:id/revoke`
- `ui/src/api/team.ts` — Add `addMember()`, `transferAdmin()`, `getMember()`, `getDependencies()`, `reassignAndRemove()`
- `ui/src/api/access.ts` — Add `resendInvite()`, `revokeInvite()`
- `ui/src/App.tsx` — Add routes for `/team/:userId` and `/team/:userId/:tab`
- `ui/src/pages/TeamPage.tsx` — Pass system admin info to HumansTab
- `ui/src/components/team/HumansTab.tsx` — Replace InviteDialog with AddMemberDialog, add system admin badge, transfer admin action, update removal flow to use ReassignmentDialog, add resend/revoke to pending invites
- `ui/src/components/team/OrgTreeTab.tsx` — Add ghost nodes for pending invites, add kebab menu to nodes
- `ui/src/components/InviteDialog.tsx` — Deprecated (replaced by AddMemberDialog)
- `ui/src/lib/queryKeys.ts` — Add `team.member`, `team.dependencies` query keys

---

## Task 1: Add `isSystemAdmin` Column to `companyMemberships`

**Files:**
- Modify: `packages/db/src/schema/company_memberships.ts`
- Test: `server/src/__tests__/team-system-admin.test.ts`

- [ ] **Step 1: Write the failing test for system admin flag**

```typescript
// server/src/__tests__/team-system-admin.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────
vi.mock("@armyofagents/db", () => {
  const makeTable = (name: string) => {
    const cols: Record<string, symbol> = {};
    return new Proxy({} as Record<string, unknown>, {
      get(_target, prop) {
        if (prop === "_") return { name };
        if (prop === "$inferSelect" || prop === "$inferInsert") return {};
        if (typeof prop === "string") {
          if (!cols[prop]) cols[prop] = Symbol(`${name}.${prop}`);
          return cols[prop];
        }
        return undefined;
      },
    });
  };
  return {
    companyMemberships: makeTable("company_memberships"),
    authUsers: makeTable("auth_users"),
    userRoles: makeTable("user_roles"),
    instanceUserRoles: makeTable("instance_user_roles"),
    principalPermissionGrants: makeTable("principal_permission_grants"),
    projects: makeTable("projects"),
    invites: makeTable("invites"),
  };
});

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  ne: vi.fn((a: unknown, b: unknown) => ({ ne: [a, b] })),
  or: vi.fn((...args: unknown[]) => args),
  desc: vi.fn((a: unknown) => ({ desc: a })),
  count: vi.fn((a: unknown) => ({ count: a })),
  isNull: vi.fn((a: unknown) => ({ isNull: a })),
  sql: Object.assign(
    vi.fn((strings: unknown, ...values: unknown[]) => ({ sql: strings, values })),
    { raw: vi.fn((s: unknown) => s) },
  ),
}));

describe("system admin", () => {
  it("isSystemAdmin field exists on membership type", () => {
    // This validates the schema has the column
    const { companyMemberships } = require("@armyofagents/db");
    expect(companyMemberships.isSystemAdmin).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/__tests__/team-system-admin.test.ts --reporter=verbose`
Expected: FAIL — `companyMemberships.isSystemAdmin` is undefined (column doesn't exist yet)

- [ ] **Step 3: Add `isSystemAdmin` column to schema**

```typescript
// packages/db/src/schema/company_memberships.ts
// Add this column after the existing `parentId` column:
  isSystemAdmin: boolean("is_system_admin").default(false).notNull(),
```

- [ ] **Step 4: Generate the migration**

Run: `pnpm db:generate`
Expected: A new migration file appears in `packages/db/src/migrations/` with `ALTER TABLE "company_memberships" ADD COLUMN "is_system_admin" boolean DEFAULT false NOT NULL`

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && npx vitest run src/__tests__/team-system-admin.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema/company_memberships.ts packages/db/src/migrations/ server/src/__tests__/team-system-admin.test.ts
git commit -m "feat(db): add isSystemAdmin column to companyMemberships"
```

---

## Task 2: Add System Admin Service Logic

**Files:**
- Modify: `server/src/services/team.ts`
- Test: `server/src/__tests__/team-system-admin.test.ts`

- [ ] **Step 1: Write failing tests for system admin service functions**

Append to `server/src/__tests__/team-system-admin.test.ts`:

```typescript
import { teamService } from "../services/team.js";

// ── Sequence DB helper ──────────────────────────────────────────────────
function createSequenceDb(config: { selects?: unknown[][]; updates?: unknown[][]; inserts?: unknown[][] } = {}) {
  let selectIdx = 0;
  let updateIdx = 0;

  function makeChain(getResult: () => unknown[]) {
    const chain: Record<string, unknown> = {};
    for (const m of ["from", "where", "set", "values", "returning", "innerJoin", "leftJoin", "orderBy", "limit", "delete"]) {
      chain[m] = (..._args: unknown[]) => chain;
    }
    chain.then = (resolve: (v: unknown[]) => unknown) => Promise.resolve(resolve(getResult()));
    return chain;
  }

  return {
    select: (..._args: unknown[]) => makeChain(() => (config.selects ?? [])[selectIdx++] ?? []),
    update: (..._args: unknown[]) => makeChain(() => (config.updates ?? [])[updateIdx++] ?? []),
    insert: (..._args: unknown[]) => makeChain(() => (config.inserts ?? [])[0] ?? []),
    delete: (..._args: unknown[]) => makeChain(() => []),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
      select: (..._args: unknown[]) => makeChain(() => []),
      update: (..._args: unknown[]) => makeChain(() => []),
      insert: (..._args: unknown[]) => makeChain(() => []),
      delete: (..._args: unknown[]) => makeChain(() => []),
    }),
  };
}

describe("teamService.isSystemAdmin", () => {
  it("returns true when membership has isSystemAdmin=true", async () => {
    const db = createSequenceDb({
      selects: [[{ isSystemAdmin: true }]],
    });
    const team = teamService(db as any);
    const result = await team.isCompanySystemAdmin("company-1", "user-1");
    expect(result).toBe(true);
  });

  it("returns false when membership has isSystemAdmin=false", async () => {
    const db = createSequenceDb({
      selects: [[{ isSystemAdmin: false }]],
    });
    const team = teamService(db as any);
    const result = await team.isCompanySystemAdmin("company-1", "user-1");
    expect(result).toBe(false);
  });

  it("returns false when no membership exists", async () => {
    const db = createSequenceDb({ selects: [[]] });
    const team = teamService(db as any);
    const result = await team.isCompanySystemAdmin("company-1", "user-1");
    expect(result).toBe(false);
  });
});

describe("teamService.transferAdmin", () => {
  it("throws when current user is not system admin", async () => {
    const db = createSequenceDb({
      selects: [[{ isSystemAdmin: false }]], // current user check
    });
    const team = teamService(db as any);
    await expect(team.transferAdmin("company-1", "from-user", "to-user"))
      .rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run src/__tests__/team-system-admin.test.ts --reporter=verbose`
Expected: FAIL — `team.isCompanySystemAdmin` and `team.transferAdmin` don't exist

- [ ] **Step 3: Implement system admin functions in team service**

Add to `server/src/services/team.ts`:

```typescript
    isCompanySystemAdmin: async (companyId: string, userId: string | null | undefined): Promise<boolean> => {
      if (!userId) return false;
      const rows = await db
        .select({ isSystemAdmin: companyMemberships.isSystemAdmin })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, userId),
            eq(companyMemberships.status, "active"),
          ),
        )
        .limit(1);
      return rows[0]?.isSystemAdmin === true;
    },

    assertSystemAdmin: async (companyId: string, userId: string | null | undefined): Promise<void> => {
      const isAdmin = await self.isCompanySystemAdmin(companyId, userId);
      if (!isAdmin) throw conflict("Only the system admin can perform this action");
    },

    transferAdmin: async (companyId: string, fromUserId: string, toUserId: string): Promise<void> => {
      await self.assertSystemAdmin(companyId, fromUserId);

      // Verify target is a founder
      const targetRole = await self.getUserRole(companyId, toUserId);
      if (targetRole.role !== "founder") {
        throw conflict("System admin can only be transferred to a founder");
      }

      await db.transaction(async (tx) => {
        // Remove admin from current
        await tx
          .update(companyMemberships)
          .set({ isSystemAdmin: false, updatedAt: new Date() })
          .where(
            and(
              eq(companyMemberships.companyId, companyId),
              eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.principalId, fromUserId),
            ),
          );
        // Grant admin to target
        await tx
          .update(companyMemberships)
          .set({ isSystemAdmin: true, updatedAt: new Date() })
          .where(
            and(
              eq(companyMemberships.companyId, companyId),
              eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.principalId, toUserId),
            ),
          );
      });
    },
```

Note: `self` refers to the returned service object. Match the existing pattern in the file where the service object references itself.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/__tests__/team-system-admin.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/services/team.ts server/src/__tests__/team-system-admin.test.ts
git commit -m "feat(team): add system admin service functions"
```

---

## Task 3: Update Shared Types and Validators for Direct Add

**Files:**
- Modify: `packages/shared/src/types/team.ts`
- Modify: `packages/shared/src/validators/team.ts`
- Modify: `packages/shared/src/validators/index.ts`
- Modify: `packages/shared/src/types/index.ts`

- [ ] **Step 1: Add new types to `packages/shared/src/types/team.ts`**

Add after the existing `TeamSummary` interface:

```typescript
export interface AddMemberInput {
  name: string;
  email: string;
  role: UserRole;
  projectId?: string | null;
  parentType?: "user" | null;
  parentId?: string | null;
}

export interface TransferAdminInput {
  toUserId: string;
  confirmation: string; // must be "TRANSFER"
}

export interface MemberDependencies {
  teamMembers: Array<{ userId: string; displayName: string | null; email: string | null; role: UserRole }>;
  agentTrees: Array<{ rootAgentId: string; rootAgentName: string; subAgentCount: number }>;
  assignedTaskCount: number;
  createdTaskCount: number;
}

export interface ReassignAndRemoveInput {
  humanReassignments: Array<{ userId: string; newParentId: string | null }>;
  agentReassignments: Array<{ agentId: string; newParentId: string; newParentType: "user" }>;
}
```

Update `TeamMemberSummary` — add field:

```typescript
  isSystemAdmin: boolean;
```

Update `TeamInviteSummary` — add field:

```typescript
  reportsToId: string | null;
  reportsToName: string | null;
```

- [ ] **Step 2: Add new validators to `packages/shared/src/validators/team.ts`**

```typescript
import { USER_ROLES } from "../constants.js";

export const addMemberSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email().max(320),
  role: z.enum(USER_ROLES),
  projectId: z.string().uuid().nullable().optional(),
  parentType: z.enum(["user"]).nullable().optional(),
  parentId: z.string().nullable().optional(),
});

export const transferAdminSchema = z.object({
  toUserId: z.string().min(1),
  confirmation: z.literal("TRANSFER"),
});

export const reassignAndRemoveSchema = z.object({
  humanReassignments: z.array(z.object({
    userId: z.string(),
    newParentId: z.string().nullable(),
  })),
  agentReassignments: z.array(z.object({
    agentId: z.string(),
    newParentId: z.string(),
    newParentType: z.literal("user"),
  })),
});
```

- [ ] **Step 3: Re-export from index files**

In `packages/shared/src/validators/index.ts`, add:

```typescript
export { addMemberSchema, transferAdminSchema, reassignAndRemoveSchema } from "./team.js";
```

In `packages/shared/src/types/index.ts`, verify these types are re-exported (they should be if `team.ts` is already exported with `export *`). If not, add:

```typescript
export type { AddMemberInput, TransferAdminInput, MemberDependencies, ReassignAndRemoveInput } from "./team.js";
```

- [ ] **Step 4: Verify build**

Run: `cd packages/shared && pnpm build`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types/team.ts packages/shared/src/validators/team.ts packages/shared/src/validators/index.ts packages/shared/src/types/index.ts
git commit -m "feat(shared): add types and validators for direct add, transfer admin, reassignment"
```

---

## Task 4: Direct Member Add — Backend Service

**Files:**
- Modify: `server/src/services/team.ts`
- Test: `server/src/__tests__/team-direct-add.test.ts`

- [ ] **Step 1: Write failing test for addMember**

```typescript
// server/src/__tests__/team-direct-add.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@armyofagents/db", () => {
  const makeTable = (name: string) => {
    const cols: Record<string, symbol> = {};
    return new Proxy({} as Record<string, unknown>, {
      get(_target, prop) {
        if (prop === "_") return { name };
        if (prop === "$inferSelect" || prop === "$inferInsert") return {};
        if (typeof prop === "string") {
          if (!cols[prop]) cols[prop] = Symbol(`${name}.${prop}`);
          return cols[prop];
        }
        return undefined;
      },
    });
  };
  return {
    companyMemberships: makeTable("company_memberships"),
    authUsers: makeTable("auth_users"),
    userRoles: makeTable("user_roles"),
    instanceUserRoles: makeTable("instance_user_roles"),
    principalPermissionGrants: makeTable("principal_permission_grants"),
    projects: makeTable("projects"),
    invites: makeTable("invites"),
  };
});

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  ne: vi.fn((a: unknown, b: unknown) => ({ ne: [a, b] })),
  or: vi.fn((...args: unknown[]) => args),
  desc: vi.fn((a: unknown) => ({ desc: a })),
  count: vi.fn((a: unknown) => ({ count: a })),
  isNull: vi.fn((a: unknown) => ({ isNull: a })),
  sql: Object.assign(
    vi.fn((strings: unknown, ...values: unknown[]) => ({ sql: strings, values })),
    { raw: vi.fn((s: unknown) => s) },
  ),
}));

// Mock org-hierarchy
vi.mock("../services/org-hierarchy.js", () => ({
  orgHierarchyService: {
    assertNoCycle: vi.fn().mockResolvedValue(undefined),
    ensureParent: vi.fn().mockResolvedValue(undefined),
    orphanChildren: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock access service
vi.mock("../services/access.js", () => ({
  accessService: vi.fn(() => ({
    setPrincipalGrants: vi.fn().mockResolvedValue(undefined),
    ensureMembership: vi.fn().mockResolvedValue({ id: "mem-1" }),
  })),
}));

import { teamService } from "../services/team.js";

describe("teamService.addMember", () => {
  it("is a function on the service", () => {
    const team = teamService({} as any);
    expect(typeof team.addMember).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/__tests__/team-direct-add.test.ts --reporter=verbose`
Expected: FAIL — `team.addMember` is undefined

- [ ] **Step 3: Implement addMember in team service**

Add to `server/src/services/team.ts`:

```typescript
    addMember: async (
      companyId: string,
      input: { name: string; email: string; role: UserRole; projectId?: string | null; parentType?: "user" | null; parentId?: string | null },
      addedByUserId: string,
    ): Promise<{ userId: string }> => {
      // Only founders can add members
      await self.assertFounder(companyId, addedByUserId);

      // Only system admin can add founders
      if (input.role === "founder") {
        await self.assertSystemAdmin(companyId, addedByUserId);
      }

      // Check if email already exists in this company
      const existingMembers = await db
        .select({ principalId: companyMemberships.principalId })
        .from(companyMemberships)
        .innerJoin(authUsers, eq(companyMemberships.principalId, authUsers.id))
        .where(
          and(
            eq(companyMemberships.companyId, companyId),
            eq(companyMemberships.principalType, "user"),
            eq(authUsers.email, input.email),
          ),
        );
      if (existingMembers.length > 0) {
        throw conflict("A team member with this email already exists in this company");
      }

      // Check if user exists globally by email
      const existingUsers = await db
        .select({ id: authUsers.id })
        .from(authUsers)
        .where(eq(authUsers.email, input.email))
        .limit(1);

      let userId: string;

      if (existingUsers.length > 0) {
        userId = existingUsers[0].id;
      } else {
        // Create new auth user
        const newUserId = crypto.randomUUID();
        await db.insert(authUsers).values({
          id: newUserId,
          email: input.email,
          name: input.name,
          displayName: input.name,
          invitedBy: addedByUserId,
          invitedAt: new Date(),
          emailVerified: false,
        });
        userId = newUserId;
      }

      // Create membership
      const access = accessService(db);
      await access.ensureMembership(companyId, "user", userId, input.role ?? "team_member", "active");

      // Set parent if provided
      if (input.parentId) {
        await db
          .update(companyMemberships)
          .set({
            parentType: input.parentType ?? "user",
            parentId: input.parentId,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(companyMemberships.companyId, companyId),
              eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.principalId, userId),
            ),
          );
      }

      // Create role
      await self.updateUserRole(
        companyId,
        userId,
        {
          role: input.role,
          projectId: input.role === "founder" ? null : (input.projectId ?? null),
          parentType: input.parentType,
          parentId: input.parentId,
        },
        addedByUserId,
      );

      return { userId };
    },
```

Add the import for `accessService` at the top of the file if not already present:

```typescript
import { accessService } from "./access.js";
```

And add `crypto` import if not present:

```typescript
import crypto from "node:crypto";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/__tests__/team-direct-add.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/services/team.ts server/src/__tests__/team-direct-add.test.ts
git commit -m "feat(team): add direct member creation service"
```

---

## Task 5: Direct Member Add — Backend Route

**Files:**
- Modify: `server/src/routes/team.ts`

- [ ] **Step 1: Add POST /team/members route**

Add to `server/src/routes/team.ts` after the existing `router.get` handler:

```typescript
  router.post(
    "/companies/:companyId/team/members",
    validate(addMemberSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      if (req.actor.type !== "board" || !req.actor.userId) {
        res.status(403).json({ error: "Board authentication required" });
        return;
      }
      await team.assertFounder(companyId, req.actor.userId);

      const result = await team.addMember(
        companyId,
        {
          name: req.body.name,
          email: req.body.email,
          role: req.body.role,
          projectId: req.body.projectId ?? null,
          parentType: req.body.parentType ?? null,
          parentId: req.body.parentId ?? null,
        },
        req.actor.userId,
      );

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId,
        action: "team.member_added",
        entityType: "user_role",
        entityId: result.userId,
        details: {
          name: req.body.name,
          email: req.body.email,
          role: req.body.role,
        },
      });

      res.status(201).json(result);
    },
  );
```

Update the import at the top of the file:

```typescript
import { updateTeamMemberRoleSchema, addMemberSchema } from "@armyofagents/shared";
```

- [ ] **Step 2: Verify build**

Run: `cd server && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/team.ts
git commit -m "feat(routes): add POST /team/members for direct add"
```

---

## Task 6: System Admin — Transfer Route & Bootstrap Logic

**Files:**
- Modify: `server/src/routes/team.ts`
- Modify: `server/src/services/team.ts`
- Modify: `server/src/services/access.ts` (bootstrap auto-assign)

- [ ] **Step 1: Add transfer admin route**

Add to `server/src/routes/team.ts`:

```typescript
  router.post(
    "/companies/:companyId/team/transfer-admin",
    validate(transferAdminSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      if (req.actor.type !== "board" || !req.actor.userId) {
        res.status(403).json({ error: "Board authentication required" });
        return;
      }

      await team.transferAdmin(companyId, req.actor.userId, req.body.toUserId);

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId,
        action: "team.admin_transferred",
        entityType: "user_role",
        entityId: req.body.toUserId,
        details: { fromUserId: req.actor.userId },
      });

      res.json({ ok: true });
    },
  );
```

Update import:

```typescript
import { updateTeamMemberRoleSchema, addMemberSchema, transferAdminSchema } from "@armyofagents/shared";
```

- [ ] **Step 2: Add isSystemAdmin to listTeam response**

In `server/src/services/team.ts`, update the `listTeam` function. Where it builds member summaries, add `isSystemAdmin` from the membership row. In the membership query, add the `isSystemAdmin` field to the select:

Find where members are mapped from rows and add `isSystemAdmin: membershipRow.isSystemAdmin ?? false` to each `TeamMemberSummary`.

- [ ] **Step 3: Auto-assign system admin on company creation**

In `server/src/services/access.ts`, find the bootstrap/company-creation flow (where the first founder membership is created). After the membership is created, update it to set `isSystemAdmin: true`:

```typescript
// After ensureMembership for the first founder/bootstrap:
await db
  .update(companyMemberships)
  .set({ isSystemAdmin: true })
  .where(
    and(
      eq(companyMemberships.companyId, companyId),
      eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.principalId, userId),
    ),
  );
```

- [ ] **Step 4: Enforce system admin constraints on role changes**

In `server/src/services/team.ts`, update the `updateUserRole` function. Before the existing last-founder check, add:

```typescript
// Only system admin can assign/remove founder role
if (input.role === "founder" || currentRole.role === "founder") {
  const isAdmin = await self.isCompanySystemAdmin(companyId, grantedByUserId);
  if (!isAdmin) {
    throw conflict("Only the system admin can assign or change founder roles");
  }
}
```

And in `removeMember`, add:

```typescript
// Cannot remove system admin — must transfer first
const isTargetAdmin = await self.isCompanySystemAdmin(companyId, userId);
if (isTargetAdmin) {
  throw conflict("Cannot remove the system admin. Transfer admin rights first.");
}
```

- [ ] **Step 5: Verify build**

Run: `cd server && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/team.ts server/src/services/team.ts server/src/services/access.ts
git commit -m "feat(team): add system admin transfer, bootstrap, and role constraints"
```

---

## Task 7: Invite Lifecycle — Resend & Revoke Backend

**Files:**
- Modify: `server/src/services/access.ts`
- Modify: `server/src/routes/access.ts`
- Test: `server/src/__tests__/team-invite-lifecycle.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// server/src/__tests__/team-invite-lifecycle.test.ts
import { describe, it, expect, vi } from "vitest";

vi.mock("@armyofagents/db", () => {
  const makeTable = (name: string) => {
    const cols: Record<string, symbol> = {};
    return new Proxy({} as Record<string, unknown>, {
      get(_target, prop) {
        if (prop === "_") return { name };
        if (prop === "$inferSelect" || prop === "$inferInsert") return {};
        if (typeof prop === "string") {
          if (!cols[prop]) cols[prop] = Symbol(`${name}.${prop}`);
          return cols[prop];
        }
        return undefined;
      },
    });
  };
  return {
    invites: makeTable("invites"),
    companyMemberships: makeTable("company_memberships"),
    authUsers: makeTable("auth_users"),
    instanceUserRoles: makeTable("instance_user_roles"),
    principalPermissionGrants: makeTable("principal_permission_grants"),
  };
});

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  ne: vi.fn((a: unknown, b: unknown) => ({ ne: [a, b] })),
  or: vi.fn((...args: unknown[]) => args),
  isNull: vi.fn((a: unknown) => ({ isNull: a })),
  desc: vi.fn((a: unknown) => ({ desc: a })),
  sql: Object.assign(
    vi.fn((strings: unknown, ...values: unknown[]) => ({ sql: strings, values })),
    { raw: vi.fn((s: unknown) => s) },
  ),
}));

import { accessService } from "../services/access.js";

describe("invite lifecycle", () => {
  it("revokeInvite is a function", () => {
    const access = accessService({} as any);
    expect(typeof access.revokeInvite).toBe("function");
  });

  it("resendInvite is a function", () => {
    const access = accessService({} as any);
    expect(typeof access.resendInvite).toBe("function");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run src/__tests__/team-invite-lifecycle.test.ts --reporter=verbose`
Expected: FAIL — functions don't exist

- [ ] **Step 3: Implement revokeInvite and resendInvite**

Add to `server/src/services/access.ts`:

```typescript
    revokeInvite: async (companyId: string, inviteId: string): Promise<void> => {
      const rows = await db
        .select()
        .from(invites)
        .where(
          and(
            eq(invites.id, inviteId),
            eq(invites.companyId, companyId),
          ),
        )
        .limit(1);

      if (rows.length === 0) throw notFound("Invite not found");
      const invite = rows[0];
      if (invite.revokedAt) throw conflict("Invite already revoked");
      if (invite.acceptedAt) throw conflict("Invite already accepted");

      await db
        .update(invites)
        .set({ revokedAt: new Date(), updatedAt: new Date() })
        .where(eq(invites.id, inviteId));
    },

    resendInvite: async (companyId: string, inviteId: string): Promise<{ token: string; inviteUrl: string; expiresAt: Date }> => {
      // Find the existing invite
      const rows = await db
        .select()
        .from(invites)
        .where(
          and(
            eq(invites.id, inviteId),
            eq(invites.companyId, companyId),
          ),
        )
        .limit(1);

      if (rows.length === 0) throw notFound("Invite not found");
      const invite = rows[0];
      if (invite.acceptedAt) throw conflict("Invite already accepted");

      // Revoke the old invite
      await db
        .update(invites)
        .set({ revokedAt: new Date(), updatedAt: new Date() })
        .where(eq(invites.id, inviteId));

      // Create a new invite with same payload
      const token = crypto.randomUUID().slice(0, 8);
      const tokenHash = createHash("sha256").update(token).digest("hex");
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

      const newRows = await db
        .insert(invites)
        .values({
          companyId,
          inviteType: invite.inviteType,
          tokenHash,
          allowedJoinTypes: invite.allowedJoinTypes,
          defaultsPayload: invite.defaultsPayload,
          expiresAt,
          invitedByUserId: invite.invitedByUserId,
        })
        .returning();

      const baseUrl = process.env.PUBLIC_URL ?? "http://localhost:5173";
      const inviteUrl = `${baseUrl}/invite/${token}`;

      return { token, inviteUrl, expiresAt };
    },
```

Ensure imports for `crypto` (createHash) are present in access.ts. Check existing usage — the file likely already has them since it creates invites.

- [ ] **Step 4: Add routes**

Add to `server/src/routes/access.ts`:

```typescript
  router.patch("/companies/:companyId/invites/:inviteId/revoke", async (req, res) => {
    const companyId = req.params.companyId as string;
    const inviteId = req.params.inviteId as string;
    assertCompanyAccess(req, companyId);
    if (req.actor.type !== "board" || !req.actor.userId) {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    // Only founders can revoke
    const team = teamService(db);
    await team.assertFounder(companyId, req.actor.userId);

    await access.revokeInvite(companyId, inviteId);

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "team.invite_revoked",
      entityType: "invite",
      entityId: inviteId,
      details: {},
    });

    res.json({ ok: true });
  });

  router.post("/companies/:companyId/invites/:inviteId/resend", async (req, res) => {
    const companyId = req.params.companyId as string;
    const inviteId = req.params.inviteId as string;
    assertCompanyAccess(req, companyId);
    if (req.actor.type !== "board" || !req.actor.userId) {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    const team = teamService(db);
    await team.assertFounder(companyId, req.actor.userId);

    const result = await access.resendInvite(companyId, inviteId);

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "team.invite_resent",
      entityType: "invite",
      entityId: inviteId,
      details: {},
    });

    res.json(result);
  });
```

Add the `teamService` import in access.ts if not already present.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && npx vitest run src/__tests__/team-invite-lifecycle.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/src/services/access.ts server/src/routes/access.ts server/src/__tests__/team-invite-lifecycle.test.ts
git commit -m "feat(access): add invite resend and revoke endpoints"
```

---

## Task 8: Dependencies & Reassignment Service

**Files:**
- Modify: `server/src/services/team.ts`
- Modify: `server/src/routes/team.ts`

- [ ] **Step 1: Implement getReportsFor and getDependencies**

Add to `server/src/services/team.ts`:

```typescript
    getReportsFor: async (companyId: string, userId: string): Promise<{
      teamMembers: Array<{ userId: string; displayName: string | null; email: string | null; role: string }>;
      agentTrees: Array<{ rootAgentId: string; rootAgentName: string; subAgentCount: number }>;
    }> => {
      // Find humans reporting to this user
      const humanReports = await db
        .select({
          userId: companyMemberships.principalId,
          displayName: authUsers.displayName,
          email: authUsers.email,
          role: userRoles.role,
        })
        .from(companyMemberships)
        .innerJoin(authUsers, eq(companyMemberships.principalId, authUsers.id))
        .leftJoin(
          userRoles,
          and(eq(userRoles.companyId, companyId), eq(userRoles.userId, companyMemberships.principalId)),
        )
        .where(
          and(
            eq(companyMemberships.companyId, companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.parentType, "user"),
            eq(companyMemberships.parentId, userId),
            eq(companyMemberships.status, "active"),
          ),
        );

      // Find agents directly reporting to this user
      const directAgents = await db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(
          and(
            eq(agents.companyId, companyId),
            eq(agents.parentType, "user"),
            eq(agents.parentId, userId),
            ne(agents.status, "terminated"),
          ),
        );

      // For each direct agent, count sub-agents recursively
      // Simple approach: count agents whose parentType=agent and parentId=directAgent.id
      // For deeper trees, we do a BFS
      const agentTrees: Array<{ rootAgentId: string; rootAgentName: string; subAgentCount: number }> = [];

      for (const agent of directAgents) {
        let subCount = 0;
        const queue = [agent.id];
        const visited = new Set<string>();
        while (queue.length > 0) {
          const parentId = queue.shift()!;
          if (visited.has(parentId)) continue;
          visited.add(parentId);
          const children = await db
            .select({ id: agents.id })
            .from(agents)
            .where(
              and(
                eq(agents.companyId, companyId),
                eq(agents.parentType, "agent"),
                eq(agents.parentId, parentId),
                ne(agents.status, "terminated"),
              ),
            );
          subCount += children.length;
          for (const child of children) {
            queue.push(child.id);
          }
        }
        agentTrees.push({ rootAgentId: agent.id, rootAgentName: agent.name, subAgentCount: subCount });
      }

      return { teamMembers: humanReports, agentTrees };
    },

    getDependencies: async (companyId: string, userId: string): Promise<MemberDependencies> => {
      const reports = await self.getReportsFor(companyId, userId);

      // Count assigned tasks
      const assignedRows = await db
        .select({ cnt: count() })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.assigneeId, userId),
            ne(issues.status, "done"),
            ne(issues.status, "cancelled"),
          ),
        );

      // Count created tasks
      const createdRows = await db
        .select({ cnt: count() })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.creatorId, userId),
            ne(issues.status, "done"),
            ne(issues.status, "cancelled"),
          ),
        );

      return {
        teamMembers: reports.teamMembers.map((m) => ({
          userId: m.userId,
          displayName: m.displayName,
          email: m.email,
          role: (m.role as UserRole) ?? "team_member",
        })),
        agentTrees: reports.agentTrees,
        assignedTaskCount: Number(assignedRows[0]?.cnt ?? 0),
        createdTaskCount: Number(createdRows[0]?.cnt ?? 0),
      };
    },
```

Add import for `agents`, `issues`, `count` at the top if not already present:

```typescript
import { agents, issues } from "@armyofagents/db";
import { count } from "drizzle-orm";
```

- [ ] **Step 2: Implement reassignAndRemove**

Add to `server/src/services/team.ts`:

```typescript
    reassignAndRemove: async (
      companyId: string,
      userId: string,
      input: { humanReassignments: Array<{ userId: string; newParentId: string | null }>; agentReassignments: Array<{ agentId: string; newParentId: string; newParentType: "user" }> },
      removedByUserId: string,
    ): Promise<void> => {
      // Cannot remove system admin
      const isTargetAdmin = await self.isCompanySystemAdmin(companyId, userId);
      if (isTargetAdmin) {
        throw conflict("Cannot remove the system admin. Transfer admin rights first.");
      }

      await db.transaction(async (tx) => {
        // Reassign human reports
        for (const reassignment of input.humanReassignments) {
          await tx
            .update(companyMemberships)
            .set({
              parentType: reassignment.newParentId ? "user" : null,
              parentId: reassignment.newParentId,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(companyMemberships.companyId, companyId),
                eq(companyMemberships.principalType, "user"),
                eq(companyMemberships.principalId, reassignment.userId),
              ),
            );
        }

        // Reassign agent trees (top-level only — sub-agents stay with their parent agent)
        for (const reassignment of input.agentReassignments) {
          await tx
            .update(agents)
            .set({
              parentType: reassignment.newParentType,
              parentId: reassignment.newParentId,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(agents.id, reassignment.agentId),
                eq(agents.companyId, companyId),
              ),
            );
        }

        // Now remove the member (delete roles, permissions, membership)
        await tx.delete(userRoles).where(
          and(eq(userRoles.companyId, companyId), eq(userRoles.userId, userId)),
        );
        await tx.delete(principalPermissionGrants).where(
          and(
            eq(principalPermissionGrants.companyId, companyId),
            eq(principalPermissionGrants.principalType, "user"),
            eq(principalPermissionGrants.principalId, userId),
          ),
        );
        await tx.delete(companyMemberships).where(
          and(
            eq(companyMemberships.companyId, companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, userId),
          ),
        );
      });
    },
```

- [ ] **Step 3: Add routes for dependencies and reassign-and-remove**

Add to `server/src/routes/team.ts`:

```typescript
  router.get("/companies/:companyId/team/users/:userId/dependencies", async (req, res) => {
    const companyId = req.params.companyId as string;
    const userId = req.params.userId as string;
    assertCompanyAccess(req, companyId);
    const deps = await team.getDependencies(companyId, userId);
    res.json(deps);
  });

  router.post(
    "/companies/:companyId/team/users/:userId/reassign-and-remove",
    validate(reassignAndRemoveSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const userId = req.params.userId as string;
      assertCompanyAccess(req, companyId);
      if (req.actor.type !== "board" || !req.actor.userId) {
        res.status(403).json({ error: "Board authentication required" });
        return;
      }
      await team.assertFounder(companyId, req.actor.userId);

      await team.reassignAndRemove(companyId, userId, req.body, req.actor.userId);

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId,
        action: "team.member_removed",
        entityType: "user_role",
        entityId: userId,
        details: { reassigned: true },
      });

      res.json({ ok: true });
    },
  );
```

Update import:

```typescript
import { updateTeamMemberRoleSchema, addMemberSchema, transferAdminSchema, reassignAndRemoveSchema } from "@armyofagents/shared";
```

- [ ] **Step 4: Add GET /team/users/:userId for human detail**

Add to `server/src/routes/team.ts`:

```typescript
  router.get("/companies/:companyId/team/users/:userId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const userId = req.params.userId as string;
    assertCompanyAccess(req, companyId);

    const summary = await team.listTeam(companyId, req.actor.type === "board" ? req.actor.userId ?? null : null);
    const member = summary.members.find((m) => m.userId === userId);
    if (!member) {
      res.status(404).json({ error: "Team member not found" });
      return;
    }

    const deps = await team.getDependencies(companyId, userId);
    res.json({ member, dependencies: deps });
  });
```

- [ ] **Step 5: Verify build**

Run: `cd server && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add server/src/services/team.ts server/src/routes/team.ts
git commit -m "feat(team): add dependencies, reassignment, and member detail endpoints"
```

---

## Task 9: Frontend API Client Updates

**Files:**
- Modify: `ui/src/api/team.ts`
- Modify: `ui/src/api/access.ts`
- Modify: `ui/src/lib/queryKeys.ts`

- [ ] **Step 1: Update team API client**

Add to `ui/src/api/team.ts`:

```typescript
import type { AddMemberInput, TransferAdminInput, MemberDependencies, ReassignAndRemoveInput, TeamMemberSummary } from "@armyofagents/shared";

// Add to existing teamApi object:
  addMember: (companyId: string, input: AddMemberInput) =>
    api.post<{ userId: string }>(`/companies/${companyId}/team/members`, input),

  getMember: (companyId: string, userId: string) =>
    api.get<{ member: TeamMemberSummary & { isSystemAdmin: boolean }; dependencies: MemberDependencies }>(
      `/companies/${companyId}/team/users/${userId}`,
    ),

  getDependencies: (companyId: string, userId: string) =>
    api.get<MemberDependencies>(`/companies/${companyId}/team/users/${userId}/dependencies`),

  transferAdmin: (companyId: string, input: TransferAdminInput) =>
    api.post<{ ok: true }>(`/companies/${companyId}/team/transfer-admin`, input),

  reassignAndRemove: (companyId: string, userId: string, input: ReassignAndRemoveInput) =>
    api.post<{ ok: true }>(`/companies/${companyId}/team/users/${userId}/reassign-and-remove`, input),
```

- [ ] **Step 2: Update access API client**

Add to `ui/src/api/access.ts`:

```typescript
  revokeInvite: (companyId: string, inviteId: string) =>
    api.patch<{ ok: true }>(`/companies/${companyId}/invites/${inviteId}/revoke`),

  resendInvite: (companyId: string, inviteId: string) =>
    api.post<{ token: string; inviteUrl: string; expiresAt: string }>(
      `/companies/${companyId}/invites/${inviteId}/resend`,
    ),
```

- [ ] **Step 3: Update query keys**

Add to `ui/src/lib/queryKeys.ts` inside the `team` section:

```typescript
  team: {
    summary: (companyId: string) => ["team", companyId] as const,
    member: (companyId: string, userId: string) => ["team", companyId, "member", userId] as const,
    dependencies: (companyId: string, userId: string) => ["team", companyId, "dependencies", userId] as const,
  },
```

- [ ] **Step 4: Verify build**

Run: `cd ui && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add ui/src/api/team.ts ui/src/api/access.ts ui/src/lib/queryKeys.ts
git commit -m "feat(ui): update API clients for team management enhancements"
```

---

## Task 10: AddMemberDialog Component

**Files:**
- Create: `ui/src/components/team/AddMemberDialog.tsx`

- [ ] **Step 1: Create the AddMemberDialog**

```typescript
// ui/src/components/team/AddMemberDialog.tsx
import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Project, UserRole, TeamMemberSummary } from "@armyofagents/shared";
import { teamApi } from "../../api/team";
import { accessApi } from "../../api/access";
import { queryKeys } from "../../lib/queryKeys";
import { useToast } from "../../context/ToastContext";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface AddMemberDialogProps {
  companyId: string;
  departments: Project[];
  members: TeamMemberSummary[];
  isSystemAdmin: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AddMemberDialog({
  companyId,
  departments,
  members,
  isSystemAdmin,
  open,
  onOpenChange,
}: AddMemberDialogProps) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  // Form state
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<UserRole>("team_member");
  const [departmentId, setDepartmentId] = useState<string>("none");
  const [parentId, setParentId] = useState<string>("none");

  // Toggle for invite link mode
  const [inviteMode, setInviteMode] = useState(false);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);

  const departmentOptions = useMemo(
    () => departments.filter((d) => d.type === "department"),
    [departments],
  );

  const parentOptions = useMemo(
    () => members.filter((m) => m.role !== "team_member" || role === "team_member"),
    [members, role],
  );

  const addMutation = useMutation({
    mutationFn: () =>
      teamApi.addMember(companyId, {
        name: name.trim(),
        email: email.trim(),
        role,
        projectId: departmentId !== "none" ? departmentId : null,
        parentType: parentId !== "none" ? "user" : null,
        parentId: parentId !== "none" ? parentId : null,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.team.summary(companyId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.org.tree(companyId) });
      pushToast({ title: `${name.trim()} added to team`, tone: "success" });
      onOpenChange(false);
      reset();
    },
    onError: (err: Error) => {
      pushToast({ title: err.message || "Failed to add member", tone: "error" });
    },
  });

  const inviteMutation = useMutation({
    mutationFn: () =>
      accessApi.createCompanyInvite(companyId, {
        allowedJoinTypes: "human",
        defaultsPayload: {
          human: {
            grants:
              role === "team_lead"
                ? [
                    { permissionKey: "tasks:assign" },
                    ...(departmentId !== "none"
                      ? [{ permissionKey: "tasks:assign_scope", scope: { projectId: departmentId } }]
                      : []),
                  ]
                : [],
          },
          teamInvite: {
            email: email.trim(),
            role,
            projectId: departmentId !== "none" ? departmentId : null,
          },
        },
      }),
    onSuccess: async (result) => {
      setInviteUrl(result.inviteUrl);
      await queryClient.invalidateQueries({ queryKey: queryKeys.team.summary(companyId) });
      pushToast({ title: "Invite created", body: email.trim(), tone: "success" });
    },
  });

  function reset() {
    setName("");
    setEmail("");
    setRole("team_member");
    setDepartmentId("none");
    setParentId("none");
    setInviteMode(false);
    setInviteUrl(null);
  }

  async function copyInviteLink() {
    if (!inviteUrl) return;
    await navigator.clipboard.writeText(inviteUrl);
    pushToast({ title: "Invite link copied", tone: "success" });
  }

  const isValid = name.trim().length > 0 && email.trim().length > 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);
        if (!nextOpen) reset();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{inviteMode ? "Invite Team Member" : "Add Team Member"}</DialogTitle>
          <DialogDescription>
            {inviteMode
              ? "Generate an invite link for the new team member."
              : "Add a new person directly to your team."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {!inviteMode && (
            <div className="space-y-1.5">
              <Label htmlFor="add-member-name">Name</Label>
              <Input
                id="add-member-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Full name"
              />
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="add-member-email">Email</Label>
            <Input
              id="add-member-email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="person@company.com"
              type="email"
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Role</Label>
              <Select value={role} onValueChange={(v) => setRole(v as UserRole)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {isSystemAdmin && <SelectItem value="founder">Founder</SelectItem>}
                  <SelectItem value="team_lead">Team Lead</SelectItem>
                  <SelectItem value="team_member">Team Member</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Department</Label>
              <Select
                value={departmentId}
                onValueChange={setDepartmentId}
                disabled={role === "founder"}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Optional" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No department</SelectItem>
                  {departmentOptions.map((d) => (
                    <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {!inviteMode && role !== "founder" && (
            <div className="space-y-1.5">
              <Label>Reports to</Label>
              <Select value={parentId} onValueChange={setParentId}>
                <SelectTrigger>
                  <SelectValue placeholder="No manager" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No manager (root)</SelectItem>
                  {parentOptions.map((m) => (
                    <SelectItem key={m.userId} value={m.userId}>
                      {m.displayName ?? m.email ?? m.userId.slice(0, 8)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {inviteUrl && (
            <div className="space-y-1.5 rounded-lg border border-border bg-muted/30 p-3">
              <Label htmlFor="invite-link">Invite Link</Label>
              <Input id="invite-link" readOnly value={inviteUrl} />
              <Button variant="outline" size="sm" onClick={copyInviteLink}>
                Copy link
              </Button>
            </div>
          )}

          {/* Toggle between modes */}
          <div className="pt-1">
            <button
              type="button"
              className="text-xs text-muted-foreground underline hover:text-foreground transition-colors"
              onClick={() => {
                setInviteMode(!inviteMode);
                setInviteUrl(null);
              }}
            >
              {inviteMode ? "Add directly instead" : "Send invite link instead"}
            </button>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => { onOpenChange(false); reset(); }}
          >
            Cancel
          </Button>
          {inviteMode ? (
            <Button
              onClick={() => inviteMutation.mutate()}
              disabled={inviteMutation.isPending || !email.trim()}
            >
              {inviteMutation.isPending ? "Sending..." : "Send Invite"}
            </Button>
          ) : (
            <Button
              onClick={() => addMutation.mutate()}
              disabled={addMutation.isPending || !isValid}
            >
              {addMutation.isPending ? "Adding..." : "Add Member"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Verify build**

Run: `cd ui && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/team/AddMemberDialog.tsx
git commit -m "feat(ui): add AddMemberDialog with direct-add and invite toggle"
```

---

## Task 11: Update HumansTab — Replace InviteDialog, Add Admin Features

**Files:**
- Modify: `ui/src/components/team/HumansTab.tsx`

- [ ] **Step 1: Replace InviteDialog with AddMemberDialog**

In `ui/src/components/team/HumansTab.tsx`:

Replace the `InviteDialog` import:

```typescript
// Remove: import { InviteDialog } from "../InviteDialog";
import { AddMemberDialog } from "./AddMemberDialog";
```

Update the `HumansTabProps` interface to include system admin info:

```typescript
interface HumansTabProps {
  teamSummary: TeamSummary;
  highlightId?: string | null;
  permissions: TeamPermissionSummary;
  isSystemAdmin: boolean;
  onMutationSuccess?: () => void;
}
```

Replace the InviteDialog usage at the bottom of the component with:

```typescript
<AddMemberDialog
  companyId={selectedCompanyId}
  departments={departments}
  members={members}
  isSystemAdmin={isSystemAdmin}
  open={inviteOpen}
  onOpenChange={setInviteOpen}
/>
```

Update the button text from "Invite teammate" to "Add Member":

```typescript
<Button onClick={() => setInviteOpen(true)} disabled={!permissions.canInviteUsers}>
  <UserPlus className="mr-1.5 h-4 w-4" />
  Add Member
</Button>
```

- [ ] **Step 2: Add system admin badge to MemberCard**

In the `MemberCard` component, after the role badge, add:

```typescript
{member.isSystemAdmin && (
  <Badge variant="outline" className="text-[11px] border-amber-500 text-amber-700 dark:text-amber-300">
    Admin
  </Badge>
)}
```

Import `Shield` from lucide-react if you want an icon variant.

- [ ] **Step 3: Add resend/revoke buttons to pending invites**

Replace the pending invites section with:

```typescript
{pendingInvites.length > 0 && (
  <div className="rounded-2xl border border-border bg-card p-5">
    <h2 className="text-sm font-semibold">Pending invites</h2>
    <div className="mt-3 space-y-2">
      {pendingInvites.map((invite) => (
        <div
          key={invite.id}
          className="flex flex-col gap-1 rounded-lg border border-border/80 px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between"
        >
          <div>
            <div className="font-medium">{invite.email ?? "Pending invite"}</div>
            <div className="text-xs text-muted-foreground">
              {ROLE_LABELS[invite.role]} · {invite.departmentName ?? "No department"}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              Expires {new Date(invite.expiresAt).toLocaleString()}
            </span>
            {permissions.canInviteUsers && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => handleResend(invite.id)}
                  disabled={resendMutation.isPending}
                >
                  Resend
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs text-destructive hover:text-destructive"
                  onClick={() => handleRevoke(invite.id)}
                  disabled={revokeMutation.isPending}
                >
                  Revoke
                </Button>
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  </div>
)}
```

Add the resend/revoke mutations and handlers:

```typescript
const resendMutation = useMutation({
  mutationFn: (inviteId: string) => accessApi.resendInvite(selectedCompanyId!, inviteId),
  onSuccess: async (result) => {
    await invalidateTeam();
    await navigator.clipboard.writeText(result.inviteUrl);
    pushToast({ title: "Invite resent — link copied", tone: "success" });
  },
  onError: () => pushToast({ title: "Failed to resend invite", tone: "error" }),
});

const revokeMutation = useMutation({
  mutationFn: (inviteId: string) => accessApi.revokeInvite(selectedCompanyId!, inviteId),
  onSuccess: async () => {
    await invalidateTeam();
    pushToast({ title: "Invite revoked", tone: "success" });
  },
  onError: () => pushToast({ title: "Failed to revoke invite", tone: "error" }),
});

const handleResend = (inviteId: string) => resendMutation.mutate(inviteId);
const handleRevoke = (inviteId: string) => revokeMutation.mutate(inviteId);
```

Add import:

```typescript
import { accessApi } from "../../api/access";
```

- [ ] **Step 4: Verify build**

Run: `cd ui && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/team/HumansTab.tsx
git commit -m "feat(ui): update HumansTab with AddMemberDialog, admin badge, invite lifecycle"
```

---

## Task 12: Update TeamPage to Pass System Admin Info

**Files:**
- Modify: `ui/src/pages/TeamPage.tsx`

- [ ] **Step 1: Pass isSystemAdmin to HumansTab**

In `TeamPage.tsx`, derive `isSystemAdmin` from the team summary and pass it:

```typescript
const isSystemAdmin = teamSummary?.currentUser?.isSystemAdmin ?? false;
```

Wait — `isSystemAdmin` is on members, not on currentUser. Update the approach: find current user in members list and check their `isSystemAdmin` flag. Or better, add it to `TeamCurrentUserSummary` type.

In `packages/shared/src/types/team.ts`, add to `TeamCurrentUserSummary`:

```typescript
  isSystemAdmin: boolean;
```

In `server/src/services/team.ts`, in the `listTeam` function where `currentUser` is built, add `isSystemAdmin` lookup from the membership row.

Then in `TeamPage.tsx`:

```typescript
const isSystemAdmin = teamSummary?.currentUser?.isSystemAdmin ?? false;
```

Pass to HumansTab:

```typescript
<HumansTab
  teamSummary={teamSummary}
  highlightId={highlightId}
  permissions={permissions}
  isSystemAdmin={isSystemAdmin}
  onMutationSuccess={invalidateAll}
/>
```

- [ ] **Step 2: Verify build**

Run: `cd ui && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add ui/src/pages/TeamPage.tsx packages/shared/src/types/team.ts server/src/services/team.ts
git commit -m "feat: pass isSystemAdmin through team summary to UI"
```

---

## Task 13: ReassignmentDialog Component

**Files:**
- Create: `ui/src/components/team/ReassignmentDialog.tsx`

- [ ] **Step 1: Create the ReassignmentDialog**

```typescript
// ui/src/components/team/ReassignmentDialog.tsx
import { useState, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MemberDependencies, TeamMemberSummary } from "@armyofagents/shared";
import { teamApi } from "../../api/team";
import { queryKeys } from "../../lib/queryKeys";
import { useToast } from "../../context/ToastContext";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface ReassignmentDialogProps {
  companyId: string;
  member: TeamMemberSummary;
  members: TeamMemberSummary[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

export function ReassignmentDialog({
  companyId,
  member,
  members,
  open,
  onOpenChange,
  onSuccess,
}: ReassignmentDialogProps) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const depsQuery = useQuery({
    queryKey: queryKeys.team.dependencies(companyId, member.userId),
    queryFn: () => teamApi.getDependencies(companyId, member.userId),
    enabled: open,
  });

  const deps = depsQuery.data;
  const hasReports = (deps?.teamMembers.length ?? 0) > 0 || (deps?.agentTrees.length ?? 0) > 0;

  // Reassignment state
  const [humanAssignments, setHumanAssignments] = useState<Record<string, string | null>>({});
  const [agentSelections, setAgentSelections] = useState<Record<string, boolean>>({});
  const [bulkAgentTarget, setBulkAgentTarget] = useState<string>("none");

  const eligibleManagers = useMemo(
    () => members.filter((m) => m.userId !== member.userId),
    [members, member.userId],
  );

  const selectedAgents = useMemo(
    () => (deps?.agentTrees ?? []).filter((a) => agentSelections[a.rootAgentId] !== false),
    [deps, agentSelections],
  );

  const canSubmit = useMemo(() => {
    if (!deps) return false;
    // All humans must have a target
    for (const tm of deps.teamMembers) {
      if (humanAssignments[tm.userId] === undefined) return false;
    }
    // If there are agent trees, bulk target must be set
    if (selectedAgents.length > 0 && bulkAgentTarget === "none") return false;
    return true;
  }, [deps, humanAssignments, selectedAgents, bulkAgentTarget]);

  const removeMutation = useMutation({
    mutationFn: () => {
      const humanReassignments = (deps?.teamMembers ?? []).map((tm) => ({
        userId: tm.userId,
        newParentId: humanAssignments[tm.userId] ?? null,
      }));

      const agentReassignments = selectedAgents.map((a) => ({
        agentId: a.rootAgentId,
        newParentId: bulkAgentTarget,
        newParentType: "user" as const,
      }));

      return teamApi.reassignAndRemove(companyId, member.userId, {
        humanReassignments,
        agentReassignments,
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.team.summary(companyId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.org.tree(companyId) });
      pushToast({ title: "Team member removed", tone: "success" });
      onOpenChange(false);
      onSuccess();
    },
    onError: (err: Error) => {
      pushToast({ title: err.message || "Failed to remove member", tone: "error" });
    },
  });

  const displayName = member.displayName ?? member.email ?? member.userId.slice(0, 8);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Remove {displayName}</DialogTitle>
          <DialogDescription>
            {hasReports
              ? `${displayName} has reports that need reassignment before removal.`
              : `Are you sure you want to remove ${displayName} from the team?`}
          </DialogDescription>
        </DialogHeader>

        {depsQuery.isLoading && (
          <div className="py-8 text-center text-sm text-muted-foreground">Loading dependencies...</div>
        )}

        {deps && (
          <div className="space-y-4 max-h-[400px] overflow-y-auto">
            {deps.teamMembers.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-sm font-semibold">Team Members</h3>
                {deps.teamMembers.map((tm) => (
                  <div key={tm.userId} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2">
                    <span className="text-sm flex-1">
                      {tm.displayName ?? tm.email ?? tm.userId.slice(0, 8)}
                    </span>
                    <Select
                      value={humanAssignments[tm.userId] ?? ""}
                      onValueChange={(v) =>
                        setHumanAssignments((prev) => ({ ...prev, [tm.userId]: v || null }))
                      }
                    >
                      <SelectTrigger className="w-[180px]">
                        <SelectValue placeholder="Select manager" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">No manager (root)</SelectItem>
                        {eligibleManagers.map((m) => (
                          <SelectItem key={m.userId} value={m.userId}>
                            {m.displayName ?? m.email ?? m.userId.slice(0, 8)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
            )}

            {deps.agentTrees.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-sm font-semibold">Agent Teams (sub-agents move together)</h3>
                {deps.agentTrees.map((tree) => (
                  <label
                    key={tree.rootAgentId}
                    className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 cursor-pointer"
                  >
                    <Checkbox
                      checked={agentSelections[tree.rootAgentId] !== false}
                      onCheckedChange={(checked) =>
                        setAgentSelections((prev) => ({
                          ...prev,
                          [tree.rootAgentId]: checked === true,
                        }))
                      }
                    />
                    <span className="text-sm flex-1">
                      {tree.rootAgentName}
                      {tree.subAgentCount > 0 && (
                        <span className="text-muted-foreground"> (+{tree.subAgentCount} sub-agent{tree.subAgentCount > 1 ? "s" : ""})</span>
                      )}
                    </span>
                  </label>
                ))}

                {selectedAgents.length > 0 && (
                  <div className="flex items-center gap-2 pt-1">
                    <span className="text-sm text-muted-foreground">Move selected to:</span>
                    <Select value={bulkAgentTarget} onValueChange={setBulkAgentTarget}>
                      <SelectTrigger className="w-[180px]">
                        <SelectValue placeholder="Select manager" />
                      </SelectTrigger>
                      <SelectContent>
                        {eligibleManagers.map((m) => (
                          <SelectItem key={m.userId} value={m.userId}>
                            {m.displayName ?? m.email ?? m.userId.slice(0, 8)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
            )}

            {deps.assignedTaskCount > 0 && (
              <p className="text-xs text-muted-foreground">
                Note: {deps.assignedTaskCount} active task{deps.assignedTaskCount > 1 ? "s" : ""} assigned to this person will remain assigned.
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={removeMutation.isPending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => removeMutation.mutate()}
            disabled={removeMutation.isPending || (hasReports && !canSubmit)}
          >
            {removeMutation.isPending ? "Removing..." : hasReports ? "Reassign & Remove" : "Remove"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Verify build**

Run: `cd ui && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/team/ReassignmentDialog.tsx
git commit -m "feat(ui): add ReassignmentDialog for safe member removal with reassignment"
```

---

## Task 14: TransferAdminDialog Component

**Files:**
- Create: `ui/src/components/team/TransferAdminDialog.tsx`

- [ ] **Step 1: Create the TransferAdminDialog**

```typescript
// ui/src/components/team/TransferAdminDialog.tsx
import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { TeamMemberSummary } from "@armyofagents/shared";
import { teamApi } from "../../api/team";
import { queryKeys } from "../../lib/queryKeys";
import { useToast } from "../../context/ToastContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AlertTriangle } from "lucide-react";

interface TransferAdminDialogProps {
  companyId: string;
  members: TeamMemberSummary[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function TransferAdminDialog({
  companyId,
  members,
  open,
  onOpenChange,
}: TransferAdminDialogProps) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const [targetUserId, setTargetUserId] = useState<string>("none");
  const [confirmation, setConfirmation] = useState("");

  const founders = useMemo(
    () => members.filter((m) => m.role === "founder" && !m.isCurrentUser),
    [members],
  );

  const targetName = useMemo(
    () => founders.find((f) => f.userId === targetUserId)?.displayName ?? "",
    [founders, targetUserId],
  );

  const transferMutation = useMutation({
    mutationFn: () =>
      teamApi.transferAdmin(companyId, { toUserId: targetUserId, confirmation: "TRANSFER" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.team.summary(companyId) });
      pushToast({ title: `Admin transferred to ${targetName}`, tone: "success" });
      onOpenChange(false);
      reset();
    },
    onError: (err: Error) => {
      pushToast({ title: err.message || "Failed to transfer admin", tone: "error" });
    },
  });

  function reset() {
    setTargetUserId("none");
    setConfirmation("");
  }

  const canSubmit = targetUserId !== "none" && confirmation === "TRANSFER";

  return (
    <Dialog open={open} onOpenChange={(next) => { onOpenChange(next); if (!next) reset(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Transfer System Admin</DialogTitle>
          <DialogDescription>
            Transfer admin privileges to another founder.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Transfer to</Label>
            <Select value={targetUserId} onValueChange={setTargetUserId}>
              <SelectTrigger>
                <SelectValue placeholder="Select a founder" />
              </SelectTrigger>
              <SelectContent>
                {founders.length === 0 && (
                  <SelectItem value="none" disabled>No other founders</SelectItem>
                )}
                {founders.map((f) => (
                  <SelectItem key={f.userId} value={f.userId}>
                    {f.displayName ?? f.email ?? f.userId.slice(0, 8)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-start gap-2 rounded-lg bg-amber-50 dark:bg-amber-950/30 p-3">
            <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
            <p className="text-xs text-amber-800 dark:text-amber-300">
              This cannot be undone without the new admin's cooperation.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="transfer-confirm">Type "TRANSFER" to confirm</Label>
            <Input
              id="transfer-confirm"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              placeholder="TRANSFER"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => { onOpenChange(false); reset(); }}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => transferMutation.mutate()}
            disabled={transferMutation.isPending || !canSubmit}
          >
            {transferMutation.isPending ? "Transferring..." : "Transfer"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Verify build**

Run: `cd ui && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/team/TransferAdminDialog.tsx
git commit -m "feat(ui): add TransferAdminDialog for system admin transfer"
```

---

## Task 15: Integrate Reassignment & Transfer Dialogs into HumansTab

**Files:**
- Modify: `ui/src/components/team/HumansTab.tsx`

- [ ] **Step 1: Replace RemoveConfirmDialog with ReassignmentDialog**

Import the new dialogs:

```typescript
import { ReassignmentDialog } from "./ReassignmentDialog";
import { TransferAdminDialog } from "./TransferAdminDialog";
```

Add transfer admin state:

```typescript
const [transferOpen, setTransferOpen] = useState(false);
```

Replace the `RemoveConfirmDialog` usage at the bottom of the component:

```typescript
{removeTarget && (
  <ReassignmentDialog
    companyId={selectedCompanyId}
    member={removeTarget}
    members={members}
    open={Boolean(removeTarget)}
    onOpenChange={(open) => { if (!open) setRemoveTarget(null); }}
    onSuccess={invalidateTeam}
  />
)}

{isSystemAdmin && (
  <TransferAdminDialog
    companyId={selectedCompanyId}
    members={members}
    open={transferOpen}
    onOpenChange={setTransferOpen}
  />
)}
```

- [ ] **Step 2: Add Transfer Admin button**

In the header section of HumansTab, after the "Add Member" button, add a transfer admin button visible only to system admin:

```typescript
{isSystemAdmin && (
  <Button variant="outline" onClick={() => setTransferOpen(true)}>
    Transfer Admin
  </Button>
)}
```

- [ ] **Step 3: Remove the old RemoveConfirmDialog function**

Delete the `RemoveConfirmDialog` component definition from HumansTab since it's no longer needed.

- [ ] **Step 4: Verify build**

Run: `cd ui && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/team/HumansTab.tsx
git commit -m "feat(ui): integrate ReassignmentDialog and TransferAdminDialog into HumansTab"
```

---

## Task 16: Human Detail Page

**Files:**
- Create: `ui/src/pages/HumanDetail.tsx`
- Modify: `ui/src/App.tsx`

- [ ] **Step 1: Create HumanDetail page**

```typescript
// ui/src/pages/HumanDetail.tsx
import { useEffect, useMemo, useState, useCallback } from "react";
import { useParams, useNavigate } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Users, Shield } from "lucide-react";
import type { UserRole } from "@armyofagents/shared";
import { teamApi } from "../api/team";
import { issuesApi } from "../api/issues";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useTeamAccess } from "../hooks/useTeamAccess";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { PageSkeleton } from "../components/PageSkeleton";
import { EmptyState } from "../components/EmptyState";
import { Tabs } from "@/components/ui/tabs";
import { PageTabBar } from "../components/PageTabBar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

const ROLE_LABELS: Record<UserRole, string> = {
  founder: "Founder",
  team_lead: "Team Lead",
  team_member: "Team Member",
};

const ROLE_STYLES: Record<UserRole, string> = {
  founder: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
  team_lead: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  team_member: "bg-slate-100 text-slate-800 dark:bg-slate-900/30 dark:text-slate-300",
};

function getInitials(name: string): string {
  return name.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("");
}

export function HumanDetail() {
  const { userId } = useParams<{ userId: string }>();
  const { tab } = useParams<{ tab?: string }>();
  const activeView = tab === "settings" ? "settings" : "overview";
  const navigate = useNavigate();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { permissions } = useTeamAccess(selectedCompanyId);
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const memberQuery = useQuery({
    queryKey: selectedCompanyId && userId
      ? queryKeys.team.member(selectedCompanyId, userId)
      : ["team", "none"],
    queryFn: () => teamApi.getMember(selectedCompanyId!, userId!),
    enabled: Boolean(selectedCompanyId && userId),
  });

  const member = memberQuery.data?.member;
  const deps = memberQuery.data?.dependencies;

  useEffect(() => {
    setBreadcrumbs([
      { label: "Team", to: "/org?tab=humans" },
      { label: member?.displayName ?? "Member" },
    ]);
  }, [setBreadcrumbs, member]);

  if (!selectedCompanyId || !userId) {
    return <EmptyState icon={Users} message="Select a company to view member details." />;
  }

  if (memberQuery.isLoading) {
    return <PageSkeleton variant="detail" />;
  }

  if (!member) {
    return <EmptyState icon={Users} message="Team member not found." />;
  }

  const displayName = member.displayName ?? member.email ?? member.userId.slice(0, 8);

  return (
    <div className="space-y-6">
      {/* Back button + header */}
      <div className="rounded-2xl border border-border bg-card p-5">
        <div className="flex items-center gap-3 mb-4">
          <Button variant="ghost" size="icon" onClick={() => navigate("/org?tab=humans")}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="flex items-center gap-3 flex-1">
            {member.avatarUrl ? (
              <img src={member.avatarUrl} alt={displayName} className="w-10 h-10 rounded-full object-cover" />
            ) : (
              <div className="w-10 h-10 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
                <span className="text-sm font-semibold text-green-700 dark:text-green-300">
                  {getInitials(displayName)}
                </span>
              </div>
            )}
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-semibold">{displayName}</h1>
                <Badge variant="secondary" className={cn("border-0", ROLE_STYLES[member.role])}>
                  {ROLE_LABELS[member.role]}
                </Badge>
                {member.isSystemAdmin && (
                  <Badge variant="outline" className="text-[11px] border-amber-500 text-amber-700 dark:text-amber-300">
                    <Shield className="h-3 w-3 mr-1" />
                    Admin
                  </Badge>
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                {member.email} · {member.departmentName ?? "No department"}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <Tabs
        value={activeView}
        onValueChange={(v) => {
          const target = v === "overview" ? `/team/${userId}` : `/team/${userId}/${v}`;
          navigate(target);
        }}
      >
        <PageTabBar
          items={[
            { value: "overview", label: "Overview" },
            { value: "settings", label: "Settings" },
          ]}
          value={activeView}
          onValueChange={(v) => {
            const target = v === "overview" ? `/team/${userId}` : `/team/${userId}/${v}`;
            navigate(target);
          }}
        />
      </Tabs>

      {activeView === "overview" && deps && (
        <div className="space-y-4">
          {/* Agents reporting */}
          {deps.agentTrees.length > 0 && (
            <div className="rounded-2xl border border-border bg-card p-5">
              <h2 className="text-sm font-semibold mb-3">Agents Reporting</h2>
              <div className="space-y-2">
                {deps.agentTrees.map((tree) => (
                  <div key={tree.rootAgentId} className="flex items-center gap-2 text-sm">
                    <span className="font-medium">{tree.rootAgentName}</span>
                    {tree.subAgentCount > 0 && (
                      <span className="text-muted-foreground">(+{tree.subAgentCount} sub-agent{tree.subAgentCount > 1 ? "s" : ""})</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Team members reporting */}
          {deps.teamMembers.length > 0 && (
            <div className="rounded-2xl border border-border bg-card p-5">
              <h2 className="text-sm font-semibold mb-3">Team Members Reporting</h2>
              <div className="space-y-2">
                {deps.teamMembers.map((tm) => (
                  <div key={tm.userId} className="flex items-center gap-2 text-sm">
                    <span className="font-medium">{tm.displayName ?? tm.email ?? tm.userId.slice(0, 8)}</span>
                    <span className="text-muted-foreground">({ROLE_LABELS[tm.role] ?? tm.role})</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Task summary */}
          <div className="rounded-2xl border border-border bg-card p-5">
            <h2 className="text-sm font-semibold mb-3">Tasks</h2>
            <div className="flex gap-6 text-sm">
              <div>
                <span className="text-muted-foreground">Assigned: </span>
                <span className="font-medium">{deps.assignedTaskCount}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Created: </span>
                <span className="font-medium">{deps.createdTaskCount}</span>
              </div>
            </div>
          </div>

          {deps.agentTrees.length === 0 && deps.teamMembers.length === 0 && deps.assignedTaskCount === 0 && deps.createdTaskCount === 0 && (
            <EmptyState icon={Users} message="No reports, agents, or tasks yet." />
          )}
        </div>
      )}

      {activeView === "settings" && (
        <div className="rounded-2xl border border-border bg-card p-5">
          <p className="text-sm text-muted-foreground">
            Edit this member's details from the{" "}
            <button
              className="underline hover:text-foreground transition-colors"
              onClick={() => navigate("/org?tab=humans&highlight=" + userId)}
            >
              Humans tab
            </button>.
          </p>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add routes to App.tsx**

In `ui/src/App.tsx`, add after the existing agents routes:

```typescript
<Route path="team/:userId" element={<HumanDetail />} />
<Route path="team/:userId/:tab" element={<HumanDetail />} />
```

Add the import:

```typescript
import { HumanDetail } from "./pages/HumanDetail";
```

- [ ] **Step 3: Verify build**

Run: `cd ui && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add ui/src/pages/HumanDetail.tsx ui/src/App.tsx
git commit -m "feat(ui): add HumanDetail page with overview and settings tabs"
```

---

## Task 17: Org Tree — Ghost Nodes for Pending Invites

**Files:**
- Modify: `ui/src/components/team/OrgTreeTab.tsx`
- Modify: `packages/shared/src/types/team.ts`

- [ ] **Step 1: Add `pendingInvites` prop to OrgTreeTab**

Update the `OrgTreeTabProps` interface:

```typescript
export interface OrgTreeTabProps {
  orgTree: UnifiedOrgNode[];
  pendingInvites?: Array<{
    id: string;
    email: string | null;
    role: string;
    departmentName: string | null;
    reportsToId: string | null;
  }>;
  onNodeClick: (id: string, nodeType: "agent" | "user") => void;
}
```

- [ ] **Step 2: Merge pending invites into the tree as ghost nodes**

In `OrgTreeTab`, before `layoutForest`, insert ghost nodes:

```typescript
const mergedTree = useMemo(() => {
  if (!pendingInvites || pendingInvites.length === 0) return orgTree;

  // Deep clone the tree to avoid mutations
  const cloned = JSON.parse(JSON.stringify(orgTree)) as UnifiedOrgNode[];

  // Build a node lookup from the cloned tree
  const nodeMap = new Map<string, UnifiedOrgNode>();
  function walkMap(nodes: UnifiedOrgNode[]) {
    for (const n of nodes) {
      nodeMap.set(`${n.nodeType}:${n.id}`, n);
      walkMap(n.children);
    }
  }
  walkMap(cloned);

  // Add pending invites as ghost nodes
  for (const invite of pendingInvites) {
    const ghost: UnifiedOrgNode = {
      id: `invite:${invite.id}`,
      name: invite.email ?? "Pending invite",
      role: invite.role,
      status: "pending",
      nodeType: "user",
      userRole: invite.role as UnifiedOrgNode["userRole"],
      departmentName: invite.departmentName ?? undefined,
      pendingApproval: true,
      children: [],
    };

    if (invite.reportsToId) {
      const parent = nodeMap.get(`user:${invite.reportsToId}`);
      if (parent) {
        parent.children.push(ghost);
        continue;
      }
    }
    cloned.push(ghost);
  }

  return cloned;
}, [orgTree, pendingInvites]);
```

Replace `orgTree` with `mergedTree` in the `layoutForest` call:

```typescript
const layout = useMemo(() => layoutForest(mergedTree), [mergedTree]);
```

- [ ] **Step 3: Style ghost nodes with dashed border**

In `HumanNodeCard`, add conditional styling for pending/ghost nodes:

```typescript
className={cn(
  "absolute bg-card border rounded-lg shadow-sm hover:shadow-md hover:border-foreground/20 transition-[box-shadow,border-color] duration-150 cursor-pointer select-none border-l-[3px] border-l-green-400",
  node.pendingApproval && "opacity-50 border-dashed",
)}
```

- [ ] **Step 4: Pass pendingInvites to OrgTreeTab in TeamPage.tsx**

In `ui/src/pages/TeamPage.tsx`, pass the pending invites:

```typescript
<OrgTreeTab
  orgTree={orgTreeQuery.data ?? []}
  pendingInvites={teamSummary?.pendingInvites?.map((inv) => ({
    id: inv.id,
    email: inv.email,
    role: inv.role,
    departmentName: inv.departmentName,
    reportsToId: inv.reportsToId ?? null,
  }))}
  onNodeClick={handleNodeClick}
/>
```

- [ ] **Step 5: Update listTeam to include reportsToId on pending invites**

In `server/src/services/team.ts`, where pending invites are queried and mapped, extract the `parentId` from `defaultsPayload.teamInvite` if present and include it as `reportsToId` in the `TeamInviteSummary`.

- [ ] **Step 6: Verify build**

Run: `cd ui && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add ui/src/components/team/OrgTreeTab.tsx ui/src/pages/TeamPage.tsx server/src/services/team.ts packages/shared/src/types/team.ts
git commit -m "feat(ui): add ghost nodes for pending invites in org tree"
```

---

## Task 18: Org Tree — Kebab Menu on Nodes

**Files:**
- Modify: `ui/src/components/team/OrgTreeTab.tsx`

- [ ] **Step 1: Add kebab menu to HumanNodeCard**

Import required components:

```typescript
import { MoreVertical } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
```

Update `OrgTreeTabProps` to add action callbacks:

```typescript
export interface OrgTreeTabProps {
  orgTree: UnifiedOrgNode[];
  pendingInvites?: Array<{
    id: string;
    email: string | null;
    role: string;
    departmentName: string | null;
    reportsToId: string | null;
  }>;
  onNodeClick: (id: string, nodeType: "agent" | "user") => void;
  onNodeAction?: (action: string, id: string, nodeType: "agent" | "user") => void;
}
```

Add a kebab button to `HumanNodeCard` (top-right corner):

```typescript
<DropdownMenu>
  <DropdownMenuTrigger asChild>
    <button
      data-org-card
      className="absolute top-2 right-2 h-6 w-6 flex items-center justify-center rounded hover:bg-accent opacity-0 group-hover:opacity-100 transition-opacity"
      onClick={(e) => e.stopPropagation()}
    >
      <MoreVertical className="h-3.5 w-3.5 text-muted-foreground" />
    </button>
  </DropdownMenuTrigger>
  <DropdownMenuContent align="end">
    <DropdownMenuItem onClick={() => onNodeAction?.("view", node.id, "user")}>
      View Profile
    </DropdownMenuItem>
    <DropdownMenuItem onClick={() => onNodeAction?.("edit-role", node.id, "user")}>
      Change Role
    </DropdownMenuItem>
    <DropdownMenuItem onClick={() => onNodeAction?.("remove", node.id, "user")} className="text-destructive">
      Remove
    </DropdownMenuItem>
  </DropdownMenuContent>
</DropdownMenu>
```

Add `group` class to the card container for hover reveal:

```typescript
className={cn(
  "absolute bg-card border rounded-lg shadow-sm ... group",
  // ...
)}
```

Similarly for `AgentNodeCard`:

```typescript
<DropdownMenuItem onClick={() => onNodeAction?.("view", node.id, "agent")}>
  View Agent
</DropdownMenuItem>
<DropdownMenuItem onClick={() => onNodeAction?.("edit-reports-to", node.id, "agent")}>
  Change Reports To
</DropdownMenuItem>
```

And for pending (ghost) nodes:

```typescript
{node.id.startsWith("invite:") ? (
  <>
    <DropdownMenuItem onClick={() => onNodeAction?.("resend", node.id.replace("invite:", ""), "user")}>
      Resend Invite
    </DropdownMenuItem>
    <DropdownMenuItem onClick={() => onNodeAction?.("revoke", node.id.replace("invite:", ""), "user")} className="text-destructive">
      Revoke Invite
    </DropdownMenuItem>
  </>
) : (
  // ... regular menu items
)}
```

- [ ] **Step 2: Handle kebab actions in TeamPage**

In `TeamPage.tsx`, add a handler for node actions:

```typescript
const handleNodeAction = useCallback(
  (action: string, id: string, nodeType: "agent" | "user") => {
    if (action === "view") {
      if (nodeType === "agent") navigate(`/agents/${id}`);
      else navigate(`/team/${id}`);
    } else if (action === "edit-role" || action === "edit-reports-to") {
      const tab = nodeType === "agent" ? "agents" : "humans";
      setSearchParams({ tab, highlight: id });
    } else if (action === "remove") {
      setSearchParams({ tab: "humans", highlight: id });
      // The removal flow is handled in HumansTab via highlight
    }
    // resend/revoke handled similarly
  },
  [navigate, setSearchParams],
);
```

Pass to OrgTreeTab:

```typescript
<OrgTreeTab
  orgTree={orgTreeQuery.data ?? []}
  pendingInvites={...}
  onNodeClick={handleNodeClick}
  onNodeAction={handleNodeAction}
/>
```

- [ ] **Step 3: Verify build**

Run: `cd ui && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/team/OrgTreeTab.tsx ui/src/pages/TeamPage.tsx
git commit -m "feat(ui): add kebab context menu to org tree nodes"
```

---

## Task 19: Enforce Agent Hierarchy Constraint (Agents Under Humans Only)

**Files:**
- Modify: `server/src/services/agents.ts`

- [ ] **Step 1: Add validation that humans cannot report to agents**

In the agent update/create flow in `server/src/services/agents.ts`, find where `parentType` and `parentId` are processed for agent creation/update. The existing logic already handles this, but verify that when an agent's parent is set, it can be either `"user"` or `"agent"`.

For the team service — in `server/src/services/team.ts`, in `updateUserRole`, add a check:

```typescript
// Humans can only report to humans
if (input.parentType && input.parentType !== "user") {
  throw conflict("Team members can only report to other team members");
}
```

This is already enforced at the UI level (dropdown only shows humans), but this adds backend enforcement.

- [ ] **Step 2: Verify build**

Run: `cd server && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add server/src/services/team.ts
git commit -m "fix(team): enforce humans-report-to-humans constraint at backend level"
```

---

## Task 20: Integration Test & Final Verification

**Files:**
- All modified files

- [ ] **Step 1: Run all existing tests**

Run: `cd server && npx vitest run --reporter=verbose`
Expected: All pre-existing tests still pass, plus the 3 new test files pass

- [ ] **Step 2: Run TypeScript checks for all packages**

Run: `pnpm -r exec tsc --noEmit` or individually:
```bash
cd packages/shared && pnpm build
cd ../../server && npx tsc --noEmit
cd ../ui && npx tsc --noEmit
```
Expected: No type errors

- [ ] **Step 3: Verify build**

Run: `pnpm build` (or the project's build command)
Expected: Clean build

- [ ] **Step 4: Manual smoke test checklist**

Verify these flows work:
1. Open Team page → Humans tab → click "Add Member" → fill form → submit → member appears
2. Open Team page → Humans tab → click "Add Member" → toggle to invite mode → create invite → copy link
3. Pending invite appears with Resend/Revoke buttons → click Resend → new link generated → click Revoke → invite removed
4. System admin badge appears on the bootstrapped founder
5. Click member card → navigate to `/team/:userId` → see Overview with agents/tasks/reports
6. Remove a member with reports → ReassignmentDialog shows → reassign → member removed
7. Org tree shows ghost nodes for pending invites (dashed, faded)
8. Kebab menu on org tree nodes → View Profile works, Change Role switches to Humans tab
9. Transfer Admin dialog → select founder → type TRANSFER → admin transferred

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: team management enhancements - direct add, system admin, invite lifecycle, human detail, reassignment"
```

---

## Summary

| Task | What | Files |
|------|------|-------|
| 1 | `isSystemAdmin` column on `companyMemberships` | DB schema + migration |
| 2 | System admin service functions | team.ts service |
| 3 | Shared types & validators | shared package |
| 4 | Direct member add service | team.ts service |
| 5 | Direct member add route | team.ts routes |
| 6 | System admin transfer + bootstrap + constraints | routes + services |
| 7 | Invite resend & revoke | access.ts service + routes |
| 8 | Dependencies & reassignment service | team.ts service + routes |
| 9 | Frontend API client updates | team.ts, access.ts, queryKeys |
| 10 | AddMemberDialog component | New UI component |
| 11 | HumansTab updates | Admin badge, invite lifecycle, new dialog |
| 12 | TeamPage system admin pass-through | TeamPage.tsx |
| 13 | ReassignmentDialog component | New UI component |
| 14 | TransferAdminDialog component | New UI component |
| 15 | Integrate dialogs into HumansTab | HumansTab.tsx |
| 16 | HumanDetail page + routing | New page + App.tsx |
| 17 | Org tree ghost nodes | OrgTreeTab.tsx |
| 18 | Org tree kebab menu | OrgTreeTab.tsx |
| 19 | Backend hierarchy constraint | team.ts |
| 20 | Integration test & verification | All files |
