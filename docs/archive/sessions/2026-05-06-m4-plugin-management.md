# M.4 Plugin Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make plugins fully company-scoped, implement the upgrade flow end-to-end, and replace Company Settings → Plugins with a rich card-grid UI with slide-over settings and upgrade support.

**Architecture:** Add `companyId` + `catalogItemId` to `plugins` and `plugin_config` tables (with data backfill), thread `companyId` through the plugin loader and installer, implement `lifecycle.upgrade()` body, extend the update checker to scan plugins, create company-scoped plugin routes, and rebuild the Company Settings Plugins tab as a 2-column card grid with a `PluginDetailSlideOver` (Overview + Settings tabs) and `CapabilityDeltaModal`.

**Tech Stack:** Drizzle ORM (schema + migrations), Express 5.x routes, React + TailwindCSS + TanStack Query (UI), existing plugin-loader / plugin-lifecycle / plugin-worker-manager services.

---

## File Map

| Action | File | Responsibility |
|---|---|---|
| Modify | `packages/db/src/schema/plugins.ts` | Add `companyId`, `catalogItemId` columns |
| Modify | `packages/db/src/schema/plugin_config.ts` | Add `companyId` column |
| Modify | `packages/db/src/schema/plugin_version_snapshots.ts` | Add `companyId` column |
| Modify | `packages/db/src/schema/index.ts` | Export new items if any |
| Create | `scripts/backfill-plugin-company-id.ts` | One-time backfill for existing rows |
| Modify | `server/src/services/plugin-loader.ts` | Add `companyId` to `PluginInstallOptions`, scope registry key |
| Modify | `server/src/services/marketplace-install/plugin-installer.ts` | Use `companyId` in idempotency check |
| Modify | `server/src/services/plugin-lifecycle.ts` | Implement `upgrade()` body |
| Modify | `server/src/services/marketplace-update-checker.ts` | Add `checkPluginUpdates()` per company |
| Create | `server/src/routes/company-plugins.ts` | Company-scoped plugin routes (list, config, upgrade, approve, rollback) |
| Modify | `server/src/app.ts` | Mount new company-plugins router |
| Modify | `ui/src/api/plugins.ts` | Add company-scoped API functions |
| Create | `ui/src/components/settings/PluginConfigForm.tsx` | JSON Schema → form fields renderer |
| Create | `ui/src/components/settings/CapabilityDeltaModal.tsx` | Approve/cancel new capabilities dialog |
| Create | `ui/src/components/settings/PluginDetailSlideOver.tsx` | Overview + Settings slide-over |
| Create | `ui/src/components/settings/PluginsSection.tsx` | 2-column card grid, replaces old toggle list |
| Modify | `ui/src/pages/SettingsPage.tsx` | Swap in new PluginsSection |
| Modify | `ui/src/pages/InstanceSettingsPage.tsx` | Strip install/upgrade UI, keep diagnostics only |

---

## Task 1: Add companyId (nullable) + catalogItemId to plugins schema

**Files:**
- Modify: `packages/db/src/schema/plugins.ts`

- [ ] **Step 1: Read the current file**

```bash
cat packages/db/src/schema/plugins.ts
```

- [ ] **Step 2: Replace the table definition**

Replace the `plugins` table in `packages/db/src/schema/plugins.ts` with:

```typescript
import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import type { PluginCategory, PluginStatus, PaperclipPluginManifestV1 } from "@armyofagents/shared";

export const plugins = pgTable(
  "plugins",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
    catalogItemId: text("catalog_item_id"),
    pluginKey: text("plugin_key").notNull(),
    packageName: text("package_name").notNull(),
    version: text("version").notNull(),
    apiVersion: integer("api_version").notNull().default(1),
    categories: jsonb("categories").$type<PluginCategory[]>().notNull().default([]),
    manifestJson: jsonb("manifest_json").$type<PaperclipPluginManifestV1>().notNull(),
    status: text("status").$type<PluginStatus>().notNull().default("installed"),
    installOrder: integer("install_order"),
    packagePath: text("package_path"),
    lastError: text("last_error"),
    installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // After backfill (Task 4), companyId will be NOT NULL.
    // For now: nullable so the migration applies without breaking existing rows.
    companyPluginKeyIdx: uniqueIndex("plugins_company_plugin_key_idx").on(
      table.companyId,
      table.pluginKey,
    ),
    statusIdx: index("plugins_status_idx").on(table.status),
  }),
);
```

Note: The old `plugins_plugin_key_idx` unique index is replaced by `plugins_company_plugin_key_idx`. Drizzle will generate a migration that drops the old index and creates the new one.

- [ ] **Step 3: Generate the migration**

```bash
pnpm db:generate
```

Expected: A new file appears in `packages/db/drizzle/` with `ALTER TABLE "plugins" ADD COLUMN "company_id" uuid` and `ALTER TABLE "plugins" ADD COLUMN "catalog_item_id" text`.

- [ ] **Step 4: Verify migration file looks correct**

```bash
ls -t packages/db/drizzle/*.sql | head -1 | xargs cat
```

Expected: See `ADD COLUMN "company_id" uuid REFERENCES "companies"("id")` and `ADD COLUMN "catalog_item_id" text`.

- [ ] **Step 5: Apply the migration**

```bash
pnpm db:migrate
```

Expected: Exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema/plugins.ts packages/db/drizzle/
git commit -m "feat(schema): add companyId + catalogItemId to plugins table (nullable, pre-backfill)"
```

---

## Task 2: Add companyId (nullable) to plugin_config and plugin_version_snapshots

**Files:**
- Modify: `packages/db/src/schema/plugin_config.ts`
- Modify: `packages/db/src/schema/plugin_version_snapshots.ts`

- [ ] **Step 1: Update plugin_config.ts**

Replace the contents of `packages/db/src/schema/plugin_config.ts` with:

```typescript
import { pgTable, uuid, text, timestamp, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { plugins } from "./plugins.js";

export const pluginConfig = pgTable(
  "plugin_config",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
    pluginId: uuid("plugin_id")
      .notNull()
      .references(() => plugins.id, { onDelete: "cascade" }),
    configJson: jsonb("config_json").$type<Record<string, unknown>>().notNull().default({}),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Replaces old unique-on-pluginId-alone index.
    companyPluginIdx: uniqueIndex("plugin_config_company_plugin_idx").on(
      table.companyId,
      table.pluginId,
    ),
    companyIdx: index("plugin_config_company_idx").on(table.companyId),
  }),
);
```

- [ ] **Step 2: Update plugin_version_snapshots.ts**

Replace the contents of `packages/db/src/schema/plugin_version_snapshots.ts` with:

```typescript
import { pgTable, uuid, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { plugins } from "./plugins.js";

export const pluginVersionSnapshots = pgTable(
  "plugin_version_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
    pluginId: uuid("plugin_id")
      .notNull()
      .references(() => plugins.id, { onDelete: "cascade" }),
    version: text("version").notNull(),
    packageName: text("package_name").notNull(),
    manifestJson: jsonb("manifest_json"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pluginCreatedIdx: index("pvs_plugin_created_idx").on(table.pluginId, table.createdAt),
    companyIdx: index("pvs_company_idx").on(table.companyId),
  }),
);
```

- [ ] **Step 3: Generate and apply migration**

```bash
pnpm db:generate && pnpm db:migrate
```

Expected: Exits 0. New migration adds `company_id` to both tables.

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/schema/plugin_config.ts packages/db/src/schema/plugin_version_snapshots.ts packages/db/drizzle/
git commit -m "feat(schema): add companyId to plugin_config and plugin_version_snapshots (nullable, pre-backfill)"
```

---

## Task 3: Backfill existing rows + add NOT NULL constraint

**Files:**
- Create: `scripts/backfill-plugin-company-id.ts`
- Modify: `packages/db/src/schema/plugins.ts` (add `.notNull()`)
- Modify: `packages/db/src/schema/plugin_config.ts` (add `.notNull()`)
- Modify: `packages/db/src/schema/plugin_version_snapshots.ts` (add `.notNull()`)

- [ ] **Step 1: Create the backfill script**

Create `scripts/backfill-plugin-company-id.ts`:

```typescript
/**
 * One-time backfill: set companyId on all existing plugin rows that have NULL companyId.
 * Uses the first company in the companies table (AoA is typically single-tenant).
 *
 * Run: npx tsx scripts/backfill-plugin-company-id.ts
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { sql, isNull } from "drizzle-orm";
import { plugins, pluginConfig, pluginVersionSnapshots, companies } from "../packages/db/src/schema/index.js";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

async function main() {
  // Get first company
  const [company] = await db.select({ id: companies.id }).from(companies).limit(1);
  if (!company) {
    console.error("No companies found — skipping backfill");
    process.exit(0);
  }
  const companyId = company.id;
  console.log(`Backfilling companyId = ${companyId}`);

  // Backfill plugins
  const pluginResult = await db
    .update(plugins)
    .set({ companyId })
    .where(isNull(plugins.companyId));
  console.log("plugins updated");

  // Backfill plugin_config
  await db.update(pluginConfig).set({ companyId }).where(isNull(pluginConfig.companyId));
  console.log("plugin_config updated");

  // Backfill plugin_version_snapshots
  await db
    .update(pluginVersionSnapshots)
    .set({ companyId })
    .where(isNull(pluginVersionSnapshots.companyId));
  console.log("plugin_version_snapshots updated");

  console.log("Backfill complete.");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run the backfill**

```bash
DATABASE_URL="postgresql://localhost:5432/aoa" npx tsx scripts/backfill-plugin-company-id.ts
```

Expected output:
```
Backfilling companyId = <uuid>
plugins updated
plugin_config updated
plugin_version_snapshots updated
Backfill complete.
```

- [ ] **Step 3: Add .notNull() to all three schema files**

In `packages/db/src/schema/plugins.ts`, change:
```typescript
companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
```
to:
```typescript
companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
```

In `packages/db/src/schema/plugin_config.ts`, change:
```typescript
companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
```
to:
```typescript
companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
```

In `packages/db/src/schema/plugin_version_snapshots.ts`, same change.

- [ ] **Step 4: Generate and apply NOT NULL migration**

```bash
pnpm db:generate && pnpm db:migrate
```

Expected: Migration adds `ALTER TABLE "plugins" ALTER COLUMN "company_id" SET NOT NULL` (and same for the other two tables).

- [ ] **Step 5: Run typecheck**

```bash
pnpm typecheck
```

Expected: 0 errors related to schema files (may have pre-existing errors elsewhere — those are OK).

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema/ packages/db/drizzle/ scripts/backfill-plugin-company-id.ts
git commit -m "feat(schema): make companyId NOT NULL on plugins, plugin_config, plugin_version_snapshots after backfill"
```

---

## Task 4: Plugin loader — add companyId to PluginInstallOptions and scope registry

**Files:**
- Modify: `server/src/services/plugin-loader.ts`

- [ ] **Step 1: Write a failing test**

Create `server/src/__tests__/plugin-loader-company-scope.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";

describe("plugin-loader companyId scoping", () => {
  it("registry key includes companyId", () => {
    // Registry key must be `${companyId}:${pluginKey}` so two companies
    // can run the same plugin independently.
    const companyId = "aaa-111";
    const pluginKey = "aoa.discord";
    const key = `${companyId}:${pluginKey}`;
    expect(key).toBe("aaa-111:aoa.discord");
  });

  it("different companyIds produce different registry keys", () => {
    const key1 = `company-a:aoa.discord`;
    const key2 = `company-b:aoa.discord`;
    expect(key1).not.toBe(key2);
  });
});
```

- [ ] **Step 2: Run test to verify it passes (these are trivial — just check the pattern)**

```bash
pnpm test --filter server -- plugin-loader-company-scope
```

Expected: PASS

- [ ] **Step 3: Add companyId to PluginInstallOptions interface**

In `server/src/services/plugin-loader.ts`, find the `PluginInstallOptions` interface (search for `PluginInstallOptions`). Add `companyId`:

```typescript
export interface PluginInstallOptions {
  packageName?: string;
  version?: string;
  localPath?: string;
  installDir?: string;
  companyId: string;          // NEW — required for company-scoped installation
  catalogItemId?: string;     // NEW — set when installing from marketplace catalog
}
```

- [ ] **Step 4: Update registry key generation**

In `plugin-loader.ts`, find where the registry key is built (search for `pluginKey` being used as a map key, likely `registry.set(pluginKey, ...)` or similar). Change to:

```typescript
// BEFORE
registry.set(manifest.id, registeredPlugin)

// AFTER
const registryKey = `${companyId}:${manifest.id}`;
registry.set(registryKey, registeredPlugin)
```

Also update the getter (search for `registry.get` or `getByKey`):

```typescript
// BEFORE
getByKey(pluginKey: string): RegisteredPlugin | undefined {
  return this.map.get(pluginKey)
}

// AFTER
getByKey(pluginKey: string, companyId: string): RegisteredPlugin | undefined {
  return this.map.get(`${companyId}:${pluginKey}`)
}
```

- [ ] **Step 5: Scope all DB queries in installPlugin by companyId**

Find the `installPlugin` implementation body (search for the function that executes npm install and writes to the `plugins` table). Ensure the DB insert includes `companyId`:

```typescript
// When inserting new plugin row (inside installPlugin):
await db.insert(plugins).values({
  companyId: opts.companyId,           // ADD THIS
  catalogItemId: opts.catalogItemId,   // ADD THIS
  pluginKey: manifest.id,
  packageName: resolvedPackageName,
  version: resolvedVersion,
  apiVersion: manifest.apiVersion,
  categories: manifest.categories ?? [],
  manifestJson: manifest,
  status: "installed",
  packagePath: packagePath,
});
```

Also update any `db.select().from(plugins).where(eq(plugins.pluginKey, ...))` queries inside plugin-loader to also filter by `companyId`:

```typescript
// BEFORE
.where(eq(plugins.pluginKey, pluginKey))

// AFTER
.where(and(eq(plugins.companyId, companyId), eq(plugins.pluginKey, pluginKey)))
```

- [ ] **Step 6: Pass companyId when spawning workers**

Find where worker startup config is built (search for `WorkerStartOptions` or the object passed to `workerManager.startWorker`). Add `companyId` to it:

```typescript
const workerOpts: WorkerStartOptions = {
  pluginId: plugin.id,
  companyId: plugin.companyId,     // ADD THIS
  packagePath: plugin.packagePath ?? resolvedPath,
  manifestJson: plugin.manifestJson,
  // ...existing fields
};
```

- [ ] **Step 7: Run typecheck**

```bash
pnpm typecheck --filter server
```

Fix any TypeScript errors from the new `companyId: string` requirement on `PluginInstallOptions`. The main callers to fix are in `plugin-lifecycle.ts` and `plugin-installer.ts` (done in next tasks).

- [ ] **Step 8: Commit**

```bash
git add server/src/services/plugin-loader.ts server/src/__tests__/plugin-loader-company-scope.test.ts
git commit -m "feat(plugin-loader): add companyId to PluginInstallOptions, scope registry key per company"
```

---

## Task 5: Plugin installer — use companyId in idempotency check

**Files:**
- Modify: `server/src/services/marketplace-install/plugin-installer.ts`

- [ ] **Step 1: Write a failing test**

Create `server/src/__tests__/plugin-installer-company-scope.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { installMarketplacePlugin } from "../services/marketplace-install/plugin-installer.js";

const makeDb = (existingPlugins: any[]) => ({
  select: () => ({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve(existingPlugins),
      }),
    }),
  }),
  insert: () => ({ values: () => Promise.resolve() }),
});

describe("installMarketplacePlugin companyId scoping", () => {
  it("idempotency check scopes by packageName — same version returns alreadyInstalled", async () => {
    const db = makeDb([{ id: "plug-1", version: "1.0.0", companyId: "co-a" }]) as any;
    const loader = {
      installPlugin: vi.fn(),
      registry: { getByKey: vi.fn() },
      lifecycle: { load: vi.fn() },
    };
    const result = await installMarketplacePlugin({
      catalogItem: {
        type: "plugin",
        id: "plugin:test",
        npm: { packageName: "@test/plugin", version: "1.0.0" },
      } as any,
      companyId: "co-a",
      db,
      pluginLoader: loader,
    });
    expect(result.alreadyInstalled).toBe(true);
    expect(loader.installPlugin).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails (loader.installPlugin is still called in current code)**

```bash
pnpm test --filter server -- plugin-installer-company-scope
```

Expected: FAIL

- [ ] **Step 3: Update installMarketplacePlugin**

Replace the body of `installMarketplacePlugin` in `server/src/services/marketplace-install/plugin-installer.ts`:

```typescript
export async function installMarketplacePlugin(
  opts: InstallMarketplacePluginOpts,
): Promise<InstallMarketplacePluginResult> {
  const { catalogItem, companyId, db, pluginLoader } = opts;

  if (catalogItem.type !== "plugin") {
    throw new Error(`installMarketplacePlugin called with non-plugin: ${catalogItem.id}`);
  }
  if (!catalogItem.npm) {
    throw new Error(
      `Plugin ${catalogItem.id} missing npm field — aggregator must populate npm.{packageName,version}`,
    );
  }

  // Idempotency check — scoped to this company
  const existing = await db
    .select()
    .from(plugins)
    .where(
      and(
        eq(plugins.companyId, companyId),
        eq(plugins.packageName, catalogItem.npm.packageName),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    if (existing[0].version === catalogItem.npm.version) {
      return { pluginId: existing[0].id, alreadyInstalled: true };
    }
    throw new Error(
      `Plugin ${catalogItem.npm.packageName} installed at version ${existing[0].version} for company ${companyId}; ` +
        `catalog requests ${catalogItem.npm.version}. Use the upgrade flow.`,
    );
  }

  // Install via plugin loader — pass companyId and catalogItemId
  const installOpts = catalogItem.npm.tarballUrl
    ? { packageName: catalogItem.npm.tarballUrl, companyId, catalogItemId: catalogItem.id }
    : {
        packageName: catalogItem.npm.packageName,
        version: catalogItem.npm.version,
        companyId,
        catalogItemId: catalogItem.id,
      };

  const discovered = await pluginLoader.installPlugin(installOpts);

  if (!discovered.manifest) {
    throw new Error(`Plugin installed but manifest is missing for ${catalogItem.id}`);
  }

  // Look up the registry entry — now scoped by companyId
  const existingPlugin = await pluginLoader.registry.getByKey(
    discovered.manifest.id,
    companyId,
  );
  if (!existingPlugin) {
    throw new Error(
      `Plugin installed but not found in registry: pluginKey=${discovered.manifest.id} companyId=${companyId}`,
    );
  }

  await pluginLoader.lifecycle.load(existingPlugin.id);

  return { pluginId: existingPlugin.id, alreadyInstalled: false };
}
```

Also add the missing `and` import at the top of the file:
```typescript
import { eq, and } from "drizzle-orm";
```

Also update the `PluginLoaderLike` interface in the same file to match:
```typescript
export interface PluginLoaderLike {
  installPlugin(opts: {
    packageName?: string;
    version?: string;
    localPath?: string;
    installDir?: string;
    companyId: string;
    catalogItemId?: string;
  }): Promise<{
    packagePath: string;
    packageName: string;
    version: string;
    source: string;
    manifest: { id: string; [key: string]: unknown } | null;
  }>;
  registry: {
    getByKey(pluginKey: string, companyId: string): Promise<{ id: string; pluginKey: string } | null>;
  };
  lifecycle: {
    load(pluginId: string): Promise<void>;
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm test --filter server -- plugin-installer-company-scope
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/services/marketplace-install/plugin-installer.ts server/src/__tests__/plugin-installer-company-scope.test.ts
git commit -m "feat(plugin-installer): scope idempotency check by companyId, pass companyId+catalogItemId to loader"
```

---

## Task 6: Implement lifecycle.upgrade() body

**Files:**
- Modify: `server/src/services/plugin-lifecycle.ts`

- [ ] **Step 1: Write a failing test**

Create `server/src/__tests__/plugin-lifecycle-upgrade.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";

// Pure function extracted from the upgrade logic: capability delta comparison
function diffCapabilities(oldCaps: string[], newCaps: string[]): string[] {
  const oldSet = new Set(oldCaps);
  return newCaps.filter((c) => !oldSet.has(c));
}

describe("plugin lifecycle upgrade helpers", () => {
  it("detects no new capabilities when sets are equal", () => {
    const delta = diffCapabilities(
      ["tools.register", "http.outbound"],
      ["tools.register", "http.outbound"],
    );
    expect(delta).toEqual([]);
  });

  it("detects newly added capabilities", () => {
    const delta = diffCapabilities(
      ["tools.register"],
      ["tools.register", "storage.write", "webhooks.listen"],
    );
    expect(delta).toEqual(["storage.write", "webhooks.listen"]);
  });

  it("does not flag removed capabilities (backward compat is OK)", () => {
    const delta = diffCapabilities(
      ["tools.register", "http.outbound"],
      ["tools.register"],
    );
    expect(delta).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test --filter server -- plugin-lifecycle-upgrade
```

Expected: FAIL (diffCapabilities not exported)

- [ ] **Step 3: Add and export diffCapabilities helper**

In `server/src/services/plugin-lifecycle.ts`, add this export near the top (after imports):

```typescript
/**
 * Returns capabilities present in newCaps but absent in oldCaps.
 * Used to determine if an upgrade requires operator approval.
 */
export function diffCapabilities(oldCaps: string[], newCaps: string[]): string[] {
  const oldSet = new Set(oldCaps);
  return newCaps.filter((c) => !oldSet.has(c));
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm test --filter server -- plugin-lifecycle-upgrade
```

Expected: PASS

- [ ] **Step 5: Implement the upgrade() method body**

Find the `upgrade` method in `plugin-lifecycle.ts` (the existing skeleton that is currently unimplemented or throws). Replace its body with:

```typescript
async upgrade(
  pluginId: string,
  version: string | undefined,
): Promise<{ version: string; status: string; delta?: string[] }> {
  // 1. Load current plugin row
  const [current] = await db
    .select()
    .from(plugins)
    .where(eq(plugins.id, pluginId));

  if (!current) throw notFound(`Plugin not found: ${pluginId}`);

  const companyId = current.companyId;
  const oldCaps = ((current.manifestJson as any)?.capabilities ?? []) as string[];

  // 2. Save rollback snapshot (uses existing pluginVersionSnapshots table)
  await db.insert(pluginVersionSnapshots).values({
    pluginId: current.id,
    companyId,
    version: current.version,
    packageName: current.packageName,
    manifestJson: current.manifestJson,
  });

  // 3. Stop existing worker
  if (this.workerManager) {
    await this.workerManager.stopWorker(pluginId).catch(() => {});
  }

  // 4. Install new version
  const discovered = await this.loader.installPlugin({
    packageName: current.packageName,
    version,
    companyId,
  });

  if (!discovered.manifest) {
    throw new Error(`Upgrade downloaded package but manifest is missing`);
  }

  const newCaps = ((discovered.manifest as any)?.capabilities ?? []) as string[];
  const addedCaps = diffCapabilities(oldCaps, newCaps);

  // 5. Update plugin row with new version + manifest
  const newVersion = discovered.version;
  await db
    .update(plugins)
    .set({
      version: newVersion,
      manifestJson: discovered.manifest as any,
      updatedAt: new Date(),
    })
    .where(eq(plugins.id, pluginId));

  // 6. Transition state
  if (addedCaps.length > 0) {
    await this.markUpgradePending(pluginId);
    return { version: newVersion, status: "upgrade_pending", delta: addedCaps };
  }

  // No new capabilities — go straight to ready
  await this.load(pluginId);
  return { version: newVersion, status: "ready" };
}
```

Make sure `pluginVersionSnapshots` is imported at the top:
```typescript
import { plugins, pluginConfig, pluginVersionSnapshots } from "@armyofagents/db";
```

- [ ] **Step 6: Update the upgrade route in server/src/routes/plugins.ts to handle the new return type**

Find the `POST /plugins/:pluginId/upgrade` route (around line 1480). Update the try block result handling:

```typescript
const result = await lifecycle.upgrade(plugin.id, version);
// result is now { version, status, delta? }
await logPluginMutationActivity(req, "plugin.upgraded", plugin.id, {
  pluginId: plugin.id,
  pluginKey: plugin.pluginKey,
  previousVersion: plugin.version,
  version: result.version,
  targetVersion: version ?? null,
});
publishGlobalLiveEvent({
  type: "plugin.ui.updated",
  payload: { pluginId: plugin.id, action: "upgraded" },
});
res.json(result);
```

- [ ] **Step 7: Run typecheck**

```bash
pnpm typecheck --filter server
```

Expected: 0 new errors.

- [ ] **Step 8: Commit**

```bash
git add server/src/services/plugin-lifecycle.ts server/src/routes/plugins.ts server/src/__tests__/plugin-lifecycle-upgrade.test.ts
git commit -m "feat(plugin-lifecycle): implement upgrade() body with capability delta + markUpgradePending gate"
```

---

## Task 7: Extend update checker to scan plugins per company

**Files:**
- Modify: `server/src/services/marketplace-update-checker.ts`

- [ ] **Step 1: Write a failing test**

Create `server/src/__tests__/marketplace-update-checker-plugins.test.ts`:

```typescript
import { describe, it, expect } from "vitest";

// Import the pure compareVersions helper (already exists in update-checker)
import { compareVersions } from "../services/marketplace-update-checker.js";

describe("compareVersions", () => {
  it("returns 1 when latest is newer", () => {
    expect(compareVersions("1.0.0", "0.1.1")).toBe(1);
  });
  it("returns 0 when equal", () => {
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });
  it("returns -1 when latest is older", () => {
    expect(compareVersions("0.9.0", "1.0.0")).toBe(-1);
  });
});
```

- [ ] **Step 2: Run test**

```bash
pnpm test --filter server -- marketplace-update-checker-plugins
```

Expected: PASS (compareVersions already exists and works).

- [ ] **Step 3: Read the current marketplace-update-checker.ts**

```bash
cat server/src/services/marketplace-update-checker.ts
```

- [ ] **Step 4: Add checkPluginUpdates function**

In `server/src/services/marketplace-update-checker.ts`, add the following function after the existing `checkCompany` function:

```typescript
/**
 * Check for plugin updates for a single company.
 * Scans the plugins table for this company, compares against the catalog,
 * and upserts to marketplacePendingUpdates for any plugins with newer versions.
 */
async function checkPluginUpdates(
  db: Db,
  companyId: string,
  catalogItems: CatalogItem[],
): Promise<void> {
  const installedPlugins = await db
    .select()
    .from(plugins)
    .where(and(eq(plugins.companyId, companyId), eq(plugins.status, "ready")));

  for (const plugin of installedPlugins) {
    // Match catalog item by packageName
    const catalogItem = catalogItems.find(
      (item) => item.type === "plugin" && item.npm?.packageName === plugin.packageName,
    );
    if (!catalogItem || !catalogItem.npm?.version) continue;

    const comparison = compareVersions(catalogItem.npm.version, plugin.version);
    if (comparison <= 0) continue; // already up to date

    const { inserted } = await upsertPendingUpdate(db, {
      companyId,
      catalogItemId: catalogItem.id,
      itemType: "plugin",
      currentVersion: plugin.version,
      latestVersion: catalogItem.npm.version,
    });

    if (inserted) {
      // Notify the company of the available update
      await db.insert(notifications).values({
        companyId,
        type: "marketplace.plugin_update_available",
        title: `Plugin update available`,
        body: `${(catalogItem as any).displayName ?? plugin.packageName} can be updated from v${plugin.version} to v${catalogItem.npm.version}`,
        payload: { catalogItemId: catalogItem.id, latestVersion: catalogItem.npm.version },
      }).catch(() => {}); // non-fatal if notifications table schema differs
    }
  }
}
```

Add missing imports at the top if not already present:
```typescript
import { plugins } from "@armyofagents/db";
import { and } from "drizzle-orm";
```

- [ ] **Step 5: Call checkPluginUpdates from checkCompany**

In the `checkCompany` function (or equivalent per-company function), add a call to `checkPluginUpdates` after the existing skills check:

```typescript
// After existing skills update check:
await checkPluginUpdates(db, companyId, catalogItems);
```

- [ ] **Step 6: Run tests**

```bash
pnpm test --filter server -- marketplace-update-checker
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add server/src/services/marketplace-update-checker.ts server/src/__tests__/marketplace-update-checker-plugins.test.ts
git commit -m "feat(update-checker): extend runUpdateCheck to scan plugins table per company"
```

---

## Task 8: Create company-scoped plugin routes

**Files:**
- Create: `server/src/routes/company-plugins.ts`

- [ ] **Step 1: Read the existing company plugin-settings routes for reference**

```bash
grep -n "pluginCompanySettings\|plugin-settings" server/src/routes/plugins.ts | head -20
```

- [ ] **Step 2: Create the file**

Create `server/src/routes/company-plugins.ts`:

```typescript
/**
 * Company-scoped plugin management routes.
 *
 * Mounted at /api/companies/:companyId/plugins by app.ts.
 *
 * These routes handle plugin management from the company's perspective:
 * - List installed plugins for this company
 * - Read/write per-company plugin config (plugin_config table, company-scoped)
 * - Trigger upgrade (delegates to lifecycle.upgrade())
 * - Approve new capabilities (upgrade_pending → ready)
 * - Rollback to previous version
 * - Toggle plugin enabled/disabled for this company
 */
import { Router } from "express";
import { eq, and } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import {
  plugins,
  pluginConfig,
  pluginCompanySettings,
  pluginVersionSnapshots,
} from "@armyofagents/db";
import { assertBoard, assertCompanyAccess } from "../middleware/auth.js";
import type { PluginLifecycleManager } from "../services/plugin-lifecycle.js";
import type { PluginLoader } from "../services/plugin-loader.js";

export function companyPluginRoutes(
  db: Db,
  lifecycle: PluginLifecycleManager,
  loader: PluginLoader,
) {
  const router = Router({ mergeParams: true });

  // ── GET /api/companies/:companyId/plugins ────────────────────────────────
  // List all plugins installed for this company with their settings overlay.
  router.get("/", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const installed = await db
      .select()
      .from(plugins)
      .where(eq(plugins.companyId, companyId))
      .orderBy(plugins.installedAt);

    const settings = await db
      .select()
      .from(pluginCompanySettings)
      .where(eq(pluginCompanySettings.companyId, companyId));

    const configs = await db
      .select()
      .from(pluginConfig)
      .where(eq(pluginConfig.companyId, companyId));

    const settingsMap = new Map(settings.map((s) => [s.pluginId, s]));
    const configMap = new Map(configs.map((c) => [c.pluginId, c]));

    const result = installed.map((plugin) => ({
      id: plugin.id,
      companyId: plugin.companyId,
      catalogItemId: plugin.catalogItemId,
      pluginKey: plugin.pluginKey,
      packageName: plugin.packageName,
      version: plugin.version,
      status: plugin.status,
      categories: plugin.categories,
      manifest: plugin.manifestJson,
      lastError: plugin.lastError,
      installedAt: plugin.installedAt,
      updatedAt: plugin.updatedAt,
      enabled: settingsMap.get(plugin.id)?.enabled ?? true,
      configJson: configMap.get(plugin.id)?.configJson ?? {},
    }));

    res.json(result);
  });

  // ── GET /api/companies/:companyId/plugins/:pluginId/config ───────────────
  router.get("/:pluginId/config", async (req, res) => {
    assertBoard(req);
    const { companyId, pluginId } = req.params as { companyId: string; pluginId: string };
    assertCompanyAccess(req, companyId);

    const [config] = await db
      .select()
      .from(pluginConfig)
      .where(and(eq(pluginConfig.companyId, companyId), eq(pluginConfig.pluginId, pluginId)));

    res.json({ configJson: config?.configJson ?? {} });
  });

  // ── POST /api/companies/:companyId/plugins/:pluginId/config ──────────────
  // Upsert per-company plugin config.
  router.post("/:pluginId/config", async (req, res) => {
    assertBoard(req);
    const { companyId, pluginId } = req.params as { companyId: string; pluginId: string };
    assertCompanyAccess(req, companyId);

    const { configJson } = req.body as { configJson: Record<string, unknown> };
    if (!configJson || typeof configJson !== "object") {
      res.status(400).json({ error: "configJson must be an object" });
      return;
    }

    // Verify plugin belongs to this company
    const [plugin] = await db
      .select({ id: plugins.id })
      .from(plugins)
      .where(and(eq(plugins.companyId, companyId), eq(plugins.id, pluginId)));

    if (!plugin) {
      res.status(404).json({ error: "Plugin not found for this company" });
      return;
    }

    const [existing] = await db
      .select()
      .from(pluginConfig)
      .where(and(eq(pluginConfig.companyId, companyId), eq(pluginConfig.pluginId, pluginId)));

    if (existing) {
      const [updated] = await db
        .update(pluginConfig)
        .set({ configJson, updatedAt: new Date() })
        .where(eq(pluginConfig.id, existing.id))
        .returning();
      res.json(updated);
    } else {
      const [inserted] = await db
        .insert(pluginConfig)
        .values({ companyId, pluginId, configJson })
        .returning();
      res.json(inserted);
    }
  });

  // ── POST /api/companies/:companyId/plugins/:pluginId/upgrade ─────────────
  // Trigger upgrade to the latest catalog version.
  // Returns { version, status: 'ready' | 'upgrade_pending', delta? }
  router.post("/:pluginId/upgrade", async (req, res) => {
    assertBoard(req);
    const { companyId, pluginId } = req.params as { companyId: string; pluginId: string };
    assertCompanyAccess(req, companyId);

    const { version } = req.body as { version?: string };

    const [plugin] = await db
      .select()
      .from(plugins)
      .where(and(eq(plugins.companyId, companyId), eq(plugins.id, pluginId)));

    if (!plugin) {
      res.status(404).json({ error: "Plugin not found for this company" });
      return;
    }

    // Save rollback snapshot before upgrading
    await db.insert(pluginVersionSnapshots).values({
      companyId,
      pluginId: plugin.id,
      version: plugin.version,
      packageName: plugin.packageName,
      manifestJson: plugin.manifestJson,
    });

    try {
      const result = await lifecycle.upgrade(plugin.id, version);
      res.json(result);
    } catch (err) {
      // Auto-rollback: find the snapshot we just saved and reinstall
      const [snapshot] = await db
        .select()
        .from(pluginVersionSnapshots)
        .where(
          and(
            eq(pluginVersionSnapshots.companyId, companyId),
            eq(pluginVersionSnapshots.pluginId, pluginId),
          ),
        )
        .orderBy(pluginVersionSnapshots.createdAt)
        .limit(1);

      if (snapshot) {
        try {
          await loader.installPlugin({
            packageName: snapshot.packageName,
            version: snapshot.version,
            companyId,
          });
          await lifecycle.load(plugin.id);
        } catch (revertErr) {
          // Plugin is in broken state — log but don't mask the original error
          console.error("Auto-rollback failed", revertErr);
        }
      }

      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  // ── POST /api/companies/:companyId/plugins/:pluginId/upgrade/approve ─────
  // Approve new capabilities and transition upgrade_pending → ready.
  router.post("/:pluginId/upgrade/approve", async (req, res) => {
    assertBoard(req);
    const { companyId, pluginId } = req.params as { companyId: string; pluginId: string };
    assertCompanyAccess(req, companyId);

    const [plugin] = await db
      .select()
      .from(plugins)
      .where(and(eq(plugins.companyId, companyId), eq(plugins.id, pluginId)));

    if (!plugin) {
      res.status(404).json({ error: "Plugin not found for this company" });
      return;
    }
    if (plugin.status !== "upgrade_pending") {
      res.status(400).json({ error: `Plugin is not in upgrade_pending state (current: ${plugin.status})` });
      return;
    }

    await lifecycle.load(plugin.id); // transitions upgrade_pending → ready, starts worker
    res.json({ status: "ready" });
  });

  // ── POST /api/companies/:companyId/plugins/:pluginId/upgrade/rollback ────
  // Cancel upgrade — restore from snapshot, transition back to ready.
  router.post("/:pluginId/upgrade/rollback", async (req, res) => {
    assertBoard(req);
    const { companyId, pluginId } = req.params as { companyId: string; pluginId: string };
    assertCompanyAccess(req, companyId);

    const [snapshot] = await db
      .select()
      .from(pluginVersionSnapshots)
      .where(
        and(
          eq(pluginVersionSnapshots.companyId, companyId),
          eq(pluginVersionSnapshots.pluginId, pluginId),
        ),
      )
      .orderBy(pluginVersionSnapshots.createdAt)
      .limit(1);

    if (!snapshot) {
      res.status(404).json({ error: "No rollback snapshot found for this plugin" });
      return;
    }

    await loader.installPlugin({
      packageName: snapshot.packageName,
      version: snapshot.version,
      companyId,
    });

    const [plugin] = await db
      .select()
      .from(plugins)
      .where(and(eq(plugins.companyId, companyId), eq(plugins.id, pluginId)));

    if (plugin) await lifecycle.load(plugin.id);

    res.json({ status: "ready", version: snapshot.version });
  });

  // ── PATCH /api/companies/:companyId/plugins/:pluginId/settings ───────────
  // Toggle enabled/disabled for this company.
  router.patch("/:pluginId/settings", async (req, res) => {
    assertBoard(req);
    const { companyId, pluginId } = req.params as { companyId: string; pluginId: string };
    assertCompanyAccess(req, companyId);

    const { enabled } = req.body as { enabled: boolean };
    if (typeof enabled !== "boolean") {
      res.status(400).json({ error: "enabled must be a boolean" });
      return;
    }

    const [existing] = await db
      .select()
      .from(pluginCompanySettings)
      .where(
        and(
          eq(pluginCompanySettings.companyId, companyId),
          eq(pluginCompanySettings.pluginId, pluginId),
        ),
      );

    if (existing) {
      const [updated] = await db
        .update(pluginCompanySettings)
        .set({ enabled, updatedAt: new Date() })
        .where(eq(pluginCompanySettings.id, existing.id))
        .returning();
      res.json(updated);
    } else {
      const [inserted] = await db
        .insert(pluginCompanySettings)
        .values({ companyId, pluginId, enabled })
        .returning();
      res.json(inserted);
    }
  });

  return router;
}
```

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/company-plugins.ts
git commit -m "feat(routes): add company-scoped plugin routes (list, config, upgrade, approve, rollback, settings)"
```

---

## Task 9: Wire company-plugins routes into app.ts

**Files:**
- Modify: `server/src/app.ts`

- [ ] **Step 1: Add import**

In `server/src/app.ts`, add after the existing plugin routes import (near line 69):

```typescript
import { companyPluginRoutes } from "./routes/company-plugins.js";
```

- [ ] **Step 2: Mount the router**

In `app.ts`, after the existing `api.use(pluginCompanySettingsRoutes(db))` call (near line 308), add:

```typescript
// Company-scoped plugin management (M.4)
if (loaderInst) {
  api.use(
    "/companies/:companyId/plugins",
    companyPluginRoutes(db, loaderInst.lifecycle, loaderInst.loader),
  );
}
```

Note: Check how `loaderInst` and `lifecycle` are structured in `app.ts` — adapt the access pattern to match what's already there. Look at how `pluginRoutes(db, loaderInst, ...)` is called to understand the pattern.

- [ ] **Step 3: Run typecheck**

```bash
pnpm typecheck --filter server
```

Expected: 0 new errors.

- [ ] **Step 4: Start the server and verify routes respond**

```bash
PORT=57563 npx tsx server/src/index.ts &
sleep 3
curl -s http://localhost:57563/api/companies/REPLACE_WITH_REAL_CID/plugins | head -c 200
kill %1
```

Expected: JSON array response (may be empty if no plugins installed for that company).

- [ ] **Step 5: Commit**

```bash
git add server/src/app.ts
git commit -m "feat(app): mount company-plugin routes at /api/companies/:companyId/plugins"
```

---

## Task 10: API client — company-scoped plugin functions

**Files:**
- Modify: `ui/src/api/plugins.ts`

- [ ] **Step 1: Read the current file**

```bash
cat ui/src/api/plugins.ts
```

- [ ] **Step 2: Add the new functions at the end of the file**

```typescript
// ─── Company-scoped plugin management (M.4) ──────────────────────────────

export interface InstalledPlugin {
  id: string;
  companyId: string;
  catalogItemId: string | null;
  pluginKey: string;
  packageName: string;
  version: string;
  status: string;
  categories: string[];
  manifest: {
    displayName: string;
    description: string;
    capabilities: string[];
    instanceConfigSchema?: Record<string, unknown>;
  };
  lastError: string | null;
  installedAt: string;
  updatedAt: string;
  enabled: boolean;
  configJson: Record<string, unknown>;
}

export interface UpgradeResult {
  version: string;
  status: "ready" | "upgrade_pending";
  delta?: string[];
}

export const listCompanyPlugins = (companyId: string) =>
  apiClient.get<InstalledPlugin[]>(`/companies/${companyId}/plugins`);

export const getPluginConfig = (companyId: string, pluginId: string) =>
  apiClient.get<{ configJson: Record<string, unknown> }>(
    `/companies/${companyId}/plugins/${pluginId}/config`,
  );

export const savePluginConfig = (
  companyId: string,
  pluginId: string,
  configJson: Record<string, unknown>,
) =>
  apiClient.post<{ configJson: Record<string, unknown> }>(
    `/companies/${companyId}/plugins/${pluginId}/config`,
    { configJson },
  );

export const upgradePlugin = (companyId: string, pluginId: string, version?: string) =>
  apiClient.post<UpgradeResult>(`/companies/${companyId}/plugins/${pluginId}/upgrade`, {
    version,
  });

export const approvePluginUpgrade = (companyId: string, pluginId: string) =>
  apiClient.post<{ status: string }>(`/companies/${companyId}/plugins/${pluginId}/upgrade/approve`);

export const rollbackPluginUpgrade = (companyId: string, pluginId: string) =>
  apiClient.post<{ status: string; version: string }>(
    `/companies/${companyId}/plugins/${pluginId}/upgrade/rollback`,
  );

export const patchPluginSettings = (
  companyId: string,
  pluginId: string,
  enabled: boolean,
) =>
  apiClient.patch(`/companies/${companyId}/plugins/${pluginId}/settings`, { enabled });
```

Note: `apiClient` is whatever HTTP client pattern is already used in `ui/src/api/plugins.ts`. Look at the existing functions in the file and follow the exact same pattern (it may be `apiFetch`, `client`, etc.).

- [ ] **Step 3: Commit**

```bash
git add ui/src/api/plugins.ts
git commit -m "feat(api-client): add company-scoped plugin management functions (M.4)"
```

---

## Task 11: PluginConfigForm component

**Files:**
- Create: `ui/src/components/settings/PluginConfigForm.tsx`

- [ ] **Step 1: Create the component**

Create `ui/src/components/settings/PluginConfigForm.tsx`:

```tsx
/**
 * Renders a configuration form from a JSON Schema (manifest.instanceConfigSchema).
 * Supports: string (text input), string+format:password (password input),
 * boolean (toggle), number (number input).
 * Saves to plugin_config.configJson via POST /companies/:cid/plugins/:id/config.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as pluginsApi from "../../api/plugins.js";

interface JsonSchemaProperty {
  type?: string;
  format?: string;
  title?: string;
  description?: string;
}

interface JsonSchema {
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}

interface Props {
  companyId: string;
  pluginId: string;
  schema: JsonSchema | undefined;
  initialValues: Record<string, unknown>;
  onSaved?: () => void;
}

export function PluginConfigForm({ companyId, pluginId, schema, initialValues, onSaved }: Props) {
  const queryClient = useQueryClient();
  const [values, setValues] = useState<Record<string, unknown>>(initialValues);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const mutation = useMutation({
    mutationFn: (configJson: Record<string, unknown>) =>
      pluginsApi.savePluginConfig(companyId, pluginId, configJson),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["company-plugins", companyId] });
      onSaved?.();
    },
  });

  if (!schema?.properties || Object.keys(schema.properties).length === 0) {
    return (
      <p className="text-xs text-zinc-500 py-2">This plugin has no configurable settings.</p>
    );
  }

  function handleChange(key: string, value: unknown) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setFieldErrors((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  function handleSave() {
    // Validate required fields
    const errors: Record<string, string> = {};
    for (const key of schema?.required ?? []) {
      if (values[key] === undefined || values[key] === "") {
        errors[key] = "Required";
      }
    }
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }
    mutation.mutate(values);
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-zinc-500">
        Company-scoped config. Each company has independent values.
      </p>

      {Object.entries(schema.properties).map(([key, prop]) => {
        const label = prop.title ?? key;
        const isPassword = prop.format === "password";
        const isBoolean = prop.type === "boolean";
        const isNumber = prop.type === "number" || prop.type === "integer";
        const error = fieldErrors[key];

        return (
          <div key={key} className="space-y-1.5">
            {isBoolean ? (
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs font-semibold text-zinc-400">{label}</div>
                  {prop.description && (
                    <div className="text-[10px] text-zinc-600">{prop.description}</div>
                  )}
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={!!values[key]}
                  onClick={() => handleChange(key, !values[key])}
                  className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors ${
                    values[key] ? "bg-indigo-600" : "bg-zinc-700"
                  }`}
                >
                  <span
                    className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform mt-[3px] ${
                      values[key] ? "translate-x-4.5" : "translate-x-0.5"
                    }`}
                  />
                </button>
              </div>
            ) : (
              <>
                <label className="block text-xs font-semibold text-zinc-400">{label}</label>
                {prop.description && (
                  <div className="text-[10px] text-zinc-600">{prop.description}</div>
                )}
                <input
                  type={isPassword ? "password" : isNumber ? "number" : "text"}
                  value={String(values[key] ?? "")}
                  onChange={(e) => handleChange(key, isNumber ? Number(e.target.value) : e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-md px-3 py-1.5 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-indigo-500"
                />
                {error && <p className="text-[10px] text-red-400">{error}</p>}
              </>
            )}
          </div>
        );
      })}

      <button
        type="button"
        onClick={handleSave}
        disabled={mutation.isPending}
        className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white text-xs font-semibold py-2 rounded-md transition-colors"
      >
        {mutation.isPending ? "Saving…" : "Save settings"}
      </button>

      {mutation.isError && (
        <p className="text-[10px] text-red-400">
          {mutation.error instanceof Error ? mutation.error.message : "Save failed"}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add ui/src/components/settings/PluginConfigForm.tsx
git commit -m "feat(ui): add PluginConfigForm — JSON Schema to form fields renderer"
```

---

## Task 12: CapabilityDeltaModal

**Files:**
- Create: `ui/src/components/settings/CapabilityDeltaModal.tsx`

- [ ] **Step 1: Create the component**

Create `ui/src/components/settings/CapabilityDeltaModal.tsx`:

```tsx
/**
 * Modal shown when an upgrade introduces new capabilities.
 * User must explicitly approve or cancel.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as pluginsApi from "../../api/plugins.js";

// Human-readable descriptions for known capabilities
const CAP_DESCRIPTIONS: Record<string, { icon: string; label: string; desc: string }> = {
  "storage.write": { icon: "💾", label: "storage.write", desc: "Write files to the plugin's private storage area" },
  "webhooks.listen": { icon: "🔗", label: "webhooks.listen", desc: "Register inbound webhook endpoints on this server" },
  "http.outbound": { icon: "🌐", label: "http.outbound", desc: "Make outbound HTTP requests to external services" },
  "agent.tools.register": { icon: "🔧", label: "agent.tools.register", desc: "Register tools that agents can invoke" },
  "jobs.schedule": { icon: "⏰", label: "jobs.schedule", desc: "Schedule recurring background jobs" },
};

interface Props {
  companyId: string;
  pluginId: string;
  pluginName: string;
  fromVersion: string;
  toVersion: string;
  delta: string[];       // new capability strings
  onApproved: () => void;
  onCancelled: () => void;
}

export function CapabilityDeltaModal({
  companyId,
  pluginId,
  pluginName,
  fromVersion,
  toVersion,
  delta,
  onApproved,
  onCancelled,
}: Props) {
  const queryClient = useQueryClient();

  const approveMutation = useMutation({
    mutationFn: () => pluginsApi.approvePluginUpgrade(companyId, pluginId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["company-plugins", companyId] });
      onApproved();
    },
  });

  const rollbackMutation = useMutation({
    mutationFn: () => pluginsApi.rollbackPluginUpgrade(companyId, pluginId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["company-plugins", companyId] });
      onCancelled();
    },
  });

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 max-w-md w-full shadow-2xl">
        <h2 className="text-base font-bold text-zinc-100 mb-1">New permissions required</h2>
        <p className="text-xs text-zinc-500 mb-4">
          Upgrading {pluginName} {fromVersion} → {toVersion}
        </p>

        <p className="text-sm text-zinc-400 mb-3">
          This version adds new capabilities to the plugin. Review them before approving.
        </p>

        <div className="space-y-2 mb-5">
          {delta.map((cap) => {
            const known = CAP_DESCRIPTIONS[cap];
            return (
              <div
                key={cap}
                className="flex items-start gap-3 bg-indigo-950/30 border border-indigo-900/40 rounded-lg p-3"
              >
                <span className="text-base mt-0.5">{known?.icon ?? "⚡"}</span>
                <div>
                  <div className="text-xs font-semibold text-indigo-300">
                    {known?.label ?? cap}
                  </div>
                  <div className="text-[10px] text-zinc-500 mt-0.5">
                    {known?.desc ?? "New capability granted to this plugin"}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => rollbackMutation.mutate()}
            disabled={rollbackMutation.isPending || approveMutation.isPending}
            className="flex-1 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-60 text-zinc-300 text-xs font-medium py-2.5 rounded-lg transition-colors"
          >
            {rollbackMutation.isPending ? "Rolling back…" : "Cancel"}
          </button>
          <button
            type="button"
            onClick={() => approveMutation.mutate()}
            disabled={approveMutation.isPending || rollbackMutation.isPending}
            className="flex-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white text-xs font-semibold py-2.5 px-4 rounded-lg transition-colors"
          >
            {approveMutation.isPending ? "Approving…" : "Approve & Upgrade"}
          </button>
        </div>

        {(approveMutation.isError || rollbackMutation.isError) && (
          <p className="text-[10px] text-red-400 mt-2 text-center">
            {(approveMutation.error ?? rollbackMutation.error) instanceof Error
              ? (approveMutation.error ?? rollbackMutation.error)!.message
              : "Operation failed — try again"}
          </p>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add ui/src/components/settings/CapabilityDeltaModal.tsx
git commit -m "feat(ui): add CapabilityDeltaModal for approving new plugin capabilities on upgrade"
```

---

## Task 13: PluginDetailSlideOver

**Files:**
- Create: `ui/src/components/settings/PluginDetailSlideOver.tsx`

- [ ] **Step 1: Create the component**

Create `ui/src/components/settings/PluginDetailSlideOver.tsx`:

```tsx
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import type { InstalledPlugin } from "../../api/plugins.js";
import * as pluginsApi from "../../api/plugins.js";
import type { PendingUpdate } from "../../api/marketplace.js";
import { PluginConfigForm } from "./PluginConfigForm.js";
import { CapabilityDeltaModal } from "./CapabilityDeltaModal.js";

interface Props {
  companyId: string;
  plugin: InstalledPlugin;
  pendingUpdate: PendingUpdate | undefined;
  onClose: () => void;
}

type Tab = "overview" | "settings";

export function PluginDetailSlideOver({ companyId, plugin, pendingUpdate, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("overview");
  const [upgradeResult, setUpgradeResult] = useState<pluginsApi.UpgradeResult | null>(null);
  const queryClient = useQueryClient();

  const { data: config } = useQuery({
    queryKey: ["plugin-config", companyId, plugin.id],
    queryFn: () => pluginsApi.getPluginConfig(companyId, plugin.id),
    enabled: tab === "settings",
  });

  const upgradeMutation = useMutation({
    mutationFn: (version: string) => pluginsApi.upgradePlugin(companyId, plugin.id, version),
    onSuccess: (result) => {
      if (result.status === "ready") {
        queryClient.invalidateQueries({ queryKey: ["company-plugins", companyId] });
      } else {
        setUpgradeResult(result);
      }
    },
  });

  const toggleMutation = useMutation({
    mutationFn: (enabled: boolean) => pluginsApi.patchPluginSettings(companyId, plugin.id, enabled),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["company-plugins", companyId] }),
  });

  const statusColor: Record<string, string> = {
    ready: "text-green-400",
    error: "text-red-400",
    upgrade_pending: "text-indigo-400",
    disabled: "text-zinc-500",
    installed: "text-zinc-400",
  };

  return (
    <>
      {upgradeResult?.status === "upgrade_pending" && upgradeResult.delta && (
        <CapabilityDeltaModal
          companyId={companyId}
          pluginId={plugin.id}
          pluginName={plugin.manifest.displayName}
          fromVersion={plugin.version}
          toVersion={upgradeResult.version}
          delta={upgradeResult.delta}
          onApproved={() => {
            setUpgradeResult(null);
            queryClient.invalidateQueries({ queryKey: ["company-plugins", companyId] });
          }}
          onCancelled={() => setUpgradeResult(null)}
        />
      )}

      <div className="w-[360px] bg-zinc-900 border-l border-zinc-800 flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-4 pt-4 pb-0 border-b border-zinc-800">
          <div className="flex items-start justify-between mb-3">
            <div className="flex items-center gap-2.5">
              <div className="text-xl">{plugin.categories.includes("notifications") ? "🔔" : "🔌"}</div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold text-zinc-100">{plugin.manifest.displayName}</span>
                  <span className="text-[9px] bg-indigo-950 border border-indigo-900 text-indigo-300 px-1.5 py-0.5 rounded-full">
                    Plugin
                  </span>
                </div>
                <div className="text-[10px] text-zinc-600 font-mono truncate max-w-[220px]">
                  {plugin.packageName}
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="text-zinc-600 hover:text-zinc-400 p-1"
            >
              <X size={14} />
            </button>
          </div>

          {/* Tabs */}
          <div className="flex">
            {(["overview", "settings"] as Tab[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`px-3 py-1.5 text-xs capitalize border-b-2 transition-colors ${
                  tab === t
                    ? "text-zinc-100 border-indigo-500"
                    : "text-zinc-600 border-transparent hover:text-zinc-400"
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4">
          {tab === "overview" ? (
            <div className="space-y-1">
              {/* Info rows */}
              {[
                { label: "Installed version", value: `v${plugin.version}` },
                {
                  label: "Latest in catalog",
                  value: pendingUpdate ? `v${pendingUpdate.latestVersion}` : `v${plugin.version} (current)`,
                  valueClass: pendingUpdate ? "text-amber-400" : undefined,
                },
                {
                  label: "Status",
                  value: plugin.status,
                  valueClass: statusColor[plugin.status] ?? "text-zinc-300",
                },
                {
                  label: "Installed",
                  value: new Date(plugin.installedAt).toLocaleDateString(),
                },
              ].map(({ label, value, valueClass }) => (
                <div
                  key={label}
                  className="flex justify-between items-center py-2 border-b border-zinc-800/60"
                >
                  <span className="text-xs text-zinc-500">{label}</span>
                  <span className={`text-xs font-medium ${valueClass ?? "text-zinc-300"}`}>
                    {value}
                  </span>
                </div>
              ))}

              {/* Upgrade banner */}
              {pendingUpdate && (
                <div className="bg-amber-950/20 border border-amber-900/40 rounded-lg p-3 mt-3">
                  <div className="flex justify-between items-center mb-1.5">
                    <span className="text-xs font-bold text-amber-400">Update available</span>
                    <span className="text-[10px] text-zinc-600">
                      v{plugin.version} → v{pendingUpdate.latestVersion}
                    </span>
                  </div>
                  <p className="text-[10px] text-zinc-500 mb-2.5">
                    New version is available from the marketplace.
                  </p>
                  <button
                    type="button"
                    onClick={() => upgradeMutation.mutate(pendingUpdate.latestVersion)}
                    disabled={upgradeMutation.isPending}
                    className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white text-xs font-semibold py-1.5 rounded-md transition-colors"
                  >
                    {upgradeMutation.isPending ? "Upgrading…" : `Upgrade to v${pendingUpdate.latestVersion}`}
                  </button>
                  {upgradeMutation.isError && (
                    <p className="text-[10px] text-red-400 mt-1.5">
                      {upgradeMutation.error instanceof Error ? upgradeMutation.error.message : "Upgrade failed"}
                    </p>
                  )}
                </div>
              )}

              {/* Capabilities */}
              {plugin.manifest.capabilities.length > 0 && (
                <>
                  <p className="text-[10px] font-semibold text-zinc-600 uppercase tracking-wider mt-4 mb-2">
                    Capabilities
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {plugin.manifest.capabilities.map((cap) => (
                      <span
                        key={cap}
                        className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-500"
                      >
                        {cap}
                      </span>
                    ))}
                  </div>
                </>
              )}

              {/* Error */}
              {plugin.lastError && (
                <div className="mt-3 bg-red-950/20 border border-red-900/40 rounded-lg p-3">
                  <p className="text-[10px] font-semibold text-red-400 mb-1">Last error</p>
                  <p className="text-[10px] text-zinc-500 font-mono break-all">{plugin.lastError}</p>
                </div>
              )}

              {/* Actions */}
              <div className="mt-4 space-y-2">
                <p className="text-[10px] font-semibold text-zinc-600 uppercase tracking-wider">Actions</p>
                <button
                  type="button"
                  disabled={toggleMutation.isPending}
                  onClick={() => toggleMutation.mutate(!plugin.enabled)}
                  className="w-full text-left text-xs text-zinc-400 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-60 border border-zinc-700 rounded-lg px-3 py-2 transition-colors"
                >
                  {plugin.enabled ? "Disable for this company" : "Enable for this company"}
                </button>
              </div>
            </div>
          ) : (
            <PluginConfigForm
              companyId={companyId}
              pluginId={plugin.id}
              schema={plugin.manifest.instanceConfigSchema as any}
              initialValues={config?.configJson ?? plugin.configJson}
            />
          )}
        </div>
      </div>
    </>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add ui/src/components/settings/PluginDetailSlideOver.tsx
git commit -m "feat(ui): add PluginDetailSlideOver with Overview + Settings tabs and upgrade flow"
```

---

## Task 14: PluginsSection card grid

**Files:**
- Create: `ui/src/components/settings/PluginsSection.tsx`

- [ ] **Step 1: Create the component**

Create `ui/src/components/settings/PluginsSection.tsx`:

```tsx
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Puzzle } from "lucide-react";
import { useCompany } from "../../hooks/use-company.js";
import * as pluginsApi from "../../api/plugins.js";
import * as marketplaceApi from "../../api/marketplace.js";
import { PluginDetailSlideOver } from "./PluginDetailSlideOver.js";
import type { InstalledPlugin } from "../../api/plugins.js";
import type { PendingUpdate } from "../../api/marketplace.js";
import { cn } from "../../lib/utils.js";

// Per-category gradient styles for plugin icons
const CATEGORY_STYLE: Record<string, string> = {
  notifications: "bg-gradient-to-br from-indigo-900/40 to-indigo-800/20 border border-indigo-800/30",
  issues: "bg-gradient-to-br from-slate-800/60 to-slate-700/20 border border-slate-700/30",
  storage: "bg-gradient-to-br from-emerald-900/40 to-emerald-800/20 border border-emerald-800/30",
  integrations: "bg-gradient-to-br from-violet-900/40 to-violet-800/20 border border-violet-800/30",
};

const CATEGORY_EMOJI: Record<string, string> = {
  notifications: "🔔",
  issues: "🐙",
  storage: "📦",
  integrations: "🔗",
};

function PluginStatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    ready: "bg-green-950/40 text-green-400 border-green-900",
    error: "bg-red-950/40 text-red-400 border-red-900",
    upgrade_pending: "bg-indigo-950/40 text-indigo-400 border-indigo-900",
    disabled: "bg-zinc-800 text-zinc-500 border-zinc-700",
  };
  return (
    <span className={cn("text-[10px] px-2 py-0.5 rounded-full border font-medium", styles[status] ?? "bg-zinc-800 text-zinc-500 border-zinc-700")}>
      {status}
    </span>
  );
}

function PluginCard({
  plugin,
  pendingUpdate,
  selected,
  onSelect,
}: {
  plugin: InstalledPlugin;
  pendingUpdate: PendingUpdate | undefined;
  selected: boolean;
  onSelect: () => void;
}) {
  const hasUpdate = !!pendingUpdate;
  const primaryCategory = plugin.categories[0] ?? "integrations";
  const iconStyle = CATEGORY_STYLE[primaryCategory] ?? CATEGORY_STYLE.integrations;
  const emoji = CATEGORY_EMOJI[primaryCategory] ?? "🔌";

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "relative flex flex-col gap-3 p-4 rounded-xl border text-left transition-all duration-150",
        selected
          ? "border-indigo-500 bg-indigo-950/20 shadow-[0_0_0_1px_theme(colors.indigo.500)]"
          : "border-zinc-800 bg-zinc-900 hover:border-zinc-700 hover:shadow-lg hover:shadow-black/30",
        hasUpdate && !selected && "border-t-amber-500 border-t-[3px]",
        hasUpdate && selected && "border-t-amber-500 border-t-[3px] border-l-indigo-500 border-r-indigo-500 border-b-indigo-500",
      )}
    >
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className={cn("w-10 h-10 rounded-xl flex items-center justify-center text-xl flex-shrink-0", iconStyle)}>
          {emoji}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold text-zinc-100 truncate">
            {plugin.manifest.displayName}
          </div>
          <div className="text-[10px] text-zinc-600">v{plugin.version}</div>
        </div>
      </div>

      {/* Description */}
      <p className="text-xs text-zinc-500 leading-relaxed line-clamp-2 min-h-[2.5rem]">
        {plugin.manifest.description}
      </p>

      {/* Badges */}
      <div className="flex flex-wrap gap-1.5 items-center">
        {hasUpdate && (
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-950/40 text-amber-400 border border-amber-900 font-medium animate-pulse">
            ↑ Update {pendingUpdate!.latestVersion}
          </span>
        )}
        <PluginStatusBadge status={plugin.status} />
        {plugin.categories.slice(0, 1).map((cat) => (
          <span key={cat} className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-600">
            {cat}
          </span>
        ))}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between pt-2.5 border-t border-zinc-800">
        <div className="flex gap-1 flex-wrap">
          {(plugin.manifest.capabilities ?? []).slice(0, 3).map((cap) => (
            <span key={cap} className="text-[9px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-600">
              {cap.split(".")[0]}
            </span>
          ))}
        </div>
        <span className="text-xs text-indigo-400 font-semibold whitespace-nowrap ml-2">
          {hasUpdate ? "Manage →" : "Configure →"}
        </span>
      </div>
    </button>
  );
}

export function PluginsSection() {
  const { selectedCompanyId } = useCompany();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data: installedPlugins, isLoading } = useQuery({
    queryKey: ["company-plugins", selectedCompanyId],
    queryFn: () => pluginsApi.listCompanyPlugins(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: pendingUpdates } = useQuery({
    queryKey: ["marketplace-updates", selectedCompanyId],
    queryFn: () => marketplaceApi.getUpdates(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const selectedPlugin = installedPlugins?.find((p) => p.id === selectedId) ?? null;

  if (isLoading) {
    return <div className="text-sm text-zinc-500 py-4">Loading plugins…</div>;
  }

  if (!installedPlugins || installedPlugins.length === 0) {
    return (
      <div className="space-y-3">
        <SectionHeader />
        <div className="border border-zinc-800 rounded-xl bg-zinc-900 py-10 text-center">
          <Puzzle className="h-8 w-8 text-zinc-700 mx-auto mb-3" />
          <p className="text-sm font-medium text-zinc-400">No plugins installed</p>
          <p className="text-xs text-zinc-600 mt-1 max-w-xs mx-auto">
            Install plugins from the Marketplace to get started.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-4">
      {/* Card grid */}
      <div className="flex-1 space-y-3">
        <SectionHeader count={installedPlugins.length} />
        <div className="grid grid-cols-2 gap-3">
          {installedPlugins.map((plugin) => (
            <PluginCard
              key={plugin.id}
              plugin={plugin}
              pendingUpdate={pendingUpdates?.find(
                (u) => u.catalogItemId === plugin.catalogItemId,
              )}
              selected={plugin.id === selectedId}
              onSelect={() => setSelectedId(plugin.id === selectedId ? null : plugin.id)}
            />
          ))}
        </div>
      </div>

      {/* Slide-over */}
      {selectedPlugin && (
        <PluginDetailSlideOver
          companyId={selectedCompanyId!}
          plugin={selectedPlugin}
          pendingUpdate={pendingUpdates?.find(
            (u) => u.catalogItemId === selectedPlugin.catalogItemId,
          )}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}

function SectionHeader({ count }: { count?: number }) {
  return (
    <div className="space-y-1">
      <h2 className="text-base font-semibold text-zinc-100">
        Plugins
        {count !== undefined && (
          <span className="ml-2 text-xs font-normal text-zinc-500">({count} installed)</span>
        )}
      </h2>
      <p className="text-sm text-zinc-500">
        Manage plugin configuration and updates for this company.
      </p>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add ui/src/components/settings/PluginsSection.tsx
git commit -m "feat(ui): add PluginsSection — 2-column plugin card grid with slide-over"
```

---

## Task 15: Swap PluginsSection into SettingsPage + simplify InstanceSettingsPage

**Files:**
- Modify: `ui/src/pages/SettingsPage.tsx`
- Modify: `ui/src/pages/InstanceSettingsPage.tsx`

- [ ] **Step 1: Read the current PluginsSection usage in SettingsPage.tsx**

```bash
grep -n "PluginsSection\|Plugins\|plugin" ui/src/pages/SettingsPage.tsx | head -20
```

- [ ] **Step 2: Replace the import**

In `ui/src/pages/SettingsPage.tsx`, find the existing `PluginsSection` (defined inline or imported). Replace with the new import:

```typescript
// Remove any existing inline PluginsSection definition
// Add this import at the top of the file:
import { PluginsSection } from "../components/settings/PluginsSection.js";
```

- [ ] **Step 3: Verify the Plugins tab uses the new component**

The Plugins tab in SettingsPage should render `<PluginsSection />` with no props (it reads `selectedCompanyId` from context internally). Confirm the tab content is:

```tsx
// Inside the Plugins tab panel:
<PluginsSection />
```

If the old inline `PluginsSection` function still exists in the file, delete it entirely (roughly lines 1461–1564 based on the code review).

- [ ] **Step 4: Simplify InstanceSettingsPage Plugins tab**

In `ui/src/pages/InstanceSettingsPage.tsx`, find the Plugins tab content (search for `PluginManager` or the install/config forms). Replace the entire Plugins tab content with:

```tsx
// Plugins tab — diagnostics only (M.4: management moved to Company Settings)
<div className="space-y-4">
  <div className="bg-indigo-950/30 border border-indigo-900/40 rounded-lg px-4 py-3 text-xs text-indigo-300">
    Plugin installation and configuration is available in each company's{" "}
    <strong>Settings → Plugins</strong> tab.
  </div>
  <PluginDiagnosticsPanel />
</div>
```

Where `PluginDiagnosticsPanel` is a new inline component (add it in the same file):

```tsx
function PluginDiagnosticsPanel() {
  // Reads from the existing instance-level plugin list endpoint
  const { data: allPlugins } = useQuery({
    queryKey: ["instance-plugins-health"],
    queryFn: () => pluginsApi.listAll(),   // existing GET /api/plugins endpoint
    refetchInterval: 30_000,
  });

  if (!allPlugins?.length) {
    return <p className="text-xs text-zinc-500 py-2">No plugins installed on this instance.</p>;
  }

  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">Worker health</p>
      {allPlugins.map((plugin: any) => (
        <div
          key={plugin.id}
          className="flex items-center gap-3 px-3 py-2.5 bg-zinc-900 border border-zinc-800 rounded-lg"
        >
          <span
            className={`w-2 h-2 rounded-full flex-shrink-0 ${
              plugin.status === "ready" ? "bg-green-400" : "bg-red-400"
            }`}
          />
          <span className="text-xs text-zinc-300 flex-1 truncate">
            {plugin.manifest?.displayName ?? plugin.pluginKey}
            {plugin.companyId && (
              <span className="text-zinc-600 ml-1">({plugin.companyId.slice(0, 8)}…)</span>
            )}
          </span>
          <span className="text-[10px] text-zinc-600 whitespace-nowrap">{plugin.status}</span>
          {plugin.lastError && (
            <span
              className="text-[10px] text-red-400 truncate max-w-[160px]"
              title={plugin.lastError}
            >
              {plugin.lastError}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
```

Note: `pluginsApi.listAll()` should map to the existing `GET /api/plugins` instance-level endpoint. Check how it's currently called in `InstanceSettingsPage.tsx` and use the same function.

- [ ] **Step 5: Run typecheck**

```bash
pnpm typecheck --filter ui
```

Fix any errors (typically missing imports or prop type mismatches).

- [ ] **Step 6: Verify UI builds**

```bash
pnpm build --filter ui
```

Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add ui/src/pages/SettingsPage.tsx ui/src/pages/InstanceSettingsPage.tsx
git commit -m "feat(ui): replace PluginsSection with card grid; simplify InstanceSettingsPage to diagnostics only"
```

---

## Self-Review Checklist

Before handing off for execution, verify:

- [ ] All 6 spec sections are covered: schema migration ✓, plugin loader refactor ✓, upgrade flow ✓, update checker ✓, company Settings UI ✓, instance Settings simplification ✓
- [ ] `companyId` is threaded through: schema (T1-T3) → loader (T4) → installer (T5) → lifecycle (T6) → update checker (T7) → routes (T8) → UI queries (T14)
- [ ] Types consistent: `InstalledPlugin` defined in T10 used in T13, T14. `UpgradeResult` defined in T10 used in T13. `PendingUpdate` from existing `marketplace.ts` used in T14.
- [ ] Rollback table is `pluginVersionSnapshots` (already exists) — used correctly in T6 and T8.
- [ ] No placeholder steps — all code shown in full.
