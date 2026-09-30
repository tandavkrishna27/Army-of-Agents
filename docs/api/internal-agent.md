---
title: Commander API
summary: Internal Agent conversations, runs, reminders, settings, and cockpit data
---

Commander is AoA's internal assistant. These routes are company-scoped and primarily serve the board UI. Treat them as authenticated operator APIs, not public unauthenticated endpoints.

For the operator workflow, see [Work with Commander](../guides/board-operator/commander.md).

## Sign-in and Verification

```
POST /api/companies/{companyId}/internal-agent/verify
POST /api/companies/{companyId}/internal-agent/commander-key
POST /api/companies/{companyId}/internal-agent/commander-login/start
GET  /api/companies/{companyId}/internal-agent/commander-login/{challengeId}
POST /api/companies/{companyId}/internal-agent/commander-login/{challengeId}/cancel
```

Commander key and login-challenge mutations are founder board actions.
`commander-key` accepts `provider` (`anthropic` or `openai`) and a non-empty
credential, stores it through the encrypted company-secret path, and records the
mutation. Login challenges are company-scoped; a concurrent challenge returns
`409`, and a provider start failure returns `502`.

## Chat, Conversation, and Runs

```
POST /api/companies/{companyId}/internal-agent/chat
POST /api/companies/{companyId}/internal-agent/confirm
GET /api/companies/{companyId}/internal-agent/conversation
DELETE /api/companies/{companyId}/internal-agent/conversation
GET /api/companies/{companyId}/internal-agent/conversations
POST /api/companies/{companyId}/internal-agent/conversations
PATCH /api/companies/{companyId}/internal-agent/conversations/reorder
DELETE /api/companies/{companyId}/internal-agent/conversations/order
PATCH /api/companies/{companyId}/internal-agent/conversations/{conversationId}/archive
PATCH /api/companies/{companyId}/internal-agent/conversations/{conversationId}/pin
PATCH /api/companies/{companyId}/internal-agent/conversations/{conversationId}/rename
DELETE /api/companies/{companyId}/internal-agent/conversations/{conversationId}
GET /api/companies/{companyId}/internal-agent/conversations/{conversationId}/messages
GET /api/companies/{companyId}/internal-agent/runs
```

`/chat` is POST-based SSE streaming (`text/event-stream`); the browser client uses `fetch`, not `EventSource`, so request bodies and abort signals work. Conversation routes persist user, assistant, and tool messages and support session list management. Run routes expose execution metadata and tool/cost traces.

A chat request includes:

```json
{
  "message": "Summarize the attached notes",
  "conversationId": "{conversationId}",
  "clientSubmissionId": "{stableClientId}",
  "pageContext": "Optional current-page context",
  "contextScope": "Optional context selection",
  "departmentContext": "Optional department context",
  "attachmentAssetIds": ["{assetId}"]
}
```

`message` is required and limited to 10,000 characters. `pageContext` is limited
to 5,000 characters, `clientSubmissionId` to 200 characters, and attachments to
five company-owned assets.

`clientSubmissionId` makes retries replay-safe within the conversation context.
An accepted or in-progress replay does not launch a second CLI turn or persist a
duplicate user message.

The stream may emit `thinking`, `content`, `reasoning`, `tool_call`,
`tool_result`, `action_confirm`, `options_prompt`, `error`, and `done` events.
Clients should treat event payloads as typed stream events and wait for `done`
or `error` rather than parsing display text.

Composer uploads use the company asset endpoint. Plain text, Markdown, and JSON
assets are runtime-readable up to 32 KB; images and other formats are stored and
disclosed but not delivered to the current model runtime. Delivery is
best-effort and never bypasses company ownership checks. See
[Commander attachment runtime](../architecture/commander-attachment-runtime.md).

## Settings, Capabilities, and Reminders

```
GET /api/companies/{companyId}/internal-agent/config
PATCH /api/companies/{companyId}/internal-agent/config
GET /api/companies/{companyId}/internal-agent/runtime-settings
GET /api/companies/{companyId}/internal-agent/greeting
GET /api/companies/{companyId}/internal-agent/skills
GET /api/companies/{companyId}/internal-agent/tool-permissions
PATCH /api/companies/{companyId}/internal-agent/tool-permissions
GET /api/companies/{companyId}/internal-agent/tool-trust-rules
DELETE /api/companies/{companyId}/internal-agent/tool-trust-rules/{ruleId}
POST /api/companies/{companyId}/internal-agent/test-connection
GET /api/companies/{companyId}/internal-agent/reminders
PATCH /api/companies/{companyId}/internal-agent/reminders/{reminderId}
```

Config includes execution mode, provider/model fields, **two autonomy dials**, enabled capabilities, budget, and proactive interval. Current execution is CLI-mode by default.

### Autonomy: two independent dials

`internal_agent_config` carries two separate autonomy columns. They are set independently and **neither is derived from the other** — writing one never moves the other. Both accept `0` (Manual), `1` (Assist), or `2` (Drive); `3` is rejected. Both default to `1`. (D18 split, 2026-07-24 — see Decision #109 addendum §10-14.)

| Field | Governs | Read by |
|---|---|---|
| `autonomyLevel` | **Commander only** | Nothing at runtime — see below |
| `crewAutonomyLevel` | **Agent work** | Crew task runs and crew wakeups, org-agent heartbeat runs, and every Adjutant/thread flow (scope-draft auto-accept, thread participation, proactive Adjutant wake, phase-advance auto-approve) |

Two things about these names are deliberate and worth knowing before you use them:

- **`crewAutonomyLevel` also governs ORG agents, not just crew.** The name follows the D18 decision, but the dial answers "how far may an agent take its own task", which is the same question for a crew agent and an org-agent heartbeat run. If you are setting autonomy for *any* agent execution, this is the field. The Settings UI labels it "Agent autonomy (crew + org agents)" for the same reason.
- **`autonomyLevel` is currently inert.** No Commander code path reads it. Commander's gating is the runtime-approval policy (`runtimeApprovalsEnabled` / `runtimeAllowAlwaysEnabled` above), which is unconditional for Commander. The column is retained as Commander's declared dial and round-trips through portability bundles, but changing it changes no behaviour today.

**If you are migrating pre-2026-07-24 client code**, a `PATCH` sending `autonomyLevel` to control agents must be changed to `crewAutonomyLevel`. The old field still validates and still writes — it simply no longer affects agent execution, so the failure is silent.

`discussions.autonomyLevel` (see `docs/api/discussions.md`) remains a third, finer-grained **per-thread override** that outranks `crewAutonomyLevel` for that thread. Resolution is `thread.autonomyLevel ?? company.crewAutonomyLevel`.

## Cockpit

```
GET /api/companies/{companyId}/cockpit
GET /api/companies/{companyId}/cockpit/counts
GET /api/companies/{companyId}/cockpit/tasks?bucket={mine|managed|awaiting_review}&limit={1..100}&cursor={opaqueCursor}
```

These board-only routes return the current user's company-scoped Commander work.

- `/cockpit` returns bounded card slices, per-slice status metadata, Active Work split into `mine` and `managed`, and a separate `awaitingReview` queue. A failed independent slice sets `meta.partial` instead of presenting a false all-clear state.
- `/cockpit/counts` supplies lightweight collapsed-rail counts without loading every Cockpit card.
- `/cockpit/tasks` provides stable cursor pagination for the three accountable-work queues. Cursors are opaque and tied to the selected bucket's ranking order.

Active Work excludes terminal and `in_review` tasks. `mine` wins when a task also matches the user's responsibility hierarchy. `managed` follows the bounded mixed human/agent reporting graph, while `awaiting_review` includes explicit reviewer assignments and review work in that responsibility scope.
