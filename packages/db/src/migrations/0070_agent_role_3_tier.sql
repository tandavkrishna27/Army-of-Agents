-- Agent role enum collapse: 11 values → 3 tiers (`cxo`, `lead`, `general`).
-- See plan: docs/superpowers/plans/2026-04-30-agent-role-3-tier-cleanup.md.
--
-- The role column is `text NOT NULL DEFAULT 'general'` — no Postgres enum
-- type to alter, so this is a pure data migration. All four steps are
-- idempotent (running them on an already-migrated cluster is a no-op).

-- Step 1: ceo → cxo. The apex executive role is renamed from "ceo" to
-- the new tier label "cxo". Bundle resolver, permission bypass, and join-
-- request manager picker all check for `role = 'cxo'` after this
-- migration.
UPDATE agents SET role = 'cxo', updated_at = NOW() WHERE role = 'ceo';
--> statement-breakpoint

-- Step 2: existing team leads + agents with direct reports → lead.
-- Smart inference: if an agent currently leads a team (team_members.role
-- = 'lead') OR has agent direct reports (something parents to them via
-- parent_type='agent'), they keep their leadership identity by being
-- promoted from a cosmetic IC role to the new `lead` tier. Skip rows
-- already at `cxo` or `lead` so this stays idempotent.
--
-- Note: agents.parent_id is `text` (mixed agent/user storage) while
-- agents.id and team_members.agent_id are `uuid`. We can't UNION them
-- directly — using `OR` with a cast on the parent-id branch avoids the
-- "UNION types uuid and text cannot be matched" error.
UPDATE agents SET role = 'lead', updated_at = NOW()
WHERE (
  id IN (SELECT agent_id FROM team_members WHERE role = 'lead')
  OR id::text IN (
    SELECT parent_id FROM agents
    WHERE parent_type = 'agent' AND parent_id IS NOT NULL
  )
)
AND role NOT IN ('cxo', 'lead');
--> statement-breakpoint

-- Step 3: cosmetic roles → general. Anyone still on one of the deleted
-- enum values gets the catch-all label. After the previous two steps the
-- only roles surviving in the table should be the three new ones (`cxo`,
-- `lead`, `general`).
UPDATE agents SET role = 'general', updated_at = NOW()
WHERE role IN ('cto','cmo','cfo','engineer','designer','pm','qa','devops','researcher');
--> statement-breakpoint

-- Step 4: enforce the new CXO-parent invariant. CXOs can only report to
-- a user or root; any cxo currently parented to another agent gets
-- re-rooted (parent fields cleared) so the data conforms to the
-- validator added in this same plan. Founders see those agents pop up
-- to the org-tree root and can re-parent to a human if they want.
UPDATE agents
SET parent_type = NULL, parent_id = NULL, reports_to = NULL, updated_at = NOW()
WHERE role = 'cxo' AND parent_type = 'agent';
