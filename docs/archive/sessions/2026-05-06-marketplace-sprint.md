# Marketplace Sprint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all 9 open marketplace items across `AoA-2.5` and `aoa-marketplace` so the install-from-catalog flow works end-to-end via GitHub release tarballs.

**Architecture:** Two parallel tracks — Track M fixes the `aoa-marketplace` catalog repo (manifest correctness, version drift, tarball distribution, drift validator); Track A fixes `AoA-2.5` UI and server (installed-state on catalog cards, stale polling guard, slot audit, E2E). M3 spans both repos (shared type + adapter + server). Tracks are independent until A4 (E2E), which requires M3 to be live.

**Tech Stack:** TypeScript, pnpm workspaces, Zod schemas, React Query, Vitest, Playwright, GitHub Actions, `npm install <tarball-url>`

---

## File Map

### aoa-marketplace repo
| File | Action | Purpose |
|---|---|---|
| `plugins/aoa-plugin-slack/manifest.json` | Modify | Replace 3 stale caps with 20 correct ones |
| `plugins/aoa-plugin-discord/src/constants.ts` | Modify | PLUGIN_VERSION → `"1.0.0"` |
| `plugins/aoa-plugin-github-issues/src/constants.ts` | Modify | PLUGIN_VERSION → `"1.0.0"` |
| `plugins/aoa-plugin-slack/src/constants.ts` | Modify | PLUGIN_VERSION → `"1.0.0"` |
| `catalog/src/types/catalog.ts` | Modify | Add `tarballUrl?: string` to `NpmRefSchema` |
| `catalog/src/sources/aoa-curated/adapter.ts` | Modify | Populate `tarballUrl` in plugin items; call drift check |
| `catalog/src/validators/manifest-drift.ts` | Create | New validator: diff `dist/manifest.js` vs `manifest.json` |
| `.github/workflows/release-plugins.yml` | Create | Build + pack + upload `.tgz` on `v*` tag push |

### AoA-2.5 repo
| File | Action | Purpose |
|---|---|---|
| `packages/shared/src/marketplace.ts` | Modify | Add `tarballUrl?: string` to `npm` schema in `MarketplaceCatalogItemSchema` |
| `server/src/services/marketplace-install/plugin-installer.ts` | Modify | Use `tarballUrl` as install spec when present |
| `ui/src/components/marketplace/CatalogCard.tsx` | Modify | Add `installedByPackageName` prop; render Installed/Pending badge |
| `ui/src/pages/Marketplace.tsx` | Modify | Fetch plugin list; pass `installedByPackageName` map to cards |
| `ui/src/pages/MarketplaceSearch.tsx` | Modify | Same — pass map to cards |
| `ui/src/pages/MarketplaceType.tsx` | Modify | Same — pass map to cards |
| `ui/src/hooks/useOperationStatus.ts` | Modify | Add `startedAfter?: Date` option |
| `ui/src/components/marketplace/install/PluginInstallModal.tsx` | Modify | Capture `openedAt`; pass as `startedAfter` |
| `ui/src/__tests__/__fixtures__/marketplace-catalog.ts` | Modify | Add `tarballUrl` to `SLACK_PLUGIN` fixture |
| `ui/src/components/marketplace/__tests__/CatalogCard.test.tsx` | Modify | Add installed/pending state test cases |
| `docs/aoa/reference/plugin-slot-coverage.md` | Create | Slot coverage audit output (A3) |

---

## TRACK M — aoa-marketplace

---

### Task M1: Fix Slack manifest.json capabilities

**Files:**
- Modify: `plugins/aoa-plugin-slack/manifest.json`

- [ ] **Step 1: Replace the capabilities array and descriptions**

Replace the entire file content with:

```json
{
  "id": "aoa.plugin-slack",
  "displayName": "Slack Chat OS",
  "description": "Full Chat OS for Slack: escalation, multi-agent sessions, media pipeline, custom commands, and proactive suggestions. Push AoA notifications, receive slash commands, and manage agent workflows.",
  "version": "1.0.0",
  "license": "MIT",
  "categories": ["integrations"],
  "capabilities": [
    "companies.read",
    "issues.read",
    "issues.create",
    "agents.read",
    "agent.sessions.create",
    "agent.sessions.send",
    "agent.sessions.close",
    "agents.invoke",
    "events.subscribe",
    "events.emit",
    "plugin.state.read",
    "plugin.state.write",
    "http.outbound",
    "secrets.read-ref",
    "webhooks.receive",
    "instance.settings.register",
    "activity.log.write",
    "metrics.write",
    "jobs.schedule",
    "agent.tools.register"
  ],
  "capabilityDescriptions": {
    "companies.read": "Read AoA company data for per-company Slack channel routing",
    "issues.read": "Read AoA tasks to post notifications to Slack channels",
    "issues.create": "Create AoA tasks from Slack slash commands and messages",
    "agents.read": "Read AoA agent data for multi-agent Slack session routing",
    "agent.sessions.create": "Start multi-agent working sessions from Slack threads",
    "agent.sessions.send": "Send messages into active agent sessions from Slack",
    "agent.sessions.close": "Close multi-agent sessions and post summaries to Slack",
    "agents.invoke": "Invoke AoA agents with context assembled from Slack threads",
    "events.subscribe": "Subscribe to AoA events to push Slack channel notifications",
    "events.emit": "Emit AoA events from Slack actions and slash commands",
    "plugin.state.read": "Read persisted state for channel mappings and session tracking",
    "plugin.state.write": "Write persisted state for channel mappings and session tracking",
    "http.outbound": "Send HTTPS requests to Slack API endpoints",
    "secrets.read-ref": "Resolve Slack Bot Token and Signing Secret references at runtime",
    "webhooks.receive": "Receive inbound payloads from Slack Events API and slash commands",
    "instance.settings.register": "Register Slack token and signing secret configuration schema",
    "activity.log.write": "Log Slack interaction events to the AoA activity feed",
    "metrics.write": "Record Slack message and session metrics for dashboards",
    "jobs.schedule": "Schedule recurring Slack digest and proactive suggestion jobs",
    "agent.tools.register": "Register Slack-specific tools available to AoA agents"
  },
  "marketplace": {
    "category": "integrations",
    "tags": ["official"],
    "featured": true
  }
}
```

- [ ] **Step 2: Verify pnpm validate passes**

```bash
cd "path/to/aoa-marketplace"
pnpm validate
```

Expected: no failures for `plugin:aoa-curated/aoa-plugin-slack`. If the drift validator (M4) is not yet in place, warnings may appear — that's fine at this step.

- [ ] **Step 3: Commit**

```bash
git add plugins/aoa-plugin-slack/manifest.json
git commit -m "fix(slack): replace 3 stale capabilities with 20 from src/manifest.ts"
```

---

### Task M2: Fix version drift in constants.ts

**Files:**
- Modify: `plugins/aoa-plugin-discord/src/constants.ts`
- Modify: `plugins/aoa-plugin-github-issues/src/constants.ts`
- Modify: `plugins/aoa-plugin-slack/src/constants.ts`

- [ ] **Step 1: Update discord PLUGIN_VERSION**

In `plugins/aoa-plugin-discord/src/constants.ts`, change:
```ts
export const PLUGIN_VERSION = "0.7.3";
```
to:
```ts
export const PLUGIN_VERSION = "1.0.0";
```

- [ ] **Step 2: Update github-issues PLUGIN_VERSION**

In `plugins/aoa-plugin-github-issues/src/constants.ts`, change:
```ts
export const PLUGIN_VERSION = "0.1.1";
```
to:
```ts
export const PLUGIN_VERSION = "1.0.0";
```

- [ ] **Step 3: Update slack PLUGIN_VERSION**

In `plugins/aoa-plugin-slack/src/constants.ts`, change:
```ts
export const PLUGIN_VERSION = "2.0.6";
```
to:
```ts
export const PLUGIN_VERSION = "1.0.0";
```

- [ ] **Step 4: Verify all four plugins are aligned**

Run from the aoa-marketplace root:
```bash
grep -r "PLUGIN_VERSION" plugins/*/src/constants.ts
```

Expected output (all `1.0.0`):
```
plugins/aoa-plugin-discord/src/constants.ts:export const PLUGIN_VERSION = "1.0.0";
plugins/aoa-plugin-github-issues/src/constants.ts:export const PLUGIN_VERSION = "1.0.0";
plugins/aoa-plugin-slack/src/constants.ts:export const PLUGIN_VERSION = "1.0.0";
plugins/aoa-plugin-telegram/src/constants.ts:export const PLUGIN_VERSION = "1.0.0";
```

- [ ] **Step 5: Commit**

```bash
git add plugins/aoa-plugin-discord/src/constants.ts \
        plugins/aoa-plugin-github-issues/src/constants.ts \
        plugins/aoa-plugin-slack/src/constants.ts
git commit -m "fix(plugins): align PLUGIN_VERSION to 1.0.0 across discord, github-issues, slack"
```

---

### Task M3: Add tarballUrl to catalog types and aggregator

**Files:**
- Modify: `catalog/src/types/catalog.ts`
- Modify: `catalog/src/sources/aoa-curated/adapter.ts`

- [ ] **Step 1: Extend NpmRefSchema with tarballUrl**

In `catalog/src/types/catalog.ts`, change `NpmRefSchema`:

```ts
// Before:
export const NpmRefSchema = z.object({
  packageName: z.string().min(1),
  version: z.string().min(1),
});

// After:
export const NpmRefSchema = z.object({
  packageName: z.string().min(1),
  version: z.string().min(1),
  tarballUrl: z.string().url().optional(),
});
```

- [ ] **Step 2: Populate tarballUrl in the aoa-curated adapter**

In `catalog/src/sources/aoa-curated/adapter.ts`, add a constant near the top (after `REPO_RAW_BASE`):

```ts
const REPO_RELEASES_BASE = "https://github.com/MeteoriteLabs/aoa-marketplace/releases/download";
```

Then in the plugin item assembly block (around line 127), change:

```ts
// Before:
npm: {
  packageName: pkg.name,
  version: manifest.version,
},

// After:
npm: {
  packageName: pkg.name,
  version: manifest.version,
  tarballUrl: `${REPO_RELEASES_BASE}/v${manifest.version}/${pkg.name}-${manifest.version}.tgz`,
},
```

- [ ] **Step 3: Verify aggregate runs without errors**

```bash
cd path/to/aoa-marketplace
pnpm validate
```

Expected: each plugin item in the output now has `tarballUrl`. No new failures.

- [ ] **Step 4: Write failing test for tarballUrl in adapter output**

In `catalog/src/sources/aoa-curated/__tests__/adapter.test.ts`, add to the existing `"M.2.0 catalog field additions"` describe block:

```ts
it("emits tarballUrl on plugin items with correct pattern", async () => {
  const fetched = await aoaCuratedAdapter.fetch(ctx);
  const items = await aoaCuratedAdapter.normalize(fetched, ctx);
  const plugin = items.find((i) => i.item.type === "plugin");
  expect(plugin).toBeDefined();
  // tarballUrl must be set and reference MeteoriteLabs releases
  expect(plugin!.item.npm!.tarballUrl).toBeDefined();
  expect(plugin!.item.npm!.tarballUrl).toContain(
    "https://github.com/MeteoriteLabs/aoa-marketplace/releases/download/v",
  );
  // URL must include the plugin version
  expect(plugin!.item.npm!.tarballUrl).toContain(plugin!.item.version);
  // URL must end in .tgz
  expect(plugin!.item.npm!.tarballUrl).toMatch(/\.tgz$/);
});
```

- [ ] **Step 5: Run test to confirm it fails**

```bash
cd path/to/aoa-marketplace
pnpm --filter @armyofagents/aoa-marketplace-builder test adapter
```

Expected: FAIL — `tarballUrl` is undefined.

- [ ] **Step 6: Run test again after adapter change to confirm it passes**

After implementing Step 2 above, re-run:

```bash
pnpm --filter @armyofagents/aoa-marketplace-builder test adapter
```

Expected: All tests PASS including the new tarballUrl assertion.

- [ ] **Step 7: Commit**

```bash
git add catalog/src/types/catalog.ts catalog/src/sources/aoa-curated/adapter.ts \
        catalog/src/sources/aoa-curated/__tests__/adapter.test.ts
git commit -m "feat(catalog): add tarballUrl to NpmRefSchema and populate in aoa-curated adapter"
```

---

### Task M4: Manifest drift validator

**Files:**
- Create: `catalog/src/validators/manifest-drift.ts`
- Modify: `catalog/src/sources/aoa-curated/adapter.ts`

- [ ] **Step 1: Write the failing test first**

Create `catalog/src/validators/__tests__/manifest-drift.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkManifestDrift } from "../manifest-drift.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
// Use the real slack plugin as a fixture — after pnpm build it has dist/manifest.js
const SLACK_PLUGIN_DIR = join(__dirname, "../../../../../plugins/aoa-plugin-slack");

describe("checkManifestDrift", () => {
  it("returns skipped=true when dist/manifest.js does not exist", async () => {
    const result = await checkManifestDrift(
      "/nonexistent/path",
      ["http.outbound"],
      "test-plugin",
    );
    expect(result.skipped).toBe(true);
    expect(result.inSrcOnly).toHaveLength(0);
    expect(result.inJsonOnly).toHaveLength(0);
  });

  it("detects caps in src but missing from manifest.json", async () => {
    // Simulate: manifest.json has only 1 cap; src has 2
    const result = await checkManifestDrift(
      SLACK_PLUGIN_DIR,
      ["http.outbound"],         // manifest.json subset
      "aoa.plugin-slack",
    );
    // After fixing Slack (M1), src/manifest.ts has 20 caps.
    // Only "http.outbound" is in our fake json, so inSrcOnly must be non-empty.
    if (!result.skipped) {
      expect(result.inSrcOnly.length).toBeGreaterThan(0);
      expect(result.inSrcOnly).not.toContain("http.outbound");
    }
  });

  it("detects no drift when manifest.json matches src", async () => {
    // After M1 fix, Slack manifest.json has all 20 caps.
    // Read them and pass to validator — should produce zero drift.
    const { readFileSync } = await import("node:fs");
    const raw = JSON.parse(readFileSync(join(SLACK_PLUGIN_DIR, "manifest.json"), "utf-8")) as {
      capabilities: string[];
    };
    const result = await checkManifestDrift(
      SLACK_PLUGIN_DIR,
      raw.capabilities,
      "aoa.plugin-slack",
    );
    if (!result.skipped) {
      expect(result.inSrcOnly).toHaveLength(0);
    }
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
cd path/to/aoa-marketplace
pnpm --filter @armyofagents/aoa-marketplace-builder test manifest-drift
```

Expected: FAIL — `manifest-drift.js` not found.

- [ ] **Step 3: Implement manifest-drift.ts**

Create `catalog/src/validators/manifest-drift.ts`:

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface DriftCheckResult {
  pluginId: string;
  inSrcOnly: string[];   // present in compiled src, absent from manifest.json → CI failure
  inJsonOnly: string[];  // present in manifest.json, absent from src → warning only (stale)
  skipped: boolean;      // true when dist/manifest.js not found (build not run)
}

/**
 * Compare capabilities declared in manifest.json against the compiled src/manifest.ts.
 *
 * Requires the plugin to have been built first (dist/manifest.js must exist).
 * If dist/manifest.js is missing, returns skipped=true — callers should warn, not fail.
 *
 * inSrcOnly means the worker will try to use a capability the loader never granted → runtime failure.
 * inJsonOnly means the manifest.json advertises a cap the worker no longer uses → harmless but stale.
 */
export async function checkManifestDrift(
  pluginDir: string,
  manifestJsonCaps: string[],
  pluginId: string,
): Promise<DriftCheckResult> {
  const distManifestPath = join(pluginDir, "dist", "manifest.js");

  if (!existsSync(distManifestPath)) {
    return { pluginId, inSrcOnly: [], inJsonOnly: [], skipped: true };
  }

  const mod = await import(pathToFileURL(distManifestPath).href);
  const srcManifest = (mod.default ?? mod) as { capabilities?: string[] };
  const srcCaps: string[] = srcManifest?.capabilities ?? [];

  const jsonSet = new Set(manifestJsonCaps);
  const srcSet = new Set(srcCaps);

  return {
    pluginId,
    inSrcOnly: srcCaps.filter((c) => !jsonSet.has(c)),
    inJsonOnly: manifestJsonCaps.filter((c) => !srcSet.has(c)),
    skipped: false,
  };
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
pnpm --filter @armyofagents/aoa-marketplace-builder test manifest-drift
```

Expected: PASS (the `skipped=true` test passes immediately; the drift tests require `pnpm build` in aoa-plugin-slack first — if skipped, those two tests are effectively no-ops).

To run the full drift tests with a real build:
```bash
cd plugins/aoa-plugin-slack && pnpm build && cd ../..
pnpm --filter @armyofagents/aoa-marketplace-builder test manifest-drift
```

Expected: All 3 tests PASS.

- [ ] **Step 5: Wire drift check into the aoa-curated adapter**

In `catalog/src/sources/aoa-curated/adapter.ts`, add the import at the top:

```ts
import { checkManifestDrift } from "../../validators/manifest-drift.js";
```

Then inside the `normalize` method's plugin loop, after reading `manifest` and before assembling `item`, add:

```ts
// Manifest drift check — requires plugin to have been built (dist/manifest.js)
const drift = await checkManifestDrift(pkgDir, manifest.capabilities ?? [], manifest.id);
if (!drift.skipped && drift.inSrcOnly.length > 0) {
  ctx.logger.error(
    `Plugin ${slug}: capabilities in src/manifest.ts missing from manifest.json: ${drift.inSrcOnly.join(", ")}. Run pnpm build and update manifest.json.`,
  );
  continue;
}
if (!drift.skipped && drift.inJsonOnly.length > 0) {
  ctx.logger.warn(
    `Plugin ${slug}: stale capabilities in manifest.json (not in src): ${drift.inJsonOnly.join(", ")}`,
  );
}
```

- [ ] **Step 6: Verify aggregate still passes end-to-end**

```bash
# Build all plugins first
for plugin in plugins/*/; do (cd "$plugin" && pnpm build); done
# Then validate
pnpm validate
```

Expected: no drift errors for any plugin (M1 fixed Slack, M2 fixed versions, all plugins are aligned now).

- [ ] **Step 7: Commit**

```bash
git add catalog/src/validators/manifest-drift.ts \
        catalog/src/validators/__tests__/manifest-drift.test.ts \
        catalog/src/sources/aoa-curated/adapter.ts
git commit -m "feat(catalog): manifest drift validator — catches manifest.json/src capability mismatch at CI time"
```

---

### Task M5: GitHub Actions release CI

**Files:**
- Create: `.github/workflows/release-plugins.yml`

- [ ] **Step 1: Create the release workflow**

Create `.github/workflows/release-plugins.yml`:

```yaml
name: Release Plugins

on:
  push:
    tags:
      - 'v*'

jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write   # needed for gh release create/upload

    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 9

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'pnpm'

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build and pack all plugins
        run: |
          mkdir -p release-assets
          for plugin in plugins/*/; do
            name=$(basename "$plugin")
            echo "Building $name..."
            (cd "$plugin" && pnpm build)
            # npm pack outputs <name>-<version>.tgz to the specified destination
            npm pack "$plugin" --pack-destination release-assets/
          done

      - name: List packed tarballs
        run: ls -lh release-assets/

      - name: Create GitHub Release and upload tarballs
        uses: softprops/action-gh-release@v2
        with:
          files: release-assets/*.tgz
          generate_release_notes: true
```

- [ ] **Step 2: Verify the workflow file is valid YAML**

```bash
python -c "import yaml; yaml.safe_load(open('.github/workflows/release-plugins.yml'))"
```

Expected: no output (valid YAML).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release-plugins.yml
git commit -m "ci: add release-plugins workflow — build, pack, upload tarballs on v* tag"
```

---

### Task M6: Regenerate and publish catalog snapshot

> **Blocked by:** M1–M5 merged to main AND a `v1.0.0` tag pushed.

- [ ] **Step 1: Push tag to trigger the release CI**

```bash
git tag v1.0.0
git push origin v1.0.0
```

Wait for the GitHub Actions `Release Plugins` job to complete. Verify 4 `.tgz` files appear on the release page:
- `aoa-plugin-discord-1.0.0.tgz`
- `aoa-plugin-github-issues-1.0.0.tgz`
- `aoa-plugin-slack-1.0.0.tgz`
- `aoa-plugin-telegram-1.0.0.tgz`

- [ ] **Step 2: Build all plugins locally then regenerate catalog**

```bash
for plugin in plugins/*/; do (cd "$plugin" && pnpm build); done
pnpm aggregate
```

Expected output ends with: `Wrote .../dist/catalog.json`

- [ ] **Step 3: Inspect the output catalog**

```bash
node -e "
const c = JSON.parse(require('fs').readFileSync('dist/catalog.json','utf8'));
console.log('generatedAt:', c.generatedAt);
c.items.filter(i => i.type === 'plugin').forEach(p => {
  console.log(p.id, '| version:', p.version, '| tarballUrl:', p.npm?.tarballUrl ?? 'MISSING');
});
"
```

Expected: each plugin entry shows a `tarballUrl` like `https://github.com/MeteoriteLabs/aoa-marketplace/releases/download/v1.0.0/aoa-plugin-slack-1.0.0.tgz`.

- [ ] **Step 4: Merge to main — CDN publishes automatically**

The existing GitHub Pages CI (`M.1.G`) publishes `dist/catalog.json` on merge to main. After merge, verify:

```bash
curl -s https://meteoritelabs.github.io/aoa-marketplace-cdn/catalog.json | \
  node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log('generatedAt:', d.generatedAt); d.items.filter(i=>i.type==='plugin').forEach(p=>console.log(p.id, p.npm?.tarballUrl))"
```

Expected: `generatedAt` is today's date; all 4 plugins have non-null `tarballUrl`.

---

## TRACK A — AoA-2.5

---

### Task A1: Add tarballUrl to shared CatalogItem type

**Files:**
- Modify: `packages/shared/src/marketplace.ts`
- Modify: `ui/src/__tests__/__fixtures__/marketplace-catalog.ts`

- [ ] **Step 1: Extend MarketplaceCatalogItemSchema npm field**

In `packages/shared/src/marketplace.ts`, change the `npm` schema:

```ts
// Before:
npm: z
  .object({
    packageName: z.string(),
    version: z.string(),
  })
  .optional(),

// After:
npm: z
  .object({
    packageName: z.string(),
    version: z.string(),
    tarballUrl: z.string().url().optional(),
  })
  .optional(),
```

- [ ] **Step 2: Update the SLACK_PLUGIN fixture**

In `ui/src/__tests__/__fixtures__/marketplace-catalog.ts`, update `SLACK_PLUGIN.npm`:

```ts
npm: {
  packageName: "aoa-plugin-slack",
  version: "1.0.0",
  tarballUrl: "https://github.com/MeteoriteLabs/aoa-marketplace/releases/download/v1.0.0/aoa-plugin-slack-1.0.0.tgz",
},
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd path/to/AoA-2.5
pnpm --filter @armyofagents/shared build
pnpm --filter @armyofagents/ui tsc --noEmit
```

Expected: 0 type errors.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/marketplace.ts \
        ui/src/__tests__/__fixtures__/marketplace-catalog.ts
git commit -m "feat(shared): add tarballUrl field to CatalogItem.npm schema"
```

---

### Task A2: Update plugin-installer.ts to use tarballUrl

**Files:**
- Modify: `server/src/services/marketplace-install/plugin-installer.ts`

- [ ] **Step 1: Update the installPlugin call**

In `server/src/services/marketplace-install/plugin-installer.ts`, change the step 2 block (around line 70):

```ts
// Before:
const discovered = await pluginLoader.installPlugin({
  packageName: catalogItem.npm.packageName,
  version: catalogItem.npm.version,
});

// After:
// When a tarballUrl is present, pass it as the packageName with no version.
// plugin-loader builds the npm spec as: version ? `${packageName}@${version}` : packageName
// So tarballUrl with no version → `npm install <tarball-url>` (standard npm behaviour).
const installOpts = catalogItem.npm.tarballUrl
  ? { packageName: catalogItem.npm.tarballUrl }
  : { packageName: catalogItem.npm.packageName, version: catalogItem.npm.version };

const discovered = await pluginLoader.installPlugin(installOpts);
```

- [ ] **Step 2: Write failing unit test for the tarball path**

Create `server/src/__tests__/marketplace-install-plugin-tarball.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";

vi.mock("@armyofagents/db", () => {
  const tableProxy = new Proxy({}, { get: () => Symbol("col") });
  return { plugins: tableProxy };
});
vi.mock("drizzle-orm", () => ({
  eq: () => Symbol("op:eq"),
}));

import { installMarketplacePlugin } from "../services/marketplace-install/plugin-installer.js";
import type { CatalogItem } from "@armyofagents/shared";

const TARBALL_URL =
  "https://github.com/MeteoriteLabs/aoa-marketplace/releases/download/v1.0.0/aoa-plugin-slack-1.0.0.tgz";

const SLACK_PLUGIN_WITH_TARBALL: CatalogItem = {
  id: "plugin:aoa-curated/aoa-plugin-slack",
  type: "plugin",
  name: "Slack",
  description: "Slack integration",
  version: "1.0.0",
  source: {
    adapter: "aoa-curated",
    url: "https://github.com/MeteoriteLabs/aoa-marketplace",
    locator: "plugins/aoa-plugin-slack",
    commitSha: "abc123",
  },
  npm: {
    packageName: "aoa-plugin-slack",
    version: "1.0.0",
    tarballUrl: TARBALL_URL,
  },
  trust: { tier: "verified", source: "aoa-curated" },
  status: "active",
  addedAt: "2026-05-06T00:00:00Z",
  category: "integrations",
  tags: [],
};

const SLACK_PLUGIN_NO_TARBALL: CatalogItem = {
  ...SLACK_PLUGIN_WITH_TARBALL,
  npm: { packageName: "aoa-plugin-slack", version: "1.0.0" },
};

describe("installMarketplacePlugin — tarball routing", () => {
  const makeLoader = (capturedSpec: { packageName?: string; version?: string }[]) => ({
    installPlugin: vi.fn(async (opts: { packageName?: string; version?: string }) => {
      capturedSpec.push(opts);
      return {
        packagePath: "/plugins/aoa-plugin-slack",
        packageName: "aoa-plugin-slack",
        version: "1.0.0",
        source: "npm",
        manifest: { id: "aoa.plugin-slack" },
      };
    }),
    registry: {
      getByKey: vi.fn(async () => ({ id: "plugin-uuid", pluginKey: "aoa.plugin-slack" })),
    },
    lifecycle: {
      load: vi.fn(async () => {}),
    },
  });

  const mockDb = {
    select: () => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
    }),
  };

  it("passes tarball URL as packageName (no version) when tarballUrl is present", async () => {
    const captured: { packageName?: string; version?: string }[] = [];
    const loader = makeLoader(captured);

    await installMarketplacePlugin({
      catalogItem: SLACK_PLUGIN_WITH_TARBALL,
      companyId: "c-1",
      db: mockDb as any,
      pluginLoader: loader,
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].packageName).toBe(TARBALL_URL);
    expect(captured[0].version).toBeUndefined();
  });

  it("passes packageName + version when tarballUrl is absent", async () => {
    const captured: { packageName?: string; version?: string }[] = [];
    const loader = makeLoader(captured);

    await installMarketplacePlugin({
      catalogItem: SLACK_PLUGIN_NO_TARBALL,
      companyId: "c-1",
      db: mockDb as any,
      pluginLoader: loader,
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].packageName).toBe("aoa-plugin-slack");
    expect(captured[0].version).toBe("1.0.0");
  });
});
```

- [ ] **Step 3: Run test to confirm it fails**

```bash
pnpm --filter @armyofagents/server test marketplace-install-plugin-tarball
```

Expected: FAIL — `captured[0].packageName` is `"aoa-plugin-slack"`, not the tarball URL.

- [ ] **Step 4: Implement the change in plugin-installer.ts** (the code in Step 1 above)

- [ ] **Step 5: Run test to confirm it passes**

```bash
pnpm --filter @armyofagents/server test marketplace-install-plugin-tarball
```

Expected: Both tests PASS.

- [ ] **Step 6: Verify TypeScript compiles**

```bash
pnpm --filter @armyofagents/server tsc --noEmit
```

Expected: 0 type errors.

- [ ] **Step 8: Smoke-test the install route**

With the dev server running:

```bash
# Confirm existing installed plugins are unaffected (no-tarball path regression check)
curl -s http://localhost:3100/api/plugins | \
  node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(d.map(p=>p.packageName+' '+p.status))"
```

Expected: existing plugins still show `status: ready`. No regression.

- [ ] **Step 9: Commit**

```bash
git add server/src/services/marketplace-install/plugin-installer.ts \
        server/src/__tests__/marketplace-install-plugin-tarball.test.ts
git commit -m "feat(marketplace): use tarballUrl as npm install spec when catalog item provides one"
```

---

### Task A3: CatalogCard installed-state rendering

**Files:**
- Modify: `ui/src/components/marketplace/CatalogCard.tsx`
- Modify: `ui/src/components/marketplace/__tests__/CatalogCard.test.tsx`
- Modify: `ui/src/pages/Marketplace.tsx`
- Modify: `ui/src/pages/MarketplaceSearch.tsx`
- Modify: `ui/src/pages/MarketplaceType.tsx`

- [ ] **Step 1: Write failing tests for installed/pending states**

Add to `ui/src/components/marketplace/__tests__/CatalogCard.test.tsx`:

```ts
import type { PluginRecord } from "@armyofagents/shared";

const INSTALLED_READY: PluginRecord = {
  id: "plugin-uuid",
  pluginKey: "aoa.plugin-slack",
  packageName: "aoa-plugin-slack",
  version: "1.0.0",
  apiVersion: 1,
  categories: ["integrations"],
  manifestJson: {} as any,
  status: "ready",
  installOrder: 1,
  localPath: null,
  settingsJson: null,
  enabledForCompanies: null,
  lastError: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const INSTALLED_LOADING: PluginRecord = { ...INSTALLED_READY, status: "loading" };

it("shows green Installed badge when plugin is ready", () => {
  const map = new Map([["aoa-plugin-slack", INSTALLED_READY]]);
  renderWithRouter(<CatalogCard item={SLACK_PLUGIN} installedByPackageName={map} />);
  expect(screen.getByText("Installed")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /install/i })).not.toBeInTheDocument();
});

it("shows Pending badge when plugin is installed but not ready", () => {
  const map = new Map([["aoa-plugin-slack", INSTALLED_LOADING]]);
  renderWithRouter(<CatalogCard item={SLACK_PLUGIN} installedByPackageName={map} />);
  expect(screen.getByText("Pending")).toBeInTheDocument();
});

it("shows Install button when plugin is not installed", () => {
  renderWithRouter(<CatalogCard item={SLACK_PLUGIN} installedByPackageName={new Map()} />);
  expect(screen.getByRole("button", { name: /install/i })).toBeInTheDocument();
});

it("shows Install button when installedByPackageName prop is omitted", () => {
  renderWithRouter(<CatalogCard item={SLACK_PLUGIN} />);
  expect(screen.getByRole("button", { name: /install/i })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pnpm --filter @armyofagents/ui test CatalogCard
```

Expected: FAIL — `installedByPackageName` prop does not exist yet.

- [ ] **Step 3: Update CatalogCard.tsx**

Replace the full file content of `ui/src/components/marketplace/CatalogCard.tsx`:

```tsx
import { useState } from "react";
import { Link } from "react-router-dom";
import type { CatalogItem, PluginRecord } from "@armyofagents/shared";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TrustBadge } from "./TrustBadge";
import { TYPE_ICONS, TYPE_LABELS } from "@/lib/marketplace-constants";
import { PluginInstallModal } from "@/components/marketplace/install/PluginInstallModal";
import { SnapshotInstallModal } from "@/components/marketplace/install/SnapshotInstallModal";

export interface CatalogCardProps {
  item: CatalogItem;
  installedByPackageName?: Map<string, PluginRecord>;
}

export function detailUrl(item: CatalogItem): string {
  const colonIdx = item.id.indexOf(":");
  const slug = item.id.slice(colonIdx + 1);
  return `/marketplace/${item.type}/${slug}`;
}

export function CatalogCard({ item, installedByPackageName }: CatalogCardProps) {
  const Icon = TYPE_ICONS[item.type];
  const typeLabel = TYPE_LABELS[item.type];
  const [installOpen, setInstallOpen] = useState(false);

  const installedPlugin = item.npm?.packageName
    ? installedByPackageName?.get(item.npm.packageName)
    : undefined;

  return (
    <div>
      <Link
        to={detailUrl(item)}
        className="block hover:no-underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-xl"
      >
        <Card className="h-full transition-colors hover:bg-accent/50 rounded-xl border-border/60">
          <CardHeader className="pb-2">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">{typeLabel}</span>
              </div>
              <TrustBadge tier={item.trust.tier} showLabel={false} className="shrink-0" />
            </div>
            <h3 className="text-base font-semibold mt-2 line-clamp-1">{item.name}</h3>
          </CardHeader>
          <CardContent className="pt-0">
            <p className="text-sm text-muted-foreground line-clamp-2 mb-3">
              {item.description}
            </p>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0 overflow-hidden">
                <Badge variant="outline" className="text-xs shrink-0">
                  v{item.version}
                </Badge>
                {item.tags.slice(0, 1).map((tag) => (
                  <Badge key={tag} variant="secondary" className="text-xs shrink-0">
                    {tag}
                  </Badge>
                ))}
              </div>
              {installedPlugin ? (
                installedPlugin.status === "ready" ? (
                  <Badge className="text-xs h-7 px-2.5 shrink-0 bg-green-600 hover:bg-green-600 cursor-default">
                    Installed
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="text-xs h-7 px-2.5 shrink-0 cursor-default">
                    Pending
                  </Badge>
                )
              ) : (
                <Button
                  size="sm"
                  className="text-xs h-7 px-2.5 shrink-0"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setInstallOpen(true);
                  }}
                >
                  Install
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      </Link>

      {installOpen && item.type === "plugin" && (
        <PluginInstallModal
          item={item}
          open={installOpen}
          onOpenChange={setInstallOpen}
        />
      )}
      {installOpen && item.type !== "plugin" && (
        <SnapshotInstallModal
          item={item}
          open={installOpen}
          onOpenChange={setInstallOpen}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
pnpm --filter @armyofagents/ui test CatalogCard
```

Expected: All tests PASS (existing 3 + new 4 = 7 total).

- [ ] **Step 5: Pass installedByPackageName from Marketplace.tsx**

In `ui/src/pages/Marketplace.tsx`, add imports and query after `useCatalog`:

```tsx
// Add at top with other imports:
import { useQuery } from "@tanstack/react-query";
import { pluginsApi } from "@/api/plugins";
import { queryKeys } from "@/lib/queryKeys";
import type { PluginRecord } from "@armyofagents/shared";
```

Add after `const { data: catalog, isLoading, error } = useCatalog();`:

```tsx
const { data: installedPlugins } = useQuery({
  queryKey: queryKeys.plugins.all,
  queryFn: () => pluginsApi.list(),
});

const installedByPackageName = useMemo(
  () => new Map((installedPlugins ?? []).map((p: PluginRecord) => [p.packageName, p])),
  [installedPlugins],
);
```

Then update the CatalogCard render at line 316:

```tsx
// Before:
<CatalogCard key={item.id} item={item} />

// After:
<CatalogCard key={item.id} item={item} installedByPackageName={installedByPackageName} />
```

- [ ] **Step 6: Pass installedByPackageName from MarketplaceSearch.tsx**

Open `ui/src/pages/MarketplaceSearch.tsx`. Add the same query and memo after the existing data fetch hooks:

```tsx
import { useQuery } from "@tanstack/react-query";
import { pluginsApi } from "@/api/plugins";
import { queryKeys } from "@/lib/queryKeys";
import type { PluginRecord } from "@armyofagents/shared";
```

Add after the existing hooks (before any early returns):

```tsx
const { data: installedPlugins } = useQuery({
  queryKey: queryKeys.plugins.all,
  queryFn: () => pluginsApi.list(),
});

const installedByPackageName = useMemo(
  () => new Map((installedPlugins ?? []).map((p: PluginRecord) => [p.packageName, p])),
  [installedPlugins],
);
```

Update the CatalogCard render (line ~102):

```tsx
<CatalogCard key={item.id} item={item} installedByPackageName={installedByPackageName} />
```

- [ ] **Step 7: Pass installedByPackageName from MarketplaceType.tsx**

In `ui/src/pages/MarketplaceType.tsx`, add imports at the top:

```tsx
import { useQuery } from "@tanstack/react-query";
import { pluginsApi } from "@/api/plugins";
import { queryKeys } from "@/lib/queryKeys";
import type { PluginRecord } from "@armyofagents/shared";
```

Add after the existing data-fetching hooks (before any early returns), and before the `return` statement:

```tsx
const { data: installedPlugins } = useQuery({
  queryKey: queryKeys.plugins.all,
  queryFn: () => pluginsApi.list(),
});

const installedByPackageName = useMemo(
  () => new Map((installedPlugins ?? []).map((p: PluginRecord) => [p.packageName, p])),
  [installedPlugins],
);
```

If `useMemo` is not yet imported in this file, add it to the React import line.

Update the CatalogCard render (around line 135):

```tsx
<CatalogCard key={item.id} item={item} installedByPackageName={installedByPackageName} />
```

- [ ] **Step 8: Verify TypeScript compiles**

```bash
pnpm --filter @armyofagents/ui tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 9: Manual smoke-test**

Start the dev server (`pnpm dev` with `AOA_MIGRATION_AUTO_APPLY=true`). Navigate to `/marketplace`. If `aoa-plugin-github-issues` is installed, its card should show a green "Installed" badge. No console errors.

- [ ] **Step 10: Commit**

```bash
git add ui/src/components/marketplace/CatalogCard.tsx \
        ui/src/components/marketplace/__tests__/CatalogCard.test.tsx \
        ui/src/pages/Marketplace.tsx \
        ui/src/pages/MarketplaceSearch.tsx \
        ui/src/pages/MarketplaceType.tsx
git commit -m "feat(marketplace): show Installed/Pending state on catalog cards"
```

---

### Task A4: Operation polling staleness guard

**Files:**
- Modify: `ui/src/hooks/useOperationStatus.ts`
- Modify: `ui/src/components/marketplace/install/PluginInstallModal.tsx`

- [ ] **Step 1: Write failing test**

Create `ui/src/hooks/__tests__/useOperationStatus.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { useOperationStatus } from "../useOperationStatus";
import * as marketplaceApi from "@/api/marketplace";

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
}

describe("useOperationStatus — startedAfter guard", () => {
  it("returns stale_operation error when op createdAt is before startedAfter", async () => {
    const staleOp = {
      id: "op-1",
      companyId: "c-1",
      status: "failure" as const,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      itemId: "plugin:aoa-curated/aoa-plugin-slack",
      itemType: "plugin" as const,
      errorMessage: null,
    };
    vi.spyOn(marketplaceApi.marketplaceApi, "getOperation").mockResolvedValue(staleOp);

    const startedAfter = new Date("2026-05-01T00:00:00Z"); // after staleOp.createdAt

    const { result } = renderHook(
      () =>
        useOperationStatus({
          companyId: "c-1",
          operationId: "op-1",
          startedAfter,
        }),
      { wrapper: makeWrapper() },
    );

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.status).toBe("failure");
    expect(result.current.data?.errorMessage).toBe("stale_operation");
  });

  it("returns real status when op createdAt is after startedAfter", async () => {
    const freshOp = {
      id: "op-2",
      companyId: "c-1",
      status: "success" as const,
      createdAt: "2026-05-06T10:00:00Z",
      updatedAt: "2026-05-06T10:00:01Z",
      itemId: "plugin:aoa-curated/aoa-plugin-slack",
      itemType: "plugin" as const,
      errorMessage: null,
    };
    vi.spyOn(marketplaceApi.marketplaceApi, "getOperation").mockResolvedValue(freshOp);

    const startedAfter = new Date("2026-05-06T09:00:00Z"); // before freshOp.createdAt

    const { result } = renderHook(
      () =>
        useOperationStatus({
          companyId: "c-1",
          operationId: "op-2",
          startedAfter,
        }),
      { wrapper: makeWrapper() },
    );

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.status).toBe("success");
    expect(result.current.data?.errorMessage).toBeNull();
  });
});
```

- [ ] **Step 2: Run to confirm tests fail**

```bash
pnpm --filter @armyofagents/ui test useOperationStatus
```

Expected: FAIL — `startedAfter` option does not exist yet.

- [ ] **Step 3: Update useOperationStatus.ts**

Replace `ui/src/hooks/useOperationStatus.ts` entirely:

```ts
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { marketplaceApi, type InstallOperation } from "@/api/marketplace";

const POLL_INTERVAL_MS = 2000;

export interface UseOperationStatusOpts {
  companyId: string | null;
  operationId: string | null;
  /** If set, any operation whose createdAt is before this date is treated as stale
   *  and returned as a synthetic failure with errorMessage="stale_operation".
   *  Use this to prevent a modal reopen from re-attaching to a previous failed op. */
  startedAfter?: Date;
}

export function useOperationStatus(
  opts: UseOperationStatusOpts,
): UseQueryResult<InstallOperation, Error> {
  const { companyId, operationId, startedAfter } = opts;
  return useQuery({
    queryKey: ["marketplace", "operation", companyId, operationId] as const,
    queryFn: async () => {
      const data = await marketplaceApi.getOperation(companyId!, operationId!);
      if (startedAfter && new Date(data.createdAt) < startedAfter) {
        return { ...data, status: "failure" as const, errorMessage: "stale_operation" };
      }
      return data;
    },
    enabled: !!companyId && !!operationId,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return POLL_INTERVAL_MS;
      if (data.status === "success" || data.status === "failure" || data.status === "requested") {
        return false;
      }
      return POLL_INTERVAL_MS;
    },
  });
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
pnpm --filter @armyofagents/ui test useOperationStatus
```

Expected: Both tests PASS.

- [ ] **Step 5: Update PluginInstallModal.tsx to pass startedAfter**

In `ui/src/components/marketplace/install/PluginInstallModal.tsx`, add a `useRef` and `useEffect` to capture the modal's open time. Add the following (the existing `useEffect` and `useState` imports are already there):

```tsx
// Add useRef to existing import:
import { useEffect, useRef, useState } from "react";
```

After the existing `const [pendingToastId, ...]` declaration, add:

```tsx
// Capture the timestamp when this modal instance opened.
// Passed to useOperationStatus so any pre-existing op for the same item
// is ignored (stale_operation) rather than shown as a loading state.
const openedAt = useRef<Date>(new Date());
useEffect(() => {
  if (open) openedAt.current = new Date();
}, [open]);
```

Then update the `useOperationStatus` call:

```tsx
// Before:
const { data: opStatus } = useOperationStatus({
  companyId: installCompanyId,
  operationId: pendingOpId,
});

// After:
const { data: opStatus } = useOperationStatus({
  companyId: installCompanyId,
  operationId: pendingOpId,
  startedAfter: openedAt.current,
});
```

- [ ] **Step 6: Verify TypeScript compiles**

```bash
pnpm --filter @armyofagents/ui tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 7: Manual verification**

1. Start the dev server.
2. Trigger an install that will fail (e.g., a plugin with no tarball available yet).
3. Close the modal.
4. Reopen the install modal for the same plugin.
5. Expected: modal shows a fresh "Install" button, NOT a loading spinner.

- [ ] **Step 8: Commit**

```bash
git add ui/src/hooks/useOperationStatus.ts \
        ui/src/hooks/__tests__/useOperationStatus.test.ts \
        ui/src/components/marketplace/install/PluginInstallModal.tsx
git commit -m "fix(marketplace): guard install modal against re-attaching to stale operations"
```

---

### Task A5: UI slot coverage audit

> **Interactive — requires TK at the screen with the dev server running and `aoa-kitchen-sink-example` installed.**

**Files:**
- Create: `docs/aoa/reference/plugin-slot-coverage.md`

- [ ] **Step 1: Prepare**

Confirm kitchen-sink plugin is installed and ready:

```bash
curl -s http://localhost:3100/api/plugins | \
  node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); d.filter(p=>p.packageName.includes('kitchen-sink')).forEach(p=>console.log(p.packageName, p.status))"
```

Expected: `aoa-kitchen-sink-example ready`

- [ ] **Step 2: Walk each slot type in the UI**

Check each slot in the browser and record whether it renders:

| Slot type | Where to look |
|---|---|
| `sidebar` | Left sidebar — look for an injected nav item below the standard items |
| `dashboardWidget` | Home page — look for an extra card/widget in the main grid |
| `settingsPage` | Settings → Plugin-injected tab or section |
| `projectSidebarItem` | Click into a Department → check the sidebar |
| `detailTab` | Open any Task → check the tab row in the slideover |
| `taskDetailView` | Open any Task → check the main body of the slideover |
| `toolbarButton` | Top toolbar — look for an extra button |
| `contextMenuItem` | Right-click a task card |
| `commentAnnotation` | Open a task with comments — check comment rendering |
| `commentContextMenuItem` | Right-click on a comment |
| `sidebarPanel` | Right-side collapsible panel |
| `page` | Navigate to a URL like `/<company>/plugins/kitchen-sink` |

- [ ] **Step 3: Create the coverage doc**

Create `docs/aoa/reference/plugin-slot-coverage.md` with a filled-in version of:

```markdown
# Plugin UI Slot Coverage

Audited: 2026-05-06  
Plugin: `aoa-kitchen-sink-example` (installed, status: ready)

| Slot type | Renders | Notes |
|---|---|---|
| `sidebar` | ✓/✗ | |
| `dashboardWidget` | ✓/✗ | |
| `settingsPage` | ✓/✗ | |
| `projectSidebarItem` | ✓/✗ | |
| `detailTab` | ✓/✗ | |
| `taskDetailView` | ✓/✗ | |
| `toolbarButton` | ✓/✗ | |
| `contextMenuItem` | ✓/✗ | |
| `commentAnnotation` | ✓/✗ | |
| `commentContextMenuItem` | ✓/✗ | |
| `sidebarPanel` | ✓/✗ | |
| `page` | ✓/✗ | |

## Unrendered slots — filed issues
<!-- List GitHub issue links here -->
```

- [ ] **Step 4: File a GitHub issue for each unrendered slot**

For each slot that does not render, file an issue in the AoA-2.5 repo with:
- Title: `feat(plugin-host): render <slot-type> UI slot`
- Body: steps to reproduce (install kitchen-sink → navigate to X → expected slot not visible)

- [ ] **Step 5: Commit the coverage doc**

```bash
git add docs/aoa/reference/plugin-slot-coverage.md
git commit -m "docs(plugins): add UI slot coverage audit for kitchen-sink plugin"
```

---

### Task A6: GitHub plugin E2E config

> **Blocked by:** M6 complete (catalog has tarballUrl, install from catalog works). Can run against the existing local-path-installed plugin for config + invoke validation.

**Prerequisites:** You need a GitHub PAT with `repo` scope (read issues) for a test repo.

- [ ] **Step 1: Get the plugin ID**

```bash
curl -s http://localhost:3100/api/plugins | \
  node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); d.filter(p=>p.pluginKey==='aoa-plugin-github-issues').forEach(p=>console.log('pluginId:', p.id, 'status:', p.status))"
```

Copy the `pluginId`.

- [ ] **Step 2: Get a company ID**

```bash
curl -s http://localhost:3100/api/companies | \
  node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); d.forEach(c=>console.log(c.id, c.name))"
```

Copy the company ID (use the Army of Agents company `b25c371b-a376-4271-9ffb-0a71ac8c5cd5`).

- [ ] **Step 3: Create a secret for the PAT**

```bash
curl -s -X POST http://localhost:3100/api/companies/b25c371b-a376-4271-9ffb-0a71ac8c5cd5/secrets \
  -H "Content-Type: application/json" \
  -d '{"name":"github_pat","value":"<YOUR_PAT_HERE>"}' | \
  node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log('secretId:', d.id)"
```

Copy the `secretId`.

- [ ] **Step 4: Configure the plugin instance**

```bash
curl -s -X PATCH http://localhost:3100/api/plugins/<pluginId>/config \
  -H "Content-Type: application/json" \
  -d '{"githubTokenRef":"<secretId>","defaultRepo":"<owner/repo>"}' | \
  node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(JSON.stringify(d,null,2))"
```

Expected: response includes the updated config.

- [ ] **Step 5: Invoke the search tool via MCP**

```bash
curl -s -X POST http://localhost:3100/api/companies/b25c371b-a376-4271-9ffb-0a71ac8c5cd5/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "github_issues__search",
      "arguments": { "query": "bug", "limit": 3 }
    }
  }' | \
  node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(JSON.stringify(d.result ?? d.error, null, 2))"
```

Expected: `result` contains an array of GitHub issues, NOT an error object.

- [ ] **Step 6: Note result**

If the search returns results → full E2E arc is validated. Document the result (issue count, repo name) in a comment or in the PR description.

---

### Task A7: Visual E2E — full marketplace install flow with screenshots

**Files:**
- Create: `tests/e2e/marketplace-install-flow.spec.ts`

This spec extends the existing `marketplace.spec.ts` coverage with visual proof of the Install button → modal → capabilities → dismiss cycle, plus the Installed badge after a real local-path install.

- [ ] **Step 1: Write the spec**

Create `tests/e2e/marketplace-install-flow.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { seedCompany, cleanupTestCompanies } from "./helpers/seed-company";

/**
 * Visual E2E: Marketplace install flow
 *
 * Covers:
 *   - Install button visible on catalog cards that are not yet installed
 *   - Clicking Install opens modal with plugin name + capabilities list
 *   - Modal dismisses cleanly (Install button reappears)
 *   - After a local-path install, the card shows "Installed" badge (not Install button)
 *
 * Screenshots saved to test-results/marketplace-install-flow/ for visual diffing.
 */

test.describe("Marketplace install flow", () => {
  test.afterEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-INSTALL-/);
  });

  test("catalog cards for uninstalled plugins show Install button", async ({ page }) => {
    await page.goto("/marketplace");

    // Wait for catalog to load
    await expect(
      page.getByRole("heading", { level: 1, name: /extend your workforce/i }),
    ).toBeVisible({ timeout: 15_000 });

    // At least one Install button should be visible in the grid
    const installButtons = page.getByRole("button", { name: /^install$/i });
    await expect(installButtons.first()).toBeVisible();

    // Screenshot: marketplace home with Install buttons visible
    await page.screenshot({
      path: "test-results/marketplace-install-flow/01-marketplace-home.png",
      fullPage: false,
    });
  });

  test("clicking Install opens modal with plugin name and capabilities", async ({
    page,
  }) => {
    await page.goto("/marketplace");

    await expect(
      page.getByRole("heading", { level: 1, name: /extend your workforce/i }),
    ).toBeVisible({ timeout: 15_000 });

    // Click the first Install button on a plugin card
    const firstInstallBtn = page.getByRole("button", { name: /^install$/i }).first();
    await firstInstallBtn.click();

    // Modal should open — it's a Dialog, so look for the dialog role
    const modal = page.getByRole("dialog");
    await expect(modal).toBeVisible({ timeout: 5_000 });

    // Modal must display the plugin name in a heading
    const modalHeading = modal.getByRole("heading");
    await expect(modalHeading).toBeVisible();

    // Screenshot: install modal open
    await page.screenshot({
      path: "test-results/marketplace-install-flow/02-install-modal-open.png",
      fullPage: false,
    });
  });

  test("install modal lists plugin capabilities", async ({ page }) => {
    await page.goto("/marketplace/plugin");

    await expect(
      page.getByRole("heading", { name: "Plugins", level: 1 }),
    ).toBeVisible({ timeout: 15_000 });

    // Open install modal for the first visible plugin card
    await page.getByRole("button", { name: /^install$/i }).first().click();

    const modal = page.getByRole("dialog");
    await expect(modal).toBeVisible({ timeout: 5_000 });

    // The modal renders a capabilities section — at minimum one list item or text
    // The PluginInstallModal renders capabilities as a list of badge-like items
    const capabilitiesSection = modal.getByText(/capabilities/i);
    await expect(capabilitiesSection).toBeVisible();

    // Screenshot: modal showing capabilities
    await page.screenshot({
      path: "test-results/marketplace-install-flow/03-modal-capabilities.png",
      fullPage: false,
    });
  });

  test("closing install modal restores Install button", async ({ page }) => {
    await page.goto("/marketplace");

    await expect(
      page.getByRole("heading", { level: 1, name: /extend your workforce/i }),
    ).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: /^install$/i }).first().click();

    const modal = page.getByRole("dialog");
    await expect(modal).toBeVisible({ timeout: 5_000 });

    // Close via Escape
    await page.keyboard.press("Escape");
    await expect(modal).not.toBeVisible({ timeout: 3_000 });

    // Install button should still be in the DOM (card restored)
    await expect(page.getByRole("button", { name: /^install$/i }).first()).toBeVisible();
  });

  test("card shows green Installed badge after local-path install", async ({
    page,
    request,
  }) => {
    // Step 1: Get available plugin examples to find a local path
    const examplesRes = await request.get("/api/plugins/examples");
    expect(examplesRes.ok()).toBe(true);
    const examples = (await examplesRes.json()) as Array<{
      packageName: string;
      localPath: string;
      displayName: string;
    }>;
    expect(examples.length).toBeGreaterThan(0);

    // Pick the first example — kitchen-sink or whichever is first
    const example = examples[0]!;

    // Step 2: Install it via local path
    const installRes = await request.post("/api/plugins/install", {
      data: { packageName: example.localPath, isLocalPath: true },
      failOnStatusCode: false,
    });
    // If already installed, that's fine (409 or 200)
    expect(installRes.status()).toBeLessThan(500);

    // Step 3: Wait for plugin to reach ready state (poll up to 15s)
    let ready = false;
    for (let i = 0; i < 15; i++) {
      const listRes = await request.get("/api/plugins");
      const list = (await listRes.json()) as Array<{ packageName: string; status: string }>;
      if (list.some((p) => p.packageName === example.packageName && p.status === "ready")) {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(ready).toBe(true);

    // Step 4: Navigate to marketplace — the installed example's card should show Installed badge.
    // NOTE: The example plugin (e.g. "aoa-kitchen-sink-example") must be in the catalog
    // snapshot for the badge to appear. If it's not in the catalog, this assertion is skipped.
    await page.goto("/marketplace");
    await expect(
      page.getByRole("heading", { level: 1, name: /extend your workforce/i }),
    ).toBeVisible({ timeout: 15_000 });

    // Check if the example plugin's name appears in the catalog
    const exampleCard = page.getByRole("heading", {
      name: example.displayName,
      level: 3,
    });

    const cardExists = await exampleCard.isVisible().catch(() => false);
    if (cardExists) {
      // The card IS in the catalog — verify it shows Installed badge
      const cardContainer = exampleCard.locator("..").locator("..");
      await expect(cardContainer.getByText("Installed")).toBeVisible({ timeout: 5_000 });

      // Screenshot: card showing green Installed badge
      await page.screenshot({
        path: "test-results/marketplace-install-flow/04-installed-badge.png",
        fullPage: false,
      });
    } else {
      // Example plugin is not in the catalog snapshot — skip badge assertion.
      // The badge logic is covered by unit tests (CatalogCard.test.tsx).
      test.info().annotations.push({
        type: "skip-reason",
        description: `${example.displayName} is not in the marketplace catalog snapshot — badge test skipped`,
      });
    }
  });

  test("full visual snapshot: marketplace page with plugin type filter active", async ({
    page,
  }) => {
    await page.goto("/marketplace");
    await expect(
      page.getByRole("heading", { level: 1, name: /extend your workforce/i }),
    ).toBeVisible({ timeout: 15_000 });

    // Activate the Plugins type pill
    await page.getByRole("button", { name: /Plugins\s+\d+\s+available/i }).click();

    // Wait for filter to apply
    await expect(
      page.getByRole("button", { name: /Plugins\s+\d+\s+available/i }),
    ).toHaveAttribute("data-active", "true");

    // Screenshot: marketplace filtered to Plugins
    await page.screenshot({
      path: "test-results/marketplace-install-flow/05-plugins-filter-active.png",
      fullPage: true,
    });

    // Verify no error state
    await expect(page.getByText("Could not load the marketplace")).not.toBeVisible();

    // Verify at least one plugin card is shown (Slack is always in the bundled snapshot)
    await expect(
      page.getByRole("heading", { name: "Slack", level: 3 }),
    ).toBeVisible();
  });
});
```

- [ ] **Step 2: Create the screenshot output directory**

```bash
mkdir -p tests/e2e/test-results/marketplace-install-flow
```

- [ ] **Step 3: Run the spec against the live dev server**

Ensure the dev server is running (`pnpm dev` with `AOA_MIGRATION_AUTO_APPLY=true`), then:

```bash
cd path/to/AoA-2.5
pnpm exec playwright test tests/e2e/marketplace-install-flow.spec.ts --headed
```

Expected: All 5 tests pass. Screenshots written to `test-results/marketplace-install-flow/`.

To run headless (CI mode):

```bash
pnpm exec playwright test tests/e2e/marketplace-install-flow.spec.ts
```

- [ ] **Step 4: Review screenshots**

Open the 5 screenshots and confirm:
- `01-marketplace-home.png` — grid of catalog cards each with an "Install" button
- `02-install-modal-open.png` — dialog open, plugin name visible in header
- `03-modal-capabilities.png` — capabilities section visible inside modal
- `05-plugins-filter-active.png` — Plugins pill active, Slack card visible (full page)

`04-installed-badge.png` only exists if the kitchen-sink plugin is in the catalog snapshot.

- [ ] **Step 5: Add test-results to .gitignore if not already present**

```bash
grep -q "test-results" .gitignore || echo "test-results/" >> .gitignore
```

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/marketplace-install-flow.spec.ts .gitignore
git commit -m "test(e2e): visual marketplace install flow spec with screenshots"
```

---

## Acceptance Criteria Checklist

- [ ] M1: `pnpm validate` passes for Slack; catalog item shows 20 capabilities
- [ ] M2: All 4 plugins have `PLUGIN_VERSION = "1.0.0"` in `constants.ts`
- [ ] M3: `catalog/src/types/catalog.ts` and `packages/shared/src/marketplace.ts` both have `tarballUrl?` in the npm schema; aggregator populates it; plugin-installer uses it
- [ ] M4: Introducing a cap in `src/manifest.ts` without updating `manifest.json` causes `pnpm validate` to reject that plugin
- [ ] M5: CI workflow exists at `.github/workflows/release-plugins.yml`; `v1.0.0` tag produces 4 `.tgz` assets on the GitHub release
- [ ] M6: CDN `catalog.json` `generatedAt` is today; all 4 plugin items have non-null `tarballUrl`
- [ ] A1: `tarballUrl` field in both Zod schemas; type-checks clean
- [ ] A2: `plugin-installer.ts` uses tarball URL when present
- [ ] A3: Installed plugin shows green "Installed" badge on catalog card; all 3 Marketplace pages pass the map; 7 CatalogCard tests pass
- [ ] A4: Reopening install modal after failure shows fresh Install button, not spinner; 2 useOperationStatus tests pass
- [ ] A5: `docs/aoa/reference/plugin-slot-coverage.md` created; issues filed for unrendered slots
- [ ] A6: `github_issues__search` returns results via MCP against a real repo
