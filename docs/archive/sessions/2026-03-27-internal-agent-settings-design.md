# Internal Agent Settings Page & Budget Integration

**Date:** 2026-03-27
**Spec refs:** v2_5_discussions_and_agent_tasks.md (T20, T21), v2_5_discussions_and_agent_api_contract.md (2.5–2.7), v2_5_discussions_and_agent_env.md

## Overview

Dedicated settings sub-page for configuring the internal agent, plus budget integration into the existing Budget section on the main Settings page.

## Page Structure

**New route:** `/settings/internal-agent`
**New files:**
- `ui/src/pages/InternalAgentSettingsPage.tsx` — page component
- `ui/src/api/internal-agent.ts` — API client
- `ui/src/__tests__/InternalAgentSettingsPage.test.tsx` — tests

**Navigation:** Link from the main SettingsPage to the sub-page.

**API layer** (`ui/src/api/internal-agent.ts`):
- `getConfig(companyId)` → `GET /api/companies/:companyId/internal-agent/config`
- `updateConfig(companyId, patch)` → `PATCH /api/companies/:companyId/internal-agent/config`
- `getRuns(companyId, params?)` → `GET /api/companies/:companyId/internal-agent/runs`
- `testConnection(companyId)` → `POST /api/companies/:companyId/internal-agent/test-connection`

## Page Layout — 4 Collapsible Sections

### Section 1: Execution & Model

- **Execution mode:** Two-option segmented control (API / CLI). Switching shows/hides relevant fields.
- **API mode:**
  - Provider dropdown: Anthropic, OpenAI, Google
  - Model dropdown: Uses `AGENT_MODELS_BY_PROVIDER` shared constant (Anthropic → claude-sonnet-4-6, claude-haiku-4-5; OpenAI → gpt-4o, gpt-4o-mini; Google → gemini-2.0-flash, gemini-2.5-pro). Adding models only requires updating the constant.
  - Link: "Configure API keys in LLM Providers settings" (no duplicate key management)
- **CLI mode:**
  - CLI tool dropdown: Claude CLI, Codex, OpenCode
- **Autonomy level:** Disabled dropdown locked to "Level 0 — Full Approval" with tooltip "Higher levels available in V3"
- **Test connection button:** Calls `POST /api/companies/:companyId/internal-agent/test-connection`. Backend reads the saved config (provider, model, API key from company_secrets) and makes a minimal LLM call (e.g., "respond with ok"). Returns `{ success: true }` or `{ success: false, error: "..." }`. Button shows loading spinner while testing. Status badge: Connected (green) / Failed with error message (red) / Not tested (grey). API client method: `testConnection(companyId)`.
- **Save behavior:** Explicit "Save" button. Changes are not auto-saved. Success/error toast on save. Validation errors (e.g., "Autonomy levels 1-3 not available") shown as toast with the server error message.

### Section 2: Capabilities & Preferences

- **Enabled capabilities:** 12 checkboxes in a grid, grouped:
  - Core: discussion_processing, organizational_queries, system_actions
  - Intelligence: proactive_suggestions, context_briefing, memory_management, conflict_detection
  - Operations: budget_awareness, workflow_coaching, workflow_discovery
  - Coordination: cross_department_coordination, department_personas
  - "Select All / Deselect All" toggle at top
- **Notification preference:** Three-option radio group — Silent, Digest, Real-time. Short description under each option.
- **Context token budget:** Dropdown — Compact (4,000), Standard (8,000), Large (16,000)

### Section 3: Budget & Spend

- **Monthly budget:** Dollar input with `$` prefix. Stored as cents in DB, converted in the component using `value / 100` for display and `value * 100` for save (same pattern as existing `formatCents()` utility).
- **Current spend:** Progress bar showing `spentMonthlyCents / budgetMonthlyCents`.
  - Colors: green (<70%), yellow (70–89%), red (≥90%)
  - Text: "$12.34 / $50.00 (24.7%)"
- **Warning indicators:** Yellow badge at 80%, red badge + "Agent paused" label at 100%.

### Section 4: Run History

- **Collapsible, closed by default.**
- **Aggregates** at top: total runs, total cost, avg duration, failure rate
- **Table columns:** Trigger type, Status (color-coded), Cost (dollars), Duration (human-readable), Date (relative)
- **Pagination:** limit=20, "Load more" button
- **API:** `GET /runs` with aggregates in response

## Budget Integration (Existing BudgetSection)

Update the `BudgetSection` in `SettingsPage.tsx`:
- Add a separate React Query call to `internalAgentApi.getConfig(companyId)` alongside the existing `costsApi` calls
- Render "Internal Agent" as a new line item after the per-worker-agent breakdown, showing spent/budget/percentage
- Update the summary card's total to include internal agent spend: `totalSpend = workerAgentSpend + internalAgentSpend`
- Same 80%/100% color indicators as the sub-page
- If the getConfig call fails (no config yet), gracefully omit the line item

## Tests

**New file:** `ui/src/__tests__/InternalAgentSettingsPage.test.tsx`

Framework: Vitest + React Testing Library + `renderWithProviders` from test-utils.

**Mock pattern:** Proxy-based mock of `internal-agent` API (same as Discussions.test.tsx pattern).

**Factory function:** `makeAgentConfig(overrides?)` returning a full config object with sensible defaults.

**Test cases:**
1. Renders all 4 sections with correct headers
2. Execution mode toggle: API mode shows provider/model dropdowns, hides CLI dropdown
3. Execution mode toggle: CLI mode shows CLI tool dropdown, hides provider/model
4. Autonomy level dropdown is disabled
5. Capability checkboxes: toggling individual checkbox updates state
6. Select All / Deselect All toggles all capabilities
7. Notification preference radio selection
8. Context token budget dropdown selection
9. Budget progress bar: green when <70%
10. Budget progress bar: yellow when 70–89%
11. Budget progress bar: red when ≥90%
12. Budget 100% shows "Agent paused" indicator
13. Save button calls updateConfig API with correct payload
14. Test connection button: shows loading state, then green badge on success
15. Test connection button: shows red badge with error message on failure
16. Run history renders table with correct columns
17. Run history "Load more" pagination
18. Run history empty state when zero runs
19. Run history "Load more" hidden when all runs loaded (total <= offset + limit)

**Existing file update:** `ui/src/__tests__/SettingsPage.test.tsx` — add test for internal agent line item in budget section.

## Data Flow

```
User edits form → local state
  → clicks Save → PATCH /internal-agent/config → success toast / error toast
  → React Query invalidates → re-fetches GET /config

Test connection → POST /internal-agent/test-connection
  → loading spinner → success/failure badge

Run history → GET /runs with pagination
  → append on "Load more"

Budget section (main Settings) → GET /internal-agent/config
  → extract spent/budget → render as line item
```

## Out of Scope

- Proactive interval configuration (in schema but not in task steps)
- Autonomy levels 1-3 (v3)
- Historical cost chart (T21 mentions it but it's a stretch goal — the progress bar covers the core need)
