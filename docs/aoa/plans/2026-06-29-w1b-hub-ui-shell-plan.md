# W1b Hub UI Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first user-visible Inbox/Approvals Hub shell on top of W1a, including source remap/emission for the headline lanes, a preview route, lane navigation, the registry-backed list/viewer, Home overview, and Approvals reachability.

**Architecture:** W1b has two halves. Server-side source producers make old Inbox sources emit into the W1a `hub_items` index, preserving the old categories without reading six source tables from the UI. Client-side hub UI reads only W1a hub routes through a new API client, uses a registry total over `HUB_SEMANTIC_TYPES`, and mounts behind a preview route until the final cutover switches `/inbox`.

**Tech Stack:** Express 5 + Drizzle service tests, shared TypeScript contracts, React + Vite + TanStack Query, Vitest + Testing Library, Playwright e2e.

---

## Scope

In scope:

- Source coverage/remap matrix for old `Inbox.tsx` categories.
- Server source producers for W1b-owned hub items:
  - approvals -> `approval_request`
  - join requests -> `join_request`
  - pending discussions -> `discussion_pending`
  - pending suggestions -> `suggestion`
  - stale tasks/issues -> `stale_work`
  - old thread notification subtypes -> existing hub notification semantic types or explicit tested deferrals
- Reconciler fixes/additions so source terminal state closes hub rows.
- UI API client for W1a hub routes.
- UI registry total over `HUB_SEMANTIC_TYPES`.
- Preview route for the new hub shell, mounted without replacing old `/inbox`.
- Three-pane shell: rail, center list/Home, collapsible tabbed viewer.
- Basic viewer composition/summaries with `Open full` escape routes.
- Approvals sidebar reachability.
- W1b e2e smoke for lane navigation and seeded item selection.
- Old Inbox parity contract tests. W1b may ship the preview route with explicitly deferred sources, but final `/inbox` cutover remains blocked until every old source is either represented in hub rows or intentionally removed by a tested product decision.

Out of scope:

- Final `/inbox` cutover.
- Snooze-return UI, undo timer, bulk actions, history, claiming, reassign/escalate.
- Realtime.
- Autopilot policy/autonomy.
- Steward agent.
- W5 runtime prompt bridges.

## Route Decision

W1b mounts the new hub at:

- `/:companyPrefix/inbox-hub`
- `/:companyPrefix/inbox-hub/:lane`
- `/:companyPrefix/inbox-hub/:lane/:itemId`

The old routes stay live:

- `/:companyPrefix/inbox/new`
- `/:companyPrefix/inbox/all`

Final cutover later moves the hub to `/inbox` and redirects legacy `new/all`.

## Source Remap Matrix

| Old Inbox source | W1b hub semantic type | Lane | W1b action |
|---|---|---|---|
| actionable approvals | `approval_request` | Waiting on you | emit on create/resubmit; reconcile pending/revision_requested vs terminal |
| pending join requests | `join_request` | Waiting on you | emit on request creation; reconcile approved/rejected terminal |
| discussions with `pendingItemCount > 0` | `discussion_pending` | Waiting on you | emit transactionally when pending count increases; preserve `ownerUserId`/scope/actor; reconcile count zero terminal |
| thread human input notification | `human_input_needed` | Waiting on you | verify W1a notification emit path; if missing, add adapter in W1b |
| thread scope proposal notification | `scope_proposal` | Waiting on you | verify W1a notification emit path; if missing, add adapter in W1b |
| `thread.artifact_needs_review` notification | `legacy_other` unless a stronger semantic type exists | Notifications | verify source parity; emit from notification bridge or record explicit tested defer |
| `thread.crew_failed` notification | `agent_error` | Notifications | verify source parity; emit from notification bridge or record explicit tested defer |
| `thread.spinoff_suggested` notification | `proactive` or `suggestion` | Suggestions | verify source parity; emit from notification bridge or record explicit tested defer |
| failed runs | `run_failed` | Notifications | W1a heartbeat/run-related source remains supported; registry/viewer only unless tests expose missing emit |
| alerts / agent errors / budget | `agent_error` / `budget_alert` / `legacy_other` | Notifications | registry/viewer only in W1b |
| mentions | `mention` | Notifications | W1a emit path already migrated mentions |
| run complete | `run_complete` | Notifications | registry/viewer only in W1b |
| stale work from old `issuesApi.list` staleness calculation | `stale_work` | Suggestions | emit from a real stale issue/task producer, not suggestion category aliasing; reconcile when issue is resolved, assigned to crew, or no longer stale |
| suggestion engine rows | `suggestion` | Suggestions | emit from `suggestionService` insert/update lifecycle |
| my recent tasks | none | none | intentionally removed; Tasks page owns this |

## Ownership And Lifecycle Rules

- All source producers must pass the same company ID as the source row. Cross-company source IDs must be rejected by existing route/service access checks before hub emission is attempted.
- Natural-owner rows must set `ownerUserId` when the source has an accountable human. Pool-owned rows must set `ownerPool: "board"` only when the source is genuinely founder/board-gated.
- Pending discussions must preserve `ownerUserId` from `discussions.ownerUserId` when present, `scopeKey` from the discussion/project/department scope when available, and source actor fields from the actor that created or last added pending work when known. They must not silently fall back to founder ownership unless the source itself is unowned.
- Source mutation and hub emission/reconciliation must happen in one transaction whenever the source service already has a transaction boundary. Pass `executor: tx as unknown as Db` to `hubItemsService.emit`/`reconcile` in those flows.
- Every producer/reconciler must be idempotent. Duplicate emits for the same company/source/type/scope refresh the existing hub row rather than creating duplicate visible rows.
- Approval summaries must be purpose-built strings, not raw `JSON.stringify(payload)`. Include only human-readable safe fields needed to identify the request.

## Route And List Contracts

- UI route slugs are stable display slugs, not API enum values:
  - `home` or no slug -> Home
  - `waiting` -> `waiting_on_you`
  - `notifications` -> `notifications`
  - `suggestions` -> `suggestions`
- Unknown lane slugs redirect to `/:companyPrefix/inbox-hub` or render a not-found state; they must not call the API with invalid lane values.
- W1b must not render or request an unbounded list. Add a shared/server/client `limit` query option capped at 50 for preview lanes. W1d can replace this with maintained counters/cursors.
- Registry `fullLink` targets must be audited against `ui/src/App.tsx`. If a semantic type lacks enough source metadata to build a valid route, return `null` and show only the generic viewer until a later source-specific resolver exists.

## File Map

Server:

- Create `server/src/services/hub-source-producers.ts`
  - Source-specific emit helpers, summary builders, and source lifecycle helpers.
- Modify `server/src/services/hub-items.ts`
  - Add W1b reconcilers for `join_request`, `discussion`, `suggestion`, and `issue`.
  - Fix approval reconciler to keep `pending` and `revision_requested` open.
- Modify `server/src/routes/approvals.ts`
  - Emit approval hub item in the same mutation flow as approval creation/resubmission.
  - Close/reconcile approval hub item after approve/reject/request-revision where applicable.
- Modify `server/src/routes/access.ts`
  - Emit join request hub item when a request is created.
  - Reconcile/close on approve/reject.
- Modify `server/src/services/discussions.ts`
  - Emit pending discussion item after pending count increases.
  - Reconcile/close when pending count reaches zero.
- Modify `server/src/services/internal-agent/tools/submit-extracted-items.ts`
  - Emit pending discussion item when the tool increments `pendingItemCount`.
- Modify `server/src/services/suggestions.ts`
  - Emit pending suggestion items after insert.
  - Reconcile/close on accept/dismiss/expiry.
- Modify `server/src/services/issues.ts` or add `server/src/services/hub-stale-work.ts`
  - Emit `stale_work` hub items from the same stale issue conditions old Inbox used.
  - Reconcile stale issue items when issues resolve, become crew-assigned, or become fresh.
- Modify notification emit path if parity tests show raw old thread notification types do not enter `hub_items`.
  - Map `thread.artifact_needs_review`, `thread.crew_failed`, and `thread.spinoff_suggested`.
- Tests:
  - `server/src/__tests__/hub-old-inbox-parity.test.ts`
  - `server/src/__tests__/hub-source-producers.test.ts`
  - `server/src/__tests__/hub-source-producers.integration.test.ts`
  - updates to affected route/service tests when mocks need the new hub service.

Client:

- Create `ui/src/api/hub-items.ts`
- Modify `ui/src/api/index.ts`
- Modify `ui/src/lib/queryKeys.ts`
- Create `ui/src/components/hub/hubTypes.ts`
- Create `ui/src/components/hub/hubRegistry.tsx`
- Create `ui/src/components/hub/HubRail.tsx`
- Create `ui/src/components/hub/HubList.tsx`
- Create `ui/src/components/hub/HubHome.tsx`
- Create `ui/src/components/hub/HubViewer.tsx`
- Create `ui/src/components/hub/HubShell.tsx`
- Create `ui/src/pages/InboxHub.tsx`
- Modify `ui/src/App.tsx`
- Modify `ui/src/components/Sidebar.tsx`
- Tests:
  - `ui/src/api/__tests__/hub-items-api.test.ts`
  - `ui/src/components/hub/__tests__/hubRegistry.test.tsx`
  - `ui/src/components/hub/__tests__/HubShell.test.tsx`
  - `ui/src/__tests__/Sidebar.test.tsx`
  - `ui/src/__tests__/InboxHub.test.tsx`

E2E:

- Create `tests/e2e/inbox-hub-w1b.spec.ts`

Docs:

- Update `docs/aoa/plans/2026-06-29-inbox-hub-integration-roadmap.md` only if execution discovers a phase-boundary change.

---

## Task 0: Preflight Branch And Source Inventory

**Files:**

- Read only: `docs/aoa/plans/2026-06-29-inbox-hub-integration-roadmap.md`
- Read only: `ui/src/pages/Inbox.tsx`
- Read only: `server/src/routes/approvals.ts`
- Read only: `server/src/routes/access.ts`
- Read only: `server/src/services/discussions.ts`
- Read only: `server/src/services/suggestions.ts`

- [ ] **Step 1: Verify branch baseline**

Run:

```sh
git fetch origin
git branch --show-current
git log --oneline --decorate --max-count=5 origin/main
git diff --name-only origin/main...HEAD
```

Expected:

- current branch is `feat/inbox-hub`
- `origin/main` includes PR #243, commit `feat(hub): W1a`
- diff contains only roadmap/plan docs before implementation begins

- [ ] **Step 2: Confirm old Inbox source inventory**

Run:

```sh
rg -n "approvalsApi|listJoinRequests|pendingDiscussions|notificationsApi|heartbeatRuns|staleIssues|touchedIssues|dashboard" ui/src/pages/Inbox.tsx
```

Expected:

- each old Inbox source is found and maps to the Source Remap Matrix above

- [ ] **Step 3: Commit**

No commit for read-only preflight. Record any mismatch by editing this plan before implementation.

---

## Task 0A: Old Inbox Parity Contract

**Files:**

- Create: `server/src/__tests__/hub-old-inbox-parity.test.ts`
- Read only: `ui/src/pages/Inbox.tsx`
- Read only: `ui/src/components/inbox/ThreadNotificationItem.tsx`
- Read only: `packages/shared/src/hub.ts`

- [x] **Step 1: Write the failing parity contract test**

Create `server/src/__tests__/hub-old-inbox-parity.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { HUB_SEMANTIC_TYPES, HUB_SEMANTIC_TO_LANE } from "@armyofagents/shared";

const oldInboxSources = [
  { name: "actionable approvals", semanticType: "approval_request", lane: "waiting_on_you" },
  { name: "pending join requests", semanticType: "join_request", lane: "waiting_on_you" },
  { name: "pending discussions", semanticType: "discussion_pending", lane: "waiting_on_you" },
  { name: "thread.human_input_needed", semanticType: "human_input_needed", lane: "waiting_on_you" },
  { name: "thread.scope_proposal_posted", semanticType: "scope_proposal", lane: "waiting_on_you" },
  { name: "thread.artifact_needs_review", semanticType: "legacy_other", lane: "notifications" },
  { name: "thread.crew_failed", semanticType: "agent_error", lane: "notifications" },
  { name: "thread.spinoff_suggested", semanticType: "proactive", lane: "suggestions" },
  { name: "failed runs", semanticType: "run_failed", lane: "notifications" },
  { name: "budget alerts", semanticType: "budget_alert", lane: "notifications" },
  { name: "agent errors", semanticType: "agent_error", lane: "notifications" },
  { name: "mentions", semanticType: "mention", lane: "notifications" },
  { name: "run complete", semanticType: "run_complete", lane: "notifications" },
  { name: "stale issues", semanticType: "stale_work", lane: "suggestions" },
  { name: "suggestion engine rows", semanticType: "suggestion", lane: "suggestions" },
] as const;

const removedOldInboxSources = [
  {
    name: "my recent tasks",
    reason: "Owned by the Tasks page, not the hub attention queue",
  },
] as const;

describe("old Inbox to hub parity contract", () => {
  it("maps every retained old Inbox source to a known hub semantic type and lane", () => {
    for (const source of oldInboxSources) {
      expect(HUB_SEMANTIC_TYPES).toContain(source.semanticType);
      expect(HUB_SEMANTIC_TO_LANE[source.semanticType]).toBe(source.lane);
    }
  });

  it("keeps intentionally removed old Inbox sections explicit", () => {
    expect(removedOldInboxSources).toEqual([
      {
        name: "my recent tasks",
        reason: "Owned by the Tasks page, not the hub attention queue",
      },
    ]);
  });
});
```

- [x] **Step 2: Run the contract**

Run:

```sh
pnpm -C server exec vitest run src/__tests__/hub-old-inbox-parity.test.ts
```

Expected: PASS once shared semantic mappings are total. This test does not prove emit paths; later integration/e2e tests must prove rows are actually created.

- [ ] **Step 3: Expand integration acceptance from this contract**

For every retained row in `oldInboxSources`, add either:

- a producer/reconciler integration assertion in Task 2 or Task 3, or
- an explicit deferred-source assertion that final `/inbox` cutover remains blocked until that source is implemented.

Do not remove old `Inbox.tsx` or redirect `/inbox` in W1b unless this parity contract and its source-emission integration coverage are green.

Review note: Task 0A locks the source inventory only. Leave this step unchecked until Tasks 2 and 3 add producer/reconciler assertions or explicit final-cutover deferrals for every retained source row.

- [x] **Step 4: Commit**

```sh
git add server/src/__tests__/hub-old-inbox-parity.test.ts
git commit -m "test(hub): lock old Inbox source parity contract"
```

---

## Task 1: Hub Source Producers

**Files:**

- Create: `server/src/services/hub-source-producers.ts`
- Test: `server/src/__tests__/hub-source-producers.test.ts`

- [x] **Step 1: Write the failing unit test**

Create `server/src/__tests__/hub-source-producers.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import {
  buildApprovalHubEmit,
  buildJoinRequestHubEmit,
  buildDiscussionPendingHubEmit,
  buildSuggestionHubEmit,
  buildStaleIssueHubEmit,
} from "../services/hub-source-producers.js";

describe("hub source producers", () => {
  it("maps pending approvals to approval_request in Waiting on you", () => {
    const emit = buildApprovalHubEmit({
      id: "approval-1",
      companyId: "company-1",
      type: "hire_agent",
      status: "pending",
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
      payload: { name: "Scout" },
      createdAt: new Date("2026-06-29T00:00:00Z"),
      updatedAt: new Date("2026-06-29T00:00:00Z"),
    } as never);

    expect(emit).toMatchObject({
      companyId: "company-1",
      semanticType: "approval_request",
      sourceType: "approval",
      sourceId: "approval-1",
      ownerPool: "board",
      sourceActorType: "agent",
      sourceActorId: "agent-1",
    });
    expect(emit.title).toContain("hire agent");
  });

  it("maps join requests to founder-gated join_request items", () => {
    const emit = buildJoinRequestHubEmit({
      id: "join-1",
      companyId: "company-1",
      requestType: "agent",
      status: "pending_approval",
      agentName: "OpenClaw Worker",
      requestEmailSnapshot: null,
      adapterType: "openclaw",
      createdAt: new Date("2026-06-29T00:00:00Z"),
      updatedAt: new Date("2026-06-29T00:00:00Z"),
    } as never);

    expect(emit).toMatchObject({
      semanticType: "join_request",
      sourceType: "join_request",
      sourceId: "join-1",
      ownerPool: "board",
    });
    expect(emit.title).toContain("OpenClaw Worker");
  });

  it("maps pending discussions to discussion_pending items", () => {
    const emit = buildDiscussionPendingHubEmit({
      id: "discussion-1",
      companyId: "company-1",
      title: "Q3 planning",
      ownerUserId: "user-1",
      projectId: "project-1",
      lastPendingActorType: "agent",
      lastPendingActorId: "agent-1",
      pendingItemCount: 3,
      updatedAt: new Date("2026-06-29T00:00:00Z"),
    } as never);

    expect(emit).toMatchObject({
      semanticType: "discussion_pending",
      sourceType: "discussion",
      sourceId: "discussion-1",
      ownerUserId: "user-1",
      scopeKey: "project-1",
      sourceActorType: "agent",
      sourceActorId: "agent-1",
      title: "Review 3 pending items in Q3 planning",
    });
  });

  it("maps pending suggestions to suggestions lane items", () => {
    const emit = buildSuggestionHubEmit({
      id: "suggestion-1",
      companyId: "company-1",
      category: "risk_flag",
      title: "Goal is at risk",
      evidence: "No activity for 14 days.",
      status: "pending",
      createdAt: new Date("2026-06-29T00:00:00Z"),
      updatedAt: new Date("2026-06-29T00:00:00Z"),
    } as never);

    expect(emit).toMatchObject({
      semanticType: "suggestion",
      sourceType: "suggestion",
      sourceId: "suggestion-1",
      title: "Goal is at risk",
      summary: "No activity for 14 days.",
    });
  });

  it("maps stale issues to stale_work without going through suggestions", () => {
    const emit = buildStaleIssueHubEmit({
      id: "issue-1",
      companyId: "company-1",
      title: "Draft launch copy",
      assigneeUserId: "user-1",
      assigneeAgentId: null,
      status: "todo",
      updatedAt: new Date("2026-06-20T00:00:00Z"),
    } as never);

    expect(emit).toMatchObject({
      semanticType: "stale_work",
      sourceType: "issue",
      sourceId: "issue-1",
      ownerUserId: "user-1",
      title: "Stale task: Draft launch copy",
    });
  });
});
```

- [x] **Step 2: Run to confirm it fails**

Run:

```sh
pnpm -C server exec vitest run src/__tests__/hub-source-producers.test.ts
```

Expected: FAIL because `hub-source-producers.ts` does not exist.

- [x] **Step 3: Implement source producer builders**

Create `server/src/services/hub-source-producers.ts`:

```ts
import type { Db } from "@armyofagents/db";
import { hubItemsService, type EmitArgs } from "./hub-items.js";

type ApprovalLike = {
  id: string;
  companyId: string;
  type: string;
  status: string;
  requestedByAgentId: string | null;
  requestedByUserId: string | null;
  payload: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

type JoinRequestLike = {
  id: string;
  companyId: string;
  requestType: string;
  status: string;
  agentName: string | null;
  requestEmailSnapshot: string | null;
  adapterType: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type DiscussionLike = {
  id: string;
  companyId: string;
  title: string | null;
  ownerUserId: string | null;
  scopeType: string | null;
  scopeId: string | null;
  lastPendingActorType?: "user" | "agent" | null;
  lastPendingActorId?: string | null;
  pendingItemCount: number;
  updatedAt: Date;
};

type SuggestionLike = {
  id: string;
  companyId: string;
  category: string;
  title: string;
  evidence: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
};

type IssueLike = {
  id: string;
  companyId: string;
  title: string;
  assigneeUserId: string | null;
  assigneeAgentId: string | null;
  status: string;
  updatedAt: Date;
};

function spaced(value: string) {
  return value.replace(/_/g, " ");
}

function scopeKeyFor(source: { scopeType: string | null; scopeId: string | null }) {
  return source.scopeType && source.scopeId ? source.scopeId : null;
}

function approvalSummary(approval: ApprovalLike) {
  const agentName =
    typeof approval.payload.name === "string"
      ? approval.payload.name
      : typeof approval.payload.agentName === "string"
        ? approval.payload.agentName
        : null;
  return agentName ? `Agent: ${agentName}` : `Approval type: ${spaced(approval.type)}`;
}

export function buildApprovalHubEmit(approval: ApprovalLike): EmitArgs {
  const actor =
    approval.requestedByAgentId != null
      ? ({ sourceActorType: "agent", sourceActorId: approval.requestedByAgentId } as const)
      : approval.requestedByUserId != null
        ? ({ sourceActorType: "user", sourceActorId: approval.requestedByUserId } as const)
        : {};
  return {
    companyId: approval.companyId,
    semanticType: "approval_request",
    sourceType: "approval",
    sourceId: approval.id,
    title: `Review ${spaced(approval.type)} approval`,
    summary: approvalSummary(approval),
    ownerPool: "board",
    ...actor,
    sourcePermissionRevision: approval.updatedAt.toISOString(),
  };
}

export function buildJoinRequestHubEmit(request: JoinRequestLike): EmitArgs {
  const subject =
    request.requestType === "agent"
      ? request.agentName ?? `${request.adapterType ?? "Agent"} request`
      : request.requestEmailSnapshot ?? "Human join request";
  return {
    companyId: request.companyId,
    semanticType: "join_request",
    sourceType: "join_request",
    sourceId: request.id,
    title: `Review ${subject}`,
    summary: `${spaced(request.requestType)} join request`,
    ownerPool: "board",
    sourcePermissionRevision: request.updatedAt.toISOString(),
  };
}

export function buildDiscussionPendingHubEmit(discussion: DiscussionLike): EmitArgs {
  const count = discussion.pendingItemCount;
  const title = discussion.title?.trim() || "Discussion";
  const actor =
    discussion.lastPendingActorType && discussion.lastPendingActorId
      ? {
          sourceActorType: discussion.lastPendingActorType,
          sourceActorId: discussion.lastPendingActorId,
        }
      : {};
  return {
    companyId: discussion.companyId,
    semanticType: "discussion_pending",
    sourceType: "discussion",
    sourceId: discussion.id,
    title: `Review ${count} pending ${count === 1 ? "item" : "items"} in ${title}`,
    summary: `${count} extracted ${count === 1 ? "item needs" : "items need"} review.`,
    ownerUserId: discussion.ownerUserId,
    scopeKey: scopeKeyFor(discussion),
    ...actor,
    sourcePermissionRevision: discussion.updatedAt.toISOString(),
  };
}

export function buildSuggestionHubEmit(suggestion: SuggestionLike): EmitArgs {
  return {
    companyId: suggestion.companyId,
    semanticType: "suggestion",
    sourceType: "suggestion",
    sourceId: suggestion.id,
    title: suggestion.title,
    summary: suggestion.evidence,
    sourcePermissionRevision: suggestion.updatedAt.toISOString(),
  };
}

export function buildStaleIssueHubEmit(issue: IssueLike): EmitArgs {
  return {
    companyId: issue.companyId,
    semanticType: "stale_work",
    sourceType: "issue",
    sourceId: issue.id,
    title: `Stale task: ${issue.title}`,
    summary: "No recent human or crew progress.",
    ownerUserId: issue.assigneeUserId,
    ownerPool: issue.assigneeUserId ? undefined : "board",
    sourceActorType: issue.assigneeAgentId ? "agent" : undefined,
    sourceActorId: issue.assigneeAgentId ?? undefined,
    sourcePermissionRevision: issue.updatedAt.toISOString(),
  };
}

export async function emitHubItem(db: Db, args: EmitArgs) {
  return hubItemsService(db).emit(args);
}
```

- [x] **Step 4: Run to confirm it passes**

Run:

```sh
pnpm -C server exec vitest run src/__tests__/hub-source-producers.test.ts
```

Expected: PASS.

- [x] **Step 5: Commit**

```sh
git add server/src/services/hub-source-producers.ts server/src/__tests__/hub-source-producers.test.ts
git commit -m "feat(hub): add W1b source producer mappings"
```

---

## Task 2: Source Reconciliation For W1b Sources

**Files:**

- Modify: `server/src/services/hub-items.ts`
- Test: `server/src/__tests__/hub-source-producers.integration.test.ts`

- [x] **Step 1: Write the failing integration test**

Create `server/src/__tests__/hub-source-producers.integration.test.ts` using the embedded-postgres harness pattern from `server/src/__tests__/hub-items-sweeper.integration.test.ts`.

Test cases:

```ts
it("keeps approval hub items open for pending and revision_requested, closes approved", async () => {
  const companyId = await seedCompanyWithFounder();
  const pending = await insertApproval(companyId, { status: "pending" });
  const revision = await insertApproval(companyId, { status: "revision_requested" });
  const approved = await insertApproval(companyId, { status: "approved" });
  const svc = hubItemsService(db);
  await svc.emit(buildApprovalHubEmit(pending));
  await svc.emit(buildApprovalHubEmit(revision));
  await svc.emit(buildApprovalHubEmit(approved));

  await svc.reconcile(companyId, { sourceType: "approval" });

  const rows = await svc.query(companyId, { actorUserId: founderId, role: "founder", lane: "waiting_on_you" });
  expect(rows.map((r) => r.sourceId).sort()).toEqual([pending.id, revision.id].sort());
});

it("closes join request, discussion, suggestion, and stale issue hub rows when sources become terminal", async () => {
  const companyId = await seedCompanyWithFounder();
  const svc = hubItemsService(db);
  const join = await insertJoinRequest(companyId, { status: "approved" });
  const discussion = await insertDiscussion(companyId, { pendingItemCount: 0, ownerUserId: founderId });
  const suggestion = await insertSuggestion(companyId, { status: "dismissed" });
  const issue = await insertIssue(companyId, { status: "done", assigneeUserId: founderId });
  await svc.emit(buildJoinRequestHubEmit({ ...join, status: "pending_approval" }));
  await svc.emit(buildDiscussionPendingHubEmit({ ...discussion, pendingItemCount: 2 }));
  await svc.emit(buildSuggestionHubEmit({ ...suggestion, status: "pending" }));
  await svc.emit(buildStaleIssueHubEmit({ ...issue, status: "todo" }));

  await svc.reconcile(companyId, { sourceType: "join_request" });
  await svc.reconcile(companyId, { sourceType: "discussion" });
  await svc.reconcile(companyId, { sourceType: "suggestion" });
  await svc.reconcile(companyId, { sourceType: "issue" });

  const rows = await svc.query(companyId, { actorUserId: founderId, role: "founder" });
  expect(rows).toHaveLength(0);
});

it("preserves discussion owner and scope when refreshing pending discussion items", async () => {
  const companyId = await seedCompanyWithFounder();
  const discussion = await insertDiscussion(companyId, {
    ownerUserId: "user-2",
    scopeType: "project",
    scopeId: "project-1",
    pendingItemCount: 2,
  });

  const row = await hubItemsService(db).emit(buildDiscussionPendingHubEmit(discussion));

  expect(row.ownerUserId).toBe("user-2");
  expect(row.scopeKey).toBe("project-1");
});
```

The helper functions must insert real rows with unique IDs and a unique company `issuePrefix`, mirroring the existing W1a integration harness.

- [x] **Step 2: Run to confirm it fails**

Run:

```sh
pnpm -C server exec vitest run src/__tests__/hub-source-producers.integration.test.ts
```

Expected: FAIL because W1b reconcilers do not exist and approval reconciler closes `revision_requested`.

Windows note: this embedded-Postgres suite is `skipIf(process.platform === "win32")`, matching the existing W1a hub integration harness. On Windows, this step can only confirm the test file loads and skips; Linux CI is the red/green authority.

- [x] **Step 3: Implement W1b reconcilers**

In `server/src/services/hub-items.ts`:

- Import `joinRequests`, `discussions`, `suggestions`, and `issues`.
- Change `reconcileApproval` so terminal is `!["pending", "revision_requested"].includes(row.status)`.
- Add `reconcileJoinRequest`:
  - missing row or `status !== "pending_approval"` is terminal
  - summary from request type/name/email
  - permission revision from `updatedAt`
- Add `reconcileDiscussion`:
  - missing row or `pendingItemCount <= 0` is terminal
  - summary from pending count
  - refreshed owner/scope from `discussions.ownerUserId` and project/scope fields
  - permission revision from `updatedAt`
- Add `reconcileSuggestion`:
  - missing row or `status !== "pending"` is terminal
  - summary from `evidence`
  - permission revision from `updatedAt`
- Add `reconcileIssue` for `sourceType: "issue"` and `semanticType: "stale_work"`:
  - missing row is terminal
  - `status` in completed/cancelled terminal states is terminal
  - crew-assigned issues are terminal because old Inbox filtered crew-assigned work from stale human attention
  - issue freshness newer than the stale threshold is terminal
  - refreshed owner from `assigneeUserId`, refreshed actor from `assigneeAgentId`, refreshed title/summary from issue fields
- Register source types:

```ts
const SOURCE_RECONCILERS: Record<string, SourceReconciler> = {
  approval: reconcileApproval,
  heartbeat_run: reconcileHeartbeatRun,
  join_request: reconcileJoinRequest,
  discussion: reconcileDiscussion,
  suggestion: reconcileSuggestion,
  issue: reconcileIssue,
};
```

- [x] **Step 4: Run to confirm it passes**

Run:

```sh
pnpm -C server exec vitest run src/__tests__/hub-source-producers.integration.test.ts
```

Expected: PASS.

- [x] **Step 5: Commit**

```sh
git add server/src/services/hub-items.ts server/src/__tests__/hub-source-producers.integration.test.ts
git commit -m "feat(hub): reconcile W1b source lifecycles"
```

---

## Task 3: Wire W1b Source Emission Into Mutations

**Files:**

- Modify: `server/src/routes/approvals.ts`
- Modify: `server/src/routes/access.ts`
- Modify: `server/src/services/discussions.ts`
- Modify: `server/src/services/internal-agent/tools/submit-extracted-items.ts`
- Modify: `server/src/services/suggestions.ts`
- Modify: `server/src/services/issues.ts` or create `server/src/services/hub-stale-work.ts`
- Test: update affected tests and add focused assertions in `server/src/__tests__/hub-source-producers.integration.test.ts`

- [x] **Step 1: Write failing route/service tests**

Add assertions that:

- `POST /companies/:companyId/approvals` emits one `approval_request` hub item.
- `POST /companies/:companyId/join-requests/:requestId/approve` closes/reconciles the related `join_request` hub item.
- `suggestionService.runAllDetectors(companyId)` emits pending suggestions into `hub_items`.
- `discussionService.approveItems(...)` closes/reconciles the discussion hub item when pending count reaches zero.
- stale issue detection emits `stale_work` items for old-Inbox-equivalent stale human work and closes them after the issue becomes complete, crew-assigned, or fresh.
- duplicate emits for the same source update one hub row; they do not create duplicate visible rows.
- transaction-backed mutations call hub emit/reconcile with `executor: tx as unknown as Db` inside the existing transaction.

For mock-based tests, mock `hubItemsService` with every method the touched module uses:

```ts
vi.mock("../services/hub-items.js", () => ({
  hubItemsService: vi.fn(() => ({
    emit: vi.fn(async () => ({ id: "hub-1", version: 0 })),
    reconcile: vi.fn(async () => ({ healed: 1, closed: 1, refreshed: 0 })),
  })),
}));
```

- [x] **Step 2: Run focused tests to confirm failure**

Run the specific affected tests, starting with:

```sh
pnpm -C server exec vitest run src/__tests__/hub-source-producers.integration.test.ts
pnpm -C server exec vitest run src/__tests__/routes-*.test.ts src/__tests__/suggestions.test.ts src/__tests__/threads-inbox.test.ts
```

Expected: FAIL until emission is wired.

- [x] **Step 3: Wire approval emissions**

In `server/src/routes/approvals.ts`:

- Import `buildApprovalHubEmit` and `emitHubItem`.
- After `svc.create(...)`, call `await emitHubItem(db, buildApprovalHubEmit(approval))`; if creation moves into a transaction during implementation, emit with `executor: tx as unknown as Db`.
- After `svc.resubmit(...)`, call `await emitHubItem(db, buildApprovalHubEmit(approval))`; keep this in the same transaction as the status update if the route/service already has one.
- After approve/reject/request-revision, call `await hubItemsService(db).reconcile(approval.companyId, { sourceType: "approval" })` in the same transaction when possible.
- Keep existing activity logs and trust-score logic unchanged.

- [x] **Step 4: Wire join request emissions**

In `server/src/routes/access.ts`:

- Import `buildJoinRequestHubEmit`, `emitHubItem`, and `hubItemsService`.
- After a pending join request is created in invite acceptance, emit `buildJoinRequestHubEmit(created)` inside the same transaction if the acceptance path uses one.
- After approve/reject updates, call `await hubItemsService(db).reconcile(companyId, { sourceType: "join_request" })` inside the same transaction if the status update uses one.
- Keep existing `notifyHireApproved` behavior unchanged.

- [x] **Step 5: Wire discussion pending emissions**

In `server/src/services/discussions.ts` and `server/src/services/internal-agent/tools/submit-extracted-items.ts`:

- Import `buildDiscussionPendingHubEmit`, `emitHubItem`, and `hubItemsService`.
- After code increments `pendingItemCount`, select the updated discussion row and emit `buildDiscussionPendingHubEmit(row)` with `executor: tx as unknown as Db` when the increment is inside a transaction.
- After approve/reject/reprocess paths decrement pending count, call `hubItemsService(db).reconcile(companyId, { sourceType: "discussion", sourceId: discussionId })` with the transaction executor when available.
- Preserve existing `pendingItemCount` update semantics.

- [x] **Step 6: Wire suggestion emissions**

In `server/src/services/suggestions.ts`:

- Import `buildSuggestionHubEmit`, `emitHubItem`, and `hubItemsService`.
- After detector inserts pending suggestions, emit one hub item per inserted row. If insertion is batched in a transaction, pass that transaction as the hub executor.
- After accept/dismiss/expiry, call `hubItemsService(db).reconcile(companyId, { sourceType: "suggestion" })` after status updates, using the transaction executor when available.
- Keep suggestion action execution unchanged.

- [x] **Step 7: Wire stale issue emissions**

In `server/src/services/issues.ts` or a focused `server/src/services/hub-stale-work.ts`:

- Reuse the old Inbox stale issue conditions: company-scoped issue rows, not completed/cancelled, not crew-assigned, no recent human/crew activity inside the configured stale threshold.
- Emit `buildStaleIssueHubEmit(issue)` for matching stale rows during the same periodic/count path that old Inbox or dashboard stale counts use, or during an explicit W1b backfill/reconcile call if no existing detector exists.
- Reconcile `sourceType: "issue"` after issue status/assignee/comment/read-state changes that can make stale work fresh or terminal.
- Do not map `suggestion.category === "pipeline_bottleneck"` to `stale_work`; suggestion rows stay `suggestion`.

- [x] **Step 8: Run server tests**

Run:

```sh
pnpm -C server exec vitest run src/__tests__/hub-source-producers.test.ts src/__tests__/hub-source-producers.integration.test.ts
pnpm -C server exec vitest run
```

Expected: PASS locally, with integration tests skipped if the platform cannot run embedded Postgres.

- [x] **Step 9: Commit**

```sh
git add server/src/routes/approvals.ts server/src/routes/access.ts server/src/services/discussions.ts server/src/services/internal-agent/tools/submit-extracted-items.ts server/src/services/suggestions.ts server/src/services/issues.ts server/src/services/hub-stale-work.ts server/src/__tests__
git commit -m "feat(hub): emit W1b source items into hub index"
```

Completed in commit `3ea40e760` as `feat(hub): emit W1b source items from mutations`.

Verification:

- `corepack pnpm -C server exec vitest run src/__tests__/join-request-approve-race.test.ts` PASS.
- `corepack pnpm --filter @armyofagents/server typecheck` PASS.
- `corepack pnpm -C server exec vitest run src/__tests__/approvals-routes-cross-tenant.test.ts src/__tests__/suggestions.test.ts src/__tests__/discussions-service.test.ts src/__tests__/aoa-submit-extracted-items.test.ts src/__tests__/submit-extracted-items-live-event.test.ts src/__tests__/hub-materializers.test.ts src/__tests__/hub-source-producers.test.ts src/__tests__/hub-source-producers.integration.test.ts src/__tests__/hub-items-query.integration.test.ts src/__tests__/issue-status-event.test.ts src/__tests__/aoa-mention-wakeup-routing.test.ts src/__tests__/invite-accept-replay.test.ts src/__tests__/approvals-service-companyid.test.ts src/__tests__/join-request-approve-race.test.ts` PASS with Windows integration DB skips.
- Independent code review PASS from subagent `Dewey`: no critical or important issues.

---

## Task 4: Hub API Client And Query Keys

**Files:**

- Modify: `packages/shared/src/validators/hub.ts`
- Modify: `server/src/services/hub-items.ts`
- Modify: `server/src/routes/hub-items.ts`
- Create: `ui/src/api/hub-items.ts`
- Modify: `ui/src/api/index.ts`
- Modify: `ui/src/lib/queryKeys.ts`
- Test: `ui/src/api/__tests__/hub-items-api.test.ts`

- [x] **Step 1: Write the failing API test**

Create `ui/src/api/__tests__/hub-items-api.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const patch = vi.fn();
const post = vi.fn();

vi.mock("../client", () => ({
  api: {
    get: (...args: unknown[]) => get(...args),
    patch: (...args: unknown[]) => patch(...args),
    post: (...args: unknown[]) => post(...args),
  },
}));

import { hubItemsApi } from "../hub-items";

describe("hubItemsApi", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists lane-filtered hub items", async () => {
    get.mockResolvedValueOnce([]);
    await hubItemsApi.list("company-1", { lane: "waiting_on_you", status: "open", limit: 50 });
    expect(get).toHaveBeenCalledWith(
      "/companies/company-1/hub-items?lane=waiting_on_you&status=open&limit=50",
    );
  });

  it("fetches counts", async () => {
    get.mockResolvedValueOnce({ open: 2, unread: 1 });
    await hubItemsApi.counts("company-1");
    expect(get).toHaveBeenCalledWith("/companies/company-1/hub-items/counts");
  });

  it("marks an item read through sparse state route", async () => {
    patch.mockResolvedValueOnce({});
    await hubItemsApi.markRead("company-1", "hub-1");
    expect(patch).toHaveBeenCalledWith("/companies/company-1/hub-items/hub-1/state", {
      kind: "read",
    });
  });
});
```

- [x] **Step 2: Run to confirm it fails**

Run:

```sh
pnpm --filter @armyofagents/ui exec vitest run src/api/__tests__/hub-items-api.test.ts
```

Expected: FAIL because the client does not exist.

- [x] **Step 3: Implement the API client**

Create `ui/src/api/hub-items.ts`:

```ts
import type { HubItemStatus, HubLane, HubSemanticType } from "@armyofagents/shared";
import { api } from "./client";

export interface HubItemListRow {
  id: string;
  companyId: string;
  semanticType: HubSemanticType;
  lane: HubLane | null;
  status: HubItemStatus;
  priority: "low" | "normal" | "high" | "urgent";
  title: string;
  summary: string | null;
  sourceType: string | null;
  sourceId: string | null;
  ownerUserId: string | null;
  ownerPool: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  readAt: string | null;
  snoozedUntil: string | null;
  dismissedAt: string | null;
}

export interface HubListOptions {
  lane?: HubLane;
  status?: HubItemStatus;
  includeDismissed?: boolean;
  limit?: number;
}

function listQuery(opts: HubListOptions = {}) {
  const params = new URLSearchParams();
  if (opts.lane) params.set("lane", opts.lane);
  if (opts.status) params.set("status", opts.status);
  if (opts.includeDismissed) params.set("includeDismissed", "true");
  params.set("limit", String(Math.min(Math.max(opts.limit ?? 50, 1), 50)));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export const hubItemsApi = {
  list: (companyId: string, opts?: HubListOptions) =>
    api.get<HubItemListRow[]>(`/companies/${companyId}/hub-items${listQuery(opts)}`),
  counts: (companyId: string) =>
    api.get<{ open: number; unread: number }>(`/companies/${companyId}/hub-items/counts`),
  markRead: (companyId: string, itemId: string) =>
    api.patch(`/companies/${companyId}/hub-items/${itemId}/state`, { kind: "read" }),
};
```

Modify `ui/src/api/index.ts`:

```ts
export { hubItemsApi } from "./hub-items";
```

Modify `ui/src/lib/queryKeys.ts`:

```ts
hubItems: {
  list: (companyId: string, opts?: { lane?: string; status?: string; includeDismissed?: boolean; limit?: number }) =>
    ["hub-items", companyId, opts ?? {}] as const,
  counts: (companyId: string) => ["hub-items", companyId, "counts"] as const,
},
```

Modify shared/server list support:

```ts
// packages/shared/src/validators/hub.ts
export const listHubItemsQuery = z
  .object({
    lane: z.enum(HUB_LANES).optional(),
    status: z.enum(HUB_ITEM_STATUSES).optional(),
    includeDismissed: z
      .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
      .optional()
      .transform((v) => v === true || v === "true" || v === "1"),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  })
  .strict();
```

In `server/src/services/hub-items.ts`, thread `limit ?? 50` into the query builder and apply `.limit(limit)`. In `server/src/routes/hub-items.ts`, pass the parsed limit from `listHubItemsQuery` into `hubItemsService(db).query(...)`.

- [x] **Step 4: Run to confirm it passes**

Run:

```sh
pnpm --filter @armyofagents/ui exec vitest run src/api/__tests__/hub-items-api.test.ts
```

Expected: PASS.

- [x] **Step 5: Commit**

Implementation note: `packages/shared/src/validators/hub.ts`, `server/src/services/hub-items.ts`, and `server/src/routes/hub-items.ts` already had the Task 4 `limit` parsing/plumbing from the W1a/W1b backend work. Task 4 added the UI API client, export, query keys, and focused API test.

Verification:

- RED: `corepack pnpm --filter @armyofagents/ui exec vitest run src/api/__tests__/hub-items-api.test.ts` failed because `../hub-items` did not exist.
- GREEN: `corepack pnpm --filter @armyofagents/ui exec vitest run src/api/__tests__/hub-items-api.test.ts` PASS, including default query, `includeDismissed`, limit clamping, and non-finite limit fallback coverage.
- `corepack pnpm --filter @armyofagents/ui typecheck` PASS.
- Independent code review PASS from subagent `Cicero`: no critical or important issues; minor query edge coverage was folded back into this commit.

```sh
git add packages/shared/src/validators/hub.ts server/src/services/hub-items.ts server/src/routes/hub-items.ts ui/src/api/hub-items.ts ui/src/api/index.ts ui/src/lib/queryKeys.ts ui/src/api/__tests__/hub-items-api.test.ts
git commit -m "feat(hub): add UI client for hub items"
```

---

## Task 5: UI Registry Contract

**Files:**

- Create: `ui/src/components/hub/hubTypes.ts`
- Create: `ui/src/components/hub/hubRegistry.tsx`
- Test: `ui/src/components/hub/__tests__/hubRegistry.test.tsx`

- [x] **Step 1: Write the failing registry test**

Create `ui/src/components/hub/__tests__/hubRegistry.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { HUB_SEMANTIC_TYPES, HUB_SEMANTIC_TO_LANE } from "@armyofagents/shared";
import { HUB_REGISTRY, resolveHubEntry } from "../hubRegistry";

describe("HUB_REGISTRY", () => {
  it("is total over HUB_SEMANTIC_TYPES", () => {
    for (const semanticType of HUB_SEMANTIC_TYPES) {
      expect(HUB_REGISTRY[semanticType], semanticType).toBeTruthy();
      expect(HUB_REGISTRY[semanticType].lane).toBe(HUB_SEMANTIC_TO_LANE[semanticType]);
    }
  });

  it("rejects unknown semantic strings", () => {
    expect(resolveHubEntry("not_real")).toBeNull();
  });

  it("routes approval requests to the approval full page", () => {
    const entry = HUB_REGISTRY.approval_request;
    expect(entry.fullLink({ sourceId: "approval-1" } as never)).toBe("/approvals/approval-1");
  });
});
```

- [x] **Step 2: Run to confirm it fails**

Run:

```sh
pnpm --filter @armyofagents/ui exec vitest run src/components/hub/__tests__/hubRegistry.test.tsx
```

Expected: FAIL because registry files do not exist.

- [x] **Step 3: Implement registry types**

Create `ui/src/components/hub/hubTypes.ts`:

```ts
import type { HubLane, HubSemanticType } from "@armyofagents/shared";
import type { HubItemListRow } from "@/api/hub-items";
import type { LucideIcon } from "lucide-react";

export interface HubRegistryEntry {
  semanticType: HubSemanticType;
  lane: HubLane;
  label: string;
  icon: LucideIcon;
  viewerKind: "approval" | "discussion" | "task" | "notification" | "suggestion" | "reserved";
  fullLink: (item: HubItemListRow) => string | null;
}
```

Create `ui/src/components/hub/hubRegistry.tsx`:

```tsx
import {
  AlertCircle,
  Bell,
  Bot,
  CheckSquare,
  FileQuestion,
  GitPullRequest,
  Lightbulb,
  MessageSquare,
  Rocket,
  ShieldQuestion,
  Sparkles,
  UserPlus,
} from "lucide-react";
import {
  HUB_SEMANTIC_TO_LANE,
  type HubSemanticType,
} from "@armyofagents/shared";
import type { HubItemListRow } from "@/api/hub-items";
import type { HubRegistryEntry } from "./hubTypes";

const source = (item: HubItemListRow) => item.sourceId;
const sourceLink = (prefix: string) => (item: HubItemListRow) =>
  source(item) ? `${prefix}/${source(item)}` : null;

export const HUB_REGISTRY: Record<HubSemanticType, HubRegistryEntry> = {
  approval_request: {
    semanticType: "approval_request",
    lane: HUB_SEMANTIC_TO_LANE.approval_request,
    label: "Approval",
    icon: ShieldQuestion,
    viewerKind: "approval",
    fullLink: sourceLink("/approvals"),
  },
  discussion_pending: {
    semanticType: "discussion_pending",
    lane: HUB_SEMANTIC_TO_LANE.discussion_pending,
    label: "Discussion",
    icon: MessageSquare,
    viewerKind: "discussion",
    fullLink: sourceLink("/discussions"),
  },
  join_request: {
    semanticType: "join_request",
    lane: HUB_SEMANTIC_TO_LANE.join_request,
    label: "Join request",
    icon: UserPlus,
    viewerKind: "notification",
    fullLink: () => "/settings?tab=access",
  },
  human_input_needed: {
    semanticType: "human_input_needed",
    lane: HUB_SEMANTIC_TO_LANE.human_input_needed,
    label: "Needs input",
    icon: FileQuestion,
    viewerKind: "discussion",
    fullLink: sourceLink("/discussions"),
  },
  scope_proposal: {
    semanticType: "scope_proposal",
    lane: HUB_SEMANTIC_TO_LANE.scope_proposal,
    label: "Scope proposal",
    icon: GitPullRequest,
    viewerKind: "discussion",
    fullLink: sourceLink("/discussions"),
  },
  agent_runtime_decision: {
    semanticType: "agent_runtime_decision",
    lane: HUB_SEMANTIC_TO_LANE.agent_runtime_decision,
    label: "Runtime decision",
    icon: Bot,
    viewerKind: "reserved",
    fullLink: () => null,
  },
  run_failed: {
    semanticType: "run_failed",
    lane: HUB_SEMANTIC_TO_LANE.run_failed,
    label: "Run failed",
    icon: AlertCircle,
    viewerKind: "notification",
    fullLink: () => null,
  },
  budget_alert: {
    semanticType: "budget_alert",
    lane: HUB_SEMANTIC_TO_LANE.budget_alert,
    label: "Budget",
    icon: AlertCircle,
    viewerKind: "notification",
    fullLink: () => "/settings?tab=budget",
  },
  agent_error: {
    semanticType: "agent_error",
    lane: HUB_SEMANTIC_TO_LANE.agent_error,
    label: "Agent error",
    icon: AlertCircle,
    viewerKind: "notification",
    fullLink: () => "/agents/all",
  },
  mention: {
    semanticType: "mention",
    lane: HUB_SEMANTIC_TO_LANE.mention,
    label: "Mention",
    icon: Bell,
    viewerKind: "notification",
    fullLink: sourceLink("/discussions"),
  },
  marketplace_op: {
    semanticType: "marketplace_op",
    lane: HUB_SEMANTIC_TO_LANE.marketplace_op,
    label: "Marketplace",
    icon: Sparkles,
    viewerKind: "notification",
    fullLink: () => "/marketplace-updates",
  },
  run_complete: {
    semanticType: "run_complete",
    lane: HUB_SEMANTIC_TO_LANE.run_complete,
    label: "Run complete",
    icon: CheckSquare,
    viewerKind: "notification",
    fullLink: () => null,
  },
  reminder: {
    semanticType: "reminder",
    lane: HUB_SEMANTIC_TO_LANE.reminder,
    label: "Reminder",
    icon: Bell,
    viewerKind: "notification",
    fullLink: () => "/commander",
  },
  extraction_failed: {
    semanticType: "extraction_failed",
    lane: HUB_SEMANTIC_TO_LANE.extraction_failed,
    label: "Extraction failed",
    icon: AlertCircle,
    viewerKind: "notification",
    fullLink: sourceLink("/discussions"),
  },
  routine_outcome: {
    semanticType: "routine_outcome",
    lane: HUB_SEMANTIC_TO_LANE.routine_outcome,
    label: "Routine",
    icon: Rocket,
    viewerKind: "notification",
    fullLink: sourceLink("/routines"),
  },
  legacy_other: {
    semanticType: "legacy_other",
    lane: HUB_SEMANTIC_TO_LANE.legacy_other,
    label: "Notification",
    icon: Bell,
    viewerKind: "notification",
    fullLink: () => null,
  },
  suggestion: {
    semanticType: "suggestion",
    lane: HUB_SEMANTIC_TO_LANE.suggestion,
    label: "Suggestion",
    icon: Lightbulb,
    viewerKind: "suggestion",
    fullLink: () => "/home",
  },
  stale_work: {
    semanticType: "stale_work",
    lane: HUB_SEMANTIC_TO_LANE.stale_work,
    label: "Stale work",
    icon: Lightbulb,
    viewerKind: "task",
    fullLink: sourceLink("/issues"),
  },
  proactive: {
    semanticType: "proactive",
    lane: HUB_SEMANTIC_TO_LANE.proactive,
    label: "Proactive",
    icon: Sparkles,
    viewerKind: "suggestion",
    fullLink: () => "/commander",
  },
};

export function resolveHubEntry(value: string): HubRegistryEntry | null {
  return Object.prototype.hasOwnProperty.call(HUB_REGISTRY, value)
    ? HUB_REGISTRY[value as HubSemanticType]
    : null;
}
```

- [x] **Step 4: Run to confirm it passes**

Run:

```sh
pnpm --filter @armyofagents/ui exec vitest run src/components/hub/__tests__/hubRegistry.test.tsx
```

Expected: PASS.

- [x] **Step 5: Commit**

```sh
git add ui/src/components/hub/hubTypes.ts ui/src/components/hub/hubRegistry.tsx ui/src/components/hub/__tests__/hubRegistry.test.tsx
git commit -m "feat(hub): add total UI registry for hub semantic types"
```

Verification:

- RED: `corepack pnpm --filter @armyofagents/ui exec vitest run src/components/hub/__tests__/hubRegistry.test.tsx` failed because `../hubRegistry` did not exist.
- GREEN: `corepack pnpm --filter @armyofagents/ui exec vitest run src/components/hub/__tests__/hubRegistry.test.tsx` PASS, including invalid-link regressions for join requests, mentions, marketplace operations, stale work, and suggestions.
- `corepack pnpm --filter @armyofagents/ui typecheck` PASS.

---

## Task 6: Three-Pane Hub Shell Components

**Files:**

- Create: `ui/src/components/hub/HubRail.tsx`
- Create: `ui/src/components/hub/HubList.tsx`
- Create: `ui/src/components/hub/HubHome.tsx`
- Create: `ui/src/components/hub/HubViewer.tsx`
- Create: `ui/src/components/hub/HubShell.tsx`
- Test: `ui/src/components/hub/__tests__/HubShell.test.tsx`

- [x] **Step 1: Write the failing shell tests**

Create `ui/src/components/hub/__tests__/HubShell.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { HubShell } from "../HubShell";
import type { HubItemListRow } from "@/api/hub-items";

const items: HubItemListRow[] = [
  {
    id: "hub-1",
    companyId: "company-1",
    semanticType: "approval_request",
    lane: "waiting_on_you",
    status: "open",
    priority: "normal",
    title: "Review hire approval",
    summary: "Scout",
    sourceType: "approval",
    sourceId: "approval-1",
    ownerUserId: "user-1",
    ownerPool: "board",
    version: 0,
    createdAt: "2026-06-29T00:00:00Z",
    updatedAt: "2026-06-29T00:00:00Z",
    readAt: null,
    snoozedUntil: null,
    dismissedAt: null,
  },
];

function renderShell() {
  return render(
    <MemoryRouter>
      <HubShell
        activeLane="waiting_on_you"
        items={items}
        counts={{ open: 1, unread: 1 }}
        isLoading={false}
        error={null}
        selectedItemId={null}
        onLaneChange={vi.fn()}
        onSelectItem={vi.fn()}
        onMarkRead={vi.fn()}
      />
    </MemoryRouter>,
  );
}

describe("HubShell", () => {
  it("renders rail, lane list, and empty viewer state", () => {
    renderShell();
    expect(screen.getByRole("navigation", { name: /hub lanes/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /waiting on you/i })).toBeInTheDocument();
    expect(screen.getByText("Review hire approval")).toBeInTheDocument();
    expect(screen.getByText(/select an item/i)).toBeInTheDocument();
  });

  it("opens a viewer tab when an item is selected", async () => {
    const user = userEvent.setup();
    const onSelectItem = vi.fn();
    render(
      <MemoryRouter>
        <HubShell
          activeLane="waiting_on_you"
          items={items}
          counts={{ open: 1, unread: 1 }}
          isLoading={false}
          error={null}
          selectedItemId={null}
          onLaneChange={vi.fn()}
          onSelectItem={onSelectItem}
          onMarkRead={vi.fn()}
        />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole("button", { name: /review hire approval/i }));
    expect(onSelectItem).toHaveBeenCalledWith("hub-1");
  });
});
```

- [x] **Step 2: Run to confirm it fails**

Run:

```sh
pnpm --filter @armyofagents/ui exec vitest run src/components/hub/__tests__/HubShell.test.tsx
```

Expected: FAIL because shell components do not exist.

- [x] **Step 3: Implement components**

Implement:

- `HubRail`: icon buttons for Home, Waiting on you, Notifications, Suggestions, disabled Mail reserved.
- `HubList`: stable-height rows with semantic icon, priority, title, summary, read state, created time.
- `HubHome`: compact overview using counts, lane shortcuts, "Needs you most", and display-only Autopilot control.
- `HubViewer`: right panel with close/collapse control, tab strip, generic source summary, and `Open full` link from registry. In W1b, embed only lightweight summaries; full source pages remain canonical.
- `HubShell`: composes the three panes and accepts state from `InboxHub`.

Constraints:

- No nested cards inside cards.
- Stable pane dimensions; item hover/selection must not resize rows.
- Empty/loading/error states must be explicit.
- Text must not overflow buttons or compact rows.

- [x] **Step 4: Run to confirm tests pass**

Run:

```sh
pnpm --filter @armyofagents/ui exec vitest run src/components/hub/__tests__/HubShell.test.tsx
```

Expected: PASS.

- [x] **Step 5: Commit**

```sh
git add ui/src/components/hub/HubRail.tsx ui/src/components/hub/HubList.tsx ui/src/components/hub/HubHome.tsx ui/src/components/hub/HubViewer.tsx ui/src/components/hub/HubShell.tsx ui/src/components/hub/__tests__/HubShell.test.tsx
git commit -m "feat(hub): build W1b three-pane shell"
```

Verification:

- RED: `corepack pnpm --filter @armyofagents/ui exec vitest run src/components/hub/__tests__/HubShell.test.tsx` failed because `../HubShell` did not exist.
- GREEN: `corepack pnpm --filter @armyofagents/ui exec vitest run src/components/hub/__tests__/HubShell.test.tsx` PASS, including priority display, nullable viewer close, named viewer landmark, and company-prefixed `Open full` link coverage.
- `corepack pnpm --filter @armyofagents/ui exec vitest run src/components/hub/__tests__/HubShell.test.tsx src/components/hub/__tests__/hubRegistry.test.tsx` PASS.
- `corepack pnpm --filter @armyofagents/ui typecheck` PASS.

---

## Task 7: InboxHub Page, Preview Routes, And Sidebar Reachability

**Files:**

- Create: `ui/src/pages/InboxHub.tsx`
- Modify: `ui/src/App.tsx`
- Modify: `ui/src/components/Sidebar.tsx`
- Test: `ui/src/__tests__/Sidebar.test.tsx`
- Test: `ui/src/__tests__/navigation.test.tsx` or new `ui/src/__tests__/InboxHub.test.tsx`

- [x] **Step 1: Write failing page/sidebar tests**

Add to `ui/src/__tests__/Sidebar.test.tsx`:

```tsx
it("renders Approvals as a reachable work nav item", async () => {
  renderSidebar();
  expect(await screen.findByRole("link", { name: /approvals/i })).toHaveAttribute(
    "href",
    "/P4/approvals/pending",
  );
});

it("renders the preview Hub nav item without replacing Inbox", async () => {
  renderSidebar();
  expect(await screen.findByRole("link", { name: /^Inbox/ })).toBeInTheDocument();
  expect(await screen.findByRole("link", { name: /Hub preview/i })).toHaveAttribute(
    "href",
    "/P4/inbox-hub",
  );
});
```

Create `ui/src/__tests__/InboxHub.test.tsx` with mocked `hubItemsApi`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { hubItemsApi } from "@/api/hub-items";
import { InboxHub } from "../pages/InboxHub";

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));
vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));
vi.mock("@/api/hub-items", () => ({
  hubItemsApi: {
    list: vi.fn().mockResolvedValue([]),
    counts: vi.fn().mockResolvedValue({ open: 0, unread: 0 }),
    markRead: vi.fn().mockResolvedValue({}),
  },
}));

describe("InboxHub page", () => {
  it("renders Home by default", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/P4/inbox-hub"]}>
          <Routes>
            <Route path="/:companyPrefix/inbox-hub" element={<InboxHub />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/Autopilot/i)).toBeInTheDocument();
  });

  it("maps the waiting slug to the waiting_on_you API lane with the preview limit", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/P4/inbox-hub/waiting"]}>
          <Routes>
            <Route path="/:companyPrefix/inbox-hub/:lane" element={<InboxHub />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await screen.findByRole("navigation", { name: /hub lanes/i });
    expect(vi.mocked(hubItemsApi.list)).toHaveBeenCalledWith("company-1", {
      lane: "waiting_on_you",
      status: "open",
      limit: 50,
    });
  });
});
```

- [x] **Step 2: Run to confirm failures**

Run:

```sh
pnpm --filter @armyofagents/ui exec vitest run src/__tests__/Sidebar.test.tsx src/__tests__/InboxHub.test.tsx
```

Expected: FAIL until route/page/sidebar are implemented.

- [x] **Step 3: Implement `InboxHub`**

Create `ui/src/pages/InboxHub.tsx`:

- Use route params to resolve active lane:
  - no lane -> Home
  - `waiting`, `notifications`, `suggestions` -> corresponding lane
- Export/use a slug map:
  - `LANE_TO_SLUG.waiting_on_you = "waiting"`
  - `SLUG_TO_LANE.waiting = "waiting_on_you"`
  - unknown slug -> redirect to `/:companyPrefix/inbox-hub` with `replace: true`
- Query `hubItemsApi.counts(selectedCompanyId)`.
- Query `hubItemsApi.list(selectedCompanyId, { lane, status: "open", limit: 50 })` for lane pages.
- Pass data into `HubShell`.
- On item select:
  - update route to `/inbox-hub/:laneSlug/:itemId`
  - call `hubItemsApi.markRead`
  - invalidate `hubItems.counts`
- If the URL contains `:itemId`, select that row after the list query resolves and render the viewer directly.
- Set breadcrumbs to `Inbox Hub`.

- [x] **Step 4: Add routes**

In `ui/src/App.tsx`:

- import `InboxHub`
- add board routes:

```tsx
<Route path="inbox-hub" element={<InboxHub />} />
<Route path="inbox-hub/:lane" element={<InboxHub />} />
<Route path="inbox-hub/:lane/:itemId" element={<InboxHub />} />
```

Do not change existing `/inbox/new` or `/inbox/all`.

- [x] **Step 5: Add sidebar reachability**

In `ui/src/components/Sidebar.tsx`:

- Keep existing `Inbox` item.
- Add `Hub preview` pointing to `/inbox-hub`.
- Add `Approvals` pointing to `/approvals/pending` under Work.
- Use lucide icons already imported or add `ShieldCheck`.

- [x] **Step 6: Run UI tests**

Run:

```sh
pnpm --filter @armyofagents/ui exec vitest run src/__tests__/Sidebar.test.tsx src/__tests__/InboxHub.test.tsx
```

Expected: PASS.

- [x] **Step 7: Commit**

```sh
git add ui/src/pages/InboxHub.tsx ui/src/App.tsx ui/src/components/Sidebar.tsx ui/src/__tests__/Sidebar.test.tsx ui/src/__tests__/InboxHub.test.tsx
git commit -m "feat(hub): mount W1b hub preview route and approvals nav"
```

Implementation note: Task 7 also adds `inbox-hub` to `ui/src/lib/company-routes.ts` so the custom router treats the preview hub as a company-scoped board route.

Verification:

- RED: `corepack pnpm --filter @armyofagents/ui exec vitest run src/__tests__/Sidebar.test.tsx src/__tests__/InboxHub.test.tsx` failed because `InboxHub` and the sidebar links did not exist.
- GREEN: `corepack pnpm --filter @armyofagents/ui exec vitest run src/__tests__/Sidebar.test.tsx src/__tests__/InboxHub.test.tsx` PASS, including duplicate mark-read prevention for repeated unread row clicks.
- `corepack pnpm --filter @armyofagents/ui typecheck` PASS.
- Independent review: Beauvoir PASS after the duplicate mark-read cache/guard fix.

---

## Task 8: W1b Playwright Flow

**Files:**

- Create: `tests/e2e/inbox-hub-w1b.spec.ts`
- Create: `tests/e2e/helpers/seed-hub-item.ts` only if no existing source API can create the required non-approval lane rows.

- [x] **Step 1: Write the failing e2e spec**

Create `tests/e2e/inbox-hub-w1b.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";
import { seedHubItem } from "./helpers/seed-hub-item";

test.describe("Inbox Hub W1b preview", () => {
  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-HUB-/);
  });

  test("founder opens hub preview, switches lanes, opens item, deep-links it, and opens full approval detail", async ({
    page,
    request,
  }) => {
    const company = await seedCompany(request, `E2E-HUB-${Date.now()}`);

    const approvalRes = await request.post(`/api/companies/${company.id}/approvals`, {
      data: {
        type: "hire_agent",
        payload: { name: "Scout" },
        issueIds: [],
      },
    });
    expect(approvalRes.ok()).toBeTruthy();
    const approval = await approvalRes.json();

    await page.goto(`/${company.issuePrefix}/inbox-hub`);
    await expect(page.getByRole("navigation", { name: /hub lanes/i })).toBeVisible();
    await page.getByRole("button", { name: /waiting on you/i }).click();
    await expect(page.getByText(/Review hire agent approval/i)).toBeVisible();

    await page.getByRole("button", { name: /Review hire agent approval/i }).click();
    await expect(page.getByRole("complementary", { name: /hub viewer/i })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/inbox-hub/waiting/.+`));

    const selectedUrl = page.url();
    await page.goto(selectedUrl);
    await expect(page.getByRole("complementary", { name: /hub viewer/i })).toBeVisible();
    await page.getByRole("link", { name: /open full/i }).click();
    await expect(page).toHaveURL(new RegExp(`/approvals/${approval.id}`));
  });

  test("preview route exposes notifications and suggestions lanes without replacing legacy Inbox", async ({
    page,
    request,
  }) => {
    const company = await seedCompany(request, `E2E-HUB-${Date.now()}`);

    await seedHubItem({
      companyId: company.id,
      semanticType: "agent_error",
      sourceType: "test_notification",
      sourceId: "n-1",
      title: "Agent failed to finish run",
      ownerPool: "board",
    });
    await seedHubItem({
      companyId: company.id,
      semanticType: "suggestion",
      sourceType: "test_suggestion",
      sourceId: "s-1",
      title: "Review stale project risk",
      ownerPool: "board",
    });

    await page.goto(`/${company.issuePrefix}/inbox-hub/notifications`);
    await expect(page.getByText("Agent failed to finish run")).toBeVisible();

    await page.getByRole("button", { name: /suggestions/i }).click();
    await expect(page).toHaveURL(new RegExp(`/inbox-hub/suggestions`));
    await expect(page.getByText("Review stale project risk")).toBeVisible();

    await page.goto(`/${company.issuePrefix}/inbox/new`);
    await expect(page).not.toHaveURL(new RegExp(`/inbox-hub`));
  });
});
```

- [x] **Step 2: Run to confirm failure or collect**

Run:

```sh
pnpm test:e2e -- inbox-hub-w1b.spec.ts
```

Expected before implementation: FAIL. After previous tasks: PASS on Linux-capable e2e environments. On Windows, Playwright config skips e2e because embedded Postgres cannot boot.

- [x] **Step 3: Fix seed gaps**

If approval creation or the seeded notification/suggestion helpers do not emit hub items in e2e:

- inspect server logs
- verify Task 3 `POST /companies/:companyId/approvals` emission
- verify `hubItems.query` role resolution treats local trusted board as founder
- prefer real source APIs when available; otherwise use `tests/e2e/helpers/seed-hub-item.ts` to insert through the local test DB client or app-internal service, never through a user-visible `/api/test` route

Do not add e2e-only backdoors.

- [x] **Step 4: Commit**

```sh
git add tests/e2e/inbox-hub-w1b.spec.ts tests/e2e/helpers/seed-hub-item.ts
git commit -m "test(hub): add W1b Playwright preview flow"
```

Verification:

- RED: with `DATABASE_URL` temporarily set to force collection on Windows, `corepack pnpm exec playwright test --config=tests/e2e/playwright.config.ts inbox-hub-w1b.spec.ts --list` failed because `tests/e2e/helpers/seed-hub-item` did not exist.
- GREEN collect: with `DATABASE_URL` temporarily set to force collection on Windows, the same `--list` command listed both W1b Playwright tests.
- Review fix: the legacy Inbox safety assertion now verifies `/:companyPrefix/inbox/new` remains on the legacy route and renders the `Inbox` heading, rather than merely asserting the URL is not `/inbox-hub`.
- Windows e2e skip: `corepack pnpm test:e2e` PASS with the expected single skipped `windows-embedded-postgres-skip.spec.ts`. Runtime browser flow remains covered by Linux/external-Postgres e2e.

---

## Task 9: W1b Verification Sweep

**Files:**

- Modify tests only if failures expose incomplete mocks.

- [x] **Step 1: Run focused checks**

Run:

```sh
pnpm --filter @armyofagents/shared exec vitest run src/__tests__/hub-contract.test.ts
pnpm -C server exec vitest run src/__tests__/hub-source-producers.test.ts src/__tests__/hub-source-producers.integration.test.ts
pnpm --filter @armyofagents/ui exec vitest run src/api/__tests__/hub-items-api.test.ts src/components/hub/__tests__/hubRegistry.test.tsx src/components/hub/__tests__/HubShell.test.tsx src/__tests__/InboxHub.test.tsx src/__tests__/Sidebar.test.tsx
pnpm test:e2e -- inbox-hub-w1b.spec.ts
```

Expected: all focused checks pass, except e2e may be skipped on Windows by config.

Verification:

- `corepack pnpm --filter @armyofagents/shared exec vitest run src/__tests__/hub-contract.test.ts` PASS (6 tests).
- `corepack pnpm -C server exec vitest run src/__tests__/hub-source-producers.test.ts src/__tests__/hub-source-producers.integration.test.ts` PASS on Windows (5 passed, 7 skipped integration rows).
- `corepack pnpm --filter @armyofagents/ui exec vitest run src/api/__tests__/hub-items-api.test.ts src/components/hub/__tests__/hubRegistry.test.tsx src/components/hub/__tests__/HubShell.test.tsx src/__tests__/InboxHub.test.tsx src/__tests__/Sidebar.test.tsx` PASS (29 tests).
- `corepack pnpm -C server exec vitest run src/__tests__/hub-items-routes.test.ts src/__tests__/mcp-approval-tools.test.ts src/__tests__/v2.5-discussion-flow-qa.test.ts --reporter=verbose` PASS after updating mocks for W1b producer/reconcile calls (98 tests).
- `corepack pnpm -C server exec vitest run src/__tests__/issues-hasunmet-dependencies.test.ts --reporter=verbose` PASS after updating the test DB stub for transactional checkout reconciliation (3 tests).
- With `DATABASE_URL` temporarily set only to force Playwright collection on Windows, `corepack pnpm exec playwright test --config=tests/e2e/playwright.config.ts inbox-hub-w1b.spec.ts --list` lists both W1b specs.
- `corepack pnpm test:e2e` PASS on Windows with the expected single skipped `windows-embedded-postgres-skip.spec.ts`; runtime browser flow still requires Linux/macOS embedded Postgres or an external `DATABASE_URL`.

- [x] **Step 2: Run broad checks**

Run:

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

Expected: PASS. If any check cannot run, record the exact command and reason in the handoff.

Verification:

- `corepack pnpm test:run` PASS (10,500 passed, 179 skipped).
- `pnpm -r typecheck` initially failed because this Codex shell resolved nested bare `pnpm` scripts to `pnpm 11.7.0`, while the repo pins `pnpm@9.15.4`. Re-ran with `C:\Users\TK\AppData\Roaming\npm` first in `PATH`, where `pnpm.cmd --version` is `9.15.4`: `pnpm -r typecheck` PASS.
- `pnpm build` PASS with the same pinned-pnpm PATH adjustment. Build produced only the existing large-chunk warning.

- [x] **Step 3: Review branch scope**

Run:

```sh
git diff --name-only origin/main...HEAD
```

Expected:

- roadmap doc
- W1b plan
- server source producer/reconciler/wiring files
- W1b UI/API files
- W1b tests
- no W1c/W1d/W2/W3/W4/W5 implementation

Verification:

- `git diff --name-only origin/main...HEAD` shows the integration roadmap, W1b plan, shared hub validators/tests, server source producer/reconciler/wiring tests, W1b UI/API shell files, and W1b e2e files.
- No W1c lifecycle UI, W1d grouping/search/settings/mobile, or W2-W5 implementation files were added.

- [x] **Step 4: Commit any verification-only fixes**

```sh
git add <files>
git commit -m "test(hub): complete W1b verification sweep"
```

Only commit if files changed.

---

## Review Gate Before Execution

Before implementing this plan:

- Run an independent plan review with a subagent.
- Patch this plan for any valid findings.
- Then choose execution mode:
  - Subagent-driven: fresh worker per task, review after each task.
  - Inline execution: execute tasks in this session with checkpoints.

## Execution Notes

- Preserve old `/inbox/new|all` until final cutover.
- W1b source producers must use `hubItemsService.emit` and preserve redaction-before-persist.
- New emit sites inside transactions must pass `executor: tx as unknown as Db` when the source mutation is transactional.
- Every mock of `hubItemsService` must include every method the code path touches.
- No dependency additions are expected.
- Do not rename DB tables or API routes.
- UI text says Task/Home/Budget/Team/Discussion; DB/API names stay unchanged.

## Final W1b Definition Of Done

- W1b source matrix is represented in code or explicitly deferred with tests.
- The new hub preview route renders Home, lanes, list, and viewer.
- Approvals are reachable from sidebar and can be opened from the hub.
- UI registry is total over shared semantic types.
- Focused unit/component/API/e2e checks pass.
- Full `pnpm -r typecheck`, `pnpm test:run`, and `pnpm build` pass or failures are documented with reasons.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | Not run | Roadmap review already accepted one integration PR for W1b/W1c/W1d, with W2+ later PRs. |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | Not run | Not run for plan-only doc. |
| Eng Review | `/plan-eng-review` + subagent Franklin | Architecture & tests (required) | 1 | CLEAR after patch | 10 findings addressed: old Inbox parity, discussion scoping, stale work source, transactional emits, coverage matrix, lane slugs, list limit, registry links, approval summaries, lifecycle edge cases. |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | Recommended before UI implementation | W1b includes a substantial new shell; run design review after shell components exist or before final visual pass. |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | Not run | Not needed for this internal feature plan. |

- **UNRESOLVED:** 0 plan decisions. The initial subagent review said "not ready"; this revision patches those blockers into executable tasks and acceptance checks.
- **VERDICT:** ENG CLEARED FOR EXECUTION. Implement with `superpowers:subagent-driven-development` or `superpowers:executing-plans`, and keep the review-after-each-task gate.
