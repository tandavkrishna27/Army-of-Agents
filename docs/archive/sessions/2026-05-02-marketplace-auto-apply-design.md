# Marketplace Auto-Apply Skill Updates Design

## Goal

When a founder sets `skillUpdatePolicy = "auto"`, catalog skill updates are applied automatically by the update checker — no manual merge required. Skills the founder has edited are skipped (fallback to notify). Auto-apply is fully opt-in; the default remains `"notify"`.

## Scope (v1)

- **Skills only.** Agents, teams, and plugins are deferred — the update checker already has TODO comments for those types.
- **Catalog-sourced skills only.** Skills with `sourceType !== "catalog"` are ignored (existing behaviour).
- **No UI changes.** All logic lives in the server. The existing marketplace settings UI already exposes `skillUpdatePolicy` and `updateWindow`.

---

## Architecture

Approach: extend the existing update checker inline (no new background job, no new tables except one column).

### Files changed

| File | Change |
|------|--------|
| `packages/db/src/schema/company_skills.ts` | Add `customized: boolean` column |
| `server/src/services/marketplace-install/skill-content.ts` | **New** — shared fetch helper |
| `server/src/services/marketplace-install/skill-installer.ts` | Refactor to use shared fetch helper |
| `server/src/services/marketplace-install/skill-auto-updater.ts` | **New** — applies a skill update |
| `server/src/services/marketplace-update-checker.ts` | Extend `checkCompany()` + refactor `upsertPendingUpdate` |
| `server/src/routes/marketplace-company.ts` | Merge endpoint sets `customized = true` |
| `server/src/routes/company-skills.ts` | `updateFile()` sets `customized = true` |

### New test files

| File | What it tests |
|------|---------------|
| `server/src/__tests__/skill-content.test.ts` | `fetchSkillContent` pure function |
| `server/src/__tests__/skill-update-window.test.ts` | `isWithinUpdateWindow` pure function |
| `server/src/__tests__/skill-auto-updater.test.ts` | `applySkillUpdate` with mock DB |
| `server/src/__tests__/marketplace-update-checker.test.ts` | `checkCompany` gate logic + error isolation |

Plus additions to `marketplace-company.test.ts` and `company-skills.test.ts`.

---

## Schema Change

**File:** `packages/db/src/schema/company_skills.ts`

Add one column:

```ts
customized: boolean("customized").notNull().default(false),
```

- Starts `false` on every install (including existing rows after migration).
- Flips to `true` when the founder edits a skill via **either** edit path (see below).
- Once `true`, stays `true` — never resets automatically.
- Migration generated via `pnpm db:generate` (no raw SQL).

### Why this column

The auto-updater overwrites `company_skills.markdown` with new catalog content. If the founder has edited that skill, overwriting destroys their work. `customized` is the flag that prevents this: when `true`, auto-apply is skipped and the founder is notified instead.

---

## Customization Tracking

Two edit paths exist for a skill's markdown. Both must set `customized = true`.

### Path 1: Direct edit (Skills page)

**Route:** `PATCH /companies/:companyId/skills/:skillId/files`  
**File:** `server/src/routes/company-skills.ts`  

After `svc.updateFile()` succeeds, add:

```ts
await db.update(companySkills)
  .set({ customized: true })
  .where(eq(companySkills.id, skillId));
```

### Path 2: Marketplace merge flow

**Route:** `POST /companies/:companyId/marketplace/updates/:id/merge`  
**File:** `server/src/routes/marketplace-company.ts`  

After the existing `markdown + sourceRef` update, add `customized: true` to the same SET clause. One DB round-trip.

---

## Shared Content Fetcher

**File:** `server/src/services/marketplace-install/skill-content.ts`

```ts
export async function fetchSkillContent(catalogItem: CatalogItem): Promise<string> {
  if (catalogItem.content?.inline) {
    return catalogItem.content.inline;
  }
  if (!catalogItem.resourceUrl) {
    throw new Error(`Skill ${catalogItem.id} has no resourceUrl and no inline content`);
  }
  const res = await fetch(catalogItem.resourceUrl, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching skill content from ${catalogItem.resourceUrl}`);
  }
  return res.text();
}
```

`skill-installer.ts` replaces its inline fetch block with `fetchSkillContent(catalogItem)`. No behaviour change — the existing tests verify both branches.

---

## Update Window Utility

**File:** `server/src/services/marketplace-install/skill-auto-updater.ts` (exported from here)

```ts
export function isWithinUpdateWindow(window: UpdateWindow, now: Date = new Date()): boolean {
  const hour = now.getUTCHours();
  const day = now.getUTCDay(); // 0 = Sunday, 6 = Saturday
  switch (window) {
    case "anytime":   return true;
    case "off_hours": return hour < 8 || hour >= 20; // before 8am or after 8pm UTC
    case "weekends":  return day === 0 || day === 6;
  }
}
```

The optional `now` parameter makes this fully testable without mocking globals.

`UpdateWindow` type already exists in `packages/shared/src/marketplace.ts`.  
Default: `"anytime"` — updates fire whenever the checker runs.

---

## Skill Auto-Updater Service

**File:** `server/src/services/marketplace-install/skill-auto-updater.ts`

```ts
export async function applySkillUpdate(args: {
  db: DrizzleDb;
  pendingUpdate: { id: string; catalogItemId: string; latestVersion: string };
  companyId: string;
  catalogItem: CatalogItem;
}): Promise<void>
```

Steps:

1. **Fetch content** via `fetchSkillContent(catalogItem)`. Throws on failure — caller catches.
2. **Transaction:**
   a. Re-read `customized` from DB (`SELECT customized FROM company_skills WHERE sourceLocator = catalogItemId AND companyId = companyId LIMIT 1`).
   b. If `customized = true` → rollback, throw a typed `SkillCustomizedError` (caller fires `updateAvailable` as fallback).
   c. Update `company_skills`: `markdown = newContent`, `sourceRef = latestVersion`.
   d. Check `rowsAffected`. If 0 → skill was deleted between check and apply → rollback, throw `SkillDeletedError` (caller skips notification).
   e. Update `marketplace_pending_updates`: `status = "applied"` where `id = pendingUpdate.id`.
3. **Notification** (outside transaction, separate try/catch):
   ```ts
   try {
     await marketplaceNotifications.updateCompleted(db, companyId, catalogItemId, latestVersion);
   } catch (err) {
     console.error("updateCompleted notification failed:", err);
     // DB already committed — do not rethrow
   }
```

---

## Update Checker Changes

**File:** `server/src/services/marketplace-update-checker.ts`

### `upsertPendingUpdate` signature change

Currently fires `updateAvailable()` internally on new rows. Change: remove the internal notification call, return `{ inserted: boolean }`. Caller owns the notification.

```ts
async function upsertPendingUpdate(...): Promise<{ inserted: boolean }>
```

### `checkCompany` new flow

```
settings = await marketplaceSettingsService(db).get(companyId)  // read ONCE per company

for each catalog-installed skill:
  try:
    { inserted } = await upsertPendingUpdate(...)
    if !inserted: continue   // already knew about this update, skip

    if settings.skillUpdatePolicy === "auto"
      AND isWithinUpdateWindow(settings.updateWindow)
      :
        // Note: skill.customized is re-checked inside the transaction in applySkillUpdate
        // (not pre-checked here, to avoid acting on stale data from the initial query)
        try:
          await applySkillUpdate({ ..., catalogItem })
          // updateCompleted fired inside applySkillUpdate
        catch SkillCustomizedError:
          await marketplaceNotifications.updateAvailable(...)  // fallback
        catch SkillDeletedError:
          // skip — no notification
        catch err:
          console.error(...)
          await marketplaceNotifications.updateAvailable(...)  // fallback
    else:
      await marketplaceNotifications.updateAvailable(...)      // notify-only path
  catch err:
    console.error(`Skill ${catalogItemId} update check failed:`, err)
    // continue to next skill
```

### `runUpdateCheck` per-company isolation

```ts
for (const company of companies) {
  try {
    await checkCompany(db, company, catalogItems)
  } catch (err) {
    console.error(`Update check failed for company ${company.id}:`, err)
    // continue to next company
  }
}
```

---

## Error Handling Summary

| Failure | Pending row | Notification fired | Data state |
|---------|-------------|-------------------|------------|
| Fetch fails | stays `pending` | `updateAvailable` (fallback) | unchanged |
| `customized = true` at apply time | stays `pending` | `updateAvailable` (fallback) | unchanged |
| Skill deleted before apply | stays `pending` | none | n/a |
| DB write fails (transaction rolled back) | stays `pending` | `updateAvailable` (fallback) | unchanged |
| Notification fails after commit | marked `applied` | none (logged) | updated correctly |
| Per-skill crash | stays `pending` | none | unchanged |
| Per-company crash | stays `pending` | none | unchanged |

No retry logic in v1 — the next scheduled checker run (default every 6h) retries naturally.

---

## Notification Flow

No new notification types. Uses existing:
- `marketplaceNotifications.updateAvailable()` — founder needs to manually review
- `marketplaceNotifications.updateCompleted()` — skill was auto-applied

The auto-apply path suppresses `updateAvailable` and fires `updateCompleted` on success. If auto-apply fails for any reason, `updateAvailable` fires as fallback — founder always gets exactly one notification per new update row.

---

## Default Values

| Setting | Default | Source |
|---------|---------|--------|
| `skillUpdatePolicy` | `"notify"` | `MARKETPLACE_SETTINGS_DEFAULTS` in `packages/shared/src/marketplace.ts` |
| `updateWindow` | `"anytime"` | `MARKETPLACE_SETTINGS_DEFAULTS` |

Auto-apply is fully opt-in. Founders who never touch these settings see no behaviour change.

---

## Testing Plan

### `skill-content.test.ts`
- Returns inline content (no HTTP fetch)
- Fetches from `resourceUrl` when inline absent
- Throws on HTTP non-ok
- Throws when neither inline nor `resourceUrl`

### `skill-update-window.test.ts`
- `anytime` → always true
- `off_hours` → true at 07:00 UTC, true at 21:00 UTC, false at 10:00 UTC
- `weekends` → true Saturday/Sunday, false Wednesday

### `skill-auto-updater.test.ts`
- Applies update when all gates pass — markdown updated, pending marked `applied`, `updateCompleted` fired
- Aborts when `customized = true` found inside transaction — no write, throws `SkillCustomizedError`
- Zero `rowsAffected` (skill deleted) — skips notification, throws `SkillDeletedError`
- Notification failure — DB state already committed, does not rethrow

### `marketplace-update-checker.test.ts`
- `notify` policy → `updateAvailable` fired, no auto-apply
- `auto` policy + in-window + not customized → `applySkillUpdate` called
- `auto` policy + out-of-window → falls back to `updateAvailable`
- `auto` policy + skill customized at apply time → falls back to `updateAvailable`
- Auto-apply fetch failure → falls back to `updateAvailable`
- One company throwing → other companies still processed
- One skill failing → other skills in same company still processed

### Additions to existing tests
- `marketplace-company.test.ts`: merge endpoint sets `customized = true` on skill row
- `company-skills.test.ts`: `updateFile()` sets `customized = true` on skill row
