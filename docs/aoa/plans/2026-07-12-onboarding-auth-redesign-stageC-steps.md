# Stage C — Workspace-Setup Steps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Read `2026-07-12-onboarding-auth-redesign-stage0-contracts.md` first — it defines every shared type referenced here (`user_profiles` §2.1, `DEPARTMENT_FUNCTION_TYPES` §3.3, `StepDefinition`/`StepProps` §4, `OnboardingState` §3.1, file map §6, testing §7). Stage C depends on **Stage B** having shipped `ui/src/onboarding/registry.ts` (StepDefinition/StepProps/StepContext), `ui/src/onboarding/FlowEngine.tsx`, `server/src/services/onboarding.ts` (progress upsert/advance/resume), and `server/src/routes/onboarding.ts`. No forward references beyond those.

**Goal:** Port the monolithic `OnboardingWizard` step logic into 8 discrete, resumable, idempotent founder step-components under `ui/src/onboarding/steps/`, each registered in the Stage B registry with its own server write, completion state, and recovery branch — then delete the wizard. Ships the full founder happy path: **profile → org → environment (probe-blocking) → commander → verify (blocking) → department → agent (dept-assigned) → review**.

**Architecture:** Each step is a `StepDefinition` (Stage 0 §4) whose `Component` does its server write via a small API client, then calls `props.onComplete()`; the Stage B FlowEngine persists the completion state and re-reads `StepContext` from server state (so a freshly-created `companyId` flows into later steps). Every server write is idempotent (upsert / existence-guard) so re-entry never double-writes. Environment probe and Commander verify are **blocking** — they fix today's non-fatal folder-create. The department taxonomy is consolidated into one shared source consumed by both onboarding and `NewProjectDialog`.

**Tech stack:** Drizzle (Postgres), Express 5, React + Vite + Tailwind v4, Vitest, Playwright, pnpm monorepo.

**Ships independently:** after Stage C, on top of Stage A (Google auth + journey router) and Stage B (state machine + FlowEngine + registry), a founder can complete the entire Phase-1 workspace setup end-to-end, leave and resume at the first incomplete state, and replay the org-layer from the Lobby. The invited journey and security/e2e hardening are Stage D.

---

## Pre-flight (once, before Task C1)

- [ ] **Confirm test/build script names + Stage B artifacts exist**

Run:
```
cat server/package.json | grep -A3 '"scripts"'
cat package.json | grep -A3 '"scripts"'
ls ui/src/onboarding/registry.ts ui/src/onboarding/FlowEngine.tsx server/src/services/onboarding.ts server/src/routes/onboarding.ts
```
Expected: note the server test script (`vitest run`), the root `verify` / `db:generate` scripts, and confirm the four Stage B files exist. If Stage B is not merged yet, STOP — Stage C composes on its registry/engine contract.

- [ ] **Confirm the shared constants Stage A/B appended**

Run: `grep -n "ONBOARDING_STATES\|ONBOARDING_JOURNEYS\|FOUNDER_PHASE1_STATES" packages/shared/src/constants.ts`
Expected: present (added by Stage A/B per Stage 0 §3.1). `DEPARTMENT_FUNCTION_TYPES` is **NOT** yet present — Task C9 adds it.

> **Task author (blocking discrepancy — surface to the reconciler before starting C2):** Stage 0 §2.1 and the scope doc both say Stage C must "seed `company_user_profiles` from `user_profiles` on org create/join," and CLAUDE.md's Naming Map lists `company_user_profiles` as an existing per-org table. **It does not exist in this worktree** — there is no `packages/db/src/schema/company_user_profiles.ts` and no `companyUserProfiles` export anywhere under `packages/` or `server/src/`. Per CLAUDE.md ("Code is always truth… flag the discrepancy"), Task C2 implements the seed as a **guarded no-op** (see C2 Step 3) and this plan flags it. Decide with the reconciler whether to (a) add `company_user_profiles` to Stage C scope, or (b) leave the per-org profile projection to a later stage. Do not invent the table silently.

---

## Task C1: `user_profiles` Drizzle table

**Files:**
- Create: `packages/db/src/schema/user_profiles.ts`
- Modify: `packages/db/src/schema/index.ts` (add re-export next to `environments` at ~:122)
- Test: `packages/db/src/__tests__/user-profiles-schema.test.ts` (contract test — no DB)

- [ ] **Step 1: Write the failing test**

```ts
// packages/db/src/__tests__/user-profiles-schema.test.ts
import { describe, it, expect } from "vitest";
import { userProfiles } from "../schema/user_profiles.js";

describe("user_profiles schema", () => {
  it("keys on userId (text) and defaults socialLinks to []", () => {
    expect(userProfiles.userId.primary).toBe(true);
    // column name mapping
    expect(userProfiles.socialLinks.name).toBe("social_links");
    expect(userProfiles.displayName.name).toBe("display_name");
    expect(userProfiles.avatarUrl.name).toBe("avatar_url");
  });
});
```

> If `packages/db` has no test runner wired, make this a re-exported contract assertion inside the server suite instead (`server/src/__tests__/user-profiles-schema.test.ts` importing `@armyofagents/db`). Follow whichever package already runs vitest — confirm in Pre-flight.

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm --filter @armyofagents/db test -- src/__tests__/user-profiles-schema.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the table exactly per Stage 0 §2.1**

```ts
// packages/db/src/schema/user_profiles.ts
import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export type UserProfileSocialLink = {
  type: string; // "linkedin" | "github" | "x" | "website" | "other"
  label: string | null;
  url: string;
};

export const userProfiles = pgTable("user_profiles", {
  userId: text("user_id").primaryKey(), // better-auth user.id (text); no FK, matches convention
  displayName: text("display_name"),
  avatarUrl: text("avatar_url"),
  title: text("title"),
  bio: text("bio"),
  socialLinks: jsonb("social_links").$type<UserProfileSocialLink[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
```

Add to `packages/db/src/schema/index.ts` (mirrors `export { environments } from "./environments.js";` at :122):
```ts
export { userProfiles, type UserProfileSocialLink } from "./user_profiles.js";
```
`packages/db/src/index.ts` already does `export * from "./schema/index.js";` (:20) — no change there.

- [ ] **Step 4: Generate the migration**

Run: `pnpm db:generate`
Expected: a new migration adding `user_profiles`. Inspect it — table only, no destructive statements. NEVER hand-edit SQL (CLAUDE.md Rule #1).

- [ ] **Step 5: Run test, verify pass**

Run: `pnpm --filter @armyofagents/db test -- src/__tests__/user-profiles-schema.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema/user_profiles.ts packages/db/src/schema/index.ts packages/db/drizzle packages/db/src/__tests__/user-profiles-schema.test.ts
git commit -m "feat(onboarding): add user_profiles table"
```

---

## Task C2: `user-profiles` service (CRUD + upsert + guarded per-org seed)

**Files:**
- Create: `server/src/services/user-profiles.ts`
- Create: `server/src/routes/user-profiles.ts` (GET + PUT own profile)
- Test: `server/src/__tests__/user-profiles-service.test.ts`

> The route file is additive and not enumerated in Stage 0 §6 (which lists only the service). It follows the existing route pattern (`server/src/routes/environments.ts`). Flag as a minor file-map addition; it is required because the Step "Your profile" component needs an endpoint.

- [ ] **Step 1: Write the failing test** (service-with-mocks, Proxy tables + sequence db per the pattern in `server/src/__tests__/commander-company-name.test.ts`)

```ts
// server/src/__tests__/user-profiles-service.test.ts
import { describe, it, expect, vi } from "vitest";

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
}));
vi.mock("@armyofagents/db", () => ({
  userProfiles: new Proxy({}, { get: (_t, p) => (p === "userId" ? Symbol("user_id") : Symbol(String(p))) }),
}));

import { userProfilesService } from "../services/user-profiles.js";

describe("userProfilesService.upsert", () => {
  it("inserts with onConflictDoUpdate keyed on userId (idempotent)", async () => {
    const calls: any = { insert: null, set: null, conflict: null };
    const db: any = {
      insert: () => ({
        values: (v: any) => { calls.insert = v; return {
          onConflictDoUpdate: (cfg: any) => { calls.conflict = cfg; return {
            returning: async () => [{ ...v }],
          }; },
        }; },
      }),
    };
    const svc = userProfilesService(db);
    const row = await svc.upsert("u1", { displayName: "Ada", socialLinks: [] });
    expect(calls.insert).toMatchObject({ userId: "u1", displayName: "Ada" });
    expect(calls.conflict.target).toBeDefined(); // conflict target = userId PK
    expect(row.displayName).toBe("Ada");
  });

  it("get returns null when no row", async () => {
    const db: any = { select: () => ({ from: () => ({ where: async () => [] }) }) };
    const svc = userProfilesService(db);
    expect(await svc.get("nobody")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm test:run src/__tests__/user-profiles-service.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the service (upsert-by-PK idempotency + guarded seed)**

```ts
// server/src/services/user-profiles.ts
import type { Db } from "@armyofagents/db";
import { userProfiles, type UserProfileSocialLink } from "@armyofagents/db";
import { eq } from "drizzle-orm";

export type UserProfileInput = {
  displayName?: string | null;
  avatarUrl?: string | null;
  title?: string | null;
  bio?: string | null;
  socialLinks?: UserProfileSocialLink[];
};

export function userProfilesService(db: Db) {
  async function get(userId: string) {
    return db
      .select()
      .from(userProfiles)
      .where(eq(userProfiles.userId, userId))
      .then((rows) => rows[0] ?? null);
  }

  // Idempotent: PK is userId, so re-entry updates instead of duplicating.
  async function upsert(userId: string, input: UserProfileInput) {
    const values = {
      userId,
      displayName: input.displayName ?? null,
      avatarUrl: input.avatarUrl ?? null,
      title: input.title ?? null,
      bio: input.bio ?? null,
      socialLinks: input.socialLinks ?? [],
      updatedAt: new Date(),
    };
    const rows = await db
      .insert(userProfiles)
      .values(values)
      .onConflictDoUpdate({
        target: userProfiles.userId,
        set: {
          displayName: values.displayName,
          avatarUrl: values.avatarUrl,
          title: values.title,
          bio: values.bio,
          socialLinks: values.socialLinks,
          updatedAt: values.updatedAt,
        },
      })
      .returning();
    return rows[0];
  }

  // Stage 0 §2.1 / scope §6 require seeding company_user_profiles from
  // user_profiles on org create/join. That table DOES NOT EXIST in this
  // worktree (see Pre-flight discrepancy note). Until it is added, this is a
  // documented no-op so callers (org-create step, invited join) can wire the
  // call site now without a phantom import. Do NOT fabricate the table here.
  async function seedCompanyUserProfile(_companyId: string, _userId: string): Promise<void> {
    // TODO(company_user_profiles): implement once the per-org profile table
    // exists. Intentionally a no-op — flagged in the Stage C plan Pre-flight.
    return;
  }

  return { get, upsert, seedCompanyUserProfile };
}
```

- [ ] **Step 4: Add the route (GET + PUT own profile)**

```ts
// server/src/routes/user-profiles.ts
import { Router } from "express";
import { z } from "zod";
import type { Db } from "@armyofagents/db";
import { userProfilesService } from "../services/user-profiles.js";
import { validate } from "../middleware/validate.js";
import { assertBoard } from "./authz.js";

const socialLinkSchema = z.object({
  type: z.string().min(1),
  label: z.string().nullable().optional().default(null),
  url: z.string().url(),
});
const updateProfileSchema = z.object({
  displayName: z.string().min(1).max(200).nullable().optional(),
  avatarUrl: z.string().url().nullable().optional(),
  title: z.string().max(200).nullable().optional(),
  bio: z.string().max(2000).nullable().optional(),
  socialLinks: z.array(socialLinkSchema).max(20).optional(),
});

export function userProfileRoutes(db: Db) {
  const router = Router();
  const svc = userProfilesService(db);

  // Own profile only — never another user's (identity layer is per-human).
  router.get("/user-profile", async (req, res) => {
    assertBoard(req);
    const userId = req.actor.userId;
    if (!userId) { res.status(401).json({ error: "No user identity" }); return; }
    res.json((await svc.get(userId)) ?? { userId, displayName: null, socialLinks: [] });
  });

  router.put("/user-profile", validate(updateProfileSchema), async (req, res) => {
    assertBoard(req);
    const userId = req.actor.userId;
    if (!userId) { res.status(401).json({ error: "No user identity" }); return; }
    res.json(await svc.upsert(userId, req.body));
  });

  return router;
}
```

Mount it next to the other authenticated board routes (search `app.ts` for where `environmentRoutes(...)` / other board routers are mounted, and add `app.use("/api", userProfileRoutes(db));`).

> Task author: confirm `req.actor.userId` is the better-auth user id in the resolved-session path (Stage A wires Google identity in both modes). In `local_trusted` escape-hatch it is `"local-board"` — acceptable for dev.

- [ ] **Step 5: Run test + verify pass**

Run: `pnpm test:run src/__tests__/user-profiles-service.test.ts` then `pnpm typecheck`
Expected: PASS; no type errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/services/user-profiles.ts server/src/routes/user-profiles.ts server/src/app.ts server/src/__tests__/user-profiles-service.test.ts
git commit -m "feat(onboarding): user_profiles service + own-profile route (guarded per-org seed)"
```

---

## Task C3: Step "Your profile" (`PROFILE_SET`)

**Files:**
- Create: `ui/src/api/user-profiles.ts`
- Create: `ui/src/onboarding/steps/ProfileStep.tsx`
- Modify: `ui/src/onboarding/registry.ts` (append `profileStep`)
- Test: `ui/src/onboarding/steps/__tests__/profile-step.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// ui/src/onboarding/steps/__tests__/profile-step.test.tsx
import { describe, it, expect } from "vitest";
import { profileStep } from "../ProfileStep";

describe("profileStep definition", () => {
  it("satisfies PROFILE_SET, is in the founder journey, name required", () => {
    expect(profileStep.state).toBe("PROFILE_SET");
    expect(profileStep.journeys).toContain("founder");
    expect(profileStep.dependsOn).toEqual(["AUTHENTICATED"]);
    expect(profileStep.canSkip).toBe(false); // name required; other fields optional
  });
  it("isComplete once PROFILE_SET is in completedStates", () => {
    expect(profileStep.isComplete({ userId: "u", companyId: null, journey: "founder", completedStates: ["AUTHENTICATED", "PROFILE_SET"] })).toBe(true);
    expect(profileStep.isComplete({ userId: "u", companyId: null, journey: "founder", completedStates: ["AUTHENTICATED"] })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm --filter @armyofagents/ui test:run src/onboarding/steps/__tests__/profile-step.test.tsx`
Expected: FAIL — module missing.

- [ ] **Step 3: API client**

```ts
// ui/src/api/user-profiles.ts
import { api } from "./client"; // reuse the shared fetch wrapper (confirm export name in ui/src/api/client.ts)

export type UserProfileSocialLink = { type: string; label: string | null; url: string };
export type UserProfile = {
  userId: string;
  displayName: string | null;
  avatarUrl?: string | null;
  title?: string | null;
  bio?: string | null;
  socialLinks: UserProfileSocialLink[];
};

export const userProfilesApi = {
  get: () => api.get<UserProfile>("/user-profile"),
  update: (data: Partial<Omit<UserProfile, "userId">>) => api.put<UserProfile>("/user-profile", data),
};
```

> Task author: confirm `ui/src/api/client.ts` exposes `api.get/put` (the other clients import `{ api }`). If the wrapper differs, mirror the exact call convention used in `ui/src/api/projects.ts`.

- [ ] **Step 4: Step component (prefill from Google identity; name-required; social links optional)**

```tsx
// ui/src/onboarding/steps/ProfileStep.tsx
import { lazy, useEffect, useState } from "react";
import type { StepDefinition, StepProps } from "../registry";
import { userProfilesApi } from "../../api/user-profiles";

function ProfileStepBody({ onComplete }: StepProps) {
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [links, setLinks] = useState<{ type: string; url: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Prefill: Google gives display name + avatar via the existing profile row
  // (Stage A stamps them on first login) — read once.
  useEffect(() => {
    userProfilesApi.get().then((p) => {
      setName(p.displayName ?? "");
      setAvatarUrl(p.avatarUrl ?? null);
      setTitle(p.title ?? "");
      setLinks((p.socialLinks ?? []).map((l) => ({ type: l.type, url: l.url })));
    }).catch(() => {});
  }, []);

  async function save() {
    if (!name.trim()) { setError("Name is required."); return; }
    setLoading(true); setError(null);
    try {
      await userProfilesApi.update({
        displayName: name.trim(),
        avatarUrl,
        title: title.trim() || null,
        socialLinks: links.filter((l) => l.url.trim()).map((l) => ({ type: l.type, label: null, url: l.url.trim() })),
      });
      onComplete();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save profile");
    } finally { setLoading(false); }
  }

  return (
    <div className="space-y-5">
      <div>
        <h3 className="font-medium">Your profile</h3>
        <p className="text-xs text-muted-foreground">Prefilled from your Google account. Name is required; everything else is optional.</p>
      </div>
      {avatarUrl && <img src={avatarUrl} alt="" className="h-12 w-12 rounded-full" />}
      <label className="text-xs text-muted-foreground block">Name
        <input className="mt-1 w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </label>
      <label className="text-xs text-muted-foreground block">Title (optional)
        <input className="mt-1 w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Founder" />
      </label>
      {/* Minimal social-links editor — one row per link; add/remove kept simple */}
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">Social links (optional)</p>
        {links.map((l, i) => (
          <div key={i} className="flex gap-2">
            <input className="w-28 rounded-md border border-border bg-transparent px-2 py-1 text-xs" value={l.type} onChange={(e) => setLinks(links.map((x, j) => j === i ? { ...x, type: e.target.value } : x))} placeholder="github" />
            <input className="flex-1 rounded-md border border-border bg-transparent px-2 py-1 text-xs" value={l.url} onChange={(e) => setLinks(links.map((x, j) => j === i ? { ...x, url: e.target.value } : x))} placeholder="https://…" />
          </div>
        ))}
        <button type="button" className="text-xs text-muted-foreground underline" onClick={() => setLinks([...links, { type: "website", url: "" }])}>+ Add link</button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <button className="rounded-md bg-foreground px-3 py-2 text-sm text-background disabled:opacity-50" disabled={loading || !name.trim()} onClick={save}>
        {loading ? "Saving…" : "Continue"}
      </button>
    </div>
  );
}

export const profileStep: StepDefinition = {
  id: "profile",
  state: "PROFILE_SET",
  journeys: ["founder", "invited"], // invited humans also set a profile
  dependsOn: ["AUTHENTICATED"],
  canSkip: false,
  isComplete: (ctx) => ctx.completedStates.includes("PROFILE_SET"),
  Component: lazy(() => Promise.resolve({ default: ProfileStepBody })),
  title: "Your profile",
};
```

- [ ] **Step 5: Register in the Stage B registry**

In `ui/src/onboarding/registry.ts`, import and append `profileStep` to the exported registry array (Stage B leaves the array extensible). Keep the array ordered by `FOUNDER_PHASE1_STATES`.

> Task author: confirm the exact export shape of `registry.ts` (array name). If Stage B exports `export const onboardingRegistry: StepDefinition[] = []`, append there; if it exports a builder, register through it.

- [ ] **Step 6: Run test, verify pass + commit**

Run: `pnpm --filter @armyofagents/ui test:run src/onboarding/steps/__tests__/profile-step.test.tsx`
Expected: PASS.
```bash
git add ui/src/api/user-profiles.ts ui/src/onboarding/steps/ProfileStep.tsx ui/src/onboarding/registry.ts ui/src/onboarding/steps/__tests__/profile-step.test.tsx
git commit -m "feat(onboarding): Your profile step (PROFILE_SET)"
```

---

## Task C4: Step "Create organization" (`ORGANIZATION_CREATED`)

**Files:**
- Create: `ui/src/onboarding/steps/OrganizationStep.tsx`
- Modify: `ui/src/onboarding/registry.ts`
- Test: `ui/src/onboarding/steps/__tests__/organization-step.test.tsx`

Ports wizard Step 1 + `handleStep4Next` company-create (`OnboardingWizard.tsx:448-507`), **minus** the mission/goal field (scope §6: "Name-only; mission/vision deferred") and minus the deferred Commander/Crew POST (that moves to Steps C6). Uses `companiesApi.create({ name })` → server sets creator = founder via `ensureRealOperator` (`server/src/routes/companies.ts:136`).

- [ ] **Step 1: Write the failing test**

```tsx
// ui/src/onboarding/steps/__tests__/organization-step.test.tsx
import { describe, it, expect } from "vitest";
import { organizationStep } from "../OrganizationStep";

describe("organizationStep", () => {
  it("satisfies ORGANIZATION_CREATED after PROFILE_SET", () => {
    expect(organizationStep.state).toBe("ORGANIZATION_CREATED");
    expect(organizationStep.dependsOn).toEqual(["PROFILE_SET"]);
    expect(organizationStep.journeys).toEqual(["founder"]); // invited joins, never creates
    expect(organizationStep.canSkip).toBe(false);
  });
  it("isComplete when companyId already bound (idempotent re-entry)", () => {
    // Engine binds companyId once the org exists; the step must not re-create.
    expect(organizationStep.isComplete({ userId: "u", companyId: "c1", journey: "founder", completedStates: ["PROFILE_SET", "ORGANIZATION_CREATED"] })).toBe(true);
    expect(organizationStep.isComplete({ userId: "u", companyId: null, journey: "founder", completedStates: ["PROFILE_SET"] })).toBe(false);
  });
});
```

- [ ] **Step 2: Run, verify FAIL** — `pnpm --filter @armyofagents/ui test:run src/onboarding/steps/__tests__/organization-step.test.tsx`

- [ ] **Step 3: Implement (idempotent: skip create if ctx.companyId already set)**

```tsx
// ui/src/onboarding/steps/OrganizationStep.tsx
import { lazy, useState } from "react";
import type { StepDefinition, StepProps } from "../registry";
import { companiesApi } from "../../api/companies";

function OrganizationStepBody({ ctx, onComplete }: StepProps) {
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    if (!name.trim()) return;
    setLoading(true); setError(null);
    try {
      // Idempotent guard: if a company is already bound to this progress row
      // (re-entry after a partial run), do not create a second org.
      if (!ctx.companyId) {
        await companiesApi.create({ name: name.trim() });
        // ensureRealOperator (server) makes the creator founder + seeds membership.
        // The FlowEngine re-reads StepContext on onComplete and picks up companyId
        // from the new membership (Stage B contract).
      }
      onComplete();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create organization");
    } finally { setLoading(false); }
  }

  return (
    <div className="space-y-5">
      <div>
        <h3 className="font-medium">Create your organization</h3>
        <p className="text-xs text-muted-foreground">This is the company your agents will work for. You can add a mission later in Settings.</p>
      </div>
      <label className="text-xs text-muted-foreground block">Organization name
        <input className="mt-1 w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm" value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Corp" autoFocus />
      </label>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <button className="rounded-md bg-foreground px-3 py-2 text-sm text-background disabled:opacity-50" disabled={loading || !name.trim()} onClick={create}>
        {loading ? "Creating…" : "Create organization"}
      </button>
    </div>
  );
}

export const organizationStep: StepDefinition = {
  id: "organization",
  state: "ORGANIZATION_CREATED",
  journeys: ["founder"],
  dependsOn: ["PROFILE_SET"],
  canSkip: false,
  isComplete: (ctx) => ctx.companyId != null && ctx.completedStates.includes("ORGANIZATION_CREATED"),
  Component: lazy(() => Promise.resolve({ default: OrganizationStepBody })),
  title: "Create organization",
};
```

> **Task author (contract note for Stage B):** `StepProps.onComplete` is `() => void` (Stage 0 §4) — it carries no `companyId`. The org-create step relies on the FlowEngine **re-reading `StepContext` from server state after each `onComplete`** so the freshly-created `companyId` (from the new `company_memberships` row) flows into `ORGANIZATION_CREATED → SETUP_COMPLETE`. Confirm Stage B's engine refetches journey/progress (not a purely in-memory advance). If it does not, this is a Stage B/C integration gap to raise with the reconciler.

- [ ] **Step 4: Register + run + commit**

Append `organizationStep` to the registry. Run the test (PASS), then:
```bash
git add ui/src/onboarding/steps/OrganizationStep.tsx ui/src/onboarding/registry.ts ui/src/onboarding/steps/__tests__/organization-step.test.tsx
git commit -m "feat(onboarding): Create organization step (ORGANIZATION_CREATED), name-only"
```

---

## Task C5: Blocking local write-probe + Step "Set up environment" (`ENVIRONMENT_READY`)

**Files:**
- Modify: `server/src/services/environment-probe.ts` (make the `local` branch actually verify read/write — fixes the non-fatal folder-create)
- Create: `server/src/services/onboarding-environment.ts` (idempotent env upsert + rootFolder set + probe)
- Create: `server/src/routes/onboarding-environment.ts` (POST setup)
- Create: `ui/src/onboarding/steps/EnvironmentStep.tsx`
- Modify: `ui/src/onboarding/registry.ts`
- Tests: `server/src/__tests__/environment-probe-local-write.test.ts`, `server/src/__tests__/onboarding-environment-setup.test.ts`, `ui/src/onboarding/steps/__tests__/environment-step.test.tsx`

**Why the probe change:** `probeEnvironmentConfig({ driver: "local" })` currently returns `{ ok: true }` unconditionally (`environment-probe.ts:75-86`) — it never touches the filesystem. Scope §6 Step 3 requires **blocking on "no write perms / missing path."** So the local branch must actually attempt a write when a `path` is supplied.

- [ ] **Step 1: Write the failing probe test**

```ts
// server/src/__tests__/environment-probe-local-write.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { probeEnvironmentConfig } from "../services/environment-probe.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const made: string[] = [];
afterEach(() => { for (const d of made) try { rmSync(d, { recursive: true, force: true }); } catch {} made.length = 0; });

describe("local environment probe verifies writability", () => {
  it("passes for a writable path", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "aoa-env-")); made.push(dir);
    const r = await probeEnvironmentConfig({ companyId: "c1", driver: "local", config: { path: dir } });
    expect(r.ok).toBe(true);
  });
  it("fails (blocking) for a path that cannot be created/written", async () => {
    // A path under a file (not a dir) can never be a writable directory.
    const r = await probeEnvironmentConfig({ companyId: "c1", driver: "local", config: { path: "/definitely/invalid" } });
    expect(r.ok).toBe(false);
    expect(r.checks?.some((c) => c.status === "failed")).toBe(true);
  });
  it("still passes with no path (back-compat — nothing to verify)", async () => {
    const r = await probeEnvironmentConfig({ companyId: "c1", driver: "local", config: {} });
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run, verify FAIL** — `pnpm test:run src/__tests__/environment-probe-local-write.test.ts`
Expected: the "fails for invalid path" case FAILS (probe returns ok:true today).

- [ ] **Step 3: Make the local branch verify read/write**

Replace the `if (input.driver === "local") { return { ok: true, … } }` block (`environment-probe.ts:75-86`) with:

```ts
  if (input.driver === "local") {
    const targetPath = readString(input.config.path) ?? readString(input.config.rootFolder);
    if (!targetPath) {
      return {
        ok: true,
        driver: "local",
        summary: "Local environment configuration is valid.",
        checks: [{ name: "config", status: "passed", message: "Local runtime does not require provider config." }],
      };
    }
    // Blocking read/write verification (fixes the previously non-fatal folder-create).
    const { mkdir, writeFile, rm } = await import("node:fs/promises");
    const nodePath = await import("node:path");
    try {
      await mkdir(targetPath, { recursive: true });
      const probeFile = nodePath.join(targetPath, `.aoa-write-probe-${Date.now()}`);
      await writeFile(probeFile, "ok");
      await rm(probeFile, { force: true });
      return {
        ok: true,
        driver: "local",
        summary: `Verified read/write access to ${targetPath}.`,
        checks: [{ name: "config.path", status: "passed", message: `Directory is writable: ${targetPath}` }],
      };
    } catch (err) {
      return {
        ok: false,
        driver: "local",
        summary: `Cannot write to ${targetPath}.`,
        checks: [{
          name: "config.path",
          status: "failed",
          message: err instanceof Error ? err.message : "Directory is not writable.",
        }],
      };
    }
  }
```

- [ ] **Step 4: Run probe test, verify PASS**

Run: `pnpm test:run src/__tests__/environment-probe-local-write.test.ts`
Expected: PASS (3).

- [ ] **Step 5: Write the onboarding-environment service test (idempotent upsert-by-name)**

```ts
// server/src/__tests__/onboarding-environment-setup.test.ts
import { describe, it, expect, vi } from "vitest";
vi.mock("drizzle-orm", () => ({ and: (...a: unknown[]) => a, eq: (a: unknown, b: unknown) => ({ eq: [a, b] }) }));
vi.mock("@armyofagents/db", () => ({
  environments: new Proxy({}, { get: (_t, p) => Symbol(String(p)) }),
  companies: new Proxy({}, { get: (_t, p) => Symbol(String(p)) }),
}));
import { setupOnboardingEnvironment } from "../services/onboarding-environment.js";

const ENV_NAME = "Local machine";

describe("setupOnboardingEnvironment", () => {
  it("creates env when none exists, sets rootFolder, and blocks on probe fail", async () => {
    const inserted: any[] = []; const updated: any[] = [];
    const db: any = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
      insert: () => ({ values: (v: any) => ({ returning: async () => { inserted.push(v); return [{ id: "e1", ...v }]; } }) }),
      update: () => ({ set: (v: any) => ({ where: async () => { updated.push(v); } }) }),
    };
    const probe = vi.fn(async () => ({ ok: false, driver: "local", summary: "no perms", checks: [{ name: "config.path", status: "failed", message: "denied" }] }));
    const res = await setupOnboardingEnvironment(db, { companyId: "c1", rootFolder: "/tmp/acme", probe });
    expect(res.ok).toBe(false); // blocking: probe failed
    expect(inserted[0]).toMatchObject({ companyId: "c1", name: ENV_NAME, driver: "local" });
    expect(probe).toHaveBeenCalled();
  });

  it("re-entry updates the existing env (no duplicate) when probe passes", async () => {
    const db: any = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: "e1", name: ENV_NAME }] }) }) }),
      update: () => ({ set: () => ({ where: async () => {} }) }),
    };
    const probe = vi.fn(async () => ({ ok: true, driver: "local", summary: "ok" }));
    const res = await setupOnboardingEnvironment(db, { companyId: "c1", rootFolder: "/tmp/acme", probe });
    expect(res.ok).toBe(true);
    expect(res.environmentId).toBe("e1");
  });
});
```

- [ ] **Step 6: Implement the service**

```ts
// server/src/services/onboarding-environment.ts
import type { Db } from "@armyofagents/db";
import { environments, companies } from "@armyofagents/db";
import { and, eq } from "drizzle-orm";
import { probeEnvironmentConfig, type EnvironmentProbeResult } from "./environment-probe.js";

export const ONBOARDING_ENVIRONMENT_NAME = "Local machine";

type ProbeFn = (input: { companyId: string; driver: "local"; config: Record<string, unknown> }) => Promise<EnvironmentProbeResult>;

export async function setupOnboardingEnvironment(
  db: Db,
  args: { companyId: string; rootFolder: string; probe?: ProbeFn },
): Promise<{ ok: boolean; environmentId: string | null; probe: EnvironmentProbeResult }> {
  const probeFn = args.probe ?? probeEnvironmentConfig;
  // 1. Blocking probe FIRST — never write rootFolder against an unwritable path.
  const probe = await probeFn({ companyId: args.companyId, driver: "local", config: { path: args.rootFolder } });
  if (!probe.ok) {
    return { ok: false, environmentId: null, probe };
  }
  // 2. Idempotent env upsert-by-name (Stage 0: "environment upserts by name").
  const [existing] = await db
    .select({ id: environments.id, name: environments.name })
    .from(environments)
    .where(and(eq(environments.companyId, args.companyId), eq(environments.name, ONBOARDING_ENVIRONMENT_NAME)))
    .limit(1);

  let environmentId: string;
  if (existing) {
    await db.update(environments)
      .set({ driver: "local", config: { path: args.rootFolder }, status: "active", updatedAt: new Date() })
      .where(eq(environments.id, existing.id));
    environmentId = existing.id;
  } else {
    const [created] = await db.insert(environments)
      .values({ companyId: args.companyId, name: ONBOARDING_ENVIRONMENT_NAME, driver: "local", status: "active", config: { path: args.rootFolder } })
      .returning();
    environmentId = created.id;
  }
  // 3. Persist rootFolder on the company (idempotent set).
  await db.update(companies).set({ rootFolder: args.rootFolder, updatedAt: new Date() }).where(eq(companies.id, args.companyId));
  return { ok: true, environmentId, probe };
}
```

- [ ] **Step 7: Route**

```ts
// server/src/routes/onboarding-environment.ts
import { Router } from "express";
import { z } from "zod";
import type { Db } from "@armyofagents/db";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { setupOnboardingEnvironment } from "../services/onboarding-environment.js";

const schema = z.object({ rootFolder: z.string().min(1) });

export function onboardingEnvironmentRoutes(db: Db) {
  const router = Router();
  router.post("/companies/:companyId/onboarding/environment", validate(schema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const result = await setupOnboardingEnvironment(db, { companyId, rootFolder: req.body.rootFolder });
    // Blocking: 422 on probe failure so the UI stays on the step.
    res.status(result.ok ? 200 : 422).json(result);
  });
  return router;
}
```

Mount alongside the other company-scoped routers in `app.ts`.

- [ ] **Step 8: Step component (prefill home dir, Browse, retry-on-block)**

```tsx
// ui/src/onboarding/steps/EnvironmentStep.tsx
import { lazy, useEffect, useState } from "react";
import type { StepDefinition, StepProps } from "../registry";
import { filesystemApi } from "../../api/filesystem";
import { api } from "../../api/client";

function EnvironmentStepBody({ ctx, onComplete }: StepProps) {
  const [rootFolder, setRootFolder] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    filesystemApi.home().then(({ homePath }) => {
      const sep = homePath.includes("\\") ? "\\" : "/";
      setRootFolder(`${homePath}${sep}AoA`);
    }).catch(() => {});
  }, []);

  async function setup() {
    if (!ctx.companyId || !rootFolder.trim()) return;
    setLoading(true); setError(null);
    try {
      // 422 = probe blocked → surface the reason and keep the user here.
      await api.post(`/companies/${ctx.companyId}/onboarding/environment`, { rootFolder: rootFolder.trim() });
      onComplete();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not verify this folder. Pick another path or check permissions, then retry.");
    } finally { setLoading(false); }
  }

  return (
    <div className="space-y-5">
      <div>
        <h3 className="font-medium">Set up your environment</h3>
        <p className="text-xs text-muted-foreground">AoA registers this machine and verifies it can read and write here. This is where department workspaces and agent files live.</p>
      </div>
      <label className="text-xs text-muted-foreground block">Root folder
        <input className="mt-1 w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm font-mono" value={rootFolder} onChange={(e) => setRootFolder(e.target.value)} />
      </label>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <button className="rounded-md bg-foreground px-3 py-2 text-sm text-background disabled:opacity-50" disabled={loading || !rootFolder.trim()} onClick={setup}>
        {loading ? "Verifying…" : "Verify & continue"}
      </button>
    </div>
  );
}

export const environmentStep: StepDefinition = {
  id: "environment",
  state: "ENVIRONMENT_READY",
  journeys: ["founder"],
  dependsOn: ["ORGANIZATION_CREATED"],
  canSkip: false,
  isComplete: (ctx) => ctx.completedStates.includes("ENVIRONMENT_READY"),
  Component: lazy(() => Promise.resolve({ default: EnvironmentStepBody })),
  title: "Set up environment",
};
```

> Task author: confirm `filesystemApi.home()` returns `{ homePath }` (it does — `server/src/routes/filesystem.ts:159`) and that `api.post` throws on non-2xx (so a 422 lands in `catch`). Optionally surface `result.probe.checks[].message` from the 422 body for a precise reason.

- [ ] **Step 9: Register, run all three tests, commit**

Run:
```
pnpm test:run src/__tests__/environment-probe-local-write.test.ts src/__tests__/onboarding-environment-setup.test.ts
pnpm --filter @armyofagents/ui test:run src/onboarding/steps/__tests__/environment-step.test.tsx
```
Expected: PASS.
```bash
git add server/src/services/environment-probe.ts server/src/services/onboarding-environment.ts server/src/routes/onboarding-environment.ts server/src/app.ts ui/src/onboarding/steps/EnvironmentStep.tsx ui/src/onboarding/registry.ts server/src/__tests__/environment-probe-local-write.test.ts server/src/__tests__/onboarding-environment-setup.test.ts ui/src/onboarding/steps/__tests__/environment-step.test.tsx
git commit -m "feat(onboarding): blocking local env write-probe + Set up environment step (ENVIRONMENT_READY)"
```

---

## Task C6: Step "Choose Commander" (`COMMANDER_SELECTED`)

**Files:**
- Create: `ui/src/onboarding/steps/CommanderStep.tsx`
- Modify: `ui/src/onboarding/registry.ts`
- Test: `ui/src/onboarding/steps/__tests__/commander-step.test.tsx`

Ports wizard Step 3 (`OnboardingWizard.tsx:869-927`) but **cards not a dropdown, no model internals** (scope §6: "Claude / Codex cards; no model internals"). Writes `internal_agent_config` via `internalAgentApi.updateConfig` (`PATCH …/internal-agent/config`) — the config row already exists (seeded at company create by `ensureInternalAgentConfig`, `server/src/services/companies.ts:154`), so this is an **idempotent upsert-in-place** (the PATCH route updates the single row keyed on companyId). Uses `providerToCliTool` from `@armyofagents/shared`.

- [ ] **Step 1: Write the failing test**

```tsx
// ui/src/onboarding/steps/__tests__/commander-step.test.tsx
import { describe, it, expect } from "vitest";
import { commanderStep } from "../CommanderStep";

describe("commanderStep", () => {
  it("satisfies COMMANDER_SELECTED after ENVIRONMENT_READY", () => {
    expect(commanderStep.state).toBe("COMMANDER_SELECTED");
    expect(commanderStep.dependsOn).toEqual(["ENVIRONMENT_READY"]);
  });
});
```

- [ ] **Step 2: Run, verify FAIL** — `pnpm --filter @armyofagents/ui test:run src/onboarding/steps/__tests__/commander-step.test.tsx`

- [ ] **Step 3: Implement (two cards: Claude / Codex → cliTool)**

```tsx
// ui/src/onboarding/steps/CommanderStep.tsx
import { lazy, useState } from "react";
import type { StepDefinition, StepProps } from "../registry";
import { providerToCliTool } from "@armyofagents/shared";
import type { CommanderProvider } from "@armyofagents/shared";
import { internalAgentApi } from "../../api/internal-agent";

const CARDS: { provider: CommanderProvider; label: string; desc: string }[] = [
  { provider: "anthropic", label: "Claude", desc: "Anthropic Claude Code CLI" },
  { provider: "openai", label: "Codex", desc: "OpenAI Codex CLI" },
];

function CommanderStepBody({ ctx, onComplete }: StepProps) {
  const [provider, setProvider] = useState<CommanderProvider | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function choose() {
    if (!ctx.companyId || !provider) return;
    setLoading(true); setError(null);
    try {
      // Idempotent: PATCH updates the single internal_agent_config row in place.
      // No model internals — blank model → provider default server-side.
      await internalAgentApi.updateConfig(ctx.companyId, {
        cliTool: providerToCliTool(provider),
        provider,           // crew inherits the same provider by default
        model: null,
        crewModel: null,
      });
      onComplete();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save Commander choice");
    } finally { setLoading(false); }
  }

  return (
    <div className="space-y-5">
      <div>
        <h3 className="font-medium">Choose your Commander</h3>
        <p className="text-xs text-muted-foreground">Commander is your always-on AI assistant. Pick the CLI it runs on — you can change the model later in Settings.</p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {CARDS.map((c) => (
          <button key={c.provider} type="button"
            className={`rounded-md border p-4 text-left ${provider === c.provider ? "border-foreground bg-accent" : "border-border hover:bg-accent/50"}`}
            onClick={() => setProvider(c.provider)}>
            <div className="text-sm font-medium">{c.label}</div>
            <div className="text-xs text-muted-foreground">{c.desc}</div>
          </button>
        ))}
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <button className="rounded-md bg-foreground px-3 py-2 text-sm text-background disabled:opacity-50" disabled={loading || !provider} onClick={choose}>
        {loading ? "Saving…" : "Continue"}
      </button>
    </div>
  );
}

export const commanderStep: StepDefinition = {
  id: "commander",
  state: "COMMANDER_SELECTED",
  journeys: ["founder"],
  dependsOn: ["ENVIRONMENT_READY"],
  canSkip: false,
  isComplete: (ctx) => ctx.completedStates.includes("COMMANDER_SELECTED"),
  Component: lazy(() => Promise.resolve({ default: CommanderStepBody })),
  title: "Choose Commander",
};
```

- [ ] **Step 4: Register, run, commit**

Run test (PASS), then:
```bash
git add ui/src/onboarding/steps/CommanderStep.tsx ui/src/onboarding/registry.ts ui/src/onboarding/steps/__tests__/commander-step.test.tsx
git commit -m "feat(onboarding): Choose Commander step (COMMANDER_SELECTED)"
```

---

## Task C7: `commander-verify` service (extends the adapter probe)

**Files:**
- Create: `server/src/services/commander-verify.ts`
- Create: `server/src/routes/commander-verify.ts` (POST verify)
- Test: `server/src/__tests__/commander-verify.test.ts`

Reuses the existing adapter environment probe — the same `adapter.testEnvironment(...)` the wizard drives via `POST …/adapters/:type/test-environment` (`server/src/routes/agents.ts:528-617`; the claude_local implementation is `packages/adapters/claude-local/src/server/test.ts`). The service resolves the Commander's adapter type from `internal_agent_config.cliTool` and classifies the `AdapterEnvironmentTestResult` into `verified | needs_auth | not_installed | failed` for the recovery UI.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/commander-verify.test.ts
import { describe, it, expect, vi } from "vitest";
import { classifyCommanderProbe, cliToolToAdapterType } from "../services/commander-verify.js";

describe("cliToolToAdapterType", () => {
  it("maps commander cliTools to adapter types", () => {
    expect(cliToolToAdapterType("claude_cli")).toBe("claude_local");
    expect(cliToolToAdapterType("codex")).toBe("codex_local");
    expect(cliToolToAdapterType("opencode")).toBe("opencode_local");
  });
});

describe("classifyCommanderProbe", () => {
  const R = (checks: any[], status: any) => ({ adapterType: "claude_local", status, checks, testedAt: "" });
  it("verified on pass", () => {
    expect(classifyCommanderProbe(R([{ code: "claude_hello_probe_passed", level: "info" }], "pass")).outcome).toBe("verified");
  });
  it("needs_auth when login required", () => {
    expect(classifyCommanderProbe(R([{ code: "claude_hello_probe_auth_required", level: "warn" }], "warn")).outcome).toBe("needs_auth");
  });
  it("not_installed when command unresolvable", () => {
    expect(classifyCommanderProbe(R([{ code: "claude_command_unresolvable", level: "error" }], "fail")).outcome).toBe("not_installed");
  });
  it("failed on other hard errors", () => {
    expect(classifyCommanderProbe(R([{ code: "claude_hello_probe_failed", level: "error" }], "fail")).outcome).toBe("failed");
  });
});
```

- [ ] **Step 2: Run, verify FAIL** — `pnpm test:run src/__tests__/commander-verify.test.ts`

- [ ] **Step 3: Implement the classifier + service**

```ts
// server/src/services/commander-verify.ts
import type { Db } from "@armyofagents/db";
import { internalAgentConfig } from "@armyofagents/db";
import { eq } from "drizzle-orm";
import type { AdapterEnvironmentTestResult } from "@armyofagents/shared";

export type CommanderVerifyOutcome = "verified" | "needs_auth" | "not_installed" | "failed";

export function cliToolToAdapterType(cliTool: string | null | undefined): string {
  switch (cliTool) {
    case "claude_cli": return "claude_local";
    case "codex": return "codex_local";
    case "opencode": return "opencode_local";
    default: return "claude_local"; // safe default; Commander defaults to claude_cli
  }
}

export function classifyCommanderProbe(result: AdapterEnvironmentTestResult): {
  outcome: CommanderVerifyOutcome;
  result: AdapterEnvironmentTestResult;
} {
  const codes = new Set(result.checks.map((c) => c.code));
  const anyCode = (needle: string) => [...codes].some((c) => c.includes(needle));
  if (result.status === "pass") return { outcome: "verified", result };
  // Auth-required is a warn/soft state across adapters (…_auth_required / login).
  if (anyCode("auth_required") || anyCode("login")) return { outcome: "needs_auth", result };
  if (anyCode("command_unresolvable") || anyCode("not_installed") || anyCode("install")) return { outcome: "not_installed", result };
  // A pure warn with hello-passed-but-unexpected is still usable → verified-ish;
  // treat non-error warn as verified so the founder is not hard-blocked on a
  // cosmetic mismatch, per scope §8 ("green ready state unlocks Continue").
  if (result.status === "warn") return { outcome: "verified", result };
  return { outcome: "failed", result };
}

export async function resolveCommanderAdapterType(db: Db, companyId: string): Promise<string> {
  const [cfg] = await db
    .select({ cliTool: internalAgentConfig.cliTool })
    .from(internalAgentConfig)
    .where(eq(internalAgentConfig.companyId, companyId))
    .limit(1);
  return cliToolToAdapterType(cfg?.cliTool ?? "claude_cli");
}
```

- [ ] **Step 4: Route (drives the shared adapter probe)**

```ts
// server/src/routes/commander-verify.ts
import { Router } from "express";
import type { Db } from "@armyofagents/db";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { classifyCommanderProbe, resolveCommanderAdapterType } from "../services/commander-verify.js";
import { findServerAdapter } from "../adapters/registry.js"; // confirm exact export

export function commanderVerifyRoutes(db: Db) {
  const router = Router();
  router.post("/companies/:companyId/internal-agent/verify", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      const adapterType = await resolveCommanderAdapterType(db, companyId);
      const adapter = findServerAdapter(adapterType);
      if (!adapter?.testEnvironment) { res.status(404).json({ error: `No probe for ${adapterType}` }); return; }
      const result = await adapter.testEnvironment({ companyId, adapterType, config: {} });
      const classified = classifyCommanderProbe(result);
      // Blocking: only 200 on verified; needs_auth / not_installed / failed → 422 with guidance.
      res.status(classified.outcome === "verified" ? 200 : 422).json(classified);
    } catch (err) { next(err); }
  });
  return router;
}
```

> Task author: confirm the exact adapter-registry lookup (`findServerAdapter`) and `adapter.testEnvironment` signature — grep `server/src/adapters/registry.ts` and `packages/adapter-utils/src/types.ts` (`AdapterEnvironmentTestContext`). The wizard calls it via the agents route with `{ companyId, adapterType, config }`; the empty `config: {}` uses the CLI defaults (subscription-login path), which is what Commander verify should test. If Commander should probe inside the company root, pass `config: { cwd: <rootFolder> }`.

- [ ] **Step 5: Run, verify PASS + commit**

Run: `pnpm test:run src/__tests__/commander-verify.test.ts`
Expected: PASS. Mount the route in `app.ts`.
```bash
git add server/src/services/commander-verify.ts server/src/routes/commander-verify.ts server/src/app.ts server/src/__tests__/commander-verify.test.ts
git commit -m "feat(onboarding): commander-verify service + route (extends adapter probe)"
```

---

## Task C8: Step "Verify tooling" (`COMMANDER_VERIFIED`, BLOCKING, install/auth help)

**Files:**
- Create: `ui/src/onboarding/steps/VerifyStep.tsx`
- Modify: `ui/src/onboarding/registry.ts`
- Test: `ui/src/onboarding/steps/__tests__/verify-step.test.tsx`

Implements scope §8 detect → guide → verify: calls `POST …/internal-agent/verify`; on `needs_auth`/`not_installed` shows OS-specific install/login copy + **"Check again"** loop, plus an **API-key-paste** path that stores a per-company encrypted secret (via a small route wrapping `secretService.create`). Blocking until `verified` or the user goes Back to pick the other runtime.

- [ ] **Step 1: Write the failing test**

```tsx
// ui/src/onboarding/steps/__tests__/verify-step.test.tsx
import { describe, it, expect } from "vitest";
import { verifyStep } from "../VerifyStep";

describe("verifyStep", () => {
  it("satisfies COMMANDER_VERIFIED after COMMANDER_SELECTED and cannot skip", () => {
    expect(verifyStep.state).toBe("COMMANDER_VERIFIED");
    expect(verifyStep.dependsOn).toEqual(["COMMANDER_SELECTED"]);
    expect(verifyStep.canSkip).toBe(false);
  });
});
```

- [ ] **Step 2: Run, verify FAIL** — `pnpm --filter @armyofagents/ui test:run src/onboarding/steps/__tests__/verify-step.test.tsx`

- [ ] **Step 3: Implement (detect → guide → verify + API-key path)**

```tsx
// ui/src/onboarding/steps/VerifyStep.tsx
import { lazy, useState } from "react";
import type { StepDefinition, StepProps } from "../registry";
import { api } from "../../api/client";

type Outcome = "idle" | "verified" | "needs_auth" | "not_installed" | "failed";

function installHint(): string {
  const p = navigator.platform.toLowerCase();
  if (p.includes("mac")) return "brew install <cli>  # or download from the vendor docs";
  if (p.includes("win")) return "winget install <cli>  # or download the installer";
  return "npm i -g <cli>  # or follow the vendor install docs";
}

function VerifyStepBody({ ctx, onComplete }: StepProps) {
  const [outcome, setOutcome] = useState<Outcome>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);

  async function check() {
    if (!ctx.companyId) return;
    setBusy(true); setMessage(null);
    try {
      const res = await api.post<{ outcome: Outcome; result: { summary?: string } }>(`/companies/${ctx.companyId}/internal-agent/verify`, {});
      setOutcome(res.outcome);
      setMessage(res.result?.summary ?? null);
      if (res.outcome === "verified") onComplete();
    } catch (e: any) {
      // 422 body carries {outcome,result}
      const body = e?.body ?? e?.response;
      setOutcome(body?.outcome ?? "failed");
      setMessage(body?.result?.summary ?? (e instanceof Error ? e.message : "Verification failed"));
    } finally { setBusy(false); }
  }

  async function saveApiKey() {
    if (!ctx.companyId || !apiKey.trim()) return;
    setBusy(true);
    try {
      // Store as a per-company encrypted secret bound to the Commander adapter env.
      await api.post(`/companies/${ctx.companyId}/onboarding/commander-key`, { value: apiKey.trim() });
      setApiKey("");
      await check(); // re-verify with the key in place
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-5">
      <div>
        <h3 className="font-medium">Verify your tooling</h3>
        <p className="text-xs text-muted-foreground">We check that your Commander CLI is installed, launchable, and signed in. You never have to touch a terminal.</p>
      </div>

      {outcome === "not_installed" && (
        <div className="rounded-md border border-amber-300/60 bg-amber-50/40 p-3 text-xs space-y-2">
          <p>The CLI isn’t installed or isn’t on your PATH.</p>
          <pre className="font-mono bg-muted/50 p-2 rounded">{installHint()}</pre>
          <p>Install it, then choose <strong>Check again</strong>.</p>
        </div>
      )}
      {outcome === "needs_auth" && (
        <div className="rounded-md border border-amber-300/60 bg-amber-50/40 p-3 text-xs space-y-2">
          <p>The CLI is installed but needs sign-in. Run its login command, or paste an API key below.</p>
          <label className="block">API key (optional path)
            <input type="password" className="mt-1 w-full rounded border border-border bg-transparent px-2 py-1 font-mono" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-…" />
          </label>
          <button className="rounded bg-foreground px-2 py-1 text-background disabled:opacity-50" disabled={busy || !apiKey.trim()} onClick={saveApiKey}>Save key & verify</button>
        </div>
      )}
      {outcome === "failed" && <p className="text-xs text-destructive">{message ?? "Verification failed."}</p>}
      {message && outcome !== "failed" && <p className="text-xs text-muted-foreground">{message}</p>}

      <div className="flex gap-2">
        <button className="rounded-md bg-foreground px-3 py-2 text-sm text-background disabled:opacity-50" disabled={busy} onClick={check}>
          {busy ? "Checking…" : outcome === "idle" ? "Verify" : "Check again"}
        </button>
      </div>
      <p className="text-[11px] text-muted-foreground">Prefer the other runtime? Go Back to pick Claude or Codex.</p>
    </div>
  );
}

export const verifyStep: StepDefinition = {
  id: "verify",
  state: "COMMANDER_VERIFIED",
  journeys: ["founder"],
  dependsOn: ["COMMANDER_SELECTED"],
  canSkip: false,
  isComplete: (ctx) => ctx.completedStates.includes("COMMANDER_VERIFIED"),
  Component: lazy(() => Promise.resolve({ default: VerifyStepBody })),
  title: "Verify tooling",
};
```

- [ ] **Step 4: API-key secret route**

Add to `server/src/routes/commander-verify.ts` (or a sibling) a `POST /companies/:companyId/onboarding/commander-key` that:
1. resolves the Commander adapter type + its env-var name (`ANTHROPIC_API_KEY` for claude_cli, `OPENAI_API_KEY` for codex),
2. calls `secretService(db).create(companyId, { name: <envVar>, provider: <secret provider>, managedMode: "aoa_managed", value })` (see `server/src/services/secrets.ts:499`), and
3. binds it into the Commander agent's adapter `env` as a `secret_ref` (mirror `syncEnvBindingsForTarget`).

> **Task author (verification pointer):** confirm the exact per-company secret provider enum + the env-binding shape (`{ type: "secret_ref", … }`) from `server/src/routes/environments.ts:50-58` and `secretService.create`. CLAUDE.md Rule #11: the only hosted key AoA *needs* is embeddings — this key is an optional CLI-auth convenience stored per-company-encrypted, NOT a new extraction key path. If `create` conflicts on re-entry (`Secret already exists`), catch and `rotate` instead (idempotent).

- [ ] **Step 5: Register, run, commit**

Run test (PASS), then:
```bash
git add ui/src/onboarding/steps/VerifyStep.tsx ui/src/onboarding/registry.ts server/src/routes/commander-verify.ts ui/src/onboarding/steps/__tests__/verify-step.test.tsx
git commit -m "feat(onboarding): Verify tooling step (COMMANDER_VERIFIED, blocking + install/auth help)"
```

---

## Task C9: Consolidate `DEPARTMENT_FUNCTION_TYPES` into `packages/shared`

**Files:**
- Modify: `packages/shared/src/constants.ts` (append per Stage 0 §3.3)
- Modify: `packages/shared/src/index.ts` (ensure the constant + type are exported)
- Modify: `ui/src/components/NewProjectDialog.tsx` (delete local `FUNCTION_TYPES` :50-61; import shared)
- Test: `packages/shared/src/__tests__/department-function-types.test.ts` (contract)

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/__tests__/department-function-types.test.ts
import { describe, it, expect } from "vitest";
import { DEPARTMENT_FUNCTION_TYPES } from "../constants.js";

describe("DEPARTMENT_FUNCTION_TYPES", () => {
  it("includes sales (new) and relabels support to Customer Support", () => {
    const byValue = Object.fromEntries(DEPARTMENT_FUNCTION_TYPES.map((t) => [t.value, t.label]));
    expect(byValue.sales).toBe("Sales");
    expect(byValue.support).toBe("Customer Support");
    expect(byValue.software_development).toBe("Product (Software)");
  });
  it("keeps software_development as the workspace-tooling gate value", () => {
    expect(DEPARTMENT_FUNCTION_TYPES.some((t) => t.value === "software_development")).toBe(true);
  });
});
```

- [ ] **Step 2: Run, verify FAIL** — `pnpm test:run src/__tests__/department-function-types.test.ts`

- [ ] **Step 3: Append the shared list (verbatim Stage 0 §3.3)**

```ts
// packages/shared/src/constants.ts (append)
export const DEPARTMENT_FUNCTION_TYPES = [
  { value: "software_development", label: "Product (Software)", icon: "💻" },
  { value: "marketing",           label: "Marketing",          icon: "📢" },
  { value: "sales",               label: "Sales",              icon: "🤝" }, // NEW
  { value: "support",             label: "Customer Support",   icon: "🎧" }, // relabeled
  { value: "finance",             label: "Finance",            icon: "💰" },
  { value: "hr",                  label: "HR",                 icon: "👥" },
  { value: "legal",               label: "Legal",              icon: "⚖️" },
  { value: "research",            label: "Research",           icon: "🔬" },
  { value: "operations",          label: "Operations",         icon: "📊" },
  { value: "general",             label: "General",            icon: "📋" },
  { value: "custom",              label: "Custom",             icon: "⚙️" },
] as const;
export type DepartmentFunctionType = (typeof DEPARTMENT_FUNCTION_TYPES)[number]["value"];
```

Confirm `packages/shared/src/index.ts` re-exports `constants.js` (it exports many `constants`-derived names). If `constants.ts` is exported via `export * from "./constants.js"`, no change; otherwise add the named export.

- [ ] **Step 4: Point `NewProjectDialog` at the shared list**

In `ui/src/components/NewProjectDialog.tsx`: delete the local `const FUNCTION_TYPES = [...] as const;` (:50-61) and add `import { DEPARTMENT_FUNCTION_TYPES } from "@armyofagents/shared";`. Replace the two `FUNCTION_TYPES.map(...)` usages (the picker at :402) with `DEPARTMENT_FUNCTION_TYPES.map(...)`. Field shape (`value`/`label`/`icon`) is identical, so the JSX is unchanged apart from the identifier.

- [ ] **Step 5: Run test + verify + commit**

Run: `pnpm test:run src/__tests__/department-function-types.test.ts` then `pnpm typecheck`
Expected: PASS; `NewProjectDialog` compiles with the shared list (now shows Sales + Customer Support).
```bash
git add packages/shared/src/constants.ts packages/shared/src/index.ts ui/src/components/NewProjectDialog.tsx packages/shared/src/__tests__/department-function-types.test.ts
git commit -m "feat(onboarding): consolidate DEPARTMENT_FUNCTION_TYPES in shared (add sales, relabel support)"
```

---

## Task C10: Step "First department" (`DEPARTMENT_CREATED`)

**Files:**
- Create: `ui/src/onboarding/steps/DepartmentStep.tsx`
- Modify: `ui/src/onboarding/registry.ts`
- Test: `ui/src/onboarding/steps/__tests__/department-step.test.tsx`

Consumes the shared `DEPARTMENT_FUNCTION_TYPES` (C9). Software → workspace source: **nested local folder default under `companies.rootFolder`, editable, OR GitHub repo** (both allowed) — reusing the path-nesting + validation logic from `NewProjectDialog.handleSubmit` (`NewProjectDialog.tsx:217-301`). Creates `projects` (type=department) via `projectsApi.create` + workspace via `projectsApi.createWorkspace`. Idempotent: guard by checking for an existing department with the same name in this company before creating.

- [ ] **Step 1: Write the failing test**

```tsx
// ui/src/onboarding/steps/__tests__/department-step.test.tsx
import { describe, it, expect } from "vitest";
import { departmentStep } from "../DepartmentStep";
import { DEPARTMENT_FUNCTION_TYPES } from "@armyofagents/shared";

describe("departmentStep", () => {
  it("satisfies DEPARTMENT_CREATED after COMMANDER_VERIFIED", () => {
    expect(departmentStep.state).toBe("DEPARTMENT_CREATED");
    expect(departmentStep.dependsOn).toEqual(["COMMANDER_VERIFIED"]);
  });
  it("uses the shared taxonomy (sales present)", () => {
    expect(DEPARTMENT_FUNCTION_TYPES.some((t) => t.value === "sales")).toBe(true);
  });
});
```

- [ ] **Step 2: Run, verify FAIL** — `pnpm --filter @armyofagents/ui test:run src/onboarding/steps/__tests__/department-step.test.tsx`

- [ ] **Step 3: Implement (type picker + nested-folder default + GitHub swap + idempotent create)**

```tsx
// ui/src/onboarding/steps/DepartmentStep.tsx
import { lazy, useEffect, useState } from "react";
import type { StepDefinition, StepProps } from "../registry";
import { DEPARTMENT_FUNCTION_TYPES } from "@armyofagents/shared";
import { projectsApi } from "../../api/projects";
import { companiesApi } from "../../api/companies";
import { filesystemApi } from "../../api/filesystem";

const REPO_ONLY_CWD_SENTINEL = "/__paperclip_repo_only__";

function DepartmentStepBody({ ctx, onComplete }: StepProps) {
  const [name, setName] = useState("");
  const [functionType, setFunctionType] = useState<string>("software_development");
  const [rootFolder, setRootFolder] = useState<string | null>(null);
  const [localPath, setLocalPath] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [useLocal, setUseLocal] = useState(true);
  const [useRepo, setUseRepo] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ctx.companyId) return;
    companiesApi.get(ctx.companyId).then((c) => setRootFolder(c.rootFolder ?? null)).catch(() => {});
  }, [ctx.companyId]);

  // Prefill nested folder under the company root: …/<root>/<slug>
  useEffect(() => {
    if (!rootFolder || !name.trim()) return;
    const sep = rootFolder.includes("\\") ? "\\" : "/";
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    setLocalPath(`${rootFolder}${sep}${slug}`);
  }, [rootFolder, name]);

  const isSoftware = functionType === "software_development";
  const isAbsolute = (v: string) => v.startsWith("/") || /^[A-Za-z]:[\\/]/.test(v);

  async function create() {
    if (!ctx.companyId || !name.trim()) return;
    setLoading(true); setError(null);
    try {
      // Idempotent guard: don't create a second department with the same name.
      const existing = await projectsApi.list(ctx.companyId).catch(() => []);
      let deptId = existing.find((p: any) => p.type === "department" && p.name === name.trim())?.id ?? null;

      if (!deptId) {
        const created = await projectsApi.create(ctx.companyId, {
          name: name.trim(),
          type: "department",
          status: "planned",
          functionType,
        });
        deptId = created.id;

        // Workspace source (software only in the happy path; folder default nested).
        if (isSoftware && (useLocal || useRepo)) {
          if (useLocal && !isAbsolute(localPath.trim())) throw new Error("Local folder must be an absolute path.");
          if (useLocal) { await filesystemApi.mkdir(localPath.trim()).catch(() => {}); }
          if (useLocal && useRepo) {
            await projectsApi.createWorkspace(deptId, { name: name.trim(), cwd: localPath.trim(), repoUrl: repoUrl.trim() });
          } else if (useLocal) {
            await projectsApi.createWorkspace(deptId, { name: name.trim(), cwd: localPath.trim() });
          } else if (useRepo) {
            await projectsApi.createWorkspace(deptId, { name: name.trim(), cwd: REPO_ONLY_CWD_SENTINEL, repoUrl: repoUrl.trim() });
          }
        }
      }
      onComplete();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create department");
    } finally { setLoading(false); }
  }

  return (
    <div className="space-y-5">
      <div>
        <h3 className="font-medium">Create your first department</h3>
        <p className="text-xs text-muted-foreground">Departments organize agents and work. Software departments can connect a local folder and/or a GitHub repo.</p>
      </div>
      <label className="text-xs text-muted-foreground block">Department name
        <input className="mt-1 w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm" value={name} onChange={(e) => setName(e.target.value)} placeholder="Engineering" autoFocus />
      </label>
      <div className="grid grid-cols-3 gap-2">
        {DEPARTMENT_FUNCTION_TYPES.map((t) => (
          <button key={t.value} type="button"
            className={`rounded-md border px-2 py-2 text-left text-xs ${functionType === t.value ? "border-foreground bg-accent" : "border-border hover:bg-accent/50"}`}
            onClick={() => setFunctionType(t.value)}>
            <span className="mr-1">{t.icon}</span>{t.label}
          </button>
        ))}
      </div>
      {isSoftware && (
        <div className="space-y-2 rounded-md border border-border p-3">
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={useLocal} onChange={(e) => setUseLocal(e.target.checked)} /> Local folder (nested under your root)</label>
          {useLocal && <input className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs font-mono" value={localPath} onChange={(e) => setLocalPath(e.target.value)} />}
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={useRepo} onChange={(e) => setUseRepo(e.target.checked)} /> GitHub repo</label>
          {useRepo && <input className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="https://github.com/org/repo" />}
        </div>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      <button className="rounded-md bg-foreground px-3 py-2 text-sm text-background disabled:opacity-50" disabled={loading || !name.trim()} onClick={create}>
        {loading ? "Creating…" : "Create department"}
      </button>
    </div>
  );
}

export const departmentStep: StepDefinition = {
  id: "department",
  state: "DEPARTMENT_CREATED",
  journeys: ["founder"],
  dependsOn: ["COMMANDER_VERIFIED"],
  canSkip: false,
  isComplete: (ctx) => ctx.completedStates.includes("DEPARTMENT_CREATED"),
  Component: lazy(() => Promise.resolve({ default: DepartmentStepBody })),
  title: "First department",
};
```

> Task author: confirm `projectsApi.list(companyId)` and `companiesApi.get(companyId)` exist (grep `ui/src/api/projects.ts`, `ui/src/api/companies.ts`). `projectsApi.create` and `projectsApi.createWorkspace` are confirmed present. The `REPO_ONLY_CWD_SENTINEL` mirrors `NewProjectDialog.tsx:48`.

- [ ] **Step 4: Register, run, commit**

Run test (PASS), then:
```bash
git add ui/src/onboarding/steps/DepartmentStep.tsx ui/src/onboarding/registry.ts ui/src/onboarding/steps/__tests__/department-step.test.tsx
git commit -m "feat(onboarding): First department step (DEPARTMENT_CREATED) with workspace source"
```

---

## Task C11: Step "First agent" (`AGENT_ASSIGNED`) — fix the dept-assignment gap

**Files:**
- Create: `ui/src/onboarding/steps/AgentStep.tsx`
- Modify: `ui/src/onboarding/registry.ts`
- Test: `ui/src/onboarding/steps/__tests__/agent-step.test.tsx`

Ports wizard Step 5 agent-create (`OnboardingWizard.tsx:509-590`) but: adapter **inherits the Commander runtime** (resolve the Commander's cliTool → adapter type; no adapter picker in the happy path), department **preselected and assigned at creation** via `projectsApi.assignAgent(deptId, agentId)` (fixes today's gap — the wizard never assigns the agent to a project), purpose prefilled, advanced settings collapsed. Idempotent: existence-guard on agent name in the company.

- [ ] **Step 1: Write the failing test**

```tsx
// ui/src/onboarding/steps/__tests__/agent-step.test.tsx
import { describe, it, expect } from "vitest";
import { agentStep } from "../AgentStep";

describe("agentStep", () => {
  it("satisfies AGENT_ASSIGNED after DEPARTMENT_CREATED", () => {
    expect(agentStep.state).toBe("AGENT_ASSIGNED");
    expect(agentStep.dependsOn).toEqual(["DEPARTMENT_CREATED"]);
  });
});
```

- [ ] **Step 2: Run, verify FAIL** — `pnpm --filter @armyofagents/ui test:run src/onboarding/steps/__tests__/agent-step.test.tsx`

- [ ] **Step 3: Implement (inherit Commander runtime, assign at creation, advanced collapsed)**

```tsx
// ui/src/onboarding/steps/AgentStep.tsx
import { lazy, useEffect, useState } from "react";
import type { StepDefinition, StepProps } from "../registry";
import { agentsApi } from "../../api/agents";
import { projectsApi } from "../../api/projects";
import { internalAgentApi } from "../../api/internal-agent";

// Commander cliTool → agent adapter type (mirror server cliToolToAdapterType).
function cliToolToAdapterType(cliTool: string | null | undefined): string {
  if (cliTool === "codex") return "codex_local";
  if (cliTool === "opencode") return "opencode_local";
  return "claude_local";
}

function AgentStepBody({ ctx, onComplete }: StepProps) {
  const [name, setName] = useState("Director");
  const [purpose, setPurpose] = useState("Coordinate work in this department and hire the team as needed.");
  const [adapterType, setAdapterType] = useState<string>("claude_local");
  const [deptId, setDeptId] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ctx.companyId) return;
    // Inherit runtime from Commander config.
    internalAgentApi.getConfig(ctx.companyId).then((cfg: any) => setAdapterType(cliToolToAdapterType(cfg?.cliTool))).catch(() => {});
    // Preselect the department created in the previous step (first department).
    projectsApi.list(ctx.companyId).then((ps: any[]) => {
      const dept = ps.find((p) => p.type === "department");
      if (dept) setDeptId(dept.id);
    }).catch(() => {});
  }, [ctx.companyId]);

  async function create() {
    if (!ctx.companyId || !name.trim() || !deptId) return;
    setLoading(true); setError(null);
    try {
      // Idempotent guard: reuse an existing same-named org agent if present.
      const existing = await agentsApi.list(ctx.companyId).catch(() => []);
      let agentId = existing.find((a: any) => a.kind === "org" && a.name === name.trim())?.id ?? null;

      if (!agentId) {
        const agent = await agentsApi.create(ctx.companyId, {
          name: name.trim(),
          role: "cxo",
          capabilities: purpose.trim() || undefined,
          adapterType,                 // inherits Commander runtime
          adapterConfig: {},
          runtimeConfig: { heartbeat: { enabled: true, intervalSec: 3600, wakeOnDemand: true, cooldownSec: 10, maxConcurrentRuns: 1 } },
        });
        agentId = agent.id;
      }
      // FIX: assign the agent to the department AT creation (wizard never did this).
      await projectsApi.assignAgent(deptId, agentId, ctx.companyId);
      onComplete();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create agent");
    } finally { setLoading(false); }
  }

  return (
    <div className="space-y-5">
      <div>
        <h3 className="font-medium">Create your first agent</h3>
        <p className="text-xs text-muted-foreground">It runs on your Commander runtime and is assigned to your department automatically.</p>
      </div>
      <label className="text-xs text-muted-foreground block">Agent name
        <input className="mt-1 w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </label>
      <label className="text-xs text-muted-foreground block">Purpose
        <textarea className="mt-1 w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm" value={purpose} onChange={(e) => setPurpose(e.target.value)} />
      </label>
      <button type="button" className="text-xs text-muted-foreground underline" onClick={() => setShowAdvanced((v) => !v)}>
        {showAdvanced ? "Hide" : "Show"} advanced settings
      </button>
      {showAdvanced && (
        <div className="rounded-md border border-border p-3 text-xs text-muted-foreground">
          Heartbeat, crawl, context mode, retry, and permissions default to the recommended settings and can be tuned later in the Agent page. Runtime is inherited from Commander ({adapterType}).
        </div>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      <button className="rounded-md bg-foreground px-3 py-2 text-sm text-background disabled:opacity-50" disabled={loading || !name.trim() || !deptId} onClick={create}>
        {loading ? "Creating…" : "Create & assign"}
      </button>
    </div>
  );
}

export const agentStep: StepDefinition = {
  id: "agent",
  state: "AGENT_ASSIGNED",
  journeys: ["founder"],
  dependsOn: ["DEPARTMENT_CREATED"],
  canSkip: false,
  isComplete: (ctx) => ctx.completedStates.includes("AGENT_ASSIGNED"),
  Component: lazy(() => Promise.resolve({ default: AgentStepBody })),
  title: "First agent",
};
```

> Task author: confirm `agentsApi.list`, `agentsApi.create`, and `internalAgentApi.getConfig` client methods (grep `ui/src/api/agents.ts`, `ui/src/api/internal-agent.ts` — `updateConfig` is confirmed at :331; a `getConfig` GET exists server-side at `…/internal-agent/config`). `projectsApi.assignAgent(projectId, agentId, companyId?)` is confirmed (`ui/src/api/projects.ts:39`) and hits `POST /projects/:id/agents` (`server/src/routes/projects.ts:466`, upsert `onConflictDoNothing` → idempotent).

- [ ] **Step 4: Register, run, commit**

Run test (PASS), then:
```bash
git add ui/src/onboarding/steps/AgentStep.tsx ui/src/onboarding/registry.ts ui/src/onboarding/steps/__tests__/agent-step.test.tsx
git commit -m "feat(onboarding): First agent step (AGENT_ASSIGNED) — assign to department at creation"
```

---

## Task C12: Step "Review" (`SETUP_COMPLETE`)

**Files:**
- Create: `ui/src/onboarding/steps/ReviewStep.tsx`
- Modify: `ui/src/onboarding/registry.ts`
- Test: `ui/src/onboarding/steps/__tests__/review-step.test.tsx`

Summary table (org / environment / commander+status / department+workspace / agent+assignment) with **"Start walkthrough"** (Phase 2 stub — reserves the transition to `WALKTHROUGH_STARTED`, gated OFF in Phase 1) and **"Go to dashboard"**. Both write `SETUP_COMPLETE` via `onComplete()` (Stage B service dedupes the state append → idempotent).

- [ ] **Step 1: Write the failing test**

```tsx
// ui/src/onboarding/steps/__tests__/review-step.test.tsx
import { describe, it, expect } from "vitest";
import { reviewStep } from "../ReviewStep";

describe("reviewStep", () => {
  it("satisfies SETUP_COMPLETE after AGENT_ASSIGNED", () => {
    expect(reviewStep.state).toBe("SETUP_COMPLETE");
    expect(reviewStep.dependsOn).toEqual(["AGENT_ASSIGNED"]);
  });
});
```

- [ ] **Step 2: Run, verify FAIL** — `pnpm --filter @armyofagents/ui test:run src/onboarding/steps/__tests__/review-step.test.tsx`

- [ ] **Step 3: Implement (summary + two finish actions)**

```tsx
// ui/src/onboarding/steps/ReviewStep.tsx
import { lazy, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { StepDefinition, StepProps } from "../registry";
import { companiesApi } from "../../api/companies";
import { projectsApi } from "../../api/projects";
import { agentsApi } from "../../api/agents";

function ReviewStepBody({ ctx, onComplete }: StepProps) {
  const navigate = useNavigate();
  const [summary, setSummary] = useState<{ org?: string; dept?: string; agent?: string; prefix?: string }>({});

  useEffect(() => {
    if (!ctx.companyId) return;
    (async () => {
      const [c, projects, agents] = await Promise.all([
        companiesApi.get(ctx.companyId!).catch(() => null),
        projectsApi.list(ctx.companyId!).catch(() => []),
        agentsApi.list(ctx.companyId!).catch(() => []),
      ]);
      setSummary({
        org: c?.name, prefix: c?.issuePrefix,
        dept: (projects as any[]).find((p) => p.type === "department")?.name,
        agent: (agents as any[]).find((a) => a.kind === "org")?.name,
      });
    })();
  }, [ctx.companyId]);

  function finish(startWalkthrough: boolean) {
    onComplete(); // writes SETUP_COMPLETE (idempotent)
    if (startWalkthrough) {
      navigate("/onboarding/walkthrough"); // Phase 2 stub route
    } else if (summary.prefix) {
      navigate(`/${summary.prefix}/home`);
    } else {
      navigate("/home");
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h3 className="font-medium">You’re set up</h3>
        <p className="text-xs text-muted-foreground">Review your workspace, then dive in.</p>
      </div>
      <div className="border border-border divide-y divide-border text-sm">
        <Row label="Organization" value={summary.org} />
        <Row label="Environment" value="Local machine — verified" />
        <Row label="Commander" value="Configured & verified" />
        <Row label="Department" value={summary.dept} />
        <Row label="Agent" value={summary.agent ? `${summary.agent} → ${summary.dept ?? "department"}` : undefined} />
      </div>
      <div className="flex gap-2">
        <button className="rounded-md border border-border px-3 py-2 text-sm" onClick={() => finish(true)}>Start walkthrough</button>
        <button className="rounded-md bg-foreground px-3 py-2 text-sm text-background" onClick={() => finish(false)}>Go to dashboard</button>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value?: string }) {
  return (
    <div className="flex items-center justify-between px-3 py-2.5">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value ?? "—"}</span>
    </div>
  );
}

export const reviewStep: StepDefinition = {
  id: "review",
  state: "SETUP_COMPLETE",
  journeys: ["founder"],
  dependsOn: ["AGENT_ASSIGNED"],
  canSkip: false,
  isComplete: (ctx) => ctx.completedStates.includes("SETUP_COMPLETE"),
  Component: lazy(() => Promise.resolve({ default: ReviewStepBody })),
  title: "Review",
};
```

> Task author: `/onboarding/walkthrough` is a Phase-2 reserved route — confirm Stage B/D stubs it (or render a "coming soon" placeholder). Do not implement the walkthrough here (scope §12 Phase 2).

- [ ] **Step 4: Register, run, commit**

Run test (PASS), then:
```bash
git add ui/src/onboarding/steps/ReviewStep.tsx ui/src/onboarding/registry.ts ui/src/onboarding/steps/__tests__/review-step.test.tsx
git commit -m "feat(onboarding): Review step (SETUP_COMPLETE)"
```

---

## Task C13: Delete `OnboardingWizard` + repoint mounts to the FlowEngine

**Files:**
- Delete: `ui/src/components/OnboardingWizard.tsx`
- Modify: `ui/src/App.tsx` (remove `OnboardingWizard` lazy import :60-61, `OnboardingWizardMount` :307-309, and its render :378; repoint `NoCompaniesStartPage` / Lobby "New Company" to the FlowEngine route)
- Modify: `ui/src/context/DialogContext.tsx` (retire the onboarding-dialog surface — `OnboardingOptions`, `onboardingOpen`, `openOnboarding` :19-22,:59-61,:83-84,:128-135,:176-178)
- Test: `ui/src/__tests__/onboarding-entrypoint.test.tsx`

The dialog-based wizard is replaced by the Stage B FlowEngine mounted at the `/onboarding` route (Stage A stubbed `/onboarding`; Stage B fills it). "New Company" / first-run entry now **navigates** to `/onboarding` (org-layer replay) instead of opening a modal.

- [ ] **Step 1: Write the failing test**

```tsx
// ui/src/__tests__/onboarding-entrypoint.test.tsx
import { describe, it, expect } from "vitest";
import * as App from "../App";

describe("onboarding entrypoint", () => {
  it("no longer references the OnboardingWizard component", () => {
    // The wizard export must be gone; the FlowEngine route is the entrypoint.
    expect((App as any).OnboardingWizard).toBeUndefined();
  });
});
```

> A stronger check: assert `openOnboarding` is no longer exported from `DialogContext`. Prefer whichever import the repo's existing tests can reach without a full render.

- [ ] **Step 2: Run, verify FAIL** — `pnpm --filter @armyofagents/ui test:run src/__tests__/onboarding-entrypoint.test.tsx`
Expected: FAIL while the wizard/mount still exist.

- [ ] **Step 3: Remove the wizard + mount, repoint entry**

1. `rm ui/src/components/OnboardingWizard.tsx`.
2. In `ui/src/App.tsx`: delete the `OnboardingWizard` lazy import (:60-61), the `OnboardingWizardMount` function (:307-309), and its `<OnboardingWizardMount />` render (:378). In `CompanyRootRedirect` (:221-240) drop the `onboardingOpen` special-case and route a no-company user to `/onboarding`. In `NoCompaniesStartPage` (:263-287) change the button + auto-open to `navigate("/onboarding")` instead of `openOnboarding()`.
3. In `ui/src/context/DialogContext.tsx`: remove `OnboardingOptions`, `onboardingOpen`, `onboardingOptions`, `openOnboarding`, `closeOnboarding` and their state/provider wiring. Grep for remaining consumers first: `grep -rn "openOnboarding\|onboardingOpen\|closeOnboarding\|onboardingOptions" ui/src` — repoint every caller (Lobby "New Company", any Settings/empty-state CTA) to `useNavigate()("/onboarding")`.

> Task author: `OnboardingWizard` imports many modules (goals/issues/agents APIs, adapter UI helpers). Deleting it may make some imports unused elsewhere — run `pnpm typecheck` and clean up any now-dead exports it was the sole consumer of. Confirm the `/onboarding` route renders the Stage B FlowEngine (Stage A stubbed the route; Stage B mounts the engine) before removing the modal, so there is never a window with no onboarding entrypoint.

- [ ] **Step 4: Run test + full UI typecheck, verify pass**

Run: `pnpm --filter @armyofagents/ui test:run src/__tests__/onboarding-entrypoint.test.tsx` then `pnpm typecheck`
Expected: PASS; no unused-import / missing-symbol errors.

- [ ] **Step 5: Commit**

```bash
git add ui/src/App.tsx ui/src/context/DialogContext.tsx ui/src/__tests__/onboarding-entrypoint.test.tsx
git rm ui/src/components/OnboardingWizard.tsx
git commit -m "feat(onboarding): delete OnboardingWizard modal; route onboarding through FlowEngine"
```

---

## Stage C self-review checklist (run before handing off)

- [ ] **Scope → task mapping (all 10 prompt items covered):**
  1. `user_profiles` table + service + guarded seed → **C1, C2**
  2. Step "Your profile" (`PROFILE_SET`) → **C3**
  3. Step "Create organization" (`ORGANIZATION_CREATED`, name-only, mission removed) → **C4**
  4. Step "Set up environment" (`ENVIRONMENT_READY`, blocking probe) → **C5**
  5. Step "Choose Commander" (`COMMANDER_SELECTED`, cards) → **C6**
  6. Step "Verify tooling" (`COMMANDER_VERIFIED`, blocking + install/auth help + API-key secret) → **C7, C8**
  7. Consolidate `DEPARTMENT_FUNCTION_TYPES` + Step "First department" (`DEPARTMENT_CREATED`) → **C9, C10**
  8. Step "First agent" (`AGENT_ASSIGNED`, dept-assigned at creation) → **C11**
  9. Step "Review" (`SETUP_COMPLETE`) → **C12**
  10. Delete wizard + repoint mount → **C13**
- [ ] **Placeholder scan:** every `> Task author:` note is a *verification pointer* (adapter-registry lookup name, per-company secret provider enum/env-binding shape, `api` client method names, Stage B registry-array export shape, engine companyId refetch, `/onboarding/walkthrough` stub) — resolve during execution, never leave a `TODO` in shipped code. The **one exception** is the deliberate guarded no-op `seedCompanyUserProfile` (C2), which is flagged for the reconciler as a real missing-table discrepancy, not a code placeholder.
- [ ] **Type consistency vs Stage 0:** `user_profiles` columns match §2.1 exactly (`userId` text PK, `socialLinks` jsonb default `[]`); `OnboardingState` values used verbatim (`PROFILE_SET`…`SETUP_COMPLETE`, §3.1); `DEPARTMENT_FUNCTION_TYPES` verbatim incl `sales` + "Customer Support" (§3.3); every step object conforms to `StepDefinition` and every body to `StepProps` (§4 — `onComplete: () => void`, `onBack`).
- [ ] **Type consistency vs Stage B registry:** steps import `StepDefinition`/`StepProps`/`StepContext` from `ui/src/onboarding/registry.ts`; `dependsOn` chains are contiguous over `FOUNDER_PHASE1_STATES`; `isComplete` predicates read only `ctx.completedStates`/`ctx.companyId` (idempotent re-entry).
- [ ] **Idempotency + blocking:** org-create existence-guard (C4), env upsert-by-name (C5), commander config PATCH-in-place (C6), agent existence-guard + `assignAgent` onConflictDoNothing (C11); environment probe (C5) and commander verify (C7/C8) return 422 → UI stays on step (no silent failure).
- [ ] **Full UI + server suites green** after C13 (the wizard deletion is the highest-fallout task — run `pnpm typecheck` + both `test` filters).

---

## Risks & inconsistencies for the reconciler

1. **`company_user_profiles` does not exist** (Pre-flight + C2) — Stage 0 §2.1 / scope §6 / CLAUDE.md all assume it; the seed is a documented no-op until the table is added or the projection is descoped.
2. **`StepProps.onComplete` carries no `companyId`** (C4) — the org-create → later-steps handoff relies on the Stage B FlowEngine re-reading `StepContext` from server state after `onComplete`. Confirm Stage B does this; otherwise it's an integration gap.
3. **The `local` environment probe was a no-op pass** (C5) — Stage 0 says "verify read/write via existing `probeEnvironmentConfig`," but the existing function never touched the filesystem. C5 adds the real write-probe to satisfy the blocking requirement; note this widens `probeEnvironmentConfig`'s local behavior (back-compat kept when no `path` is supplied).
4. **Additive route files not in Stage 0 §6:** `server/src/routes/user-profiles.ts`, `onboarding-environment.ts`, `commander-verify.ts`, and `ui/src/api/user-profiles.ts` — required by the steps, consistent with existing route/client patterns.
