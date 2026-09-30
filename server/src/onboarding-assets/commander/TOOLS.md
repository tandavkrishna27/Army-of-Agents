# Commander — Tool Reference

<!-- GENERATED — DO NOT EDIT. Run `pnpm gen:tools:md`. Source: packages/shared/src/generated/tools.json -->

The 87 tools below are your complete set, generated from the live tool registry. Only call tools in this list; no other tool names exist.

**Tool naming convention.** Your AoA tools are exposed by the AoA MCP bridge with the namespace prefix `mcp__aoa__`. Inside this file the tools are written without the prefix for readability (e.g. `query_tasks`); when you invoke a tool call the prefixed form (`mcp__aoa__query_tasks`).

## Query Tools (read-only, call freely)

| Tool | R/W | Min role | What it does |
|------|-----|----------|--------------|
| `find_humans` | read | team_member | Find company humans by profile, role, responsibility, and capability documents. Read-only; use before routing or escalating work. |
| `find_similar_threads` | read | team_member | Find threads similar to a text query via embedding cosine similarity (HNSW). |
| `get_approval` | read | founder | Read one approval by id: its type, status, payload, and requester. Use to inspect a specific pending decision before acting on it. |
| `get_approval_tasks` | read | founder | List the tasks an approval is gating (what unblocks if it is approved). |
| `get_heartbeat_context` | read | team_member | Read a task plus its 10 most recent comments — including the auto-generated run-summary an agent posts after each run (outcome, duration, cost, files touched). Use to see what an agent actually did on a task. |
| `get_task` | read | team_member | Read the full context of a single task (your assigned task): identifier, title, description, status, priority, source discussion thread, assignee, responsible human owner, and execution workspace. Assignee means who does the task; responsible human owns the outcome. |
| `get_thread_summary` | read | team_member | Return a thread's summary, intent, phase, and crew participants. |
| `list_approval_comments` | read | founder | List the discussion/comments on an approval (context for the decision). |
| `list_approvals` | read | founder | List the company's approval requests (governance decisions awaiting a call), newest first. Optional filters: status (pending\|approved\|rejected\|revision_requested\|…), type. Use when asked what needs approval / what is waiting on the founder. |
| `list_thread_cards` | read | team_member | Fetch routing cards (summaryText + routingTerms) for active threads. Use this to get candidate threads before deciding where an inbound item belongs. |
| `query_activity` | read | team_member | Get recent activity log entries. |
| `query_agents` | read | team_member | List agents with optional department filter. |
| `query_artifacts` | read | team_member | List artifacts linked to a thread via discussion_entry_attachments. |
| `query_budget` | read | team_lead | Get budget summary for the company. |
| `query_company` | read | team_member | Get the current company's identity: name, vision, mission, issue prefix, and stage. Call this whenever you need to know who you are working for. |
| `query_company_artifacts` | read | team_member | List the company's recent artifacts (deliverables) across all threads and tasks, newest first. Optional filters: type (document\|presentation\|code\|design\|report\|other), status (draft\|active\|archived), limit (default 20, max 50). Use when asked what artifacts/documents/deliverables exist. |
| `query_departments` | read | team_member | List all departments. |
| `query_extracted_items` | read | team_member | List extracted items from a thread (decisions, tasks, insights, references, etc). |
| `query_goals` | read | team_member | List goals with optional status filter. |
| `query_human_context` | read | team_member | Read a company human's operational context bundle by user id, or resolve a natural-language query to the right human when there is exactly one match. Intended for Commander orchestration. |
| `query_humans` | read | team_member | List company humans from the team roster. Use for broad questions like who is in this org, who is on the team, or which humans exist. |
| `query_tasks` | read | team_member | List and filter tasks. Returns tasks matching the given filters. |
| `query_team_roster` | read | team_member | Read the unified company team roster and hierarchy across humans and org agents. Use for broad questions like who is on the team, who reports to whom, org chart, or humans and agents together. |
| `query_threads` | read | team_member | List threads (discussions) in this company. Optionally filter by phase or scope. |
| `thread.listEntries` | read | team_member | Read entries from a thread in chronological order (capped at 200). |
| `use_skill` | read | team_member | Load a skill's full instructions into context. Call this before applying any skill. The skill content will be available for the rest of this conversation. |

## Action Tools (confirm before calling)

| Tool | R/W | Min role | What it does |
|------|-----|----------|--------------|
| `advance_phase` | write | team_member | Advance a thread to the next phase. Requires autonomy level ≥ 2. |
| `approval_decision` | write | founder | Decide an approval: approve, reject, request revision, or resubmit. Founder-only, and always confirmed before it runs (irreversible governance action). |
| `assign_task` | write | team_lead | Assign a task to an agent or human. Assignee means who does the task; responsible human ownership is separate. |
| `attach_to_thread` | write | team_member | Move a thread_inbox_items entry to a real thread as a new discussion entry. |
| `create_agent` | write | founder | Create a new worker agent. Founder-only. |
| `create_artifact` | write | team_member | Create a new artifact (document, code, report, etc.) and optionally link it to a thread entry. |
| `create_artifact_version` | write | team_member | Create a new version of an existing artifact (Engineer iteration loop). |
| `create_department` | write | founder | Create a new department. Founder-only. |
| `create_goal` | write | team_lead | Create a new goal with optional department scope. |
| `create_task` | write | team_lead | Create a new task with title, optional description, priority, department, goal, assignee, and responsible human. Assignee means who does the task; responsible human owns the outcome. |
| `defer_inbox_to_human` | write | team_member | Finalize an inbound item you are UNSURE about: leave it in the Inbox for the founder to triage. Call this instead of returning silently when no thread is a confident home and a new thread isn't clearly warranted. |
| `delegate_to_subagent` | write | founder | Delegate a task to a named AoA sub-agent by enqueuing a wakeup request. The sub-agent will be triggered asynchronously by the AoA dispatcher. |
| `promote_inbox_to_thread` | write | team_member | Create a new thread from an inbound inbox item. At full_auto dial: auto-creates the thread. At auto_attach/suggest dial: records a 'suggest_new' decision surfaced to the founder. |
| `propose_crew_work` | write | team_member | Propose crew work for this thread. Resolves the effective autonomy (thread or company level) and routes through the unified D11 chokepoint. At autonomy L1 the scope card is written and awaits human approval; at L2 the card is written and immediately auto-approved, dispatching the assigned agents. |
| `request_thread_workspace` | write | team_member | Create an execution_workspace scoped to a thread (Engineer-only; opt-in for interactive/dev-server work). |
| `spin_off_thread` | write | team_member | Create a new thread spun off from an existing thread. Optionally copy seed entries; writes a thread_links row of kind 'spinoff'. |
| `thread.createLink` | write | team_member | Create a typed link between two threads. |
| `thread.postScopeProposal` | write | team_member | Post a scope_proposal entry to a thread and populate thread_plan_steps (single transaction). |
| `thread.setIntent` | write | team_member | Set the intent classification on a thread (e.g. planning, research, problem, alignment). |
| `thread.updateSummary` | write | team_member | Update a thread's summary text + routing terms, then queue embedding regeneration. |
| `update_agent` | write | founder | Update agent configuration. Founder-only. |
| `update_company_identity` | write | founder | Update the company's vision and/or mission statement. Only call this after the user has reviewed and approved the new text. Gated to founders only. |
| `update_task` | write | team_lead | Update an existing task's title, status, priority, or responsible human. Use assign_task for assignee reassignment. |
| `wakeup_agent` | write | team_lead | Trigger an agent's heartbeat to start working. |

## Memory Tools

| Tool | R/W | Min role | What it does |
|------|-----|----------|--------------|
| `archive_stale_memory` | write | team_member | Archive approved memory items whose accessedAt is older than the threshold (default 90 days). Founder approval required. |
| `detect_conflicts` | read | team_member | Check if proposed memory content conflicts with existing items. |
| `extract_decisions` | read | team_member | Extract decision-type memory candidates from a thread (filtered subset of extract_memory_candidates). |
| `extract_insights` | read | team_member | Extract insight-type memory candidates from a thread (filtered subset of extract_memory_candidates). |
| `extract_memory_candidates` | read | team_member | Run LLM extraction over thread entries and return structured memory candidates (decisions, insights, references, etc.). Does not persist — pair with submit_extracted_items or propose_memory_from_thread to act on the results. |
| `extract_references` | read | team_member | Extract reference-type memory candidates from a thread (filtered subset of extract_memory_candidates). |
| `find_similar_memory` | read | team_member | Find semantically similar memory items using vector search. |
| `find_similar_memory_hnsw` | read | team_member | Find existing memory items semantically similar to a query via direct HNSW cosine search. |
| `forget_working_context` | write | team_member | Archive temporary scoped Commander working context. |
| `propose_memory_from_thread` | write | team_member | Propose a memory item (status='pending', founder approves) seeded from a thread. Inherits visibility + scope from the source thread. Private threads may only propose working or active_context layers. |
| `query_memory` | read | team_member | Search memory items with optional layer and text filters. |
| `remember_working_context` | write | team_member | Remember temporary scoped Commander working context for the current project, goal, task, or conversation. |
| `suggest_memory` | write | team_lead | Propose a new memory item for founder approval (status: pending). |
| `update_memory` | write | team_lead | Update an existing memory item's content or layer. |
| `update_working_context` | write | team_member | Update temporary scoped Commander working context. |
| `write_memory` | write | team_member | Create a memory item (status='pending', founder approves per Critical Rule #6) and enqueue it for RAG indexing. Use for capturing important knowledge discovered during task execution that should be reviewed and promoted to company memory. layer='domain' requires a departmentId; layer='identity' must not have one. For temporary working notes scoped only to this agent, prefer the MCP memory.retain tool with scopeToSelf=true and layer=working. |

## Discussion Tools

| Tool | R/W | Min role | What it does |
|------|-----|----------|--------------|
| `extract_from_content` | read | founder | Trigger extraction of tasks and memory items from a discussion entry. |
| `link_discussion_to_project` | write | team_lead | Scope a discussion to a project, department, or goal. |
| `post_entry` | write | team_member | Post a message to a thread as this agent. Use for crew coordination, summaries, and @mentions. |
| `search_discussions` | read | team_member | Search discussions by title. |
| `submit_extracted_items` | write | founder | Persist structured extracted items (decisions, tasks, insights, etc.) for a discussion entry and mark the entry's extraction as completed. Called by the discussion-extraction agent to write its results. |

## Workflow Tools

| Tool | R/W | Min role | What it does |
|------|-----|----------|--------------|
| `add_task_dependency` | write | team_lead | Add a blocking dependency between two tasks. |
| `create_workflow_template` | write | team_lead | Create a reusable workflow template with steps and dependencies. |
| `instantiate_workflow` | write | team_lead | Create tasks from a workflow template. |

## File Tools

| Tool | R/W | Min role | What it does |
|------|-----|----------|--------------|
| `read_file` | read | team_lead | Read an artifact's content. Returns the latest version by default, or a specific version number. |

## Coordination Tools

| Tool | R/W | Min role | What it does |
|------|-----|----------|--------------|
| `agent.dispatch` | write | team_member | Dispatch another AoA agent by inserting a wakeup row. Does NOT call heartbeat directly — the dispatcher's drain loop picks it up. Respects hop-count cap (max 3) and dedupes within a single thread context. |
| `ask_founder` | write | team_member | Compatibility alias for ask_human. Recipient routing still follows the task's responsible human and reviewer. |
| `ask_human` | write | team_member | Ask the responsible human a durable task question. The same question appears in Commander, Inbox, Task Work, Workspace, and the source Discussion. The run waits briefly, then parks cleanly and continues once answered. |
| `attach_task_artifact` | write | team_member | Attach your work product to a task as a deliverable: creates a new artifact (document, code, report, etc.) authored by you, links it to the task, and records it in the task's output index. Use this to hand back the result of your work. |
| `hub.readCurationContext` | read | team_member | Read bounded, redacted hub item context for Steward curation. This returns hub envelopes and source pointers only; it never reads raw source bodies or mutates lifecycle state. |
| `hub.updateCurationSummary` | write | team_member | Write a bounded Steward curation summary or explanation for a hub item. This only updates display curation metadata and never resolves, archives, approves, rejects, or changes source-side state. |
| `notify_owner` | write | team_member | Send a notification to the thread owner. Use when the crew needs human attention or approval. |
| `post_task_comment` | write | team_member | Post a comment back onto a task (typically your assigned task) — for example a progress note, a summary of what you did, or a question for the founder. The comment is recorded as authored by you. |
| `query_dependency_chain` | read | team_member | Analyze task dependency chain — find what blocks a task or what it blocks. |
| `set_task_status` | write | team_member | Move your own assigned task forward to a new status (for example from in_progress to in_review, or to done). Whether a transition is allowed depends on your autonomy level — moving a task to review requires at least Assist, and completing it requires Drive. Use this when you have finished a unit of work and want to hand the task to the next stage. |

## Analysis Tools

| Tool | R/W | Min role | What it does |
|------|-----|----------|--------------|
| `analyze_workload` | read | team_lead | Get workload balance insights from the suggestion engine. |
| `suggest_improvements` | read | team_lead | Run all detectors and return pending improvement suggestions. |

## Usage Rules

1. **Never guess a tool name.** The tools above are your complete set. If a skill references a tool not on this list, flag it — don't attempt the call.
2. **Query before action.** Call read tools to gather current state before any write.
3. **Confirm before write.** All write tools require confirmation via ⚡OPTIONS⚡ unless a loaded skill grants auto-execute for the step.
4. **Memory governance.** `suggest_memory` → PENDING. Use `detect_conflicts` before proposing memory that might contradict existing items.
