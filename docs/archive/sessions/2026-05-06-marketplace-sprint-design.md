# Marketplace Sprint Design
**Date:** 2026-05-06  
**Repos:** `AoA-2.5` (main app) + `aoa-marketplace` (plugin catalog)  
**Approach:** Parallel tracks — Track M (marketplace fixes) and Track A (AoA-2.5 UI fixes) run concurrently; blocked items (catalog publish, E2E) land last.

---

## Background

The marketplace install flow is broken end-to-end:

- No `@armyofagents` packages exist on npm — `POST /marketplace/install` always 404s
- The Slack plugin manifest is severely stale (3 caps vs 20 in runtime source)
- Version numbers are split across 3 files per plugin
- The catalog snapshot predates the github-issues fix
- No CI validator catches manifest drift
- The AoA-2.5 UI never shows "Installed" state on catalog cards
- Install-modal polling can re-attach to a stale operation on reopen

This sprint closes all 9 open items across both repos.

---

## Scope

| # | Item | Repo | Track |
|---|---|---|---|
| 3 | Slack `manifest.json` → match `src/manifest.ts` | aoa-marketplace | M |
| 2 | Version drift: align `package.json` / `manifest.json` / `constants.ts` | aoa-marketplace | M |
| 5 | Validator: detect manifest drift in CI | aoa-marketplace | M |
| 1 | GitHub release tarballs + catalog `tarballUrl` + `plugin-installer.ts` adapter | aoa-marketplace + AoA-2.5 | M |
| 4 | Regenerate + publish catalog snapshot | aoa-marketplace | M (last) |
| 6 | `CatalogCard.tsx` installed-state rendering | AoA-2.5 | A |
| 7 | `useOperationStatus.ts` staleness guard | AoA-2.5 | A |
| 8 | UI slot coverage audit + doc | AoA-2.5 | A (interactive) |
| 9 | GitHub plugin E2E config + dry-run | AoA-2.5 | A (last) |

---

## Track M — aoa-marketplace

### M1 · Slack manifest.json fix (item 3)

**Root cause:** `plugins/aoa-plugin-slack/manifest.json` was never updated after M.1.H. It still declares 3 pre-M.1.5 placeholder capabilities. The AoA plugin loader validates capabilities at install time — any capability used by the worker but absent from `manifest.json` is silently denied.

**Stale caps (to remove):**
```
slack.send_message
slack.read_channels
network.outbound
```

**Correct caps (from `src/manifest.ts`, 20 total):**
```
companies.read
issues.read
issues.create
agents.read
agent.sessions.create
agent.sessions.send
agent.sessions.close
agents.invoke
events.subscribe
events.emit
plugin.state.read
plugin.state.write
http.outbound
secrets.read-ref
webhooks.receive
instance.settings.register
activity.log.write
metrics.write
jobs.schedule
agent.tools.register
```

**File:** `plugins/aoa-plugin-slack/manifest.json` — replace the `capabilities` array.

**Verification:** `pnpm validate` passes; `pnpm aggregate` produces a catalog item for Slack with 20 capabilities.

---

### M2 · Version drift fix (item 2)

**Root cause:** `src/constants.ts` was updated independently during development without bumping `package.json` or `manifest.json`. Three plugins are affected:

| Plugin | `package.json` | `manifest.json` | `constants.ts` (PLUGIN_VERSION) |
|---|---|---|---|
| aoa-plugin-discord | `1.0.0` | `1.0.0` | `0.7.3` ← wrong |
| aoa-plugin-github-issues | `1.0.0` | `1.0.0` | `0.1.1` ← wrong |
| aoa-plugin-slack | `1.0.0` | `1.0.0` | `2.0.6` ← wrong |
| aoa-plugin-telegram | `1.0.0` | `1.0.0` | `1.0.0` ✓ |

**Source of truth decision:** `package.json` is the npm source of truth. It controls what `npm install` resolves to and what the catalog aggregator reads. `manifest.json` and `constants.ts` must match it.

**Fix:** Update `PLUGIN_VERSION` in `src/constants.ts` to `"1.0.0"` for discord, github-issues, and slack.

**Files:**
- `plugins/aoa-plugin-discord/src/constants.ts`
- `plugins/aoa-plugin-github-issues/src/constants.ts`
- `plugins/aoa-plugin-slack/src/constants.ts`

**Verification:** `grep -r PLUGIN_VERSION plugins/*/src/constants.ts` all return `1.0.0`.

---

### M3 · GitHub release tarballs + tarballUrl wiring (item 1)

**Root cause:** The catalog `npm.packageName` field points to `@armyofagents/*` packages that don't exist on the npm registry. `plugin-installer.ts` passes this directly to `npm install`, which 404s.

**Design:**

#### 3a. CI release job (`aoa-marketplace`)

New workflow: `.github/workflows/release-plugins.yml`

```
trigger: push to tag v*
for each plugin in plugins/:
  pnpm --filter <plugin> build
  npm pack --workspace plugins/<plugin>   → <plugin>-<version>.tgz
  gh release upload v<tag> <plugin>-<version>.tgz
```

One tag covers all 4 plugins (they share the same release version for now). Tag format: `v1.0.0`.

#### 3b. CatalogItem type extension (`@armyofagents/shared`)

Add optional `tarballUrl` to the `npm` object on `CatalogItem`:

```ts
// packages/shared/src/types/marketplace.ts (or wherever CatalogItem lives)
npm?: {
  packageName: string;
  version: string;
  tarballUrl?: string;   // ← new: GitHub release tarball URL
}
```

#### 3c. Catalog aggregator update (`aoa-marketplace`)

The aggregator (`catalog/src/`) populates `tarballUrl` when building plugin entries:

```ts
tarballUrl: `https://github.com/MeteoriteLabs/aoa-marketplace/releases/download/v${version}/${packageName}-${version}.tgz`
```

`MeteoriteLabs` is the GitHub org — derived from `DEFAULT_CDN_URL` in `server/src/services/aoa-marketplace.ts:24`. Store it as a constant in the aggregator config, not hardcoded in the template string.

#### 3d. plugin-installer.ts adapter (`AoA-2.5`)

In `server/src/services/marketplace-install/plugin-installer.ts`, change the `installPlugin` call:

```ts
// Before:
const discovered = await pluginLoader.installPlugin({
  packageName: catalogItem.npm.packageName,
  version: catalogItem.npm.version,
});

// After:
const installSpec = catalogItem.npm.tarballUrl
  ? { packageName: catalogItem.npm.tarballUrl }          // npm install <tarball-url>
  : { packageName: catalogItem.npm.packageName, version: catalogItem.npm.version };

const discovered = await pluginLoader.installPlugin(installSpec);
```

`plugin-loader.ts:830` already builds `spec = version ? ${packageName}@${version} : packageName` — passing just `packageName` (the tarball URL) with no version produces `npm install https://...tgz`, which is standard npm behavior.

**Verification:** `POST /api/marketplace/companies/:cid/install` with a plugin item returns `200`, plugin appears in `GET /api/plugins` with `status: ready`.

---

### M4 · Manifest drift validator (item 5)

**Root cause:** Both the Slack bug (3 stale caps) and the github-issues bug (`jobs.schedule` missing) would have been caught at CI time if the validator compared `manifest.json` against the compiled `src/manifest.ts`.

**Design:**

New validator function in `catalog/src/validators/manifest-drift.ts`:

```ts
export function checkManifestDrift(
  pluginDir: string,             // absolute path to plugin root
  manifestJson: PluginManifest,  // parsed manifest.json
): CheckResult
```

Steps:
1. Import the plugin's compiled manifest from `dist/` (post-build): `require(pluginDir + '/dist/manifest.js')` or equivalent ESM dynamic import
2. Extract `capabilities[]` from both the compiled manifest and `manifest.json`
3. For each cap in compiled manifest absent from `manifest.json` → failure
4. For each cap in `manifest.json` absent from compiled manifest → warning (stale, not breaking)

Called from the aggregate pipeline **after** `pnpm build` for each plugin, before `runAutomatedChecks`.

**CI integration:** The drift check requires each plugin to be built first (it reads `dist/manifest.js`). Integration point is the **aggregate pipeline** (`catalog/src/aggregate.ts` or equivalent), after `pnpm build` for each plugin and before the catalog entry is written. `automated-checks.ts` (the schema/semver/license checker) runs on the static `manifest.json` and does not need a build — keep these two validators separate. The aggregate pipeline fails non-zero if any drift check fails, which blocks `pnpm publish-cdn`.

**Files:**
- `catalog/src/validators/manifest-drift.ts` (new)
- `catalog/src/aggregate.ts` — call `checkManifestDrift` per plugin after build, before entry assembly

---

### M5 · Catalog snapshot regeneration (item 4)

After M1–M3 land and a `v1.0.0` tag is pushed:

1. The release CI job builds + uploads 4 `.tgz` files to the GitHub release
2. Run `pnpm aggregate` locally (or let CI do it on `main` merge) — regenerates `dist/catalog.json` with:
   - Correct versions (`1.0.0` everywhere)
   - Slack with 20 capabilities
   - `tarballUrl` populated for all 4 plugins
   - Fresh `generatedAt` timestamp
3. The existing GitHub Pages pipeline (commit `97e7df2`) publishes `dist/catalog.json` to the CDN on merge to `main`
4. AoA-2.5 fetches the updated catalog on next `GET /api/marketplace/catalog` — no server restart needed if the catalog URL is remote-fetched with a reasonable TTL

**Verification:** `curl https://meteoritelabs.github.io/aoa-marketplace-cdn/catalog.json | jq '.generatedAt'` returns today's date; each plugin entry has a non-null `tarballUrl`.

---

## Track A — AoA-2.5

### A1 · CatalogCard installed-state (item 6)

**Root cause:** `ui/src/components/marketplace/CatalogCard.tsx` always renders "Install". The pattern for installed-state lookup already exists in `PluginManager.tsx:149` (`installedByPackageName` map) but was never applied to `CatalogCard`.

**Design:**

Add prop to `CatalogCard`:
```ts
interface CatalogCardProps {
  item: CatalogItem;
  installedByPackageName?: Map<string, InstalledPlugin>;  // ← new, optional
}
```

Button rendering logic:
```ts
const installedPlugin = item.npm?.packageName
  ? installedByPackageName?.get(item.npm.packageName)
  : undefined;
```

| `installedPlugin` state | Rendered element |
|---|---|
| `undefined` | `<Button>Install</Button>` (current) |
| `status === "ready"` | `<Badge className="bg-green-600">Installed</Badge>` (disabled, no onClick) |
| any other status | `<Badge variant="secondary">Pending</Badge>` + link to plugin settings |

The parent `MarketplacePage` already calls `GET /api/plugins` (or can use the existing `usePlugins` hook) — it builds the map and passes it to each `CatalogCard`.

**Files:**
- `ui/src/components/marketplace/CatalogCard.tsx`
- `ui/src/pages/Marketplace.tsx` — main catalog listing
- `ui/src/pages/MarketplaceSearch.tsx` — search results listing
- `ui/src/pages/MarketplaceType.tsx` — type-filtered listing

All three pages render `CatalogCard` and need the `installedByPackageName` map passed down.

**Verification:** Install a plugin via local-path, navigate to Marketplace — the card shows "Installed" in green without a page reload.

---

### A2 · Operation polling staleness guard (item 7)

**Root cause:** `useOperationStatus.ts` polls by `operationId`. The hook correctly stops polling on terminal states (`success/failure/requested`), but if the modal closes and reopens passing the same `operationId`, it re-mounts and briefly shows a loading state against an already-finished operation.

**Design:**

**Part 1 — `useOperationStatus.ts`:** Add `startedAfter?: Date` option. If the fetched operation's `createdAt` is before `startedAfter`, return a synthetic stale-failure immediately without polling:

```ts
export interface UseOperationStatusOpts {
  companyId: string | null;
  operationId: string | null;
  startedAfter?: Date;  // ← new
}

// Inside queryFn, after fetching:
if (opts.startedAfter && new Date(data.createdAt) < opts.startedAfter) {
  return { ...data, status: "failure", error: "stale_operation" };
}
```

**Part 2 — `PluginInstallModal.tsx`:** Capture `openedAt = useRef(new Date())` when the modal mounts (or resets on `open` transition). Pass it as `startedAfter` to `useOperationStatus`.

```ts
const openedAt = useRef<Date>(new Date());
useEffect(() => {
  if (open) openedAt.current = new Date();
}, [open]);

const operation = useOperationStatus({
  companyId,
  operationId,
  startedAfter: openedAt.current,
});
```

**Files:**
- `ui/src/hooks/useOperationStatus.ts`
- `ui/src/components/marketplace/install/PluginInstallModal.tsx`

**Verification:** Trigger a failed install, close modal, reopen for same plugin — modal shows fresh "Install" state, not a loading spinner.

---

### A3 · UI slot coverage audit (item 8)

**Goal:** Determine which of the 13 slot types declared by `aoa-kitchen-sink-example` are actually rendered by the host, and document the gaps.

**Slot types to verify (13 total):**

| Slot type | Where to look in the UI |
|---|---|
| `sidebar` | Left sidebar — look for injected item |
| `dashboardWidget` | Home page — look for extra widget |
| `settingsPage` | Settings → should have a plugin-injected page |
| `projectSidebarItem` | Department/Project sidebar |
| `detailTab` (×2) | Task slideover — tabs row |
| `taskDetailView` | Task slideover — main body |
| `toolbarButton` | Top toolbar |
| `contextMenuItem` | Right-click context menu on a task |
| `commentAnnotation` | Comment thread on a task |
| `commentContextMenuItem` | Right-click on a comment |
| `sidebarPanel` | Right-side panel |
| `page` | Dedicated route — look for `/plugins/kitchen-sink/...` |

**Output:** `docs/aoa/reference/plugin-slot-coverage.md` — a table with columns: slot type / renders / notes. One GitHub issue filed per unrendered slot with steps to reproduce.

**This step requires TK at the screen** — interactive walkthrough.

---

### A4 · GitHub plugin E2E config (item 9)

**Goal:** Validate the full arc: install from catalog → configure with secrets → invoke a tool.

**Steps (API-driven):**

```bash
# 1. Create a secret for the GitHub PAT
POST /api/companies/:cid/secrets
{ "name": "github_pat", "value": "<your PAT>" }
# → { "id": "<secretId>" }

# 2. Configure the plugin instance
PATCH /api/plugins/:pluginId/config
{ "githubTokenRef": "<secretId>", "defaultRepo": "<owner/repo>" }

# 3. Invoke the search tool
POST /api/companies/:cid/mcp
{
  "jsonrpc": "2.0", "method": "tools/call",
  "params": { "name": "github_issues__search", "arguments": { "query": "bug", "limit": 3 } }
}
# → expect results array, not an error
```

**Blocked by:** M3 must work so the plugin was installed from the catalog (not local-path) before this test is considered the full E2E. Config + invoke steps can be validated against the existing local-path install in the meantime.

---

## Sequencing Summary

```
Day 1
├── Track M: M1 (Slack manifest) + M2 (version drift)        [~1h, pure text edits]
├── Track A: A1 (CatalogCard installed state)                 [~30min]
└── Track A: A2 (polling staleness guard)                     [~45min]

Day 2
├── Track M: M4 (manifest drift validator)                    [~2h]
└── Track M: M3a (release CI job)                             [~1h]

Day 3
├── Track M: M3b+c (tarballUrl in shared types + aggregator)  [~1h]
├── Track M: M3d (plugin-installer.ts adapter)               [~30min]
├── Track M: M5 (tag v1.0.0, run aggregate, publish)         [~30min]
└── Track A: A3 (slot coverage walkthrough — interactive)     [~1h with TK]

Day 4
└── Track A: A4 (E2E GitHub plugin config + dry-run)          [~30min]
```

---

## Acceptance Criteria

| # | Done when |
|---|---|
| M1 | `pnpm validate` passes for Slack; catalog item shows 20 caps |
| M2 | All 4 plugins report `1.0.0` in `package.json`, `manifest.json`, and `constants.ts` |
| M3 | `POST /marketplace/install` for a catalog plugin succeeds end-to-end; plugin appears `status: ready` |
| M4 | Introducing a cap in `src/manifest.ts` without updating `manifest.json` fails `pnpm validate` |
| M5 | CDN catalog.json `generatedAt` is today; all 4 plugins have `tarballUrl` |
| A1 | Installed plugin shows green "Installed" badge on its catalog card |
| A2 | Reopening install modal after a failed op shows fresh state, not loading spinner |
| A3 | `docs/aoa/reference/plugin-slot-coverage.md` exists; issues filed for unrendered slots |
| A4 | `github_issues__search` tool returns results against a real repo |

---

## Files Changed

### aoa-marketplace
- `plugins/aoa-plugin-slack/manifest.json` — replace capabilities array (3 → 20)
- `plugins/aoa-plugin-discord/src/constants.ts` — PLUGIN_VERSION → `1.0.0`
- `plugins/aoa-plugin-github-issues/src/constants.ts` — PLUGIN_VERSION → `1.0.0`
- `plugins/aoa-plugin-slack/src/constants.ts` — PLUGIN_VERSION → `1.0.0`
- `catalog/src/validators/manifest-drift.ts` — new file
- `catalog/src/aggregate.ts` — call manifest-drift per plugin post-build
- `.github/workflows/release-plugins.yml` — new release CI job (build + pack + upload tgz)

### AoA-2.5
- `packages/shared/src/types/marketplace.ts` — add `tarballUrl?` to `CatalogItem.npm`
- `server/src/services/marketplace-install/plugin-installer.ts` — use tarballUrl as install spec when present
- `ui/src/components/marketplace/CatalogCard.tsx` — installed-state rendering + `installedByPackageName` prop
- `ui/src/pages/Marketplace.tsx` — pass installedByPackageName map to CatalogCard
- `ui/src/pages/MarketplaceSearch.tsx` — pass installedByPackageName map to CatalogCard
- `ui/src/pages/MarketplaceType.tsx` — pass installedByPackageName map to CatalogCard
- `ui/src/hooks/useOperationStatus.ts` — add `startedAfter` option
- `ui/src/components/marketplace/install/PluginInstallModal.tsx` — pass `startedAfter`
- `docs/aoa/reference/plugin-slot-coverage.md` — new (A3 output)
