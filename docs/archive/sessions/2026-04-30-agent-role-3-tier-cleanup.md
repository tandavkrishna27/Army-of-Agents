# Agent Role 3-Tier Cleanup Implementation Plan

> **For agentic workers:** Multi-task implementation. Steps use checkbox (`- [ ]`) syntax. Run tests + smoke after each major task; do not batch.

**Goal:** Replace the 11-value `agent.role` enum with a meaningful 3-tier model (`["cxo", "lead", "general"]`) where each tier maps to a real instructions bundle and clear permission semantics. Enforce that CXOs only report to humans or root.

**Architecture:**
Today `agent.role` has 11 values but only 2 (`ceo`, `general`) produce different behavior — the other 9 are cosmetic, creating false promises. The cleanup:
- Drops 9 cosmetic values
- Renames `ceo` → `cxo`, with a new mid-tier `lead` between CXO and IC
- Each tier gets a real onboarding bundle (existing dir reused/renamed)
- The "Chief of Staff" position is computed (apex CXO) — not stored
- CXOs are constrained to report to a human or root only

**Tech Stack:** Drizzle ORM (data migration), Express/Zod (validation), React (UI tweaks), Vitest (tests). No new dependencies.

---

## File Structure

| File | Action | Why |
|---|---|---|
| `packages/shared/src/constants.ts` | **Modify** | `AGENT_ROLES` enum: 11→3 values |
| `packages/shared/src/agents.ts` (find via grep — likely the role-labels file) | **Modify** | `AGENT_ROLE_LABELS`: relabel + drop |
| `server/src/onboarding-assets/director/` | **Rename → `cxo/`** | Naming alignment with new enum |
| `server/src/onboarding-assets/cxo/AGENTS.md` | **Lightly retone** | Drop "Code → CTO, Marketing → CMO" lines so it works for any apex CXO; rename "Director" → "Chief of Staff" voice |
| `server/src/onboarding-assets/tech-lead/` | **Rename → `lead/`** | Reuse existing well-authored content |
| `server/src/onboarding-assets/lead/AGENTS.md` | **Lightly genericize** | Rename "Tech Lead" → "Lead"; "Junior Devs" → "your direct reports"; remove tech-specific routing rules |
| `server/src/onboarding-assets/default/` | **Untouched** | `general` keeps using this |
| `server/src/services/default-agent-instructions.ts` | **Modify** | Resolver: `ceo` → `cxo`; add `lead` |
| `server/src/routes/issues.ts:91` | **Modify** | `=== "ceo"` → `=== "cxo"` |
| `server/src/services/agents.ts` | **Modify** | Add CXO parent-constraint validation in `create` + `update` |
| `packages/db/src/migrations/<NEW>.sql` | **Create** | Smart 3-step data migration |
| `ui/src/components/AgentConfigForm.tsx` | **Modify** | Drop misleading `{{ agent.role }}` placeholder hint |
| `ui/src/components/team/OrgTreeTab.tsx` | **Modify** | Add "⭐ Chief of Staff" badge on apex CXO |
| Tests | **Update + add** | Fixture role values; new validation tests; resolver tests |

## Decisions (locked)

1. **Enum:** `["cxo", "lead", "general"]`. Display labels: `{ cxo: "Executive", lead: "Lead", general: "General" }`.
2. **Folder names match DB values 1:1** — `cxo/`, `lead/`, `default/` (legacy name kept for `general` to avoid extra renaming churn).
3. **CXO parent constraint = HARD enforcement.** Service-layer 422 with a clear message. Same rule on create + update.
4. **Chief of Staff is computed**, not stored. Derived as: the topmost agent with `role = 'cxo'` in the org chart (i.e., a CXO with `parentType` `'user'` or `null`). Rendered as `⭐ Chief of Staff` badge in `OrgTreeTab`.
5. **Migration is smart, not lossy.** Three SQL UPDATEs:
   1. `ceo` → `cxo`
   2. agents that lead a team OR have direct reports → `lead`
   3. all remaining cosmetic roles → `general`
   Plus one cleanup: any newly-`cxo` agent currently parented to another agent gets reparented to root (so the CXO-must-report-to-user-or-null invariant holds).
6. **Bundle retoning approved by user.** Free to rewrite the prose so it works for any apex/mid-tier CXO without naming specific officer roles.
7. **Existing tests** use string literals like `role: "engineer"`, `role: "ceo"`. We update them to use the new values. Test fixture builder in `test-utils.tsx` defaults `role: "engineer"` — switch default to `general`.
8. **No new tests for visual badge.** Org-chart UI smoke test will catch the badge render. The badge derivation is a 3-line memo — overkill to test in isolation.

## Self-review (run before starting)

- [x] Spec coverage: 11→3 enum, bundle wiring for each, validation, migration, UI badge, AgentConfigForm placeholder fix — all covered
- [x] No placeholders, no "TBD"
- [x] Type consistency: `cxo` / `lead` / `general` used identically across enum / labels / folders / resolver / tests
- [x] No circular deps introduced

---

## Tasks

### Task 1 — Update `AGENT_ROLES` enum + labels

**Files:**
- Modify: `packages/shared/src/constants.ts`
- Modify: locate and modify `AGENT_ROLE_LABELS` (grep first to find: it's exported with `displayAgentRole`)

- [ ] **Step 1: Locate the label map**

```bash
grep -nE "AGENT_ROLE_LABELS\s*=" packages/shared/src
```

- [ ] **Step 2: Update enum**

Replace
```ts
export const AGENT_ROLES = [
  "ceo", "cto", "cmo", "cfo", "engineer", "designer",
  "pm", "qa", "devops", "researcher", "general",
] as const;
```
with
```ts
export const AGENT_ROLES = ["cxo", "lead", "general"] as const;
```

- [ ] **Step 3: Update labels**

```ts
export const AGENT_ROLE_LABELS: Record<typeof AGENT_ROLES[number], string> = {
  cxo: "Executive",
  lead: "Lead",
  general: "General",
};
```

- [ ] **Step 4: Run `pnpm -F shared build` and shared package tests**

Expected: clean. If `displayAgentRole()` switches on the old roles, repair it (likely just delete branches).

- [ ] **Step 5: Run typecheck across the monorepo**

```bash
pnpm exec tsc -b
```

Expected: many errors elsewhere referencing old role values. We'll fix them in subsequent tasks. Note them down but don't fix yet.

---

### Task 2 — Rename + retone the CXO bundle

**Files:**
- Rename: `server/src/onboarding-assets/director/` → `server/src/onboarding-assets/cxo/`
- Modify: `server/src/onboarding-assets/cxo/AGENTS.md`

- [ ] **Step 1: Rename the folder**

```bash
git mv server/src/onboarding-assets/director server/src/onboarding-assets/cxo
```

- [ ] **Step 2: Retone `AGENTS.md`**

Open the file. Replace the opening line and delegation rules so it works for both apex CXO (no parent above) and mid-tier CXO (under another CXO):
- Replace `"You are the Director."` → `"You are an Executive (CXO tier)."`
- Replace the role-specific routing rules (`Code → CTO`, `Marketing → CMO`, `UX → UXDesigner`) with generic guidance: *"Delegate based on each direct report's function. Read their `AGENTS.md` to know what they own."*
- Keep the delegation philosophy (*"You MUST delegate"*), the no-IC-work rule, and the follow-up rule.
- Add a one-liner near the top: *"If you are at the apex of the agent hierarchy (reporting directly to a human or no one), you are the Chief of Staff — the founder's primary delegate."*

- [ ] **Step 3: Skim `HEARTBEAT.md`, `SOUL.md`, `TOOLS.md` in the renamed folder**

Update any "Director" references to "Executive" or "Chief of Staff" depending on context. Do NOT add cruft — only change what reads wrong.

- [ ] **Step 4: Verify file load works**

The resolver (Task 4) will test reading it; this step just ensures no syntax/encoding issues.

```bash
head -1 server/src/onboarding-assets/cxo/AGENTS.md
```

Expected: starts with "You are an Executive..."

---

### Task 3 — Build the Lead bundle

**Files:**
- Rename: `server/src/onboarding-assets/tech-lead/` → `server/src/onboarding-assets/lead/`
- Modify: `server/src/onboarding-assets/lead/AGENTS.md`

- [ ] **Step 1: Rename folder**

```bash
git mv server/src/onboarding-assets/tech-lead server/src/onboarding-assets/lead
```

- [ ] **Step 2: Genericize `AGENTS.md`**

Open the file. Today it talks about "Tech Lead" / "Junior Devs" / engineering-specific routing. Genericize:
- Replace `"You are the Tech Lead."` → `"You are a Lead."`
- Replace specific routing rules (`Backend → dev-backend`, `UI → dev-frontend`, etc.) with generic *"Triage each subtask to whichever direct report owns that lane. Read their AGENTS.md to know what each one does."*
- Keep the delegation-is-the-job philosophy and the subagent-driven-development guidance — both are universal.

- [ ] **Step 3: Skim `HEARTBEAT.md`, `SOUL.md`, `TOOLS.md`**

Same treatment — generalize away from engineering-only language. Keep what's universal.

- [ ] **Step 4: Verify**

```bash
head -1 server/src/onboarding-assets/lead/AGENTS.md
```

Expected: starts with "You are a Lead..."

---

### Task 4 — Update the bundle resolver

**Files:**
- Modify: `server/src/services/default-agent-instructions.ts`
- Test: `server/src/__tests__/default-agent-instructions.test.ts`

- [ ] **Step 1: Write the failing tests first**

Add three test cases to `default-agent-instructions.test.ts`:
1. `loadDefaultAgentInstructionsBundle("cxo")` returns the 4 cxo files
2. `loadDefaultAgentInstructionsBundle("lead")` returns the 4 lead files (assume same set)
3. `loadDefaultAgentInstructionsBundle("default")` returns the 1 default file
4. `resolveDefaultAgentInstructionsBundleRole("cxo")` → `"cxo"`
5. `resolveDefaultAgentInstructionsBundleRole("lead")` → `"lead"`
6. `resolveDefaultAgentInstructionsBundleRole("general")` → `"default"`
7. `resolveDefaultAgentInstructionsBundleRole("anything-else")` → `"default"` (defensive fallback)

Run: `pnpm -F server test:run default-agent-instructions` — expect FAIL.

- [ ] **Step 2: Update the resolver**

Replace
```ts
const DEFAULT_AGENT_BUNDLE_FILES = {
  default: ["AGENTS.md"],
  ceo: ["AGENTS.md", "HEARTBEAT.md", "SOUL.md", "TOOLS.md"],
} as const;

const DEFAULT_AGENT_BUNDLE_DIRS: Record<DefaultAgentBundleRole, string> = {
  default: "default",
  ceo: "director",
};
```
with
```ts
const DEFAULT_AGENT_BUNDLE_FILES = {
  default: ["AGENTS.md"],
  cxo: ["AGENTS.md", "HEARTBEAT.md", "SOUL.md", "TOOLS.md"],
  lead: ["AGENTS.md", "HEARTBEAT.md", "SOUL.md", "TOOLS.md"],
} as const;

const DEFAULT_AGENT_BUNDLE_DIRS: Record<DefaultAgentBundleRole, string> = {
  default: "default",
  cxo: "cxo",
  lead: "lead",
};
```

And
```ts
export function resolveDefaultAgentInstructionsBundleRole(role: string): DefaultAgentBundleRole {
  if (role === "cxo") return "cxo";
  if (role === "lead") return "lead";
  return "default";
}
```

- [ ] **Step 3: Run tests**

Expected: all green.

---

### Task 5 — Move CEO permission bypass to CXO

**Files:**
- Modify: `server/src/routes/issues.ts:91` (the `canCreateAgentsLegacy` function)

- [ ] **Step 1: Replace the check**

```ts
function canCreateAgentsLegacy(agent: { permissions: Record<string, unknown> | null | undefined; role: string }) {
  if (agent.role === "cxo") return true;  // was: "ceo"
  if (!agent.permissions || typeof agent.permissions !== "object") return false;
  return Boolean((agent.permissions as Record<string, unknown>).canCreateAgents);
}
```

- [ ] **Step 2: Find any other hardcoded "ceo" string**

```bash
grep -rE "\"ceo\"|'ceo'" server/src --include="*.ts" | grep -v test
```

Update each. (There may be none after the resolver fix in Task 4.)

- [ ] **Step 3: Run server tests**

```bash
pnpm -F server test:run issues
```

Expected: green (or only failures from old-role fixtures we'll fix in Task 9).

---

### Task 6 — Add CXO parent-constraint validation

**Files:**
- Modify: `server/src/services/agents.ts` — `create` + `update` methods
- Test: `server/src/__tests__/agent-parent-fields.test.ts` (existing, extend it)

- [ ] **Step 1: Write the failing tests**

In `agent-parent-fields.test.ts`, add:
1. Creating an agent with `role: "cxo"` + `parentType: "agent"` → throws 422 with message containing "CXO can only report to a human or root"
2. Creating an agent with `role: "cxo"` + `parentType: "user"` → succeeds
3. Creating an agent with `role: "cxo"` + `parentType: null` → succeeds
4. Updating an existing CXO to `parentType: "agent"` → throws 422
5. Updating an existing `lead` to `role: "cxo"` while it has `parentType: "agent"` → throws 422 (role-promotion check)
6. Updating an existing `lead` to `role: "cxo"` after first clearing parent → succeeds

Run: expected FAIL.

- [ ] **Step 2: Implement validation in agent service**

In `services/agents.ts`, add a private helper:
```ts
function assertCxoParentConstraint(role: string | undefined, parentType: string | null | undefined) {
  if (role === "cxo" && parentType === "agent") {
    throw unprocessable(
      "CXO agents can only report to a human user or sit at the root of the org. " +
      "Reassign their parent to a user or null first.",
    );
  }
}
```

Call it in `create` after input validation, before insert. Call it in `update` after merging the patch into the effective state — i.e., compute `effectiveRole = patch.role ?? existing.role` and `effectiveParentType = 'parentType' in patch ? patch.parentType : existing.parentType`, then assert.

- [ ] **Step 3: Run tests**

Expected: green.

---

### Task 7 — Write the data migration

**Files:**
- Create: `packages/db/src/migrations/<NNNN>_agent_role_3_tier.sql` (let drizzle pick the next number)

- [ ] **Step 1: Generate migration shell**

```bash
pnpm -F db drizzle-kit generate --name agent_role_3_tier --custom
```

If `--custom` isn't supported, hand-create `packages/db/src/migrations/<next-number>_agent_role_3_tier.sql`.

- [ ] **Step 2: Write the SQL**

```sql
-- Step 1: ceo → cxo
UPDATE agents SET role = 'cxo' WHERE role = 'ceo';

-- Step 2: leads → lead
-- Anyone who is a team_members.role='lead' OR has agent direct reports
UPDATE agents SET role = 'lead' WHERE id IN (
  SELECT DISTINCT agent_id FROM team_members WHERE role = 'lead'
  UNION
  SELECT DISTINCT parent_id FROM agents
    WHERE parent_type = 'agent' AND parent_id IS NOT NULL
)
AND role NOT IN ('cxo', 'lead');

-- Step 3: cosmetic roles → general
UPDATE agents SET role = 'general' WHERE role IN
  ('cto','cmo','cfo','engineer','designer','pm','qa','devops','researcher');

-- Step 4: enforce CXO-parent invariant — any cxo currently parented to an agent
-- gets re-rooted (data integrity for the new validation rule).
UPDATE agents
SET parent_type = NULL, parent_id = NULL, reports_to = NULL
WHERE role = 'cxo' AND parent_type = 'agent';
```

Note: this is a **data** migration, not a schema change — drizzle's enum (if any) lives in the application layer, not Postgres. If `agents.role` is a Postgres enum type, we'd also need ALTER TYPE statements. Verify with:
```bash
grep -A 2 "role" packages/db/src/schema/agents.ts | head -10
```
If it's `text` (most likely), no schema change needed.

- [ ] **Step 3: Apply migration locally**

```bash
pnpm -F db migrate
```

- [ ] **Step 4: Verify in IMP**

```bash
curl -s "http://localhost:3100/api/companies/fe5a2a4d-30df-4d1e-ad12-36c80f62e3df/agents" | python -c "import sys,json;agents=json.load(sys.stdin);print('\n'.join(f\"{a['name']:>10}: role={a['role']}\" for a in agents))"
```

Expected (smart migration applied to current IMP state):
- Maya, Alice, Diana → `lead` (each is a team_members lead)
- Ben, Sam, Felix, Quinn, Bob, Charlie → `general`
- No CXO yet (none was `ceo` to begin with)

---

### Task 8 — UI: AgentConfigForm placeholder fix + Chief of Staff badge

**Files:**
- Modify: `ui/src/components/AgentConfigForm.tsx`
- Modify: `ui/src/components/team/OrgTreeTab.tsx`

- [ ] **Step 1: Drop misleading prompt-template placeholder hint**

In `AgentConfigForm.tsx`, find the prompt template input where `placeholder="You are agent {{ agent.name }}. Your role is {{ agent.role }}..."` appears. Change to:
```
placeholder="You are agent {{ agent.name }}..."
```

(Drop the `{{ agent.role }}` segment because there's no template engine that substitutes it. Same for the help text in `agent-config-primitives.tsx` if it lists `{{ agent.role }}` as a supported variable — drop that mention too.)

- [ ] **Step 2: Add "⭐ Chief of Staff" badge on the apex CXO**

In `OrgTreeTab.tsx`, the agent card render branch already has the Identity logo + status dot. Add a small badge above or next to the name when the agent is the apex CXO.

Definition of apex CXO:
- `agent.role === "cxo"`
- `agent.parentType` is `null` OR `"user"` (i.e., not under another agent)

The component receives `LayoutNode` which has `nodeType` + minimal fields. We need `role` + `parentType` from the actual agent. Two options:
1. **Option A (simplest):** Have `TeamPage` pass the agents-list query data through to `OrgTreeTab`, and look up `agent.role` + `agent.parentType` by id at render time.
2. **Option B:** Extend `UnifiedOrgNode` (the org tree response shape) to include `role` + `parentType` for agent nodes. Server already has these fields in `agentRows` — small additive change to `orgForCompany()` in `services/agents.ts`.

Pick Option B — it keeps OrgTreeTab cohesive and avoids prop drilling.

- [ ] **Step 3: Server-side: extend `UnifiedOrgNode`**

In `packages/shared/src/...` (find the `UnifiedOrgNode` type) add optional `parentType?: "agent" | "user" | null` field. In `services/agents.ts` `orgForCompany`, populate it from `row.parentType` for agent nodes.

- [ ] **Step 4: Render the badge**

In `OrgTreeTab.tsx`'s `AgentNodeCard`, add (above or next to the name):
```tsx
{node.role === "cxo" && (node.parentType === null || node.parentType === "user") && (
  <span className="rounded bg-amber-500 text-white px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide">
    ⭐ Chief of Staff
  </span>
)}
```

- [ ] **Step 5: Build + verify in browser**

Navigate to `/IMP/org`. Since IMP has no CXO right now, no badge should render anywhere. Promote one agent (e.g., make Maya `cxo` reporting to TK via API), reload → expect ⭐ Chief of Staff badge on Maya's card.

```bash
# Promote Maya to CXO temporarily to verify
curl -s -X PATCH "http://localhost:3100/api/agents/4e4311aa-d6c1-4a83-804f-f061615b3ee8" -H "Content-Type: application/json" -d '{"role":"cxo"}'
# Verify badge in UI, then revert
curl -s -X PATCH "http://localhost:3100/api/agents/4e4311aa-d6c1-4a83-804f-f061615b3ee8" -H "Content-Type: application/json" -d '{"role":"lead"}'
```

---

### Task 9 — Update tests + fixtures

**Files:** various test files referencing old role values.

- [ ] **Step 1: Find every hardcoded old-role string in tests**

```bash
grep -rE "role.*[\"']?(ceo|cto|cmo|cfo|engineer|designer|pm|qa|devops|researcher)[\"']?" {server,ui,packages}/src --include="*.test.ts" --include="*.test.tsx"
```

- [ ] **Step 2: Update each occurrence**

Map old → new:
- `ceo` → `cxo`
- `cto`, `cmo`, `cfo` → `cxo` (if the test specifically tested executive behavior) or `general` (if cosmetic)
- `engineer`, `designer`, `pm`, `qa`, `devops`, `researcher` → `general` (cosmetic in tests just like in product)
- Tests that *specifically* test team-lead behavior → `lead`

- [ ] **Step 3: Update `test-utils.tsx` `makeAgent` default**

```ts
export function makeAgent(overrides: Record<string, any> = {}) {
  return {
    ...,
    role: "general",  // was: "engineer"
    ...overrides,
  };
}
```

- [ ] **Step 4: Run full test sweep**

```bash
pnpm -F server test:run
pnpm -F ui test:run
pnpm -F shared test:run
```

Expected: all green. Fix any remaining failures.

- [ ] **Step 5: Run typecheck**

```bash
pnpm exec tsc -b
```

Expected: clean.

---

### Task 10 — Live verification

- [ ] **Step 1: Build UI**

```bash
pnpm -F ui build
```

- [ ] **Step 2: Reload IMP org page**

Navigate `/IMP/org`. Expected:
- Cards still render
- Maya/Alice/Diana labelled "Lead" on their cards (badge label changed)
- No `⭐ Chief of Staff` badge on anyone (no CXO yet)
- Team overlay boxes still render as before

- [ ] **Step 3: Test CXO parent constraint**

Try via API to set a `cxo` reporting to another agent — expect 422.

```bash
# Promote Maya to cxo (currently reports to TK, a user — should succeed)
curl -s -X PATCH "http://localhost:3100/api/agents/4e4311aa-d6c1-4a83-804f-f061615b3ee8" -H "Content-Type: application/json" -d '{"role":"cxo"}'

# Now try to make her report to Alice (an agent) — should fail with 422
curl -s -i -X PATCH "http://localhost:3100/api/agents/4e4311aa-d6c1-4a83-804f-f061615b3ee8" -H "Content-Type: application/json" -d '{"parentType":"agent","parentId":"34381784-ae9d-4f19-9b9d-669938af6ef2"}' | head -3

# Expected: 422 Unprocessable Entity with the constraint message

# Revert Maya to lead
curl -s -X PATCH "http://localhost:3100/api/agents/4e4311aa-d6c1-4a83-804f-f061615b3ee8" -H "Content-Type: application/json" -d '{"role":"lead"}'
```

- [ ] **Step 4: Visual smoke — promote and demote**

Navigate to Maya's `/IMP/agents/maya/configure`. Open Identity accordion. Confirm the role dropdown shows only 3 options: Executive, Lead, General. Pick "Executive", click Save. Reload `/IMP/org` — expect ⭐ Chief of Staff badge on Maya. Demote her back to "Lead".

---

### Task 11 — Code review

- [ ] Dispatch code-reviewer agent on the full diff
- [ ] Address any Critical/Important issues; document Nits as follow-ups
- [ ] Re-review if substantial fixes were needed

---

## Self-review (post-write)

- **Spec coverage:** every part of the user's confirmed scheme is reflected in tasks 1–10.
- **Placeholder scan:** no TBDs.
- **Type consistency:** `cxo`/`lead`/`general` used uniformly. CXO constraint flows through enum, validator, migration, UI badge.
- **Risk:** Medium. Schema-touching change (data migration) but no actual schema migration. Migration is reversible with a backup. Test coverage is broad.
