# Invited-Teammate Journey Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guided invited-teammate onboarding — the teammate builds their Human Operating Profile, and a verified-email match on the invite admits them instantly on profile completion; mismatches fall back to founder approval with a live-polling pending screen.

**Architecture:** Reuse the existing invite-accept + approval machinery. Extract the human-approval transaction into a shared service (`join-approval.ts`) used by both the founder-approve route and a new self-scoped finalize endpoint. Global `user_profiles` gains `timezone`; the approval transaction materializes the company `company_user_profiles` row + seeds capability-doc stubs from the global profile. UI: a shared `HumanProfileStep` (invited-only wiring) + an `InvitedJoinTerminal` that finalizes, then polls.

**Tech Stack:** Express 5 + Drizzle (server), React + Vite + RTL/Vitest (UI), pnpm workspaces.

**Spec:** `docs/aoa/plans/2026-07-16-invited-teammate-journey-scope.md`. **One deviation from spec §7/§8 (simplification):** the teammate's timezone lives on the **global `user_profiles`** (new column) instead of being carried on the join_request — the profile step saves it with everything else and the approval copies global→company. Removes a route and a column; identical behavior. `join_requests` instead gains only `approval_source` (audit).

**Worktree/branch:** `C:/Users/TK/.aoa/wt/onboarding-auth-redesign`, branch `feat/invited-teammate-journey` (off main post-PR#287).

**Commands (verified for this repo):**
- UI single test file: `pnpm --filter @armyofagents/ui test:run <path-substring>` (never use `|` in filters)
- Server single test file: `pnpm test:run <path-substring>` (root vitest; server has no package `test` script)
- Typecheck: `pnpm --filter @armyofagents/server typecheck` / `pnpm --filter @armyofagents/ui typecheck`
- Schema change: edit `packages/db/src/schema/*.ts` → `pnpm db:generate` → **commit the SQL migration + meta/_journal.json + snapshot together**
- Shared-package edit: `pnpm --filter @armyofagents/shared build` before the server sees it

---

### Task 1: Shared human-profile constants (UI)

The Title/Timezone pick-lists must be identical in onboarding and on the Human page. Extract them from `HumanDetail.tsx` into a shared module.

**Files:**
- Create: `ui/src/lib/human-profile-constants.ts`
- Create: `ui/src/lib/__tests__/human-profile-constants.test.ts`
- Modify: `ui/src/pages/HumanDetail.tsx:105-157` (delete local copies, import instead)

- [ ] **Step 1: Write the failing test**

```ts
// ui/src/lib/__tests__/human-profile-constants.test.ts
import { describe, it, expect } from "vitest";
import {
  HUMAN_TITLE_OPTIONS,
  FALLBACK_TIMEZONE_OPTIONS,
  getTimezoneOptions,
} from "../human-profile-constants";

describe("human-profile-constants (shared between HumanDetail + onboarding)", () => {
  it("keeps the curated title options", () => {
    expect(HUMAN_TITLE_OPTIONS).toContain("Founder");
    expect(HUMAN_TITLE_OPTIONS).toContain("Engineer");
    expect(HUMAN_TITLE_OPTIONS).toContain("Advisor");
    expect(HUMAN_TITLE_OPTIONS.length).toBeGreaterThanOrEqual(28);
  });

  it("getTimezoneOptions is the full IANA set unioned with fallbacks, sorted + deduped", () => {
    const options = getTimezoneOptions();
    expect(options).toContain("UTC");
    for (const tz of FALLBACK_TIMEZONE_OPTIONS) expect(options).toContain(tz);
    expect(new Set(options).size).toBe(options.length); // deduped
    const sorted = [...options].sort((a, b) => a.localeCompare(b));
    expect(options).toEqual(sorted);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL (module not found)**

Run: `pnpm --filter @armyofagents/ui test:run src/lib/__tests__/human-profile-constants`
Expected: FAIL — cannot resolve `../human-profile-constants`

- [ ] **Step 3: Create the shared module (moved verbatim from HumanDetail.tsx:105-157)**

```ts
// ui/src/lib/human-profile-constants.ts
/**
 * Shared Human Operating Profile pick-lists. Consumed by BOTH the Human page
 * (HumanDetail) and the onboarding HumanProfileStep so the options can never
 * drift. Add new titles here — both surfaces pick them up.
 */
export const HUMAN_TITLE_OPTIONS = [
  "Founder",
  "Co-Founder",
  "Founder Partner",
  "Founder Operator",
  "CEO",
  "COO",
  "CTO",
  "CPO",
  "Chief of Staff",
  "General Manager",
  "Team Lead",
  "Product Lead",
  "Engineering Lead",
  "Design Lead",
  "Marketing Lead",
  "Sales Lead",
  "Customer Success Lead",
  "Operations Lead",
  "Finance Lead",
  "Legal Lead",
  "People Lead",
  "Product Manager",
  "Engineer",
  "Designer",
  "Researcher",
  "Analyst",
  "Operator",
  "Advisor",
] as const;

export const FALLBACK_TIMEZONE_OPTIONS = [
  "UTC",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "Europe/Amsterdam",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
] as const;

export function getTimezoneOptions(): string[] {
  const supported = Intl.supportedValuesOf?.("timeZone") ?? [];
  return Array.from(new Set(["UTC", ...FALLBACK_TIMEZONE_OPTIONS, ...supported])).sort((a, b) =>
    a.localeCompare(b),
  );
}
```

- [ ] **Step 4: Point HumanDetail at the shared module**

In `ui/src/pages/HumanDetail.tsx`: delete the local `const HUMAN_TITLE_OPTIONS = [...]`, `const FALLBACK_TIMEZONE_OPTIONS = [...]`, and `function getTimezoneOptions() {...}` (lines 105–157), and add to the imports:

```ts
import { HUMAN_TITLE_OPTIONS, getTimezoneOptions } from "@/lib/human-profile-constants";
```

(`FALLBACK_TIMEZONE_OPTIONS` is only used by `getTimezoneOptions` — don't import it into HumanDetail.)

- [ ] **Step 5: Run test + typecheck — expect PASS / clean**

Run: `pnpm --filter @armyofagents/ui test:run src/lib/__tests__/human-profile-constants` → PASS
Run: `pnpm --filter @armyofagents/ui typecheck` → clean

- [ ] **Step 6: Commit**

```bash
git add ui/src/lib/human-profile-constants.ts ui/src/lib/__tests__/human-profile-constants.test.ts ui/src/pages/HumanDetail.tsx
git commit -m "refactor(ui): extract shared human-profile title/timezone constants"
```

---

### Task 2: Schema — `user_profiles.timezone` + `join_requests.approval_source`

**Files:**
- Modify: `packages/db/src/schema/user_profiles.ts`
- Modify: `packages/db/src/schema/join_requests.ts`
- Generated: new SQL migration + `meta/_journal.json` + snapshot (via `pnpm db:generate`)

- [ ] **Step 1: Add `timezone` to user_profiles**

In `packages/db/src/schema/user_profiles.ts`, after the `bio` column:

```ts
  bio: text("bio"),
  /** IANA timezone (e.g. "Asia/Kolkata"). Collected during onboarding; the
   *  approval transaction copies it into company_user_profiles. */
  timezone: text("timezone"),
```

- [ ] **Step 2: Add `approvalSource` to join_requests**

In `packages/db/src/schema/join_requests.ts`, after `approvedByUserId`:

```ts
    approvedByUserId: text("approved_by_user_id"),
    /** How the approval happened: "founder" (manual) | "invite_email_match"
     *  (auto-admit — the invitation carried the approval). Null on legacy rows. */
    approvalSource: text("approval_source"),
```

- [ ] **Step 3: Generate the migration**

Run: `pnpm db:generate`
Expected: a new `packages/db/src/migrations/NNNN_*.sql` containing exactly two `ALTER TABLE ... ADD COLUMN` statements (`user_profiles.timezone`, `join_requests.approval_source`), plus updated `meta/_journal.json` + snapshot.

- [ ] **Step 4: Server typecheck (columns visible)**

Run: `pnpm --filter @armyofagents/server typecheck` → clean

- [ ] **Step 5: Commit (ALL generated artifacts)**

```bash
git add packages/db/src/schema/user_profiles.ts packages/db/src/schema/join_requests.ts packages/db/src/migrations/
git commit -m "feat(db): user_profiles.timezone + join_requests.approval_source"
```

---

### Task 3: Global profile timezone plumb-through (server service + route + client)

**Files:**
- Modify: `server/src/services/user-profiles.ts`
- Modify: `server/src/routes/user-profiles.ts:36-38`
- Modify: `ui/src/api/userProfile.ts`
- Create: `server/src/__tests__/user-profile-timezone.test.ts`

- [ ] **Step 1: Write the failing test (route-level contract)**

```ts
// server/src/__tests__/user-profile-timezone.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const upsertUserProfile = vi.hoisted(() => vi.fn(async (_db: unknown, _userId: string, input: unknown) => ({
  userId: "u1",
  displayName: "Ada",
  avatarUrl: null,
  title: "Engineer",
  bio: null,
  timezone: (input as { timezone?: string | null }).timezone ?? null,
  socialLinks: [],
})));
vi.mock("../services/user-profiles.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/user-profiles.js")>()),
  upsertUserProfile,
}));

import { userProfileRoutes } from "../routes/user-profiles.js";

function findRoute(router: ReturnType<typeof userProfileRoutes>, method: "patch") {
  const layer = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> } }> }).stack
    .find((l) => l.route?.path === "/user-profile" && l.route.methods[method]);
  if (!layer?.route) throw new Error("route not found");
  return layer.route.stack[0]!.handle as (req: unknown, res: unknown) => Promise<void>;
}

describe("PATCH /user-profile accepts timezone", () => {
  beforeEach(() => vi.clearAllMocks());

  it("forwards a string timezone to the upsert", async () => {
    const handler = findRoute(userProfileRoutes({} as never), "patch");
    const json = vi.fn();
    await handler(
      { actor: { type: "board", userId: "u1" }, body: { displayName: "Ada", timezone: "Asia/Kolkata" } },
      { json, status: vi.fn().mockReturnValue({ json }) },
    );
    expect(upsertUserProfile).toHaveBeenCalledWith(expect.anything(), "u1",
      expect.objectContaining({ timezone: "Asia/Kolkata" }));
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (route drops `timezone`; the `objectContaining` assertion fails)

Run: `pnpm test:run user-profile-timezone`
Expected: FAIL

- [ ] **Step 3: Implement — service types + upsert + mapRow**

In `server/src/services/user-profiles.ts`:
- `UserProfileInput`: add `timezone?: string | null;`
- `UserProfile`: add `timezone: string | null;`
- `mapRow`: add `timezone: row.timezone ?? null,`
- `upsertUserProfile` `values`: add `timezone: input.timezone ?? null,`
- `upsertUserProfile` `updates`: add `if (input.timezone !== undefined) updates.timezone = input.timezone;`

In `server/src/routes/user-profiles.ts`, after the `bio` line (line 37):

```ts
    if (typeof body.timezone === "string" || body.timezone === null) input.timezone = body.timezone;
```

In `ui/src/api/userProfile.ts`, add to `UserProfile`:

```ts
  timezone: string | null;
```

- [ ] **Step 4: Run test + both typechecks — expect PASS / clean**

Run: `pnpm test:run user-profile-timezone` → PASS
Run: `pnpm --filter @armyofagents/server typecheck` && `pnpm --filter @armyofagents/ui typecheck` → clean

- [ ] **Step 5: Commit**

```bash
git add server/src/services/user-profiles.ts server/src/routes/user-profiles.ts ui/src/api/userProfile.ts server/src/__tests__/user-profile-timezone.test.ts
git commit -m "feat(profile): global user profile carries timezone"
```

---

### Task 4: Export `parseInviteRoleMetadata` (+ pure unit test)

The finalize endpoint needs the invited email; `parseInviteRoleMetadata` (team.ts:48) already parses it but isn't exported.

**Files:**
- Modify: `server/src/services/team.ts:48`
- Create: `server/src/services/__tests__/invite-role-metadata.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/services/__tests__/invite-role-metadata.test.ts
import { describe, it, expect } from "vitest";
import { parseInviteRoleMetadata } from "../team.js";

describe("parseInviteRoleMetadata", () => {
  it("returns email + role for a teamInvite payload", () => {
    const meta = parseInviteRoleMetadata({
      teamInvite: { role: "team_member", email: "Ada@Example.com", projectId: null, parentId: null },
    });
    expect(meta).toEqual({ email: "Ada@Example.com", role: "team_member", projectId: null, parentId: null });
  });

  it("returns null for a payload without a valid role", () => {
    expect(parseInviteRoleMetadata({ teamInvite: { email: "a@b.c" } })).toBeNull();
    expect(parseInviteRoleMetadata(null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`parseInviteRoleMetadata` is not exported)

Run: `pnpm test:run invite-role-metadata`
Expected: FAIL — no exported member

- [ ] **Step 3: Add the export keyword**

`server/src/services/team.ts:48`: `function parseInviteRoleMetadata(` → `export function parseInviteRoleMetadata(`

- [ ] **Step 4: Run — expect PASS**, server typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/team.ts server/src/services/__tests__/invite-role-metadata.test.ts
git commit -m "refactor(team): export parseInviteRoleMetadata for the join finalize path"
```

---

### Task 5: Shared human-approval service + founder-route refactor

Extract the human branch of the approve transaction into `join-approval.ts` (single choke point), ADD the seeding (company profile + capability stubs), and move `grantsFromDefaults` there (the finalize path needs it too).

**Files:**
- Create: `server/src/services/join-approval.ts`
- Create: `server/src/services/__tests__/join-approval.test.ts`
- Modify: `server/src/routes/access.ts` (approve handler ~2431-2576; delete local `grantsFromDefaults` at 1354-1387 and import it; keep the agent branch's own use)
- Modify: `packages/shared/src/types/access.ts` (add `approvalSource` to the `JoinRequest` type)
- Modify: `packages/shared/src/constants.ts` (add `JOIN_REQUEST_APPROVAL_SOURCES` + `JoinRequestApprovalSource`)

- [ ] **Step 1: Write the failing service test**

```ts
// server/src/services/__tests__/join-approval.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@armyofagents/db", () => ({
  joinRequests: new Proxy({}, { get: (_t, p) => ({ name: String(p) }) }),
}));
vi.mock("drizzle-orm", () => ({ and: (...a: unknown[]) => a, eq: (...a: unknown[]) => a }));
const reconcile = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../hub-items.js", () => ({ hubItemsService: () => ({ reconcile }) }));
const logActivity = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../activity-log.js", () => ({ logActivity }));
const getUserProfile = vi.hoisted(() =>
  vi.fn(async () => ({
    userId: "u1", displayName: "Ada", avatarUrl: null, title: "Engineer",
    bio: "hi", timezone: "Asia/Kolkata", socialLinks: [],
  })),
);
vi.mock("../user-profiles.js", () => ({ getUserProfile }));
vi.mock("../../middleware/logger.js", () => ({ logger: { warn: vi.fn() } }));
// buildHumanJoinApprovalServices constructs real services — not used in these tests.
vi.mock("../access.js", () => ({ accessService: () => ({}) }));
vi.mock("../team.js", () => ({ teamService: () => ({}) }));
vi.mock("../human-capabilities.js", () => ({ humanCapabilitiesService: () => ({}) }));

import { approveHumanJoinRequestTx, grantsFromDefaults } from "../join-approval.js";

function makeTxDb(updatedRow: Record<string, unknown> | null) {
  return {
    update: () => ({ set: () => ({ where: () => ({ returning: async () => (updatedRow ? [updatedRow] : []) }) }) }),
  } as never;
}

function makeServices() {
  return {
    access: { ensureMembership: vi.fn(async () => {}), setPrincipalGrants: vi.fn(async () => {}) },
    team: { applyInviteRole: vi.fn(async () => null), updateCompanyUserProfile: vi.fn(async () => ({})) },
    capabilities: { ensureStandardDocuments: vi.fn(async () => {}) },
  };
}

const args = {
  companyId: "c1", requestId: "r1", requestingUserId: "u1",
  invite: { id: "i1", defaultsPayload: { teamInvite: { role: "team_member", email: "ada@x.com" } } as Record<string, unknown> },
  approvedByUserId: null,
  attributionUserId: null,
  activityActor: { actorType: "system" as const, actorId: "invite_email_match" },
  approvalSource: "invite_email_match" as const,
};

describe("approveHumanJoinRequestTx", () => {
  beforeEach(() => vi.clearAllMocks());

  it("approves: row update + membership + grants + role + seeding + hub + activity", async () => {
    const services = makeServices();
    const row = await approveHumanJoinRequestTx(makeTxDb({ id: "r1", status: "approved" }), services as never, args);
    expect(row).toEqual({ id: "r1", status: "approved" });
    expect(services.access.ensureMembership).toHaveBeenCalledWith("c1", "user", "u1", "member", "active");
    expect(services.team.applyInviteRole).toHaveBeenCalledWith("c1", "u1", args.invite.defaultsPayload, null);
    // seeding copies the GLOBAL profile (incl timezone) into the company profile
    expect(services.team.updateCompanyUserProfile).toHaveBeenCalledWith(
      "c1", "u1",
      expect.objectContaining({ displayName: "Ada", title: "Engineer", timezone: "Asia/Kolkata" }),
      null,
    );
    expect(services.capabilities.ensureStandardDocuments).toHaveBeenCalledWith("c1", "u1", null);
    expect(reconcile).toHaveBeenCalledWith("c1", { sourceType: "join_request", sourceId: "r1" });
    expect(logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "join.approved",
      actorType: "system",
      actorId: "invite_email_match",
      details: { requestType: "human", approvalSource: "invite_email_match" },
    }));
  });

  it("returns null (no side effects) when the row is no longer pending (race)", async () => {
    const services = makeServices();
    const row = await approveHumanJoinRequestTx(makeTxDb(null), services as never, args);
    expect(row).toBeNull();
    expect(services.access.ensureMembership).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("seeding failure is non-fatal — approval still completes", async () => {
    const services = makeServices();
    services.team.updateCompanyUserProfile = vi.fn(async () => { throw new Error("boom"); });
    const row = await approveHumanJoinRequestTx(makeTxDb({ id: "r1" }), services as never, args);
    expect(row).toEqual({ id: "r1" });
    expect(reconcile).toHaveBeenCalled(); // hub/activity still run
  });
});

describe("grantsFromDefaults", () => {
  it("extracts valid grants for the requested key", () => {
    const grants = grantsFromDefaults(
      { human: { grants: [{ permissionKey: "tasks:assign", scope: null }, { permissionKey: "nope" }] } },
      "human",
    );
    expect(grants).toEqual([{ permissionKey: "tasks:assign", scope: null }]);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (module doesn't exist)

Run: `pnpm test:run join-approval`
Expected: FAIL — cannot resolve `../join-approval.js`

- [ ] **Step 3: Create the service**

```ts
// server/src/services/join-approval.ts
import { and, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { joinRequests } from "@armyofagents/db";
import { PERMISSION_KEYS, type JoinRequestApprovalSource } from "@armyofagents/shared";
import { accessService } from "./access.js";
import { teamService } from "./team.js";
import { humanCapabilitiesService } from "./human-capabilities.js";
import { getUserProfile } from "./user-profiles.js";
import { hubItemsService } from "./hub-items.js";
import { logActivity } from "./activity-log.js";
import { logger } from "../middleware/logger.js";

/**
 * Extract permission grants from an invite defaultsPayload (moved verbatim from
 * routes/access.ts — the founder approve route AND the invited finalize path
 * both need it).
 */
export function grantsFromDefaults(
  defaultsPayload: Record<string, unknown> | null | undefined,
  key: "human" | "agent",
): Array<{
  permissionKey: (typeof PERMISSION_KEYS)[number];
  scope: Record<string, unknown> | null;
}> {
  if (!defaultsPayload || typeof defaultsPayload !== "object") return [];
  const scoped = defaultsPayload[key];
  if (!scoped || typeof scoped !== "object") return [];
  const grants = (scoped as Record<string, unknown>).grants;
  if (!Array.isArray(grants)) return [];
  const validPermissionKeys = new Set<string>(PERMISSION_KEYS);
  const result: Array<{
    permissionKey: (typeof PERMISSION_KEYS)[number];
    scope: Record<string, unknown> | null;
  }> = [];
  for (const item of grants) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.permissionKey !== "string") continue;
    if (!validPermissionKeys.has(record.permissionKey)) continue;
    result.push({
      permissionKey: record.permissionKey as (typeof PERMISSION_KEYS)[number],
      scope:
        record.scope && typeof record.scope === "object" && !Array.isArray(record.scope)
          ? (record.scope as Record<string, unknown>)
          : null,
    });
  }
  return result;
}

/** Tx-scoped service instances the approval needs (injected for testability). */
export type HumanJoinApprovalServices = {
  access: Pick<ReturnType<typeof accessService>, "ensureMembership" | "setPrincipalGrants">;
  team: Pick<ReturnType<typeof teamService>, "applyInviteRole" | "updateCompanyUserProfile">;
  capabilities: Pick<ReturnType<typeof humanCapabilitiesService>, "ensureStandardDocuments">;
};

export function buildHumanJoinApprovalServices(txDb: Db): HumanJoinApprovalServices {
  return {
    access: accessService(txDb),
    team: teamService(txDb),
    capabilities: humanCapabilitiesService(txDb),
  };
}

export type ApproveHumanJoinRequestArgs = {
  companyId: string;
  requestId: string;
  requestingUserId: string;
  invite: { id: string; defaultsPayload: Record<string, unknown> | null };
  /** Written to join_requests.approved_by_user_id. null for auto-admit — the
   *  audit trail must never impersonate the founder. Founder route passes
   *  `req.actor.userId ?? (isLocalImplicit(req) ? "local-board" : null)`. */
  approvedByUserId: string | null;
  /** Attribution for grants/role/profile writes. Preserves the founder route's
   *  ORIGINAL semantics (`req.actor.userId ?? null` — no local-board fallback).
   *  null for auto-admit. */
  attributionUserId: string | null;
  /** Activity-log actor. Founder: { actorType: "user", actorId: req.actor.userId ?? "board" }.
   *  Auto-admit: { actorType: "system", actorId: "invite_email_match" } — never
   *  attribute the approval to the invitee. */
  activityActor: { actorType: "user" | "system"; actorId: string };
  approvalSource: JoinRequestApprovalSource;
};

/**
 * The single choke point for admitting an invited human — used by BOTH the
 * founder approve route and the invited auto-admit finalize. Must run inside a
 * transaction (pass the tx-scoped Db). Returns the approved row, or null when
 * the request was no longer pending (raced).
 */
export async function approveHumanJoinRequestTx(
  txDb: Db,
  services: HumanJoinApprovalServices,
  args: ApproveHumanJoinRequestArgs,
) {
  const approvedAt = new Date();
  const row = await txDb
    .update(joinRequests)
    .set({
      status: "approved",
      approvedByUserId: args.approvedByUserId,
      approvalSource: args.approvalSource,
      approvedAt,
      updatedAt: approvedAt,
    })
    .where(
      and(
        eq(joinRequests.companyId, args.companyId),
        eq(joinRequests.id, args.requestId),
        eq(joinRequests.status, "pending_approval"),
      ),
    )
    .returning()
    .then((rows) => rows[0] ?? null);
  if (!row) return null;

  await services.access.ensureMembership(args.companyId, "user", args.requestingUserId, "member", "active");
  const grants = grantsFromDefaults(args.invite.defaultsPayload, "human");
  await services.access.setPrincipalGrants(
    args.companyId,
    "user",
    args.requestingUserId,
    grants,
    args.attributionUserId,
  );
  await services.team.applyInviteRole(
    args.companyId,
    args.requestingUserId,
    args.invite.defaultsPayload,
    args.attributionUserId,
  );

  // Materialize the company Human Operating Profile from the GLOBAL profile +
  // seed the 6 standard capability-doc stubs. Best-effort: a seeding failure
  // must never fail the approval (membership/role/grants are already correct).
  try {
    const globalProfile = await getUserProfile(txDb, args.requestingUserId);
    await services.team.updateCompanyUserProfile(
      args.companyId,
      args.requestingUserId,
      {
        displayName: globalProfile?.displayName ?? null,
        title: globalProfile?.title ?? null,
        bio: globalProfile?.bio ?? null,
        socialLinks: globalProfile?.socialLinks ?? [],
        timezone: globalProfile?.timezone ?? null,
      },
      args.attributionUserId,
    );
    await services.capabilities.ensureStandardDocuments(
      args.companyId,
      args.requestingUserId,
      args.attributionUserId,
    );
  } catch (err) {
    logger.warn(
      { err, companyId: args.companyId, userId: args.requestingUserId },
      "join approval: human profile seeding failed (non-fatal)",
    );
  }

  await hubItemsService(txDb).reconcile(args.companyId, {
    sourceType: "join_request",
    sourceId: args.requestId,
  });
  await logActivity(txDb, {
    companyId: args.companyId,
    actorType: args.activityActor.actorType,
    actorId: args.activityActor.actorId,
    action: "join.approved",
    entityType: "join_request",
    entityId: args.requestId,
    details: { requestType: "human", approvalSource: args.approvalSource },
  });
  return row;
}
```

- [ ] **Step 4: Run the service test — expect PASS**

Run: `pnpm test:run join-approval` → PASS

- [ ] **Step 5: Refactor the founder approve route (human branch delegates)**

In `server/src/routes/access.ts`:

(a) Delete the local `grantsFromDefaults` (lines 1354–1387) and add to the imports:

```ts
import {
  approveHumanJoinRequestTx,
  buildHumanJoinApprovalServices,
  grantsFromDefaults,
} from "../services/join-approval.js";
```

(b) In the approve handler, replace the transaction body (the `db.transaction(async (tx) => { ... })` at ~2431-2576) with a human/agent split — the HUMAN path delegates entirely; the AGENT path keeps the original code:

```ts
      const approved = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;

        if (existing.requestType === "human") {
          if (!existing.requestingUserId)
            throw conflict("Join request missing user identity");
          return approveHumanJoinRequestTx(txDb, buildHumanJoinApprovalServices(txDb), {
            companyId,
            requestId,
            requestingUserId: existing.requestingUserId,
            invite: {
              id: invite.id,
              defaultsPayload: invite.defaultsPayload as Record<string, unknown> | null,
            },
            approvedByUserId:
              req.actor.userId ?? (isLocalImplicit(req) ? "local-board" : null),
            attributionUserId: req.actor.userId ?? null, // original grants/role semantics
            activityActor: { actorType: "user", actorId: req.actor.userId ?? "board" },
            approvalSource: "founder",
          });
        }

        // ── agent branch: unchanged original code ──
        const txAccess = accessService(txDb);
        const txTeam = teamService(txDb);   // keep only if still referenced; otherwise drop
        const txAgents = agentService(txDb);
        const approvedAt = new Date();
        const row = await tx
          .update(joinRequests)
          .set({
            status: "approved",
            approvedByUserId:
              req.actor.userId ?? (isLocalImplicit(req) ? "local-board" : null),
            approvalSource: "founder",
            approvedAt,
            createdAgentId,
            updatedAt: approvedAt
          })
          .where(
            and(
              eq(joinRequests.companyId, companyId),
              eq(joinRequests.id, requestId),
              eq(joinRequests.status, "pending_approval")
            )
          )
          .returning()
          .then((rows) => rows[0]);
        if (!row) return null;
        // ... (the ENTIRE existing agent-creation block from `const existingAgents = await txAgents.list(companyId);`
        //      through the trailing hubItemsService(...).reconcile + logActivity + `return finalRow;`
        //      stays here verbatim — only the human `if` branch was removed from it)
      });
```

NOTE: the original single row-update served both types; after the split the human update lives in the service and the agent update stays inline (shown above with `approvalSource: "founder"` added). Remove the now-dead `if (existing.requestType === "human") {...}` block from the retained agent code. If `txTeam` is no longer referenced in the agent branch, delete that line.

(c) `toJoinRequestResponse` (access.ts:123-126) is a destructuring spread (`const { claimSecretHash: _x, ...safe } = row; return safe;`) — once Task 2 adds the column, `approvalSource` flows through **automatically**. No code change there; just verify the response carries it. For type safety (Task-2 quality-review finding: mirror the sibling `JOIN_REQUEST_TYPES`/`JOIN_REQUEST_STATUSES` pattern), add to `packages/shared/src/constants.ts` next to those:

```ts
export const JOIN_REQUEST_APPROVAL_SOURCES = ["founder", "invite_email_match"] as const;
export type JoinRequestApprovalSource = (typeof JOIN_REQUEST_APPROVAL_SOURCES)[number];
```

and to the shared `JoinRequest` type in `packages/shared/src/types/access.ts` (next to `approvedByUserId`, importing the type):

```ts
  approvalSource: JoinRequestApprovalSource | null;
```

then rebuild shared: `pnpm --filter @armyofagents/shared build`.

- [ ] **Step 6: Server typecheck + full server suite — expect clean/green**

Run: `pnpm --filter @armyofagents/server typecheck` → clean
Run: `pnpm test:run server/src` → all green (approve-route behavior unchanged for existing tests)

- [ ] **Step 7: Commit**

```bash
git add server/src/services/join-approval.ts server/src/services/__tests__/join-approval.test.ts server/src/routes/access.ts packages/shared/src/types/access.ts packages/shared/src/constants.ts
git commit -m "refactor(access): extract human join-approval into a shared service + seed the company human record

NOTE: human-path activity details now carry approvalSource instead of
createdAgentId (which was always null for humans) — deliberate audit-shape
change. Grants/role attribution preserves the original req.actor.userId ?? null."
```

> **Fragility note (reviewer finding):** `join-approval.ts` imports sibling service modules directly (not the `services/index.js` barrel). Existing route tests that mock the barrel (e.g. `join-request-approve-race.test.ts`) still pass — the race test's losing update short-circuits before any service call — but future human-path approve tests must mock the sibling modules (`../services/join-approval.js` or its imports), not the barrel.

---

### Task 6: Finalize endpoint (auto-admit) + client function

**Files:**
- Create: `server/src/routes/onboarding-join.ts`
- Create: `server/src/__tests__/onboarding-join-finalize.test.ts`
- Modify: `server/src/app.ts` (import at ~:17, mount at ~:247)
- Modify: `ui/src/api/onboarding.ts` (add `finalizeInvitedJoin`)

- [ ] **Step 1: Write the failing route test**

```ts
// server/src/__tests__/onboarding-join-finalize.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@armyofagents/db", () => ({
  joinRequests: new Proxy({}, { get: (_t, p) => ({ name: String(p) }) }),
  invites: new Proxy({}, { get: (_t, p) => ({ name: String(p) }) }),
  authUsers: new Proxy({}, { get: (_t, p) => ({ name: String(p) }) }),
}));
vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => a, eq: (...a: unknown[]) => a, desc: (a: unknown) => a,
}));
const approveTx = vi.hoisted(() => vi.fn(async () => ({ id: "r1", status: "approved" })));
vi.mock("../services/join-approval.js", () => ({
  approveHumanJoinRequestTx: approveTx,
  buildHumanJoinApprovalServices: () => ({}),
  autoAdmitApprovalIdentity: () => ({
    approvedByUserId: null,
    attributionUserId: null,
    activityActor: { actorType: "system", actorId: "invite_email_match" },
    approvalSource: "invite_email_match",
  }),
}));
vi.mock("../services/team.js", () => ({
  parseInviteRoleMetadata: (p: Record<string, unknown> | null) =>
    p && (p as { teamInvite?: { email?: string } }).teamInvite?.email
      ? { email: (p as { teamInvite: { email: string } }).teamInvite.email, role: "team_member", projectId: null, parentId: null }
      : null,
}));

import { onboardingJoinRoutes } from "../routes/onboarding-join.js";

type Row = Record<string, unknown>;
/** Sequence db: each select() returns the next configured result set. */
function createSequenceDb(selects: Row[][]) {
  let i = 0;
  const chain = () => {
    const result = selects[i++] ?? [];
    const q = {
      from: () => q, where: () => q, orderBy: () => q, limit: () => q,
      then: (resolve: (rows: Row[]) => unknown) => resolve(result),
    };
    return q;
  };
  return {
    select: chain,
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
  } as never;
}

function handler(db: never) {
  const router = onboardingJoinRoutes(db);
  const layer = (router as unknown as { stack: Array<{ route?: { path: string; stack: Array<{ handle: unknown }> } }> }).stack
    .find((l) => l.route?.path === "/onboarding/join/finalize");
  if (!layer?.route) throw new Error("route not found");
  return layer.route.stack[0]!.handle as (req: unknown, res: unknown) => Promise<void>;
}

function call(db: never, body: Record<string, unknown>, actor = { type: "board", userId: "u1" }) {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  return handler(db)({ actor, body }, { json, status }).then(() => ({ json, status }));
}

const pendingRequest = { id: "r1", inviteId: "i1", status: "pending_approval" };
const validInvite = { id: "i1", revokedAt: null, expiresAt: null, defaultsPayload: { teamInvite: { email: "ada@x.com", role: "team_member" } } };

describe("POST /onboarding/join/finalize", () => {
  beforeEach(() => vi.clearAllMocks());

  it("admits on a verified case-insensitive email match", async () => {
    const db = createSequenceDb([
      [pendingRequest],
      [validInvite],
      [{ email: "ADA@X.COM", emailVerified: true }],
    ]);
    const { json } = await call(db, { companyId: "c1" });
    expect(approveTx).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({
      approvedByUserId: null,
      approvalSource: "invite_email_match",
    }));
    expect(json).toHaveBeenCalledWith({ admitted: true, status: "approved" });
  });

  it("does NOT admit when the email is unverified", async () => {
    const db = createSequenceDb([
      [pendingRequest],
      [validInvite],
      [{ email: "ada@x.com", emailVerified: false }],
    ]);
    const { json } = await call(db, { companyId: "c1" });
    expect(approveTx).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith({ admitted: false, status: "pending" });
  });

  it("does NOT admit on an email mismatch", async () => {
    const db = createSequenceDb([
      [pendingRequest],
      [validInvite],
      [{ email: "mallory@evil.com", emailVerified: true }],
    ]);
    const { json } = await call(db, { companyId: "c1" });
    expect(approveTx).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith({ admitted: false, status: "pending" });
  });

  it("refuses a revoked invite", async () => {
    const db = createSequenceDb([
      [pendingRequest],
      [{ ...validInvite, revokedAt: new Date() }],
    ]);
    const { json } = await call(db, { companyId: "c1" });
    expect(json).toHaveBeenCalledWith({ admitted: false, status: "invite_invalid" });
  });

  it("admits even when expiresAt has passed — validity was established at accept (10-min TTL)", async () => {
    const db = createSequenceDb([
      [pendingRequest],
      [{ ...validInvite, expiresAt: new Date(Date.now() - 60_000) }],
      [{ email: "ada@x.com", emailVerified: true }],
    ]);
    const { json } = await call(db, { companyId: "c1" });
    expect(json).toHaveBeenCalledWith({ admitted: true, status: "approved" });
  });

  it("is idempotent — an already-approved request reports admitted", async () => {
    const db = createSequenceDb([[{ ...pendingRequest, status: "approved" }]]);
    const { json } = await call(db, { companyId: "c1" });
    expect(json).toHaveBeenCalledWith({ admitted: true, status: "approved" });
    expect(approveTx).not.toHaveBeenCalled();
  });

  it("reports a rejected request", async () => {
    const db = createSequenceDb([[{ ...pendingRequest, status: "rejected" }]]);
    const { json } = await call(db, { companyId: "c1" });
    expect(json).toHaveBeenCalledWith({ admitted: false, status: "rejected" });
  });

  it("401s without a board session", async () => {
    const db = createSequenceDb([]);
    const { status } = await call(db, { companyId: "c1" }, { type: "none" } as never);
    expect(status).toHaveBeenCalledWith(401);
  });

  it("404s when the caller has no join request for the company", async () => {
    const db = createSequenceDb([[]]);
    const { status } = await call(db, { companyId: "c1" });
    expect(status).toHaveBeenCalledWith(404);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (module doesn't exist)

Run: `pnpm test:run onboarding-join-finalize`
Expected: FAIL

- [ ] **Step 3: Implement the route**

```ts
// server/src/routes/onboarding-join.ts
import { Router, type Request, type Response } from "express";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { authUsers, invites, joinRequests } from "@armyofagents/db";
import { parseInviteRoleMetadata } from "../services/team.js";
import {
  approveHumanJoinRequestTx,
  autoAdmitApprovalIdentity,
  buildHumanJoinApprovalServices,
} from "../services/join-approval.js";

/**
 * Invited auto-admit (spec §8): the invitation carries the approval. Fired by
 * the InvitedJoinTerminal after the profile step. Self-scoped: only finalizes
 * the CALLER's own pending human join_request. Admits iff the caller's VERIFIED
 * email matches the invited email (case-insensitive), computed fresh here —
 * else the request stays pending for founder approval.
 */
export function onboardingJoinRoutes(db: Db): Router {
  const router = Router();

  router.post("/onboarding/join/finalize", async (req: Request, res: Response) => {
    const actor = req.actor;
    if (actor.type !== "board" || !actor.userId) {
      res.status(401).json({ error: "authentication required" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const companyId = typeof body.companyId === "string" ? body.companyId : "";
    if (!companyId) {
      res.status(400).json({ error: "companyId is required" });
      return;
    }

    const request = await db
      .select()
      .from(joinRequests)
      .where(
        and(
          eq(joinRequests.companyId, companyId),
          eq(joinRequests.requestType, "human"),
          eq(joinRequests.requestingUserId, actor.userId),
        ),
      )
      .orderBy(desc(joinRequests.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!request) {
      res.status(404).json({ error: "no join request for this company" });
      return;
    }
    if (request.status === "approved") {
      res.json({ admitted: true, status: "approved" });
      return;
    }
    if (request.status === "rejected") {
      res.json({ admitted: false, status: "rejected" });
      return;
    }

    const invite = await db
      .select()
      .from(invites)
      .where(eq(invites.id, request.inviteId))
      .then((rows) => rows[0] ?? null);
    // Invite validity was established AT ACCEPT (accept enforces the 10-minute
    // COMPANY_INVITE_TTL and consumes the invite). Do NOT re-check expiresAt
    // here — the TTL clock keeps ticking through Google sign-in + the profile
    // form and would degrade nearly every real auto-admit to pending (spec §9,
    // amended post-review). Keep only a defensive revokedAt check.
    if (!invite || invite.revokedAt) {
      res.json({ admitted: false, status: "invite_invalid" });
      return;
    }

    const user = await db
      .select({ email: authUsers.email, emailVerified: authUsers.emailVerified })
      .from(authUsers)
      .where(eq(authUsers.id, actor.userId))
      .then((rows) => rows[0] ?? null);
    const invitedEmail =
      parseInviteRoleMetadata(invite.defaultsPayload as Record<string, unknown> | null)?.email ?? null;
    const matched = Boolean(
      user?.emailVerified &&
        typeof user.email === "string" &&
        invitedEmail &&
        user.email.trim().toLowerCase() === invitedEmail.trim().toLowerCase(),
    );
    if (!matched) {
      res.json({ admitted: false, status: "pending" });
      return;
    }

    const approved = await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      return approveHumanJoinRequestTx(txDb, buildHumanJoinApprovalServices(txDb), {
        companyId,
        requestId: request.id,
        requestingUserId: actor.userId as string,
        invite: {
          id: invite.id,
          defaultsPayload: invite.defaultsPayload as Record<string, unknown> | null,
        },
        // The preset factory keeps the three-identity contract unmisusable
        // (never impersonates the founder or the invitee).
        ...autoAdmitApprovalIdentity(),
      });
    });
    res.json(approved ? { admitted: true, status: "approved" } : { admitted: false, status: "pending" });
  });

  return router;
}
```

- [ ] **Step 4: Mount it**

In `server/src/app.ts`: add the import next to the other onboarding routes (~line 17):

```ts
import { onboardingJoinRoutes } from "./routes/onboarding-join.js";
```

and mount it next to `onboardingRoutes` (~line 247):

```ts
  app.use("/api", onboardingJoinRoutes(db));
```

- [ ] **Step 5: Client function** — append to `ui/src/api/onboarding.ts`:

```ts
export type FinalizeInvitedJoinResult = {
  admitted: boolean;
  status: "approved" | "pending" | "rejected" | "invite_invalid";
};

/**
 * Invited auto-admit (spec §8): asks the server to finalize the caller's own
 * join request for the company — admits immediately when the verified email
 * matches the invite; otherwise the request stays pending for the founder.
 */
export async function finalizeInvitedJoin(companyId: string): Promise<FinalizeInvitedJoinResult> {
  const res = await fetch("/api/onboarding/join/finalize", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ companyId }),
  });
  if (!res.ok) throw new Error(`finalize failed: ${res.status}`);
  return (await res.json()) as FinalizeInvitedJoinResult;
}
```

- [ ] **Step 6: Run test + typechecks — expect PASS / clean**

Run: `pnpm test:run onboarding-join-finalize` → PASS (all 8)
Run: `pnpm --filter @armyofagents/server typecheck` && `pnpm --filter @armyofagents/ui typecheck` → clean

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/onboarding-join.ts server/src/__tests__/onboarding-join-finalize.test.ts server/src/app.ts ui/src/api/onboarding.ts
git commit -m "feat(onboarding): invited auto-admit finalize endpoint — the invitation carries the approval"
```

---

### Task 7: `HumanProfileStep` + registry rewire

**Files:**
- Create: `ui/src/onboarding/steps/HumanProfileStep.tsx`
- Create: `ui/src/onboarding/steps/__tests__/HumanProfileStep.test.tsx`
- Modify: `ui/src/onboarding/steps/index.ts` (retag `profile` → `["founder"]`; register `human-profile` for invited)
- Modify: `ui/src/onboarding/steps/__tests__/ProfileStep.test.tsx` (if it asserts `journeys` includes `invited`, update to founder-only)

- [ ] **Step 1: Write the failing test**

```tsx
// ui/src/onboarding/steps/__tests__/HumanProfileStep.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { HumanProfileStep } from "../HumanProfileStep";
import { validateRegistry, type StepContext } from "../../registry";
import { ONBOARDING_STEPS } from "../index";

const saveUserProfile = vi.hoisted(() => vi.fn(async (input: unknown) => input));
const getUserProfile = vi.hoisted(() =>
  vi.fn(async () => ({
    userId: "u1", displayName: "Ada", avatarUrl: null, title: null,
    bio: null, timezone: null, socialLinks: [],
  })),
);
vi.mock("../../../api/userProfile", () => ({ saveUserProfile, getUserProfile }));
vi.mock("../../../api/onboarding", () => ({
  advanceOnboarding: vi.fn(async () => ({ completedStates: ["AUTHENTICATED", "PROFILE_SET"] })),
}));

import { advanceOnboarding } from "../../../api/onboarding";

const ctx: StepContext = {
  userId: "u1",
  companyId: null, // invited runs on the user layer
  journey: "invited",
  completedStates: ["AUTHENTICATED"],
};

describe("HumanProfileStep (shared; wired invited)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("prefills Name from the global profile; submit blocked until Title is chosen", async () => {
    render(<HumanProfileStep ctx={ctx} onComplete={vi.fn()} onBack={() => {}} />);
    await waitFor(() =>
      expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Ada"),
    );
    const btn = screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true); // title still missing (timezone auto-detects)
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Engineer" } });
    expect(btn.disabled).toBe(false);
  });

  it("requires a name when no global profile exists yet", async () => {
    getUserProfile.mockResolvedValueOnce(null as never);
    render(<HumanProfileStep ctx={ctx} onComplete={vi.fn()} onBack={() => {}} />);
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Engineer" } });
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ada" } });
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("saves the full global profile (incl timezone) then advances PROFILE_SET", async () => {
    const onComplete = vi.fn();
    render(<HumanProfileStep ctx={ctx} onComplete={onComplete} onBack={() => {}} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ada" } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Engineer" } });
    fireEvent.change(screen.getByLabelText("Timezone"), { target: { value: "Asia/Kolkata" } });
    fireEvent.change(screen.getByLabelText("Short bio (optional)"), { target: { value: "hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(saveUserProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: "Ada",
        title: "Engineer",
        timezone: "Asia/Kolkata",
        bio: "hi",
      }),
    );
    expect(advanceOnboarding).toHaveBeenCalledWith({
      companyId: null,
      journey: "invited",
      requestedState: "PROFILE_SET",
    });
  });

  it("surfaces a save failure and re-enables the button", async () => {
    saveUserProfile.mockRejectedValueOnce(new Error("save blew up"));
    render(<HumanProfileStep ctx={ctx} onComplete={vi.fn()} onBack={() => {}} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ada" } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Engineer" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("save blew up")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("registry rewire", () => {
  it("still passes the guard", () => {
    expect(validateRegistry(ONBOARDING_STEPS)).toEqual([]);
  });
  it("invited uses human-profile; founder keeps the bare profile step", () => {
    const bare = ONBOARDING_STEPS.find((s) => s.id === "profile");
    const rich = ONBOARDING_STEPS.find((s) => s.id === "human-profile");
    expect(bare?.journeys).toEqual(["founder"]);
    expect(rich?.journeys).toEqual(["invited"]);
    expect(rich?.state).toBe("PROFILE_SET");
    expect(rich?.order).toBe(1);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (component + registry entry missing)

Run: `pnpm --filter @armyofagents/ui test:run src/onboarding/steps/__tests__/HumanProfileStep`
Expected: FAIL

- [ ] **Step 3: Create the component**

```tsx
// ui/src/onboarding/steps/HumanProfileStep.tsx
import { useEffect, useMemo, useState } from "react";
import type { StepProps } from "../registry";
import { getUserProfile, saveUserProfile } from "../../api/userProfile";
import { advanceOnboarding } from "../../api/onboarding";
import { HUMAN_TITLE_OPTIONS, getTimezoneOptions } from "@/lib/human-profile-constants";
import { Button } from "@/components/ui/button";

const FIELD =
  "w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring";

/**
 * Shared Human Operating Profile step (spec §6). Journey-agnostic; wired for
 * the INVITED journey now (supersedes the bare ProfileStep there — founder
 * wiring is a later follow-up). Writes the GLOBAL user profile — the company
 * record is materialized by the approval transaction (spec §7). Name + Title +
 * Timezone are required (spec decision 1); Bio + Social links are optional.
 */
export function HumanProfileStep({ ctx, onComplete }: StepProps) {
  const timezoneOptions = useMemo(() => getTimezoneOptions(), []);
  const detected = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
    } catch {
      return "";
    }
  }, []);
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [timezone, setTimezone] = useState(detected);
  const [bio, setBio] = useState("");
  const [links, setLinks] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Prefill from the existing global profile — Name arrives from Google via the
  // auth-synced profile (spec §5: "Name is prefilled"); a returning user
  // resumes their saved values. User-typed values are never overwritten.
  useEffect(() => {
    let cancelled = false;
    void getUserProfile()
      .then((p) => {
        if (cancelled || !p) return;
        setName((v) => v || p.displayName || "");
        setTitle((v) => v || p.title || "");
        setBio((v) => v || p.bio || "");
        if (p.timezone) setTimezone((v) => v || p.timezone || "");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const canSubmit = Boolean(name.trim() && title && timezone) && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await saveUserProfile({
        displayName: name.trim(),
        title,
        timezone,
        bio: bio.trim() || null,
        socialLinks: links
          .map((url) => url.trim())
          .filter(Boolean)
          .map((url) => ({ type: "website", label: null, url })),
      });
      await advanceOnboarding({
        companyId: ctx.companyId,
        journey: ctx.journey,
        requestedState: "PROFILE_SET",
      });
      onComplete();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save your profile.");
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-md py-10">
      <h1 className="text-xl font-semibold">Set up your profile</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        This is how your team — and its agents — will know you.
      </p>

      <label className="mt-6 mb-1 block text-xs text-muted-foreground" htmlFor="hp-name">
        Name
      </label>
      <input id="hp-name" aria-label="Name" className={FIELD} value={name} onChange={(e) => setName(e.target.value)} autoFocus />

      <label className="mt-3 mb-1 block text-xs text-muted-foreground" htmlFor="hp-title">
        Title
      </label>
      <select id="hp-title" aria-label="Title" className={FIELD} value={title} onChange={(e) => setTitle(e.target.value)}>
        <option value="">Select a title…</option>
        {HUMAN_TITLE_OPTIONS.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>

      <label className="mt-3 mb-1 block text-xs text-muted-foreground" htmlFor="hp-tz">
        Timezone
      </label>
      <select id="hp-tz" aria-label="Timezone" className={FIELD} value={timezone} onChange={(e) => setTimezone(e.target.value)}>
        <option value="">Select a timezone…</option>
        {timezoneOptions.map((tz) => (
          <option key={tz} value={tz}>
            {tz}
          </option>
        ))}
      </select>

      <label className="mt-3 mb-1 block text-xs text-muted-foreground" htmlFor="hp-bio">
        Short bio (optional)
      </label>
      <textarea id="hp-bio" aria-label="Short bio (optional)" className={FIELD} rows={2} value={bio} onChange={(e) => setBio(e.target.value)} />

      <div className="mt-3">
        <span className="mb-1 block text-xs text-muted-foreground">Social links (optional)</span>
        {links.map((url, i) => (
          <input
            key={i}
            aria-label={`Social link ${i + 1}`}
            className={`${FIELD} mt-1`}
            placeholder="https://…"
            value={url}
            onChange={(e) => setLinks((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))}
          />
        ))}
        <button
          type="button"
          className="mt-1 text-xs text-muted-foreground underline"
          onClick={() => setLinks((prev) => [...prev, ""])}
        >
          + Add link
        </button>
      </div>

      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      <Button className="mt-4 w-full" onClick={() => void submit()} disabled={!canSubmit}>
        {busy ? "Saving…" : "Continue"}
      </Button>
    </div>
  );
}
```

- [ ] **Step 4: Rewire the registry** — in `ui/src/onboarding/steps/index.ts`:

(a) import: `import { HumanProfileStep } from "./HumanProfileStep";`
(b) change the `profile` entry's journeys: `journeys: ["founder", "invited"],` → `journeys: ["founder"],`
(c) insert AFTER the `profile` entry:

```ts
  {
    id: "human-profile",
    order: 1,
    state: "PROFILE_SET",
    journeys: ["invited"],
    dependsOn: ["AUTHENTICATED"],
    canSkip: false,
    shouldInclude: () => true,
    isComplete: (ctx) => ctx.completedStates.includes("PROFILE_SET"),
    Component: HumanProfileStep,
    title: "Set up your profile",
  },
```

(d) In `ProfileStep.test.tsx`, if a registry assertion expects `journeys` containing `"invited"` for the `profile` step, change it to `["founder"]`.

- [ ] **Step 5: Run tests — expect PASS** (HumanProfileStep + ProfileStep + registry files)

Run: `pnpm --filter @armyofagents/ui test:run src/onboarding/steps/__tests__/HumanProfileStep src/onboarding/steps/__tests__/ProfileStep` → PASS

- [ ] **Step 6: Commit**

```bash
git add ui/src/onboarding/steps/HumanProfileStep.tsx ui/src/onboarding/steps/__tests__/HumanProfileStep.test.tsx ui/src/onboarding/steps/index.ts ui/src/onboarding/steps/__tests__/ProfileStep.test.tsx
git commit -m "feat(onboarding): shared HumanProfileStep — invited journey collects the operating profile"
```

---

### Task 8: `InvitedJoinTerminal` + OnboardingFlow wiring

> **Amendments carried from the Task-6 quality review (implement WITH this task):**
> 1. `finalizeInvitedJoin` (ui/src/api/onboarding.ts) attaches the HTTP status to its error: `throw Object.assign(new Error(\`finalize failed: ${res.status}\`), { status: res.status });`
> 2. The terminal must NOT call finalize only on the first tick — a transient failure would silently downgrade an auto-admit-eligible user to founder-wait. Instead: keep attempting finalize on each poll tick until it returns a definitive response (any `{admitted, status}` body), tracked via a ref; a thrown error with `status === 401` → session gone → `navigate("/auth?next=/onboarding/join", { replace: true })`; other throws → retry next tick (finalize is idempotent).
> 3. Server-test hardening in `server/src/__tests__/onboarding-join-finalize.test.ts`: (a) capture `where()` args in the sequence-db and assert the request lookup binds `requestingUserId` to the actor ("u1") — the self-scoping WHERE must be regression-locked; (b) add the 400 missing-companyId test (direct handler call with the res.status mock); (c) add a raced-null test (`approveTx` resolves null → `{admitted:false,status:"pending"}`).
> 4. Terminal tests additionally cover: transient finalize throw → retried on next tick; 401 throw → navigates to /auth.

**Files:**
- Create: `ui/src/onboarding/InvitedJoinTerminal.tsx`
- Create: `ui/src/onboarding/__tests__/InvitedJoinTerminal.test.tsx`
- Modify: `ui/src/pages/OnboardingFlow.tsx` (replace `InvitedPendingPage` with the terminal)
- Modify: `ui/src/pages/__tests__/OnboardingFlow.test.tsx` (invited test asserts the terminal renders)

- [ ] **Step 1: Write the failing terminal test**

```tsx
// ui/src/onboarding/__tests__/InvitedJoinTerminal.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { InvitedJoinTerminal } from "../InvitedJoinTerminal";

const mockNavigate = vi.hoisted(() => vi.fn());
const routerState = vi.hoisted(() => ({ searchParams: new URLSearchParams() }));
vi.mock("@/lib/router", () => ({
  useNavigate: () => mockNavigate,
  useSearchParams: () => [routerState.searchParams],
}));
const mockRemoveQueries = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => ({ removeQueries: mockRemoveQueries }),
}));
const fetchJourney = vi.hoisted(() => vi.fn());
const finalizeInvitedJoin = vi.hoisted(() => vi.fn());
vi.mock("../../api/onboarding", () => ({ fetchJourney, finalizeInvitedJoin }));

const invitedJourney = {
  journey: "invited",
  targetCompanyId: "c1",
  pendingInvitations: [
    { companyId: "c1", companyName: "Acme", inviteId: "r1", role: "team_member", createdAt: "" },
  ],
  inviteToken: null,
};

describe("InvitedJoinTerminal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    routerState.searchParams = new URLSearchParams();
    fetchJourney.mockResolvedValue(invitedJourney);
    finalizeInvitedJoin.mockResolvedValue({ admitted: false, status: "pending" });
  });
  afterEach(() => vi.useRealTimers());

  it("auto-admits: finalize returns admitted → evicts the journey cache and enters", async () => {
    finalizeInvitedJoin.mockResolvedValue({ admitted: true, status: "approved" });
    render(<InvitedJoinTerminal />);
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith("/", { replace: true }));
    expect(finalizeInvitedJoin).toHaveBeenCalledWith("c1");
    expect(mockRemoveQueries).toHaveBeenCalledWith({ queryKey: ["onboarding", "journey"], exact: true });
    expect(mockRemoveQueries.mock.invocationCallOrder[0]).toBeLessThan(
      mockNavigate.mock.invocationCallOrder[0]!,
    );
  });

  it("not admitted → shows the pending screen with company + role", async () => {
    render(<InvitedJoinTerminal />);
    expect(await screen.findByText(/joining/i)).toBeTruthy();
    expect(screen.getByText(/Acme/)).toBeTruthy();
    expect(screen.getByText(/team_member/)).toBeTruthy();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("polls: enters when the journey flips to returning (founder approved)", async () => {
    render(<InvitedJoinTerminal />);
    await screen.findByText(/joining/i);
    fetchJourney.mockResolvedValue({ ...invitedJourney, journey: "returning" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith("/", { replace: true }));
  });

  it("rejected finalize → terminal not-approved state, never navigates to /", async () => {
    finalizeInvitedJoin.mockResolvedValue({ admitted: false, status: "rejected" });
    render(<InvitedJoinTerminal />);
    expect(await screen.findByText(/not approved/i)).toBeTruthy();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("journey no longer invited (and not returning) → not-approved terminal", async () => {
    fetchJourney.mockResolvedValue({ ...invitedJourney, journey: "founder", pendingInvitations: [] });
    render(<InvitedJoinTerminal />);
    expect(await screen.findByText(/not approved/i)).toBeTruthy();
  });

  it("prefers the deep-linked ?company= over the resolver's first invitation", async () => {
    routerState.searchParams = new URLSearchParams("company=c2");
    fetchJourney.mockResolvedValue({
      ...invitedJourney,
      pendingInvitations: [
        ...invitedJourney.pendingInvitations,
        { companyId: "c2", companyName: "Beta", inviteId: "r2", role: "team_lead", createdAt: "" },
      ],
    });
    render(<InvitedJoinTerminal />);
    await screen.findByText(/Beta/);
    expect(finalizeInvitedJoin).toHaveBeenCalledWith("c2");
  });

  it("invite_invalid → distinct copy, keeps polling (founder can still approve)", async () => {
    finalizeInvitedJoin.mockResolvedValue({ admitted: false, status: "invite_invalid" });
    render(<InvitedJoinTerminal />);
    expect(await screen.findByText(/no longer valid/i)).toBeTruthy();
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (component missing)

Run: `pnpm --filter @armyofagents/ui test:run src/onboarding/__tests__/InvitedJoinTerminal`
Expected: FAIL

- [ ] **Step 3: Create the component**

```tsx
// ui/src/onboarding/InvitedJoinTerminal.tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "@/lib/router";
import { fetchJourney, finalizeInvitedJoin } from "../api/onboarding";

const POLL_MS = 7000;

type Phase = "checking" | "pending" | "invite_invalid" | "not_approved";

/**
 * Terminal of the invited journey (spec §6). On mount: finalize once — a
 * verified email match admits immediately (the invitation carried the
 * approval). Otherwise poll the journey until the founder approves
 * (journey→returning) or the request is rejected / invalidated. Never
 * navigates to "/" while still invited — that re-triggers the join loop.
 */
export function InvitedJoinTerminal() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const [phase, setPhase] = useState<Phase>("checking");
  const [company, setCompany] = useState<{ name: string; role: string } | null>(null);
  const timerRef = useRef<number | null>(null);

  const enter = useCallback(() => {
    // Evict the gate's cached pre-approval `invited` journey — otherwise the
    // index gate can bounce us straight back to /onboarding/join.
    queryClient.removeQueries({ queryKey: ["onboarding", "journey"], exact: true });
    navigate("/", { replace: true });
  }, [navigate, queryClient]);

  useEffect(() => {
    let cancelled = false;
    const tick = async (first: boolean) => {
      try {
        const j = await fetchJourney();
        if (cancelled) return;
        if (j.journey === "returning") {
          enter();
          return;
        }
        if (j.journey !== "invited") {
          // No membership and no pending invitation left → rejected/expired.
          setPhase("not_approved");
          return;
        }
        // Prefer the deep-linked ?company= (InviteLanding passes it) when it is
        // one of the caller's pending invitations; else the resolver's target.
        const deepLinked = searchParams.get("company");
        const targetId =
          (deepLinked && j.pendingInvitations.some((p) => p.companyId === deepLinked)
            ? deepLinked
            : j.targetCompanyId) ?? null;
        const inv =
          j.pendingInvitations.find((p) => p.companyId === targetId) ??
          j.pendingInvitations[0] ??
          null;
        if (inv) setCompany({ name: inv.companyName, role: inv.role });
        if (first && targetId) {
          const result = await finalizeInvitedJoin(targetId);
          if (cancelled) return;
          if (result.admitted) {
            enter();
            return;
          }
          if (result.status === "rejected") {
            setPhase("not_approved");
            return;
          }
          // invite_invalid: distinct copy (spec §9), but keep polling — the
          // founder can still approve the pending request manually.
          setPhase(result.status === "invite_invalid" ? "invite_invalid" : "pending");
        } else {
          setPhase((p) => (p === "invite_invalid" ? p : "pending"));
        }
      } catch {
        if (!cancelled) setPhase((p) => (p === "checking" ? "pending" : p));
      }
      if (!cancelled) {
        timerRef.current = window.setTimeout(() => void tick(false), POLL_MS);
      }
    };
    void tick(true);
    return () => {
      cancelled = true;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [enter, searchParams]);

  if (phase === "checking") {
    return <div className="mx-auto max-w-md py-16 text-sm text-muted-foreground">Checking your invitation…</div>;
  }
  if (phase === "not_approved") {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <h1 className="text-xl font-semibold">Request not approved</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Your request to join{company ? ` ${company.name}` : ""} wasn't approved, or the invite is no
          longer valid. Ask your admin for a new invitation.
        </p>
      </div>
    );
  }
  if (phase === "invite_invalid") {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <h1 className="text-xl font-semibold">
          You're joining{company ? ` ${company.name}` : ""}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Your invite link is no longer valid, but your request is with the admin for approval —
          this page will let you in automatically the moment it's approved.
        </p>
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="text-xl font-semibold">
        You're joining{company ? ` ${company.name}` : ""}
        {company ? ` as ${company.role}` : ""}
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Your request is with the admin for approval. This page will let you in automatically the
        moment it's approved — you can also come back later.
      </p>
    </div>
  );
}
```

- [ ] **Step 4: Wire it into OnboardingFlow**

In `ui/src/pages/OnboardingFlow.tsx`:
(a) delete the `InvitedPendingPage` function entirely;
(b) add `import { InvitedJoinTerminal } from "../onboarding/InvitedJoinTerminal";`
(c) replace

```tsx
  if (journey === "invited" && invitedDone) {
    return <InvitedPendingPage />;
  }
```

with

```tsx
  if (journey === "invited" && invitedDone) {
    return <InvitedJoinTerminal />;
  }
```

(everything else — founder paths, `?new=1`, `invitedDone` state, the `onFinished` invited branch — stays untouched).

- [ ] **Step 5: Update the existing OnboardingFlow invited test**

In `ui/src/pages/__tests__/OnboardingFlow.test.tsx`: add near the other mocks

```tsx
vi.mock("../../onboarding/InvitedJoinTerminal", () => ({
  InvitedJoinTerminal: () => <div>invited-join-terminal</div>,
}));
```

and change the invited test's assertions from the old stub text to:

```tsx
    expect(await screen.findByText("invited-join-terminal")).toBeTruthy();
    // must NOT navigate to "/" — that is exactly what re-triggers the invited loop
    expect(mockNavigate).not.toHaveBeenCalledWith("/", { replace: true });
```

- [ ] **Step 6: Run tests — expect PASS**

Run: `pnpm --filter @armyofagents/ui test:run src/onboarding/__tests__/InvitedJoinTerminal src/pages/__tests__/OnboardingFlow` → PASS

- [ ] **Step 7: Commit**

```bash
git add ui/src/onboarding/InvitedJoinTerminal.tsx ui/src/onboarding/__tests__/InvitedJoinTerminal.test.tsx ui/src/pages/OnboardingFlow.tsx ui/src/pages/__tests__/OnboardingFlow.test.tsx
git commit -m "feat(onboarding): InvitedJoinTerminal — auto-admit finalize + live approval polling"
```

---

### Task 9: InviteLanding routes humans into the guided flow

**Files:**
- Modify: `ui/src/pages/InviteLanding.tsx` (the `acceptMutation.onSuccess` at ~:107-114)

- [ ] **Step 1: Implement the redirect** (human, non-bootstrap accepts only — the agent path keeps its claim-secret result screen)

In `acceptMutation`'s `onSuccess`, after the two `invalidateQueries` calls and the `asBootstrap` computation, replace `setResult({ kind: asBootstrap ? "bootstrap" : "join", payload });` with:

```tsx
      if (!asBootstrap && joinType === "human") {
        // Human accepts continue into the guided invited onboarding (profile →
        // auto-admit/pending) instead of the inline "request submitted" screen.
        const companyId = (payload as { companyId?: string | null })?.companyId ?? "";
        queryClient.removeQueries({ queryKey: ["onboarding", "journey"], exact: true });
        navigate(`/onboarding/join?company=${encodeURIComponent(companyId)}`, { replace: true });
        return;
      }
      setResult({ kind: asBootstrap ? "bootstrap" : "join", payload });
```

**InviteLanding has NO `useNavigate` today** (`InviteLanding.tsx:3` imports only `Link, useParams` from `@/lib/router`). Two additions are required: (a) extend that import to include `useNavigate`, and (b) bind it in the component body next to the existing hooks (~line 45): `const navigate = useNavigate();`. `queryClient` is already in scope from the existing `invalidateQueries` calls, and the human accept 202 response spreads the join_request row, so `payload.companyId` is present (`access.ts:2334`).

- [ ] **Step 2: UI typecheck + run any existing InviteLanding tests**

Run: `pnpm --filter @armyofagents/ui typecheck` → clean
Run: `pnpm --filter @armyofagents/ui test:run InviteLanding` → PASS (or "no tests found" if none exist)

- [ ] **Step 3: Commit**

```bash
git add ui/src/pages/InviteLanding.tsx
git commit -m "feat(onboarding): human invite accepts continue into the guided invited flow"
```

---

### Task 10: `addMember` convergence (manual adds get the same human record)

**Files:**
- Modify: `server/src/services/team.ts` (`addMember`, ~:678-750 — after the `ensureStandardDocuments` call)
- Create: `server/src/services/__tests__/add-member-profile-seed.test.ts` *(skip creating if mocking `addMember`'s auth-user creation proves disproportionate — see Step 3)*

- [ ] **Step 1: Implement** — in `addMember`, right after the existing `humanCapabilities.ensureStandardDocuments(...)` call, add:

```ts
    // Converge with the invited path (join-approval.ts): manually-added humans
    // also get a company profile row materialized from their global profile.
    try {
      const globalProfile = await getUserProfile(db, userId);
      await updateCompanyUserProfile(
        companyId,
        userId,
        {
          displayName: globalProfile?.displayName ?? null,
          title: globalProfile?.title ?? null,
          bio: globalProfile?.bio ?? null,
          socialLinks: globalProfile?.socialLinks ?? [],
          timezone: globalProfile?.timezone ?? null,
        },
        addedByUserId,
      );
    } catch {
      // best-effort — never fail the add
    }
```

(Verified against `team.ts:678-682`: the member's id local is `userId` and the actor is `addedByUserId: string` (non-null — no `?? null` needed). `addMember` is NOT transaction-wrapped; `updateCompanyUserProfile` is a same-closure sibling — call it directly. Add `import { getUserProfile } from "./user-profiles.js";` to team.ts imports.)

- [ ] **Step 2: Server typecheck + full suite**

Run: `pnpm --filter @armyofagents/server typecheck` → clean
Run: `pnpm test:run server/src` → green

- [ ] **Step 3: Test judgment call** — if an existing `addMember` test exists, extend it to assert `updateCompanyUserProfile` effects; if none exists and mocking the full `addMember` flow (auth-user creation + membership + role) requires a disproportionate harness, note it in the commit body and rely on the join-approval tests covering the identical seeding block.

- [ ] **Step 4: Commit**

```bash
git add server/src/services/team.ts
git commit -m "feat(team): manual addMember materializes the company human profile (convergence)"
```

---

### Task 11: Full verification + docs

- [ ] **Step 1: Full suites + typechecks**

Run: `pnpm test:run server/src` → green
Run: `pnpm --filter @armyofagents/ui test:run` → green
Run: `pnpm --filter @armyofagents/server typecheck` && `pnpm --filter @armyofagents/ui typecheck` → clean

- [ ] **Step 2: Update the spec + roadmap** — in `2026-07-16-invited-teammate-journey-scope.md` header, set Status to "implemented — see plan"; in `2026-07-13-onboarding-auth-remaining-phases.md` §Track B, add a one-line pointer to this plan + spec.

- [ ] **Step 3: Commit**

```bash
git add docs/aoa/plans/2026-07-16-invited-teammate-journey-scope.md docs/aoa/plans/2026-07-13-onboarding-auth-remaining-phases.md
git commit -m "docs(onboarding): Track B spec/roadmap status — invited journey implemented"
```

---

## Post-plan verification notes (not tasks)

- **Live validation** needs a **second Google account**: founder invites it (email-targeted) on the isolated authenticated instance (`bash ~/.aoa/instances/onboarding-test/start.sh`, rebuild UI first) → matched auto-admit path; then an open-link/mismatch invite → pending + founder-approve path. The USER performs all Google logins.
- **e2e** (matched + mismatch paths) folds into Track D / A12 (mocked-Google helper) — explicitly deferred.
- **Known accepted gaps:** an invitee whose PROFILE_SET predates this feature skips the profile step → timezone null on the company profile (fill later on the Human page). Open-link invites always take the pending path (by design).
- **Review follow-ups (recorded during execution, not blocking):** (1) **DONE** (commit 89774415c) — the seeding block in `approveHumanJoinRequestTx` is wrapped in a nested `txDb.transaction(...)` (SAVEPOINT), so best-effort holds for DB-level failures too. (2) Remaining: the global PATCH `/user-profile` route (`server/src/routes/user-profiles.ts:39`) still accepts `socialLinks` with only an Array.isArray check — pre-existing laxity; the seeding-side normalization (parse-filter through `humanSocialLinkSchema`) IS done in 89774415c, so the laxity is confined to the PATCH route's own input validation.
