# Plugin Capability Consent Dialog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show users a human-readable list of permissions a plugin requests at install time, and require explicit consent before proceeding. UI-side only — backend capability enforcement is out of scope for this PR.

**Architecture:** Add a `CAPABILITY_DESCRIPTIONS` map to `@armyofagents/shared`, create a `CapabilityConsentStep` component that renders the list + consent checkbox, and wire it into `PluginInstallModal` as a pre-install gate. The Install button stays disabled until the user checks the consent box.

**Tech Stack:** React, TypeScript, Tailwind CSS, Vitest, React Testing Library

---

## File Map

| File | Change |
|------|--------|
| `packages/shared/src/constants.ts` | Add `CAPABILITY_DESCRIPTIONS` map (42 entries) |
| `ui/src/components/marketplace/install/CapabilityConsentStep.tsx` | **New** — list + checkbox component |
| `ui/src/components/marketplace/install/PluginInstallModal.tsx` | Wire in consent step; gate Install button |
| `ui/src/components/marketplace/install/__tests__/CapabilityConsentStep.test.tsx` | **New** — unit tests |
| `ui/src/components/marketplace/install/__tests__/PluginInstallModal.test.tsx` | Add consent-gate integration tests |

---

## Task 1: Add `CAPABILITY_DESCRIPTIONS` to shared constants

**Files:**
- Modify: `packages/shared/src/constants.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/__tests__/constants.test.ts` (or append to an existing constants test if one exists):

```ts
import { describe, it, expect } from "vitest";
import { PLUGIN_CAPABILITIES, CAPABILITY_DESCRIPTIONS } from "../constants.js";

describe("CAPABILITY_DESCRIPTIONS", () => {
  it("has a description for every capability in PLUGIN_CAPABILITIES", () => {
    for (const cap of PLUGIN_CAPABILITIES) {
      expect(CAPABILITY_DESCRIPTIONS[cap], `Missing description for ${cap}`).toBeTruthy();
    }
  });

  it("has no descriptions for capabilities not in PLUGIN_CAPABILITIES", () => {
    const capSet = new Set<string>(PLUGIN_CAPABILITIES);
    for (const key of Object.keys(CAPABILITY_DESCRIPTIONS)) {
      expect(capSet.has(key), `Extra description key: ${key}`).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd packages/shared && pnpm test
```
Expected: import error — `CAPABILITY_DESCRIPTIONS` is not exported.

- [ ] **Step 3: Add CAPABILITY_DESCRIPTIONS to constants.ts**

After the `PLUGIN_CAPABILITIES` array, add:

```ts
export const CAPABILITY_DESCRIPTIONS: Record<PluginCapability, string> = {
  // Data read
  "companies.read":             "Read your organization's company profile",
  "projects.read":              "Read departments and projects",
  "project.workspaces.read":    "Read workspace data for software projects",
  "issues.read":                "Read tasks and issues",
  "issue.comments.read":        "Read comments on tasks",
  "issue.documents.read":       "Read documents and attachments on tasks",
  "agents.read":                "Read agent profiles and configuration",
  "goals.read":                 "Read goals and their status",
  "activity.read":              "Read the activity history log",
  "costs.read":                 "Read budget and cost records",
  // Data write
  "issues.create":              "Create new tasks on your behalf",
  "issues.update":              "Update existing tasks on your behalf",
  "issue.comments.create":      "Post comments on tasks",
  "issue.documents.write":      "Write documents and attachments to tasks",
  "activity.log.write":         "Write entries to the activity log",
  "metrics.write":              "Record custom performance metrics",
  "telemetry.track":            "Send anonymous usage events to the plugin developer",
  // Plugin state
  "plugin.state.read":          "Read this plugin's private persistent data",
  "plugin.state.write":         "Write to this plugin's private persistent data",
  // Integration
  "events.subscribe":           "Listen to system events (task updates, agent completions, etc.)",
  "events.emit":                "Broadcast custom events to other installed plugins",
  "jobs.schedule":              "Schedule recurring background jobs",
  "webhooks.receive":           "Receive inbound webhooks from external services (e.g. GitHub, Stripe)",
  "http.outbound":              "Make outbound HTTP requests to external URLs",
  "secrets.read-ref":           "Read references to secrets stored in the vault (values are never exposed)",
  // Agent tools
  "agent.tools.register":       "Register custom tools that your agents can call",
  // Agent control
  "agents.pause":               "Pause running agents",
  "agents.resume":              "Resume paused agents",
  "agents.invoke":              "Invoke agents programmatically",
  "agent.sessions.create":      "Create new agent chat sessions",
  "agent.sessions.list":        "List existing agent sessions",
  "agent.sessions.send":        "Send messages into agent sessions",
  "agent.sessions.close":       "Close agent sessions",
  // Goals
  "goals.create":               "Create new goals",
  "goals.update":               "Update existing goals",
  // UI
  "ui.sidebar.register":        "Add navigation items to the sidebar",
  "ui.page.register":           "Register custom full-page views",
  "ui.detailTab.register":      "Add tabs to task or entity detail panels",
  "ui.dashboardWidget.register":"Add widgets to the Home dashboard",
  "ui.commentAnnotation.register":"Add inline annotations inside comments",
  "ui.action.register":         "Register contextual action buttons",
  // Instance
  "instance.settings.register": "Add configuration panels to Instance Settings",
};
```

- [ ] **Step 4: Run test to confirm it passes**

```bash
cd packages/shared && pnpm test
```
Expected: 2 tests pass.

- [ ] **Step 5: Run typecheck**

```bash
cd packages/shared && pnpm tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/constants.ts packages/shared/src/__tests__/constants.test.ts
git commit -m "feat: add CAPABILITY_DESCRIPTIONS map to shared constants"
```

---

## Task 2: Create the CapabilityConsentStep component

**Files:**
- Create: `ui/src/components/marketplace/install/CapabilityConsentStep.tsx`
- Create: `ui/src/components/marketplace/install/__tests__/CapabilityConsentStep.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `ui/src/components/marketplace/install/__tests__/CapabilityConsentStep.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CapabilityConsentStep } from "../CapabilityConsentStep";

const CAPS = ["issues.read", "http.outbound"] as const;

describe("CapabilityConsentStep", () => {
  it("renders human-readable descriptions for each capability", () => {
    render(
      <CapabilityConsentStep
        pluginName="My Plugin"
        capabilities={[...CAPS]}
        agreed={false}
        onAgreedChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/Read tasks and issues/i)).toBeInTheDocument();
    expect(screen.getByText(/Make outbound HTTP requests/i)).toBeInTheDocument();
  });

  it("renders the consent checkbox unchecked by default", () => {
    render(
      <CapabilityConsentStep
        pluginName="My Plugin"
        capabilities={[...CAPS]}
        agreed={false}
        onAgreedChange={vi.fn()}
      />,
    );
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).not.toBeChecked();
  });

  it("calls onAgreedChange(true) when checkbox is checked", async () => {
    const onAgreedChange = vi.fn();
    render(
      <CapabilityConsentStep
        pluginName="My Plugin"
        capabilities={[...CAPS]}
        agreed={false}
        onAgreedChange={onAgreedChange}
      />,
    );
    await userEvent.click(screen.getByRole("checkbox"));
    expect(onAgreedChange).toHaveBeenCalledWith(true);
  });

  it("renders 'No special permissions' when capabilities is empty", () => {
    render(
      <CapabilityConsentStep
        pluginName="My Plugin"
        capabilities={[]}
        agreed={false}
        onAgreedChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/No special permissions/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd ui && pnpm test src/components/marketplace/install/__tests__/CapabilityConsentStep.test.tsx
```
Expected: import error — file does not exist.

- [ ] **Step 3: Create CapabilityConsentStep.tsx**

Create `ui/src/components/marketplace/install/CapabilityConsentStep.tsx`:

```tsx
import { CAPABILITY_DESCRIPTIONS } from "@armyofagents/shared";
import type { PluginCapability } from "@armyofagents/shared";

interface Props {
  pluginName: string;
  capabilities: PluginCapability[];
  agreed: boolean;
  onAgreedChange: (agreed: boolean) => void;
}

export function CapabilityConsentStep({ pluginName, capabilities, agreed, onAgreedChange }: Props) {
  if (capabilities.length === 0) {
    return (
      <div className="space-y-4">
        <p className="text-xs text-zinc-400">
          <span className="font-semibold text-zinc-200">{pluginName}</span> requests no special
          permissions.
        </p>
        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(e) => onAgreedChange(e.target.checked)}
            className="mt-0.5 accent-indigo-500"
          />
          <span className="text-xs text-zinc-400">
            No special permissions required — I understand what this plugin can access.
          </span>
        </label>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs text-zinc-400 mb-2">
          <span className="font-semibold text-zinc-200">{pluginName}</span> requests the following
          permissions:
        </p>
        <ul className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
          {capabilities.map((cap) => (
            <li key={cap} className="flex items-start gap-2">
              <span className="mt-0.5 text-amber-400 shrink-0">•</span>
              <div>
                <div className="text-xs font-mono text-zinc-500">{cap}</div>
                <div className="text-xs text-zinc-300">
                  {CAPABILITY_DESCRIPTIONS[cap] ?? cap}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <label className="flex items-start gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={agreed}
          onChange={(e) => onAgreedChange(e.target.checked)}
          className="mt-0.5 accent-indigo-500"
        />
        <span className="text-xs text-zinc-400">
          I understand and agree to grant these permissions to{" "}
          <span className="text-zinc-200 font-semibold">{pluginName}</span>.
        </span>
      </label>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd ui && pnpm test src/components/marketplace/install/__tests__/CapabilityConsentStep.test.tsx
```
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/marketplace/install/CapabilityConsentStep.tsx ui/src/components/marketplace/install/__tests__/CapabilityConsentStep.test.tsx
git commit -m "feat: add CapabilityConsentStep component for plugin install"
```

---

## Task 3: Wire CapabilityConsentStep into PluginInstallModal

**Files:**
- Modify: `ui/src/components/marketplace/install/PluginInstallModal.tsx`
- Modify: `ui/src/components/marketplace/install/__tests__/PluginInstallModal.test.tsx`

The install modal's flow after this change:
1. Modal opens with plugin details
2. If plugin has declared capabilities → show `CapabilityConsentStep`, Install button disabled
3. User checks consent → Install button enabled
4. User clicks Install → existing install logic runs

- [ ] **Step 1: Read PluginInstallModal.tsx to understand current structure**

```bash
cat ui/src/components/marketplace/install/PluginInstallModal.tsx | head -100
```

Identify:
- Where the Install button is rendered
- What prop drives the install action (likely `onInstall` or a mutation call)
- Where `catalogItem.capabilities` or `manifest.capabilities` is available

- [ ] **Step 2: Write the failing tests**

Append to `ui/src/components/marketplace/install/__tests__/PluginInstallModal.test.tsx`:

```tsx
describe("PluginInstallModal — capability consent gate", () => {
  it("disables Install button when capabilities are present and not yet agreed", () => {
    // Render with a catalog item that declares capabilities
    // The item's `capabilities` field is an array of PluginCapability strings
    // Assert the Install button has disabled attribute
    render(
      <PluginInstallModal
        item={{
          id: "item-1",
          name: "Test Plugin",
          capabilities: ["http.outbound", "issues.read"],
          // ... other required props with defaults
        }}
        open={true}
        onClose={vi.fn()}
      />,
    );
    const installBtn = screen.getByRole("button", { name: /install/i });
    expect(installBtn).toBeDisabled();
  });

  it("enables Install button after user checks the consent checkbox", async () => {
    render(
      <PluginInstallModal
        item={{
          id: "item-1",
          name: "Test Plugin",
          capabilities: ["http.outbound"],
        }}
        open={true}
        onClose={vi.fn()}
      />,
    );
    const checkbox = screen.getByRole("checkbox");
    await userEvent.click(checkbox);
    const installBtn = screen.getByRole("button", { name: /install/i });
    expect(installBtn).not.toBeDisabled();
  });

  it("enables Install button immediately when plugin declares no capabilities", () => {
    render(
      <PluginInstallModal
        item={{ id: "item-1", name: "Test Plugin", capabilities: [] }}
        open={true}
        onClose={vi.fn()}
      />,
    );
    // No checkbox shown; Install button is enabled from the start
    const installBtn = screen.getByRole("button", { name: /install/i });
    expect(installBtn).not.toBeDisabled();
  });
});
```

**Note:** Adjust prop shapes to match the actual `PluginInstallModal` props interface — read the file first. The tests above are written to the logical shape; adapt as needed.

- [ ] **Step 3: Run to confirm failure**

```bash
cd ui && pnpm test src/components/marketplace/install/__tests__/PluginInstallModal.test.tsx
```
Expected: the consent-gate tests fail (button is not disabled yet).

- [ ] **Step 4: Add consent state to PluginInstallModal**

In `PluginInstallModal.tsx`:

1. Add import:
```ts
import { CapabilityConsentStep } from "./CapabilityConsentStep.js";
import type { PluginCapability } from "@armyofagents/shared";
```

2. Add state:
```ts
const capabilities = (item.capabilities ?? []) as PluginCapability[];
const [capabilitiesAgreed, setCapabilitiesAgreed] = useState(capabilities.length === 0);
```

3. In the modal body, render `CapabilityConsentStep` before the Install button section:
```tsx
{!isInstalling && (
  <CapabilityConsentStep
    pluginName={item.name}
    capabilities={capabilities}
    agreed={capabilitiesAgreed}
    onAgreedChange={setCapabilitiesAgreed}
  />
)}
```

4. Add `disabled={!capabilitiesAgreed}` to the Install button:
```tsx
<button
  type="button"
  onClick={handleInstall}
  disabled={!capabilitiesAgreed || mutation.isPending}
  className="..."
>
  Install
</button>
```

- [ ] **Step 5: Run tests to confirm they pass**

```bash
cd ui && pnpm test src/components/marketplace/install/__tests__/PluginInstallModal.test.tsx
```
Expected: all tests pass including the new consent-gate tests.

- [ ] **Step 6: Run full UI test suite**

```bash
cd ui && pnpm test
```
Expected: no regressions.

- [ ] **Step 7: Commit**

```bash
git add ui/src/components/marketplace/install/PluginInstallModal.tsx ui/src/components/marketplace/install/__tests__/PluginInstallModal.test.tsx
git commit -m "feat: gate plugin install on capability consent checkbox"
```

---

## Self-Review Checklist

- [ ] `CAPABILITY_DESCRIPTIONS` covers all 42 entries in `PLUGIN_CAPABILITIES` — enforced by test
- [ ] `CapabilityConsentStep` renders correctly for 0 capabilities and N capabilities
- [ ] Install button is disabled until checkbox is checked (when capabilities.length > 0)
- [ ] Install button is enabled immediately when capabilities.length === 0
- [ ] Consent checkbox resets if modal is closed and reopened (`useState` re-initializes)
- [ ] No backend enforcement in this PR — deferred to a later PR
- [ ] Typecheck clean, all tests green
