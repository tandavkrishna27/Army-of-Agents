# Commander Human Tools and Codex Traces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Commander answer broad team/human questions from first-class human roster/context tools, and persist Codex MCP tool calls/results into AoA conversation/run records.

**Architecture:** Keep existing company-scoped services as the source of truth. Add a read-only human roster tool beside `find_humans` and `query_human_context`, keep search behavior intact for routing queries, and extend Codex JSONL parsing so raw MCP call events become normal AoA `tool_call` / `tool_result` chunks that `agent-loop` already knows how to persist.

**Tech Stack:** Express 5 routes, Drizzle-backed services, `@armyofagents/shared` validators/types, internal-agent MCP tools, codex-local adapter parser, Vitest, React/Vite Commander UI live E2E.

---

## Ground Truth From Investigation

- Live company: `EET`, company id `0eec7b7e-a1de-4af5-b04d-0a16345d773b`.
- Commander was configured to Codex via `PATCH /api/companies/:companyId/internal-agent/config` with `cliTool: "codex"`.
- `/api/companies/:companyId/team` returned one human: `local-board`, display name `Live Codex Human`, role `founder`, title `Human Routing Specialist`.
- `/api/companies/:companyId/team/users/local-board/agent-context` returned the full human context bundle with identity, authority, responsibilities, six capability documents, and rendered markdown.
- `find_humans` worked for specific queries like `Live Codex Human` and the seeded capability phrase.
- `find_humans` returned zero for broad generic text like `all humans in organization` because search requires a matching query string.
- `query_human_context` worked when given `userId`, but natural-language query `humans in this organization` returned `mode: "no_match"` because it delegates to search.
- Raw Codex rollout JSONL for the latest Commander turn contained `response_item/function_call`, `event_msg/mcp_tool_call_end`, and `response_item/function_call_output` records for AoA tools.
- AoA persisted the assistant answer, but `internal_agent_messages.toolCalls`, `toolResults`, and `internal_agent_runs.toolsCalled` stayed empty/null.
- Root parser gap: `packages/adapters/codex-local/src/server/parse.ts` currently recognizes `item.completed` tool-result shapes, not the rollout records Codex actually produced in this Commander run.

## Product Decisions Locked

- Broad team/org roster questions should include humans and agents.
- Human roster listing should be a first-class read-only tool, not a search hack.
- `find_humans` remains for capability/person/role search and routing.
- `query_human_context` remains for one human's full operational context; it should resolve exact single human matches, but should not pretend a generic roster question is a context target.
- Codex tool traces should be persisted for observability and later UI display.

## File Structure

- Modify `server/src/services/team.ts`: expose or reuse a company-scoped member listing method if the existing `listTeam` shape is enough.
- Modify `server/src/services/internal-agent/tools/query-tools.ts`: add `query_humans` and update tool descriptions.
- Modify `server/src/services/internal-agent/agent-loop.ts`: persist tool result details, not only summaries, if parser chunks provide them.
- Modify `server/src/services/internal-agent/cli-mode.ts`: carry parsed Codex tool chunks through the existing stream.
- Modify `packages/adapters/codex-local/src/server/parse-shared.ts`: add shared chunk types/helpers for Codex function calls and MCP results.
- Modify `packages/adapters/codex-local/src/server/parse.ts`: parse rollout `function_call`, `mcp_tool_call_end`, and `function_call_output` records.
- Modify `packages/adapters/codex-local/src/server/app-server/parse-events.ts`: keep parser parity if the same event shapes can arrive through app-server notifications.
- Modify Commander prompt/tool reference source files discovered by `rg "Who is on the team|Tool Reference|query_agents"`: update team guidance so humans are included.
- Test `server/src/__tests__/query-tools.test.ts`.
- Test `server/src/__tests__/query-human-context-tool.test.ts`.
- Test `packages/adapters/codex-local/src/server/parse.test.ts`.
- Test `packages/adapters/codex-local/src/server/__tests__/appserver-parse-events.test.ts`.
- Add/modify route tests only if a new REST endpoint is added; prefer tool-only for this phase unless UI needs direct roster API changes.

---

### Task 1: Add `query_humans` As A First-Class Commander Tool

**Files:**
- Modify: `server/src/services/internal-agent/tools/query-tools.ts`
- Modify: `server/src/__tests__/query-tools.test.ts`

- [ ] **Step 1: Write the failing query tool test**

Add this behavior to `server/src/__tests__/query-tools.test.ts`:

```ts
it("query_humans returns the company human roster without requiring search text", async () => {
  const services = mockServices();
  (services as any).team = {
    listTeam: vi.fn().mockResolvedValue({
      members: [
        {
          userId: "local-board",
          email: "local@aoa.local",
          displayName: "Live Codex Human",
          avatarUrl: null,
          title: "Human Routing Specialist",
          bio: "Owns live commander human routing validation.",
          location: null,
          timezone: null,
          socialLinks: [],
          role: "founder",
          departmentId: null,
          departmentName: null,
          permissions: [],
          isCurrentUser: true,
          isSystemAdmin: true,
          parentType: null,
          parentId: null,
        },
      ],
      pendingInvites: [],
    }),
  };
  const ctx = makeCtx(services);
  const queryHumans = createQueryTools().find((tool) => tool.name === "query_humans")!;

  const result = await queryHumans.execute({ limit: 20 }, ctx);

  expect(result.success).toBe(true);
  expect((result.data as any).results).toHaveLength(1);
  expect((result.data as any).results[0]).toMatchObject({
    userId: "local-board",
    displayName: "Live Codex Human",
    role: "founder",
    title: "Human Routing Specialist",
  });
  expect(result.summary).toBe("Found 1 human(s)");
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
pnpm --filter @armyofagents/server test -- query-tools.test.ts
```

Expected: FAIL because `query_humans` does not exist.

- [ ] **Step 3: Add `team` to the internal-agent service container type/mock if missing**

If `ServiceContainer` does not expose `team`, add it in `server/src/services/internal-agent/types.ts` and `server/src/services/internal-agent/service-container.ts`:

```ts
team: ReturnType<typeof teamService>;
```

Expected implementation source:

```ts
team: teamService(db),
```

- [ ] **Step 4: Implement the minimal `query_humans` tool**

Add this tool before `find_humans` in `createQueryTools()`:

```ts
{
  name: "query_humans",
  description:
    "List company humans from the team roster. Use for broad questions like who is in this org, who is on the team, or which humans exist.",
  parameters: {
    type: "object",
    properties: {
      role: { type: "string", description: "Optional role filter: founder, team_lead, team_member, or all" },
      departmentId: { type: "string", description: "Optional department id filter" },
      limit: { type: "number", description: "Max results to return, default 20, max 50" },
    },
  },
  category: "query",
  requiredRole: "team_member",
  requiresConfirmation: false,
  execute: async (params: unknown, ctx) => {
    const raw = (params ?? {}) as Record<string, unknown>;
    const role = typeof raw.role === "string" ? raw.role : "all";
    const departmentId = typeof raw.departmentId === "string" ? raw.departmentId : null;
    const rawLimit = typeof raw.limit === "number" && Number.isFinite(raw.limit) ? Math.floor(raw.limit) : 20;
    const limit = Math.min(Math.max(rawLimit, 1), 50);
    const summary = await ctx.services.team.listTeam(ctx.companyId, ctx.userId ?? null);
    const results = summary.members
      .filter((member) => role === "all" || member.role === role)
      .filter((member) => departmentId === null || member.departmentId === departmentId)
      .slice(0, limit)
      .map((member) => ({
        userId: member.userId,
        email: member.email,
        displayName: member.displayName,
        avatarUrl: member.avatarUrl,
        title: member.title,
        role: member.role,
        departmentId: member.departmentId,
        departmentName: member.departmentName,
        reportsToUserId: member.parentId,
        isSystemAdmin: member.isSystemAdmin,
      }));
    return {
      success: true,
      data: { companyId: ctx.companyId, results },
      summary: `Found ${results.length} human(s)`,
    };
  },
}
```

- [ ] **Step 5: Update the query tool count test**

Change:

```ts
expect(tools).toHaveLength(9);
```

to:

```ts
expect(tools).toHaveLength(10);
expect(tools.map((tool) => tool.name)).toContain("query_humans");
```

- [ ] **Step 6: Run query tool tests**

Run:

```bash
pnpm --filter @armyofagents/server test -- query-tools.test.ts query-human-context-tool.test.ts
```

Expected: PASS.

---

### Task 2: Make Generic Roster Questions Resolve To Roster, Not Human Context Search

**Files:**
- Modify: `server/src/services/internal-agent/tools/query-tools.ts`
- Modify: `server/src/__tests__/query-human-context-tool.test.ts`

- [ ] **Step 1: Write the failing guard test**

Add:

```ts
it("does not treat generic roster questions as a single human context target", async () => {
  const search = vi.fn();
  const getBundle = vi.fn();
  const tool = createQueryTools().find((candidate) => candidate.name === "query_human_context");

  const result = await tool!.execute({ q: "humans in this organization" }, {
    companyId: "company-1",
    userId: "commander-user-1",
    services: { humanContext: { getBundle }, humanDiscovery: { search } },
  } as never);

  expect(search).not.toHaveBeenCalled();
  expect(getBundle).not.toHaveBeenCalled();
  expect(result.success).toBe(false);
  expect(result.summary).toContain("Use query_humans");
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
pnpm --filter @armyofagents/server test -- query-human-context-tool.test.ts
```

Expected: FAIL because the current implementation delegates generic text to `humanDiscovery.search`.

- [ ] **Step 3: Add a small generic-roster detector**

In `query-tools.ts`, add:

```ts
function isGenericHumanRosterQuery(q: string) {
  return /\b(all|list|show|who|which)\b/i.test(q) && /\b(humans|people|members|team|org|organization)\b/i.test(q);
}
```

Then before discovery search in `query_human_context.execute`:

```ts
if (isGenericHumanRosterQuery(q)) {
  return {
    success: false,
    error: "query_humans is required for broad human roster questions",
    data: null,
    summary: "Use query_humans for broad roster questions; use query_human_context for one specific human.",
  };
}
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
pnpm --filter @armyofagents/server test -- query-human-context-tool.test.ts query-tools.test.ts
```

Expected: PASS.

---

### Task 3: Update Commander Tool Guidance To Include Humans And Agents

**Files:**
- Modify the Commander prompt/tool reference file found by:

```bash
rg -n "Who is on the team|Tool Reference|query_agents|query_departments" server/src packages -S
```

- [ ] **Step 1: Locate the prompt source**

Run:

```bash
rg -n "Who is on the team|Tool Reference|query_agents|query_departments" server/src packages -S
```

Expected: one or more Commander instruction source files.

- [ ] **Step 2: Update the tool table**

Change the team-row guidance from:

```md
| Who is on the team? | `query_agents` + `query_departments` |
```

to:

```md
| Who is on the team? | `query_humans` + `query_agents` + `query_departments` |
```

Add `query_humans` to the read-only query tools list:

```md
| `query_humans` | Human roster with role, title, department, reporting, and admin signal |
```

- [ ] **Step 3: Add a prompt regression test if prompt tests exist**

Find prompt tests:

```bash
rg -n "Commander.*Tool Reference|query_departments|query_agents" server/src/__tests__ packages -S
```

If an existing prompt snapshot/string test exists, add assertions:

```ts
expect(prompt).toContain("query_humans");
expect(prompt).toContain("query_humans` + `query_agents` + `query_departments");
```

- [ ] **Step 4: Run prompt/tool tests**

Run the focused test command matching the discovered test file. If none exists, run:

```bash
pnpm --filter @armyofagents/server test -- query-tools.test.ts
```

Expected: PASS.

---

### Task 4: Persist Codex MCP Tool Calls And Results

**Files:**
- Modify: `packages/adapters/codex-local/src/server/parse-shared.ts`
- Modify: `packages/adapters/codex-local/src/server/parse.ts`
- Modify: `packages/adapters/codex-local/src/server/__tests__/appserver-parse-events.test.ts` if app-server parity applies
- Modify: `server/src/services/internal-agent/agent-loop.ts`

- [ ] **Step 1: Write a failing Codex parser test for rollout tool events**

Create or extend `packages/adapters/codex-local/src/server/parse.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseCodexJsonl } from "./parse.js";

describe("parseCodexJsonl MCP function traces", () => {
  it("parses response function calls and MCP call results into tool chunks", () => {
    const stdout = [
      JSON.stringify({
        timestamp: "2026-07-08T11:48:43.459Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "find_humans",
          namespace: "mcp__aoa__",
          arguments: "{\"q\":\"Live Codex Human\",\"role\":\"all\",\"limit\":10}",
          call_id: "call_1",
        },
      }),
      JSON.stringify({
        timestamp: "2026-07-08T11:48:43.499Z",
        type: "event_msg",
        payload: {
          type: "mcp_tool_call_end",
          call_id: "call_1",
          invocation: {
            server: "aoa",
            tool: "find_humans",
            arguments: { q: "Live Codex Human", role: "all", limit: 10 },
          },
          result: {
            Ok: {
              content: [
                {
                  type: "text",
                  text: "{\"success\":true,\"data\":{\"results\":[{\"userId\":\"local-board\",\"displayName\":\"Live Codex Human\"}]},\"summary\":\"Found 1 human(s)\"}",
                },
              ],
              isError: false,
            },
          },
        },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Live Codex Human." },
      }),
    ].join("\n");

    const parsed = parseCodexJsonl(stdout);

    expect(parsed.summary).toBe("Live Codex Human.");
    expect(parsed.chunks).toEqual([
      {
        type: "tool_call",
        name: "find_humans",
        input: { q: "Live Codex Human", role: "all", limit: 10 },
        callId: "call_1",
      },
      {
        type: "tool_result",
        name: "find_humans",
        callId: "call_1",
        result: expect.objectContaining({
          success: true,
          summary: "Found 1 human(s)",
        }),
        refs: [],
      },
    ]);
  });
});
```

- [ ] **Step 2: Run the failing parser test**

Run:

```bash
pnpm --filter @armyofagents/adapter-codex-local test -- parse.test.ts
```

Expected: FAIL because `tool_call` chunks are not currently emitted for rollout `function_call` records.

- [ ] **Step 3: Extend `CodexParsedChunk`**

In `parse-shared.ts`, extend the union:

```ts
| {
    type: "tool_call";
    name: string;
    input: unknown;
    callId?: string;
  }
| {
    type: "tool_result";
    name: string;
    callId?: string;
    result: { success: boolean; data: unknown; summary: string };
    refs: LiftedOutputRef[];
  }
```

- [ ] **Step 4: Parse rollout `function_call` records**

In `parse.ts`, when `event.type === "response_item"` and `payload.type === "function_call"`:

```ts
const payload = parseObject(event.payload);
if (asString(payload.type, "") === "function_call") {
  const name = asString(payload.name, "");
  if (name) {
    const rawArgs = asString(payload.arguments, "");
    let input: unknown = {};
    try {
      input = rawArgs ? JSON.parse(rawArgs) : {};
    } catch {
      input = rawArgs;
    }
    chunks.push({
      type: "tool_call",
      name,
      input,
      callId: asString(payload.call_id, "") || undefined,
    });
  }
  continue;
}
```

- [ ] **Step 5: Parse rollout `mcp_tool_call_end` records**

In `parse.ts`, when `event.type === "event_msg"` and `payload.type === "mcp_tool_call_end"`:

```ts
const payload = parseObject(event.payload);
if (asString(payload.type, "") === "mcp_tool_call_end") {
  const invocation = parseObject(payload.invocation);
  const tool = asString(invocation.tool, "");
  const resultRecord = parseObject(payload.result);
  const ok = parseObject(resultRecord.Ok);
  const content = ok.content;
  const text = Array.isArray(content)
    ? content.map((entry) => asString(parseObject(entry).text, "")).join("")
    : "";
  let parsedResult: any = null;
  try {
    parsedResult = text ? JSON.parse(text) : null;
  } catch {
    parsedResult = null;
  }
  chunks.push({
    type: "tool_result",
    name: tool,
    callId: asString(payload.call_id, "") || undefined,
    result: {
      success: parsedResult?.success ?? ok.isError !== true,
      data: parsedResult?.data ?? text,
      summary: asString(parsedResult?.summary, "") || text.slice(0, 500),
    },
    refs: liftOutputRefs(text) ?? [],
  });
  continue;
}
```

- [ ] **Step 6: Persist richer tool call/result data in `agent-loop`**

Update the chunk handling so it keeps call id and inputs:

```ts
const turnToolCalls: Array<{ id?: string; name: string; input?: unknown; success?: boolean; summary?: string; result?: unknown }> = [];
```

On tool call:

```ts
turnToolCalls.push({ id: chunk.callId, name: chunk.name, input: chunk.input });
```

On tool result:

```ts
const enriched = {
  success: chunk.result?.success ?? true,
  summary: humanToolSummary(chunk.name, chunk.result?.summary ?? chunk.result?.data),
  result: chunk.result?.data ?? chunk.result,
};
const match = turnToolCalls.find((c) => (chunk.callId && c.id === chunk.callId) || (c.name === chunk.name && c.success === undefined));
if (match) Object.assign(match, enriched);
else turnToolCalls.push({ id: chunk.callId, name: chunk.name, ...enriched });
```

- [ ] **Step 7: Run parser and server tests**

Run:

```bash
pnpm --filter @armyofagents/adapter-codex-local test -- parse.test.ts appserver-parse-events.test.ts
pnpm --filter @armyofagents/server test -- query-tools.test.ts query-human-context-tool.test.ts
```

Expected: PASS.

---

### Task 5: Live Commander E2E Verification

**Files:**
- No production files unless a bug is found during E2E.

- [ ] **Step 1: Start or reuse the isolated dev server**

Run:

```bash
pnpm dev
```

Expected: app reachable at the isolated port already in use for this worktree, currently `http://127.0.0.1:3211`.

- [ ] **Step 2: Configure Commander as Codex**

Use API or UI:

```bash
curl -X PATCH http://127.0.0.1:3211/api/companies/0eec7b7e-a1de-4af5-b04d-0a16345d773b/internal-agent/config ^
  -H "Content-Type: application/json" ^
  -d "{\"cliTool\":\"codex\"}"
```

Expected: response contains `"cliTool":"codex"`.

- [ ] **Step 3: Ask broad roster question in the UI**

Prompt:

```text
Who is on the team in this org? Include humans and agents.
```

Expected visible answer:

```text
Humans
- Live Codex Human - founder, Human Routing Specialist

Agents
- No agents configured

Departments
- No departments configured
```

- [ ] **Step 4: Ask specific human context question in the UI**

Prompt:

```text
Load the full context for Live Codex Human and summarize their role, responsibilities, and capabilities.
```

Expected: Commander calls `query_human_context`, resolves `Live Codex Human`, and mentions role `founder`, title `Human Routing Specialist`, created task count, and `skills.md`.

- [ ] **Step 5: Verify persisted tool calls**

Run:

```bash
curl http://127.0.0.1:3211/api/companies/0eec7b7e-a1de-4af5-b04d-0a16345d773b/internal-agent/conversation
```

Expected: latest assistant messages have non-null `toolCalls` including `query_humans`, `query_agents`, `query_departments`, and `query_human_context`.

- [ ] **Step 6: Verify run history observability**

Run:

```bash
curl "http://127.0.0.1:3211/api/companies/0eec7b7e-a1de-4af5-b04d-0a16345d773b/internal-agent/runs?limit=5"
```

Expected: the latest conversation run has tool trace data if run-level `toolsCalled` is wired in this phase. If not, record it as a follow-up and ensure message-level persistence is complete.

---

### Task 6: Full Verification Before Hand-Off

**Files:**
- No new files.

- [ ] **Step 1: Run focused tests**

```bash
pnpm --filter @armyofagents/server test -- query-tools.test.ts query-human-context-tool.test.ts human-discovery-routes.test.ts human-context-routes.test.ts
pnpm --filter @armyofagents/adapter-codex-local test -- parse.test.ts appserver-parse-events.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run repo checks required by AGENTS.md**

```bash
pnpm -r typecheck
pnpm test:run
pnpm build
```

Expected: PASS. If any fail for unrelated existing reasons, capture the exact failure and do not claim green.

- [ ] **Step 3: Document final live evidence**

Record:

```text
Commander provider: Codex
Broad roster prompt: passed / failed
Specific context prompt: passed / failed
Conversation toolCalls persisted: yes / no
Run toolsCalled persisted: yes / no
Tests run: commands and pass/fail
```

---

## Engineering Review

### Scope Challenge

Scope accepted as one phase because the three gaps are connected in one user-facing flow: Commander must choose the correct human tool, execute it through Codex, and preserve the trace. Splitting parser persistence from human roster semantics is possible, but doing only one would still leave the live Commander test misleading.

### Architecture Review

1. `query_humans` must use `team.listTeam`, not `humanDiscovery.search`, because roster listing is not search.
2. `find_humans` should keep requiring `q`; relaxing it to empty search would blur search/list semantics and could degrade routing precision.
3. `query_human_context` should reject generic roster queries with a helpful summary so Commander learns to call `query_humans`.
4. Codex parser changes should be adapter-local and stream normalized chunks into the existing `agent-loop`; avoid custom DB writes from the parser.
5. Message-level `toolCalls` are required for this phase. Run-level `toolsCalled` is valuable, but can be a follow-up if it requires a wider run-summary contract.

### Test Review

- Unit tests cover tool registration, roster listing, context guard behavior, and Codex JSONL parsing.
- Integration route tests already cover search/context routes; add only if a new REST endpoint is introduced.
- Live E2E is required because the previous bug only became obvious when Commander ran through Codex with real MCP tools.
- Regression test must include the actual Codex rollout event shapes: `response_item/function_call`, `event_msg/mcp_tool_call_end`, and `response_item/function_call_output`.

### Performance Review

- `query_humans` should call `team.listTeam` once and slice/filter in memory; acceptable for current team sizes.
- `find_humans` currently calls `team.getDependencies` per scored match. This remains unchanged.
- Codex parser work is linear over JSONL lines and should not add meaningful overhead.

### Risks And Mitigations

- Risk: Commander still chooses `find_humans` for broad roster questions. Mitigation: prompt guidance plus `query_humans` tool description that explicitly names broad team/org questions.
- Risk: Parser double-counts tool calls if both `mcp_tool_call_end` and `function_call_output` are parsed as results. Mitigation: prefer `mcp_tool_call_end` for MCP results and dedupe by `call_id`.
- Risk: Tool result payloads are large. Mitigation: persist summary and bounded data first; cap or omit raw output if needed after tests show shape.
- Risk: App-server parser parity drifts. Mitigation: add/update parity test if app-server receives matching event shapes.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | not run | Product decisions were confirmed in chat: roster includes humans and agents |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | not run | Not needed before implementation; run after diff exists |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | clear | 5 architecture findings, 4 test requirements, 0 blocking unresolved decisions |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | not run | No UI layout work in this phase beyond live Commander verification |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | not run | Not applicable |

- **UNRESOLVED:** Whether run-level `internal_agent_runs.toolsCalled` must be completed in the same phase or can follow message-level persistence. Recommendation: message-level persistence is required; run-level persistence is same-branch if low-risk.
- **VERDICT:** ENG CLEARED - ready to implement with TDD and live Codex Commander E2E.
