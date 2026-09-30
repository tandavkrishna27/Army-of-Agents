# AoA Multi-Tenant Cloud — Phase 2: Signup → Organization Journey, Org Roles, Operator/Owner Separation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn AoA's single-tenant "first Google user becomes the global instance admin" model into a hosted multi-tenant signup flow where any signed-in user self-serves an **Organization** (tenant), becomes its **owner**, and creates Companies under it — while fully disabling every runtime `instance_admin` promotion path in the new `cloud_auth` mode and preserving self-hosted `local_trusted`/`authenticated` behavior unchanged.

**Architecture:** Add a third deployment mode `cloud_auth`. Introduce an org-level RBAC layer (`organization_memberships` with roles `owner|admin|member|billing`) that sits *above* the unchanged per-company RBAC (`user_roles`, `company_memberships.membershipRole`). A single chokepoint `instanceAdminBootstrapEnabled(mode)` gates all four `instance_admin` promotion sites (both better-auth hooks, `bootstrap_ceo` invite, board-claim) and returns `false` for `cloud_auth`. The company-create authorization gate is swapped from `isInstanceAdmin` to org-owner/admin scoped to a server-derived `organization_id`, and that swap lands in the **same commit** as the hook gating so a fresh `cloud_auth` instance can never lock everyone out.

**Tech Stack:** TypeScript, Drizzle ORM (Postgres), Express 5, better-auth (Google OAuth), Vitest, React + Vite. Contract-sync across `packages/db` → `packages/shared` → `server` → `ui`.

---

## Prerequisites (Phase 1 — DO NOT duplicate here)

Phase 1 **owns** and must be present on this branch before Phase 2 tasks run. **Phase 2 generates NO migration and creates NONE of these — it CONSUMES them:**

- `organizations` table (`packages/db/src/schema/organizations.ts`) + its `packages/db/src/schema/index.ts` export.
- **`organization_memberships` table** — created by P1's `0188` migration, which ALSO backfills `owner` memberships. Phase 2 imports `organizationMemberships` from `@armyofagents/db`; it does **not** define the schema file, does **not** add the `index.ts` export, and does **not** run `pnpm db:generate` (items 1).
- `companies.organizationId` column (`organization_id uuid → organizations.id`) — the tenant pointer on every company.
- `DEPLOYMENT_MODES` including `"cloud_auth"` (`packages/shared/src/constants.ts`) — the CONSTANT is P1's (item 4). Phase 2 owns only the `config-schema.ts` `cloud_auth` validation.
- `ORGANIZATION_ROLES` (`owner|admin|member|billing`) constant + `OrganizationRole` type in `@armyofagents/shared` — P1's (item 15). Phase 2 imports it, does not redefine it.
- `services/organizations.ts` — P1 creates this file with the factory (`organizationService`), `ensureDefaultOrganization`, `DEFAULT_ORGANIZATION_ID`, and slug helpers. Phase 2 EXTENDS it (adds `createSelfServeOrganization`), does not create a second file (item 6).
- The **default-Organization creation + membership backfill migration** for existing single-tenant installs (P1's `0188`). **Phase 2 adds NO backfill.**

If any of the above (esp. `companies.organizationId`, `organizations`, `organization_memberships`, `cloud_auth` in `DEPLOYMENT_MODES`, `ORGANIZATION_ROLES`, `services/organizations.ts`) is absent, Tasks 0, 5, 6, 9, 10 will not compile — stop and rebase Phase 1 in first.

Verify before starting:

```bash
grep -R "organization_id" packages/db/src/schema/companies.ts        # expect a match
ls packages/db/src/schema/organizations.ts                            # expect the file
ls packages/db/src/schema/organization_memberships.ts                 # expect the P1 file
grep -R "cloud_auth" packages/shared/src/constants.ts                 # expect a match (P1's constant)
grep -R "ORGANIZATION_ROLES" packages/shared/src/constants.ts         # expect a match (P1's constant)
grep -R "DEFAULT_ORGANIZATION_ID\|ensureDefaultOrganization" server/src/services/organizations.ts  # expect P1's factory
```

---

## Existing patterns this plan follows (cite before you copy)

- **Service shape:** `server/src/services/access.ts:42` (`accessService(db)` returns a bag of async fns). New `organizationAccessService` mirrors it.
- **Route shape:** `server/src/routes/goals.ts` (per project conventions) + the create-gate idiom at `server/src/routes/companies.ts:146-151`.
- **Membership/role writes:** `access.ensureMembership` (`server/src/services/access.ts:243-275`) and `ensureRealOperator` (`:277-305`).
- **Bootstrap test double:** `server/src/__tests__/first-user-bootstrap.test.ts` (fake-`db` transaction stub — reuse verbatim).
- **Journey resolver:** pure fn `resolvePostAuthJourney` (`server/src/services/post-auth-journey.ts:24-49`) + DB adapter `getJourneyForUser` (`server/src/routes/onboarding-journey.ts:40-203`).
- **Deployment-mode gating idiom:** `deploymentMode === "local_trusted"` is the *permissive* branch everywhere; every other value gets the strict path (`server/src/auth/better-auth.ts:77`, `server/src/middleware/auth.ts:34`, helmet). `cloud_auth` therefore inherits strict security defaults for free — Task 10 adds a regression test locking that in.
- **Onboarding state machine:** `packages/shared/src/onboarding.ts:16-72`, advanced by `server/src/services/onboarding.ts:140` (`advanceState`).

**Commands** (run from repo root `C:\Users\TK\.aoa\wt\mt-cloud`):
- Server tests: `pnpm --filter @armyofagents/server test -- <path>`
- Shared tests: `pnpm --filter @armyofagents/shared test -- <path>`
- UI tests: `pnpm --filter @armyofagents/ui test -- <path>`
- Migrations: **Phase 2 generates NO migration** — the `organizations` + `organization_memberships` DDL is Phase 1's (its `0188`). Do NOT run `pnpm db:generate` in any Phase 2 task.
- Windows CI skips `*.integration.test.ts` + e2e — keep lockout/isolation assertions in plain `*.test.ts` where possible.

---

## Task 0: `cloud_auth` config-schema validation (Phase 2 owns validation; Phase 1 owns the CONSTANT)

> **Cross-phase (item 4):** the `DEPLOYMENT_MODES` constant (with `"cloud_auth"`) is **Phase 1's** — Phase 2 CONSUMES it and does NOT re-add it. Phase 3 is deleting its own duplicate. Phase 2 **owns all `config-schema.ts` `cloud_auth` validation** (the superRefine below) — keep it. If P1 has not yet added `"cloud_auth"` to `DEPLOYMENT_MODES`, that is a prerequisite blocker (see Prerequisites), not a Phase 2 edit.

**Files:**
- Modify: `packages/shared/src/config-schema.ts:47`, `:127-162` (validation only)
- Test: `packages/shared/src/__tests__/config-schema-cloud-auth.test.ts`
- Modify (docs): `docs/deploy/deployment-modes.md`

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/__tests__/config-schema-cloud-auth.test.ts
import { describe, it, expect } from "vitest";
import { DEPLOYMENT_MODES } from "../constants.js";
import { paperclipConfigSchema } from "../config-schema.js";

const base = {
  $meta: { version: 1 },
  database: { mode: "postgres", url: "postgres://x" },
  logging: { mode: "file", logDir: "/tmp" },
  storage: undefined,
  secrets: undefined,
} as any;

describe("cloud_auth deployment mode", () => {
  it("is a member of DEPLOYMENT_MODES (owned by Phase 1 — this asserts the prerequisite is present)", () => {
    expect(DEPLOYMENT_MODES).toContain("cloud_auth");
  });

  it("requires public exposure + explicit base URL", () => {
    const bad = paperclipConfigSchema.safeParse({
      ...base,
      server: { deploymentMode: "cloud_auth", exposure: "private", host: "0.0.0.0", port: 3101, allowedHostnames: [], serveUi: true },
      auth: { baseUrlMode: "auto" },
    });
    expect(bad.success).toBe(false);

    const good = paperclipConfigSchema.safeParse({
      ...base,
      server: { deploymentMode: "cloud_auth", exposure: "public", host: "0.0.0.0", port: 3101, allowedHostnames: [], serveUi: true },
      auth: { baseUrlMode: "explicit", publicBaseUrl: "https://app.example.com" },
    });
    expect(good.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/shared test -- config-schema-cloud-auth`
Expected: FAIL — the `cloud_auth` exposure superRefine does not exist yet (the `DEPLOYMENT_MODES.contains` sub-case should already PASS once P1 has landed the constant).

- [ ] **Step 3: Write minimal implementation (validation only — do NOT touch `constants.ts`; the constant is P1's)**

```ts
// packages/shared/src/config-schema.ts — inside the .superRefine block, AFTER the
// local_trusted early-return (currently ends ~:137) and BEFORE the existing
// exposure==="public" checks. cloud_auth forces public + explicit base URL, then
// the existing public checks (:147-161) apply unchanged.
    if (value.server.deploymentMode === "cloud_auth" && value.server.exposure !== "public") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "server.exposure must be public when deploymentMode is cloud_auth",
        path: ["server", "exposure"],
      });
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/shared test -- config-schema-cloud-auth`
Expected: PASS

- [ ] **Step 5: Update docs**

Append a `## cloud_auth` section to `docs/deploy/deployment-modes.md` stating: hosted beta mode; login required (Google); all four `instance_admin` promotion paths disabled; self-serve Organizations enabled; `instance_admin` provisioned out-of-band only (break-glass); board-claim not available.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/config-schema.ts packages/shared/src/__tests__/config-schema-cloud-auth.test.ts docs/deploy/deployment-modes.md
git commit -m "feat(mt): cloud_auth config-schema validation (consumes P1 constant)"
```

---

## Task 1: CONSUME Phase 1's `organization_memberships` table + `ORGANIZATION_ROLES` (no schema, no migration)

> **Cross-phase (items 1 + 15):** Phase 1's `0188` migration OWNS the `organization_memberships` table AND the `owner`-membership backfill; Phase 1 also owns the `ORGANIZATION_ROLES` constant. **Phase 2 creates NO schema file, adds NO `schema/index.ts` export, runs NO `pnpm db:generate`, and defines NO role constant.** This task is a *consumption guard* — a compile-time smoke test proving the P1 table + constant are importable, so downstream tasks (5, 6, 9, 10, 11) fail loudly here rather than mid-implementation if P1 is not yet rebased in.

**Files:**
- Test only: `server/src/__tests__/p1-org-contract-present.test.ts`

- [ ] **Step 1: Write the failing test (consumption smoke test)**

```ts
// server/src/__tests__/p1-org-contract-present.test.ts
import { describe, it, expect } from "vitest";
import { organizationMemberships } from "@armyofagents/db";
import { ORGANIZATION_ROLES } from "@armyofagents/shared";

describe("Phase 1 org contract is present (Phase 2 consumes it)", () => {
  it("organization_memberships table is importable from @armyofagents/db", () => {
    expect(organizationMemberships).toBeDefined();
  });
  it("ORGANIZATION_ROLES is exactly owner/admin/member/billing (P1-owned)", () => {
    expect([...ORGANIZATION_ROLES]).toEqual(["owner", "admin", "member", "billing"]);
  });
});
```

- [ ] **Step 2: Run test**

Run: `pnpm --filter @armyofagents/server test -- p1-org-contract-present`
Expected: PASS if Phase 1 is rebased in. If it FAILS to import, STOP — Phase 1 is not present; rebase it before continuing (see Prerequisites). **Do not "fix" this by creating the table in Phase 2.**

- [ ] **Step 3: Commit**

```bash
git add server/src/__tests__/p1-org-contract-present.test.ts
git commit -m "test(mt): assert Phase 1 org_memberships + role constant are present"
```

---

## Task 2: Rename onboarding company state ORGANIZATION_CREATED → COMPANY_CREATED (with legacy alias)

**Files:**
- Modify: `packages/shared/src/onboarding.ts:16-59`
- Create: `packages/shared/src/__tests__/onboarding-company-state.test.ts`
- Modify: `server/src/services/onboarding.ts` (normalize legacy state on read)
- Test: `server/src/__tests__/onboarding-legacy-state-normalize.test.ts`

- [ ] **Step 1: Write the failing test (shared)**

```ts
// packages/shared/src/__tests__/onboarding-company-state.test.ts
import { describe, it, expect } from "vitest";
import { ONBOARDING_STATES, FOUNDER_PHASE1_STATES, normalizeLegacyOnboardingState } from "../onboarding.js";

describe("company-created onboarding state", () => {
  it("uses COMPANY_CREATED in the founder sequence", () => {
    expect(FOUNDER_PHASE1_STATES).toContain("COMPANY_CREATED");
  });
  it("keeps ORGANIZATION_CREATED valid for legacy rows", () => {
    expect(ONBOARDING_STATES).toContain("ORGANIZATION_CREATED");
    expect(ONBOARDING_STATES).toContain("COMPANY_CREATED");
  });
  it("normalizes the legacy alias", () => {
    expect(normalizeLegacyOnboardingState("ORGANIZATION_CREATED")).toBe("COMPANY_CREATED");
    expect(normalizeLegacyOnboardingState("PROFILE_SET")).toBe("PROFILE_SET");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/shared test -- onboarding-company-state`
Expected: FAIL — `COMPANY_CREATED` / `normalizeLegacyOnboardingState` not defined.

- [ ] **Step 3: Write minimal implementation (shared)**

```ts
// packages/shared/src/onboarding.ts
// (1) ADD "COMPANY_CREATED" to ONBOARDING_STATES (:16-37) immediately after
//     "ORGANIZATION_CREATED" — KEEP ORGANIZATION_CREATED for legacy rows.
// (2) Replace "ORGANIZATION_CREATED" with "COMPANY_CREATED" in FOUNDER_PHASE1_STATES (:51-59).
// (3) Append the normalizer:
export function normalizeLegacyOnboardingState(state: OnboardingState): OnboardingState {
  return state === "ORGANIZATION_CREATED" ? "COMPANY_CREATED" : state;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/shared test -- onboarding-company-state`
Expected: PASS

- [ ] **Step 5: Write the failing test (server normalize)**

```ts
// server/src/__tests__/onboarding-legacy-state-normalize.test.ts
import { describe, it, expect } from "vitest";
import { normalizeProgressRow } from "../services/onboarding.js";

describe("normalizeProgressRow", () => {
  it("maps legacy ORGANIZATION_CREATED to COMPANY_CREATED on read", () => {
    const row = normalizeProgressRow({
      currentState: "ORGANIZATION_CREATED",
      completedStates: ["AUTHENTICATED", "PROFILE_SET", "ORGANIZATION_CREATED"],
    } as any);
    expect(row.currentState).toBe("COMPANY_CREATED");
    expect(row.completedStates).toContain("COMPANY_CREATED");
    expect(row.completedStates).not.toContain("ORGANIZATION_CREATED");
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/server test -- onboarding-legacy-state-normalize`
Expected: FAIL — `normalizeProgressRow` not exported.

- [ ] **Step 7: Implement + wire the normalizer**

```ts
// server/src/services/onboarding.ts (add + call inside ensureProgress and advanceState
// right after the row is loaded, before computeAdvance at :156)
import { normalizeLegacyOnboardingState } from "@armyofagents/shared";

export function normalizeProgressRow<T extends { currentState: any; completedStates: any[] }>(row: T): T {
  return {
    ...row,
    currentState: normalizeLegacyOnboardingState(row.currentState),
    completedStates: Array.from(
      new Set((row.completedStates ?? []).map((s: any) => normalizeLegacyOnboardingState(s))),
    ),
  };
}
```

Call `normalizeProgressRow(row)` on the loaded row before it is compared/returned (in `ensureProgress` return and in `advanceState` at `:155-156`).

- [ ] **Step 8: Run tests to verify they pass**

Run: `pnpm --filter @armyofagents/server test -- onboarding-legacy-state-normalize`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add packages/shared/src/onboarding.ts packages/shared/src/__tests__/onboarding-company-state.test.ts server/src/services/onboarding.ts server/src/__tests__/onboarding-legacy-state-normalize.test.ts
git commit -m "feat(mt): rename onboarding ORGANIZATION_CREATED->COMPANY_CREATED with legacy alias"
```

---

## Task 3: UI copy — company step says "Company", new Create-Organization step

**Files:**
- Modify: `ui/src/onboarding/steps/OrgStep.tsx:75,94,111,119,141,144,149` (copy + requested state)
- Create: `ui/src/onboarding/steps/CreateOrganizationStep.tsx`
- Modify: `ui/src/onboarding/steps/index.ts` (register the new step)
- Modify: `ui/src/api/organizations.ts` (created in Task 6 — import here)
- Test: `ui/src/onboarding/steps/__tests__/CreateOrganizationStep.test.tsx`

> Depends on Task 6's `POST /organizations` client. If executing strictly in order, do Task 6 first; this task only needs the `organizationsApi.create` signature `{ name: string } -> { id: string }`.

- [ ] **Step 1: Write the failing test**

```tsx
// ui/src/onboarding/steps/__tests__/CreateOrganizationStep.test.tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { CreateOrganizationStep } from "../CreateOrganizationStep";

const createOrg = vi.fn(async (_: { name: string }) => ({ id: "org1", name: "Acme" }));
vi.mock("../../../api/organizations", () => ({ organizationsApi: { create: (a: any) => createOrg(a) } }));

describe("CreateOrganizationStep", () => {
  it("creates an organization and advances", async () => {
    const onComplete = vi.fn();
    render(<CreateOrganizationStep ctx={{ userId: "u1", journey: "founder", companyId: null } as any} onComplete={onComplete} />);
    fireEvent.change(screen.getByLabelText(/organization name/i), { target: { value: "Acme" } });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    await waitFor(() => expect(createOrg).toHaveBeenCalledWith({ name: "Acme" }));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/ui test -- CreateOrganizationStep`
Expected: FAIL — module `../CreateOrganizationStep` not found.

- [ ] **Step 3: Write minimal implementation**

```tsx
// ui/src/onboarding/steps/CreateOrganizationStep.tsx
// Structure mirrors OrgStep.tsx:30-83 but creates the TENANT and stores its id on
// the onboarding context for the following Company step. Copy says "organization".
import { useState } from "react";
import type { StepProps } from "../registry";
import { organizationsApi } from "../../api/organizations";
import { Button } from "@/components/ui/button";
import { Reveal } from "../motion";
import { FIELD, GradientText, LABEL, StepCard, StepHeading, StepShell } from "./shared";

export function CreateOrganizationStep({ ctx, onComplete }: StepProps) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) { setError("Please enter a name for your organization."); return; }
    setBusy(true); setError(null);
    try {
      const org = await organizationsApi.create({ name: name.trim() });
      ctx.setOrganizationId?.(org.id); // added to StepProps ctx in Task 12
      onComplete();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create your organization.");
      setBusy(false);
    }
  };

  return (
    <StepShell>
      <Reveal>
        <StepHeading
          title={<>Your <GradientText>organization</GradientText></>}
          subtitle="Your organization is the account that owns your companies and billing. You can rename it later." />
      </Reveal>
      <Reveal delay={0.09}>
        <StepCard>
          <label className={LABEL} htmlFor="org-tenant-name">Organization name</label>
          <input id="org-tenant-name" className={FIELD} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
        </StepCard>
      </Reveal>
      <Reveal delay={0.18}>
        <Button className="w-full" onClick={() => void submit()} disabled={busy}>{busy ? "Creating…" : "Continue"}</Button>
      </Reveal>
    </StepShell>
  );
}
```

Then fix `OrgStep.tsx` copy to say **Company** and advance to `COMPANY_CREATED`:
- `:75` and `:94`: `requestedState: "COMPANY_CREATED"` (was `"ORGANIZATION_CREATED"`).
- `:111`,`:141`: heading already `company` — keep.
- `:114`,`:119`,`:144`,`:149`: replace user-facing "organization" copy with "company" (e.g. "Create your company", label "Company name", error "Please enter a name for your company.").

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/ui test -- CreateOrganizationStep`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add ui/src/onboarding/steps/CreateOrganizationStep.tsx ui/src/onboarding/steps/OrgStep.tsx ui/src/onboarding/steps/__tests__/CreateOrganizationStep.test.tsx
git commit -m "feat(mt): create-organization step + company-step copy rename"
```

---

## Task 4: `instanceAdminBootstrapEnabled` chokepoint + boot assertion (pure, no rewiring)

This introduces the single gate all four promotion sites will consult. It does **not** rewire any call site yet (so no behavior change, no lockout risk).

**Files:**
- Modify: `server/src/services/first-user-bootstrap.ts` (append the chokepoint + assertion)
- Test: `server/src/__tests__/instance-admin-bootstrap-gate.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/instance-admin-bootstrap-gate.test.ts
import { describe, it, expect } from "vitest";
import {
  instanceAdminBootstrapEnabled,
  assertInstanceAdminBootstrapInvariant,
} from "../services/first-user-bootstrap.js";

describe("instanceAdminBootstrapEnabled", () => {
  it("is enabled for self-hosted modes", () => {
    expect(instanceAdminBootstrapEnabled("local_trusted")).toBe(true);
    expect(instanceAdminBootstrapEnabled("authenticated")).toBe(true);
  });
  it("is DISABLED for cloud_auth", () => {
    expect(instanceAdminBootstrapEnabled("cloud_auth")).toBe(false);
  });
});

describe("assertInstanceAdminBootstrapInvariant", () => {
  it("passes when cloud_auth bootstrap is disabled (the real resolver)", () => {
    expect(() => assertInstanceAdminBootstrapInvariant({ deploymentMode: "cloud_auth" })).not.toThrow();
  });
  it("throws if a tampered resolver would enable cloud_auth promotion", () => {
    expect(() =>
      assertInstanceAdminBootstrapInvariant({ deploymentMode: "cloud_auth" }, () => true),
    ).toThrow(/cloud_auth must not mint runtime instance_admin/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/server test -- instance-admin-bootstrap-gate`
Expected: FAIL — exports not defined.

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/services/first-user-bootstrap.ts (append)
import type { DeploymentMode } from "@armyofagents/shared";

/**
 * Single chokepoint gating EVERY instance_admin promotion path. `cloud_auth`
 * (hosted multi-tenant beta) mints zero runtime instance_admins — the platform
 * operator is provisioned out-of-band; instance_admin is self-hosted/break-glass
 * only. Self-hosted local_trusted/authenticated keep the first-user bootstrap.
 */
export function instanceAdminBootstrapEnabled(mode: DeploymentMode): boolean {
  return mode !== "cloud_auth";
}

/** Boot-time invariant: cloud_auth must never have a runtime promotion path enabled. */
export function assertInstanceAdminBootstrapInvariant(
  config: { deploymentMode: DeploymentMode },
  resolver: (mode: DeploymentMode) => boolean = instanceAdminBootstrapEnabled,
): void {
  if (config.deploymentMode === "cloud_auth" && resolver(config.deploymentMode)) {
    throw new Error(
      "Startup invariant violated: cloud_auth must not mint runtime instance_admin.",
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/server test -- instance-admin-bootstrap-gate`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/services/first-user-bootstrap.ts server/src/__tests__/instance-admin-bootstrap-gate.test.ts
git commit -m "feat(mt): instance_admin bootstrap chokepoint + boot invariant"
```

---

## Task 5: `organizationAccessService` — org role × capability matrix

**Files:**
- Create: `server/src/services/organization-access.ts`
- Modify: `server/src/services/index.ts` (export `organizationAccessService`)
- Test: `server/src/__tests__/organization-access.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/organization-access.test.ts
import { describe, it, expect } from "vitest";
import { orgRoleCan } from "../services/organization-access.js";

describe("orgRoleCan (role x capability matrix)", () => {
  it("owner can do everything org-scoped", () => {
    for (const cap of [
      "company:create", "company:delete", "org:member:manage",
      "org:role:set", "org:transfer", "org:dissolve", "billing:manage", "company:list:all",
    ] as const) {
      expect(orgRoleCan("owner", cap)).toBe(true);
    }
  });
  it("admin can create/delete companies + manage members but not transfer/billing", () => {
    expect(orgRoleCan("admin", "company:create")).toBe(true);
    expect(orgRoleCan("admin", "org:member:manage")).toBe(true);
    expect(orgRoleCan("admin", "org:transfer")).toBe(false);
    expect(orgRoleCan("admin", "billing:manage")).toBe(false);
  });
  it("member cannot create companies", () => {
    expect(orgRoleCan("member", "company:create")).toBe(false);
    expect(orgRoleCan("member", "company:list:scoped")).toBe(true);
  });
  it("billing can only manage billing + read metadata", () => {
    expect(orgRoleCan("billing", "billing:manage")).toBe(true);
    expect(orgRoleCan("billing", "company:create")).toBe(false);
    expect(orgRoleCan("billing", "company:list:metadata")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/server test -- organization-access`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/services/organization-access.ts
// Mirrors accessService shape (server/src/services/access.ts:42).
import { and, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { organizationMemberships } from "@armyofagents/db";
import type { OrganizationRole } from "@armyofagents/shared";

export type OrgCapability =
  | "company:create" | "company:delete"
  | "org:member:manage" | "org:role:set" | "org:transfer" | "org:dissolve"
  | "billing:manage"
  | "company:list:all" | "company:list:scoped" | "company:list:metadata";

const MATRIX: Record<OrganizationRole, ReadonlySet<OrgCapability>> = {
  owner: new Set<OrgCapability>([
    "company:create", "company:delete", "org:member:manage", "org:role:set",
    "org:transfer", "org:dissolve", "billing:manage", "company:list:all",
  ]),
  admin: new Set<OrgCapability>([
    "company:create", "company:delete", "org:member:manage", "org:role:set", "company:list:all",
  ]),
  member: new Set<OrgCapability>(["company:list:scoped"]),
  billing: new Set<OrgCapability>(["billing:manage", "company:list:metadata"]),
};

export function orgRoleCan(role: OrganizationRole, cap: OrgCapability): boolean {
  return MATRIX[role]?.has(cap) ?? false;
}

export function organizationAccessService(db: Db) {
  async function getMembership(organizationId: string, userId: string) {
    return db
      .select()
      .from(organizationMemberships)
      .where(and(
        eq(organizationMemberships.organizationId, organizationId),
        eq(organizationMemberships.userId, userId),
      ))
      .then((rows) => rows[0] ?? null);
  }

  async function canOrg(organizationId: string, userId: string | null | undefined, cap: OrgCapability): Promise<boolean> {
    if (!userId) return false;
    const m = await getMembership(organizationId, userId);
    if (!m || m.status !== "active") return false;
    return orgRoleCan(m.role as OrganizationRole, cap);
  }

  async function ensureOrgMembership(
    organizationId: string, userId: string, role: OrganizationRole = "member", status = "active",
  ) {
    // Race-safe + idempotent: P1's 0188 backfill and access.ensureRealOperator
    // (Task 10) may also insert the SAME (organizationId,userId) owner row, so the
    // insert uses onConflictDoNothing on the P1 unique index and re-reads. Never
    // downgrades an existing owner to a weaker role on conflict.
    await db.insert(organizationMemberships)
      .values({ organizationId, userId, role, status })
      .onConflictDoNothing({
        target: [organizationMemberships.organizationId, organizationMemberships.userId],
      });
    const existing = await getMembership(organizationId, userId);
    if (existing && (existing.role !== role || existing.status !== status)) {
      // Only promote (never clobber an owner with a member write): callers pass the
      // intended role explicitly, and self-serve create always passes "owner".
      if (!(existing.role === "owner" && role !== "owner")) {
        await db.update(organizationMemberships)
          .set({ role, status, updatedAt: new Date() })
          .where(eq(organizationMemberships.id, existing.id));
      }
    }
    return existing?.id ?? (await getMembership(organizationId, userId))!.id;
  }

  async function ensureOrgOwner(organizationId: string, userId: string) {
    return ensureOrgMembership(organizationId, userId, "owner", "active");
  }

  async function listOrgMemberships(userId: string) {
    return db.select().from(organizationMemberships)
      .where(and(eq(organizationMemberships.userId, userId), eq(organizationMemberships.status, "active")));
  }

  return { getMembership, canOrg, ensureOrgMembership, ensureOrgOwner, listOrgMemberships };
}
```

```ts
// server/src/services/index.ts (append)
export { organizationAccessService } from "./organization-access.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/server test -- organization-access`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/services/organization-access.ts server/src/services/index.ts server/src/__tests__/organization-access.test.ts
git commit -m "feat(mt): organizationAccessService + role x capability matrix"
```

---

## Task 6: Self-serve `POST /organizations` — EXTEND P1's `organizations.ts`

> **Cross-phase (item 6):** Phase 1 already creates `server/src/services/organizations.ts` with its factory (`organizationService`), `ensureDefaultOrganization`, `DEFAULT_ORGANIZATION_ID`, and slug helpers. Phase 2 **ADDS `createSelfServeOrganization` INTO that existing file** — it does NOT create a second `organizations.ts`. Reuse P1's factory/slug helper for the row insert; use `orgAccess.ensureOrgOwner` (which is `onConflictDoNothing`-safe per Task 5) for the owner-membership write, since P1's `ensureRealOperator`/backfill may also touch it.

**Files:**
- Modify: `server/src/services/organizations.ts` (ADD `createSelfServeOrganization` to P1's file)
- Create: `server/src/routes/organizations.ts` (follows `server/src/routes/goals.ts`)
- Modify: `server/src/app.ts:307` region (mount after `/companies`)
- Create: `ui/src/api/organizations.ts`
- Test: `server/src/__tests__/organizations-routes.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/organizations-routes.test.ts
import { describe, it, expect, vi } from "vitest";
import { createSelfServeOrganization } from "../services/organizations.js";

// Sequence-style fake db (see CLAUDE.md Test Patterns).
function fakeDb() {
  const inserts: any[] = [];
  const db: any = {
    insert: (tbl: any) => ({
      values: (v: any) => ({ returning: async () => { inserts.push({ tbl, v }); return [{ id: v.id ?? "org-new", ...v }]; } }),
    }),
  };
  return { db, inserts };
}

describe("createSelfServeOrganization", () => {
  it("creates the org and makes the caller its owner", async () => {
    const { db, inserts } = fakeDb();
    const ensureOrgOwner = vi.fn(async () => "m1");
    const org = await createSelfServeOrganization(db, { name: "Acme", ownerUserId: "u1" }, { ensureOrgOwner } as any);
    expect(org.name).toBe("Acme");
    expect(ensureOrgOwner).toHaveBeenCalledWith(org.id, "u1");
    expect(inserts.some((i) => i.v.name === "Acme")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/server test -- organizations-routes`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/services/organizations.ts — APPEND this export to P1's existing file.
// Do NOT re-import `organizations` or redefine the factory if P1 already did; reuse
// P1's row-insert path (its factory `createOrganization`/slug helper). The example
// below assumes P1 exposes `organizationService(db).create({ name })`; if P1's
// method name differs, call that instead — the contract is "insert an org row,
// return it". The owner-membership write goes through ensureOrgOwner (idempotent).
import type { Db } from "@armyofagents/db";
import { organizationService } from "./organizations.js"; // P1's factory (same file)
import type { organizationAccessService } from "./organization-access.js";

export async function createSelfServeOrganization(
  db: Db,
  input: { name: string; ownerUserId: string },
  orgAccess: Pick<ReturnType<typeof organizationAccessService>, "ensureOrgOwner">,
) {
  const org = await organizationService(db).create({ name: input.name }); // P1 factory
  await orgAccess.ensureOrgOwner(org.id, input.ownerUserId);              // onConflictDoNothing-safe
  return org;
}
```

> If P1's factory is not `organizationService(db).create(...)`, adapt the single call to P1's actual method (grep `server/src/services/organizations.ts` for the exported factory before writing). The **test double** below stays valid because it injects `ensureOrgOwner` and stubs the row insert.

```ts
// server/src/routes/organizations.ts  (pattern: routes/goals.ts + companies.ts:146-151 gate idiom)
import { Router } from "express";
import { z } from "zod";
import type { Db } from "@armyofagents/db";
import { validate } from "../middleware/validate.js";
import { assertBoard } from "./authz.js";
import { forbidden } from "../errors.js";
import { organizationAccessService } from "../services/organization-access.js";
import { createSelfServeOrganization } from "../services/organizations.js";

const createOrgSchema = z.object({ name: z.string().min(1) });

export function organizationRoutes(db: Db): Router {
  const router = Router();
  const orgAccess = organizationAccessService(db);

  // Self-serve org creation: any signed-in board user may create an org and
  // becomes its owner. NO instance_admin gate — this is the multi-tenant thesis.
  router.post("/", validate(createOrgSchema), async (req, res) => {
    assertBoard(req);
    if (!req.actor.userId) throw forbidden("Sign in to create an organization");
    const org = await createSelfServeOrganization(db, { name: req.body.name, ownerUserId: req.actor.userId }, orgAccess);
    res.status(201).json(org);
  });

  // Caller's own org memberships (for the Lobby org switcher).
  router.get("/", async (req, res) => {
    assertBoard(req);
    if (!req.actor.userId) { res.json([]); return; }
    res.json(await orgAccess.listOrgMemberships(req.actor.userId));
  });

  return router;
}
```

```ts
// server/src/app.ts — import near :27 and mount right after the /companies line (:307)
import { organizationRoutes } from "./routes/organizations.js";
// ...
api.use("/organizations", organizationRoutes(db));
```

```ts
// ui/src/api/organizations.ts
import { apiFetch } from "./client"; // reuse the existing client helper used by companiesApi
export const organizationsApi = {
  create: (data: { name: string }) => apiFetch<{ id: string; name: string }>("/api/organizations", { method: "POST", body: JSON.stringify(data) }),
  list: () => apiFetch<Array<{ organizationId: string; role: string }>>("/api/organizations"),
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/server test -- organizations-routes`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/services/organizations.ts server/src/routes/organizations.ts server/src/app.ts ui/src/api/organizations.ts server/src/__tests__/organizations-routes.test.ts
git commit -m "feat(mt): self-serve POST /organizations (extends P1 organizations service)"
```

---

## Task 7: Gate the `bootstrap_ceo` invite promotion for cloud_auth

**Files:**
- Modify: `server/src/routes/access.ts:2040-2043`
- Test: `server/src/__tests__/bootstrap-ceo-cloud-auth.test.ts`

> Safe to land before the atomic cutover: this only removes a *secondary* promotion path in cloud_auth; the better-auth hooks still promote the first user until Task 10, so no lockout.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/bootstrap-ceo-cloud-auth.test.ts
import { describe, it, expect } from "vitest";
import { bootstrapCeoPromotionAllowed } from "../routes/access.js";

describe("bootstrapCeoPromotionAllowed", () => {
  it("blocks bootstrap_ceo promotion in cloud_auth", () => {
    expect(bootstrapCeoPromotionAllowed("cloud_auth")).toBe(false);
  });
  it("allows it self-hosted", () => {
    expect(bootstrapCeoPromotionAllowed("authenticated")).toBe(true);
    expect(bootstrapCeoPromotionAllowed("local_trusted")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/server test -- bootstrap-ceo-cloud-auth`
Expected: FAIL — `bootstrapCeoPromotionAllowed` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/routes/access.ts — add near the top (exported helper) using the chokepoint.
import { instanceAdminBootstrapEnabled } from "../services/first-user-bootstrap.js";
import type { DeploymentMode } from "@armyofagents/shared";
export function bootstrapCeoPromotionAllowed(mode: DeploymentMode): boolean {
  return instanceAdminBootstrapEnabled(mode);
}
```

Then guard the promotion in the `bootstrap_ceo` branch (currently `:2040-2043`). `accessRoutes` already receives `opts.deploymentMode` (`:1564`):

```ts
// server/src/routes/access.ts:2040-2043 (replace)
const userId = req.actor.userId ?? "local-board";
if (bootstrapCeoPromotionAllowed(opts.deploymentMode)) {
  const existingAdmin = await access.isInstanceAdmin(userId);
  if (!existingAdmin) {
    await access.promoteInstanceAdmin(userId);
  }
} else {
  throw forbidden("Bootstrap CEO promotion is disabled in this deployment mode");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/server test -- bootstrap-ceo-cloud-auth`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/access.ts server/src/__tests__/bootstrap-ceo-cloud-auth.test.ts
git commit -m "feat(mt): disable bootstrap_ceo instance_admin promotion in cloud_auth"
```

---

## Task 8: Gate board-claim for cloud_auth

**Files:**
- Modify: `server/src/board-claim.ts:43-66` (init) and `:85-91` (claim entry)
- Test: `server/src/__tests__/board-claim-cloud-auth.test.ts`

> Board-claim is a single-tenant `local_trusted → authenticated` handoff; it must be inert in cloud_auth. Safe to land before the cutover for the same reason as Task 7.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/board-claim-cloud-auth.test.ts
import { describe, it, expect } from "vitest";
import { initializeBoardClaimChallenge, claimBoardOwnership, getBoardClaimWarningUrl } from "../board-claim.js";

const db: any = { select: () => ({ from: () => ({ where: async () => [] }) }) };

describe("board-claim in cloud_auth", () => {
  it("initializes no challenge", async () => {
    await initializeBoardClaimChallenge(db, { deploymentMode: "cloud_auth" });
    expect(getBoardClaimWarningUrl("localhost", 3101)).toBeNull();
  });
  it("claim is a no-op returning invalid", async () => {
    const r = await claimBoardOwnership(db, { token: "x", code: "y", userId: "u1", deploymentMode: "cloud_auth" } as any);
    expect(r.status).toBe("invalid");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/server test -- board-claim-cloud-auth`
Expected: FAIL — `claimBoardOwnership` does not accept/short-circuit on `deploymentMode`.

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/board-claim.ts:47 (initializeBoardClaimChallenge) — broaden the early return:
//   was: if (opts.deploymentMode !== "authenticated") { activeChallenge = null; return; }
//   keep as-is — cloud_auth already !== "authenticated", so no challenge is created. ✓

// server/src/board-claim.ts:85 (claimBoardOwnership) — add deploymentMode + guard:
export async function claimBoardOwnership(
  db: Db,
  opts: { token: string; code: string | undefined; userId: string; deploymentMode?: DeploymentMode },
): Promise<{ status: ChallengeStatus; claimedByUserId?: string }> {
  if (opts.deploymentMode === "cloud_auth") return { status: "invalid" };
  const status = getChallengeStatus(opts.token, opts.code);
  // ...unchanged below
```

Thread `deploymentMode` from the caller at `server/src/routes/access.ts:1607` (`claimBoardOwnership(db, { token, code, ... })`) — add `deploymentMode: opts.deploymentMode`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/server test -- board-claim-cloud-auth`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/board-claim.ts server/src/routes/access.ts server/src/__tests__/board-claim-cloud-auth.test.ts
git commit -m "feat(mt): make board-claim inert in cloud_auth"
```

---

## Task 9: Org-first journey resolver rewrite

**Files:**
- Modify: `server/src/services/post-auth-journey.ts:3-49`
- Modify: `server/src/routes/onboarding-journey.ts:40-203` (resolve org memberships; org-aware invited path)
- Test: `server/src/__tests__/post-auth-journey-org-first.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/post-auth-journey-org-first.test.ts
import { describe, it, expect } from "vitest";
import { resolvePostAuthJourney } from "../services/post-auth-journey.js";

describe("org-first journey resolution", () => {
  it("returning when the user has an org membership even with zero companies", () => {
    const r = resolvePostAuthJourney({
      organizationMemberships: ["org1"], memberships: [], pendingInvitations: [], deepLinkCompanyId: null,
    });
    expect(r.journey).toBe("returning");
    expect(r.targetCompanyId).toBeNull();
  });
  it("founder when no org membership and no invite", () => {
    const r = resolvePostAuthJourney({
      organizationMemberships: [], memberships: [], pendingInvitations: [], deepLinkCompanyId: null,
    });
    expect(r.journey).toBe("founder");
  });
  it("invited when an org invitation exists but no membership", () => {
    const r = resolvePostAuthJourney({
      organizationMemberships: [], memberships: [],
      pendingInvitations: [{ companyId: "c1", companyName: "X", inviteId: "i1", role: "team_member", createdAt: "2026-01-01T00:00:00Z", filed: true }],
      deepLinkCompanyId: null,
    });
    expect(r.journey).toBe("invited");
    expect(r.targetCompanyId).toBe("c1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/server test -- post-auth-journey-org-first`
Expected: FAIL — `organizationMemberships` not accepted; returning currently keys on `memberships`.

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/services/post-auth-journey.ts
export type JourneyInput = {
  organizationMemberships: string[]; // org ids the user actively belongs to (org-first)
  memberships: string[];             // companyIds — used only to pick a landing target
  pendingInvitations: PendingInvitation[];
  deepLinkCompanyId?: string | null;
};

export function resolvePostAuthJourney(input: JourneyInput): PostAuthJourneyResult {
  if (input.organizationMemberships.length > 0) {
    return {
      journey: "returning",
      targetCompanyId: input.memberships[0] ?? null,
      pendingInvitations: input.pendingInvitations,
      inviteToken: null,
    };
  }
  if (input.pendingInvitations.length > 0) {
    const target =
      input.deepLinkCompanyId && input.pendingInvitations.some((i) => i.companyId === input.deepLinkCompanyId)
        ? input.deepLinkCompanyId
        : input.pendingInvitations[0].companyId;
    return { journey: "invited", targetCompanyId: target, pendingInvitations: input.pendingInvitations, inviteToken: null };
  }
  return { journey: "founder", targetCompanyId: null, pendingInvitations: [], inviteToken: null };
}
```

```ts
// server/src/routes/onboarding-journey.ts — in getJourneyForUser:
// (a) load org memberships via organizationAccessService.listOrgMemberships(userId).
// (b) pass organizationMemberships (org ids) into resolvePostAuthJourney alongside
//     the existing company `returningCompanyIds` as `memberships`.
// (c) the instance-admin company-visibility bypass (:161-167) stays for
//     self-hosted single-tenant, but is inert in cloud_auth (no instance_admin exists).
import { organizationAccessService } from "../services/organization-access.js";
// ...
const orgAccess = organizationAccessService(db);
const orgRows = await orgAccess.listOrgMemberships(args.userId);
const organizationMemberships = orgRows.map((r) => r.organizationId);
// ...
const result = resolvePostAuthJourney({
  organizationMemberships,
  memberships: returningCompanyIds,
  pendingInvitations,
  deepLinkCompanyId: args.deepLinkCompanyId ?? null,
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/server test -- post-auth-journey-org-first`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/services/post-auth-journey.ts server/src/routes/onboarding-journey.ts server/src/__tests__/post-auth-journey-org-first.test.ts
git commit -m "feat(mt): org-first post-auth journey resolution"
```

---

## Task 10: ATOMIC cloud_auth cutover — hook gating + company-create gate swap + operator/owner + boot assertion

**This is the lockout-critical commit.** It disables the two better-auth first-user hooks in cloud_auth **and** swaps the company-create gate to org-owner **in the same commit**, so a fresh cloud_auth instance is never left admin-less with an admin-gated create path.

> **Cross-phase (item 6) — Phase 3 is the LAST WRITER on the `companies.ts` create/list handler gate.** The `companies.ts` create/list handler is edited by three phases; P3 folds the FINAL create-authorization into its `req.tenant.enforced` middleware path (which will call **this plan's `organizationAccessService.canOrg`**). Phase 2's edit here is deliberately **minimal and scoped to the lockout fix**: swap the `isInstanceAdmin` gate to `canOrg("company:create")` + server-derive the org, ONLY so the atomic hook-swap doesn't lock out cloud_auth. Do NOT build elaborate tenant-scoping/list-filtering here — that is P3's. Phase 2 KEEPS ownership of: the atomic hook-gating (this task), `POST /organizations` (Task 6), and `organizationAccessService`/`canOrg` (Task 5) that P3 consumes. Leave a code comment at the swapped gate: `// P2 lockout-scoped gate; P3 is last-writer — final authz moves to req.tenant.enforced calling canOrg`.

**Files:**
- Modify: `server/src/auth/better-auth.ts:216-237` (gate both hooks)
- Modify: `server/src/routes/companies.ts:146-162` (P2 lockout-scoped gate swap + org server-derive + org-owner write; P3 last-writer)
- Modify: `server/src/services/access.ts:277-305` (`ensureRealOperator` also writes org owner membership)
- Modify: `server/src/app.ts` boot path (call `assertInstanceAdminBootstrapInvariant`)
- Modify: `server/src/middleware/auth.ts:~82,~154` (item 1 — keep `opts.deploymentMode` in scope at the two `isInstanceAdmin` derivations; NO behavior change in P2, this is the readable-hook P3's force-false wraps)
- Modify: `packages/shared/src/validators/company.ts:8-19` (add `organizationId` as **OPTIONAL** — item 5)
- Test: `server/src/__tests__/cloud-auth-cutover.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// server/src/__tests__/cloud-auth-cutover.test.ts
import { describe, it, expect, vi } from "vitest";
import { buildBetterAuthConfig } from "../auth/better-auth.js";
import { resolveCompanyOrganizationId, assertCompanyCreateAuthorized } from "../routes/companies.js";
import { DEFAULT_ORGANIZATION_ID } from "../services/organizations.js"; // P1-owned

const cfg = (deploymentMode: any) => ({
  deploymentMode, deploymentExposure: "public", authBaseUrlMode: "explicit",
  authPublicBaseUrl: "https://a.example.com", googleClientId: "x", googleClientSecret: "y",
  headlessBootstrap: false,
} as any);

describe("first cloud_auth user does NOT become global admin", () => {
  it("wires NO first-user databaseHooks in cloud_auth", () => {
    const built = buildBetterAuthConfig({} as any, cfg("cloud_auth"), [], "secret") as any;
    // Hooks object exists but the user/session create hooks must be absent/no-op.
    expect(built.databaseHooks?.user?.create?.after).toBeUndefined();
    expect(built.databaseHooks?.session?.create?.after).toBeUndefined();
  });
  it("self-hosted STILL wires the first-user promotion hooks", () => {
    const built = buildBetterAuthConfig({} as any, cfg("authenticated"), [], "secret") as any;
    expect(typeof built.databaseHooks.user.create.after).toBe("function");
    expect(typeof built.databaseHooks.session.create.after).toBe("function");
  });
});

describe("company-create org gate (anti-tenant-hop)", () => {
  it("uses the SAME org for authz and for the written company row", async () => {
    const canOrg = vi.fn(async (orgId: string) => orgId === "orgA"); // caller authorized only for orgA
    await expect(
      assertCompanyCreateAuthorized({ canOrg } as any, "orgA", "u1"),
    ).resolves.toBeUndefined();
    await expect(
      assertCompanyCreateAuthorized({ canOrg } as any, "orgB", "u1"),
    ).rejects.toThrow(/organization/i);
    // The org written to the company is exactly the org that was authorized.
    expect(resolveCompanyOrganizationId({ organizationId: "orgA" } as any)).toBe("orgA");
  });
  it("falls back to DEFAULT_ORGANIZATION_ID when the client omits organizationId (self-hosted)", () => {
    expect(resolveCompanyOrganizationId({} as any)).toBe(DEFAULT_ORGANIZATION_ID);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @armyofagents/server test -- cloud-auth-cutover`
Expected: FAIL — helpers not exported; hooks always wired.

- [ ] **Step 3: Write minimal implementation**

Gate both hooks (better-auth.ts):

```ts
// server/src/auth/better-auth.ts — import the chokepoint at top:
import { instanceAdminBootstrapEnabled } from "../services/first-user-bootstrap.js";

// Replace the databaseHooks block (:213-238) so the first-user hooks are only
// attached when bootstrap is enabled for this mode. In cloud_auth they are absent.
if (instanceAdminBootstrapEnabled(config.deploymentMode)) {
  authConfig.databaseHooks = {
    user: { create: { after: async (user: { id: string }) => {
      await attemptFirstAdminBootstrap(db, user.id, "user_create", config.headlessBootstrap === true);
    } } },
    session: { create: { after: async (session: { userId: string }) => {
      await attemptFirstAdminBootstrap(db, session.userId, "session_create", config.headlessBootstrap === true);
    } } },
  };
} else {
  authConfig.databaseHooks = {}; // cloud_auth: zero runtime instance_admin promotion
}
```

Swap the company-create gate + derive org server-side + write org owner (companies.ts):

```ts
// packages/shared/src/validators/company.ts:8 — add to createCompanySchema.
// OPTIONAL (item 5): self-hosted single-tenant clients don't send it; the route
// injects DEFAULT_ORGANIZATION_ID (P1) or the authorized org AFTER validation.
  organizationId: z.string().uuid().optional(),
```

```ts
// server/src/routes/companies.ts — add exported helpers + swap the gate at :146-162.
// P2 lockout-scoped gate; P3 is last-writer — final authz moves to req.tenant.enforced calling canOrg.
import { organizationAccessService } from "../services/organization-access.js";
import type { OrgCapability } from "../services/organization-access.js";
import { DEFAULT_ORGANIZATION_ID } from "../services/organizations.js"; // P1-owned constant

/**
 * Anti-tenant-hop: the org used to AUTHORIZE the create is the SAME org written to
 * the company row. When the client omits organizationId (self-hosted single-tenant),
 * fall back to P1's DEFAULT_ORGANIZATION_ID — never to a client-supplied "target".
 */
export function resolveCompanyOrganizationId(body: { organizationId?: string | null }): string {
  return body.organizationId ?? DEFAULT_ORGANIZATION_ID;
}
export async function assertCompanyCreateAuthorized(
  orgAccess: { canOrg: (o: string, u: string, c: OrgCapability) => Promise<boolean> },
  organizationId: string, userId: string,
): Promise<void> {
  const ok = await orgAccess.canOrg(organizationId, userId, "company:create");
  if (!ok) throw forbidden("You are not an owner/admin of this organization");
}

// Inside router.post("/", ...) replace the isInstanceAdmin gate (:146-162):
router.post("/", validate(createCompanySchema), async (req, res) => {
  assertBoard(req);
  const orgAccess = organizationAccessService(db);
  // Self-hosted single-tenant keeps working: local_implicit / instance_admin bypass.
  const isSelfHostedOperator = req.actor.source === "local_implicit" || req.actor.isInstanceAdmin;
  const organizationId = resolveCompanyOrganizationId(req.body); // server-derived; never a raw client "target"
  if (!isSelfHostedOperator) {
    if (!req.actor.userId) throw forbidden("Sign in to create a company");
    await assertCompanyCreateAuthorized(orgAccess, organizationId, req.actor.userId);
  }
  const requireBoardApprovalForNewAgents = opts.deploymentMode !== "local_trusted";
  const company = await svc.create(
    { ...req.body, organizationId, requireBoardApprovalForNewAgents }, // org bound server-side
    { requestedByUserId: req.actor.userId ?? null },
  );
  const operatorId = await access.ensureRealOperator(company.id, req.actor.userId);
  // ...unchanged (materializeCompanyProfileFromGlobal, seedAoaNativeSkills, ensureCommanderAgent, logActivity, 201)
});
```

Make `ensureRealOperator` also write org owner membership (access.ts:277-305). It needs the org id — derive from the company row:

```ts
// server/src/services/access.ts — inside ensureRealOperator, after ensureMembership(...owner)
// and the founder user_role insert (:297-303), add:
import { companies as companiesTable, organizationMemberships } from "@armyofagents/db";
// ...
const companyRow = await db.select({ organizationId: companiesTable.organizationId })
  .from(companiesTable).where(eq(companiesTable.id, companyId)).limit(1).then((r) => r[0]);
if (companyRow?.organizationId) {
  const existingOrg = await db.select({ id: organizationMemberships.id }).from(organizationMemberships)
    .where(and(
      eq(organizationMemberships.organizationId, companyRow.organizationId),
      eq(organizationMemberships.userId, operatorId),
    )).limit(1).then((r) => r[0]);
  if (!existingOrg) {
    await db.insert(organizationMemberships).values({
      organizationId: companyRow.organizationId, userId: operatorId, role: "owner", status: "active",
    });
  }
}
```

Wire the boot assertion (app.ts — near where `opts.deploymentMode` is first available, e.g. server boot before listening):

```ts
// server/src/app.ts (or server/src/index.ts boot path)
import { assertInstanceAdminBootstrapInvariant } from "./services/first-user-bootstrap.js";
assertInstanceAdminBootstrapInvariant({ deploymentMode: opts.deploymentMode });
```

Make `config.deploymentMode` (incl. the new `cloud_auth`) readable at the actor-`isInstanceAdmin` derivation point (item 1 / BLOCKER B1 coordination):

```ts
// server/src/middleware/auth.ts — actorMiddleware already receives `opts.deploymentMode`
// (ActorMiddlewareOptions, :16-25) and reads it for the escape hatch (:33). Phase 2 must
// keep that value in scope at BOTH points where the board actor's isInstanceAdmin is
// derived (~:82 session path, ~:154 board-key path). Concretely: ensure `opts.deploymentMode`
// is referenced (not destructured away) in the two `isInstanceAdmin: Boolean(roleRow)` blocks
// so P3 can wrap them.
//
// P2 OWNS: making cloud_auth readable at this derivation point.
// P3 OWNS: the actual force-false — e.g.
//   isInstanceAdmin: opts.deploymentMode === "cloud_auth" ? false : Boolean(roleRow)
// Do NOT implement the force-false in P2; only guarantee the mode is in scope here.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @armyofagents/server test -- cloud-auth-cutover`
Expected: PASS

- [ ] **Step 5: Commit (atomic)**

```bash
git add server/src/auth/better-auth.ts server/src/routes/companies.ts server/src/services/access.ts server/src/app.ts server/src/middleware/auth.ts packages/shared/src/validators/company.ts server/src/__tests__/cloud-auth-cutover.test.ts
git commit -m "feat(mt): atomic cloud_auth cutover — disable first-user hooks + org-owner company-create gate"
```

---

## Task 10b: Let `cloud_auth` boot in e2e/test context WITHOUT real Google OAuth creds

> **Why:** P6 §4.0b's strict cloud_auth e2e journeys (cross-tenant-negative, access-required, break-glass, invited-join) only exercise real tenant-isolation behavior when the instance boots in TRUE `cloud_auth` (in `authenticated` the P3 `isInstanceAdmin` clamp + enforced tenant gate are OFF — single-tenant preserved — so those tests would be meaningless). But `cloud_auth` normally hard-requires Google client id/secret. This task lets `cloud_auth` boot without real Google creds **only** under the same hard flag P6 §4.0 introduced (`AOA_E2E_TEST_SUPPORT === "1"`); sessions then come from the P6 test-mint seam, never real OAuth.
>
> **Where the Google-creds boot requirement actually lives (reconciliation):** the coordinator named `config-schema.ts superRefine`, but the file-based `paperclipConfigSchema` holds **no** Google creds — `googleClientId`/`googleClientSecret` are env-resolved `Config` fields (`server/src/config.ts:42-43`), and the boot-time requirement is enforced in **`assertAuthProviderConfigured` (`server/src/auth/better-auth.ts:256-267`)**. The flag-gated relaxation therefore goes there (plus the stub provider in `buildBetterAuthConfig`), which is the equivalent gate.
>
> **PROD-SAFETY:** the relaxation applies ONLY when `AOA_E2E_TEST_SUPPORT === "1"`. Real prod `cloud_auth` still hard-requires Google creds. The existing fail-closed boot guard that refuses to start if `AOA_E2E_TEST_SUPPORT` is set on a real public deployment (P6 §4.0) is the leak backstop — this task does NOT weaken it and must not be merged ahead of it (cross-phase dep).

**Files:**
- Modify: `server/src/auth/better-auth.ts:174-181` (stub provider), `:256-267` (`assertAuthProviderConfigured` relaxation)
- Test: `server/src/__tests__/cloud-auth-test-boot.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/cloud-auth-test-boot.test.ts
import { describe, it, expect } from "vitest";
import {
  assertAuthProviderConfigured,
  allowCloudAuthBootWithoutGoogle,
  buildBetterAuthConfig,
} from "../auth/better-auth.js";

const noGoogleCloud = {
  deploymentMode: "cloud_auth", devLocalIdentity: false,
  googleClientId: null, googleClientSecret: null,
  authBaseUrlMode: "explicit", authPublicBaseUrl: "https://a.example.com",
  deploymentExposure: "public",
} as any;

describe("cloud_auth test-support boot relaxation (AOA_E2E_TEST_SUPPORT)", () => {
  it("boots WITHOUT Google creds when the flag is set", () => {
    expect(() => assertAuthProviderConfigured(noGoogleCloud, true)).not.toThrow();
  });
  it("REFUSES to boot without Google creds when the flag is UNSET (real-prod invariant)", () => {
    expect(() => assertAuthProviderConfigured(noGoogleCloud, false)).toThrow(/Google OAuth is not configured/i);
  });
  it("mounts a stub Google provider under the flag (sessions come from the P6 test-mint seam)", () => {
    const built = buildBetterAuthConfig({} as any, noGoogleCloud, [], "s", true) as any;
    expect(built.socialProviders?.google).toBeDefined();
  });
  it("helper is true ONLY for cloud_auth + flag on", () => {
    expect(allowCloudAuthBootWithoutGoogle("cloud_auth", true)).toBe(true);
    expect(allowCloudAuthBootWithoutGoogle("cloud_auth", false)).toBe(false);
    expect(allowCloudAuthBootWithoutGoogle("authenticated", true)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/server test -- cloud-auth-test-boot`
Expected: FAIL — `allowCloudAuthBootWithoutGoogle` not exported; `assertAuthProviderConfigured`/`buildBetterAuthConfig` don't accept the flag.

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/auth/better-auth.ts — add the pure helper (near assertAuthProviderConfigured):
/**
 * e2e/test-support boot relaxation: cloud_auth may boot WITHOUT real Google creds
 * ONLY when AOA_E2E_TEST_SUPPORT === "1" (sessions come from the P6 test-mint seam,
 * never real OAuth). Prod cloud_auth still hard-requires Google creds.
 */
export function allowCloudAuthBootWithoutGoogle(
  deploymentMode: DeploymentMode,
  e2eTestSupport: boolean,
): boolean {
  return deploymentMode === "cloud_auth" && e2eTestSupport;
}
```

```ts
// server/src/auth/better-auth.ts:256-267 — relax assertAuthProviderConfigured.
// Default the flag from env (matches config.ts env-read pattern) but accept an
// override for unit tests. The throw message is UNCHANGED.
export function assertAuthProviderConfigured(
  config: Config,
  e2eTestSupport: boolean = process.env.AOA_E2E_TEST_SUPPORT === "1",
): void {
  const hasGoogle = Boolean(config.googleClientId && config.googleClientSecret);
  if (hasGoogle) return;
  if (config.deploymentMode === "local_trusted" && config.devLocalIdentity) return;
  if (allowCloudAuthBootWithoutGoogle(config.deploymentMode, e2eTestSupport)) return; // e2e-only
  throw new Error(
    "Google OAuth is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET). " +
      "It is the only sign-in provider; set both before starting the server" +
      (config.deploymentMode === "local_trusted"
        ? ", or set AOA_DEV_LOCAL_IDENTITY=1 for local development."
        : "."),
  );
}
```

```ts
// server/src/auth/better-auth.ts — buildBetterAuthConfig signature gains an optional
// flag (back-compatible; createBetterAuthInstance passes it). Replace the
// socialProviders block (:174-181):
export function buildBetterAuthConfig(
  db: Db,
  config: Config,
  trustedOrigins: string[],
  secret: string,
  e2eTestSupport: boolean = process.env.AOA_E2E_TEST_SUPPORT === "1",
): Record<string, unknown> {
  // ...unchanged setup...
  if (config.googleClientId && config.googleClientSecret) {
    authConfig.socialProviders = {
      google: { clientId: config.googleClientId, clientSecret: config.googleClientSecret },
    };
  } else if (allowCloudAuthBootWithoutGoogle(config.deploymentMode, e2eTestSupport)) {
    // e2e stub: mount a no-op Google provider so /api/auth/* routes exist; real
    // sessions are minted by the P6 test-support seam, never by this provider.
    authConfig.socialProviders = { google: { clientId: "e2e-stub-client", clientSecret: "e2e-stub-secret" } };
  }
  // ...rest unchanged...
}
```

Thread the flag through `createBetterAuthInstance` (`better-auth.ts:269-274`): pass `process.env.AOA_E2E_TEST_SUPPORT === "1"` into `buildBetterAuthConfig(...)` so runtime boot honors it too (P6 wires the real seam; here we only enable the stub-provider boot path). No change needed at `assertAuthProviderConfigured` call site — its default already reads the env.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/server test -- cloud-auth-test-boot`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/auth/better-auth.ts server/src/__tests__/cloud-auth-test-boot.test.ts
git commit -m "feat(mt): cloud_auth boots without Google creds under AOA_E2E_TEST_SUPPORT (e2e-only, prod-safe)"
```

---

## Task 11: Security regression suite — all four paths inert, self-hosted preserved, invited joins correct org

**Files:**
- Create: `server/src/__tests__/cloud-auth-promotion-paths-inert.test.ts`
- Create: `server/src/__tests__/cloud-auth-no-instance-admin-minted.test.ts` (defense-in-depth, item 2)
- Create: `server/src/__tests__/invited-joins-correct-org.test.ts`
- Modify: `server/src/services/join-approval.ts:195` region (ensure org membership on approve)

- [ ] **Step 1: Write the failing test — all four promotion paths inert in cloud_auth**

```ts
// server/src/__tests__/cloud-auth-promotion-paths-inert.test.ts
import { describe, it, expect } from "vitest";
import { instanceAdminBootstrapEnabled } from "../services/first-user-bootstrap.js";
import { bootstrapCeoPromotionAllowed } from "../routes/access.js";
import { buildBetterAuthConfig } from "../auth/better-auth.js";
import { claimBoardOwnership } from "../board-claim.js";

const cfg = { deploymentMode: "cloud_auth", deploymentExposure: "public", authBaseUrlMode: "explicit",
  authPublicBaseUrl: "https://a.example.com", googleClientId: "x", googleClientSecret: "y", headlessBootstrap: false } as any;
const db: any = { select: () => ({ from: () => ({ where: async () => [] }) }) };

describe("cloud_auth: all four instance_admin promotion paths are inert", () => {
  it("(1) better-auth user.create hook is not wired", () => {
    expect((buildBetterAuthConfig(db, cfg, [], "s") as any).databaseHooks?.user?.create?.after).toBeUndefined();
  });
  it("(2) better-auth session.create hook is not wired", () => {
    expect((buildBetterAuthConfig(db, cfg, [], "s") as any).databaseHooks?.session?.create?.after).toBeUndefined();
  });
  it("(3) bootstrap_ceo promotion is disallowed", () => {
    expect(bootstrapCeoPromotionAllowed("cloud_auth")).toBe(false);
  });
  it("(4) board-claim is inert", async () => {
    expect((await claimBoardOwnership(db, { token: "t", code: "c", userId: "u", deploymentMode: "cloud_auth" } as any)).status).toBe("invalid");
  });
  it("chokepoint agrees", () => {
    expect(instanceAdminBootstrapEnabled("cloud_auth")).toBe(false);
    expect(instanceAdminBootstrapEnabled("authenticated")).toBe(true); // self-hosted preserved
  });
});
```

- [ ] **Step 2: Run to verify it passes (paths already gated in Tasks 7/8/10)**

Run: `pnpm --filter @armyofagents/server test -- cloud-auth-promotion-paths-inert`
Expected: PASS (this is the aggregate lock-in; if any sub-case FAILS, the corresponding task regressed).

- [ ] **Step 2b: Write the defense-in-depth test — cloud_auth mints ZERO `instance_user_roles` rows (item 2)**

> Belt to P3's force-false suspenders: even if a stray `instance_user_roles` row somehow existed, P3's actor-middleware neutralizes it — but P2 must PROVE that no request-driven path mints one. This asserts the boot invariant PLUS a per-path negative: an insert/transaction spy that **throws if any write is attempted**, so a regression that reintroduces a promotion write fails loudly here.

```ts
// server/src/__tests__/cloud-auth-no-instance-admin-minted.test.ts
import { describe, it, expect } from "vitest";
import { assertInstanceAdminBootstrapInvariant } from "../services/first-user-bootstrap.js";
import { bootstrapCeoPromotionAllowed } from "../routes/access.js";
import { buildBetterAuthConfig } from "../auth/better-auth.js";
import { claimBoardOwnership } from "../board-claim.js";

const cfg = { deploymentMode: "cloud_auth", deploymentExposure: "public", authBaseUrlMode: "explicit",
  authPublicBaseUrl: "https://a.example.com", googleClientId: "x", googleClientSecret: "y", headlessBootstrap: false } as any;

// A db that RECORDS reads but EXPLODES on any write — proves no row is minted.
function noWriteDb() {
  const boom = () => { throw new Error("UNEXPECTED WRITE: cloud_auth must mint no instance_user_roles row"); };
  return {
    select: () => ({ from: () => ({ where: async () => [] }) }),
    insert: boom,
    update: boom,
    delete: boom,
    transaction: boom, // board-claim's promotion write lives inside a transaction
  } as any;
}

describe("cloud_auth mints ZERO instance_user_roles rows (defense-in-depth)", () => {
  it("boot invariant holds", () => {
    expect(() => assertInstanceAdminBootstrapInvariant({ deploymentMode: "cloud_auth" })).not.toThrow();
  });
  it("(1)+(2) neither better-auth hook is wired, so attemptFirstAdminBootstrap can never run", () => {
    const built = buildBetterAuthConfig(noWriteDb(), cfg, [], "s") as any;
    expect(built.databaseHooks?.user?.create?.after).toBeUndefined();
    expect(built.databaseHooks?.session?.create?.after).toBeUndefined();
  });
  it("(3) bootstrap_ceo promotion gate is closed, so promoteInstanceAdmin (the only insert) is unreachable", () => {
    expect(bootstrapCeoPromotionAllowed("cloud_auth")).toBe(false);
  });
  it("(4) board-claim short-circuits BEFORE its transaction — the no-write db is never touched", async () => {
    const r = await claimBoardOwnership(noWriteDb(), { token: "t", code: "c", userId: "u", deploymentMode: "cloud_auth" } as any);
    expect(r.status).toBe("invalid"); // did NOT throw ⇒ transaction/insert never attempted
  });
});
```

- [ ] **Step 2c: Run to verify it passes**

Run: `pnpm --filter @armyofagents/server test -- cloud-auth-no-instance-admin-minted`
Expected: PASS (no write attempted on any of the four paths; boot invariant holds). A FAIL here means a promotion write was reintroduced — investigate the offending path before proceeding.

- [ ] **Step 3: Write the failing test — invited user joins the correct org**

```ts
// server/src/__tests__/invited-joins-correct-org.test.ts
import { describe, it, expect, vi } from "vitest";
import { approveJoinRequest } from "../services/join-approval.js"; // existing entry (see :110-209)

describe("invited user joins the correct Organization", () => {
  it("ensures org membership for the invited company's tenant only", async () => {
    const ensureMembership = vi.fn(async () => {});
    const ensureOrgMembership = vi.fn(async () => "m1");
    const setPrincipalGrants = vi.fn(async () => {});
    // company C1 belongs to org T1
    const services: any = {
      access: { ensureMembership, setPrincipalGrants },
      orgAccess: { ensureOrgMembership },
      team: { applyInviteRole: vi.fn(async () => {}) },
      resolveCompanyOrg: vi.fn(async () => "T1"),
    };
    await approveJoinRequest({ companyId: "C1", requestId: "r1", requestingUserId: "u9",
      invite: { defaultsPayload: {} }, attributionUserId: "admin" } as any, services);
    expect(ensureMembership).toHaveBeenCalledWith("C1", "user", "u9", "member", "active");
    expect(ensureOrgMembership).toHaveBeenCalledWith("T1", "u9", "member");
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `pnpm --filter @armyofagents/server test -- invited-joins-correct-org`
Expected: FAIL — approve path does not ensure org membership.

- [ ] **Step 5: Implement — org membership on approve**

```ts
// server/src/services/join-approval.ts — after the ensureMembership call (:195),
// derive the company's org and ensure a member-role org membership so an invited
// teammate lands in the SAME tenant as the company. Pass orgAccess + a resolver in
// the services bag (thread from the caller in routes/access.ts approve handler).
const organizationId = await services.resolveCompanyOrg(args.companyId);
if (organizationId) {
  await services.orgAccess.ensureOrgMembership(organizationId, args.requestingUserId, "member");
}
```

Wire `orgAccess` + `resolveCompanyOrg` (a one-line `companies.organizationId` lookup) into the services object where `approveJoinRequest` is constructed in `server/src/routes/access.ts`.

- [ ] **Step 6: Run to verify it passes**

Run: `pnpm --filter @armyofagents/server test -- invited-joins-correct-org`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add server/src/__tests__/cloud-auth-promotion-paths-inert.test.ts server/src/__tests__/cloud-auth-no-instance-admin-minted.test.ts server/src/__tests__/invited-joins-correct-org.test.ts server/src/services/join-approval.ts server/src/routes/access.ts
git commit -m "test(mt): cloud_auth mints zero instance_admin (four paths inert + no-write) + invited joins correct org"
```

---

## Task 12: UI journey wiring — org context + create-org step registration

**Files:**
- Modify: `ui/src/onboarding/registry.ts` (add `organizationId`/`setOrganizationId` to step ctx)
- Modify: `ui/src/onboarding/steps/index.ts` (register `CreateOrganizationStep` before `OrgStep` in the founder sequence)
- Modify: `ui/src/context/CompanyContext.tsx:28-32` (`createCompany` accepts `organizationId`)
- Test: `ui/src/onboarding/steps/__tests__/OrgStep.test.tsx` (update expectation to `COMPANY_CREATED` + `organizationId` passthrough)

- [ ] **Step 1: Update the failing test**

```tsx
// ui/src/onboarding/steps/__tests__/OrgStep.test.tsx (adjust existing expectations)
// createCompany is now called with an organizationId taken from ctx, and the
// advance requests COMPANY_CREATED.
expect(createCompany).toHaveBeenCalledWith({ name: "Acme", organizationId: "org1" });
// ...and the advanceOnboarding mock asserts requestedState: "COMPANY_CREATED".
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @armyofagents/ui test -- OrgStep`
Expected: FAIL — `organizationId` not passed; state still `ORGANIZATION_CREATED`.

- [ ] **Step 3: Implement**

```tsx
// ui/src/context/CompanyContext.tsx:28 — extend createCompany signature:
  createCompany: (data: { name: string; organizationId: string; description?: string | null; budgetMonthlyCents?: number }) => Promise<Company>;
// and forward organizationId in the POST body.

// ui/src/onboarding/registry.ts — add to the step ctx type:
//   organizationId: string | null;
//   setOrganizationId?: (id: string) => void;

// ui/src/onboarding/steps/OrgStep.tsx:69 — pass ctx.organizationId:
const company = resumableCompany ?? (await createCompany({ name: name.trim(), organizationId: ctx.organizationId! }));

// ui/src/onboarding/steps/index.ts — register CreateOrganizationStep as the founder
// step BEFORE OrgStep (order index between PROFILE_SET and COMPANY_CREATED).
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @armyofagents/ui test -- OrgStep CreateOrganizationStep`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add ui/src/onboarding/registry.ts ui/src/onboarding/steps/index.ts ui/src/onboarding/steps/OrgStep.tsx ui/src/context/CompanyContext.tsx ui/src/onboarding/steps/__tests__/OrgStep.test.tsx
git commit -m "feat(mt): wire org-first onboarding + createCompany organizationId"
```

---

## Task 13: Full-suite verification + typecheck

- [ ] **Step 1: Typecheck all packages**

Run: `pnpm -r typecheck`
Expected: PASS (no unresolved `organizationId`, no dangling `ORGANIZATION_CREATED`).

- [ ] **Step 2: Run the server + shared + ui suites**

Run: `pnpm --filter @armyofagents/server test` then `pnpm --filter @armyofagents/shared test` then `pnpm --filter @armyofagents/ui test`
Expected: PASS (Windows skips `*.integration.test.ts` + e2e per CLAUDE.md; those run on Linux CI).

- [ ] **Step 3: Contract-sync checks**

Run: `pnpm gen:tools:check && pnpm gen:tools:md:check && pnpm gen:skills:check`
Expected: PASS (no drift; if the org role surfaces in any generated contract, regenerate).

- [ ] **Step 4: Commit any regenerated artifacts**

```bash
git add -A
git commit -m "chore(mt): regenerate contracts + green full suite for phase 2"
```

---

## Self-Review checklist (run after writing)

1. **Spec coverage:** org-first resolver (Task 9), org role×capability matrix (Task 5), `POST /organizations` (Task 6), all four promotion sites gated (Tasks 7,8,10 + aggregate Task 11), atomic gate-swap (Task 10), security tests — first cloud_auth user NOT admin (Task 10), invited joins correct org (Task 11), self-hosted still auto-provisions (Tasks 10/11), tenant-hop rejected (Task 10), all four inert (Task 11). ✓
2. **Placeholder scan:** every code step shows real code; no TBD/TODO. ✓
3. **Type consistency:** `instanceAdminBootstrapEnabled` (Task 4) reused in Tasks 7/8/10/11; `organizationAccessService.canOrg/ensureOrgMembership/ensureOrgOwner/listOrgMemberships` names consistent across Tasks 5/6/9/10/11; `COMPANY_CREATED` used in Tasks 2/3/12; `organizationId` used in company create Tasks 10/12 and validator. ✓
4. **Cross-phase boundaries (reconciled):** Phase 2 CONSUMES (never creates) — `organization_memberships` table + `0188` backfill (P1), `ORGANIZATION_ROLES` constant (P1), `DEPLOYMENT_MODES` `cloud_auth` constant (P1), `services/organizations.ts` factory + `DEFAULT_ORGANIZATION_ID` (P1, extended not replaced). Phase 2 OWNS — `config-schema.ts` cloud_auth validation, the atomic hook-gating, `POST /organizations`, `organizationAccessService`. Phase 3 is LAST-WRITER on the `companies.ts` create/list handler gate (Phase 2's gate is lockout-scoped only). `organizationId` on `createCompanySchema` is OPTIONAL; route derives `DEFAULT_ORGANIZATION_ID`. Company step rename (COMPANY_CREATED + CreateOrganizationStep + copy) is Phase 2's (item 7). ✓
5. **Eng-review coordination (B1 + defense-in-depth):** the actor-middleware `isInstanceAdmin` force-false in `cloud_auth` is P3's (`server/src/middleware/auth.ts:~82,~154`); P2 only guarantees `config.deploymentMode` is in scope there (Task 10, noted, NO behavior change). P2's belt is `cloud-auth-no-instance-admin-minted.test.ts` (Task 11 Step 2b) — boot invariant + a per-path no-write assertion proving cloud_auth mints ZERO `instance_user_roles` rows via any request-driven path. ✓
6. **cloud_auth e2e boot (Task 10b, unblocks P6 §4.0b):** `cloud_auth` boots WITHOUT real Google creds ONLY under `AOA_E2E_TEST_SUPPORT === "1"` (stub provider; sessions from the P6 test-mint seam). Prod cloud_auth still hard-requires Google creds (test: refuses to boot when the flag is unset). The Google-creds gate lives in `assertAuthProviderConfigured`/`buildBetterAuthConfig` (`better-auth.ts`), NOT the `config-schema.ts` superRefine (which holds no Google creds) — reconciled. Cross-phase dep: must NOT merge ahead of P6 §4.0's fail-closed guard that refuses `AOA_E2E_TEST_SUPPORT` on a real public deployment. ✓

## Lockout invariant (do not reorder past this)

Tasks 7 and 8 only *remove* secondary promotion paths in cloud_auth while the better-auth hooks still promote — safe before the cutover. **Task 10 is the only commit that removes the first-user hooks, and it removes them in the same commit that opens company-create to org owners and adds `POST /organizations` (Task 6, landed earlier).** Never split Task 10's hook-gating from its gate-swap.

## Execution Handoff

Plan complete. Recommended: **Subagent-Driven** execution (REQUIRED SUB-SKILL: superpowers:subagent-driven-development) — fresh subagent per task, two-stage review between tasks, with a hard gate that Task 10 lands as a single atomic commit.
