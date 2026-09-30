# Plugin UI Slot Coverage

Audit performed 2026-05-06 against kitchen-sink example plugin (`aoa-kitchen-sink-example`, v0.1.0).

Definitions live in `packages/shared/src/constants.ts` (`PLUGIN_UI_SLOT_TYPES`).  
Runtime slot infrastructure: `ui/src/plugins/slots.tsx`.  
Consumers verified by grepping for `PluginSlotOutlet`, `PluginSlotMount`, `usePluginSlots` across `ui/src/`.

---

## Status legend

| Symbol | Meaning |
|--------|---------|
| ✅ | Rendered and visible in browser |
| ❌ | Slot type defined but no UI consumer exists |
| ⚠️ | Partially wired — see notes |

---

## Slot audit

### ✅ `page`

**Where:** `ui/src/pages/PluginPage.tsx`  
**Route:** `/:companyPrefix/plugins/:pluginId`  
**Renders:** Plugin's `page` slot via `PluginSlotMount`. Page title + Back button are host-rendered; slot content fills the body.

**Gap — `routePath` navigation not implemented:**  
The manifest declares `routePath: "kitchensink"`, but no route `/:companyPrefix/kitchensink` (or `/plugins/r/:routePath`) exists in `App.tsx`. Navigating to `/ARM/kitchensink` produces React Router "No routes matched" and a blank page. The pluginId route (`/ARM/plugins/:pluginId`) is the only working entry point.

**Note on PLUGINS sidebar section:**  
The sidebar's PLUGINS nav section (e.g. "Kitchen Sink (Example)") is driven by plugins that have a `page` slot — it is NOT the `sidebar` slot type. See `ui/src/components/Sidebar.tsx:59–61`.

---

### ✅ `settingsPage`

**Where:** `ui/src/pages/PluginSettings.tsx`  
**Route:** `/instance/settings/plugins/:pluginId`  
**Renders:** Plugin's custom settings page via `usePluginSlots({ slotTypes: ["settingsPage"] })` + `PluginSlotMount`. Falls back to auto-generated config form when no `settingsPage` slot is declared.

---

### ❌ `sidebar`

**Defined in:** `PLUGIN_UI_SLOT_TYPES`  
**Consumer:** None. The sidebar PLUGINS section is driven by `page` slots, not `sidebar` slots (see `Sidebar.tsx:59`).  
**To implement:** Add `usePluginSlots({ slotTypes: ["sidebar"] })` to `Sidebar.tsx` and render each slot as a nav item below the auto-registered PLUGINS entries.

---

### ❌ `sidebarPanel`

**Defined in:** `PLUGIN_UI_SLOT_TYPES`  
**Consumer:** None. Slot type has no rendering target anywhere in `ui/src/`.  
**To implement:** Render inside the plugin detail page (`/ARM/plugins/:pluginId`) as the main panel body, or as a right-side sheet when the sidebar item is clicked.

---

### ❌ `dashboardWidget`

**Defined in:** `PLUGIN_UI_SLOT_TYPES`  
**Consumer:** None. `ui/src/pages/Dashboard.tsx` (Home page) does not call `usePluginSlots` or `PluginSlotOutlet`.  
**To implement:** Add a widgets section to `Dashboard.tsx` using `usePluginSlots({ slotTypes: ["dashboardWidget"] })`.

---

### ❌ `projectSidebarItem`

**Defined in:** `PLUGIN_UI_SLOT_TYPES` (entityTypes: `["project"]`)  
**Consumer:** None. `ui/src/components/SidebarProjects.tsx` / `SidebarProjectsByType.tsx` do not call plugin slot hooks.  
**To implement:** Inject below each project entry in the project sidebar list.

---

### ❌ `detailTab` (issue + project)

**Defined in:** `PLUGIN_UI_SLOT_TYPES` (entityTypes: `["issue"]` and `["project"]`)  
**Consumer:** None.
- Issue detail: `ui/src/components/TaskSlideOver.tsx` and `ui/src/pages/IssueDetail.tsx` have no `PluginSlotOutlet`/`usePluginSlots` calls. The existing Tabs (Comments / Sub-tasks / Activity / Artifacts) are hardcoded.
- Project detail: not checked for `project` entityType but the same infra gap applies.

**To implement:** Add plugin-injected tabs to the `TabsList` in `TaskSlideOver.tsx` and `IssueDetail.tsx`.

---

### ❌ `taskDetailView`

**Defined in:** `PLUGIN_UI_SLOT_TYPES` (entityTypes: `["issue"]`)  
**Consumer:** None. Neither `TaskSlideOver.tsx` nor `IssueDetail.tsx` render this slot.  
**To implement:** Render as an additional section in the task detail body (below or alongside the main detail pane).

---

### ❌ `toolbarButton`

**Defined in:** `PLUGIN_UI_SLOT_TYPES` (entityTypes: `["project", "issue"]`)  
**Consumer:** None. The toolbar buttons in `TaskSlideOver.tsx` ("Open in LLM", "More task actions") are hardcoded with no plugin injection point.  
**To implement:** Add a plugin toolbar zone to the task/project action bar.

---

### ❌ `contextMenuItem`

**Defined in:** `PLUGIN_UI_SLOT_TYPES` (entityTypes: `["project", "issue"]`)  
**Consumer:** None. No context menu in `TaskSlideOver.tsx` or project views calls plugin slot hooks.  
**To implement:** Inject into the "More task actions" dropdown and project kebab menus.

---

### ❌ `commentAnnotation`

**Defined in:** `PLUGIN_UI_SLOT_TYPES` (entityTypes: `["comment"]`)  
**Consumer:** None. No comment thread component calls plugin slot hooks.  
**To implement:** Render below each comment body in the CommentThread component.

---

### ❌ `commentContextMenuItem`

**Defined in:** `PLUGIN_UI_SLOT_TYPES` (entityTypes: `["comment"]`)  
**Consumer:** None. Comment action menus do not have a plugin injection point.  
**To implement:** Inject into the per-comment action dropdown.

---

## Summary

| Slot type | Status | Consumer file |
|-----------|--------|---------------|
| `page` | ✅ | `ui/src/pages/PluginPage.tsx` |
| `settingsPage` | ✅ | `ui/src/pages/PluginSettings.tsx` |
| `sidebar` | ❌ | — |
| `sidebarPanel` | ❌ | — |
| `dashboardWidget` | ❌ | — |
| `projectSidebarItem` | ❌ | — |
| `detailTab` (issue) | ❌ | — |
| `detailTab` (project) | ❌ | — |
| `taskDetailView` | ❌ | — |
| `toolbarButton` | ❌ | — |
| `contextMenuItem` | ❌ | — |
| `commentAnnotation` | ❌ | — |
| `commentContextMenuItem` | ❌ | — |

**2 of 13 slot types implemented.** The slot infrastructure (`slots.tsx`) is fully built; the gap is that only `PluginPage` and `PluginSettings` call into it. The remaining 11 slot types need host-side `usePluginSlots` / `PluginSlotOutlet` call sites wired into the relevant layout components.

---

## Known bugs found during audit

1. **`routePath` navigation broken** — No router route for `/:companyPrefix/:pluginRoutePath`. Direct URL `/ARM/kitchensink` returns "No routes matched". File to fix: `ui/src/App.tsx` (add `<Route path=":pluginRoutePath" element={<PluginPage />} />`).
2. **`KitchenSinkSettingsPage` missing `key` props** — React "Each child in a list should have a unique key prop" warnings from `KitchenSinkSettingsPage`. File: `packages/plugins/examples/plugin-kitchen-sink-example/src/ui/settings.tsx` (or similar).
3. **`aoa.plugin-github-issues` UI module 404** — `Failed to fetch plugin module: 404 Not Found` for GitHub Issues plugin. The plugin is installed but its `dist/ui` bundle was not built. Run `pnpm build` in `aoa-marketplace/plugins/aoa-plugin-github-issues/` to fix.
