# Plan: Move the Inbox Hub settings into a Settings → Inbox section

**Goal.** Relocate the Inbox Hub's inline gear settings panel into a new **"Inbox"**
section of the main Settings tab, presented as a proper explained panel, and
**remove** the settings gear + inline panel from the Inbox entirely. The Inbox hub
keeps reading the preferences it needs to render itself (grouping, visible lanes,
density, default landing, autopilot status for Home); only the *editing UI* moves.

**Architecture.** React 19 + Vite + TailwindCSS v4 UI (`ui/src/`). The settings are
already server-backed through `hubItemsApi` (`ui/src/api/hub-items.ts`):
`getPreferences`/`updatePreferences` (`/hub-items/preferences/me`),
`autopilotPolicy.get/update/reset` (`/hub-autopilot/policy`),
`notificationPreferences.get/update/reset` (`/notifications/preferences/me`),
`notificationDigest.list/ack` (`/notifications/digest/me`). No server changes.
Settings sections are registered in three coupled places
(`SettingsLayout.tsx`, `SettingsPage.tsx`) and each renders a section component under
`ui/src/components/settings/sections/`.

**Tech stack.** TypeScript (strict), @tanstack/react-query v5, Vitest +
@testing-library/react, lucide-react icons.

**Branch.** `feat/provider-readiness` (worktree `C:/Users/TK/.aoa/wt/providers`),
HEAD `b2b271779`. Everything runs from the repo root.

---

## Design decisions (locked — do not relitigate)

1. **Section name is "Inbox"** — not "Discussions". The settings control
   inbox/hub behaviour, so the section lives under Settings labelled "Inbox".
2. **The gear is removed from the Inbox entirely.** The settings live **only** in
   Settings → Inbox. Single home, no mirror. No gear button, no inline panel, no
   `settingsOpen` state remain in `HubShell`.
3. **The new section presents the settings as a proper panel with explanations.**
   Each setting group gets a short helper sentence (not just today's terse label).

---

## File Structure

| File | Change |
|------|--------|
| `ui/src/components/inbox/InboxSettingsPanel.tsx` | **New.** Presentational panel extracted from HubShell's inline settings `<div>`. Owns its own `notificationPanelOpen` state + the `updateNotificationRule`/`updateQuietHours`/`updateDigest`/`updateAutopilotRule`/`semanticTypeLabel` helpers. |
| `ui/src/components/inbox/__tests__/InboxSettingsPanel.test.tsx` | **New.** Panel rendering + change-handler + explanatory-copy tests. |
| `ui/src/components/hub/HubShell.tsx` | **Edit.** Task 1: render `<InboxSettingsPanel>` in place of the inline `<div>`. Task 4: delete the gear button, `settingsOpen`, `notificationPanelOpen`, the moved helpers, and the settings-only props. Keep every preference **read**. |
| `ui/src/pages/InboxHub.tsx` | **Edit (Task 4, risky).** Remove the preference/notification/autopilot **edit** mutations + optimistic state + the settings props passed to HubShell. Keep the preference/notification/autopilot **read** queries. |
| `ui/src/components/settings/sections/InboxSection.tsx` | **New.** Fetches preferences/autopilot/notifications/digest, owns the edit mutations, renders `InboxSettingsPanel` under a GitHub-style section header. |
| `ui/src/components/settings/__tests__/InboxSection.test.tsx` | **New.** Section registration + renders panel + a change calls the right API. |
| `ui/src/components/settings/SettingsLayout.tsx` | **Edit.** Add `"inbox"` to `SettingsSectionId`; add the `Inbox` item to the Operations group; import the `Inbox` icon. |
| `ui/src/pages/SettingsPage.tsx` | **Edit.** Add `"inbox"` to `VALID_SECTIONS`; import `InboxSection`; add `case "inbox"`. |
| `ui/src/components/hub/__tests__/HubShell.test.tsx` | **Edit (Task 4).** Delete/repurpose the six gear-driven tests (moved to the panel suite). |
| `ui/src/__tests__/InboxHub.test.tsx` | **Edit (Task 4).** Delete the four gear-driven tests (re-homed under InboxSection). |

---

## Repo conventions

- **`ui/tsconfig.json` excludes `src/__tests__` and `src/**/__tests__`.** Type
  guarantees are enforced against **source only**. A prop/type contract asserted
  only in a test is *not* a compile guarantee — the panel's prop interface and the
  section's registration must be real source-level types. Colocated tests live in a
  sibling `__tests__/` directory.
- **Run everything from the repo root.** Commands:
  - Typecheck the UI: `pnpm --filter @armyofagents/ui exec tsc -p tsconfig.json --noEmit`
  - Lint the UI (catches unused imports/vars after prop removal):
    `pnpm --filter @armyofagents/ui lint`
  - Single test file: `pnpm --filter @armyofagents/ui exec vitest run <path>`
  - Full UI suite: `pnpm --filter @armyofagents/ui test`
  - Build: `pnpm --filter @armyofagents/ui build`
- **Follow the existing section pattern.** `GitHubSection.tsx` is the header
  template (eyebrow "Settings · Operations" + `h2` + description). `ProvidersSection`
  is the fetch-and-mutate-inside-a-section template (`useCompany` guard →
  keyed inner panel → `useQuery`/mutations → `queryKeys`).
- **Mutation testing is mandatory and the harness must be self-verified.** For every
  task, after tests are green, prove the tests actually constrain the code by
  mutating the source and confirming a test fails. A green mutation run is a lie
  until the harness is proven honest. Known lies to defend against:
  - **CRLF-vs-LF multiline anchors.** These files may be checked out with CRLF.
    A multiline `old_string` anchored with `\n` will silently fail to match. Read
    the file's bytes, normalise to LF **in memory**, locate + apply the mutation in
    the LF copy, then rewrite the file in its **original EOL**. Never anchor against
    an assumed EOL.
  - **Stale pristine snapshot.** Snapshot the pristine file to a scratch path
    *immediately before* mutating, not from an earlier step.
  - **Pure-reorder / zero-byte-delta mutations.** A swap can be +0 bytes. Detect
    "did the file change" with `git diff --no-index <pristine> <file>` (exit code),
    never a byte-length comparison.
  - **Diffing against HEAD with a dirty tree.** The working tree already has
    uncommitted edits from this task, so `git diff HEAD` is not "my mutation".
    Diff against the **pristine snapshot** taken in this step.
  - **Negative control.** Include one mutation whose anchor is impossible (a string
    that does not occur in the file); the harness MUST report `DID-NOT-APPLY`. If it
    reports "applied", the mutation applier is broken and every "killed" result is
    suspect.
  - Restore the pristine file after each mutation (copy the snapshot back), re-run to
    confirm green is restored before the next mutation.
  - The pre-existing `LobbySidebar.test.tsx` ~3–6% flake is unrelated — do not chase
    it; re-run once if it trips.

  **Reusable mutation procedure (per task):**
  ```
  # 1. snapshot pristine
  cp <target> /tmp/pristine.snap
  # 2. for each mutation: apply to an LF-normalised copy, write back in original EOL
  # 3. verify the file actually changed
  git diff --no-index --quiet /tmp/pristine.snap <target> && echo "DID-NOT-APPLY" || echo "APPLIED"
  # 4. run the guarding test; expect FAIL for a real mutation, DID-NOT-APPLY for the control
  pnpm --filter @armyofagents/ui exec vitest run <test>
  # 5. restore
  cp /tmp/pristine.snap <target>
  ```

---

## Task 1 — Extract the inline settings panel into `InboxSettingsPanel` (behaviour unchanged)

Extract HubShell's inline settings `<div>` (currently `HubShell.tsx` lines 396–748,
gated by `settingsOpen`) into a presentational `InboxSettingsPanel`. HubShell keeps
its gear + `settingsOpen` and renders `<InboxSettingsPanel>` in that slot, so all
existing HubShell/InboxHub tests still pass — this proves the extraction is clean.

Move into the panel: the local `notificationPanelOpen` state (HubShell line 198),
the helpers `updateNotificationRule` (314), `updateQuietHours` (325), `updateDigest`
(331), `updateAutopilotRule` (337), and the module fn `semanticTypeLabel` (984–989).

### 1a. Failing test first

Create `ui/src/components/inbox/__tests__/InboxSettingsPanel.test.tsx`. Model the
fixtures on `HubShell.test.tsx`'s `notificationPreferences()`/`autopilotPolicy()`
helpers. Write it to render the panel directly (no gear).

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  HubAutopilotPolicy,
  HubPreferences,
  NotificationPreferences,
} from "@armyofagents/shared";
import { InboxSettingsPanel } from "../InboxSettingsPanel";
import type { HubItemListRow } from "@/api/hub-items";

function preferences(over: Partial<HubPreferences> = {}): HubPreferences {
  return {
    defaultLanding: "waiting_on_you",
    visibleLanes: ["waiting_on_you", "notifications", "suggestions"],
    groupMode: "auto",
    density: "comfortable",
    showAutopilotEntry: true,
    updatedAt: null,
    ...over,
  };
}

function autopilotPolicy(over: Partial<HubAutopilotPolicy> = {}): HubAutopilotPolicy {
  return {
    mode: "off",
    handledToday: 0,
    lastHandledAt: null,
    rules: [
      { semanticType: "approval_request", action: "none", minTrustScore: 100, enabled: false },
      { semanticType: "run_complete", action: "none", minTrustScore: 100, enabled: false },
    ],
    updatedAt: null,
    ...over,
  };
}

function notificationPreferences(
  over: Partial<NotificationPreferences> = {},
): NotificationPreferences {
  return {
    rules: [
      { semanticType: "approval_request", deliveryMode: "realtime", toastEnabled: true },
      { semanticType: "reminder", deliveryMode: "realtime", toastEnabled: true },
    ],
    quietHours: { enabled: false, start: "18:00", end: "09:00", timezone: "UTC" },
    digest: { enabled: true, cadence: "daily" },
    updatedAt: null,
    ...over,
  };
}

function renderPanel(over: Partial<React.ComponentProps<typeof InboxSettingsPanel>> = {}) {
  const props: React.ComponentProps<typeof InboxSettingsPanel> = {
    preferences: preferences(),
    onPreferencesChange: vi.fn(),
    autopilotPolicy: autopilotPolicy(),
    autopilotPending: false,
    onUpdateAutopilotPolicy: vi.fn(),
    onResetAutopilotPolicy: vi.fn(),
    notificationPreferences: notificationPreferences(),
    notificationPreferencesPending: false,
    onUpdateNotificationPreferences: vi.fn(),
    onResetNotificationPreferences: vi.fn(),
    digestItems: [] as HubItemListRow[],
    onAckDigest: vi.fn(),
    ...over,
  };
  return render(<InboxSettingsPanel {...props} />);
}

describe("InboxSettingsPanel", () => {
  it("renders the preference controls with the supplied values", () => {
    renderPanel();
    expect(screen.getByRole("combobox", { name: /default landing/i })).toHaveValue(
      "waiting_on_you",
    );
    expect(screen.getByRole("combobox", { name: /density/i })).toHaveValue("comfortable");
    expect(screen.getByRole("checkbox", { name: /autopilot entry/i })).toBeChecked();
  });

  it("emits a preferences patch when density changes", async () => {
    const user = userEvent.setup();
    const onPreferencesChange = vi.fn();
    renderPanel({ onPreferencesChange });
    await user.selectOptions(screen.getByRole("combobox", { name: /density/i }), "compact");
    expect(onPreferencesChange).toHaveBeenCalledWith({ density: "compact" });
  });

  it("updates and resets Autopilot mode", async () => {
    const user = userEvent.setup();
    const onUpdateAutopilotPolicy = vi.fn();
    const onResetAutopilotPolicy = vi.fn();
    renderPanel({ onUpdateAutopilotPolicy, onResetAutopilotPolicy });
    await user.selectOptions(screen.getByRole("combobox", { name: /autopilot mode/i }), "drive");
    expect(onUpdateAutopilotPolicy).toHaveBeenCalledWith({ mode: "drive" });
    await user.click(screen.getByRole("button", { name: /reset autopilot/i }));
    expect(onResetAutopilotPolicy).toHaveBeenCalled();
  });

  it("keeps founder-gated categories out of auto-handle configuration", async () => {
    const user = userEvent.setup();
    renderPanel();
    expect(screen.getByText("Approval Request")).toBeInTheDocument();
    expect(screen.getByText(/founder-gated/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: /approval request autopilot action/i }),
    ).not.toBeInTheDocument();
  });

  it("opens notification preferences and changes delivery + toast + quiet hours", async () => {
    const user = userEvent.setup();
    const onUpdateNotificationPreferences = vi.fn();
    renderPanel({ onUpdateNotificationPreferences });
    await user.click(screen.getByRole("button", { name: /notification preferences/i }));
    expect(
      screen.getByRole("heading", { name: /notification preferences/i }),
    ).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText(/reminder delivery/i), "digest");
    expect(onUpdateNotificationPreferences).toHaveBeenCalledWith({
      rules: expect.arrayContaining([
        expect.objectContaining({ semanticType: "reminder", deliveryMode: "digest" }),
      ]),
    });
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
  });

  it("acknowledges and resets from the notification panel", async () => {
    const user = userEvent.setup();
    const onAckDigest = vi.fn();
    const onResetNotificationPreferences = vi.fn();
    renderPanel({
      digestItems: [{ id: "digest-1", title: "Digest reminder" } as HubItemListRow],
      onAckDigest,
      onResetNotificationPreferences,
    });
    await user.click(screen.getByRole("button", { name: /notification preferences/i }));
    expect(screen.getByText("Digest reminder")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /acknowledge digest/i }));
    expect(onAckDigest).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /reset notification preferences/i }));
    expect(onResetNotificationPreferences).toHaveBeenCalled();
  });
});
```

Run it — it fails (module does not exist yet):
`pnpm --filter @armyofagents/ui exec vitest run ui/src/components/inbox/__tests__/InboxSettingsPanel.test.tsx`

### 1b. Create the panel

Create `ui/src/components/inbox/InboxSettingsPanel.tsx`. Paste the JSX from
HubShell lines 397–747 verbatim into the panel body (the outer
`<div className="grid gap-3 border-b border-border bg-card px-4 py-3 text-xs">…</div>`),
move the four update-helpers and `semanticTypeLabel` in, and add the
`notificationPanelOpen` state. Props are exactly the settings props HubShell holds.

```tsx
import { useState } from "react";
import type {
  HubAutopilotAction,
  HubAutopilotMode,
  HubAutopilotPolicy,
  HubDensity,
  HubGroupMode,
  HubLane,
  HubPreferences,
  NotificationPreference,
  NotificationPreferences,
  UpdateHubAutopilotPolicyInput,
  UpdateHubPreferencesInput,
  UpdateNotificationPreferencesInput,
} from "@armyofagents/shared";
import {
  isFounderGatedAutopilotType,
  isInternalSemanticType,
} from "@armyofagents/shared";
import type { HubItemListRow } from "@/api/hub-items";
import { Button } from "@/components/ui/button";

export interface InboxSettingsPanelProps {
  preferences: HubPreferences;
  onPreferencesChange: (patch: UpdateHubPreferencesInput) => void;
  autopilotPolicy: HubAutopilotPolicy;
  autopilotPending?: boolean;
  onUpdateAutopilotPolicy: (patch: UpdateHubAutopilotPolicyInput) => void;
  onResetAutopilotPolicy: () => void;
  notificationPreferences: NotificationPreferences;
  notificationPreferencesPending?: boolean;
  onUpdateNotificationPreferences: (patch: UpdateNotificationPreferencesInput) => void;
  onResetNotificationPreferences: () => void;
  digestItems?: HubItemListRow[];
  onAckDigest: () => void;
}

export function InboxSettingsPanel({
  preferences,
  onPreferencesChange,
  autopilotPolicy,
  autopilotPending = false,
  onUpdateAutopilotPolicy,
  onResetAutopilotPolicy,
  notificationPreferences,
  notificationPreferencesPending = false,
  onUpdateNotificationPreferences,
  onResetNotificationPreferences,
  digestItems = [],
  onAckDigest,
}: InboxSettingsPanelProps) {
  const [notificationPanelOpen, setNotificationPanelOpen] = useState(false);

  const updateNotificationRule = (
    semanticType: NotificationPreferences["rules"][number]["semanticType"],
    patch: Partial<Pick<NotificationPreferences["rules"][number], "deliveryMode" | "toastEnabled">>,
  ) => {
    onUpdateNotificationPreferences({
      rules: notificationPreferences.rules.map((rule) =>
        rule.semanticType === semanticType ? { ...rule, ...patch } : rule,
      ),
    });
  };

  const updateQuietHours = (patch: Partial<NotificationPreferences["quietHours"]>) => {
    onUpdateNotificationPreferences({
      quietHours: { ...notificationPreferences.quietHours, ...patch },
    });
  };

  const updateDigest = (patch: Partial<NotificationPreferences["digest"]>) => {
    onUpdateNotificationPreferences({
      digest: { ...notificationPreferences.digest, ...patch },
    });
  };

  const updateAutopilotRule = (
    semanticType: HubAutopilotPolicy["rules"][number]["semanticType"],
    patch: Partial<
      Pick<HubAutopilotPolicy["rules"][number], "enabled" | "action" | "minTrustScore">
    >,
  ) => {
    onUpdateAutopilotPolicy({
      rules: autopilotPolicy.rules.map((rule) =>
        rule.semanticType === semanticType ? { ...rule, ...patch } : rule,
      ),
    });
  };

  return (
    <div className="grid gap-3 border-b border-border bg-card px-4 py-3 text-xs">
      {/* PASTE HubShell.tsx lines 398–746 here VERBATIM: the "Default landing" label
          through the closing </div> of the notification sub-panel. It references
          `preferences`, `onPreferencesChange`, `autopilotPolicy`, `autopilotPending`,
          `onUpdateAutopilotPolicy`, `onResetAutopilotPolicy`, `updateAutopilotRule`,
          `notificationPanelOpen`, `setNotificationPanelOpen`, `notificationPreferences`,
          `notificationPreferencesPending`, `updateNotificationRule`, `updateQuietHours`,
          `updateDigest`, `digestItems`, `onAckDigest`, `onResetNotificationPreferences`,
          `isFounderGatedAutopilotType`, `isInternalSemanticType`, `semanticTypeLabel`,
          `laneTitle`, `Button` — all now in scope. */}
    </div>
  );
}

/** `snake_case` → "Snake Case" for the founder-facing rule labels. */
function semanticTypeLabel(value: string) {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** Lane title used by the visible-lanes checkbox row. */
function laneTitle(lane: HubLane) {
  if (lane === "waiting_on_you") return "Waiting on you";
  if (lane === "notifications") return "Notifications";
  return "Suggestions";
}
```

> Note: HubShell's `laneTitle` accepts `HubLane | null`; the panel only ever maps
> the three concrete lanes, so the panel-local `laneTitle` narrows to `HubLane`.
> Keep HubShell's own `laneTitle` (it is still used for the list header).

### 1c. Wire the panel into HubShell (in place)

In `HubShell.tsx`, replace the inline settings JSX (lines 396–748,
`{settingsOpen ? (<div …>…</div>) : null}`) with:

```tsx
{settingsOpen ? (
  <InboxSettingsPanel
    preferences={preferences}
    onPreferencesChange={onPreferencesChange}
    autopilotPolicy={autopilotPolicy}
    autopilotPending={autopilotPending}
    onUpdateAutopilotPolicy={onUpdateAutopilotPolicy}
    onResetAutopilotPolicy={onResetAutopilotPolicy}
    notificationPreferences={notificationPreferences}
    notificationPreferencesPending={notificationPreferencesPending}
    onUpdateNotificationPreferences={onUpdateNotificationPreferences}
    onResetNotificationPreferences={onResetNotificationPreferences}
    digestItems={digestItems}
    onAckDigest={onAckDigest}
  />
) : null}
```

Add `import { InboxSettingsPanel } from "@/components/inbox/InboxSettingsPanel";`.
Delete the now-unused-in-HubShell helpers `updateNotificationRule`,
`updateQuietHours`, `updateDigest`, `updateAutopilotRule`, HubShell's
`notificationPanelOpen` state, and (only if no longer referenced) `semanticTypeLabel`.
Everything else (props, `settingsOpen`, gear) stays for now.

### 1d. Verify

- New panel test green (1a).
- `HubShell.test.tsx` still green (gear still present, DOM identical).
- `InboxHub.test.tsx` still green.
- Typecheck + lint clean.

### 1e. Mutation testing (kill list — target `InboxSettingsPanel.tsx`)

Follow the reusable procedure. Prove each mutation FAILS the panel test:
1. In the density `onChange`, change `{ density: event.target.value … }` →
   `{ groupMode: event.target.value … }` → the "emits a preferences patch when
   density changes" test must fail.
2. In the autopilot mode select `onChange`, change `mode: event.target.value` →
   a hard-coded `mode: "off"` → "updates and resets Autopilot mode" fails.
3. Delete the `.filter((rule) => !isFounderGatedAutopilotType(...))` guard so gated
   rules render an action combobox → "keeps founder-gated categories out" fails.
4. In `updateNotificationRule`, drop the `toastEnabled` spread (`...patch` → `{}`)
   → the toast assertion fails.
5. **Negative control:** anchor on `"THIS_STRING_IS_NOT_IN_THE_FILE"` → harness must
   report `DID-NOT-APPLY`.

Restore pristine, confirm green. Commit: `refactor(inbox): extract InboxSettingsPanel from HubShell (behaviour unchanged)`.

---

## Task 2 — Add explanatory helper text to each setting group

This is the "proper explanations" ask. Each group gains a one-sentence helper. Copy
lives inside the panel, so its tests are the panel suite.

### 2a. Failing test first

Append to `InboxSettingsPanel.test.tsx`:

```tsx
describe("InboxSettingsPanel explanations", () => {
  it("explains each setting group in plain language", async () => {
    const user = userEvent.setup();
    renderPanel();
    expect(
      screen.getByText(/which view opens when you land on the inbox/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/choose which lanes appear in the rail/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/how items are grouped in each lane/i)).toBeInTheDocument();
    expect(screen.getByText(/row height/i)).toBeInTheDocument();
    expect(
      screen.getByText(/let the hub act on items automatically/i),
    ).toBeInTheDocument();
    // The notification explanation lives inside the collapsible sub-panel.
    await user.click(screen.getByRole("button", { name: /notification preferences/i }));
    expect(
      screen.getByText(/how and when each kind of update reaches you/i),
    ).toBeInTheDocument();
  });
});
```

### 2b. Implement

Add a `<p className="text-[11px] text-muted-foreground">…</p>` (or reuse the existing
`text-muted-foreground` label style) directly under each group heading/label. Exact
copy the test asserts:

| Group | Helper sentence |
|-------|-----------------|
| Default landing | "Which view opens when you land on the Inbox." |
| Visible lanes | "Choose which lanes appear in the rail." |
| Grouping | "How items are grouped in each lane." |
| Density | "Row height — Comfortable for readability, Compact to fit more." |
| Autopilot entry / Autopilot | "Let the Hub act on items automatically within the limits you set." |
| Notification preferences (sub-panel) | "How and when each kind of update reaches you." |

Keep the terse labels as the control's accessible name; the helper sits beside them.

### 2c. Verify + mutation

- Panel suite green; HubShell + InboxHub suites still green (extra copy is additive).
- Mutation: delete one helper `<p>` → the matching explanation assertion fails.
  Negative control as before. Restore, confirm green.

Commit: `feat(inbox): explain each Inbox setting in the panel`.

---

## Task 3 — Create `InboxSection` and register it in Settings

`InboxSection` fetches the same four sources and owns the edit mutations (the
`ProvidersSection` self-contained pattern), rendering `InboxSettingsPanel` under a
GitHub-style header. Register it in the three coupled places.

### 3a. Failing tests first

Create `ui/src/components/settings/__tests__/InboxSection.test.tsx`. Mock
`@/api/hub-items` (like `InboxHub.test.tsx` does) and `@/context/CompanyContext`
(like `ProvidersSection.test.tsx` does).

```tsx
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SETTINGS_SECTIONS } from "../SettingsLayout";
import { VALID_SECTIONS } from "@/pages/SettingsPage";
import { InboxSection } from "../sections/InboxSection";
import { hubItemsApi } from "@/api/hub-items";

vi.mock("@/api/hub-items", () => ({
  hubItemsApi: {
    getPreferences: vi.fn(),
    updatePreferences: vi.fn(),
    autopilotPolicy: { get: vi.fn(), update: vi.fn(), reset: vi.fn() },
    notificationPreferences: { get: vi.fn(), update: vi.fn(), reset: vi.fn() },
    notificationDigest: { list: vi.fn(), ack: vi.fn() },
  },
}));

const COMPANY_ID = "company-1";
const useCompanyMock = vi.fn(() => ({ selectedCompanyId: COMPANY_ID as string | null }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => useCompanyMock() }));

function prefs() {
  return {
    defaultLanding: "home",
    visibleLanes: ["waiting_on_you", "notifications", "suggestions"],
    groupMode: "auto",
    density: "comfortable",
    showAutopilotEntry: true,
    updatedAt: null,
  };
}
function policy() {
  return {
    mode: "off",
    handledToday: 0,
    lastHandledAt: null,
    rules: [{ semanticType: "run_complete", action: "none", minTrustScore: 100, enabled: false }],
    updatedAt: null,
  };
}
function notif() {
  return {
    rules: [{ semanticType: "reminder", deliveryMode: "realtime", toastEnabled: true }],
    quietHours: { enabled: false, start: "18:00", end: "09:00", timezone: "UTC" },
    digest: { enabled: true, cadence: "daily" },
    updatedAt: null,
  };
}

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <InboxSection />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useCompanyMock.mockReturnValue({ selectedCompanyId: COMPANY_ID });
  vi.mocked(hubItemsApi.getPreferences).mockResolvedValue(prefs() as never);
  vi.mocked(hubItemsApi.updatePreferences).mockResolvedValue(prefs() as never);
  vi.mocked(hubItemsApi.autopilotPolicy.get).mockResolvedValue(policy() as never);
  vi.mocked(hubItemsApi.autopilotPolicy.update).mockResolvedValue(policy() as never);
  vi.mocked(hubItemsApi.autopilotPolicy.reset).mockResolvedValue(policy() as never);
  vi.mocked(hubItemsApi.notificationPreferences.get).mockResolvedValue(notif() as never);
  vi.mocked(hubItemsApi.notificationPreferences.update).mockResolvedValue(notif() as never);
  vi.mocked(hubItemsApi.notificationPreferences.reset).mockResolvedValue(notif() as never);
  vi.mocked(hubItemsApi.notificationDigest.list).mockResolvedValue({ items: [] } as never);
  vi.mocked(hubItemsApi.notificationDigest.ack).mockResolvedValue({ acked: 0 } as never);
});

describe("Settings -> Inbox registration", () => {
  it("registers an Inbox entry in the Operations group", () => {
    const ops = SETTINGS_SECTIONS.find((g) => g.group === "Operations");
    expect(ops?.items.map((i) => i.id)).toContain("inbox");
  });
  it("accepts every registered section id as a ?tab= value", () => {
    for (const group of SETTINGS_SECTIONS) {
      for (const item of group.items) {
        expect(VALID_SECTIONS).toContain(item.id);
      }
    }
  });
});

describe("InboxSection", () => {
  it("renders the settings panel with the fetched values", async () => {
    renderSection();
    expect(
      await screen.findByRole("combobox", { name: /default landing/i }),
    ).toHaveValue("home");
    expect(screen.getByRole("heading", { name: /^inbox/i })).toBeInTheDocument();
  });

  it("persists a density change through updatePreferences", async () => {
    const user = userEvent.setup();
    renderSection();
    await user.selectOptions(
      await screen.findByRole("combobox", { name: /density/i }),
      "compact",
    );
    await waitFor(() => {
      expect(hubItemsApi.updatePreferences).toHaveBeenCalledWith(COMPANY_ID, {
        density: "compact",
      });
    });
  });

  it("persists an autopilot mode change", async () => {
    const user = userEvent.setup();
    renderSection();
    await user.selectOptions(
      await screen.findByRole("combobox", { name: /autopilot mode/i }),
      "drive",
    );
    await waitFor(() => {
      expect(hubItemsApi.autopilotPolicy.update).toHaveBeenCalledWith(COMPANY_ID, {
        mode: "drive",
      });
    });
  });

  it("shows the company-selection guard when no company is selected", () => {
    useCompanyMock.mockReturnValue({ selectedCompanyId: null });
    renderSection();
    expect(screen.getByText(/select a company/i)).toBeInTheDocument();
    expect(hubItemsApi.getPreferences).not.toHaveBeenCalled();
  });
});
```

### 3b. Implement `InboxSection`

Create `ui/src/components/settings/sections/InboxSection.tsx`. Header follows
`GitHubSection` (eyebrow "Settings · Operations", `h2` "Inbox.", description).
Fetch/mutate follows `ProvidersSection` (company guard → keyed inner panel).

```tsx
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import type {
  HubAutopilotPolicy,
  HubPreferences,
  NotificationPreferences,
  UpdateHubAutopilotPolicyInput,
  UpdateHubPreferencesInput,
  UpdateNotificationPreferencesInput,
} from "@armyofagents/shared";
import { DEFAULT_NOTIFICATION_PREFERENCES } from "@armyofagents/shared";
import { useCompany } from "@/context/CompanyContext";
import { hubItemsApi } from "@/api/hub-items";
import { queryKeys } from "@/lib/queryKeys";
import { InboxSettingsPanel } from "@/components/inbox/InboxSettingsPanel";

const DEFAULT_PREFERENCES: HubPreferences = {
  defaultLanding: "home",
  visibleLanes: ["waiting_on_you", "notifications", "suggestions"],
  groupMode: "auto",
  density: "comfortable",
  showAutopilotEntry: true,
  updatedAt: null,
};
const DEFAULT_AUTOPILOT_POLICY: HubAutopilotPolicy = {
  mode: "off",
  handledToday: 0,
  lastHandledAt: null,
  rules: [],
  updatedAt: null,
};

export function InboxSection() {
  const { selectedCompanyId } = useCompany();
  if (!selectedCompanyId) {
    return (
      <div className="p-8">
        <p className="text-sm text-muted-foreground">Select a company to manage Inbox settings.</p>
      </div>
    );
  }
  return <InboxSettingsSection key={selectedCompanyId} companyId={selectedCompanyId} />;
}

function InboxSettingsSection({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();

  const preferencesQuery = useQuery({
    queryKey: queryKeys.hubItems.preferences(companyId),
    queryFn: () => hubItemsApi.getPreferences(companyId),
  });
  const autopilotQuery = useQuery({
    queryKey: queryKeys.hubItems.autopilotPolicy(companyId),
    queryFn: () => hubItemsApi.autopilotPolicy.get(companyId),
  });
  const notificationQuery = useQuery({
    queryKey: queryKeys.notifications.preferences(companyId),
    queryFn: () => hubItemsApi.notificationPreferences.get(companyId),
  });
  const digestQuery = useQuery({
    queryKey: queryKeys.notifications.digest(companyId),
    queryFn: () => hubItemsApi.notificationDigest.list(companyId),
  });

  const setPrefs = (data: HubPreferences) =>
    queryClient.setQueryData(queryKeys.hubItems.preferences(companyId), data);
  const setPolicy = (data: HubAutopilotPolicy) =>
    queryClient.setQueryData(queryKeys.hubItems.autopilotPolicy(companyId), data);
  const setNotif = (data: NotificationPreferences) =>
    queryClient.setQueryData(queryKeys.notifications.preferences(companyId), data);

  const updatePreferences = useMutation({
    mutationFn: (patch: UpdateHubPreferencesInput) => hubItemsApi.updatePreferences(companyId, patch),
    onSuccess: setPrefs,
  });
  const updateAutopilot = useMutation({
    mutationFn: (patch: UpdateHubAutopilotPolicyInput) =>
      hubItemsApi.autopilotPolicy.update(companyId, patch),
    onSuccess: setPolicy,
  });
  const resetAutopilot = useMutation({
    mutationFn: () => hubItemsApi.autopilotPolicy.reset(companyId),
    onSuccess: setPolicy,
  });
  const updateNotifications = useMutation({
    mutationFn: (patch: UpdateNotificationPreferencesInput) =>
      hubItemsApi.notificationPreferences.update(companyId, patch),
    onSuccess: setNotif,
  });
  const resetNotifications = useMutation({
    mutationFn: () => hubItemsApi.notificationPreferences.reset(companyId),
    onSuccess: setNotif,
  });
  const ackDigest = useMutation({
    mutationFn: () => hubItemsApi.notificationDigest.ack(companyId),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.notifications.digest(companyId) }),
  });

  return (
    <div data-testid="inbox-section">
      <div className="px-8 pt-6 pb-3 border-b border-border">
        <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground/60 font-semibold">
          Settings · Operations
        </div>
        <h2 className="text-[1.4rem] font-bold tracking-tight mt-1">
          Inbox<span className="text-brand">.</span>
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Control how the Inbox behaves — its default view, visible lanes, grouping,
          density, Autopilot, and how notifications reach you.
        </p>
      </div>
      <div className="p-8 max-w-[680px]">
        <InboxSettingsPanel
          preferences={preferencesQuery.data ?? DEFAULT_PREFERENCES}
          onPreferencesChange={(patch) => updatePreferences.mutate(patch)}
          autopilotPolicy={autopilotQuery.data ?? DEFAULT_AUTOPILOT_POLICY}
          autopilotPending={updateAutopilot.isPending || resetAutopilot.isPending}
          onUpdateAutopilotPolicy={(patch) => updateAutopilot.mutate(patch)}
          onResetAutopilotPolicy={() => resetAutopilot.mutate()}
          notificationPreferences={notificationQuery.data ?? DEFAULT_NOTIFICATION_PREFERENCES}
          notificationPreferencesPending={
            updateNotifications.isPending || resetNotifications.isPending || ackDigest.isPending
          }
          onUpdateNotificationPreferences={(patch) => updateNotifications.mutate(patch)}
          onResetNotificationPreferences={() => resetNotifications.mutate()}
          digestItems={digestQuery.data?.items ?? []}
          onAckDigest={() => ackDigest.mutate()}
        />
      </div>
    </div>
  );
}
```

> The section body wrapper (`p-8 max-w-[680px]`) sits *around* the panel's own
> `grid … border-b bg-card px-4 py-3 text-xs` wrapper. Acceptable for this move; a
> pure-visual polish (dropping the panel's hub-chrome border when embedded in
> Settings) is listed under Deferred.

### 3c. Register the section (three edits)

`ui/src/components/settings/SettingsLayout.tsx`:
- Line 4 import: add `Inbox` to the lucide import list.
- Line 10–13 union: add `| "inbox"` to `SettingsSectionId` (Operations group ⇒ append after the existing members, e.g. `… | "activity" | "environments" | "secrets" | "inbox"`).
- Operations group (lines 38–48): add
  `{ id: "inbox", label: "Inbox", icon: Inbox },` (place it first in Operations so
  it reads naturally).

`ui/src/pages/SettingsPage.tsx`:
- Import: `import { InboxSection } from "@/components/settings/sections/InboxSection";`
- `VALID_SECTIONS` (lines 27–30): add `"inbox"`.
- Switch (lines 42–84): add `case "inbox": return <InboxSection />;`. The `default`
  branch is a `never` exhaustiveness check, so a missing case is a compile error —
  typecheck confirms the union + switch agree.

### 3d. Verify + mutation

- `InboxSection.test.tsx` green; typecheck clean (exhaustiveness).
- Mutations against `InboxSection.tsx`:
  1. `onPreferencesChange={(patch) => updatePreferences.mutate(patch)}` → replace
     `patch` with `{}` → "persists a density change" fails.
  2. `onUpdateAutopilotPolicy` mutate `patch` → `{}` → "persists an autopilot mode
     change" fails.
  3. Change the `data-testid`/company-guard so `getPreferences` still runs when
     `selectedCompanyId` is null (remove the early return) → "shows the
     company-selection guard" fails.
  - Mutation against `SettingsLayout.tsx`: remove the `{ id: "inbox", … }` item →
    the registration test fails.
  - Negative control anchor. Restore, confirm green.

Commit: `feat(settings): add Settings -> Inbox section`.

---

## Task 4 — Remove the gear + inline panel + settings plumbing (RISKY)

Now delete the editing UI from the Inbox. **The precise cut list — what is safe to
remove vs. what stays — is the crux of this task.**

### 4a. HubShell.tsx — what STAYS (preference reads the hub renders with)

Do **not** remove these; the hub renders itself from them:
- Prop `preferences` (+ default `DEFAULT_PREFERENCES`, `HubPreferences` type). Read by
  `HubRail` (`visibleLanes`), `HubList` (`groupMode`, `density`), `HubHome`
  (`visibleLanes`, `showAutopilotEntry`), and the `laneTitle(activeLane)` list header.
- Prop `autopilotPolicy` (+ default `DEFAULT_AUTOPILOT_POLICY`, `HubAutopilotPolicy`
  type) — read by `HubHome`.
- Prop `autopilotActions` (+ `EMPTY_AUTOPILOT_ACTIONS`) — read by `HubHome`.
- Prop `onUndoAutopilotAction` — read by `HubHome`.
- `onLaneChange`, `HubLane` type (cast in the `HubHome` `onLaneChange`), all list /
  tab / lifecycle props, the `laneTitle` module fn, `semanticTypeLabel` **only if**
  still referenced (it is not, once the panel owns its copy — remove it from
  HubShell).

### 4b. HubShell.tsx — what to REMOVE (settings-editing only)

- The gear `<Button aria-label="Hub settings" …>` (lines 384–393) and the
  `{settingsOpen ? <InboxSettingsPanel … /> : null}` block (Task 1 slot).
- `const [settingsOpen, setSettingsOpen] = useState(false);` (line 197).
- Props + their defaults + destructuring: `notificationPreferences`,
  `notificationPreferencesPending`, `digestItems`, `autopilotPending`,
  `onPreferencesChange`, `onUpdateNotificationPreferences`,
  `onResetNotificationPreferences`, `onAckDigest`, `onUpdateAutopilotPolicy`,
  `onResetAutopilotPolicy`.
- The `InboxSettingsPanel` import (no longer rendered by HubShell).
- Now-unused imports: `Settings` (from lucide, line 1);
  `DEFAULT_NOTIFICATION_PREFERENCES`, `isFounderGatedAutopilotType`,
  `isInternalSemanticType` (lines 24–27); type-only imports that go unused
  (`HubAutopilotAction`, `HubAutopilotMode`, `HubDensity`, `HubGroupMode`,
  `NotificationPreference`, `NotificationPreferences`,
  `UpdateNotificationPreferencesInput`, `UpdateHubAutopilotPolicyInput`,
  `UpdateHubPreferencesInput`). **Verify each against the final file** — keep any that
  a surviving prop still references. Lint (`no-unused-vars`) is the backstop; run it.

The gear lived in the list header's right-side `<div className="flex shrink-0 gap-1">`
(lines 369–394). After removing the gear button, that div keeps the history-status
buttons (`open`/`resolved`/`archived`); leave it.

### 4c. HubShell.test.tsx — delete/repurpose the six gear tests

Delete (their coverage now lives in `InboxSettingsPanel.test.tsx`):
- "renders preference controls"
- "updates and resets Autopilot mode from hub settings"
- "prevents founder-gated categories from being configured for auto-handle"
- "opens notification preferences from hub settings and shows digest summary"
- "changes notification delivery, toast, and quiet-hours preferences"

Repurpose "keeps Home list controls reachable on mobile" (it clicked the gear then
opened lanes): drop the gear/`default landing` assertions, keep only the mobile lane
drawer open on Home:
```tsx
it("keeps the Home lane drawer reachable on mobile", async () => {
  const user = userEvent.setup();
  renderShell({
    activeLane: null,
    homeItems: [{ ...items[0], id: "home-mobile-1", title: "Home mobile queue" }],
    tabs: [HOME_TAB],
    activeTabKey: "home",
  });
  await user.click(screen.getByRole("button", { name: /open hub lanes/i }));
  expect(screen.getByRole("dialog", { name: /hub lanes/i })).toBeInTheDocument();
});
```
Also remove the now-unused `notificationPreferences`/`autopilotPolicy`/
`autopilotActions` fixture helpers **only if** no surviving test references them
(the Home autopilot test still uses `autopilotPolicy`/`autopilotActions` — keep those;
`notificationPreferences` becomes unused — remove it and its import usages).
Assert no `hub settings` button anywhere:
```tsx
it("no longer renders a hub settings gear (settings live in Settings -> Inbox)", () => {
  renderShell();
  expect(screen.queryByRole("button", { name: /hub settings/i })).toBeNull();
});
```

### 4d. InboxHub.tsx — what STAYS vs what to REMOVE

**STAYS (reads):**
- `preferencesQuery` + `serverPreferences`/`preferences` (line 227–235) — drives the
  rail/list/home + the default-landing redirect effect (452–462) + the hidden-lane
  redirect. **But** `optimisticPreferences` state (178) and its use in
  `preferences = optimisticPreferences ?? serverPreferences` (235) go away — set
  `const preferences = serverPreferences;`.
- `notificationPreferencesQuery` + `notificationPreferencesRef` (237–245, 271–273) —
  the toast bridge (`shouldToastHubItem`) needs it. KEEP.
- `autopilotPolicyQuery`, `autopilotActionsQuery` (255–269) — HubHome display. KEEP.
- `handleUndoAutopilotAction` (874–892) + `refreshAutopilotDashboard`. KEEP.
- Everything for list/counts/home-preview/hidden/deep-link/bulk/lifecycle. KEEP.

**REMOVE (editing — moved to InboxSection):**
- `optimisticPreferences` state (178) + `setOptimisticPreferences` usages.
- `updatePreferences` mutation (297–334) and `handlePreferencesChange` (800–806).
  The lane-hide navigation it did is already covered by the standing effect at
  452–462 (`if (!preferences.visibleLanes.includes(activeLane)) navigate("/inbox")`),
  which fires when the user edits in Settings and returns.
- `updateNotificationPreferences` (336–370), `resetNotificationPreferences`
  (372–387) mutations.
- `updateAutopilotPolicy` (389–414), `resetAutopilotPolicy` (416–440) mutations.
- `ackNotificationDigest` mutation (442–450) **and** `notificationDigestQuery`
  (247–253) — digest items were panel-only.
- The HubShell props that no longer exist (see 4b): `onPreferencesChange`,
  `onUpdateNotificationPreferences`, `onResetNotificationPreferences`, `onAckDigest`,
  `onUpdateAutopilotPolicy`, `onResetAutopilotPolicy`, `notificationPreferences`,
  `notificationPreferencesPending`, `digestItems`, `autopilotPending` (lines 961–992).
- Prune now-unused imports: `UpdateHubPreferencesInput`,
  `UpdateHubAutopilotPolicyInput`, `UpdateNotificationPreferencesInput` types (if no
  longer referenced), and `useMutation` **only if** no mutation remains — `markRead`,
  `hubMutations`, etc. still use mutations, so `useMutation` likely stays. Lint is the
  backstop.

> Guard: `notificationPreferences` (the value from `notificationPreferencesQuery`) is
> still computed for the toast bridge — do not delete the query, only stop passing it
> to HubShell. `DEFAULT_NOTIFICATION_PREFERENCES` import stays (toast bridge default).

### 4e. InboxHub.test.tsx — delete the four gear tests

Delete (re-homed under `InboxSection.test.tsx`):
- "updates notification preferences from hub settings"
- "updates Autopilot policy from hub settings"
- "acknowledges pending digest items from hub settings"
- "optimistically applies hub preference lane visibility changes"

The last one asserted the rail reacts to a visible-lanes toggle. Its editing path is
gone; the rail-read behaviour is still covered by `HubShell.test.tsx`
"hides lanes excluded by preferences". Remove the mock expectations for
`updatePreferences`/`notificationPreferences.update`/`autopilotPolicy.update`/
`notificationDigest.ack` from the surviving assertions only where they were the
subject — the `beforeEach` mock setup can stay (harmless).

### 4f. Verify + mutation

- Full UI suite green: `pnpm --filter @armyofagents/ui test`.
- Typecheck + lint clean (this is where dangling imports/props surface).
- Build clean.
- Mutations:
  1. In `InboxHub.tsx`, re-add a stray `onPreferencesChange={…}` referencing a
     deleted symbol → typecheck fails (proves the prop is truly gone from HubShell).
  2. In `HubShell.tsx`, re-introduce the gear `<Button aria-label="Hub settings">` →
     the new "no longer renders a hub settings gear" test fails.
  3. Negative control anchor → `DID-NOT-APPLY`. Restore, confirm green.

Commit: `feat(inbox): remove the hub settings gear; settings now live in Settings -> Inbox`.

---

## Task 5 — Full suite + typecheck + build + live pass

1. `pnpm --filter @armyofagents/ui test` (full UI suite green; ignore the known
   `LobbySidebar.test.tsx` flake, re-run once if it trips).
2. `pnpm --filter @armyofagents/ui exec tsc -p tsconfig.json --noEmit` (clean).
3. `pnpm --filter @armyofagents/ui lint` (no unused imports/vars).
4. `pnpm --filter @armyofagents/ui build` (clean).
5. **Live pass** — boot the instance per the provider-readiness runbook from this
   worktree (short path avoids the OneDrive MAX_PATH initdb failure): `pnpm install`
   if needed, then `pnpm dev` (`scripts/dev-runner.mjs watch`) with the instance env
   (`AOA_HOME`, `PORT`, `AOA_EMBEDDED_POSTGRES_PORT`). Confirm, in `local_trusted`
   (no auth):
   - Settings → **Inbox** appears in the Operations group and shows the panel with
     each setting's explanatory sentence.
   - Changing a setting (density, autopilot mode, a notification delivery) persists —
     reload the page and the new value survives (server round-trip).
   - The **Inbox has no gear** and no inline settings panel.
   - The Inbox hub still renders with the user's grouping / visible lanes / density /
     default landing, and Home still shows Autopilot status. Change density in
     Settings → Inbox, go to the Inbox, confirm the list reflects it.

---

## Self-Review

- **Spec coverage.**
  - Locked #1 (name "Inbox"): SettingsLayout item label + `h2` "Inbox." — Task 3.
  - Locked #2 (gear removed, single home): gear + `settingsOpen` + panel deleted from
    HubShell, editing plumbing deleted from InboxHub — Task 4; no mirror created.
  - Locked #3 (explanations): per-group helper sentences — Task 2, asserted by test.
  - Reads that must stay: enumerated explicitly in 4a/4d and guarded by mutation #1/#2.
- **Type consistency.** `InboxSettingsPanelProps` is a real source type
  (`ui/tsconfig.json` excludes tests, so the contract must live in source — it does).
  The `SettingsSectionId` union + `SettingsPage` switch `never` check force the new
  section to be wired in both places or fail typecheck.
- **Placeholder scan.** The only placeholder is the explicit "PASTE lines 398–746
  verbatim" marker in Task 1b — a deliberate copy instruction, not shipped code. Every
  other code block is complete (real JSX, real props, real imports). No `TODO`/`FIXME`.
- **Line references.** Anchors cited against `HubShell.tsx` (gear 384–393, panel
  396–748, `settingsOpen` 197, helpers 314/325/331/337, `semanticTypeLabel` 984–989),
  `InboxHub.tsx` (mutations 297/336/372/389/416/442, digest query 247, optimistic 178,
  props 960–992), `SettingsLayout.tsx` (union 10–13, Operations 38–48, icon import 4),
  `SettingsPage.tsx` (VALID_SECTIONS 27–30, switch 42–84) — all verified at HEAD
  `b2b271779`; re-grep before editing as they shift with each commit.

## Deferred

- Visual polish: drop the panel's hub-chrome outer styling
  (`border-b bg-card px-4 py-3 text-xs`) when embedded in Settings (a `variant` prop or
  a wrapper-less body), so it reads as a native settings panel rather than a lifted
  hub tray. Cosmetic; out of scope for the move.
- A Settings → Inbox deep-link entry point from the Inbox (e.g. a small "Inbox
  settings" link in an empty state) — the gear removal is intentional per Locked #2, so
  any re-entry affordance is a separate design decision.
- Consolidating the duplicated read-queries between `InboxHub` and `InboxSection` into a
  shared `useHubPreferences` hook — both pages read the same `queryKeys`, so react-query
  already dedupes at runtime; a hook is a tidiness-only refactor.

---

## Review corrections (2026-07-21) — these OVERRIDE the task text where they conflict

Independent review verdict: **SOUND — proceed, no P1s.** The four correctness cruxes hold (STAY/REMOVE prop split, surviving read-queries, section wiring, registration). Apply these three P2 fixes while building:

**C1 — `InboxHub.tsx`: DELETE the dead `notificationPreferences` const + import (the plan's "KEEP 237–245 / DEFAULT_NOTIFICATION_PREFERENCES stays" is WRONG for this file).** The toast bridge reads `notificationPreferencesRef.current` (set at ~272 with `?? null`), NOT the derived const (244–245) and NOT the default. Once the HubShell `notificationPreferences` prop is removed (Task 4), the const at 244–245 is its only remaining reader and `DEFAULT_NOTIFICATION_PREFERENCES` becomes fully unused **in `InboxHub.tsx`**. So in Task 4: delete the `notificationPreferences` const (244–245) AND the `DEFAULT_NOTIFICATION_PREFERENCES` import from `InboxHub.tsx`. (The NEW `InboxSection.tsx` keeps its own `DEFAULT_NOTIFICATION_PREFERENCES` import — it needs the fetch default. This correction is InboxHub.tsx only.)

**C2 — Prune the 7 now-unused HubShell imports in TASK 1, not Task 4.** After Task 1c moves the settings JSX into the panel, these HubShell imports have zero remaining references and ESLint `no-unused-vars` (the plan's own backstop) will fail, so Task 1d cannot be "lint clean" as written: `isFounderGatedAutopilotType`, `isInternalSemanticType`, and the five enum casts `HubAutopilotAction`, `HubAutopilotMode`, `HubDensity`, `HubGroupMode`, `NotificationPreference`. Remove all seven in Task 1. KEEP through Task 1 (they're still used by the gear + a prop default until Task 4): `Settings` and `DEFAULT_NOTIFICATION_PREFERENCES`. Task 4b's import list then just confirms these seven are already gone. (`tsc` stays green either way — `strict` does not enable `noUnusedLocals` — so lint is the real gate; run it.)

**C3 — Add two InboxSection wiring tests (Task 3a) + two mutations (Task 3d).** The InboxSection suite currently only asserts section→API wiring for density + autopilot mode, so a miswired `onUpdateNotificationPreferences` / `onAckDigest` in `InboxSection` would ship green (Task 1a only spies the panel callbacks with `vi.fn()`). Add to `InboxSection.test.tsx`: (a) changing a notification delivery setting calls `hubItemsApi.notificationPreferences.update` with `COMPANY_ID`; (b) acknowledging a digest item calls `hubItemsApi.notificationDigest.ack` (or the exact method the plan wires) with `COMPANY_ID`. Add the matching two mutations to Task 3d's kill-list (break each call target → the new test fails).

No other changes. Proceed task-by-task, one implementer at a time (shared-worktree full-suite interference lesson).
