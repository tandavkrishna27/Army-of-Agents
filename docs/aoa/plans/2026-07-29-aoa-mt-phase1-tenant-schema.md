# AoA Multi-Tenant Cloud — Phase 1: Organization (Tenant) Schema + Backfill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce an `Organization` tenant parent above `Company` (new `organizations`, `organization_memberships`, `organization_invitations` tables + an `organization_id` FK on `companies`), backfill every existing company into one default Organization, and re-scope the two globally-unique company identifiers (`issue_prefix`, issue `identifier`) so a second tenant can never collide — all on one branch, preserving self-hosted single-tenant behavior byte-for-byte.

**Architecture:** A single hand-finalized, atomic migration (`0188_organizations.sql`) creates the three tables, adds `companies.organization_id` **nullable**, inserts one sentinel default Organization (`00000000-0000-0000-0000-000000000001`), backfills all companies + owner memberships from instance admins, then flips the column `NOT NULL`, adds the FK, and swaps `companies_issue_prefix_idx`→`(organization_id, issue_prefix)` and `issues_identifier_idx`→`(company_id, identifier)`. Because all existing companies land in one Organization, per-Org uniqueness degenerates to the old global uniqueness — the backfill cannot violate the new indexes. RLS readiness (Decision 3): `companies.organization_id` is the only tenant column added now; every other tenant-scoped row already carries `company_id`, so `row → company → organization` is always derivable and a later RLS phase needs **no** data backfill.

**Tech Stack:** Drizzle ORM (schema in `packages/db/src/schema/`, migrations in `packages/db/src/migrations/`), PostgreSQL, Zod validators + TS types in `packages/shared/src/`, Express services/routes in `server/src/`, Vitest (contract tests cross-platform; `*.integration.test.ts` on embedded-postgres, **Linux-only** via `describe.skipIf(process.platform !== "linux")` — Windows CI skips them).

---

## Pre-flight (READ BEFORE TASK 1)

- **DB BACKUP GATE / ONE-WAY DOOR.** `0188` is a forward-only migration — this repo has **no down-migrations and no down-runner** (`packages/db/src/client.ts` only ever rolls *forward*). Once a **second** Organization exists, the change is a one-way door: the old *global* `issue_prefix`/`identifier` unique indexes can no longer be recreated (a second tenant may legitimately share prefix `PAP`). **Before deploying `0188` to any instance with data, take a full DB snapshot.** Rollback == restore snapshot, OR (only while a single Organization still exists) a forward compensating migration that drops the FK + org-scoped indexes and restores the global indexes.
- **Atomicity.** Each migration file runs inside ONE transaction (`runInTransaction`, `client.ts:118-131`; drizzle's native `migratePg` is also per-migration transactional). So `0188`'s DDL + backfill + `SET NOT NULL` + index swap are all-or-nothing. Never split them across files.
- **Idempotency.** The manual reconcile path has auto-detection only for `CREATE TABLE`/`ADD COLUMN`/`CREATE INDEX`/`ADD CONSTRAINT` (`client.ts:365-410`) — **not** for `INSERT`/`UPDATE`. Every data statement in `0188` therefore carries its own `ON CONFLICT DO NOTHING` / `WHERE … IS NULL` guard.
- **Migration head is `0186`** (`_journal.json` tail = `0186_cold_psylocke`, idx 186). This phase adds exactly one migration: **`0188`**. Downstream ordinals are reserved: **P3 = 0189, P4 = 0190, P5 = 0191/0192** (P3 collapsed its two migrations into a single 0189). Task 16 adds a contiguity/uniqueness gate that enforces this globally.
- **RUNBOOK — lock window (item 4).** `0188`'s `issues_identifier_idx` swap is a **non-concurrent** `CREATE UNIQUE INDEX` executed inside the migration transaction, so it takes an **`ACCESS EXCLUSIVE` lock on `issues`** for the full index-build duration (and likewise a brief `ACCESS EXCLUSIVE` on `companies` for its FK add + prefix-index swap). On a fresh/beta instance this is sub-second and negligible. On a **large existing self-hosted `issues` table** it is a multi-minute stall that blocks all reads/writes to `issues` until the build completes — expect roughly the time of a full `issues` scan + index write. `CREATE INDEX CONCURRENTLY` is intentionally NOT used (it cannot run inside a transaction, which would break the file's all-or-nothing guarantee). Operators with a large `issues` table should schedule `0188` in a maintenance window.

---

## Task 1: Shared constants (Organization enums, sentinel id, `cloud_auth` mode)

**Files:**
- Modify: `packages/shared/src/constants.ts:18` (extend `DEPLOYMENT_MODES`) and append Organization constants near the membership block (`:384-405`)
- Test: `packages/shared/src/__tests__/organization-constants.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/__tests__/organization-constants.test.ts
import { describe, expect, it } from "vitest";
import {
  ORGANIZATION_STATUSES,
  ORGANIZATION_ROLES,
  ORGANIZATION_INVITATION_STATUSES,
  DEFAULT_ORGANIZATION_ID,
  DEFAULT_ORGANIZATION_SLUG,
  DEPLOYMENT_MODES,
} from "../constants.js";

describe("organization constants", () => {
  it("statuses mirror the company status vocabulary", () => {
    expect(ORGANIZATION_STATUSES).toEqual(["active", "suspended", "archived"]);
  });
  it("roles are owner|admin|member|billing (locked decision)", () => {
    expect(ORGANIZATION_ROLES).toEqual(["owner", "admin", "member", "billing"]);
  });
  it("invitation statuses cover the full lifecycle", () => {
    expect(ORGANIZATION_INVITATION_STATUSES).toEqual([
      "pending",
      "accepted",
      "revoked",
      "expired",
    ]);
  });
  it("pins the sentinel default-organization id + slug", () => {
    expect(DEFAULT_ORGANIZATION_ID).toBe("00000000-0000-0000-0000-000000000001");
    expect(DEFAULT_ORGANIZATION_SLUG).toBe("default");
  });
  it("adds cloud_auth as the third deployment mode, preserving self-hosted modes", () => {
    expect(DEPLOYMENT_MODES).toEqual(["local_trusted", "authenticated", "cloud_auth"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/shared/src/__tests__/organization-constants.test.ts`
Expected: FAIL — `ORGANIZATION_STATUSES` (and siblings) are not exported; `DEPLOYMENT_MODES` has only 2 values.

- [ ] **Step 3: Write minimal implementation**

In `packages/shared/src/constants.ts`, change line 18 from
`export const DEPLOYMENT_MODES = ["local_trusted", "authenticated"] as const;`
to:

```ts
// cloud_auth = network-private controlled-beta multi-tenant cloud (Phase 1, Decision 2).
// Self-hosted local_trusted / authenticated behavior is unchanged.
export const DEPLOYMENT_MODES = ["local_trusted", "authenticated", "cloud_auth"] as const;
```

Then append (next to `MEMBERSHIP_STATUSES`, around line 385):

```ts
export const ORGANIZATION_STATUSES = ["active", "suspended", "archived"] as const;
export type OrganizationStatus = (typeof ORGANIZATION_STATUSES)[number];

export const ORGANIZATION_ROLES = ["owner", "admin", "member", "billing"] as const;
export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

export const ORGANIZATION_INVITATION_STATUSES = [
  "pending",
  "accepted",
  "revoked",
  "expired",
] as const;
export type OrganizationInvitationStatus =
  (typeof ORGANIZATION_INVITATION_STATUSES)[number];

// Sentinel Organization that owns every company on self-hosted single-tenant
// installs and every pre-existing company after the Phase 1 backfill.
export const DEFAULT_ORGANIZATION_ID = "00000000-0000-0000-0000-000000000001";
export const DEFAULT_ORGANIZATION_SLUG = "default";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/shared/src/__tests__/organization-constants.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/constants.ts packages/shared/src/__tests__/organization-constants.test.ts
git commit -m "feat(mt): add organization constants + cloud_auth deployment mode"
```

---

## Task 2: Shared types + validators + `Company.organizationId`

**Files:**
- Create: `packages/shared/src/types/organization.ts`
- Create: `packages/shared/src/validators/organization.ts`
- Modify: `packages/shared/src/types/company.ts` (add `organizationId`)
- Modify: `packages/shared/src/index.ts` (export new type + validator symbols)
- Test: `packages/shared/src/__tests__/organization-validators.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/__tests__/organization-validators.test.ts
import { describe, expect, it } from "vitest";
import {
  createOrganizationSchema,
  inviteToOrganizationSchema,
} from "../validators/organization.js";

describe("organization validators", () => {
  it("accepts a minimal create payload and defaults plan/slug omitted", () => {
    const parsed = createOrganizationSchema.parse({ name: "Acme" });
    expect(parsed.name).toBe("Acme");
  });
  it("rejects an empty name", () => {
    expect(() => createOrganizationSchema.parse({ name: "" })).toThrow();
  });
  it("rejects a slug with uppercase or spaces", () => {
    expect(() => createOrganizationSchema.parse({ name: "Acme", slug: "Acme Inc" })).toThrow();
  });
  it("invite defaults role to member and requires a valid email", () => {
    const parsed = inviteToOrganizationSchema.parse({ email: "a@b.com" });
    expect(parsed.role).toBe("member");
    expect(() => inviteToOrganizationSchema.parse({ email: "nope" })).toThrow();
  });
  it("invite rejects a role outside owner|admin|member|billing", () => {
    expect(() =>
      inviteToOrganizationSchema.parse({ email: "a@b.com", role: "founder" }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/shared/src/__tests__/organization-validators.test.ts`
Expected: FAIL — cannot resolve `../validators/organization.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/shared/src/types/organization.ts
import type {
  OrganizationStatus,
  OrganizationRole,
  OrganizationInvitationStatus,
} from "../constants.js";

export interface Organization {
  id: string;
  name: string;
  slug: string;
  status: OrganizationStatus;
  plan: string;
  concurrencyCap: number | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrganizationMembership {
  id: string;
  organizationId: string;
  userId: string;
  role: OrganizationRole;
  status: "pending" | "active" | "suspended";
  invitedByUserId: string | null;
  joinedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrganizationInvitation {
  id: string;
  organizationId: string;
  email: string;
  role: OrganizationRole;
  status: OrganizationInvitationStatus;
  invitedByUserId: string | null;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
```

```ts
// packages/shared/src/validators/organization.ts
import { z } from "zod";
import { ORGANIZATION_ROLES } from "../constants.js";

export const createOrganizationSchema = z.object({
  name: z.string().min(1),
  // Slug is optional at create — the service slugifies the name and de-dupes.
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, "slug must be lowercase kebab-case")
    .optional(),
  plan: z.string().optional(),
});
export type CreateOrganization = z.infer<typeof createOrganizationSchema>;

export const inviteToOrganizationSchema = z.object({
  email: z.string().email(),
  role: z.enum(ORGANIZATION_ROLES).default("member"),
});
export type InviteToOrganization = z.infer<typeof inviteToOrganizationSchema>;
```

Add `organizationId: string;` to the `Company` interface in `packages/shared/src/types/company.ts` (immediately after `id: string;`):

```ts
  id: string;
  organizationId: string;
```

Add to `packages/shared/src/index.ts` (near the other company exports):

```ts
export type {
  Organization,
  OrganizationMembership,
  OrganizationInvitation,
} from "./types/organization.js";
export {
  createOrganizationSchema,
  inviteToOrganizationSchema,
  type CreateOrganization,
  type InviteToOrganization,
} from "./validators/organization.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/shared/src/__tests__/organization-validators.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types/organization.ts packages/shared/src/validators/organization.ts packages/shared/src/types/company.ts packages/shared/src/index.ts packages/shared/src/__tests__/organization-validators.test.ts
git commit -m "feat(mt): organization shared types + validators; Company.organizationId"
```

---

## Task 3: `organizations` schema table

**Files:**
- Create: `packages/db/src/schema/organizations.ts`
- Modify: `packages/db/src/schema/index.ts:1` (export beneath `companies`)
- Test: `packages/db/src/__tests__/organizations-schema.test.ts`

Follows the `goals.ts` template and the `teams.ts` `check()`/`slug` conventions.

- [ ] **Step 1: Write the failing test**

```ts
// packages/db/src/__tests__/organizations-schema.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_FILE = join(__dirname, "..", "schema", "organizations.ts");
const INDEX_FILE = join(__dirname, "..", "schema", "index.ts");

describe("organizations schema", () => {
  const src = readFileSync(SCHEMA_FILE, "utf8");
  const indexSrc = readFileSync(INDEX_FILE, "utf8");

  it("defines the organizations tenant table", () => {
    expect(src).toMatch(/pgTable\(\s*"organizations"/);
    expect(src).toMatch(/id:\s*uuid\("id"\)\.primaryKey\(\)\.defaultRandom\(\)/);
    expect(src).toMatch(/name:\s*text\("name"\)\.notNull\(\)/);
    expect(src).toMatch(/slug:\s*text\("slug"\)\.notNull\(\)/);
    expect(src).toMatch(/status:\s*text\("status"\)\.notNull\(\)\.default\("active"\)/);
    expect(src).toMatch(/plan:\s*text\("plan"\)\.notNull\(\)\.default\("beta"\)/);
    expect(src).toMatch(/concurrencyCap:\s*integer\("concurrency_cap"\)/);
    expect(src).toMatch(/createdByUserId:\s*text\("created_by_user_id"\)/);
  });

  it("makes slug GLOBALLY unique (the tenant routing handle)", () => {
    expect(src).toMatch(/uniqueIndex\("organizations_slug_uq"\)\.on\(table\.slug\)/);
  });

  it("constrains status with a check", () => {
    expect(src).toMatch(
      /check\(\s*"organizations_status_check",\s*sql`status IN \('active', 'suspended', 'archived'\)`/,
    );
  });

  it("clears created_by on user delete", () => {
    expect(src).toMatch(/createdByUserId[\s\S]*references\(\(\)\s*=>\s*authUsers\.id,\s*\{\s*onDelete:\s*"set null"\s*\}\)/);
  });

  it("is exported from the schema barrel", () => {
    expect(indexSrc).toContain('export { organizations } from "./organizations.js";');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/db/src/__tests__/organizations-schema.test.ts`
Expected: FAIL — `organizations.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/db/src/schema/organizations.ts
import { pgTable, uuid, text, integer, timestamp, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { authUsers } from "./auth.js";

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    // GLOBALLY unique tenant handle (P4 routing keys on it). slug = 'default'
    // for the sentinel Organization.
    slug: text("slug").notNull(),
    status: text("status").notNull().default("active"),
    plan: text("plan").notNull().default("beta"),
    // P5 concurrency governance dial. NULL = no org-level cap (semantics owned
    // by P5); added now so P5 needs no schema migration.
    concurrencyCap: integer("concurrency_cap"),
    createdByUserId: text("created_by_user_id").references(() => authUsers.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    slugUq: uniqueIndex("organizations_slug_uq").on(table.slug),
    statusIdx: index("organizations_status_idx").on(table.status),
    statusValid: check("organizations_status_check", sql`status IN ('active', 'suspended', 'archived')`),
  }),
);
```

Add to `packages/db/src/schema/index.ts` immediately after line 1 (`export { companies } …`):

```ts
export { organizations } from "./organizations.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/db/src/__tests__/organizations-schema.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/organizations.ts packages/db/src/schema/index.ts packages/db/src/__tests__/organizations-schema.test.ts
git commit -m "feat(mt): organizations tenant table"
```

---

## Task 4: `organization_memberships` schema table

**Files:**
- Create: `packages/db/src/schema/organization_memberships.ts`
- Modify: `packages/db/src/schema/index.ts` (export beneath `organizations`)
- Test: `packages/db/src/__tests__/organization-memberships-schema.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/db/src/__tests__/organization-memberships-schema.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_FILE = join(__dirname, "..", "schema", "organization_memberships.ts");
const INDEX_FILE = join(__dirname, "..", "schema", "index.ts");

describe("organization_memberships schema", () => {
  const src = readFileSync(SCHEMA_FILE, "utf8");
  const indexSrc = readFileSync(INDEX_FILE, "utf8");

  it("defines a human membership row", () => {
    expect(src).toMatch(/pgTable\(\s*"organization_memberships"/);
    expect(src).toMatch(/organizationId:\s*uuid\("organization_id"\)\.notNull\(\)\.references\(\(\)\s*=>\s*organizations\.id,\s*\{\s*onDelete:\s*"cascade"\s*\}\)/);
    expect(src).toMatch(/userId:\s*text\("user_id"\)\.notNull\(\)\.references\(\(\)\s*=>\s*authUsers\.id,\s*\{\s*onDelete:\s*"cascade"\s*\}\)/);
    expect(src).toMatch(/role:\s*text\("role"\)\.notNull\(\)\.default\("member"\)/);
    expect(src).toMatch(/status:\s*text\("status"\)\.notNull\(\)\.default\("active"\)/);
    expect(src).toMatch(/invitedByUserId:\s*text\("invited_by_user_id"\)/);
    expect(src).toMatch(/joinedAt:\s*timestamp\("joined_at"/);
  });

  it("is unique per (organization, user)", () => {
    expect(src).toMatch(
      /uniqueIndex\("organization_memberships_org_user_uq"\)\.on\(table\.organizationId,\s*table\.userId\)/,
    );
  });

  it("checks role and status vocabularies", () => {
    expect(src).toMatch(/organization_memberships_role_check",\s*sql`role IN \('owner', 'admin', 'member', 'billing'\)`/);
    expect(src).toMatch(/organization_memberships_status_check",\s*sql`status IN \('pending', 'active', 'suspended'\)`/);
  });

  it("is exported from the schema barrel", () => {
    expect(indexSrc).toContain('export { organizationMemberships } from "./organization_memberships.js";');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/db/src/__tests__/organization-memberships-schema.test.ts`
Expected: FAIL — file does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/db/src/schema/organization_memberships.ts
import { pgTable, uuid, text, timestamp, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "./organizations.js";
import { authUsers } from "./auth.js";

export const organizationMemberships = pgTable(
  "organization_memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    status: text("status").notNull().default("active"),
    invitedByUserId: text("invited_by_user_id").references(() => authUsers.id, { onDelete: "set null" }),
    joinedAt: timestamp("joined_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgUserUq: uniqueIndex("organization_memberships_org_user_uq").on(table.organizationId, table.userId),
    userStatusIdx: index("organization_memberships_user_status_idx").on(table.userId, table.status),
    orgStatusIdx: index("organization_memberships_org_status_idx").on(table.organizationId, table.status),
    roleValid: check("organization_memberships_role_check", sql`role IN ('owner', 'admin', 'member', 'billing')`),
    statusValid: check("organization_memberships_status_check", sql`status IN ('pending', 'active', 'suspended')`),
  }),
);
```

Add to `packages/db/src/schema/index.ts` (after the `organizations` export):

```ts
export { organizationMemberships } from "./organization_memberships.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/db/src/__tests__/organization-memberships-schema.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/organization_memberships.ts packages/db/src/schema/index.ts packages/db/src/__tests__/organization-memberships-schema.test.ts
git commit -m "feat(mt): organization_memberships table"
```

---

## Task 5: `organization_invitations` schema table

**Files:**
- Create: `packages/db/src/schema/organization_invitations.ts`
- Modify: `packages/db/src/schema/index.ts` (export beneath memberships)
- Test: `packages/db/src/__tests__/organization-invitations-schema.test.ts`

Mirrors `invites.ts` (hash-only token, expiry, revoked/accepted).

> **Intentional build-ahead:** this table ships the schema only. Org-level invitation WIRING (mint/accept routes, UI, accept flow) is a post-beta follow-up with **no consumer in this PR** — reviewers should not expect one. P1 owns the table so downstream phases inherit it without a migration.

- [ ] **Step 1: Write the failing test**

```ts
// packages/db/src/__tests__/organization-invitations-schema.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_FILE = join(__dirname, "..", "schema", "organization_invitations.ts");
const INDEX_FILE = join(__dirname, "..", "schema", "index.ts");

describe("organization_invitations schema", () => {
  const src = readFileSync(SCHEMA_FILE, "utf8");
  const indexSrc = readFileSync(INDEX_FILE, "utf8");

  it("stores hash-only tokens with expiry (never plaintext)", () => {
    expect(src).toMatch(/pgTable\(\s*"organization_invitations"/);
    expect(src).toMatch(/tokenHash:\s*text\("token_hash"\)\.notNull\(\)/);
    expect(src).not.toMatch(/token:\s*text\("token"\)/); // no plaintext column
    expect(src).toMatch(/expiresAt:\s*timestamp\("expires_at",\s*\{\s*withTimezone:\s*true\s*\}\)\.notNull\(\)/);
    expect(src).toMatch(/acceptedAt:\s*timestamp\("accepted_at"/);
    expect(src).toMatch(/revokedAt:\s*timestamp\("revoked_at"/);
    expect(src).toMatch(/email:\s*text\("email"\)\.notNull\(\)/);
  });

  it("token_hash is globally unique", () => {
    expect(src).toMatch(/uniqueIndex\("organization_invitations_token_hash_uq"\)\.on\(table\.tokenHash\)/);
  });

  it("blocks duplicate live invites via a partial unique on pending (org,email)", () => {
    expect(src).toMatch(/uniqueIndex\("organization_invitations_pending_email_uq"\)[\s\S]*\.on\(table\.organizationId,\s*table\.email\)[\s\S]*\.where\(sql`status = 'pending'`\)/);
  });

  it("is exported from the schema barrel", () => {
    expect(indexSrc).toContain('export { organizationInvitations } from "./organization_invitations.js";');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/db/src/__tests__/organization-invitations-schema.test.ts`
Expected: FAIL — file does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/db/src/schema/organization_invitations.ts
import { pgTable, uuid, text, timestamp, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "./organizations.js";
import { authUsers } from "./auth.js";

export const organizationInvitations = pgTable(
  "organization_invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").notNull().default("member"),
    // SHA-256 of a 32-byte random token; plaintext is shown once at mint time
    // and never persisted (mirrors invites.ts).
    tokenHash: text("token_hash").notNull(),
    status: text("status").notNull().default("pending"),
    invitedByUserId: text("invited_by_user_id").references(() => authUsers.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tokenHashUq: uniqueIndex("organization_invitations_token_hash_uq").on(table.tokenHash),
    orgStatusIdx: index("organization_invitations_org_status_idx").on(
      table.organizationId,
      table.status,
      table.expiresAt,
    ),
    pendingEmailUq: uniqueIndex("organization_invitations_pending_email_uq")
      .on(table.organizationId, table.email)
      .where(sql`status = 'pending'`),
    roleValid: check("organization_invitations_role_check", sql`role IN ('owner', 'admin', 'member', 'billing')`),
    statusValid: check("organization_invitations_status_check", sql`status IN ('pending', 'accepted', 'revoked', 'expired')`),
  }),
);
```

Add to `packages/db/src/schema/index.ts` (after memberships):

```ts
export { organizationInvitations } from "./organization_invitations.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/db/src/__tests__/organization-invitations-schema.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/organization_invitations.ts packages/db/src/schema/index.ts packages/db/src/__tests__/organization-invitations-schema.test.ts
git commit -m "feat(mt): organization_invitations table (hash-only tokens)"
```

---

## Task 6: Add `companies.organization_id` FK + re-scope the prefix index

**Files:**
- Modify: `packages/db/src/schema/companies.ts:1` (import), `:6` (new column), `:54-56` (index)
- Test: `packages/db/src/__tests__/companies-org-scope-schema.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/db/src/__tests__/companies-org-scope-schema.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, "..", "schema", "companies.ts"), "utf8");

describe("companies tenant FK + re-scoped prefix uniqueness", () => {
  it("adds a non-null organization_id FK with RESTRICT on org delete + sentinel DB default", () => {
    expect(src).toMatch(
      /organizationId:\s*uuid\("organization_id"\)\.notNull\(\)\.default\("00000000-0000-0000-0000-000000000001"\)\.references\(\(\)\s*=>\s*organizations\.id,\s*\{\s*onDelete:\s*"restrict"\s*\}\)/,
    );
  });
  it("re-scopes issue_prefix uniqueness to (organization_id, issue_prefix)", () => {
    expect(src).toMatch(
      /uniqueIndex\("companies_org_issue_prefix_idx"\)\.on\(table\.organizationId,\s*table\.issuePrefix\)/,
    );
    expect(src).not.toMatch(/uniqueIndex\("companies_issue_prefix_idx"\)/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/db/src/__tests__/companies-org-scope-schema.test.ts`
Expected: FAIL — no `organization_id` column; index still named `companies_issue_prefix_idx`.

- [ ] **Step 3: Write minimal implementation**

In `packages/db/src/schema/companies.ts`, add the import at the top (line 2 area, next to any relative imports — this file currently imports only from `drizzle-orm/pg-core`, so add a new line):

```ts
import { organizations } from "./organizations.js";
```

Add the column immediately after `id:` (line 6):

```ts
    id: uuid("id").primaryKey().defaultRandom(),
    // Phase 1 tenant FK. RESTRICT: an Organization cannot be deleted while it
    // still owns companies (org teardown is out of Phase 1 scope). Injected on
    // every existing row by migration 0188.
    // DB-level DEFAULT = the sentinel org: belt-and-suspenders so ANY missed
    // writer (raw e2e seeds, portability edge paths, future migrations) lands
    // in the default org instead of hitting a NOT NULL violation. SET DEFAULT
    // does NOT rewrite existing rows, so 0188's explicit backfill still runs.
    organizationId: uuid("organization_id")
      .notNull()
      .default("00000000-0000-0000-0000-000000000001")
      .references(() => organizations.id, { onDelete: "restrict" }),
```

Replace the index block (lines 54-56):

```ts
  (table) => ({
    // Re-scoped in Phase 1: prefix uniqueness is per-Organization, not global.
    // The 23505 retry in companyService keys on this constraint name.
    issuePrefixUniqueIdx: uniqueIndex("companies_org_issue_prefix_idx").on(
      table.organizationId,
      table.issuePrefix,
    ),
  }),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/db/src/__tests__/companies-org-scope-schema.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/companies.ts packages/db/src/__tests__/companies-org-scope-schema.test.ts
git commit -m "feat(mt): companies.organization_id FK + per-org prefix uniqueness"
```

---

## Task 7: Re-scope `issues_identifier_idx` to `(company_id, identifier)`

**Files:**
- Modify: `packages/db/src/schema/issues.ts:127`
- Test: `packages/db/src/__tests__/issues-identifier-scope-schema.test.ts`

Required coupling: once two companies can share prefix `PAP`, both mint `PAP-1`; the identifier is `${issuePrefix}-${number}` (`server/src/services/issues.ts:1431`). `issue_counter` is already per-company, so scoping the identifier index to `company_id` is correct and collision-free.

- [ ] **Step 1: Write the failing test**

```ts
// packages/db/src/__tests__/issues-identifier-scope-schema.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, "..", "schema", "issues.ts"), "utf8");

describe("issues identifier uniqueness is per-company", () => {
  it("scopes issues_identifier_idx to (company_id, identifier)", () => {
    expect(src).toMatch(
      /uniqueIndex\("issues_identifier_idx"\)\.on\(table\.companyId,\s*table\.identifier\)/,
    );
  });
  it("is no longer a global unique on identifier alone", () => {
    expect(src).not.toMatch(/uniqueIndex\("issues_identifier_idx"\)\.on\(table\.identifier\)/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/db/src/__tests__/issues-identifier-scope-schema.test.ts`
Expected: FAIL — index still `.on(table.identifier)`.

- [ ] **Step 3: Write minimal implementation**

In `packages/db/src/schema/issues.ts:127`, change:

```ts
    identifierIdx: uniqueIndex("issues_identifier_idx").on(table.identifier),
```

to:

```ts
    // Per-company (Phase 1): issue_counter is per-company, so PAP-1 is unique
    // within a company even when two companies (in different Orgs) share prefix.
    identifierIdx: uniqueIndex("issues_identifier_idx").on(table.companyId, table.identifier),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/db/src/__tests__/issues-identifier-scope-schema.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/issues.ts packages/db/src/__tests__/issues-identifier-scope-schema.test.ts
git commit -m "feat(mt): scope issues_identifier_idx to (company_id, identifier)"
```

---

## Task 8: Migration `0188_organizations.sql` (DDL + safe backfill) + journal + contract test

**Files:**
- Create: `packages/db/src/migrations/0188_organizations.sql`
- Modify: `packages/db/src/migrations/meta/_journal.json` (append idx-187 entry)
- Test: `server/src/__tests__/migration-0188-organizations-contract.test.ts`
- Test: `packages/db/src/__tests__/organizations-migration-journal.test.ts`

Authoring workflow (mirrors how `0069` was generated-then-hand-edited): run `pnpm --filter @armyofagents/db build && pnpm db:generate` to let drizzle-kit emit a **draft** for the schema diff, then **replace** the draft body with the verbatim SQL below (drizzle would emit an unsafe `ADD COLUMN … NOT NULL` on the populated `companies` table — that must become nullable→backfill→`SET NOT NULL`). Rename the emitted file to `0188_organizations.sql` and fix the journal `tag`.

- [ ] **Step 1: Write the failing test** (static contract, cross-platform — the pattern of `migration-0069-contract.test.ts`)

```ts
// server/src/__tests__/migration-0188-organizations-contract.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SQL = readFileSync(
  resolve(__dirname, "../../../packages/db/src/migrations/0188_organizations.sql"),
  "utf8",
);

describe("Migration 0188 — organizations + safe companies backfill", () => {
  it("creates the three tenant tables", () => {
    expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS "organizations"/);
    expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS "organization_memberships"/);
    expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS "organization_invitations"/);
  });

  it("adds companies.organization_id as NULLABLE (never NOT NULL in the ADD COLUMN)", () => {
    const addCol = SQL.match(/ALTER TABLE "companies" ADD COLUMN "organization_id" uuid;?/);
    expect(addCol).not.toBeNull();
    expect(SQL).not.toMatch(/ADD COLUMN "organization_id" uuid NOT NULL/);
  });

  it("sets a sentinel DB DEFAULT on the column (belt-and-suspenders for raw writers)", () => {
    expect(SQL).toMatch(
      /ALTER TABLE "companies" ALTER COLUMN "organization_id" SET DEFAULT '00000000-0000-0000-0000-000000000001'/,
    );
  });

  it("seeds a fallback owner (founder, else first user) when no instance_admin exists", () => {
    expect(SQL).toMatch(/user_roles/);
    expect(SQL).toMatch(/role = 'founder'/);
    expect(SQL).toMatch(/NOT EXISTS[\s\S]*"role" = 'owner'/);
    // Fallback INSERT is guarded so it never double-seeds when admins were found.
    const ownerInserts = SQL.match(/INSERT INTO "organization_memberships"/g) ?? [];
    expect(ownerInserts.length).toBeGreaterThanOrEqual(2);
  });

  it("inserts the sentinel default Organization idempotently", () => {
    expect(SQL).toMatch(/'00000000-0000-0000-0000-000000000001'/);
    expect(SQL).toMatch(/'Default Organization'/);
    expect(SQL.toLowerCase()).toContain("on conflict");
    expect(SQL.toLowerCase()).toContain("do nothing");
  });

  it("backfills every company then flips the column NOT NULL — in that order", () => {
    const backfillIdx = SQL.search(/UPDATE "companies"\s+SET "organization_id"/i);
    const notNullIdx = SQL.search(/ALTER TABLE "companies" ALTER COLUMN "organization_id" SET NOT NULL/i);
    expect(backfillIdx).toBeGreaterThanOrEqual(0);
    expect(notNullIdx).toBeGreaterThanOrEqual(0);
    expect(backfillIdx).toBeLessThan(notNullIdx);
  });

  it("guards the backfill UPDATE with WHERE organization_id IS NULL (idempotent)", () => {
    expect(SQL).toMatch(/UPDATE "companies"\s+SET "organization_id"[\s\S]*WHERE "organization_id" IS NULL/i);
  });

  it("adds the FK only AFTER the column is populated + NOT NULL", () => {
    const notNullIdx = SQL.search(/SET NOT NULL/i);
    const fkIdx = SQL.search(/ADD CONSTRAINT "companies_organization_id_organizations_id_fk"/);
    expect(fkIdx).toBeGreaterThan(notNullIdx);
    expect(SQL).toMatch(/ON DELETE restrict/);
  });

  it("backfills owner memberships from instance admins, joined to real users", () => {
    expect(SQL).toMatch(/INSERT INTO "organization_memberships"/);
    expect(SQL).toMatch(/FROM "instance_user_roles"/);
    expect(SQL).toMatch(/JOIN "user"/);
    expect(SQL).toMatch(/'owner'/);
    expect(SQL).toMatch(/role = 'instance_admin'/);
  });

  it("swaps the prefix index to (organization_id, issue_prefix)", () => {
    expect(SQL).toMatch(/DROP INDEX IF EXISTS "companies_issue_prefix_idx"/);
    expect(SQL).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "companies_org_issue_prefix_idx" ON "companies"[\s\S]*"organization_id","issue_prefix"/);
  });

  it("re-scopes issues_identifier_idx to (company_id, identifier)", () => {
    expect(SQL).toMatch(/DROP INDEX IF EXISTS "issues_identifier_idx"/);
    expect(SQL).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "issues_identifier_idx" ON "issues"[\s\S]*"company_id","identifier"/);
  });

  it("orders index swaps AFTER the backfill (org_id populated before it is indexed)", () => {
    const backfillIdx = SQL.search(/UPDATE "companies"\s+SET "organization_id"/i);
    const prefixIdx = SQL.search(/CREATE UNIQUE INDEX IF NOT EXISTS "companies_org_issue_prefix_idx"/);
    expect(prefixIdx).toBeGreaterThan(backfillIdx);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run server/src/__tests__/migration-0188-organizations-contract.test.ts`
Expected: FAIL — `0188_organizations.sql` does not exist (readFileSync throws).

- [ ] **Step 3: Write minimal implementation** — create the migration VERBATIM

```sql
-- packages/db/src/migrations/0188_organizations.sql
-- Phase 1 (multi-tenant cloud): introduce the Organization tenant parent,
-- backfill every existing company into ONE default Organization, and re-scope
-- the two globally-unique company identifiers so a second tenant can never
-- collide.
--
-- SAFETY (single atomic transaction — see packages/db/src/client.ts):
--   1. create the 3 tenant tables
--   2. ADD COLUMN companies.organization_id NULLABLE (safe on a populated table)
--   3. SET DEFAULT the sentinel org on the column (belt-and-suspenders for any
--      future/raw writer that omits organization_id; does NOT rewrite old rows)
--   4. INSERT the sentinel default Organization (idempotent)
--   5. UPDATE all companies -> default org (idempotent WHERE org_id IS NULL)
--   6. INSERT owner memberships from instance_admins (idempotent, FK-guarded)
--   7. FALLBACK owner: when NO instance_admin exists, seed the first company
--      founder (else the first user) as owner so the default org is never
--      ownerless/unadministrable in cloud_auth (idempotent, NOT EXISTS-guarded)
--   8. ALTER COLUMN ... SET NOT NULL (only after every row is populated)
--   9. ADD the FK constraint
--  10. swap companies_issue_prefix_idx -> (organization_id, issue_prefix)
--  11. swap issues_identifier_idx -> (company_id, identifier)
-- Within one default Organization, per-org uniqueness == the old global
-- uniqueness, so steps 8-9 cannot abort on existing data.
-- ONE-WAY DOOR once a second Organization exists: take a DB snapshot first.

CREATE TABLE IF NOT EXISTS "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"plan" text DEFAULT 'beta' NOT NULL,
	"concurrency_cap" integer,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_status_check" CHECK (status IN ('active', 'suspended', 'archived'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "organization_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"invited_by_user_id" text,
	"joined_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_memberships_role_check" CHECK (role IN ('owner', 'admin', 'member', 'billing')),
	CONSTRAINT "organization_memberships_status_check" CHECK (status IN ('pending', 'active', 'suspended'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "organization_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"token_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"invited_by_user_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_invitations_role_check" CHECK (role IN ('owner', 'admin', 'member', 'billing')),
	CONSTRAINT "organization_invitations_status_check" CHECK (status IN ('pending', 'accepted', 'revoked', 'expired'))
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_invited_by_user_id_user_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_invited_by_user_id_user_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "organizations_slug_uq" ON "organizations" USING btree ("slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "organizations_status_idx" ON "organizations" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "organization_memberships_org_user_uq" ON "organization_memberships" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "organization_memberships_user_status_idx" ON "organization_memberships" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "organization_memberships_org_status_idx" ON "organization_memberships" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "organization_invitations_token_hash_uq" ON "organization_invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "organization_invitations_org_status_idx" ON "organization_invitations" USING btree ("organization_id","status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "organization_invitations_pending_email_uq" ON "organization_invitations" USING btree ("organization_id","email") WHERE status = 'pending';--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
ALTER TABLE "companies" ALTER COLUMN "organization_id" SET DEFAULT '00000000-0000-0000-0000-000000000001';--> statement-breakpoint
INSERT INTO "organizations" ("id", "name", "slug", "status", "plan")
VALUES ('00000000-0000-0000-0000-000000000001', 'Default Organization', 'default', 'active', 'beta')
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
UPDATE "companies"
SET "organization_id" = '00000000-0000-0000-0000-000000000001'
WHERE "organization_id" IS NULL;--> statement-breakpoint
INSERT INTO "organization_memberships" ("organization_id", "user_id", "role", "status", "joined_at")
SELECT '00000000-0000-0000-0000-000000000001', u."id", 'owner', 'active', now()
FROM "instance_user_roles" iur
JOIN "user" u ON u."id" = iur."user_id"
WHERE iur."role" = 'instance_admin'
ON CONFLICT ("organization_id", "user_id") DO NOTHING;--> statement-breakpoint
-- Fallback owner: only fires when the instance_admin backfill above seeded NO
-- owner for the default org (e.g. an install with zero instance_admins). Picks
-- the earliest company founder (user_roles.role = 'founder'), else the earliest
-- user. A truly userless loopback install seeds nobody (fallback IS NULL) and
-- that is correct.
INSERT INTO "organization_memberships" ("organization_id", "user_id", "role", "status", "joined_at")
SELECT '00000000-0000-0000-0000-000000000001', fallback."user_id", 'owner', 'active', now()
FROM (
  SELECT COALESCE(
    (SELECT ur."user_id"
       FROM "user_roles" ur
       JOIN "user" u ON u."id" = ur."user_id"
      WHERE ur."role" = 'founder'
      ORDER BY ur."created_at" ASC
      LIMIT 1),
    (SELECT u."id" FROM "user" u ORDER BY u."created_at" ASC LIMIT 1)
  ) AS "user_id"
) fallback
WHERE fallback."user_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "organization_memberships" m
    WHERE m."organization_id" = '00000000-0000-0000-0000-000000000001'
      AND m."role" = 'owner'
  )
ON CONFLICT ("organization_id", "user_id") DO NOTHING;--> statement-breakpoint
ALTER TABLE "companies" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
DROP INDEX IF EXISTS "companies_issue_prefix_idx";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "companies_org_issue_prefix_idx" ON "companies" USING btree ("organization_id","issue_prefix");--> statement-breakpoint
DROP INDEX IF EXISTS "issues_identifier_idx";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issues_identifier_idx" ON "issues" USING btree ("company_id","identifier");
```

Append to `packages/db/src/migrations/meta/_journal.json` `entries` array (after the `0186_cold_psylocke` object; `when` must be strictly greater than 0186's):

```json
    {
      "idx": 187,
      "version": "7",
      "when": 1785312000000,
      "tag": "0188_organizations",
      "breakpoints": true
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run server/src/__tests__/migration-0188-organizations-contract.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/migrations/0188_organizations.sql packages/db/src/migrations/meta/_journal.json server/src/__tests__/migration-0188-organizations-contract.test.ts
git commit -m "feat(mt): 0188 organizations migration + safe companies backfill"
```

---

## Task 9: Journal registration test (db package)

**Files:**
- Test: `packages/db/src/__tests__/organizations-migration-journal.test.ts`

Mirrors `aoa-sentinels-migration.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/db/src/__tests__/organizations-migration-journal.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const journal = JSON.parse(
  readFileSync(join(__dirname, "..", "migrations", "meta", "_journal.json"), "utf8"),
) as { entries: Array<{ idx: number; version: string; tag: string; breakpoints: boolean }> };

const entry = journal.entries.find((e) => e.tag === "0188_organizations");

describe("0188 journal registration", () => {
  it("is registered at idx 187", () => {
    expect(entry).toBeDefined();
    expect(entry?.idx).toBe(187);
  });
  it("matches the journal version 7 with breakpoints", () => {
    expect(entry?.version).toBe("7");
    expect(entry?.breakpoints).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

(If Task 8's journal edit is already present this passes immediately; if executing tasks out of order it fails with "entry undefined".)
Run: `pnpm exec vitest run packages/db/src/__tests__/organizations-migration-journal.test.ts`
Expected: PASS (journal entry added in Task 8) — this task locks that guarantee with a dedicated regression test.

- [ ] **Step 3: Write minimal implementation**

No code — the journal entry was added in Task 8. If the entry is missing, add the JSON object from Task 8 Step 3.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/db/src/__tests__/organizations-migration-journal.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/__tests__/organizations-migration-journal.test.ts
git commit -m "test(mt): pin 0188 journal registration at idx 187"
```

---

## Task 10: `organizationService` + `ensureDefaultOrganization`

**Files:**
- Create: `server/src/services/organizations.ts`
- Modify: `server/src/services/index.ts` (export `organizationService` — add next to `companyService`)
- Test: `server/src/services/__tests__/organizations-service.test.ts`

Follows the `companyService(db)` factory + unique-allocation-retry pattern (`server/src/services/companies.ts:67-201`). Pure helpers are exported for unit testing (as `goals.ts` exports `isScopeWithinParent`).

- [ ] **Step 1: Write the failing test**

```ts
// server/src/services/__tests__/organizations-service.test.ts
import { describe, expect, it } from "vitest";
import { slugifyOrganizationName, isOrgSlugConflict } from "../organizations.js";

describe("organizationService pure helpers", () => {
  it("slugifies a name to lowercase kebab-case", () => {
    expect(slugifyOrganizationName("Acme, Inc.")).toBe("acme-inc");
    expect(slugifyOrganizationName("  Hello   World  ")).toBe("hello-world");
  });
  it("falls back to 'org' for a name with no alphanumerics", () => {
    expect(slugifyOrganizationName("***")).toBe("org");
  });
  it("detects a 23505 conflict on organizations_slug_uq (nested cause chain)", () => {
    const err = { cause: { code: "23505", constraint: "organizations_slug_uq" } };
    expect(isOrgSlugConflict(err)).toBe(true);
  });
  it("ignores unrelated 23505s", () => {
    const err = { code: "23505", constraint: "some_other_uq" };
    expect(isOrgSlugConflict(err)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run server/src/services/__tests__/organizations-service.test.ts`
Expected: FAIL — cannot resolve `../organizations.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/services/organizations.ts
import { eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { organizations, organizationMemberships } from "@armyofagents/db";
import { DEFAULT_ORGANIZATION_ID, DEFAULT_ORGANIZATION_SLUG } from "@armyofagents/shared";

/** Lowercase kebab-case slug base; falls back to "org" when name has no [a-z0-9]. */
export function slugifyOrganizationName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "org";
}

/** Walks the error cause-chain for a 23505 on organizations_slug_uq. */
export function isOrgSlugConflict(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const c = current as { cause?: unknown; code?: unknown; constraint?: unknown; constraint_name?: unknown };
    const constraint =
      typeof c.constraint === "string" ? c.constraint
      : typeof c.constraint_name === "string" ? c.constraint_name
      : undefined;
    if (c.code === "23505" && constraint === "organizations_slug_uq") return true;
    current = c.cause;
  }
  return false;
}

export function organizationService(db: Db) {
  return {
    getById: (id: string) =>
      db.select().from(organizations).where(eq(organizations.id, id)).then((r) => r[0] ?? null),

    /**
     * Guarantee the sentinel default Organization exists. Idempotent — safe to
     * call on every boot. Underpins self-hosted single-tenant + fresh installs.
     */
    ensureDefaultOrganization: async () => {
      await db
        .insert(organizations)
        .values({
          id: DEFAULT_ORGANIZATION_ID,
          name: "Default Organization",
          slug: DEFAULT_ORGANIZATION_SLUG,
          status: "active",
          plan: "beta",
        })
        .onConflictDoNothing({ target: organizations.id });
      return DEFAULT_ORGANIZATION_ID;
    },

    /** Create an Organization, de-duping the slug with a numeric suffix. */
    create: async (data: { name: string; slug?: string; plan?: string; createdByUserId?: string | null }) => {
      const base = data.slug ? slugifyOrganizationName(data.slug) : slugifyOrganizationName(data.name);
      let attempt = 0;
      while (attempt < 10000) {
        const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
        try {
          const rows = await db
            .insert(organizations)
            .values({
              name: data.name,
              slug: candidate,
              plan: data.plan ?? "beta",
              createdByUserId: data.createdByUserId ?? null,
            })
            .returning();
          const org = rows[0];
          if (data.createdByUserId) {
            await db
              .insert(organizationMemberships)
              .values({
                organizationId: org.id,
                userId: data.createdByUserId,
                role: "owner",
                status: "active",
                joinedAt: new Date(),
              })
              .onConflictDoNothing({
                target: [organizationMemberships.organizationId, organizationMemberships.userId],
              });
          }
          return org;
        } catch (error) {
          if (!isOrgSlugConflict(error)) throw error;
        }
        attempt += 1;
      }
      throw new Error("Unable to allocate unique organization slug");
    },
  };
}
```

Add to `server/src/services/index.ts` next to the `companyService` export:

```ts
export { organizationService, ensureDefaultOrganization as _unusedEnsure } from "./organizations.js";
```

(If `services/index.ts` re-exports via `export * from`, add `export * from "./organizations.js";` instead — match the file's existing style; do NOT introduce an unused alias.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run server/src/services/__tests__/organizations-service.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/services/organizations.ts server/src/services/index.ts server/src/services/__tests__/organizations-service.test.ts
git commit -m "feat(mt): organizationService + ensureDefaultOrganization"
```

---

## Task 11: `companyService` — inject `organization_id` + rename the 23505 handler (lockstep)

**Files:**
- Modify: `server/src/services/companies.ts:98` (constraint name), `:108-120` (insert input type + org default)
- Test: `server/src/__tests__/company-service-org-scope.test.ts`

Critical: the schema index was renamed to `companies_org_issue_prefix_idx` in Task 6. If `isIssuePrefixConflict` still matches the old name, the first same-name collision **throws** instead of auto-suffixing. Rename in lockstep. Also default `organization_id` to the sentinel so every existing caller (company-portability import → `companyService`, `packages/db/src/seed.ts`) keeps working on self-hosted single-tenant.

> This app-level default is the FIRST line; the column's DB-level `DEFAULT` (Task 6 / migration Task 8) is the true safety net that also catches raw inserts that never reach this service. Keeping both is deliberate defence-in-depth.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/company-service-org-scope.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(resolve(__dirname, "../services/companies.ts"), "utf8");

describe("companyService org-scoping + 23505 handler rename", () => {
  it("keys the prefix-conflict handler on the re-scoped constraint name", () => {
    expect(SRC).toContain('constraint === "companies_org_issue_prefix_idx"');
    expect(SRC).not.toContain('constraint === "companies_issue_prefix_idx"');
  });
  it("defaults organization_id to the sentinel on insert (back-compat)", () => {
    expect(SRC).toContain("DEFAULT_ORGANIZATION_ID");
    expect(SRC).toMatch(/organizationId:\s*data\.organizationId\s*\?\?\s*DEFAULT_ORGANIZATION_ID/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run server/src/__tests__/company-service-org-scope.test.ts`
Expected: FAIL — handler still names `companies_issue_prefix_idx`; no `DEFAULT_ORGANIZATION_ID` usage.

- [ ] **Step 3: Write minimal implementation**

Add the import at the top of `server/src/services/companies.ts` (with the other `@armyofagents/shared` / local imports):

```ts
import { DEFAULT_ORGANIZATION_ID } from "@armyofagents/shared";
```

At line 98, change:

```ts
      if (candidate.code === "23505" && constraint === "companies_issue_prefix_idx") {
```

to:

```ts
      if (candidate.code === "23505" && constraint === "companies_org_issue_prefix_idx") {
```

Change the `createCompanyWithUniquePrefix` signature (line 108) so the caller may omit `organizationId`, and default it on insert. Replace the signature + the `.values(...)` call:

```ts
  async function createCompanyWithUniquePrefix(
    data: Omit<typeof companies.$inferInsert, "organizationId"> & { organizationId?: string },
    opts: CreateCompanyOptions = {},
  ) {
```

and the insert (line ~117-120):

```ts
        const rows = await db
          .insert(companies)
          .values({
            ...data,
            // Self-hosted single-tenant + company-portability import land in the
            // sentinel Organization unless a real org context is supplied.
            organizationId: data.organizationId ?? DEFAULT_ORGANIZATION_ID,
            issuePrefix: candidate,
          })
          .returning();
```

Update the public `create` wrapper's parameter type (line ~213) to the same `Omit<…> & { organizationId?: string }` shape so callers compile.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run server/src/__tests__/company-service-org-scope.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/services/companies.ts server/src/__tests__/company-service-org-scope.test.ts
git commit -m "fix(mt): rename prefix 23505 handler + default company organization_id"
```

---

## Task 12: Wire `organization_id` at company create + ensure default org at startup

**Files:**
- Modify: `server/src/routes/companies.ts:158-161` (pass `organizationId`)
- Modify: `server/src/index.ts` (call `ensureDefaultOrganization` after migrations, before serving) **or** `server/src/app.ts` bootstrap
- Modify: `packages/db/src/seed.ts:12` (dev seed sets `organizationId` + seeds the default org)
- Test: `server/src/__tests__/companies-create-org-default.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/companies-create-org-default.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROUTES = readFileSync(resolve(__dirname, "../routes/companies.ts"), "utf8");
const INDEX = readFileSync(resolve(__dirname, "../index.ts"), "utf8");

describe("company create attaches an organization + startup ensures default org", () => {
  it("passes organizationId into svc.create (sentinel in single-tenant)", () => {
    expect(ROUTES).toContain("DEFAULT_ORGANIZATION_ID");
    expect(ROUTES).toMatch(/organizationId:/);
  });
  it("ensures the default organization on boot", () => {
    expect(INDEX).toContain("ensureDefaultOrganization");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run server/src/__tests__/companies-create-org-default.test.ts`
Expected: FAIL — route does not reference `DEFAULT_ORGANIZATION_ID`; index does not call `ensureDefaultOrganization`.

- [ ] **Step 3: Write minimal implementation**

In `server/src/routes/companies.ts`, add the import (with the other `@armyofagents/shared` imports) and pass the org id. Change the `svc.create(...)` call (lines 158-161):

```ts
    // Single-tenant / self-hosted: attach to the sentinel Organization. In
    // cloud_auth, later phases resolve the caller's real org context here.
    const organizationId = DEFAULT_ORGANIZATION_ID;
    const company = await svc.create(
      { ...req.body, requireBoardApprovalForNewAgents, organizationId },
      { requestedByUserId: req.actor.userId ?? null },
    );
```

Add to the imports at the top of `server/src/routes/companies.ts`:

```ts
import { DEFAULT_ORGANIZATION_ID } from "@armyofagents/shared";
```

In `server/src/index.ts`, immediately AFTER migrations are applied and BEFORE the HTTP server starts listening, add:

```ts
import { organizationService } from "./services/organizations.js";
// … after applyPendingMigrations(...) / migratePostgresIfEmpty(...):
await organizationService(db).ensureDefaultOrganization();
```

(Place the `await` where the DB handle `db` is already in scope — right after the existing migration bootstrap, mirroring where other one-time seeders run.)

In `packages/db/src/seed.ts`, before inserting the demo company (line 12), ensure the default org and stamp it on the seed company:

```ts
import { DEFAULT_ORGANIZATION_ID, DEFAULT_ORGANIZATION_SLUG } from "@armyofagents/shared";
// …
await db
  .insert(organizations)
  .values({ id: DEFAULT_ORGANIZATION_ID, name: "Default Organization", slug: DEFAULT_ORGANIZATION_SLUG })
  .onConflictDoNothing({ target: organizations.id });
// then add organizationId: DEFAULT_ORGANIZATION_ID to the companies insert values
```

(Add `organizations` to the seed's `@armyofagents/db` import.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run server/src/__tests__/companies-create-org-default.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/companies.ts server/src/index.ts packages/db/src/seed.ts server/src/__tests__/companies-create-org-default.test.ts
git commit -m "feat(mt): attach organization at company create + ensure default org on boot"
```

---

## Task 13: Backfill correctness — embedded-postgres integration test (Linux-only)

**Files:**
- Test: `server/src/__tests__/organizations-backfill.integration.test.ts`

Harness copied from `companies-delete-integration.test.ts:60-102` (embedded-postgres + `applyPendingMigrations`), gated `describe.skipIf(process.platform !== "linux")` (Windows CI skips `*.integration.test.ts`).

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/organizations-backfill.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { DEFAULT_ORGANIZATION_ID } from "@armyofagents/shared";
import { companyService } from "../services/companies.js";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";

type PG = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
let pg: PG | null = null;
let dataDir = "";
let db: Db;
let setupError: unknown = null;

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-org-backfill-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as { default: any };
    const port = await allocateEmbeddedPgPort();
    pg = new EmbeddedPostgres({ databaseDir: join(dataDir, "db"), user: "test", password: "test", port, persistent: false });
    await pg.initialise();
    await pg.start();
    const conn = `postgres://test:test@localhost:${port}/postgres`;
    await applyPendingMigrations(conn);
    db = createDb(conn);
  } catch (err) {
    setupError = err;
    // eslint-disable-next-line no-console
    console.error("[organizations-backfill] setup failed:", err);
  }
}, 180_000);

afterAll(async () => {
  try { if (pg) await pg.stop(); } catch { /* ignore */ }
  try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}, 60_000);

describe.skipIf(process.platform !== "linux")("0188 backfill — real DB", () => {
  it("creates exactly one sentinel default organization", async () => {
    if (setupError) throw new Error(String(setupError));
    const rows = await db.execute(sql`SELECT id, slug FROM organizations WHERE id = ${DEFAULT_ORGANIZATION_ID}`);
    const arr = Array.isArray(rows) ? rows : (rows as any).rows;
    expect(arr.length).toBe(1);
    expect(arr[0].slug).toBe("default");
  });

  it("attaches every created company to the default org and enforces NOT NULL", async () => {
    const company = await companyService(db).create({ name: "Backfill Co" });
    const rows = await db.execute(sql`SELECT organization_id FROM companies WHERE id = ${company.id}`);
    const arr = Array.isArray(rows) ? rows : (rows as any).rows;
    expect(arr[0].organization_id).toBe(DEFAULT_ORGANIZATION_ID);

    await expect(
      db.execute(sql`INSERT INTO companies (name, issue_prefix) VALUES ('NoOrg', 'NUL')`),
    ).rejects.toThrow(); // organization_id is NOT NULL
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (on Linux, or WSL): `pnpm exec vitest run server/src/__tests__/organizations-backfill.integration.test.ts`
Expected: FAIL first if run before Tasks 8/11 land (migration/service missing); on Windows it is SKIPPED (0 assertions run) — this is expected and honest.

- [ ] **Step 3: Write minimal implementation**

No production code — this test exercises Tasks 8/11/12. If it fails on Linux, the failure is a real backfill defect to fix in `0188`/`companies.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run (Linux): `pnpm exec vitest run server/src/__tests__/organizations-backfill.integration.test.ts`
Expected: PASS (Linux) / SKIPPED (Windows/macOS-advisory).

- [ ] **Step 5: Commit**

```bash
git add server/src/__tests__/organizations-backfill.integration.test.ts
git commit -m "test(mt): embedded-pg backfill correctness for 0188 (linux-only)"
```

---

## Task 14: Uniqueness matrix — embedded-postgres integration test (Linux-only)

**Files:**
- Test: `server/src/__tests__/organizations-uniqueness.integration.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/organizations-uniqueness.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { organizationService } from "../services/organizations.js";
import { companyService } from "../services/companies.js";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";

type PG = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
let pg: PG | null = null;
let dataDir = "";
let db: Db;
let setupError: unknown = null;

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-org-uniq-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as { default: any };
    const port = await allocateEmbeddedPgPort();
    pg = new EmbeddedPostgres({ databaseDir: join(dataDir, "db"), user: "test", password: "test", port, persistent: false });
    await pg.initialise();
    await pg.start();
    const conn = `postgres://test:test@localhost:${port}/postgres`;
    await applyPendingMigrations(conn);
    db = createDb(conn);
  } catch (err) {
    setupError = err;
    // eslint-disable-next-line no-console
    console.error("[organizations-uniqueness] setup failed:", err);
  }
}, 180_000);

afterAll(async () => {
  try { if (pg) await pg.stop(); } catch { /* ignore */ }
  try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}, 60_000);

describe.skipIf(process.platform !== "linux")("0188 uniqueness matrix — real DB", () => {
  it("allows the SAME issue_prefix in DIFFERENT organizations", async () => {
    if (setupError) throw new Error(String(setupError));
    const orgs = organizationService(db);
    const a = await orgs.create({ name: "Org A" });
    const b = await orgs.create({ name: "Org B" });
    await db.execute(sql`INSERT INTO companies (name, issue_prefix, organization_id) VALUES ('CA', 'DUP', ${a.id})`);
    await expect(
      db.execute(sql`INSERT INTO companies (name, issue_prefix, organization_id) VALUES ('CB', 'DUP', ${b.id})`),
    ).resolves.toBeDefined();
  });

  it("rejects the SAME issue_prefix within ONE organization", async () => {
    const org = await organizationService(db).create({ name: "Org C" });
    await db.execute(sql`INSERT INTO companies (name, issue_prefix, organization_id) VALUES ('C1', 'SME', ${org.id})`);
    await expect(
      db.execute(sql`INSERT INTO companies (name, issue_prefix, organization_id) VALUES ('C2', 'SME', ${org.id})`),
    ).rejects.toThrow();
  });

  it("allows the SAME issue identifier string in two different companies", async () => {
    const org = await organizationService(db).create({ name: "Org D" });
    const r1 = await db.execute(sql`INSERT INTO companies (name, issue_prefix, organization_id) VALUES ('D1', 'DA', ${org.id}) RETURNING id`);
    const r2 = await db.execute(sql`INSERT INTO companies (name, issue_prefix, organization_id) VALUES ('D2', 'DB', ${org.id}) RETURNING id`);
    const id1 = (Array.isArray(r1) ? r1 : (r1 as any).rows)[0].id;
    const id2 = (Array.isArray(r2) ? r2 : (r2 as any).rows)[0].id;
    await db.execute(sql`INSERT INTO issues (company_id, title, identifier, status) VALUES (${id1}, 'x', 'DUP-1', 'backlog')`);
    await expect(
      db.execute(sql`INSERT INTO issues (company_id, title, identifier, status) VALUES (${id2}, 'y', 'DUP-1', 'backlog')`),
    ).resolves.toBeDefined();
  });

  it("rejects a duplicate organization slug (global uniqueness)", async () => {
    await db.execute(sql`INSERT INTO organizations (name, slug) VALUES ('Slug1', 'shared-slug')`);
    await expect(
      db.execute(sql`INSERT INTO organizations (name, slug) VALUES ('Slug2', 'shared-slug')`),
    ).rejects.toThrow();
  });

  it("auto-suffixes the prefix when two same-named companies are created in one org (23505 handler works)", async () => {
    const org = await organizationService(db).create({ name: "Org E" });
    const c1 = await companyService(db).create({ name: "Same Name Co", organizationId: org.id });
    const c2 = await companyService(db).create({ name: "Same Name Co", organizationId: org.id });
    expect(c1.issuePrefix).not.toBe(c2.issuePrefix);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (Linux): `pnpm exec vitest run server/src/__tests__/organizations-uniqueness.integration.test.ts`
Expected: FAIL before Tasks 6/7/8/11 land (old global indexes still present / handler unrenamed); SKIPPED on Windows.

- [ ] **Step 3: Write minimal implementation**

No production code — this validates Tasks 6, 7, 8, 11. A failure is a real index/handler defect to fix.

- [ ] **Step 4: Run test to verify it passes**

Run (Linux): `pnpm exec vitest run server/src/__tests__/organizations-uniqueness.integration.test.ts`
Expected: PASS (Linux) / SKIPPED (Windows).

- [ ] **Step 5: Commit**

```bash
git add server/src/__tests__/organizations-uniqueness.integration.test.ts
git commit -m "test(mt): embedded-pg uniqueness matrix for 0188 (linux-only)"
```

---

## Task 15: Contract-sync + typecheck + no-drift gate

**Files:**
- No new files — verification task across `packages/db` + `packages/shared` + `server`.

- [ ] **Step 1: Build the db package + regenerate to confirm zero drift**

Run: `pnpm --filter @armyofagents/db build && pnpm db:generate`
Expected: drizzle-kit reports **no** new migration to write (the schema now exactly matches `0188`). If it wants to emit a migration, the schema and `0188` disagree — reconcile before proceeding (do NOT accept a second generated migration; fold the diff into `0188`).

- [ ] **Step 2: Whole-repo typecheck**

Run: `pnpm typecheck`
Expected: PASS — in particular `companies.$inferInsert` now requires `organization_id`, and every `companyService.create` caller compiles because the service accepts `organizationId?` and defaults it.

- [ ] **Step 3: Run the full Phase-1 test set (cross-platform subset)**

Run: `pnpm exec vitest run organization issues-identifier-scope companies-org-scope migration-0188 company-service-org-scope companies-create-org-default journal-contiguity snapshot-gate revert-0188`
Expected: PASS (integration suites are skipped off Linux; all contract/unit suites pass).

- [ ] **Step 4: Commit (if any reconciliation edits were needed)**

```bash
git add -A
git commit -m "chore(mt): contract-sync + no-drift verification for phase 1 tenant schema"
```

---

## Task 16: Migration-journal contiguity + uniqueness gate (cross-platform, BLOCKER B5)

**Files:**
- Test: `packages/db/src/__tests__/migration-journal-contiguity.test.ts`

The "generate strictly in order across 5 branches" guidance is otherwise unenforceable. With P3=0189, P4=0190, P5=0191/0192 all landing on separate branches, a duplicate or skipped ordinal would silently corrupt apply order. This gate fails CI the moment ordinals collide, gap, or drift from filenames. Cross-platform (pure fs read — runs on Windows too).

- [ ] **Step 1: Write the failing test**

```ts
// packages/db/src/__tests__/migration-journal-contiguity.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIG_DIR = join(__dirname, "..", "migrations");
const journal = JSON.parse(readFileSync(join(MIG_DIR, "meta", "_journal.json"), "utf8")) as {
  entries: Array<{ idx: number; tag: string }>;
};

describe("migration journal is contiguous, unique, and file-aligned", () => {
  const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);

  it("has no duplicate ordinals", () => {
    const seen = new Set<number>();
    for (const e of entries) {
      expect(seen.has(e.idx), `duplicate idx ${e.idx}`).toBe(false);
      seen.add(e.idx);
    }
  });

  it("is contiguous from 0 with no gaps", () => {
    entries.forEach((e, i) => {
      expect(e.idx, `expected idx ${i} at position ${i}, got ${e.idx} (${e.tag})`).toBe(i);
    });
  });

  it("every journal tag has a matching .sql file and vice-versa", () => {
    const sqlFiles = new Set(
      readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).map((f) => f.replace(/\.sql$/, "")),
    );
    for (const e of entries) {
      expect(sqlFiles.has(e.tag), `journal tag ${e.tag} has no .sql file`).toBe(true);
    }
    expect(sqlFiles.size).toBe(entries.length);
  });

  it("tag ordinal prefix matches its journal idx (zero-padded)", () => {
    for (const e of entries) {
      const prefix = e.tag.slice(0, 4);
      expect(prefix, `tag ${e.tag} prefix != idx ${e.idx}`).toBe(String(e.idx).padStart(4, "0"));
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/db/src/__tests__/migration-journal-contiguity.test.ts`
Expected: PASS immediately if the tree is already clean at 0188 — to see it catch a regression, temporarily duplicate the 0188 entry's `idx` and confirm the "no duplicate ordinals" case FAILS, then revert. (This is a guard test; its value is future enforcement, not a red-to-green transition on a clean tree.)

- [ ] **Step 3: Write minimal implementation**

No production code — the gate asserts an existing invariant of the migrations tree.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/db/src/__tests__/migration-journal-contiguity.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/__tests__/migration-journal-contiguity.test.ts
git commit -m "test(mt): enforce migration-journal contiguity + uniqueness (B5 gate)"
```

---

## Task 17: Reversibility follow-up (a) — guarded compensating revert script

**Files:**
- Create: `packages/db/src/revert-0188.ts` (standalone script — NOT journaled, never auto-runs)
- Test: `packages/db/src/__tests__/revert-0188-guard.test.ts`

> **Reversibility follow-up — may land in a separate PR.** This is the escape hatch WHILE STILL SINGLE-ORG. It is a manually-invoked forward compensating script, deliberately **not** a journaled migration (a journaled reversal would auto-apply on the next deploy and undo P1). It refuses to run unless exactly one Organization exists — once a second tenant exists the door is closed and rollback = restore the pre-migration snapshot.

- [ ] **Step 1: Write the failing test**

```ts
// packages/db/src/__tests__/revert-0188-guard.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, "..", "revert-0188.ts"), "utf8");

describe("revert-0188 is single-org-guarded and restores global invariants", () => {
  it("asserts exactly one organization before doing anything", () => {
    expect(SRC).toMatch(/count\(\*\)/i);
    expect(SRC).toMatch(/organizations/);
    expect(SRC).toMatch(/=== 1|!== 1|> 1/); // single-org guard
  });
  it("drops the org FK + org-scoped indexes and restores the global ones", () => {
    expect(SRC).toContain("companies_organization_id_organizations_id_fk");
    expect(SRC).toContain("companies_org_issue_prefix_idx");
    expect(SRC).toMatch(/CREATE UNIQUE INDEX[\s\S]*"companies_issue_prefix_idx"[\s\S]*\("issue_prefix"\)/);
    expect(SRC).toMatch(/CREATE UNIQUE INDEX[\s\S]*"issues_identifier_idx"[\s\S]*\("identifier"\)/);
  });
  it("runs inside a transaction", () => {
    expect(SRC).toMatch(/BEGIN|transaction/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/db/src/__tests__/revert-0188-guard.test.ts`
Expected: FAIL — `revert-0188.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/db/src/revert-0188.ts
// REVERSIBILITY ESCAPE HATCH — manual, single-org only. NOT a journaled
// migration (would auto-apply and undo Phase 1). Run: tsx src/revert-0188.ts
// Refuses unless exactly ONE Organization exists.
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required for revert-0188");

const sql = postgres(url, { max: 1 });
try {
  const [{ count }] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM organizations`;
  if (count !== 1) {
    throw new Error(
      `revert-0188 refused: expected exactly 1 organization, found ${count}. ` +
        `Once a second tenant exists this is a one-way door — restore the pre-0188 snapshot instead.`,
    );
  }
  await sql.begin(async (tx) => {
    // 1. Drop the tenant FK on companies.
    await tx.unsafe(`ALTER TABLE "companies" DROP CONSTRAINT IF EXISTS "companies_organization_id_organizations_id_fk"`);
    await tx.unsafe(`ALTER TABLE "companies" ALTER COLUMN "organization_id" DROP DEFAULT`);
    // 2. Restore global uniqueness (safe: single org => prefixes/identifiers are already globally unique).
    await tx.unsafe(`DROP INDEX IF EXISTS "companies_org_issue_prefix_idx"`);
    await tx.unsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "companies_issue_prefix_idx" ON "companies" USING btree ("issue_prefix")`);
    await tx.unsafe(`DROP INDEX IF EXISTS "issues_identifier_idx"`);
    await tx.unsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "issues_identifier_idx" ON "issues" USING btree ("identifier")`);
    // 3. Drop the org column + tenant tables.
    await tx.unsafe(`ALTER TABLE "companies" DROP COLUMN IF EXISTS "organization_id"`);
    await tx.unsafe(`DROP TABLE IF EXISTS "organization_invitations"`);
    await tx.unsafe(`DROP TABLE IF EXISTS "organization_memberships"`);
    await tx.unsafe(`DROP TABLE IF EXISTS "organizations"`);
    // 4. Manually strip the 0188 journal row from __drizzle_migrations so the
    //    migrator does not think it is still applied. (Operator must also delete
    //    the 0188 files + journal entry from source before re-generating.)
    await tx.unsafe(`DELETE FROM "drizzle"."__drizzle_migrations" WHERE name = '0188_organizations.sql' OR name = '0188_organizations'`);
  });
  // eslint-disable-next-line no-console
  console.log("revert-0188 complete: Phase 1 tenant schema removed (single-org state restored).");
} finally {
  await sql.end();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/db/src/__tests__/revert-0188-guard.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/revert-0188.ts packages/db/src/__tests__/revert-0188-guard.test.ts
git commit -m "feat(mt): guarded single-org revert script for 0188 (reversibility follow-up)"
```

---

## Task 18: Reversibility follow-up (b) — pre-migration snapshot gate

**Files:**
- Create: `server/src/postgres/snapshot-gate.ts`
- Modify: `server/src/index.ts` (call the gate before `applyPendingMigrations`)
- Test: `server/src/__tests__/snapshot-gate.test.ts`

> **Reversibility follow-up — may land in a separate PR.** Refuses to apply `0188` when the blast radius is real AND unprotected: `deploymentMode === "cloud_auth"` AND `companies` is populated AND no snapshot marker is recorded. The marker is an operator-set flag in `instance_settings.general.migrationSnapshots` (e.g. `["0188"]`) written after the operator confirms a DB snapshot exists. On self-hosted `local_trusted`/`authenticated` the gate is a no-op.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/snapshot-gate.test.ts
import { describe, expect, it } from "vitest";
import { shouldBlockForMissingSnapshot } from "../postgres/snapshot-gate.js";

describe("shouldBlockForMissingSnapshot", () => {
  const base = {
    deploymentMode: "cloud_auth" as const,
    pendingMigrationTags: ["0188_organizations"],
    companyCount: 5,
    recordedSnapshots: [] as string[],
  };

  it("blocks cloud_auth + populated + 0188 pending + no snapshot", () => {
    expect(shouldBlockForMissingSnapshot(base)).toBe(true);
  });
  it("allows once the 0188 snapshot marker is recorded", () => {
    expect(shouldBlockForMissingSnapshot({ ...base, recordedSnapshots: ["0188"] })).toBe(false);
  });
  it("allows on empty companies table (nothing to lose)", () => {
    expect(shouldBlockForMissingSnapshot({ ...base, companyCount: 0 })).toBe(false);
  });
  it("no-ops for self-hosted deployment modes", () => {
    expect(shouldBlockForMissingSnapshot({ ...base, deploymentMode: "local_trusted" })).toBe(false);
    expect(shouldBlockForMissingSnapshot({ ...base, deploymentMode: "authenticated" })).toBe(false);
  });
  it("allows when 0188 is not pending (already applied)", () => {
    expect(shouldBlockForMissingSnapshot({ ...base, pendingMigrationTags: [] })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run server/src/__tests__/snapshot-gate.test.ts`
Expected: FAIL — cannot resolve `../postgres/snapshot-gate.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/postgres/snapshot-gate.ts
import type { DeploymentMode } from "@armyofagents/shared";

export interface SnapshotGateInput {
  deploymentMode: DeploymentMode;
  pendingMigrationTags: string[];
  companyCount: number;
  recordedSnapshots: string[];
}

const GATED_MIGRATION = "0188";

/**
 * Pure predicate: true => refuse to apply 0188 until an operator records a
 * snapshot marker. Only bites on cloud_auth with real data at stake.
 */
export function shouldBlockForMissingSnapshot(input: SnapshotGateInput): boolean {
  if (input.deploymentMode !== "cloud_auth") return false;
  if (input.companyCount <= 0) return false;
  const pending = input.pendingMigrationTags.some((t) => t.startsWith(GATED_MIGRATION));
  if (!pending) return false;
  return !input.recordedSnapshots.some((s) => s === GATED_MIGRATION);
}

export class SnapshotGateError extends Error {
  constructor() {
    super(
      "Refusing to apply migration 0188 (multi-tenant tenant schema): deploymentMode is " +
        "cloud_auth with a populated companies table and no snapshot marker. Take a full DB " +
        "snapshot, then record it via instance_settings.general.migrationSnapshots += \"0188\" " +
        "before restarting. (One-way door once a second Organization exists.)",
    );
    this.name = "SnapshotGateError";
  }
}
```

In `server/src/index.ts`, BEFORE `applyPendingMigrations(...)` runs (where `config.deploymentMode` and a `postgres`/`db` handle are in scope), add:

```ts
import { shouldBlockForMissingSnapshot, SnapshotGateError } from "./postgres/snapshot-gate.js";
import { inspectMigrations } from "@armyofagents/db";
// … before applying migrations:
{
  const state = await inspectMigrations(databaseUrl);
  const pendingMigrationTags =
    state.status === "needsMigrations" ? state.pendingMigrations.map((f) => f.replace(/\.sql$/, "")) : [];
  const companyCount = (
    await db.execute(sql`SELECT count(*)::int AS count FROM companies`)
  );
  const count = (Array.isArray(companyCount) ? companyCount : (companyCount as any).rows)[0]?.count ?? 0;
  const settings = await db.select().from(instanceSettings).limit(1);
  const recordedSnapshots =
    (settings[0]?.general as { migrationSnapshots?: string[] } | undefined)?.migrationSnapshots ?? [];
  if (
    shouldBlockForMissingSnapshot({
      deploymentMode: config.deploymentMode,
      pendingMigrationTags,
      companyCount: count,
      recordedSnapshots,
    })
  ) {
    throw new SnapshotGateError();
  }
}
```

(Import `sql` from `drizzle-orm` and `instanceSettings` from `@armyofagents/db` at the top of `index.ts` if not already present. If `companies` does not yet exist — fresh empty DB — wrap the count query in a try/catch that treats a missing table as `count = 0`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run server/src/__tests__/snapshot-gate.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/postgres/snapshot-gate.ts server/src/index.ts server/src/__tests__/snapshot-gate.test.ts
git commit -m "feat(mt): pre-migration snapshot gate for 0188 on cloud_auth (reversibility follow-up)"
```

---

## Deferred to later phases (explicitly out of Phase 1 scope)

- **Onboarding "Company" step rename (Decision 1, UI copy):** the wizard label change has no schema dependency and is owned by **Phase 2** — tracked there, not implemented here.
- **`cloud_auth` runtime wiring:** the enum value is added now (Task 1) so shared contracts compile; auth/exposure behavior for `cloud_auth` (better-auth, `config-schema` superRefine, middleware) is later-phase.
- **Full RLS (Decision 3):** only `companies.organization_id` is added now. Every other tenant-scoped row carries `company_id`, so `row → company → organization` is derivable — a later RLS phase adds policies (or a mechanical, derivable, backfill-free `UPDATE … FROM companies` denormalization) with **no** human backfill.
- **Credentials strangler (Decision 4):** context only; not this phase.
- **P2 org-RBAC / operator separation, P4 slug routing, P5 concurrency-cap semantics:** consume this schema; not built here.

---

## Self-Review

- **Spec coverage:** organizations + memberships + invitations tables (Tasks 3-5) ✓; companies FK + backfill (Tasks 6, 8) ✓; re-scoped `companies_issue_prefix_idx` (Tasks 6, 8) ✓; coupled `issues_identifier_idx` rescope (Tasks 7, 8) ✓; default-org backfill + owner memberships from instance_admins (Task 8) ✓; `concurrency_cap` (Task 3) ✓; `cloud_auth` (Task 1) ✓; hash-only 7-day invite token (Task 5; 7-day default is set by the P5 invite service at mint time — the column is `expires_at NOT NULL`) ✓; global-unique slug (Task 3) ✓; 23505 handler rename in lockstep (Task 11) ✓; ensureDefaultOrganization + back-compat default (Tasks 10-12) ✓; migration/backfill/uniqueness tests (Tasks 8, 13, 14) ✓; one-way-door/backup gate (Pre-flight) ✓. **Eng-review adds:** DB-level sentinel `DEFAULT` on `organization_id` for missed raw writers (Tasks 6, 8) ✓; fallback owner backfill when zero instance_admins (Task 8) ✓; journal contiguity/uniqueness gate B5 (Task 16) ✓; guarded single-org revert script (Task 17, reversibility follow-up) ✓; cloud_auth pre-migration snapshot gate (Task 18, reversibility follow-up) ✓; `issues` `ACCESS EXCLUSIVE` lock-window runbook note (Pre-flight) ✓.
- **Type consistency:** `organizationId`/`organization_id`, `DEFAULT_ORGANIZATION_ID`, `companies_org_issue_prefix_idx`, `slugifyOrganizationName`, `isOrgSlugConflict`, `ensureDefaultOrganization` are used identically across every task that references them.
- **No placeholders:** every code/test/SQL/command step is concrete.

---

**Plan complete and saved to `docs/aoa/plans/2026-07-29-aoa-mt-phase1-tenant-schema.md`. Two execution options:**

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task with two-stage review between tasks.
2. **Inline Execution** — execute tasks in this session with checkpoints.

Which approach?
