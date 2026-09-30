# Stage D — Invited Routing (minimal) + Security/E2E Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Read `2026-07-12-onboarding-auth-redesign-stage0-contracts.md` (THE CONTRACT) first — it defines every shared type referenced here. This stage BUILDS ON Stage A (`resolvePostAuthJourney`, `GET /api/onboarding/journey`, `getJourneyForUser`, actor changes) and Stage B (`onboarding_progress` table, `onboardingProgress` service, `StepDefinition` registry, `FlowEngine`, `resolveNextStep`) and Stage C (`user_profiles` table, `userProfilesService`, the founder step UIs, Commander verify, taxonomy). Do **not** redefine those — reference them as available contracts.

**Goal:** Ship the **minimal invited-human journey** (Google auth → profile → join your org, never create-org), prove the invited journey excludes org/environment/commander/department/agent creation, and land the enterprise **security + e2e hardening** pass (OAuth state/PKCE, cookie flags, escape-hatch fail-closed, no-secrets-in-URLs/logs, encrypted API-key storage, four Playwright happy/edge paths, and a full-suite green gate).

**Architecture:** The invited journey reuses the **existing** invite/join machinery verbatim — `POST /api/invites/:token/accept` (server/src/routes/access.ts:1903) creates a `join_requests` row (`pending_approval`); board approval via `POST /api/companies/:companyId/join-requests/:requestId/approve` (access.ts:2402) calls `accessService.ensureMembership` + `setPrincipalGrants` + `teamService.applyInviteRole`. Stage D adds a thin `POST /api/onboarding/join` route that only (a) ensures the global `user_profiles` row (Stage C `userProfilesService`), (b) seeds `company_user_profiles`, and (c) writes `onboarding_progress` with `journey="invited"` — it does **not** reimplement acceptance. Invited detection is hardened at the journey resolver so hashed-token and email-match lookups actually work. Security tasks are TDD contract/integration tests over Stage A's better-auth config + actor middleware + the secrets chokepoint.

**Tech stack:** better-auth, Express 5, Drizzle (Postgres), Vitest, React + Vite, Playwright. Package manager: **pnpm**.

**Ships independently:** after Stage D, an invited human who follows their `/invite/:token` link and signs in with Google lands on a lightweight "profile → join your org" screen (never the founder create-org flow), their join request is filed through the existing approval path, and the full test pyramid (unit/integration/e2e/security) is green. It depends on Stages A–C being merged.

---

## Pre-flight (once, before Task D1)

- [ ] **Confirm Stage A–C artifacts exist on the branch**

Run: `git log --oneline -20` and confirm Stage A/B/C commits are present. Then verify the contract files this stage imports:

```bash
ls server/src/services/post-auth-journey.ts server/src/routes/onboarding-journey.ts   # Stage A
ls server/src/services/onboarding.ts server/src/routes/onboarding.ts                   # Stage B
ls ui/src/onboarding/registry.ts ui/src/onboarding/FlowEngine.tsx                      # Stage B
ls packages/db/src/schema/onboarding_progress.ts packages/db/src/schema/user_profiles.ts
ls server/src/services/user-profiles.ts ui/src/onboarding/steps                        # Stage C
```

Expected: all present. If any is missing, Stage D is blocked — stop and reconcile stage order.

- [ ] **Confirm test/build script names** (same as Stage A pre-flight)

Run: `cat server/package.json | grep -A2 '"scripts"'` and `cat package.json | grep -A2 '"scripts"'`
Expected: note the server test script (`vitest run`), the ui test script, and root `verify` / `db:generate`. Use the confirmed names in every `Run:` step below.

> **Task author:** Stage B chose the exact exported names of the `onboarding_progress` service. Before D2, confirm them: `grep -n "export function\|export async function\|return {" server/src/services/onboarding.ts`. This plan calls `onboardingProgressService(db)` with an `upsertProgress({ userId, companyId, journey, currentState, completedStates })` method — if Stage B named these differently (e.g. `recordState` / `advance`), use Stage B's names and keep the same argument shape.

---

## Task D1: Invited journey states + registry-exclusion contract

Locks the invited journey's state list and proves (against the Stage B registry) that the invited journey **excludes** org/environment/commander/department/agent steps (scope item 2).

**Files:**
- Modify: `packages/shared/src/constants.ts` (append, next to `FOUNDER_PHASE1_STATES` from Stage 0 §3.1)
- Test: `packages/shared/src/__tests__/invited-journey-states.test.ts` (new) and `ui/src/onboarding/__tests__/invited-registry.test.ts` (new)

- [ ] **Step 1: Write the failing shared-constant test**

```ts
// packages/shared/src/__tests__/invited-journey-states.test.ts
import { describe, it, expect } from "vitest";
import { INVITED_PHASE1_STATES, FOUNDER_PHASE1_STATES } from "../constants.js";

describe("INVITED_PHASE1_STATES", () => {
  it("is the minimal profile→join path (no org/env/commander/dept/agent)", () => {
    expect(INVITED_PHASE1_STATES).toEqual(["AUTHENTICATED", "PROFILE_SET", "SETUP_COMPLETE"]);
  });
  it("excludes every founder-only workspace-setup state", () => {
    const founderOnly = [
      "ORGANIZATION_CREATED",
      "ENVIRONMENT_READY",
      "COMMANDER_SELECTED",
      "COMMANDER_VERIFIED",
      "DEPARTMENT_CREATED",
      "AGENT_ASSIGNED",
    ];
    for (const s of founderOnly) expect(INVITED_PHASE1_STATES).not.toContain(s);
  });
  it("every invited state is also a valid founder state (shared enum, no drift)", () => {
    for (const s of INVITED_PHASE1_STATES) {
      if (s === "SETUP_COMPLETE") continue; // terminal, shared
      expect(FOUNDER_PHASE1_STATES).toContain(s);
    }
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm test:run src/__tests__/invited-journey-states.test.ts`
Expected: FAIL — `INVITED_PHASE1_STATES` not exported.

- [ ] **Step 3: Append the constant**

In `packages/shared/src/constants.ts`, directly after the `FOUNDER_PHASE1_STATES` block (Stage 0 §3.1):

```ts
// The ordered invited-journey states Phase 1 actually drives.
// Minimal: authenticate → set profile → land (join request filed for approval).
// Deliberately NO org/environment/commander/department/agent states — an invited
// human never runs org creation (scope §5.2, D6). SETUP_COMPLETE is the shared
// terminal state (reused from the reserved enum; no invited-specific state minted).
export const INVITED_PHASE1_STATES: OnboardingState[] = [
  "AUTHENTICATED",
  "PROFILE_SET",
  "SETUP_COMPLETE",
];
```

- [ ] **Step 4: Run shared test, verify pass**

Run: `pnpm test:run src/__tests__/invited-journey-states.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing registry-exclusion test**

This asserts the Stage B registry filters by `journeys` correctly. `resolveNextStep` and the `registry` array are Stage B contracts (Stage 0 §4).

```tsx
// ui/src/onboarding/__tests__/invited-registry.test.ts
import { describe, it, expect } from "vitest";
import { registry } from "../registry";

const invitedSteps = registry.filter((s) => s.journeys.includes("invited"));
const founderOnlyStates = new Set([
  "ORGANIZATION_CREATED",
  "ENVIRONMENT_READY",
  "COMMANDER_SELECTED",
  "COMMANDER_VERIFIED",
  "DEPARTMENT_CREATED",
  "AGENT_ASSIGNED",
]);

describe("invited journey registry", () => {
  it("includes exactly the profile step and the join step", () => {
    const ids = invitedSteps.map((s) => s.id).sort();
    expect(ids).toEqual(["join", "profile"]);
  });
  it("no invited step satisfies a founder-only workspace-setup state", () => {
    for (const step of invitedSteps) {
      expect(founderOnlyStates.has(step.state)).toBe(false);
    }
  });
  it("founder steps are NOT tagged invited", () => {
    const orgStep = registry.find((s) => s.id === "organization");
    expect(orgStep?.journeys).not.toContain("invited");
  });
});
```

- [ ] **Step 6: Run test, verify it fails, then wire the registry**

Run: `pnpm --filter @armyofagents/ui test:run src/onboarding/__tests__/invited-registry.test.ts`
Expected: first FAIL — the `join` step doesn't exist yet and/or `profile` isn't tagged `invited`. This test is completed by **Task D4** (which adds the `join` step and tags `profile` with `["founder","invited"]`). Leave it red here and reference it forward; it flips green at the end of D4.

> The `profile` step is created in Stage C tagged `journeys: ["founder"]`. Task D4 widens it to `["founder", "invited"]`. Do not duplicate the profile step.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/constants.ts packages/shared/src/__tests__/invited-journey-states.test.ts ui/src/onboarding/__tests__/invited-registry.test.ts
git commit -m "feat(onboarding): invited-journey states + registry-exclusion contract"
```

---

## Task D2: `POST /api/onboarding/join` — profile-ensure + progress (reuses acceptance, does not reimplement it)

The invited join has two server touchpoints: (1) the **existing** `POST /api/invites/:token/accept` files the join request (reused verbatim, no change), and (2) this **new** thin route records identity + progress. Splitting it keeps invite acceptance 100% reused.

**Files:**
- Create: `server/src/routes/onboarding-join.ts`
- Modify: `server/src/routes/onboarding.ts` (mount the handler alongside Stage B's onboarding routes) — or mount in the authenticated router where Stage A mounted `onboarding-journey`
- Test: `server/src/__tests__/onboarding-join-route.test.ts`

- [ ] **Step 1: Write the failing test** (service-with-mocks pattern; follow existing `server/src/__tests__/*.test.ts` proxy-mock convention)

```ts
// server/src/__tests__/onboarding-join-route.test.ts
import { describe, it, expect, vi } from "vitest";
import { completeInvitedJoin } from "../routes/onboarding-join.js";

describe("completeInvitedJoin", () => {
  it("ensures the profile, seeds the company profile, and records invited progress", async () => {
    const calls: Record<string, unknown[]> = { ensure: [], seed: [], progress: [] };
    const deps = {
      userProfiles: {
        ensureProfile: vi.fn(async (a: unknown) => { calls.ensure.push(a); return { userId: "u1" }; }),
        seedCompanyUserProfile: vi.fn(async (a: unknown) => { calls.seed.push(a); return { id: "cp1" }; }),
      },
      onboarding: {
        upsertProgress: vi.fn(async (a: unknown) => { calls.progress.push(a); return { id: "op1" }; }),
      },
      membershipExists: vi.fn(async () => false),
    };
    const result = await completeInvitedJoin(deps as never, {
      userId: "u1",
      email: "invitee@x.com",
      displayName: "Invitee",
      avatarUrl: null,
      targetCompanyId: "c2",
    });
    expect(deps.userProfiles.ensureProfile).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", displayName: "Invitee" }),
    );
    expect(deps.userProfiles.seedCompanyUserProfile).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: "c2", userId: "u1" }),
    );
    expect(deps.onboarding.upsertProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u1",
        companyId: "c2",
        journey: "invited",
        currentState: "SETUP_COMPLETE",
        completedStates: ["AUTHENTICATED", "PROFILE_SET", "SETUP_COMPLETE"],
      }),
    );
    expect(result.journey).toBe("invited");
  });

  it("requires a target company", async () => {
    await expect(
      completeInvitedJoin({} as never, {
        userId: "u1", email: "x@x.com", displayName: null, avatarUrl: null, targetCompanyId: null,
      }),
    ).rejects.toThrow(/target company/i);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm test:run src/__tests__/onboarding-join-route.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the handler (dependency-injected core + Express wrapper)**

```ts
// server/src/routes/onboarding-join.ts
import { Router } from "express";
import type { Request } from "express";
import { and, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { authUsers, companyMemberships } from "@armyofagents/db";
import { INVITED_PHASE1_STATES } from "@armyofagents/shared";
import { badRequest, unauthorized } from "../errors.js";
import { userProfilesService } from "../services/user-profiles.js";       // Stage C
import { onboardingProgressService } from "../services/onboarding.js";     // Stage B

export type CompleteInvitedJoinDeps = {
  userProfiles: {
    ensureProfile: (args: {
      userId: string;
      displayName: string | null;
      avatarUrl: string | null;
    }) => Promise<unknown>;
    seedCompanyUserProfile: (args: { companyId: string; userId: string }) => Promise<unknown>;
  };
  onboarding: {
    upsertProgress: (args: {
      userId: string;
      companyId: string;
      journey: "invited";
      currentState: string;
      completedStates: string[];
    }) => Promise<unknown>;
  };
  membershipExists: (companyId: string, userId: string) => Promise<boolean>;
};

export async function completeInvitedJoin(
  deps: CompleteInvitedJoinDeps,
  input: {
    userId: string;
    email: string | null;
    displayName: string | null;
    avatarUrl: string | null;
    targetCompanyId: string | null;
  },
): Promise<{ journey: "invited"; targetCompanyId: string }> {
  if (!input.targetCompanyId) throw badRequest("A target company is required to join");
  // Idempotent identity writes (safe on resume / double-submit).
  await deps.userProfiles.ensureProfile({
    userId: input.userId,
    displayName: input.displayName,
    avatarUrl: input.avatarUrl,
  });
  await deps.userProfiles.seedCompanyUserProfile({
    companyId: input.targetCompanyId,
    userId: input.userId,
  });
  await deps.onboarding.upsertProgress({
    userId: input.userId,
    companyId: input.targetCompanyId,
    journey: "invited",
    currentState: "SETUP_COMPLETE",
    completedStates: [...INVITED_PHASE1_STATES],
  });
  return { journey: "invited", targetCompanyId: input.targetCompanyId };
}

async function membershipExists(db: Db, companyId: string, userId: string): Promise<boolean> {
  const row = await db
    .select({ id: companyMemberships.id })
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, userId),
      ),
    )
    .then((rows) => rows[0] ?? null);
  return Boolean(row);
}

export function onboardingJoinRoutes(db: Db) {
  const router = Router();
  const userProfiles = userProfilesService(db);
  const onboarding = onboardingProgressService(db);

  // POST /api/onboarding/join  { targetCompanyId }
  // The invite itself is accepted by the UI via the EXISTING
  // POST /api/invites/:token/accept before this call. This route only records
  // identity (user_profiles + company_user_profiles) and invited progress.
  router.post("/onboarding/join", async (req: Request, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Sign in with Google before joining an organization");
    }
    const targetCompanyId =
      typeof req.body?.targetCompanyId === "string" ? req.body.targetCompanyId.trim() : null;
    const user = await db
      .select({ email: authUsers.email, name: authUsers.name, image: authUsers.image })
      .from(authUsers)
      .where(eq(authUsers.id, req.actor.userId))
      .then((rows) => rows[0] ?? null);

    const result = await completeInvitedJoin(
      {
        userProfiles: {
          ensureProfile: (a) => userProfiles.ensureProfile(a),
          seedCompanyUserProfile: (a) => userProfiles.seedCompanyUserProfile(a),
        },
        onboarding: { upsertProgress: (a) => onboarding.upsertProgress(a) },
        membershipExists: (c, u) => membershipExists(db, c, u),
      },
      {
        userId: req.actor.userId,
        email: user?.email ?? null,
        displayName: user?.name ?? null,
        avatarUrl: user?.image ?? null,
        targetCompanyId,
      },
    );
    res.status(202).json(result);
  });

  return router;
}
```

> **Task author:** confirm the exact Stage C `userProfilesService` method names (`ensureProfile`, `seedCompanyUserProfile`) and their argument shapes via `grep -n "return {" server/src/services/user-profiles.ts`. If Stage C used `upsertProfile` / `seedForCompany`, adjust the two call sites (and the test's mock keys) to match. The pure `completeInvitedJoin` core is the DI seam so the exact names live in one place.

- [ ] **Step 4: Run test, verify pass**

Run: `pnpm test:run src/__tests__/onboarding-join-route.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Mount the route**

In `server/src/routes/onboarding.ts` (Stage B) — or wherever Stage A mounted `onboarding-journey` — mount:

```ts
import { onboardingJoinRoutes } from "./onboarding-join.js";
// inside the authenticated router assembly:
router.use(onboardingJoinRoutes(db));
```

Run: `pnpm typecheck`
Expected: PASS; no type errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/onboarding-join.ts server/src/routes/onboarding.ts server/src/__tests__/onboarding-join-route.test.ts
git commit -m "feat(onboarding): POST /api/onboarding/join records invited profile + progress (reuses invite acceptance)"
```

---

## Task D3: Harden invited detection — token hashing + email match in the journey resolver

**Reconciler-critical.** Stage A's `getJourneyForUser` (`server/src/routes/onboarding-journey.ts`) selects `invites.tokenHash` as `token` and the deep-link `inviteToken` is the **plaintext** token, so `resolvePostAuthJourney` compares a hash against a plaintext and never matches. Also, the invitee email lives in `defaultsPayload.teamInvite.email` (there is **no** email column on `invites` — see `server/src/services/team.ts:28,35` `TEAM_INVITE_KEY`), so the email fallback must read the jsonb path. This task fixes both without touching the pure `resolvePostAuthJourney` (Stage A A4) — we feed it consistent **hashed** values.

**Files:**
- Modify: `server/src/routes/onboarding-journey.ts` (`getJourneyForUser`)
- Test: `server/src/__tests__/onboarding-journey-invited.test.ts`

- [ ] **Step 1: Write the failing test** (sequence-mock db)

```ts
// server/src/__tests__/onboarding-journey-invited.test.ts
import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { getJourneyForUser } from "../routes/onboarding-journey.js";

const hash = (t: string) => createHash("sha256").update(t).digest("hex");

// Minimal sequence db: memberships → [], invites(email match) → [row]
function makeDb(inviteRows: Array<{ companyId: string; tokenHash: string }>) {
  const results = [[], inviteRows]; // 1st select = memberships, 2nd = invites
  let i = 0;
  const chain: unknown = new Proxy(() => chain, {
    get: () => chain,
    apply: () => chain,
  });
  return {
    select: () => ({
      from: () => ({
        where: async () => results[i++] ?? [],
      }),
    }),
  } as never;
}

describe("getJourneyForUser — invited detection", () => {
  it("matches a deep-linked token by HASH (not plaintext) → invited", async () => {
    const token = "aoa_invite_abcd";
    const db = makeDb([{ companyId: "c2", tokenHash: hash(token) }]);
    const r = await getJourneyForUser(db, { userId: "u1", email: "invitee@x.com", inviteToken: token });
    expect(r.journey).toBe("invited");
    expect(r.targetCompanyId).toBe("c2");
  });
  it("matches a pending invite by email when no token is supplied → invited", async () => {
    const db = makeDb([{ companyId: "c3", tokenHash: hash("aoa_invite_zzzz") }]);
    const r = await getJourneyForUser(db, { userId: "u1", email: "invitee@x.com", inviteToken: null });
    expect(r.journey).toBe("invited");
    expect(r.targetCompanyId).toBe("c3");
  });
  it("no invite, no membership → founder", async () => {
    const db = makeDb([]);
    const r = await getJourneyForUser(db, { userId: "u1", email: "solo@x.com", inviteToken: null });
    expect(r.journey).toBe("founder");
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm test:run src/__tests__/onboarding-journey-invited.test.ts`
Expected: FAIL — current query matches by plaintext / ignores email.

- [ ] **Step 3: Rewrite the invites lookup in `getJourneyForUser`**

Replace the pending-invites query (Stage A A5 `server/src/routes/onboarding-journey.ts`) with an email-scoped, open-only, hash-consistent lookup:

```ts
// server/src/routes/onboarding-journey.ts
import { createHash } from "node:crypto";
import type { Db } from "@armyofagents/db";
import { companyMemberships, invites } from "@armyofagents/db";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { resolvePostAuthJourney } from "../services/post-auth-journey.js";
import type { PostAuthJourneyResult } from "@armyofagents/shared";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function getJourneyForUser(
  db: Db,
  args: { userId: string; email: string; inviteToken: string | null },
): Promise<PostAuthJourneyResult> {
  const memberships = await db
    .select({ companyId: companyMemberships.companyId })
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, args.userId),
        eq(companyMemberships.status, "active"),
      ),
    );

  // Open invites (not accepted, not revoked, not expired) whose invitee email —
  // stored at defaultsPayload->'teamInvite'->>'email' (server/src/services/team.ts:28,35;
  // there is NO email column on invites) — matches this Google identity.
  const emailMatched = args.email
    ? await db
        .select({ companyId: invites.companyId, tokenHash: invites.tokenHash })
        .from(invites)
        .where(
          and(
            isNull(invites.acceptedAt),
            isNull(invites.revokedAt),
            gt(invites.expiresAt, new Date()),
            sql`lower(${invites.defaultsPayload} -> 'teamInvite' ->> 'email') = lower(${args.email})`,
          ),
        )
    : [];

  // Deep-linked token resolves to its own invite (hash the plaintext to match the
  // stored tokenHash). Feed the resolver HASHED values on both sides so the pure
  // comparison in resolvePostAuthJourney (Stage A §A4) matches hash-to-hash.
  const hashedDeepLink = args.inviteToken ? hashToken(args.inviteToken) : null;
  const tokenMatched = hashedDeepLink
    ? await db
        .select({ companyId: invites.companyId, tokenHash: invites.tokenHash })
        .from(invites)
        .where(
          and(
            eq(invites.tokenHash, hashedDeepLink),
            isNull(invites.acceptedAt),
            isNull(invites.revokedAt),
            gt(invites.expiresAt, new Date()),
          ),
        )
    : [];

  const pending = [...tokenMatched, ...emailMatched].map((row) => ({
    companyId: row.companyId as string,
    token: row.tokenHash,
  }));

  return resolvePostAuthJourney({
    memberships: memberships.map((m) => m.companyId),
    pendingInvites: pending,
    inviteToken: hashedDeepLink, // hash, so token-match wins deterministically in the resolver
  });
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `pnpm test:run src/__tests__/onboarding-journey-invited.test.ts`
Expected: PASS (3 tests). Also re-run Stage A's `post-auth-journey.test.ts` and `onboarding-journey-route.test.ts` — still green (the pure resolver is unchanged).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/onboarding-journey.ts server/src/__tests__/onboarding-journey-invited.test.ts
git commit -m "fix(onboarding): match invited by token-hash + teamInvite.email (was plaintext-vs-hash no-op)"
```

> **Task author:** confirm `invites.companyId` is non-null for company_join invites (schema allows null — `packages/db/src/schema/invites.ts:8`). Bootstrap invites carry no company; they are excluded here because they have no `teamInvite.email` and would only appear via an explicit token — a bootstrap token deep-link should route to the bootstrap accept UI, not the invited journey. If a null `companyId` ever reaches `pending`, filter it out before mapping.

---

## Task D4: Frontend invited step — `JoinOrg` + registry wiring

Adds the minimal invited step UI and registers it (`journeys: ["invited"]`), and widens the Stage C `profile` step to `["founder","invited"]`. Stage A A9 already routes `invited → /onboarding/join?company=c2`; Stage B's `FlowEngine` renders the journey. Completing this flips Task D1's registry test green.

**Files:**
- Create: `ui/src/onboarding/steps/JoinOrg.tsx`
- Modify: `ui/src/onboarding/registry.ts` (add `join`; widen `profile` journeys)
- Modify: `ui/src/api/onboarding.ts` (Stage A) — add `completeJoin`
- Test: `ui/src/onboarding/__tests__/join-org-step.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// ui/src/onboarding/__tests__/join-org-step.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { JoinOrg } from "../steps/JoinOrg";

const acceptInvite = vi.fn(async () => ({ id: "jr1" }));
const completeJoin = vi.fn(async () => ({ journey: "invited", targetCompanyId: "c2" }));
vi.mock("../../api/access", () => ({ accessApi: { acceptInvite: (...a: unknown[]) => acceptInvite(...a) } }));
vi.mock("../../api/onboarding", () => ({ completeJoin: (...a: unknown[]) => completeJoin(...a) }));

const ctx = {
  userId: "u1",
  companyId: "c2",
  journey: "invited" as const,
  completedStates: ["AUTHENTICATED" as const],
};

describe("JoinOrg step", () => {
  beforeEach(() => { acceptInvite.mockClear(); completeJoin.mockClear(); });
  it("accepts the invite then records progress, then calls onComplete", async () => {
    const onComplete = vi.fn();
    render(<JoinOrg ctx={ctx} inviteToken="aoa_invite_abcd" onComplete={onComplete} onBack={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /join/i }));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(acceptInvite).toHaveBeenCalledWith("aoa_invite_abcd", { requestType: "human" });
    expect(completeJoin).toHaveBeenCalledWith({ targetCompanyId: "c2" });
  });
  it("blocks join when no invite token is present (email-only detection)", () => {
    render(<JoinOrg ctx={ctx} inviteToken={null} onComplete={() => {}} onBack={() => {}} />);
    expect(screen.getByRole("button", { name: /join/i })).toBeDisabled();
    expect(screen.getByText(/open your invite link/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm --filter @armyofagents/ui test:run src/onboarding/__tests__/join-org-step.test.tsx`
Expected: FAIL — module missing.

- [ ] **Step 3: Add the API client method**

In `ui/src/api/onboarding.ts` (Stage A), append:

```ts
export async function completeJoin(body: { targetCompanyId: string }): Promise<{
  journey: "invited";
  targetCompanyId: string;
}> {
  const res = await fetch("/api/onboarding/join", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`join failed: ${res.status}`);
  return res.json();
}
```

- [ ] **Step 4: Implement the step component**

```tsx
// ui/src/onboarding/steps/JoinOrg.tsx
import { useState } from "react";
import type { StepProps } from "../registry";
import { accessApi } from "../../api/access";
import { completeJoin } from "../../api/onboarding";
import { Button } from "@/components/ui/button";

type JoinOrgProps = StepProps & { inviteToken: string | null };

export function JoinOrg({ ctx, inviteToken, onComplete }: JoinOrgProps) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function join() {
    if (!inviteToken || !ctx.companyId) return;
    setPending(true);
    setError(null);
    try {
      // Reuse the canonical acceptance flow — files a join_request (pending_approval).
      await accessApi.acceptInvite(inviteToken, { requestType: "human" });
      // Record identity + invited progress (does not re-accept).
      await completeJoin({ targetCompanyId: ctx.companyId });
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to join organization");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mx-auto max-w-md space-y-4">
      <div>
        <h2 className="text-xl font-semibold">Join your organization</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          You were invited to a team. We’ll set up your profile and file your join request for
          approval — no organization setup needed.
        </p>
      </div>
      {!inviteToken && (
        <p className="rounded-md border border-border bg-muted/30 p-3 text-sm">
          We detected an invitation for your account, but we need your invite link to complete the
          join. Please open your invite link (starts with <code>/invite/</code>) and sign in from
          there.
        </p>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button disabled={pending || !inviteToken || !ctx.companyId} onClick={join}>
        {pending ? "Joining…" : "Join organization"}
      </Button>
    </div>
  );
}

export default JoinOrg;
```

- [ ] **Step 5: Register the step + widen `profile`**

In `ui/src/onboarding/registry.ts`:

```ts
import { lazy } from "react";
// ...existing imports + steps...

// Widen the Stage C profile step so the invited journey includes it:
//   change  journeys: ["founder"]  →  journeys: ["founder", "invited"]
// on the existing `profile` StepDefinition.

// Append the invited-only join step:
export const joinStep: StepDefinition = {
  id: "join",
  state: "SETUP_COMPLETE",
  journeys: ["invited"],
  dependsOn: ["PROFILE_SET"],
  canSkip: false,
  isComplete: (ctx) => ctx.completedStates.includes("SETUP_COMPLETE"),
  Component: lazy(() => import("./steps/JoinOrg")),
  title: "Join your organization",
};

// Add joinStep to the exported `registry` array.
```

> The `FlowEngine` (Stage B) passes `StepProps`. `JoinOrg` needs the plaintext `inviteToken`; the engine reads it from the URL (`/onboarding/join?...` — the user arrived via `/invite/:token`, so persist the token in the onboarding route state or a query param). **Task author:** confirm how Stage B's `FlowEngine` threads step-specific props. If it only passes `StepProps`, read `inviteToken` inside `JoinOrg` from the router (`useSearchParams`/`useParams`) instead of a prop, and drop it from the signature — keep the accept→complete→onComplete order identical.

- [ ] **Step 6: Run tests, verify pass**

Run: `pnpm --filter @armyofagents/ui test:run src/onboarding/__tests__/join-org-step.test.tsx src/onboarding/__tests__/invited-registry.test.ts`
Expected: PASS (join-org: 2; invited-registry: 3 — D1's forward-referenced test is now green).

- [ ] **Step 7: Commit**

```bash
git add ui/src/onboarding/steps/JoinOrg.tsx ui/src/onboarding/registry.ts ui/src/api/onboarding.ts ui/src/onboarding/__tests__/join-org-step.test.tsx
git commit -m "feat(onboarding): minimal invited JoinOrg step + registry wiring"
```

---

## Task D5: Integration — invited routing + resume from an invited state

Proves the whole invited spine at the service layer: journey resolves invited → join records progress → resume drops the user at the invited terminal (not the founder flow).

**Files:**
- Test: `server/src/__tests__/invited-journey-integration.test.ts` (service-with-mocks; no drizzle internals)

- [ ] **Step 1: Write the test**

```ts
// server/src/__tests__/invited-journey-integration.test.ts
import { describe, it, expect } from "vitest";
import { resolvePostAuthJourney } from "../services/post-auth-journey.js";
import { completeInvitedJoin } from "../routes/onboarding-join.js";
import { INVITED_PHASE1_STATES } from "@armyofagents/shared";

describe("invited journey integration", () => {
  it("pending invite (by email) → invited → join records SETUP_COMPLETE progress", async () => {
    // 1. Detection (pure resolver, values as getJourneyForUser feeds them — hashed token)
    const journey = resolvePostAuthJourney({
      memberships: [],
      pendingInvites: [{ companyId: "c2", token: "hash" }],
      inviteToken: null,
    });
    expect(journey).toMatchObject({ journey: "invited", targetCompanyId: "c2" });

    // 2. Join records identity + invited progress
    const progressCalls: unknown[] = [];
    const result = await completeInvitedJoin(
      {
        userProfiles: {
          ensureProfile: async () => ({}),
          seedCompanyUserProfile: async () => ({}),
        },
        onboarding: { upsertProgress: async (a) => { progressCalls.push(a); return {}; } },
        membershipExists: async () => false,
      } as never,
      { userId: "u1", email: "i@x.com", displayName: "I", avatarUrl: null, targetCompanyId: journey.targetCompanyId },
    );
    expect(result.journey).toBe("invited");
    expect(progressCalls[0]).toMatchObject({
      journey: "invited",
      currentState: "SETUP_COMPLETE",
      completedStates: [...INVITED_PHASE1_STATES],
    });
  });

  it("resume: an invited row already at SETUP_COMPLETE has no next step (never founder create-org)", () => {
    // resolveNextStep is Stage B; here we assert the invariant it relies on:
    // once SETUP_COMPLETE is in completedStates, no founder-only state is pending.
    const completed = [...INVITED_PHASE1_STATES];
    const founderOnly = ["ORGANIZATION_CREATED", "ENVIRONMENT_READY", "DEPARTMENT_CREATED", "AGENT_ASSIGNED"];
    for (const s of founderOnly) expect(completed).not.toContain(s);
    expect(completed.at(-1)).toBe("SETUP_COMPLETE");
  });
});
```

- [ ] **Step 2: Run test, verify pass**

Run: `pnpm test:run src/__tests__/invited-journey-integration.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 3: Commit**

```bash
git add server/src/__tests__/invited-journey-integration.test.ts
git commit -m "test(onboarding): invited routing + resume integration"
```

---

## Task D6: Security — OAuth state/PKCE + session cookie flags

better-auth handles OAuth `state`/PKCE internally; this task asserts the config is wired to enable them and that sessions carry secure cookie flags. Uses Stage A's pure `buildBetterAuthConfig`.

**Files:**
- Test: `server/src/__tests__/auth-security-config.test.ts`
- Possibly modify: `server/src/auth/better-auth.ts` (`buildBetterAuthConfig`) if cookie hardening isn't already present

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/auth-security-config.test.ts
import { describe, it, expect } from "vitest";
import { buildBetterAuthConfig } from "../auth/better-auth.js";
import type { Config } from "../config.js";

const cfg = (over: Partial<Config> = {}): Config => ({
  deploymentMode: "authenticated",
  googleClientId: "gid",
  googleClientSecret: "gsecret",
  devLocalIdentity: false,
  authBaseUrlMode: "explicit",
  authPublicBaseUrl: "https://app.example.com",
  ...over,
} as unknown as Config);

describe("auth security config", () => {
  it("enables the Google social provider (better-auth applies OAuth state + PKCE for social sign-in)", () => {
    const c = buildBetterAuthConfig({} as never, cfg(), ["https://app.example.com"], "secret");
    expect(c.socialProviders?.google?.clientId).toBe("gid");
  });
  it("hardens the session cookie in authenticated mode (httpOnly + secure + sameSite)", () => {
    const c = buildBetterAuthConfig({} as never, cfg(), ["https://app.example.com"], "secret") as any;
    const cookie = c.advanced?.cookies?.session_token ?? c.advanced?.defaultCookieAttributes;
    expect(cookie?.httpOnly ?? c.advanced?.defaultCookieAttributes?.httpOnly).toBe(true);
    expect(cookie?.secure ?? c.advanced?.defaultCookieAttributes?.secure).toBe(true);
    expect((cookie?.sameSite ?? c.advanced?.defaultCookieAttributes?.sameSite)).toMatch(/lax|strict/i);
  });
  it("does NOT force Secure in local_trusted (loopback http dev)", () => {
    const c = buildBetterAuthConfig({} as never, cfg({ deploymentMode: "local_trusted" }), [], "secret") as any;
    expect(c.advanced?.defaultCookieAttributes?.secure).toBe(false);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm test:run src/__tests__/auth-security-config.test.ts`
Expected: FAIL — no `advanced.defaultCookieAttributes` on the config.

- [ ] **Step 3: Add cookie hardening to `buildBetterAuthConfig`**

In `server/src/auth/better-auth.ts`, inside `buildBetterAuthConfig` (Stage A A2), add to `authConfig`:

```ts
  const isHosted = config.deploymentMode === "authenticated";
  (authConfig as Record<string, unknown>).advanced = {
    // better-auth sets HttpOnly by default; make the intent explicit and gate
    // Secure to hosted deployments (loopback http dev in local_trusted must not
    // set Secure or the cookie is dropped over http://127.0.0.1).
    defaultCookieAttributes: {
      httpOnly: true,
      secure: isHosted,
      sameSite: "lax", // OAuth redirect round-trip needs Lax (Strict drops the callback cookie)
    },
  };
```

> **Task author:** confirm the better-auth version's cookie-config surface (`advanced.defaultCookieAttributes` vs `advanced.cookies.session_token.attributes`) via `grep -rn "defaultCookieAttributes\|cookiePrefix" node_modules/better-auth/dist` or the installed version's types. Align the key the test asserts with the real one. OAuth `state`/PKCE are internal to better-auth's social flow — no config knob — so the first assertion is a provider-presence proxy; do not hand-roll state/PKCE.

- [ ] **Step 4: Run test, verify pass**

Run: `pnpm test:run src/__tests__/auth-security-config.test.ts`
Expected: PASS (3 tests). Re-run `better-auth-config.test.ts` — still green.

- [ ] **Step 5: Commit**

```bash
git add server/src/auth/better-auth.ts server/src/__tests__/auth-security-config.test.ts
git commit -m "feat(auth): harden session cookies (HttpOnly/Secure/SameSite), assert Google OAuth state/PKCE wiring"
```

---

## Task D7: Security — escape hatch fail-closed + no secrets in URLs/logs

Two hardening assertions: (1) `AOA_DEV_LOCAL_IDENTITY` is refused in `authenticated` mode end-to-end (builds on Stage A A6's unit test with an integration-level assertion), and (2) the journey endpoint never leaks the invite token into logs, and callers pass it out of the query string.

**Files:**
- Test: `server/src/__tests__/escape-hatch-fail-closed.test.ts`
- Test: `server/src/__tests__/no-secret-leak.test.ts`
- Possibly modify: `server/src/routes/onboarding-journey.ts` (accept `inviteToken` from a header/body, not only the query string) + redaction in any log line

- [ ] **Step 1: Write the escape-hatch integration test**

```ts
// server/src/__tests__/escape-hatch-fail-closed.test.ts
import { describe, it, expect } from "vitest";
import { actorMiddleware } from "../middleware/auth.js";

function run(mw: any, req: any) {
  return new Promise((resolve) => mw(req, {}, () => resolve(req.actor)));
}
const baseReq = () => ({ header: () => undefined, method: "GET", originalUrl: "/api/companies" });

describe("escape hatch is fail-closed in authenticated mode", () => {
  it("authenticated + AOA_DEV_LOCAL_IDENTITY=true → NO synthetic admin (actor stays none)", async () => {
    const mw = actorMiddleware({} as any, { deploymentMode: "authenticated", devLocalIdentity: true });
    const actor: any = await run(mw, baseReq());
    expect(actor.type).toBe("none");
    expect(actor.isInstanceAdmin).not.toBe(true);
  });
  it("local_trusted + flag → synthetic admin (dev path still works)", async () => {
    const mw = actorMiddleware({} as any, { deploymentMode: "local_trusted", devLocalIdentity: true });
    const actor: any = await run(mw, baseReq());
    expect(actor).toMatchObject({ type: "board", isInstanceAdmin: true });
  });
});
```

- [ ] **Step 2: Run it — should PASS immediately** (Stage A A6 already implemented the gate)

Run: `pnpm test:run src/__tests__/escape-hatch-fail-closed.test.ts`
Expected: PASS (2 tests). If it FAILS, Stage A A6 regressed — fix the middleware gate before continuing (this is the security backstop for A6).

- [ ] **Step 3: Write the no-secret-leak test**

```ts
// server/src/__tests__/no-secret-leak.test.ts
import { describe, it, expect, vi } from "vitest";
import { getJourneyForUser } from "../routes/onboarding-journey.js";

describe("journey endpoint does not leak the invite token", () => {
  it("never logs the raw invite token", async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a) => { logged.push(a.join(" ")); });
    const errSpy = vi.spyOn(console, "error").mockImplementation((...a) => { logged.push(a.join(" ")); });
    const db = {
      select: () => ({ from: () => ({ where: async () => [] }) }),
    } as never;
    await getJourneyForUser(db, { userId: "u1", email: "x@x.com", inviteToken: "aoa_invite_SECRET123" });
    spy.mockRestore();
    errSpy.mockRestore();
    expect(logged.join("\n")).not.toContain("aoa_invite_SECRET123");
  });
});
```

- [ ] **Step 4: Run it, verify pass (and add redaction if it fails)**

Run: `pnpm test:run src/__tests__/no-secret-leak.test.ts`
Expected: PASS. If any log line in `getJourneyForUser` or its handler prints the token, redact it (log only `hashToken(inviteToken).slice(0,12)` — the same pattern as `summarizeSecretForLog` in `server/src/routes/access.ts:492`). Ensure the Express handler reads `inviteToken` from a header (`x-invite-token`) or POST body in preference to `?inviteToken=` so the secret stays out of URLs/access logs; keep the query param only as a compatibility fallback.

> **Task author:** Stage A A9 wired the UI client to call `GET /api/onboarding/journey?inviteToken=...`. Putting the token in the query string violates "no secrets in URLs". Before finalizing, change the UI client (`ui/src/api/onboarding.ts` `fetchJourney`) to send the token as an `x-invite-token` header (keep `credentials: "include"`), and read it server-side from the header first. Flag this to the reconciler as a small Stage A follow-up.

- [ ] **Step 5: Commit**

```bash
git add server/src/__tests__/escape-hatch-fail-closed.test.ts server/src/__tests__/no-secret-leak.test.ts server/src/routes/onboarding-journey.ts ui/src/api/onboarding.ts
git commit -m "test(security): escape-hatch fail-closed + no invite-token leak in URLs/logs"
```

---

## Task D8: Security — API-key paste stored as an encrypted per-company secret

Commander verify (Stage C, API-key path) must persist a pasted key through the encrypted secrets chokepoint (`companySecrets` / `companySecretVersions`), never as plaintext on `internal_agent_config`.

**Files:**
- Test: `server/src/__tests__/commander-key-encrypted.test.ts`
- Reference: `server/src/services/commander-verify.ts` (Stage C), `server/src/services/secrets.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/commander-key-encrypted.test.ts
import { describe, it, expect, vi } from "vitest";
import { persistCommanderApiKey } from "../services/commander-verify.js"; // Stage C

describe("commander API-key storage", () => {
  it("writes through the secrets service, not plaintext into internal_agent_config", async () => {
    const secretCalls: unknown[] = [];
    const configCalls: unknown[] = [];
    const deps = {
      secrets: { setCompanySecret: vi.fn(async (a: unknown) => { secretCalls.push(a); return { secretId: "s1" }; }) },
      internalAgentConfig: { update: vi.fn(async (a: unknown) => { configCalls.push(a); }) },
    };
    await persistCommanderApiKey(deps as never, {
      companyId: "c1",
      provider: "claude",
      apiKey: "sk-ant-SUPERSECRET",
    });
    // Key value went to the secrets vault…
    expect(secretCalls.length).toBe(1);
    expect(JSON.stringify(secretCalls[0])).toContain("sk-ant-SUPERSECRET");
    // …and NOT into the agent config row.
    expect(JSON.stringify(configCalls)).not.toContain("sk-ant-SUPERSECRET");
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm test:run src/__tests__/commander-key-encrypted.test.ts`
Expected: FAIL — `persistCommanderApiKey` missing / not extracted.

- [ ] **Step 3: Implement the DI-seam helper in `commander-verify.ts`**

```ts
// server/src/services/commander-verify.ts  (add)
export type PersistKeyDeps = {
  secrets: {
    setCompanySecret: (args: {
      companyId: string;
      key: string;        // env-style key, e.g. "COMMANDER_CLAUDE_API_KEY"
      name: string;
      value: string;      // the raw key — the secrets service encrypts at rest
      actorUserId: string | null;
    }) => Promise<{ secretId: string }>;
  };
  internalAgentConfig: {
    update: (args: { companyId: string; patch: Record<string, unknown> }) => Promise<void>;
  };
};

export async function persistCommanderApiKey(
  deps: PersistKeyDeps,
  input: { companyId: string; provider: "claude" | "codex"; apiKey: string; actorUserId?: string | null },
): Promise<{ secretId: string }> {
  const key = `COMMANDER_${input.provider.toUpperCase()}_API_KEY`;
  const { secretId } = await deps.secrets.setCompanySecret({
    companyId: input.companyId,
    key,
    name: `Commander ${input.provider} API key`,
    value: input.apiKey,
    actorUserId: input.actorUserId ?? null,
  });
  // Store only the REFERENCE on the config, never the raw key.
  await deps.internalAgentConfig.update({
    companyId: input.companyId,
    patch: { commanderApiKeySecretId: secretId },
  });
  return { secretId };
}
```

> **Task author:** confirm the real secrets-service write method. `server/src/services/secrets.ts` exposes a factory `secretsService(db)`; find the create/version method via `grep -n "return {" server/src/services/secrets.ts` and the encrypted-write path (it wraps `companySecrets` + `companySecretVersions` via a provider `createVersion` — see secrets.ts:532,586). Adapt `setCompanySecret` to the real name (it may be `create` / `createVersion` / `upsertManagedSecret`). CLAUDE.md Rule #11: this is NOT a hosted runtime key (Commander is CLI-first); the API-key path is an explicit user-chosen fallback and must still be encrypted at rest like any secret.

- [ ] **Step 4: Run test, verify pass**

Run: `pnpm test:run src/__tests__/commander-key-encrypted.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/commander-verify.ts server/src/__tests__/commander-key-encrypted.test.ts
git commit -m "feat(security): store Commander API-key as encrypted per-company secret (never plaintext)"
```

---

## Task D9: E2E hardening — four Playwright paths (Google mocked)

Adds the four scope-required flows. All run in `local_trusted` mode (`tests/e2e/playwright.config.ts`) with Google mocked via Stage A's session-injection helper (A12). Respect the Windows embedded-pg skip (`WINDOWS_WITH_EMBEDDED_POSTGRES` gate + `windows-embedded-postgres-skip.spec.ts` testMatch — no per-spec change needed; the config already routes Windows CI to the skip spec).

**Files:**
- Create: `tests/e2e/onboarding-founder-happy-path.spec.ts`
- Create: `tests/e2e/onboarding-resume.spec.ts`
- Create: `tests/e2e/onboarding-invited-join.spec.ts`
- Create: `tests/e2e/onboarding-second-org.spec.ts`
- Reference: `tests/e2e/helpers/` (Stage A's Google/session-injection helper; `seed-company.ts`)

- [ ] **Step 1: Founder happy path**

```ts
// tests/e2e/onboarding-founder-happy-path.spec.ts
import { test, expect } from "@playwright/test";
import { injectGoogleSession } from "./helpers/google-mock"; // Stage A A12 helper

test("founder completes profile → org → environment → commander → department → agent → review", async ({ page, request }) => {
  await injectGoogleSession(page, { email: "founder@e2e.test", name: "E2E Founder" });
  await page.goto("/onboarding");
  await expect(page.getByRole("heading", { name: /your profile/i })).toBeVisible({ timeout: 10_000 });

  // The step-by-step click-through depends on Stage C step markup + fake CLI env
  // (fake-claude/fake-codex already on PATH via playwright.config.ts). Drive each
  // step's primary action and assert the terminal Review state.
  // Profile (name prefilled from Google) → Continue
  await page.getByRole("button", { name: /continue|next/i }).click();
  // … org name, environment probe (temp AOA_HOME is writable), commander card
  // (fake CLI verifies), department, agent … each: fill required + Continue.
  // Assert we land on Review / dashboard:
  await expect(page.getByText(/setup complete|go to dashboard/i)).toBeVisible({ timeout: 30_000 });
});
```

> **Task author:** the intermediate step selectors depend on Stage C's step components. Fill them in against the real markup once Stage C is merged; keep the profile-first + review-last assertions as the stable contract. If a step needs a real local folder, the e2e temp `AOA_HOME` (config line 62) is writable — use it as the environment root.

- [ ] **Step 2: Resume-after-abandon**

```ts
// tests/e2e/onboarding-resume.spec.ts
import { test, expect } from "@playwright/test";
import { injectGoogleSession } from "./helpers/google-mock";

test("leaving mid-flow and returning lands on the first incomplete step", async ({ page }) => {
  await injectGoogleSession(page, { email: "resume@e2e.test", name: "Resumer" });
  await page.goto("/onboarding");
  await expect(page.getByRole("heading", { name: /your profile/i })).toBeVisible();
  await page.getByRole("button", { name: /continue|next/i }).click(); // completes PROFILE_SET
  await expect(page.getByRole("heading", { name: /organization/i })).toBeVisible();

  // Abandon: navigate away, then return.
  await page.goto("/");
  await page.goto("/onboarding");
  // Should NOT restart at profile — resume drops at ORGANIZATION_CREATED step.
  await expect(page.getByRole("heading", { name: /organization/i })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("heading", { name: /your profile/i })).toHaveCount(0);
});
```

- [ ] **Step 3: Invited-human minimal join**

```ts
// tests/e2e/onboarding-invited-join.spec.ts
import { test, expect } from "@playwright/test";
import { injectGoogleSession } from "./helpers/google-mock";

test("invited human lands on join (never create-org) and files a join request", async ({ page, request }) => {
  // Seed an org + a human invite whose teamInvite.email matches the Google identity.
  const company = await (await request.post("/api/companies", { data: { name: `E2E-Invited-${Date.now()}` } })).json();
  const invite = await (await request.post(`/api/companies/${company.id}/invites`, {
    data: {
      allowedJoinTypes: "human",
      defaultsPayload: { teamInvite: { email: "invitee@e2e.test", role: "team_member", projectId: null } },
    },
  })).json();

  await injectGoogleSession(page, { email: "invitee@e2e.test", name: "Invitee" });
  await page.goto(`/invite/${invite.token}`);
  // Post-auth routing sends the invited user to the join step (Stage A destinationForJourney).
  await page.goto("/onboarding/join?company=" + company.id);
  await expect(page.getByRole("heading", { name: /join your organization/i })).toBeVisible({ timeout: 10_000 });
  // Never the founder create-org heading:
  await expect(page.getByRole("heading", { name: /create organization/i })).toHaveCount(0);

  await page.getByRole("button", { name: /join organization/i }).click();
  // Join request filed → pending approval surfaced.
  await expect(page.getByText(/pending|request/i)).toBeVisible({ timeout: 15_000 });

  // Verify server state: a pending_approval human join request exists.
  const jrs = await (await request.get(`/api/companies/${company.id}/join-requests`)).json();
  expect(jrs.some((j: { requestType: string; status: string }) => j.requestType === "human" && j.status === "pending_approval")).toBe(true);
});
```

> **Task author:** in `local_trusted` e2e the `request` fixture is auto-authorized as the local board admin (onboarding.spec.ts:37), so the seed POSTs work without a token. But `injectGoogleSession` must switch the *page* actor to `invitee@e2e.test` so acceptance/join run as that identity. Confirm the helper sets the session cookie the page uses, distinct from the `request` fixture's implicit admin.

- [ ] **Step 4: Second-org-from-Lobby skips the user layer**

```ts
// tests/e2e/onboarding-second-org.spec.ts
import { test, expect } from "@playwright/test";
import { injectGoogleSession } from "./helpers/google-mock";

test("creating a 2nd org from the Lobby re-enters only the org-level flow", async ({ page, request }) => {
  // Founder already has one org + a completed user-layer profile.
  await injectGoogleSession(page, { email: "multi@e2e.test", name: "Multi Founder" });
  const first = await (await request.post("/api/companies", { data: { name: `E2E-Multi-${Date.now()}` } })).json();
  void first;

  await page.goto("/"); // Lobby
  await page.getByRole("button", { name: /create organization/i }).click();
  // Should start at ORGANIZATION_CREATED, NOT at "Your profile".
  await expect(page.getByRole("heading", { name: /organization/i })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("heading", { name: /your profile/i })).toHaveCount(0);
});
```

- [ ] **Step 5: Run the four specs, verify pass**

Run: `pnpm test:e2e onboarding-founder-happy-path onboarding-resume onboarding-invited-join onboarding-second-org` (confirm the repo's e2e run command from the pre-flight)
Expected: PASS on Linux/macOS. On Windows CI the config routes to `windows-embedded-postgres-skip.spec.ts` (embedded-pg can't start on `runneradmin` — Issue #114); locally, set `AOA_E2E_FORCE_WINDOWS=1` + `DATABASE_URL` to run them. First run may FAIL until Stage A's `google-mock` helper + Stage C step markup are present — that is expected sequencing.

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/onboarding-founder-happy-path.spec.ts tests/e2e/onboarding-resume.spec.ts tests/e2e/onboarding-invited-join.spec.ts tests/e2e/onboarding-second-org.spec.ts
git commit -m "test(e2e): founder happy path, resume, invited join, second-org-skips-user-layer"
```

---

## Task D10: Full-suite green gate + Stage A actor-identity fallout sweep

Final gate: run the full server + ui unit suites + typecheck, surface any cross-cutting fallout from Stage A's actor-identity change (the highest-risk change: `local_trusted` no longer auto-admins by default), and fix-forward.

**Files:** none new — this is a verification + fix-forward task.

- [ ] **Step 1: Run the full gate**

Run, in order:
```bash
pnpm typecheck
pnpm test:run
pnpm test:run
pnpm --filter @armyofagents/ui test
```
Expected: all green.

- [ ] **Step 2: Sweep for actor-identity fallout**

Any server test that assumed the old `local_trusted` auto-admin default will now see `{ type: "none" }` unless it sets `devLocalIdentity: true` or injects a session. Find candidates:

```bash
grep -rn "local-board\|local_implicit\|deploymentMode: \"local_trusted\"" server/src/__tests__
```

For each failing test, the fix is one of:
- pass `devLocalIdentity: true` to `actorMiddleware` (dev/offline path), OR
- inject a resolved session actor (the new default identity source), OR
- assert the new `{ type: "none" }` default if the test's intent was "no identity".

Do **not** revert the Stage A default. Document each touched test in the commit body.

- [ ] **Step 3: List cross-cutting fallout (report, not code)**

Produce a short list for the reconciler of any files changed outside Stage D's own scope to keep the suite green (e.g. legacy auth-assuming tests, seed helpers that relied on implicit admin). Keep it in the commit body + the handoff summary.

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "test(onboarding): full-suite green gate + actor-identity fallout sweep"
```

---

## Stage D self-review checklist (run before handing off)

- [ ] **Scope → task mapping:**
  - Invited minimal journey (profile→join, not create-org): D1 (states) · D2 (join route) · D4 (JoinOrg UI) · D5 (integration). ✔
  - Invited registry excludes org/env/commander/dept/agent: D1 (registry-exclusion test) + D4 (registry wiring). ✔
  - Security — OAuth state/PKCE (D6) · cookie flags (D6) · escape-hatch refused in authenticated (D7) · no secrets in URLs/logs (D7) · API-key encrypted secret (D8). ✔
  - E2E — founder happy path · resume-after-abandon · invited join · 2nd-org-skips-user-layer (D9). ✔
  - Full-suite green gate + fallout (D10). ✔
- [ ] **Reuse, not reimplement:** invite acceptance uses the EXISTING `POST /api/invites/:token/accept` (access.ts:1903) + approval (access.ts:2402 → `ensureMembership`/`setPrincipalGrants`/`applyInviteRole`). D2 only adds profile + progress. `teamService.applyInviteRole` (team.ts:447) and `TEAM_INVITE_KEY` email path (team.ts:28,35) cited. ✔
- [ ] **Placeholder scan:** every `> Task author:` note is a *verification pointer* (Stage B service names, Stage C profile-service names, better-auth cookie-config surface, secrets-service write method, e2e step selectors, FlowEngine prop threading), not a code TODO — resolve during execution. No `TODO`/`FIXME` left in shipped code. ✔
- [ ] **Type consistency:** `OnboardingState` / `OnboardingJourney` / `INVITED_PHASE1_STATES` from `@armyofagents/shared`; `PostAuthJourneyResult` unchanged (Stage 0 §3.2); `resolvePostAuthJourney` signature untouched (fed hashed values); `StepDefinition.journeys` filtering matches Stage 0 §4; `onboarding_progress` fields (`journey`/`currentState`/`completedStates`) match Stage 0 §2.2. ✔
- [ ] **Invariants honored:** `account.password` untouched; no hosted runtime key added (Commander key is an encrypted user-chosen fallback, D8); `local_trusted` divergence points (D5/D6/D8 in CLAUDE.md) untouched; Windows e2e skip preserved (D9). ✔
- [ ] **Full server suite green after D3 + D7** (the resolver + actor-adjacent changes) before continuing to e2e.

---

## Notes for the reconciler (inconsistencies / risks surfaced)

1. **Stage A A5 invited-detection bug (fixed here in D3):** A5's `getJourneyForUser` selected `invites.tokenHash` as `token` and compared it against the **plaintext** deep-link `inviteToken` — a guaranteed no-op, so invited detection never fired. There is **no email column** on `invites`; the invitee email lives at `defaultsPayload->'teamInvite'->>'email'` (`server/src/services/team.ts:28,35`). D3 hashes the deep-link token and adds the jsonb email match. This resolves A5's open `> Task author:` note. Confirm A5's inline query is replaced, not left alongside.
2. **Secrets-in-URL (Stage A A9):** A9's client calls `GET /api/onboarding/journey?inviteToken=...`, putting the token in the URL/access logs. D7 moves it to an `x-invite-token` header. Reconciler should ensure A9's client and any A5 route doc are updated to match.
3. **Email-only invited users need their link:** invite tokens are stored hashed, so the server cannot hand back a plaintext token. An email-detected invited user who did **not** arrive via `/invite/:token` cannot self-accept (acceptance is token-only). D4's `JoinOrg` disables join and instructs them to open their invite link. This is an accepted Phase-1 limitation (spec §5.2 "minimal") — flag if product wants a tokenless server-side accept later.
4. **Invited terminal state = `SETUP_COMPLETE`:** no invited-specific state was minted (the enum's Phase-1 slots are founder-shaped). `INVITED_PHASE1_STATES = [AUTHENTICATED, PROFILE_SET, SETUP_COMPLETE]`. If Stage B's `resolveNextStep` treats `SETUP_COMPLETE` specially for founder, confirm it also terminates the invited journey cleanly.
5. **Human invited join is approval-gated, not auto:** the existing flow files a `pending_approval` join request; membership only lands after a board member approves (`joins:approve`). Scope D1's "approval-or-auto" therefore means "approval" in Phase 1 — there is no auto-approve path. The e2e (D9 step 3) asserts the pending request, not membership.
6. **Stage B/C name coupling:** D2/D4/D8 depend on exact exported names from Stage B (`onboardingProgressService.upsertProgress`) and Stage C (`userProfilesService.ensureProfile`/`seedCompanyUserProfile`, `commander-verify` shape, step markup, `FlowEngine` prop threading). All are flagged as `> Task author:` pointers; the reconciler should verify these line up once B/C land.
