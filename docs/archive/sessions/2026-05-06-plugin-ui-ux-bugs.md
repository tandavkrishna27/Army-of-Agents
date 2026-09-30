# Plugin UI/UX Bug Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 4 user-facing bugs in the plugin marketplace/settings UI discovered during end-to-end testing.

**Architecture:** All 4 bugs are independent, minimal changes — each task commits separately. No new files required; all changes are targeted edits to existing components and one API client file.

**Tech Stack:** React 18, TypeScript, TanStack Query v5, Vitest + React Testing Library, Tailwind CSS

---

## File Map

| File | Change |
|------|--------|
| `ui/src/pages/MarketplaceDetail.tsx` | Bug 1: remove conditional mount guard; Bug 2: fetch installed list + conditionally show badge |
| `ui/src/components/marketplace/CatalogCard.tsx` | Bug 1: remove conditional mount guard on `PluginInstallModal` |
| `ui/src/components/settings/PluginConfigForm.tsx` | Bug 3: add success toast on save |
| `ui/src/api/plugins.ts` | Bug 4: add `retryPlugin` named export |
| `ui/src/components/settings/PluginDetailSlideOver.tsx` | Bug 4: add "Retry activation" button for `error`-state plugins |
| `ui/src/__tests__/MarketplaceDetail.test.tsx` | Bug 2: add test for "Installed" badge when plugin is installed |
| `ui/src/components/marketplace/install/__tests__/PluginInstallModal.test.tsx` | Bug 1: add test verifying toast survives modal close |

---

## Task 1 — Fix: install spinner never auto-dismisses (component unmount)

**Context:** Both `MarketplaceDetail.tsx:286` and `CatalogCard.tsx:92` render `PluginInstallModal` inside a `{installModalOpen && ...}` guard. When `handleInstall` calls `onOpenChange(false)`, React unmounts the component, destroying `pendingOpId`/`pendingToastId` state. The polling query is cancelled and the toast stays in "Installing…" forever. The fix is to let the component stay mounted and rely on the `open` prop (passed to Radix Dialog) for show/hide only.

**Files:**
- Modify: `ui/src/pages/MarketplaceDetail.tsx:286-298`
- Modify: `ui/src/components/marketplace/CatalogCard.tsx:92-105`
- Modify: `ui/src/components/marketplace/install/__tests__/PluginInstallModal.test.tsx`

- [ ] **Step 1: Write the failing test**

Add to `ui/src/components/marketplace/install/__tests__/PluginInstallModal.test.tsx`:

```tsx
it("keeps polling and resolves toast after modal closes", async () => {
  // The modal unmounts when open=false — this test verifies the parent must NOT
  // gate mounting on open. (This test is written from outside the component to
  // document the contract; the real fix is in the parent callers.)
  // Simulate: install fires, op transitions to success while open=false
  vi.mocked(marketplaceApi.install).mockResolvedValueOnce({
    operationId: "op-success",
    status: "pending",
  });
  vi.mocked(marketplaceApi.getOperation).mockResolvedValueOnce({
    id: "op-success",
    status: "success",
    createdAt: new Date().toISOString(),
    errorMessage: null,
  });

  const onOpenChange = vi.fn();
  // Render with open=true, then flip to open=false after install click
  const { rerender } = wrap(
    <PluginInstallModal item={SLACK_PLUGIN} open onOpenChange={onOpenChange} />,
  );

  await userEvent.click(screen.getByRole("button", { name: "Install" }));
  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));

  // Simulate parent keeping component mounted but with open=false
  rerender(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <ToastProvider>
          <PluginInstallModal item={SLACK_PLUGIN} open={false} onOpenChange={onOpenChange} />
          <InstallToastSlot />
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );

  // Toast should eventually resolve to success (not stay as "Installing…")
  await waitFor(() =>
    expect(screen.getByText(/Installed Slack/)).toBeInTheDocument(),
    { timeout: 3000 },
  );
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```
cd "C:\Users\TK\OneDrive\Desktop\Claude Data\Paperclip-AoA\AoA-2.5"
pnpm --filter ui test -- --run src/components/marketplace/install/__tests__/PluginInstallModal.test.tsx
```

Expected: FAIL — toast shows "Installing Slack" and never updates to "Installed Slack".

- [ ] **Step 3: Fix `CatalogCard.tsx` — remove mount guard**

In `ui/src/components/marketplace/CatalogCard.tsx`, change lines 92–105:

```tsx
// Before
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

// After
{item.type === "plugin" && (
  <PluginInstallModal
    item={item}
    open={installOpen}
    onOpenChange={setInstallOpen}
  />
)}
{item.type !== "plugin" && (
  <SnapshotInstallModal
    item={item}
    open={installOpen}
    onOpenChange={setInstallOpen}
  />
)}
```

- [ ] **Step 4: Fix `MarketplaceDetail.tsx` — remove mount guard**

In `ui/src/pages/MarketplaceDetail.tsx`, change lines 286–298:

```tsx
// Before
{installModalOpen && item.type === "plugin" && (
  <PluginInstallModal
    item={item}
    open={installModalOpen}
    onOpenChange={setInstallModalOpen}
  />
)}
{installModalOpen && item.type !== "plugin" && (
  <SnapshotInstallModal
    item={item}
    open={installModalOpen}
    onOpenChange={setInstallModalOpen}
  />
)}

// After
{item.type === "plugin" && (
  <PluginInstallModal
    item={item}
    open={installModalOpen}
    onOpenChange={setInstallModalOpen}
  />
)}
{item.type !== "plugin" && (
  <SnapshotInstallModal
    item={item}
    open={installModalOpen}
    onOpenChange={setInstallModalOpen}
  />
)}
```

- [ ] **Step 5: Run the test — confirm it passes**

```
pnpm --filter ui test -- --run src/components/marketplace/install/__tests__/PluginInstallModal.test.tsx
```

Expected: All 4 tests PASS including the new one.

- [ ] **Step 6: Run the full UI test suite**

```
pnpm --filter ui test -- --run
```

Expected: All tests pass. No regressions.

- [ ] **Step 7: Commit**

```
git add ui/src/pages/MarketplaceDetail.tsx ui/src/components/marketplace/CatalogCard.tsx ui/src/components/marketplace/install/__tests__/PluginInstallModal.test.tsx
git commit -m "fix(plugin-ui): keep install modal mounted after close to preserve polling state"
```

---

## Task 2 — Fix: detail page always shows "Install" button regardless of install state

**Context:** `MarketplaceDetail.tsx` only calls `useCatalog()`. It never fetches the installed-plugins list, so the "Install" button appears even when a plugin is already installed. `CatalogCard.tsx` solves this correctly by mapping `installedByPackageName` from `pluginsApi.list()`. The detail page needs the same check.

**Files:**
- Modify: `ui/src/pages/MarketplaceDetail.tsx` (imports + query + install button JSX)
- Modify: `ui/src/__tests__/MarketplaceDetail.test.tsx`

- [ ] **Step 1: Write the failing test**

Add to `ui/src/__tests__/MarketplaceDetail.test.tsx`.

First, expand the existing mock to include `pluginsApi`:

```tsx
// Add at top of file alongside the existing marketplace mock
import * as pluginsApi from "@/api/plugins";

vi.mock("@/api/plugins", async () => {
  const actual = await vi.importActual<typeof import("@/api/plugins")>("@/api/plugins");
  return { ...actual, list: vi.fn() };
});
```

Then add the test:

```tsx
it("shows Installed badge instead of Install button when plugin is already installed", async () => {
  vi.mocked(marketplaceApi.getCatalog).mockResolvedValueOnce(FULL_CATALOG);
  // aoa-plugin-slack's packageName from the fixture
  vi.mocked(pluginsApi.list).mockResolvedValueOnce([
    {
      id: "plugin-1",
      packageName: "aoa-plugin-slack",
      pluginKey: "aoa.plugin-slack",
      version: "1.0.0",
      status: "ready",
      categories: [],
      manifestJson: {} as any,
      apiVersion: 1,
      companyId: "c1",
      installOrder: 1,
      packagePath: null,
      lastError: null,
      installedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ]);

  wrap("/marketplace/plugin/aoa-curated/aoa-plugin-slack");

  await waitFor(() =>
    expect(screen.getByRole("heading", { level: 1, name: "Slack" })).toBeInTheDocument(),
  );

  // Should NOT show Install button
  expect(screen.queryByRole("button", { name: /^install$/i })).not.toBeInTheDocument();
  // Should show Installed badge
  expect(screen.getByText(/installed/i)).toBeInTheDocument();
});

it("shows Install button when plugin is not installed", async () => {
  vi.mocked(marketplaceApi.getCatalog).mockResolvedValueOnce(FULL_CATALOG);
  vi.mocked(pluginsApi.list).mockResolvedValueOnce([]);

  wrap("/marketplace/plugin/aoa-curated/aoa-plugin-slack");

  await waitFor(() =>
    expect(screen.getByRole("heading", { level: 1, name: "Slack" })).toBeInTheDocument(),
  );

  expect(screen.getByRole("button", { name: /^install$/i })).toBeInTheDocument();
});
```

Also update the `wrap` function — it doesn't include `CompanyContext`, which the existing mock already handles, but need to make `pluginsApi.list` return `[]` by default in `beforeEach` to avoid affecting other tests:

In `beforeEach`:
```tsx
beforeEach(() => {
  vi.clearAllMocks();
  // Default: no plugins installed (won't affect non-plugin tests)
  vi.mocked(pluginsApi.list).mockResolvedValue([]);
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

```
pnpm --filter ui test -- --run src/__tests__/MarketplaceDetail.test.tsx
```

Expected: New tests FAIL — "Install" button always appears; "Installed" badge never appears.

- [ ] **Step 3: Add installed-plugins query to `MarketplaceDetail.tsx`**

In `ui/src/pages/MarketplaceDetail.tsx`, add the following:

1. Add imports at line 9 (after `useCatalog` import):

```tsx
import { useQuery } from "@tanstack/react-query";
import * as pluginsApi from "@/api/plugins";
import type { PluginRecord } from "@armyofagents/shared";
```

2. Inside `MarketplaceDetail()` function, after line 40 (`const { data: catalog, ... } = useCatalog();`), add:

```tsx
const { data: installedPlugins = [] } = useQuery<PluginRecord[]>({
  queryKey: ["plugins"],
  queryFn: () => pluginsApi.list(),
});

const installedByPackageName = useMemo(
  () => new Map(installedPlugins.map((p) => [p.packageName, p])),
  [installedPlugins],
);

const installedPlugin = item?.npm?.packageName
  ? installedByPackageName.get(item.npm.packageName)
  : undefined;
```

3. Replace the Install button at line 211:

```tsx
// Before
<Button className="w-full" onClick={() => setInstallModalOpen(true)}>
  Install
</Button>

// After
{installedPlugin?.status === "ready" ? (
  <div className="w-full flex items-center justify-center gap-2 bg-muted rounded-md px-4 py-2">
    <span className="text-sm font-semibold text-green-400">Installed</span>
    <span className="text-xs text-muted-foreground">v{installedPlugin.version}</span>
  </div>
) : installedPlugin ? (
  <div className="w-full flex items-center justify-center gap-2 bg-muted rounded-md px-4 py-2">
    <span className="text-sm font-semibold text-muted-foreground">Pending</span>
    <span className="text-xs text-muted-foreground">v{installedPlugin.version}</span>
  </div>
) : (
  <Button className="w-full" onClick={() => setInstallModalOpen(true)}>
    Install
  </Button>
)}
```

Note: The `useMemo` import is already in the file (line 1). Do not add a duplicate.

- [ ] **Step 4: Run the tests — confirm they pass**

```
pnpm --filter ui test -- --run src/__tests__/MarketplaceDetail.test.tsx
```

Expected: All 6 tests PASS.

- [ ] **Step 5: Run the full UI test suite**

```
pnpm --filter ui test -- --run
```

Expected: All tests pass.

- [ ] **Step 6: Commit**

```
git add ui/src/pages/MarketplaceDetail.tsx ui/src/__tests__/MarketplaceDetail.test.tsx
git commit -m "fix(plugin-ui): show Installed badge on detail page when plugin is already installed"
```

---

## Task 3 — Fix: no success feedback when saving plugin settings

**Context:** `PluginConfigForm.tsx` mutation `onSuccess` only calls `queryClient.invalidateQueries` and `onSaved?.()`. There is no visual confirmation. The project uses `pushToast({ title, tone })` from `useToast()` in `../../context/ToastContext.js`. The form already shows an error state inline (`mutation.isError`) — we add the success confirmation as a toast, consistent with the rest of the app.

**Files:**
- Modify: `ui/src/components/settings/PluginConfigForm.tsx`

No test file exists for this component. We will write one.

- [ ] **Step 1: Write the failing test**

Create `ui/src/components/settings/__tests__/PluginConfigForm.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { PluginConfigForm } from "../PluginConfigForm";
import * as pluginsApi from "@/api/plugins";

vi.mock("@/api/plugins", async () => {
  const actual = await vi.importActual<typeof import("@/api/plugins")>("@/api/plugins");
  return { ...actual, savePluginConfig: vi.fn() };
});

// Minimal ToastContext stub — real one requires full app tree
const toastPush = vi.fn();
vi.mock("../../context/ToastContext", () => ({
  useToast: () => ({ pushToast: toastPush }),
}));

const SCHEMA = {
  properties: {
    apiKey: { type: "string", title: "API Key" },
  },
  required: [],
};

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

describe("PluginConfigForm", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("shows success toast after save", async () => {
    vi.mocked(pluginsApi.savePluginConfig).mockResolvedValueOnce({ configJson: {} });

    wrap(
      <PluginConfigForm
        companyId="c1"
        pluginId="p1"
        schema={SCHEMA}
        initialValues={{ apiKey: "test" }}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /save settings/i }));

    await waitFor(() =>
      expect(toastPush).toHaveBeenCalledWith(
        expect.objectContaining({ tone: "success" }),
      ),
    );
  });

  it("does NOT show success toast when save fails", async () => {
    vi.mocked(pluginsApi.savePluginConfig).mockRejectedValueOnce(new Error("500"));

    wrap(
      <PluginConfigForm
        companyId="c1"
        pluginId="p1"
        schema={SCHEMA}
        initialValues={{ apiKey: "test" }}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /save settings/i }));

    await waitFor(() =>
      expect(screen.getByText(/save failed/i)).toBeInTheDocument(),
    );
    expect(toastPush).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```
pnpm --filter ui test -- --run src/components/settings/__tests__/PluginConfigForm.test.tsx
```

Expected: FAIL — `toastPush` is never called.

- [ ] **Step 3: Add success toast to `PluginConfigForm.tsx`**

In `ui/src/components/settings/PluginConfigForm.tsx`:

1. Add import after line 7 (`import { useMutation, useQueryClient } ...`):

```tsx
import { useToast } from "../../context/ToastContext.js";
```

2. Add hook call inside `PluginConfigForm` function after `const queryClient = useQueryClient();` (line 31):

```tsx
const { pushToast } = useToast();
```

3. Update `onSuccess` (lines 38–41):

```tsx
onSuccess: () => {
  queryClient.invalidateQueries({ queryKey: ["company-plugins", companyId] });
  pushToast({ title: "Settings saved", tone: "success" });
  onSaved?.();
},
```

- [ ] **Step 4: Run the test — confirm it passes**

```
pnpm --filter ui test -- --run src/components/settings/__tests__/PluginConfigForm.test.tsx
```

Expected: Both tests PASS.

- [ ] **Step 5: Run the full UI test suite**

```
pnpm --filter ui test -- --run
```

Expected: All tests pass.

- [ ] **Step 6: Commit**

```
git add ui/src/components/settings/PluginConfigForm.tsx ui/src/components/settings/__tests__/PluginConfigForm.test.tsx
git commit -m "fix(plugin-ui): show success toast when plugin settings are saved"
```

---

## Task 4 — Fix: no recovery path for `error`-state plugins

**Context:** The plugin lifecycle `enable()` method accepts `error` as a valid source state and will restart the plugin worker (server-side `POST /plugins/:pluginId/enable`). The existing `patchPluginSettings` toggle only updates the company-level `pluginCompanySettings.enabled` flag — a different concept. There is currently no UI path to re-activate a broken plugin.

`enable` is a method on the `pluginsApi` object export, but `PluginDetailSlideOver.tsx` uses only direct named exports (`patchPluginSettings`, `upgradePlugin`). We add a direct named export `retryPlugin` so the component follows the same pattern, then add the Retry button.

`pluginsApi.enable()` exists in `ui/src/api/plugins.ts:226` as an object method:
```ts
enable: (pluginId: string) => api.post<{ ok: boolean }>(`/plugins/${pluginId}/enable`, {}),
```

**Files:**
- Modify: `ui/src/api/plugins.ts` (append named export after line 553)
- Modify: `ui/src/components/settings/PluginDetailSlideOver.tsx`

No test file exists for this component. We will write one.

- [ ] **Step 1: Write the failing test**

Create `ui/src/components/settings/__tests__/PluginDetailSlideOver.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { PluginDetailSlideOver } from "../PluginDetailSlideOver";
import * as pluginsApi from "@/api/plugins";
import type { InstalledPlugin } from "@/api/plugins";

vi.mock("@/api/plugins", async () => {
  const actual = await vi.importActual<typeof import("@/api/plugins")>("@/api/plugins");
  return {
    ...actual,
    patchPluginSettings: vi.fn(),
    retryPlugin: vi.fn(),
    getPluginConfig: vi.fn().mockResolvedValue({ configJson: {} }),
  };
});

const ERROR_PLUGIN: InstalledPlugin = {
  id: "plugin-1",
  companyId: "c1",
  catalogItemId: null,
  pluginKey: "aoa.plugin-discord",
  packageName: "aoa-plugin-discord",
  version: "1.0.0",
  status: "error",
  enabled: true,
  categories: [],
  manifest: {
    displayName: "Discord",
    description: "Discord notifications",
    capabilities: [],
    instanceConfigSchema: undefined,
  },
  configJson: {},
  lastError: "Activation failed: worker process crashed",
  installedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function wrap(plugin: InstalledPlugin) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PluginDetailSlideOver
        companyId="c1"
        plugin={plugin}
        pendingUpdate={undefined}
        onClose={() => {}}
      />
    </QueryClientProvider>,
  );
}

describe("PluginDetailSlideOver", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("shows Retry activation button when plugin status is error", () => {
    wrap(ERROR_PLUGIN);
    expect(screen.getByRole("button", { name: /retry activation/i })).toBeInTheDocument();
  });

  it("does NOT show Retry activation button when plugin status is ready", () => {
    wrap({ ...ERROR_PLUGIN, status: "ready" });
    expect(
      screen.queryByRole("button", { name: /retry activation/i }),
    ).not.toBeInTheDocument();
  });

  it("shows last error message when plugin has lastError", () => {
    wrap(ERROR_PLUGIN);
    expect(screen.getByText("Activation failed: worker process crashed")).toBeInTheDocument();
  });

  it("calls retryPlugin when Retry activation is clicked", async () => {
    vi.mocked(pluginsApi.retryPlugin).mockResolvedValueOnce({ ok: true });
    wrap(ERROR_PLUGIN);

    await userEvent.click(screen.getByRole("button", { name: /retry activation/i }));

    await waitFor(() =>
      expect(pluginsApi.retryPlugin).toHaveBeenCalledWith("plugin-1"),
    );
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```
pnpm --filter ui test -- --run src/components/settings/__tests__/PluginDetailSlideOver.test.tsx
```

Expected: FAIL — "Retry activation" button not found, `retryPlugin` not a named export.

- [ ] **Step 3: Add `retryPlugin` named export to `ui/src/api/plugins.ts`**

Append after the final `patchPluginSettings` export (after line 553):

```ts
export const retryPlugin = (pluginId: string) =>
  api.post<{ ok: true }>(`/plugins/${pluginId}/enable`, {});
```

- [ ] **Step 4: Add retry mutation and button to `PluginDetailSlideOver.tsx`**

In `ui/src/components/settings/PluginDetailSlideOver.tsx`:

1. Add `retryMutation` after the existing `toggleMutation` (after line 44):

```tsx
const retryMutation = useMutation({
  mutationFn: () => pluginsApi.retryPlugin(plugin.id),
  onSuccess: () => queryClient.invalidateQueries({ queryKey: ["company-plugins", companyId] }),
});
```

2. In the Actions section (after the enable/disable button, around line 216), add the retry button:

```tsx
{plugin.status === "error" && (
  <button
    type="button"
    disabled={retryMutation.isPending}
    onClick={() => retryMutation.mutate()}
    className="w-full text-left text-xs text-amber-400 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-60 border border-amber-900/40 rounded-lg px-3 py-2 transition-colors"
  >
    {retryMutation.isPending ? "Retrying…" : "Retry activation"}
  </button>
)}
{retryMutation.isError && (
  <p className="text-[10px] text-red-400 mt-1">
    {retryMutation.error instanceof Error
      ? retryMutation.error.message
      : "Retry failed"}
  </p>
)}
```

The full Actions section (replacing lines 207–217) becomes:

```tsx
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
  {plugin.status === "error" && (
    <button
      type="button"
      disabled={retryMutation.isPending}
      onClick={() => retryMutation.mutate()}
      className="w-full text-left text-xs text-amber-400 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-60 border border-amber-900/40 rounded-lg px-3 py-2 transition-colors"
    >
      {retryMutation.isPending ? "Retrying…" : "Retry activation"}
    </button>
  )}
  {retryMutation.isError && (
    <p className="text-[10px] text-red-400 mt-1">
      {retryMutation.error instanceof Error
        ? retryMutation.error.message
        : "Retry failed"}
    </p>
  )}
</div>
```

- [ ] **Step 5: Run the test — confirm it passes**

```
pnpm --filter ui test -- --run src/components/settings/__tests__/PluginDetailSlideOver.test.tsx
```

Expected: All 4 tests PASS.

- [ ] **Step 6: Run the full UI test suite**

```
pnpm --filter ui test -- --run
```

Expected: All tests pass.

- [ ] **Step 7: Commit**

```
git add ui/src/api/plugins.ts ui/src/components/settings/PluginDetailSlideOver.tsx ui/src/components/settings/__tests__/PluginDetailSlideOver.test.tsx
git commit -m "fix(plugin-ui): add Retry activation button for error-state plugins"
```
