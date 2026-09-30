# W2 Task 7 Notification Settings UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add working notification preference controls and digest summary controls to the Inbox Hub settings UI.

**Architecture:** Keep settings inside the existing `HubShell` settings strip rather than introducing a new route, modal, or socket. `InboxHub` owns server state and mutations through React Query; `HubShell` remains a controlled presentational component that emits preference patches and digest actions.

**Tech Stack:** React, Vite, TanStack Query, Vitest, Testing Library, existing AoA shared notification preference contracts.

---

## File Structure

- Modify `ui/src/components/hub/HubShell.tsx`
  - Extend props for notification preferences, pending state, digest items, reset, update, and ack handlers.
  - Replace the disabled "Notification preferences" settings entry with an active sub-panel.
  - Keep rendering dense and operational: compact fieldsets, native selects/checkboxes, no new card-in-card layout.
- Modify `ui/src/components/hub/__tests__/HubShell.test.tsx`
  - Add red tests for opening notification preferences, changing delivery modes, toggling toast, quiet hours, reset, digest summary, and ack.
- Modify `ui/src/pages/InboxHub.tsx`
  - Reuse the Task 6 notification preferences query.
  - Add notification preference update/reset mutations with optimistic update and rollback.
  - Add digest list query and ack mutation.
  - Pass controlled props to `HubShell`.
- Modify `ui/src/__tests__/InboxHub.test.tsx`
  - Verify notification preference mutations and digest ack wiring.

---

## Task 1: HubShell Notification Preferences Panel

**Files:**
- Modify: `ui/src/components/hub/HubShell.tsx`
- Modify: `ui/src/components/hub/__tests__/HubShell.test.tsx`

- [x] **Step 1: Write failing HubShell settings tests**

Add tests that render `HubShell` with:

```ts
notificationPreferences={{
  rules: [
    { semanticType: "approval_request", deliveryMode: "realtime", toastEnabled: true },
    { semanticType: "reminder", deliveryMode: "realtime", toastEnabled: true },
  ],
  quietHours: { enabled: false, start: "18:00", end: "09:00", timezone: "UTC" },
  digest: { enabled: true, cadence: "daily" },
  updatedAt: null,
}}
digestItems={[hubItem({ id: "digest-1", title: "Digest reminder", semanticType: "reminder", lane: "notifications" })]}
onUpdateNotificationPreferences={onUpdateNotificationPreferences}
onResetNotificationPreferences={onResetNotificationPreferences}
onAckDigest={onAckDigest}
```

Assertions:

```ts
await user.click(screen.getByRole("button", { name: /hub settings/i }));
await user.click(screen.getByRole("button", { name: /notification preferences/i }));
expect(screen.getByRole("heading", { name: /notification preferences/i })).toBeInTheDocument();
await user.selectOptions(screen.getByLabelText(/reminder delivery/i), "digest");
expect(onUpdateNotificationPreferences).toHaveBeenCalledWith({
  rules: expect.arrayContaining([
    expect.objectContaining({ semanticType: "reminder", deliveryMode: "digest" }),
  ]),
});
```

Also assert:

```ts
await user.click(screen.getByRole("checkbox", { name: /reminder toast/i }));
expect(onUpdateNotificationPreferences).toHaveBeenCalledWith({
  rules: expect.arrayContaining([
    expect.objectContaining({ semanticType: "reminder", toastEnabled: false }),
  ]),
});
await user.click(screen.getByRole("checkbox", { name: /quiet hours/i }));
expect(onUpdateNotificationPreferences).toHaveBeenCalledWith({
  quietHours: { enabled: true, start: "18:00", end: "09:00", timezone: "UTC" },
});
expect(screen.getByText("Digest reminder")).toBeInTheDocument();
await user.click(screen.getByRole("button", { name: /acknowledge digest/i }));
expect(onAckDigest).toHaveBeenCalled();
await user.click(screen.getByRole("button", { name: /reset notification preferences/i }));
expect(onResetNotificationPreferences).toHaveBeenCalled();
```

- [x] **Step 2: Run HubShell tests and verify RED**

Run:

```sh
corepack pnpm@9.15.4 test:run ui/src/components/hub/__tests__/HubShell.test.tsx
```

Expected: FAIL because `HubShell` does not accept notification props and the notification preferences entry is disabled.

- [x] **Step 3: Implement the controlled panel**

Add props to `HubShellProps`:

```ts
notificationPreferences?: NotificationPreferences;
notificationPreferencesPending?: boolean;
onUpdateNotificationPreferences?: (patch: UpdateNotificationPreferencesInput) => void;
onResetNotificationPreferences?: () => void;
digestItems?: HubItemListRow[];
onAckDigest?: () => void;
```

Implementation details:

- Use `DEFAULT_NOTIFICATION_PREFERENCES` when no preferences are passed.
- Render a toggle button labeled `Notification preferences`.
- When open, render:
  - `<h2>Notification preferences</h2>`
  - A row per rule with `aria-label={`${label} delivery`}` select values `realtime`, `digest`, `silent`.
  - A toast checkbox with `aria-label={`${label} toast`}` disabled unless delivery mode is `realtime`.
  - Quiet hours checkbox/start/end/timezone inputs.
  - Digest enabled checkbox.
  - Digest summary list from `digestItems`.
  - `Acknowledge digest` button disabled when `digestItems.length === 0`.
  - `Reset notification preferences` button.
- Build full `rules` arrays when updating one rule so the server receives a complete deduplicated rules patch.

- [x] **Step 4: Run HubShell tests and verify GREEN**

Run:

```sh
corepack pnpm@9.15.4 test:run ui/src/components/hub/__tests__/HubShell.test.tsx
```

Expected: PASS.

- [x] **Step 5: Commit Task 1**

```sh
git add ui/src/components/hub/HubShell.tsx ui/src/components/hub/__tests__/HubShell.test.tsx
git commit -m "feat(ui): add hub notification settings panel"
```

---

## Task 2: InboxHub Notification Settings Wiring

**Files:**
- Modify: `ui/src/pages/InboxHub.tsx`
- Modify: `ui/src/__tests__/InboxHub.test.tsx`

- [x] **Step 1: Write failing InboxHub wiring tests**

Add tests to `InboxHub.test.tsx`:

```ts
it("updates notification preferences from hub settings", async () => {
  renderPage("/P4/inbox/waiting");
  await user.click(screen.getByRole("button", { name: /hub settings/i }));
  await user.click(screen.getByRole("button", { name: /notification preferences/i }));
  await user.selectOptions(screen.getByLabelText(/approval request delivery/i), "digest");
  await waitFor(() => {
    expect(hubItemsApi.notificationPreferences.update).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        rules: expect.arrayContaining([
          expect.objectContaining({ semanticType: "approval_request", deliveryMode: "digest" }),
        ]),
      }),
    );
  });
});

it("acknowledges pending digest items from hub settings", async () => {
  vi.mocked(hubItemsApi.notificationDigest.list).mockResolvedValue({ items: [hubItem({ id: "digest-1", title: "Digest reminder" })] });
  renderPage("/P4/inbox/waiting");
  await user.click(screen.getByRole("button", { name: /hub settings/i }));
  await user.click(screen.getByRole("button", { name: /notification preferences/i }));
  await user.click(await screen.findByRole("button", { name: /acknowledge digest/i }));
  await waitFor(() => {
    expect(hubItemsApi.notificationDigest.ack).toHaveBeenCalledWith("company-1");
  });
});
```

- [x] **Step 2: Run InboxHub tests and verify RED**

Run:

```sh
corepack pnpm@9.15.4 test:run ui/src/__tests__/InboxHub.test.tsx
```

Expected: FAIL because `InboxHub` does not pass notification settings props to `HubShell` and does not define update/reset/digest ack mutations.

- [x] **Step 3: Implement React Query wiring**

In `InboxHub.tsx`:

- Reuse `notificationPreferencesQuery` from Task 6.
- Add `updateNotificationPreferences` mutation:
  - `mutationFn: (patch) => hubItemsApi.notificationPreferences.update(selectedCompanyId!, patch)`
  - `onMutate`: cancel `queryKeys.notifications.preferences(companyId)`, capture previous, set optimistic merged value.
  - `onError`: restore previous if present.
  - `onSuccess`: set returned preferences.
  - `onSettled`: invalidate preferences.
- Add `resetNotificationPreferences` mutation:
  - call `hubItemsApi.notificationPreferences.reset(companyId)`.
  - on success set preferences query data.
- Add `digestQuery` using `queryKeys.notifications.digest(companyId)`.
- Add `ackDigest` mutation:
  - call `hubItemsApi.notificationDigest.ack(companyId)`.
  - on success invalidate digest query.
- Pass `notificationPreferences`, `notificationPreferencesPending`, handlers, `digestItems`, and `onAckDigest` to `HubShell`.

- [x] **Step 4: Run focused UI tests and typecheck**

Run:

```sh
corepack pnpm@9.15.4 test:run ui/src/components/hub/__tests__/HubShell.test.tsx ui/src/__tests__/InboxHub.test.tsx
corepack pnpm@9.15.4 --filter @armyofagents/ui typecheck
```

Expected: PASS.

- [x] **Step 5: Commit Task 2**

```sh
git add ui/src/pages/InboxHub.tsx ui/src/__tests__/InboxHub.test.tsx
git commit -m "feat(ui): wire hub notification settings"
```

---

## Self-Review

- Spec coverage: Covers Task 7 requirements from the W2 Layer 3 roadmap: settings entry, delivery controls, quiet hours, digest controls, reset, and page mutation wiring.
- Placeholder scan: No placeholder implementation steps remain.
- Type consistency: Uses existing shared types `NotificationPreferences` and `UpdateNotificationPreferencesInput`, and existing API methods from Task 6.
