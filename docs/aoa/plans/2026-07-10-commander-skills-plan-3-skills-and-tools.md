# WS-2/3: Commander Skills + Tools — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Ship the four R1 Commander "operating copilot" skills (daily-triage/org-awareness, review-agent-output, delegate-handoff, harden-thinking-partner) plus the small tool surface they hard-need — port the MCP Approval family and `get-heartbeat-context` into Commander's registry (B2), teach the existing untaught tools (B1), and gate the run-history read tool (B3) behind an explicit go/no-go.

**Architecture:** Commander runs skills by loading their markdown via `use_skill` and calling tools from its 75-tool `createToolRegistry()`. Skills live canonically in the AoA-Skills repo (`skills/*.md`, open-source, **surface-agnostic prose** — intent in words, using Commander/surface-neutral names like `use_skill`, validated against the **COMMANDER surface** of `tools.json` by `validate.ts`) and are mirrored into the product's runtime catalog via `AOA_NATIVE_SKILLS` in `aoa-skills-seeder.ts` so the live Commander seeds + can invoke them. **Do NOT rewrite skill bodies to MCP spellings** (e.g. `memory.write`) — that would fail `validate.ts` (which allowlists commander-surface names) and is unnecessary because the per-surface cheat-sheet resolves real names; the seeder generation (Plan-1 Task 7) applies only the key-namespace mapping, not a prose rewrite. New tools are `AgentTool` objects wrapping existing services (approval + issue-approval services already exist on the MCP surface; the port re-implements the handler over Commander's `ToolContext` shape and registers them in `tool-registry.ts`). Skills are surface-agnostic: prose describes intent, and a per-surface cheat-sheet (from Plan-1's `tools.json`) resolves real tool names.

**Tech Stack:** Node/Bun, TypeScript; product = AoA (this worktree); skills = AoA-Skills repo.

**Depends on:** Plan 1 (WS-0 — `tools.json` manifest + per-surface cheat-sheets; regenerated `validate.ts` allowlist) + Plan 2 (WS-1 — shared Commander preamble injected product-side; WHEN-only description + rigid/flexible authoring conventions; lite triggering-eval harness). This plan produces new commander-surface tool names; because Plan-1's `buildToolManifest()` reads the **live** registry, they land in `tools.json` (and thus the `validate.ts` allowlist) **automatically** once registered — the workflow is "register in `createToolRegistry()` → `pnpm gen:tools` → `pnpm sync:skills`", not a hand-edit of `tools.json` (see each B2 task's regen step). `mcpAlias` stays `null` per scope §WS-0.

**Repos touched:** [product] AoA-2.5 (this worktree) · [skills-repo] AoA-Skills (`github.com/MeteoriteLabs/AoA-Skills`)

---

## Cross-plan contract (fixed inputs — do not redesign)

- **Plan 1 (WS-0):** `tools.json` manifest + per-surface tool cheat-sheets exist. Skills are surface-agnostic (intent in prose; tool names from the cheat-sheet). `validate.ts`'s `VALID_TOOLS` is regenerated from `tools.json` (the phantom `create_memory` is gone; `suggest_memory` is valid).
- **Plan 2 (WS-1):** shared Commander preamble injected in `buildCompactSkillList` / `use_skill` return (persona + confirm-gate + memory-PENDING). Authoring conventions: WHEN-only `description`, rigid/flexible + degrees-of-freedom labels. A lite triggering-eval harness exists (naive prompt → assert the right skill key routed). **The assertion reads the classifier-proxy output (Tier 1) or the in-process `tool_call` chunk `input.key` / the `Loaded skill: <name>` `tool_result` summary (`tools/skill-tools.ts:100`) (Tier 2) — NOT the persisted `internal_agent_messages.toolCalls`, which stores only the tool `name`, not the skill key.** **Each new skill in this plan ships one triggering-eval case for that harness** (keyed `skill:aoa/<name>`).
- Commander chat reaches ~all 75 registry tools (role/capability/per-tool gated, default enabled). **Use existing tools where possible** — B2 ports and the single conditional B3 tool are the only new product tools this plan introduces.

---

## Naming decisions locked for this plan

- **Skill keys — two forms, one deterministic mapping (cross-plan B2).** The AoA-Skills repo is the single source; each `skills/*.md` frontmatter carries the **source** key `skill:aoa-curated/aoa-<name>`. Plan-1 Task 7's `AOA_NATIVE_SKILLS` generator maps it to the **runtime seeder** key `skill:aoa/<name>` (strip `aoa-curated/aoa-` → `aoa/`), preserving today's live seeder keys (no install migration). **In this plan: every `expectSkillKey`/triggering-eval case and every `AOA_NATIVE_SKILLS` seeder entry uses `skill:aoa/<name>`** (what live Commander loads and fires); the repo frontmatter `key:` stays `skill:aoa-curated/aoa-<name>` (source), mapped by the generator. (This is why the skill files below show `key: skill:aoa-curated/aoa-…` in frontmatter but the seeder twins + eval cases use `skill:aoa/…`.)
- **Commander tool names are `snake_case`** (registry convention). The ports get snake_case names. The kebab names in the second column are the **pre-existing MCP-surface tools** that already ship as their own `surface:"mcp"` entries in `tools.json` — they are shown here only to trace which existing handler each port mirrors. **`mcpAlias` stays `null` on every ported commander entry in R1** (scope §WS-0 reserves the field): `validate.ts` keys on commander-surface tool **names**, not aliases, and the MCP cheat-sheet already lists those kebab tools from their separate `surface:"mcp"` entries — so no `mcpAlias` mapping is needed for the skills to validate.

  | Commander name (new) | Existing MCP-surface tool (separate `surface:"mcp"` entry) | Category | Role floor | Confirm |
  |---|---|---|---|---|
  | `list_approvals` | `list-approvals` | query | **founder** | no |
  | `get_approval` | `get-approval` | query | **founder** | no |
  | `get_approval_tasks` | `get-approval-tasks` | query | **founder** | no |
  | `list_approval_comments` | `list-approval-comments` | query | **founder** | no |
  | `approval_decision` | `approval-decision` | action | **founder** | **yes** |
  | `get_heartbeat_context` | `get-heartbeat-context` | query | team_member | no |
  | `list_agent_runs` (B3, conditional) | *(new — no MCP twin)* | query | team_lead | no |

- **RBAC divergence from the MCP surface (deliberate, flagged for review):** The MCP approval handlers scope non-founder callers per-project — reads and decisions are filtered to approvals whose linked tasks fall in the caller's authorization project set (`ctx.scope.projectIds`, `server/src/mcp/tools/approval-tools.ts:27,71,219`). Commander's `ToolContext` carries **no team_lead authorization project SET** — every existing Commander tool gates on `requiredRole` + `companyId` only. (Commander does carry a `contextScope.projectId`, but that is a **UI context hint** — the department the user is currently looking at — **NOT an authorization boundary**; it must not be used to gate reads, or a lead could read any project's approvals just by switching the UI scope.) To avoid silently widening authority, the R1 port:
  - gates **both the approval READ tools and the decision tool** (`list_approvals`, `get_approval`, `get_approval_tasks`, `list_approval_comments`, `approval_decision`) at **`requiredRole: "founder"`** — not `team_lead`. Without a real per-project authorization set we cannot replicate the MCP surface's lead-scoping, so giving a lead company-wide approval visibility (or decision power) would widen authority; founder-only is correct-by-default (the founder is AoA's approval gatekeeper, CLAUDE.md).
  - **defers team_lead parity to R2**, behind a Commander project-scope resolver that mirrors the MCP filtering (`approvalHasScopedIssueLink`) using a real authorization project set — not `contextScope.projectId`. This is the single most important RBAC call in this plan — see Self-Review + Open Questions.

---

## File Structure

### [product] AoA-2.5 (this worktree)

| Path | Create/Modify | Responsibility |
|---|---|---|
| `server/src/services/internal-agent/types.ts` | Modify | Add `approvals` + `issueApprovals` to `ServiceContainer` interface. |
| `server/src/services/internal-agent/service-container.ts` | Modify | Wire `approvalService(db)` + `issueApprovalService(db)` into `createServiceContainer`. |
| `server/src/services/internal-agent/tools/approval-tools.ts` | **Create** | 5 Commander `AgentTool`s: `list_approvals`, `get_approval`, `get_approval_tasks`, `list_approval_comments`, `approval_decision`. Wraps `approvals` + `issueApprovals`; company-scoped; hub-sync + activity-log on decision. |
| `server/src/services/internal-agent/tools/heartbeat-context-tool.ts` | **Create** | Commander `AgentTool` `get_heartbeat_context` — `{ task, recentComments }` (last 10 comments), company-scoped. |
| `server/src/services/internal-agent/tools/agent-runs-tool.ts` | **Create (CONDITIONAL — Task 8 only)** | `list_agent_runs` — reads `heartbeat_runs` + events. Built only if the Task-5 go/no-go trips. Default: not created (deferred to R2). |
| `server/src/services/internal-agent/tool-registry.ts` | Modify | Import + register the new tools in `createToolRegistry()`. |
| `server/src/services/internal-agent/aoa-skills-seeder.ts` | Modify | Add 3 new `AOA_NATIVE_SKILLS` entries (daily-triage, review-agent-output, delegate-handoff, Commander-flavored) and replace the `brainstorm` markdown with the hardened version; add an `office-hours` entry (currently absent from the seeder). |
| `server/src/services/internal-agent/tools/__tests__/approval-tools.test.ts` | **Create** | TDD: list/get/decision happy-path + cross-company NOT_FOUND + role/company gating + hub-sync-on-decide. |
| `server/src/services/internal-agent/tools/__tests__/heartbeat-context-tool.test.ts` | **Create** | TDD: happy-path shape + cross-company NOT_FOUND + comment cap at 10. |
| `server/src/services/internal-agent/tools/__tests__/agent-runs-tool.test.ts` | **Create (CONDITIONAL)** | TDD for Task 8, only if built. |
| Plan-2 triggering-eval fixtures (path owned by Plan 2) | Modify | Add one case per new/hardened skill. |

### [skills-repo] AoA-Skills

| Path | Create/Modify | Responsibility |
|---|---|---|
| `skills/daily-triage.md` | **Create** | R1 skill 1 — role-aware "what needs me?" |
| `skills/review-agent-output.md` | **Create** | R1 skill 2 — walk artifact/diff vs acceptance criteria → approve/revise. |
| `skills/delegate-handoff.md` | **Create** | R1 skill 3 — planning→execution bridge. |
| `skills/brainstorm.md` | Modify | Harden: critical (not sycophantic) + memory-grounded. |
| `skills/office-hours.md` | Modify | Harden: critical + memory-grounded; fix phantom `create_memory` → `suggest_memory`. |
| `catalog/skills.json` | Modify | Add the 3 new skill entries (id/name/description/file/category/tags). |
| `commander/TOOLS.md` | Modify (if not already done by Plan-1) | Ensure the 6 ported tool names appear (generated from `tools.json`). Coordinated with Plan-1. |

> **Two-copy note (important):** every skill exists twice — canonical in the AoA-Skills repo (`skills/*.md`, **surface-agnostic** prose, `validate.ts`-checked against the **commander** surface) **and** in the product seeder (`AOA_NATIVE_SKILLS`) which is what the live Commander actually loads and what the triggering-eval fires against (keyed `skill:aoa/<name>`). A skill task is not done until **both** are updated. `office-hours` currently lives only in the repo; hardening it for Commander requires adding it to the seeder. (Once Plan-1 Task 7's generator lands, the seeder copy is produced FROM the repo copy — the two stop being hand-mirrored; see Self-Review risk #2.)

---

## Task 1 — [product] Extend Commander `ServiceContainer` with approval services

**Why first:** the Approval-family port (Task 2) needs `approvals` + `issueApprovals`, which Commander's container does not expose today. Small, no behavior change, unblocks Task 2.

**Files:**
- `server/src/services/internal-agent/types.ts:97` (`ServiceContainer` interface) + `:15` (import block)
- `server/src/services/internal-agent/service-container.ts:191` (`createServiceContainer` return) + `:1` (import block)
- Both services already exist and are exported: `server/src/services/index.ts:6` (`issueApprovalService`) and `:9` (`approvalService`).

Steps:

- [ ] In `types.ts`, add imports near the other service type imports (after line 17):
  ```ts
  import type { approvalService } from "../approvals.js";
  import type { issueApprovalService } from "../issue-approvals.js";
  ```
- [ ] In the `ServiceContainer` interface (after `notifications:` line ~110), add:
  ```ts
  /** Approval workflow service — powers Commander's approval oversight tools (B2 port). */
  approvals: ReturnType<typeof approvalService>;
  /** Issue↔approval linkage — resolves which tasks an approval blocks. */
  issueApprovals: ReturnType<typeof issueApprovalService>;
  ```
- [ ] In `service-container.ts`, import both at the top:
  ```ts
  import { approvalService } from "../approvals.js";
  import { issueApprovalService } from "../issue-approvals.js";
  ```
- [ ] In the `createServiceContainer` return object (after `notifications: notificationService(db),`), add:
  ```ts
  approvals: approvalService(db),
  issueApprovals: issueApprovalService(db),
  ```
- [ ] Verify it compiles:
  ```
  cd server && pnpm exec tsc --noEmit
  ```
  Expected: no new type errors (the two added properties satisfy the interface).

---

## Task 2 — [product] Port the Approval family into Commander's registry (B2, TDD)

**Rationale:** `review-agent-output` (approve/revise an agent's work) and `daily-triage/org-awareness` (surface open approvals as "what needs me") both reach for approvals oversight, which lives only on the MCP surface today. Port 5 tools; leave `create-approval`, `add-approval-comment`, `list-task-approvals`, `link/unlink-task-approval` on MCP for R1 (not reached by the R1 skills — creation/linking is a founder-console action, not a Commander conversation).

**Files:**
- Reference handler (do not import — different `ToolContext`): `server/src/mcp/tools/approval-tools.ts:57` (`handleListApprovals`), `:83` (`handleGetApproval`), `:95` (`handleGetApprovalTasks`), `:111` (`handleListApprovalComments`), `:205` (`handleApprovalDecision`), `:46` (`syncApprovalHubItem`).
- Hub-sync helpers (reuse): `server/src/services/hub-source-producers.ts` (`buildApprovalHubEmit`, `emitHubItem`), `server/src/services/hub-items.ts` (`hubItemsService`).
- Activity log: `server/src/services/index.ts` (`logActivity`).
- `AgentTool` shape: `server/src/services/internal-agent/types.ts:86`.
- Pattern to mirror (company-scope-in-tool + NOT_FOUND on cross-company): `server/src/services/internal-agent/tools/get-task-tool.ts:47-60`.
- Register in: `server/src/services/internal-agent/tool-registry.ts:90` (`createToolRegistry`).

### 2a — Write the failing test first

- [ ] Create `server/src/services/internal-agent/tools/__tests__/approval-tools.test.ts` mirroring the mock style in `__tests__/artifact-create-version-delegates.test.ts` (Proxy table stub for `@armyofagents/db`, hand-built `ctx.services`). Cover:
  ```ts
  import { describe, it, expect, vi } from "vitest";
  import { approvalTools } from "../approval-tools.js";

  const byName = Object.fromEntries(approvalTools.map((t) => [t.name, t]));

  function ctx(overrides: any = {}) {
    return {
      companyId: "c1",
      userId: "u1",
      userRole: "founder",
      db: {},
      services: {
        approvals: {
          list: vi.fn().mockResolvedValue([{ id: "a1", companyId: "c1", status: "pending", type: "crew_dispatch" }]),
          getById: vi.fn().mockResolvedValue({ id: "a1", companyId: "c1", status: "pending" }),
          listComments: vi.fn().mockResolvedValue([]),
          approve: vi.fn().mockResolvedValue({ id: "a1", companyId: "c1", status: "approved" }),
          reject: vi.fn(), requestRevision: vi.fn(), resubmit: vi.fn(),
        },
        issueApprovals: { listIssuesForApproval: vi.fn().mockResolvedValue([{ issueId: "t1", projectId: "p1" }]) },
      },
      ...overrides,
    } as any;
  }

  it("list_approvals returns the company's approvals", async () => {
    const res = await byName.list_approvals.execute({ status: "pending" }, ctx());
    expect(res.success).toBe(true);
    expect(Array.isArray(res.data)).toBe(true);
  });

  it("get_approval returns NOT_FOUND for a cross-company approval", async () => {
    const c = ctx();
    c.services.approvals.getById.mockResolvedValue({ id: "a1", companyId: "other", status: "pending" });
    const res = await byName.get_approval.execute({ approvalId: "a1" }, c);
    expect(res.success).toBe(false);
    expect(res.error).toBe("NOT_FOUND");
  });

  it("approval_decision approve calls approvals.approve with company + user", async () => {
    const c = ctx();
    const res = await byName.approval_decision.execute({ approvalId: "a1", action: "approve" }, c);
    expect(c.services.approvals.approve).toHaveBeenCalledWith("a1", "c1", "u1", null);
    expect(res.success).toBe(true);
  });

  it("approval_decision rejects a cross-company approval before mutating", async () => {
    const c = ctx();
    c.services.approvals.getById.mockResolvedValue({ id: "a1", companyId: "other", status: "pending" });
    const res = await byName.approval_decision.execute({ approvalId: "a1", action: "approve" }, c);
    expect(res.error).toBe("NOT_FOUND");
    expect(c.services.approvals.approve).not.toHaveBeenCalled();
  });
  ```
- [ ] Run — expect failure (module missing):
  ```
  cd server && pnpm exec vitest run src/services/internal-agent/tools/__tests__/approval-tools.test.ts
  ```
  Expected: `Cannot find module '../approval-tools.js'`.

### 2b — Implement the tools

- [ ] Create `server/src/services/internal-agent/tools/approval-tools.ts`:
  ```ts
  // server/src/services/internal-agent/tools/approval-tools.ts
  //
  // B2 port — Approval-family oversight tools for Commander. Wraps the same
  // approvalService + issueApprovalService the MCP surface uses, re-expressed
  // over Commander's ToolContext (userRole + companyId; no team_lead authorization project set).
  //
  // SECURITY: every approval service method looks up by primary key WITHOUT a
  // company filter, so each tool enforces row.companyId === ctx.companyId itself
  // and returns NOT_FOUND on mismatch (never confirms a foreign approval exists).
  //
  // RBAC (R1): reads AND the decision all gate at founder (requiredRole).
  // The MCP surface's per-project team_lead scoping is intentionally NOT
  // replicated: Commander's ToolContext has no team_lead authorization project
  // SET (contextScope.projectId is a UI hint, not an authz boundary), so
  // company-wide lead visibility would widen authority. team_lead parity is R2
  // behind a project-scope resolver — see plan §"RBAC divergence". Category:
  // reads=query (no capability gate), decision=action (system_actions-gated +
  // write ergonomics).
  import { APPROVAL_STATUSES, APPROVAL_TYPES } from "@armyofagents/shared";
  import { logActivity } from "../../index.js";
  import { hubItemsService } from "../../hub-items.js";
  import { buildApprovalHubEmit, emitHubItem } from "../../hub-source-producers.js";
  import type { AgentTool, ToolContext, ToolResult } from "../types.js";

  const OPEN_HUB_STATUSES = new Set(["pending", "revision_requested"]);
  const VALID_STATUS = new Set<string>(APPROVAL_STATUSES);
  const VALID_TYPE = new Set<string>(APPROVAL_TYPES);

  async function loadOwnedApproval(ctx: ToolContext, approvalId: string) {
    const row = await ctx.services.approvals.getById(approvalId);
    if (!row || (row as { companyId?: string }).companyId !== ctx.companyId) return null;
    return row as { id: string; companyId: string; status: string } & Record<string, unknown>;
  }

  async function syncApprovalHubItem(ctx: ToolContext, approval: { id: string; companyId: string; status: string }) {
    if (OPEN_HUB_STATUSES.has(approval.status)) {
      await emitHubItem(ctx.db, buildApprovalHubEmit(approval as any));
      return;
    }
    await hubItemsService(ctx.db).reconcile(approval.companyId, { sourceType: "approval", sourceId: approval.id });
  }

  const listApprovals: AgentTool = {
    name: "list_approvals",
    description:
      "List the company's approval requests (governance decisions awaiting a call), newest first. Optional filters: status (pending|approved|rejected|revision_requested|…), type. Use when asked what needs approval / what is waiting on the founder.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", description: "Filter by approval status" },
        type: { type: "string", description: "Filter by approval type" },
      },
    },
    category: "query",
    requiredRole: "founder", // R1: founder-only — Commander has no team_lead authorization project set (see RBAC divergence). team_lead parity is R2.
    requiresConfirmation: false,
    async execute(params, ctx): Promise<ToolResult> {
      const { status, type } = (params ?? {}) as { status?: string; type?: string };
      const statusFilter = typeof status === "string" && VALID_STATUS.has(status) ? status : undefined;
      let rows = await ctx.services.approvals.list(ctx.companyId, statusFilter);
      if (typeof type === "string" && VALID_TYPE.has(type)) {
        rows = (Array.isArray(rows) ? rows : []).filter((r: any) => r.type === type);
      }
      const list = Array.isArray(rows) ? rows : [];
      return { success: true, data: list, summary: `Found ${list.length} approval${list.length === 1 ? "" : "s"}` };
    },
  };

  const getApproval: AgentTool = {
    name: "get_approval",
    description:
      "Read one approval by id: its type, status, payload, and requester. Use to inspect a specific pending decision before acting on it.",
    parameters: { type: "object", properties: { approvalId: { type: "string" } }, required: ["approvalId"] },
    category: "query",
    requiredRole: "founder", // R1: founder-only — Commander has no team_lead authorization project set (see RBAC divergence). team_lead parity is R2.
    requiresConfirmation: false,
    async execute(params, ctx): Promise<ToolResult> {
      const { approvalId } = (params ?? {}) as { approvalId?: string };
      if (!approvalId) return { success: false, data: null, summary: "approvalId is required", error: "INVALID_PARAMS" };
      const row = await loadOwnedApproval(ctx, approvalId);
      if (!row) return { success: false, data: null, summary: "Approval not found", error: "NOT_FOUND" };
      return { success: true, data: row, summary: `Approval ${row.id}: ${row.status}` };
    },
  };

  const getApprovalTasks: AgentTool = {
    name: "get_approval_tasks",
    description: "List the tasks an approval is gating (what unblocks if it is approved).",
    parameters: { type: "object", properties: { approvalId: { type: "string" } }, required: ["approvalId"] },
    category: "query",
    requiredRole: "founder", // R1: founder-only — Commander has no team_lead authorization project set (see RBAC divergence). team_lead parity is R2.
    requiresConfirmation: false,
    async execute(params, ctx): Promise<ToolResult> {
      const { approvalId } = (params ?? {}) as { approvalId?: string };
      if (!approvalId) return { success: false, data: null, summary: "approvalId is required", error: "INVALID_PARAMS" };
      const row = await loadOwnedApproval(ctx, approvalId);
      if (!row) return { success: false, data: null, summary: "Approval not found", error: "NOT_FOUND" };
      const rows = await ctx.services.issueApprovals.listIssuesForApproval(approvalId);
      const list = Array.isArray(rows) ? rows : [];
      return { success: true, data: list, summary: `${list.length} task${list.length === 1 ? "" : "s"} linked` };
    },
  };

  const listApprovalComments: AgentTool = {
    name: "list_approval_comments",
    description: "List the discussion/comments on an approval (context for the decision).",
    parameters: { type: "object", properties: { approvalId: { type: "string" } }, required: ["approvalId"] },
    category: "query",
    requiredRole: "founder", // R1: founder-only — Commander has no team_lead authorization project set (see RBAC divergence). team_lead parity is R2.
    requiresConfirmation: false,
    async execute(params, ctx): Promise<ToolResult> {
      const { approvalId } = (params ?? {}) as { approvalId?: string };
      if (!approvalId) return { success: false, data: null, summary: "approvalId is required", error: "INVALID_PARAMS" };
      const row = await loadOwnedApproval(ctx, approvalId);
      if (!row) return { success: false, data: null, summary: "Approval not found", error: "NOT_FOUND" };
      const comments = await ctx.services.approvals.listComments(approvalId);
      const list = Array.isArray(comments) ? comments : [];
      return { success: true, data: list, summary: `${list.length} comment${list.length === 1 ? "" : "s"}` };
    },
  };

  const approvalDecision: AgentTool = {
    name: "approval_decision",
    description:
      "Decide an approval: approve, reject, request revision, or resubmit. Founder-only, and always confirmed before it runs (irreversible governance action).",
    parameters: {
      type: "object",
      properties: {
        approvalId: { type: "string" },
        action: { type: "string", enum: ["approve", "reject", "requestRevision", "resubmit"] },
        decisionNote: { type: "string" },
      },
      required: ["approvalId", "action"],
    },
    category: "action",
    requiredRole: "founder",
    requiresConfirmation: true,
    async execute(params, ctx): Promise<ToolResult> {
      const { approvalId, action, decisionNote } = (params ?? {}) as {
        approvalId?: string; action?: string; decisionNote?: string;
      };
      if (!approvalId || !action) {
        return { success: false, data: null, summary: "approvalId and action are required", error: "INVALID_PARAMS" };
      }
      const approval = await loadOwnedApproval(ctx, approvalId);
      if (!approval) return { success: false, data: null, summary: "Approval not found", error: "NOT_FOUND" };
      const note = decisionNote ?? null;
      let updated: any;
      switch (action) {
        case "approve": updated = await ctx.services.approvals.approve(approvalId, ctx.companyId, ctx.userId, note); break;
        case "reject": updated = await ctx.services.approvals.reject(approvalId, ctx.companyId, ctx.userId, note); break;
        case "requestRevision": updated = await ctx.services.approvals.requestRevision(approvalId, ctx.companyId, ctx.userId, note); break;
        case "resubmit": updated = await ctx.services.approvals.resubmit(approvalId, ctx.companyId); break;
        default: return { success: false, data: null, summary: `Unknown action '${action}'`, error: "INVALID_PARAMS" };
      }
      if (!updated) return { success: false, data: null, summary: "Approval not found", error: "NOT_FOUND" };
      await logActivity(ctx.db, {
        companyId: ctx.companyId, actorType: "user", actorId: ctx.userId,
        action: `approval.${action}`, entityType: "approval", entityId: approvalId,
        details: { action, source: "commander" },
      });
      await syncApprovalHubItem(ctx, updated);
      return { success: true, data: updated, summary: `Approval ${action} → ${updated.status}` };
    },
  };

  export const approvalTools: AgentTool[] = [
    listApprovals, getApproval, getApprovalTasks, listApprovalComments, approvalDecision,
  ];
  ```
- [ ] Confirm the `logActivity` argument shape matches its signature (see `server/src/mcp/tools/approval-tools.ts:184-194`). If `logActivity` requires `actorType` from a fixed union, use `"user"`; drop `runId`/`agentId` (Commander decisions are user-driven). Adjust to satisfy `tsc`.
- [ ] Register in `tool-registry.ts`: add `import { approvalTools } from "./tools/approval-tools.js";` near the other tool imports, and spread `...approvalTools,` into the `createToolRegistry()` array (place near the hub-curation tools at the end).

### 2c — Green + register verification

- [ ] Run the test — expect green:
  ```
  cd server && pnpm exec vitest run src/services/internal-agent/tools/__tests__/approval-tools.test.ts
  ```
  Expected: 4 passing.
- [ ] Typecheck: `cd server && pnpm exec tsc --noEmit` → no errors.
- [ ] **Regenerate the contract + resync (Plan 1 generators — do NOT hand-edit `tools.json`).** After the 5 tools are registered in `createToolRegistry()`, run `pnpm gen:tools` then `pnpm sync:skills -- <skills-repo>` so the new commander-surface tool **names** land in the vendored `generated/tools.json` + the `validate.ts` allowlist automatically (Plan-1's generator reads the live registry). `mcpAlias` stays `null` per scope §WS-0 — `validate.ts` keys on commander-surface names, and the existing `list-approvals`/`approval-decision`/… MCP tools already appear as their own `surface:"mcp"` entries, so the MCP cheat-sheet gets them regardless. This step MUST run before any skill body that references these names is validated (Tasks 4–5, skill-verification block).
- [ ] Commit: `git add -A && git commit -m "feat(commander): port approval-family oversight tools (B2)"`.

---

## Task 3 — [product] Port `get_heartbeat_context` into Commander (B2, TDD)

**Rationale:** `review-agent-output` needs the agent's *run outcome* on a task. AoA already posts an auto-run-summary comment after every heartbeat/crew run (duration, tokens, cost, outcome, detected files → `issue_comments`). `get_heartbeat_context` returns `{ task, recentComments }` (last 10), so the run summary is already reachable without a dedicated run-history tool — this is the key input that lets Task 8 (B3) default to deferred.

**Files:**
- Reference handler: `server/src/mcp/tools/read-tools.ts:113` (`handleGetHeartbeatContext`).
- `issueService.listComments`: `server/src/services/issues.ts:1776`.
- Pattern: `server/src/services/internal-agent/tools/get-task-tool.ts`.

- [ ] Create `server/src/services/internal-agent/tools/__tests__/heartbeat-context-tool.test.ts`:
  ```ts
  import { describe, it, expect, vi } from "vitest";
  import { getHeartbeatContextTool } from "../heartbeat-context-tool.js";

  function ctx(task: any, comments: any[] = []) {
    return {
      companyId: "c1",
      services: { issues: { getById: vi.fn().mockResolvedValue(task), listComments: vi.fn().mockResolvedValue(comments) } },
    } as any;
  }
  it("returns task + up to 10 recent comments", async () => {
    const comments = Array.from({ length: 15 }, (_, i) => ({ id: `c${i}` }));
    const res = await getHeartbeatContextTool.execute({ taskId: "t1" }, ctx({ id: "t1", companyId: "c1" }, comments));
    expect(res.success).toBe(true);
    expect((res.data as any).recentComments).toHaveLength(10);
  });
  it("NOT_FOUND for a cross-company task", async () => {
    const res = await getHeartbeatContextTool.execute({ taskId: "t1" }, ctx({ id: "t1", companyId: "other" }));
    expect(res.error).toBe("NOT_FOUND");
  });
  ```
- [ ] Run — expect failure (missing module).
- [ ] Create `server/src/services/internal-agent/tools/heartbeat-context-tool.ts`:
  ```ts
  // server/src/services/internal-agent/tools/heartbeat-context-tool.ts
  //
  // B2 port — get_heartbeat_context. Returns { task, recentComments } (last 10)
  // for a task. The auto-run-summary comment posted after each heartbeat/crew run
  // lives in these comments, so review-agent-output reads the run outcome here
  // without a dedicated run-history tool. Company-scoped in-tool (getById/
  // listComments have no company filter). Category: query (no capability gate).
  import type { AgentTool, ToolResult } from "../types.js";

  export const getHeartbeatContextTool: AgentTool = {
    name: "get_heartbeat_context",
    description:
      "Read a task plus its 10 most recent comments — including the auto-generated run-summary an agent posts after each run (outcome, duration, cost, files touched). Use to see what an agent actually did on a task.",
    parameters: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] },
    category: "query",
    requiredRole: "team_member",
    requiresConfirmation: false,
    async execute(params, ctx): Promise<ToolResult> {
      const { taskId } = (params ?? {}) as { taskId?: string };
      if (!taskId || typeof taskId !== "string") {
        return { success: false, data: null, summary: "taskId is required", error: "INVALID_PARAMS" };
      }
      const task = await ctx.services.issues.getById(taskId);
      if (!task || (task as { companyId?: string }).companyId !== ctx.companyId) {
        return { success: false, data: null, summary: "Task not found", error: "NOT_FOUND" };
      }
      const comments = await ctx.services.issues.listComments(taskId);
      const recentComments = (Array.isArray(comments) ? comments : []).slice(0, 10);
      return {
        success: true,
        data: { task, recentComments },
        summary: `Task context: ${(task as any).identifier ?? taskId} (+${recentComments.length} comments)`,
      };
    },
  };
  ```
- [ ] Register in `tool-registry.ts` (import + add `getHeartbeatContextTool,` to the array).
- [ ] Run test → green. `tsc --noEmit` → clean.
- [ ] **Regenerate the contract + resync.** After `get_heartbeat_context` is registered in `createToolRegistry()`, run `pnpm gen:tools` then `pnpm sync:skills -- <skills-repo>` so the name lands in `generated/tools.json` + the `validate.ts` allowlist automatically. `mcpAlias` stays `null` per scope §WS-0 (the existing `get-heartbeat-context` MCP tool is already its own `surface:"mcp"` entry). Run before validating any skill body that references it.
- [ ] Commit: `feat(commander): port get_heartbeat_context (B2)`.

---

## Task 4 — [skills-repo + product] Skill: **Daily Triage / Org-Awareness** (B1)

**WHEN-only description** (Plan-2 convention — describe *when to fire*, never the workflow):
> "When the user asks what to work on, what needs their attention, what is blocked or at risk, or how a department or the company is doing right now — a status/prioritization ask, not a request to create or change anything."

**Rigid/flexible label:** *Flexible* — the reads and the ordering adapt to the role and what the data shows; there is no fixed script.

**Tools it teaches** (all reachable today — B1/B2; verified against the registry):
| Tool | Tier | Registry ref |
|---|---|---|
| `query_tasks` | B1 | `tools/query-tools.ts:6` |
| `query_goals` | B1 | `tools/query-tools.ts:36` |
| `query_dependency_chain` | B1 | `tools/coordination-tools.ts:6` |
| `analyze_workload` | B1 | `tools/analysis-tools.ts` (team_lead) |
| `query_budget` | B1 | `tools/query-tools.ts:104` (team_lead) |
| `query_agents` | B1 | `tools/query-tools.ts:60` |
| `list_approvals` | B2 (Task 2) | new — surfaces "waiting on you" |
| `query_company` | Have | `tools/query-tools.ts:146` |

**Surface-agnostic body outline** (intent-first; real names live in the per-surface cheat-sheet, not hardcoded in prose):
1. **Ground role + identity.** Read who the user is (role) and the company frame. Founders and team_leads get org-wide triage; team_members get their own lane.
2. **Gather the attention set** (reads only, in one pass): open/in-progress tasks, blocked tasks + their dependency chains, goals that are `at_risk`; for founder/lead the workload-balance signal; and — **for the founder** — open approvals waiting on a decision (`list_approvals` is founder-only in R1; a lead's call is role-gated, so skip it silently for leads, per the role-gate rule below).
3. **Rank by what needs a human.** Order: (a) decisions only you can make (open approvals, `ask_founder` items), (b) blockers you can clear, (c) at-risk goals, (d) your next unblocked task. Show at most 5–7 items.
4. **Offer one next action per item** — a handoff to `delegate-handoff`, opening a task, or deciding an approval. Do not act; propose.
5. **Stop.** This skill never writes. If the user picks an action, hand to the relevant skill.

**Acceptance criteria:**
- Given a founder with 2 blocked tasks + 1 open approval, the skill (in a dogfood run) reads tasks/goals/approvals and returns a ranked ≤7-item list with the approval and blockers surfaced first, and creates/changes nothing.
- Given a `team_member`, it does **not** call `query_budget`/`analyze_workload`/`list_approvals` (role-gated) and still returns a personal task list without an authorization error surfacing to the user.
- `validate.ts` passes on `skills/daily-triage.md` (all referenced tool names in `VALID_TOOLS`).

**Triggering-eval case** (Plan-2 harness): `{ prompt: "what should I focus on today?", expectSkillKey: "skill:aoa/daily-triage" }` (plus a negative: `"create a task to fix the login bug"` must **not** fire it).

- [ ] Create `skills/daily-triage.md` in AoA-Skills:
  ```markdown
  ---
  name: aoa-daily-triage
  description: When the user asks what to work on, what needs their attention, what is blocked or at risk, or how a department or the company is doing right now — a status/prioritization ask, not a request to change anything.
  requires: aoa-mcp
  key: skill:aoa-curated/aoa-daily-triage
  ---

  ## Prerequisites
  Install AoA MCP: `npx @armyofagents/mcp`
  Tools used (see your surface's tool cheat-sheet for exact names): read tasks, read goals, read the dependency chain of a blocked task, read workload balance, read the budget summary, read agents, list open approvals, read company identity.

  # Daily Triage

  ## When to use
  Fire when the user asks "what should I work on", "what needs me", "what's blocked", "how are we doing", or any status/prioritization question. This is a **read-only** skill — it surfaces and ranks; it never creates or changes anything.

  ## Degrees of freedom
  Flexible. Adapt the reads and ordering to the user's role and what the data shows. Do not run a fixed script.

  ## Process

  ### Step 1 — Ground role + identity
  Read the company identity and note the user's role.
  - Founder / team lead → triage the whole org (or their departments).
  - Team member → triage only their own lane.

  ### Step 2 — Gather the attention set (one read pass, no writes)
  Pull: open and in-progress tasks; blocked tasks and, for each, its dependency chain; goals that are at risk. For founders and team leads also pull the workload-balance signal. For the founder, also pull open approvals waiting on a decision (this read is founder-only in R1; if a lead runs the skill, skip it silently per the role-gate rule).

  ### Step 3 — Rank by what needs a human
  Order the list:
  1. Decisions only this user can make (open approvals; questions waiting on the founder).
  2. Blockers this user can clear.
  3. At-risk goals.
  4. Their next unblocked task.
  Show at most 5–7 items. If nothing needs them, say so plainly.

  ### Step 4 — One next action per item
  For each surfaced item, offer exactly one next move (hand off the work, open the task, decide the approval). Propose — do not act.

  ## Rules
  - Never call a write tool in this skill.
  - Respect role gates — if a read is not permitted for this user, skip it silently; do not surface an authorization error as the answer.
  - One recommendation per item. No caveat stacking.
  - If the user picks an action, hand to the matching skill (e.g. Delegate & Handoff, Review Agent Output) — don't inline it.
  ```
- [ ] Add the Commander-flavored twin to `AOA_NATIVE_SKILLS` in `server/src/services/internal-agent/aoa-skills-seeder.ts` — key `skill:aoa/daily-triage`, name `Daily Triage`, `triggerPhrases` (kept for legacy/marketplace but note Plan-2 leans on `description`): `["what should I work on", "what needs me", "what's blocked", "how are we doing", "triage my day"]`, and the same body with Commander tool names inline where the repo body says "read tasks / list open approvals" (`query_tasks`, `query_goals`, `query_dependency_chain`, `analyze_workload`, `query_budget`, `query_agents`, `list_approvals`, `query_company`).
- [ ] Add the entry to `catalog/skills.json`.
- [ ] Add the triggering-eval case (positive + negative) to the Plan-2 harness fixture.
- [ ] Verify (see "Skill verification" block at the end of the plan).

---

## Task 5 — [skills-repo + product] Skill: **Review Agent Output** (B1 + B2)

**WHEN-only description:**
> "When the user wants to review what an agent produced on a task — check its deliverable or diff against the acceptance criteria and decide whether to approve it or send it back — before an approval is granted."

**Rigid/flexible label:** *Rigid on the gate, flexible on the read* — the acceptance-criteria check and the approve-or-revise decision are a fixed spine (never approve without checking criteria); how you inspect the artifact is flexible.

**Tools it teaches:**
| Tool | Tier | Registry ref |
|---|---|---|
| `get_task` | Have | `tools/get-task-tool.ts:22` (acceptance criteria = task description) |
| `get_heartbeat_context` | B2 (Task 3) | new — reads the run-summary comment (what the agent did) |
| `query_company_artifacts` | B1 | `tools/artifact-query-company.ts:13` |
| `read_file` | B1 | `tools/file-tools.ts:6` |
| `create_artifact_version` | B1 | `tools/artifact-create-version.ts:16` (the "revise" path) |
| `list_approvals` / `get_approval` | B2 (Task 2) | find the gating approval |
| `approval_decision` | B2 (Task 2) | approve / requestRevision (founder-only, confirmed) |
| `post_task_comment` | Have | `tools/post-task-comment-tool.ts:27` (leave review notes) |

**Surface-agnostic body outline:**
1. **Load the contract.** Read the task (title, description = the acceptance criteria, `artifactId`) and its recent run context (the run-summary comment tells you what the agent claims it did).
2. **Load the deliverable.** From the task's artifact (or the company artifact list), read the current version's content; if the work is files, read them.
3. **Check against criteria, point by point.** For each acceptance criterion, state met / not-met / unclear with the evidence line. No vibes — cite the artifact.
4. **Decide.** If every criterion is met → propose approving the gating approval (founder confirms). If gaps → summarize them as a revision request: post the review notes to the task and, if the fix is small and structured, offer a corrected artifact version; then request revision on the approval.
5. **Never approve on trust.** If you cannot find the acceptance criteria or the deliverable, say so and stop — do not approve.

**B3 decision (run-history) — resolved: DEFER.** Review needs "what did the agent do + does the output meet the bar." The *output* comes from the artifact; the *what-it-did* comes from the auto-run-summary comment already surfaced by `get_heartbeat_context` (Task 3). The acceptance criteria are the task description. All three are reachable without reading `heartbeat_runs`/`heartbeat_run_events`. **Therefore the run-history tool is NOT required for R1 and is deferred to R2 (Task 8 stays unbuilt) unless the dogfood check below fails its criterion.**

**Acceptance criteria:**
- Dogfood: given a task with an artifact and a run-summary comment, the skill reads the task + artifact + `get_heartbeat_context`, produces a per-criterion met/not-met table, and routes to either `approval_decision(approve)` (confirmed) or a revision (task comment + `requestRevision`) — **without** any `heartbeat_runs` read.
- If a criterion cannot be evaluated from artifact + comments alone, the skill stops and reports the gap (does not approve).
- `validate.ts` passes.

**B3 go/no-go criterion (evaluated at this task's dogfood):** *Build `list_agent_runs` (Task 8) only if the reviewer cannot determine whether the deliverable meets the acceptance criteria from `get_task` + `query_company_artifacts`/`read_file` + `get_heartbeat_context` alone — i.e. the needed evidence lives only in `heartbeat_run_events` and never reaches a task comment or artifact.* Default expectation: criterion NOT tripped → defer.

**Triggering-eval case:** `{ prompt: "can you check the work the coder agent did on the auth task?", expectSkillKey: "skill:aoa/review-agent-output" }` (negative: `"what's blocked?"` → daily-triage, not this).

- [ ] Create `skills/review-agent-output.md`:
  ```markdown
  ---
  name: aoa-review-agent-output
  description: When the user wants to review what an agent produced on a task — check its deliverable or diff against the acceptance criteria and decide whether to approve it or send it back — before an approval is granted.
  requires: aoa-mcp
  key: skill:aoa-curated/aoa-review-agent-output
  ---

  ## Prerequisites
  Install AoA MCP: `npx @armyofagents/mcp`
  Tools used (see your surface's cheat-sheet for exact names): read the task, read its recent run context (task comments incl. the run summary), list/read the company's artifacts, read a file, add a new artifact version, list/read approvals, decide an approval, comment on a task.

  # Review Agent Output

  ## When to use
  Fire when the user asks you to review, check, or sign off on what an agent produced on a task — before an approval is granted. Not for status ("what's blocked" → Daily Triage) and not for handing out new work (→ Delegate & Handoff).

  ## Degrees of freedom
  Rigid on the gate: never approve without checking the deliverable against the acceptance criteria. Flexible on how you inspect the artifact.

  ## Process

  ### Step 1 — Load the contract
  Read the task: its title, description (this is the acceptance criteria), and its linked artifact. Read the task's recent comments — the agent's auto-generated run summary tells you what it claims it did (outcome, files touched, cost).

  ### Step 2 — Load the deliverable
  From the task's artifact (or the company artifact list), read the current version's content. If the work is files, read them.

  ### Step 3 — Check against criteria, point by point
  For each acceptance criterion, state **met / not-met / unclear** with the evidence — cite the artifact line or the run summary. Do not judge on impression.

  ### Step 4 — Decide
  - **All criteria met** → propose approving the gating approval. The decision is founder-only and confirmed; show the summary before it runs.
  - **Gaps** → write the gaps as review notes on the task. If the fix is small and structured, offer a corrected artifact version. Then request revision on the approval.

  ### Step 5 — Never approve on trust
  If you cannot locate the acceptance criteria or the deliverable, say so and stop. A missing artifact is a not-met, not an approve.

  ## Rules
  - Approving is founder-only and irreversible — always show what you are approving and wait.
  - Cite evidence for every met/not-met call.
  - One decision per review. If the user wants changes, route to revision, don't silently approve a subset.
  ```
- [ ] Add the Commander-flavored twin to `AOA_NATIVE_SKILLS` (key `skill:aoa/review-agent-output`, name `Review Agent Output`, triggerPhrases `["review the agent's work", "check what the agent did", "sign off on", "is this ready to approve", "did the agent finish"]`, Commander tool names inline: `get_task`, `get_heartbeat_context`, `query_company_artifacts`, `read_file`, `create_artifact_version`, `list_approvals`, `get_approval`, `approval_decision`, `post_task_comment`).
- [ ] Add to `catalog/skills.json` + Plan-2 eval fixture.
- [ ] **Run the B3 go/no-go at the dogfood check.** Record the verdict in the PR description. Default: defer (Task 8 unbuilt).
- [ ] Verify (skill verification block).

---

## Task 6 — [skills-repo + product] Skill: **Delegate & Handoff** (Have)

**WHEN-only description:**
> "When the user is ready to hand a piece of work to an agent — pick the right agent, write a clear task spec, set what it depends on, and dispatch it. The planning→execution bridge, after the idea is shaped and before the agent runs."

**Rigid/flexible label:** *Rigid on the spec quality gate + confirm-before-dispatch, flexible on agent selection reasoning.*

**Tools it teaches:**
| Tool | Tier | Registry ref |
|---|---|---|
| `query_agents` | Have | `tools/query-tools.ts:60` (candidate agents) |
| `analyze_workload` | B1 | `tools/analysis-tools.ts` (who is free) |
| `query_tasks` | Have | avoid duplicating in-flight work |
| `create_task` | Have | `tools/action-tools.ts:7` |
| `assign_task` | Have | `tools/action-tools.ts:155` |
| `add_task_dependency` | Have | `tools/workflow-tools.ts:44` |
| `wakeup_agent` | Have | `tools/action-tools.ts:175` (dispatch) |

> Note on trust: agent trust score is not yet a Commander tool (B3, R2). For R1 the skill selects on **workload + department fit + stated skills** from `query_agents`, and names trust as a factor the founder weighs manually. Do not reference a `query_trust` tool — it does not exist.

**Surface-agnostic body outline:**
1. **Confirm the work is ready to delegate.** There must be a shaped ask (from brainstorm/spec/sprint-planning). If it is still a rough idea, hand back to the thinking-partner skill.
2. **Pick the agent.** Read the candidate agents and current workload; match on department/function fit, free capacity, and stated skills. Propose one agent with a one-line why.
3. **Write the spec.** Draft a task with a verb-noun title, a description that states *what done looks like* (the acceptance criteria the reviewer will later check), priority, and any inputs/artifacts. Show it before creating.
4. **Set dependencies.** If this work is blocked by other tasks, link them so it won't dispatch early.
5. **Hand off (confirmed).** On approval: create the task, assign the agent, add dependencies, then dispatch. Each write is confirmed; show the final plan before the first create.

**Acceptance criteria:**
- Dogfood: from a shaped ask, the skill proposes one agent (with reasoning tied to workload/fit), shows a full task spec with explicit "done looks like" criteria, and — only after confirmation — creates + assigns + links deps + dispatches. No write happens before the plan is shown.
- If asked to delegate a still-rough idea, it declines and routes to Brainstorm/Office Hours.
- `validate.ts` passes.

**Triggering-eval case:** `{ prompt: "hand the checkout redesign off to one of the design agents", expectSkillKey: "skill:aoa/delegate-handoff" }` (negative: `"should we even build checkout redesign?"` → office-hours).

- [ ] Create `skills/delegate-handoff.md`:
  ```markdown
  ---
  name: aoa-delegate-handoff
  description: When the user is ready to hand a piece of work to an agent — pick the right agent, write a clear task spec, set dependencies, and dispatch it. The planning→execution bridge, after the idea is shaped and before the agent runs.
  requires: aoa-mcp
  key: skill:aoa-curated/aoa-delegate-handoff
  ---

  ## Prerequisites
  Install AoA MCP: `npx @armyofagents/mcp`
  Tools used (see your surface's cheat-sheet for exact names): read agents, read workload balance, read tasks, create a task, assign a task, add a task dependency, wake up an agent.

  # Delegate & Handoff

  ## When to use
  Fire when the user wants to give work to an agent — "hand this to…", "assign…", "get an agent on…". This is the bridge from a shaped plan to a running agent. If the idea is still rough, this is the wrong skill — route to Brainstorm or Office Hours first.

  ## Degrees of freedom
  Rigid: the spec must state what "done" looks like, and nothing is created or dispatched before the user confirms the plan. Flexible: how you reason about which agent fits.

  ## Process

  ### Step 1 — Confirm it's ready to delegate
  There must be a shaped ask. If it's a rough idea, stop and hand to the thinking-partner skill.

  ### Step 2 — Pick the agent
  Read the candidate agents and their current workload. Match on department/function fit, free capacity, and stated skills. Propose ONE agent with a one-line reason. (Trust score is not yet readable here — name it as a factor the founder weighs, don't invent a tool for it.)

  ### Step 3 — Write the spec
  Draft the task: a verb-noun title, a description that states exactly what done looks like (these become the acceptance criteria a reviewer checks later), priority, and any input artifacts. Show the full spec before creating anything.

  ### Step 4 — Set dependencies
  If other tasks must finish first, link them so this won't dispatch early.

  ### Step 5 — Hand off (confirmed)
  On approval: create the task, assign the agent, add the dependencies, then dispatch. Each write is confirmed — show the final plan before the first create call.

  ## Rules
  - No write before the plan is shown and approved.
  - A spec without "done looks like" is not ready — write it before dispatching.
  - Propose one agent, not a menu, but say why.
  ```
- [ ] Add the Commander-flavored twin to `AOA_NATIVE_SKILLS` (key `skill:aoa/delegate-handoff`, name `Delegate & Handoff`, triggerPhrases `["hand this to", "assign this to", "get an agent on", "delegate", "who should do this"]`, inline names `query_agents`, `analyze_workload`, `query_tasks`, `create_task`, `assign_task`, `add_task_dependency`, `wakeup_agent`).
- [ ] Add to `catalog/skills.json` + Plan-2 eval fixture.
- [ ] Verify.

---

## Task 7 — [skills-repo + product] Harden **Thinking Partner** (brainstorm + office-hours) (Have)

**Goal:** make the two existing idea-shaping skills *critical* (not sycophantic) and *memory-grounded* (pull company memory before opining). Also fix the live phantom: `office-hours.md` currently references `create_memory` (does not exist) — change to `suggest_memory`.

**Rigid/flexible label:** *Flexible* conversation, with one *rigid* rule added: pull memory before forming an opinion, and push back at least once.

**Tools added/kept:**
| Tool | Tier | Registry ref |
|---|---|---|
| `query_company` | Have | `tools/query-tools.ts:146` |
| `query_memory` | Have | `tools/memory-tools.ts:62` |
| `find_similar_memory` | Have | `tools/memory-tools.ts:317` |
| `suggest_memory` | Have | `tools/memory-tools.ts:263` (replaces phantom `create_memory`) |

**Changes to make (both files, repo + seeder):**
1. **Memory-grounding (new Step 0):** before probing, pull identity-layer memory and any similar prior decisions (`query_memory` + `find_similar_memory`). If the idea contradicts a locked decision or repeats a parked idea, say so up front.
2. **Critical stance (rewritten Rules):** replace the "the goal is to sharpen, not kill" softening with a genuine devil's-advocate mandate — the model must name the weakest assumption and push back on it at least once, and must not validate an idea it has not stress-tested. Keep SOUL.md's "one voice, no lecture": push back once, clearly, then move on — no rationalization tables, no "YOU MUST" scolding.
3. **Phantom fix:** `office-hours.md` Step 4(c) and its Prerequisites line — `create_memory` → `suggest_memory`, and keep the PENDING language ("suggested for memory — appears in the Memory panel for approval").
4. **Seeder parity:** update the `brainstorm` markdown in `AOA_NATIVE_SKILLS`, and **add** an `office-hours` entry to the seeder (it is currently repo-only, so the live Commander cannot run the hardened version otherwise). Key `skill:aoa/office-hours`.

**Acceptance criteria:**
- Both skills, in a dogfood run, call a memory read before giving any opinion, and each surfaces at least one explicit pushback on the user's weakest assumption.
- No occurrence of `create_memory` remains in either file (or anywhere in `skills/` or the seeder) — `grep -rn create_memory` returns nothing in changed files.
- `validate.ts` passes with `suggest_memory` accepted (depends on Plan-1's de-inverted allowlist).

**Triggering-eval cases (unchanged keys):** `{ prompt: "I want to build a Slack integration", expectSkillKey: "skill:aoa/brainstorm" }` and `{ prompt: "should we even do the enterprise tier?", expectSkillKey: "skill:aoa/office-hours" }`.

- [ ] Edit `skills/brainstorm.md`: add **Step 0 — Ground in memory** (pull identity memory + similar prior ideas before probing; flag contradictions/duplicates), and rewrite the **Rules** section:
  ```markdown
  ## Rules
  - Ground before you opine: pull company identity + similar prior decisions from memory before your first reaction. If this idea contradicts a locked decision or repeats a parked one, say so immediately.
  - Be a critical partner, not a cheerleader. Name the single weakest assumption and push back on it at least once. Do not validate an idea you have not stress-tested.
  - One pushback, said once, clearly — then move on. No lectures, no stacked caveats.
  - Do NOT create tasks or call write tools during this skill.
  ```
- [ ] Edit `skills/office-hours.md`: add the same Step 0 grounding (it already reads `query_memory` — extend to `find_similar_memory` and require it *before* Q1); rewrite Step 4(c) and Prerequisites to use `suggest_memory`; add a Rule matching the "critical, one-pushback" stance above.
- [ ] Mirror both into `AOA_NATIVE_SKILLS` (replace `brainstorm` body; add `office-hours` entry with the hardened body + `query_company`/`query_memory`/`find_similar_memory`/`suggest_memory` inline).
- [ ] `grep -rn "create_memory" skills/ server/src/services/internal-agent/aoa-skills-seeder.ts` → **no matches** in the files you changed.
- [ ] Verify.

---

## Task 8 — [product] CONDITIONAL / DECISION-GATED: `list_agent_runs` run-history read (B3)

> **Default: DO NOT BUILD. Deferred to R2.** Build this **only if** the Task-5 dogfood trips the go/no-go: *review-agent-output cannot determine whether a deliverable meets its acceptance criteria from `get_task` + `query_company_artifacts`/`read_file` + `get_heartbeat_context` alone — i.e. the decisive evidence lives only in `heartbeat_run_events` and never reaches a task comment or artifact.* Record the verdict in the PR before either building or skipping. The auto-run-summary comment (already surfaced by `get_heartbeat_context`) is expected to satisfy the reviewer, so the default expectation is "not tripped."

If (and only if) tripped:

**Files:**
- Service already exists: `server/src/services/heartbeat.ts:5418` (`list(companyId, agentId?, limit?)`), `getRun`, `:5506` (`listEvents(runId, afterSeq, limit)`).
- Schema: `packages/db/src/schema/` (`heartbeat_runs`, `heartbeat_run_events`).

- [ ] TDD: `server/src/services/internal-agent/tools/__tests__/agent-runs-tool.test.ts` — happy-path list shape, company scoping via `agentId` ownership check, and a single-run detail (`listEvents`) path.
- [ ] Create `server/src/services/internal-agent/tools/agent-runs-tool.ts` — `list_agent_runs`:
  - `category: "query"`, `requiredRole: "team_lead"`, `requiresConfirmation: false`.
  - params: `{ agentId?: string, runId?: string, limit?: number }`.
  - with `runId` → `getRun` + `listEvents` (verify the run's `companyId === ctx.companyId`; NOT_FOUND on mismatch); else `list(ctx.companyId, agentId, limit)`.
  - Return compact `{ id, agentId, taskId, status, startedAt, endedAt, tokenUsage, costCents, outcome }` rows — never raw event blobs unless a `runId` is given.
- [ ] Register in `tool-registry.ts`. Run test → green. `tsc --noEmit`.
- [ ] Regenerate the contract + resync: after `list_agent_runs` is registered in `createToolRegistry()`, run `pnpm gen:tools` then `pnpm sync:skills -- <skills-repo>` so it lands in `generated/tools.json` + the `validate.ts` allowlist (`surface: commander`, `mcpAlias: null` — no MCP twin exists, `requiredRole: team_lead`). Then update the review + daily-triage skill "Tools used" lines to reference it.

---

## Skill verification (run for Tasks 4–7)

For each skill file changed, run all three gates:

- [ ] **Plan-1 `validate.ts`** (in the AoA-Skills repo). **Precondition:** the Task-2/Task-3 regen+resync (`pnpm gen:tools` → `pnpm sync:skills`) has run, so the 6 ported commander-surface names are in the vendored `generated/tools.json` allowlist. Then:
  ```
  bun run validate.ts skills/
  ```
  Expected: `✅ Validated N files — 0 tool name errors found.` (requires Plan-1's de-inverted, regenerated `VALID_TOOLS` including the 6 ported names + `suggest_memory`).
- [ ] **Triggering-eval** (Plan-2 harness, product side) — the positive case fires the right `use_skill` key and the negative case does not:
  ```
  cd server && pnpm exec vitest run <plan-2-triggering-eval-spec>
  ```
  Expected: the new case(s) pass.
- [ ] **Manual dogfood** — in a local isolated Commander instance (see MEMORY "QA isolated main instance"), give the naive prompt and confirm: the right skill loads, it uses only tools it names, it respects the confirm-gate on writes, and (for triage/review) it reads before it recommends. Capture the transcript in the PR.

---

## Self-Review

**Spec coverage vs scope §5 (WS-2) and §5/§6 (WS-3 B1/B2/B3):**
- WS-2 skill 1 (daily-triage/org-awareness, B1) → Task 4. ✅
- WS-2 skill 2 (review-agent-output, B1 + later B3) → Task 5, with B3 explicitly decision-gated (Task 8) and defaulted to deferred. ✅
- WS-2 skill 3 (delegate-handoff, Have) → Task 6. ✅
- WS-2 skill 4 (harden thinking-partner, Have) → Task 7, including the live `create_memory`→`suggest_memory` phantom fix in `office-hours`. ✅
- WS-3 **B1** (list the untaught existing tools each skill teaches, verified vs registry) → per-skill "Tools it teaches" tables, every name verified against a `tools/*.ts:line`. ✅
- WS-3 **B2** (port Approval family + `get-heartbeat-context` as Commander `AgentTool`s wrapping existing handlers, with tests) → Tasks 1–3. ✅ (Document family from §5's B2 list is **not** ported — no R1 skill reaches for it; noted as R2.)
- WS-3 **B3** (run-history read, explicit go/no-go, default defer) → Task 8 with a stated criterion. ✅

**Placeholder scan:** no `TODO`, `TBD`, `<placeholder>`, or `...`-as-code in tool implementations; skill bodies are complete and droppable. The only intentionally-abstract reference is the **Plan-2 triggering-eval fixture path** (owned by Plan 2 — cross-plan contract) — flagged, not invented.

**Tool-name consistency vs the real registry (75 tools, verified this session):**
- Every "Have/B1" tool named exists: `query_tasks`, `query_goals`, `query_agents`, `query_budget`, `query_company`, `query_dependency_chain`, `analyze_workload`, `create_task`, `assign_task`, `wakeup_agent`, `add_task_dependency`, `get_task`, `post_task_comment`, `query_company_artifacts`, `read_file`, `create_artifact_version`, `query_memory`, `find_similar_memory`, `suggest_memory`. ✅
- New B2 names are snake_case (registry convention), distinct from the pre-existing kebab MCP-surface tools; they reach Plan-1's `tools.json` automatically via `pnpm gen:tools` (live-registry read) — `mcpAlias` stays `null` per scope §WS-0, not hand-populated. ✅
- **No reference to the phantom `create_memory` anywhere** in this plan; the memory-write tool is `suggest_memory`. ✅
- The plan does **not** invent `query_trust`/`query_runs` in any shipped R1 skill (trust is called out as manual; run-history is gated). ✅

**Known risks / deliberate simplifications flagged for review:**
1. **RBAC divergence (highest-signal):** the Commander approval port gates **both the reads and the decision at `founder-only`** for R1, and does **not** replicate the MCP surface's per-project `team_lead` scoping — Commander's `ToolContext` has no team_lead authorization project SET (`contextScope.projectId` is a UI hint, not an authz boundary). Founder-only avoids widening authority; team-lead parity needs a project-scope resolver mirroring `approvalHasScopedIssueLink` and is deferred to R2. A conscious call, not an oversight.
2. **Two-copy skill maintenance:** every skill is authored twice (repo + seeder). Plan-1 Task 7 lands the `AOA_NATIVE_SKILLS` generator (repo → seeder, with the `skill:aoa-curated/aoa-<name>` → `skill:aoa/<name>` key mapping), so the seeder edits here become the generator's input instead of hand-copies — reconcile at integration.
3. **`logActivity` signature:** the port assumes the same shape as the MCP handler; verify against the actual export and drop agent/run fields for the user-driven Commander path.

---

## Open questions / surprises (for the requester)

1. **Is B3 run-history truly needed for review-agent-output?** **Finding: no, for R1.** AoA auto-posts a run-summary comment (outcome/duration/cost/files) to the task after every heartbeat/crew run, and `get_heartbeat_context` (Task 3) returns the last 10 task comments — so "what did the agent do" is already reachable, and "does the output meet the bar" comes from the artifact + task description. The plan defaults Task 8 to **deferred** and only builds it if the Task-5 dogfood proves the decisive evidence lives *only* in `heartbeat_run_events`. Please confirm you're comfortable shipping R1 without run-history.
2. **Does porting the Approval family raise RBAC concerns?** **Yes, one — flagged above.** The MCP surface scopes team-lead approvals to their projects; Commander has no team_lead authorization project set, so R1 makes **both the reads and the decision founder-only** (team_lead parity deferred to R2 behind a project-scope resolver). Confirm this is the desired R1 posture vs. investing in a Commander project-scope resolver now.
3. **Seeder vs. repo source of truth for skills:** the scope's Decision #5 makes `onboarding-assets/commander/*` canonical for *instruction files*, but *skills* have two runtime homes (repo `skills/*.md` and the product `AOA_NATIVE_SKILLS` seeder). This plan updates both. **Resolved for planning:** Plan-1 Task 7 lands the repo → seeder generator, so post-integration these stop being hand-mirrored (this plan's seeder edits become the generator's input).
4. **`office-hours` is not in the product seeder today** — only in the repo. Hardening it for the *live* Commander requires adding it to `AOA_NATIVE_SKILLS` (done in Task 7). Confirm you want office-hours to become a seeded native Commander skill (vs. marketplace-install only).
