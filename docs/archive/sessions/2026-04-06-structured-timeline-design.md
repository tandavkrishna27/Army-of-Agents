# Structured Timeline Rendering — Design Spec

**Date:** 2026-04-06
**Scope:** Workspace timeline only (WorkspaceTimeline component)
**Approach:** Build new rendering layer on existing AoA transcript infrastructure, inspired by AoA's RunTranscriptView + vibe-kanban's aggregation

---

## Problem

AoA's workspace timeline renders agent run output as raw `<pre>` text dumps (RunBlock.tsx, line 74). Despite having a full structured parsing pipeline (TranscriptEntry types, buildTranscript(), 7 adapter parsers), the frontend throws away the structure and shows unformatted logs. This is unusable for non-developers and hard to scan even for engineers.

## Goal

Replace the raw `<pre>` dump in RunBlock with structured, department-aware rendering that feels like a chat thread where the agent shows its work — not a terminal log. The timeline should be intuitive for marketing managers, finance analysts, support leads, and engineers alike.

---

## What Already Exists in AoA (No Changes Needed)

| Layer | File | What it does |
|-------|------|-------------|
| TranscriptEntry types | `packages/adapter-utils/src/types.ts:194-206` | 10 entry kinds: assistant, thinking, user, tool_call, tool_result, init, result, stderr, system, stdout |
| buildTranscript() | `ui/src/adapters/transcript.ts` | Parses raw NDJSON RunLogChunk[] into TranscriptEntry[] with line buffering |
| Adapter parsers | `packages/adapters/*/src/ui/parse-stdout.ts` | 7 parsers: claude-local, codex-local, cursor-local, gemini-local, openclaw, opencode-local, http |
| Adapter registry | `ui/src/adapters/registry.ts` | Maps adapterType string to UIAdapterModule with parseStdoutLine |
| NDJSON log storage | `server/src/services/run-log-store.ts` | Stores run logs as `{ ts, stream, chunk }` lines |
| heartbeat_run_events | `packages/db/src/schema/heartbeat_run_events.ts` | Structured event storage with eventType, stream, level, payload JSONB |
| WebSocket streaming | `server/src/services/live-events.ts` | Live events: heartbeat.run.log, heartbeat.run.event, heartbeat.run.status |
| WorkspaceTimeline | `ui/src/components/workspace/WorkspaceTimeline.tsx` | Container: fetches comments + runs, merges chronologically, chat input |
| heartbeatsApi.log() | `ui/src/api/heartbeats.ts` | Fetches run log content in chunks |

## What Gets Ported from AoA (Reference)

| What | Source file | How used |
|------|-----------|----------|
| normalizeTranscript() | `paperclip/ui/src/components/transcript/RunTranscriptView.tsx:390-579` | Port the aggregation logic (tool_call + tool_result matching, message merging, stderr grouping, command grouping, tool grouping) |
| TranscriptBlock type | Same file, lines 30-107 | Port the type definition as-is |
| Helper functions | Same file, lines 109-250 | Port: isCommandTool, extractToolUseId, summarizeToolInput, stripWrappedShell, displayToolName, formatToolPayload, summarizeRecord, parseStructuredToolResult |
| groupCommandBlocks() | Same file | Port as-is |
| groupToolBlocks() | Same file | Port as-is |

**NOT porting:** The rendering components from RunTranscriptView (we build new ones). NOT porting from vibe-kanban (architecture too different — Rust backend, NormalizedEntry, execution processes).

## What Gets Built New

1. Aggregation pass 2 (consecutive same-category grouping, inspired by vibe-kanban)
2. Entry classification system (department-aware tool categorization)
3. Rendering components (pills, cards, messages — matching vibe-kanban visual style)
4. Integration into RunBlock/TimelineAgentMessage

---

## Architecture

### Data Flow

```
Raw NDJSON log (existing)
    |
    v
buildTranscript(chunks, adapterParser)        ← existing in AoA
    |
    v
TranscriptEntry[]                              ← existing type
    |
    v
normalizeTranscript(entries, streaming)         ← ported from AoA
    |
    v
TranscriptBlock[]                              ← ported type
    |
    v
aggregateBlocks(blocks, departmentType)         ← NEW
    |
    v
(TranscriptBlock | AggregatedGroup)[]          ← NEW type
    |
    v
renderTranscriptBlock(block, dept, density)     ← NEW dispatch
    |
    v
Specialized React components                   ← NEW
```

### TranscriptBlock Type (from AoA)

```typescript
type TranscriptBlock =
  | { type: "message"; role: "assistant" | "user"; ts: string; text: string; streaming: boolean }
  | { type: "thinking"; ts: string; text: string; streaming: boolean }
  | { type: "tool"; ts: string; endTs?: string; name: string; toolUseId?: string; input: unknown; result?: string; isError?: boolean; status: "running" | "completed" | "error" }
  | { type: "activity"; ts: string; activityId?: string; name: string; status: "running" | "completed" }
  | { type: "command_group"; ts: string; endTs?: string; items: Array<{ ts: string; endTs?: string; input: unknown; result?: string; isError?: boolean; status: "running" | "completed" | "error" }> }
  | { type: "tool_group"; ts: string; endTs?: string; items: Array<{ ts: string; endTs?: string; name: string; input: unknown; result?: string; isError?: boolean; status: "running" | "completed" | "error" }> }
  | { type: "stderr_group"; ts: string; endTs?: string; lines: Array<{ ts: string; text: string }> }
  | { type: "stdout"; ts: string; text: string }
  | { type: "event"; ts: string; label: string; tone: "info" | "warn" | "error" | "neutral"; text: string; detail?: string };
```

### Aggregated Group Types (new)

```typescript
type AggregatedGroup =
  | { type: "read_group"; items: TranscriptBlock[]; count: number }
  | { type: "edit_group"; filePath: string; items: TranscriptBlock[]; totalAdditions: number; totalDeletions: number }
  | { type: "multi_edit_group"; items: TranscriptBlock[]; fileCount: number }
  | { type: "search_group"; items: TranscriptBlock[]; count: number }
  | { type: "web_group"; items: TranscriptBlock[]; count: number }
  | { type: "thinking_group"; items: TranscriptBlock[]; isPreviousTurn: boolean }
  | { type: "generic_group"; category: string; items: TranscriptBlock[]; count: number };

// Minimum 2 consecutive same-category entries to form a group.
// Single entries render as-is (not wrapped).
```

---

## Entry Classification System

### classifyToolEntry(name, input, departmentType): EntryCategory

Priority:
1. Exact tool name match
2. Pattern match on tool name (e.g. `*_search`)
3. Command content analysis for command entries (detects git, npm test, build commands)
4. Department-specific matching (only when departmentType matches)
5. Fallback to `generic_tool`

### Universal Categories (all departments)

| Category | Tool name matches | Pill render |
|----------|------------------|-------------|
| `message` | (entry kind: assistant, user) | Chat bubble with markdown |
| `thinking` | (entry kind: thinking) | Collapsed dot, expandable |
| `file_read` | Read, cat, head, file_read, ReadFile | "Read · filename" |
| `file_edit` | Edit, Write, file_edit, EditFile, NotebookEdit | "filename · +N -N" |
| `search` | Grep, Glob, search, find, ripgrep | "Search · query" |
| `command` | Bash, shell, bash, command_execution, shellToolCall | "Ran command" + exit status |
| `web` | WebFetch, WebSearch, web_fetch, curl | "Web · url" |
| `api_call` | api_request, http_*, rest_*, graphql_* | "API · endpoint" + status |
| `file_upload` | upload_file, attach_*, send_file | "Upload · filename" + size |
| `file_download` | download_file, export_*, save_as | "Download · filename" + size |
| `memory_operation` | suggest_memory, recall_*, context_lookup | "Memory · action" |
| `approval_requested` | request_approval, needs_review, sign_off | "Approval needed" card |
| `progress_update` | TodoWrite, update_progress, set_status | Task checklist with progress bar |
| `audio_generated` | text_to_speech, generate_audio, voice_*, podcast_* | Audio player card |
| `system_event` | (entry kind: init, result, system) | Event row |
| `error` | (entry kind: stderr) | Red error block |
| `generic_tool` | (fallback) | "Tool · name" pill |

### Software Development (functionType: "software_development")

| Category | Tool name matches | Pill render |
|----------|------------------|-------------|
| `git_operation` | git commands detected in command content | "Git · branch/commit/push" |
| `test_run` | npm test, jest, vitest, pytest detected in command content | "Tests · passed/failed" + status |
| `build` | npm build, make, cargo build detected in command content | "Build · status" |
| `diff_view` | diff, git diff | Inline diff viewer |

### Marketing (functionType: "marketing")

| Category | Tool name matches | Pill render |
|----------|------------------|-------------|
| `content_generated` | generate_copy, write_content, draft_* | "Content · title" card with preview |
| `image_generated` | generate_image, dall-e, midjourney, stable-diffusion | Image thumbnail card |
| `video_generated` | generate_video, create_video, animate_*, video_edit | Video thumbnail card with duration |
| `research` | analyze_audience, competitor_analysis, market_research | "Research · topic" expandable card |
| `social_post` | schedule_post, create_post, draft_social | "Post · platform" card |
| `seo_analysis` | seo_audit, keyword_research | "SEO · query" pill |
| `email_campaign` | draft_email, email_template, campaign_* | "Email · subject" card |
| `analytics_pulled` | pull_analytics, ga_*, analytics_report | "Analytics · metric" pill |

### Finance (functionType: "finance")

| Category | Tool name matches | Pill render |
|----------|------------------|-------------|
| `calculation` | calculate, compute, formula, spreadsheet_* | "Calc · description" + result |
| `data_query` | query_data, sql, fetch_report, pull_metrics | "Query · source" pill |
| `report_generated` | generate_report, financial_summary, forecast | "Report · title" card |
| `chart_generated` | create_chart, visualize, plot | Chart thumbnail card |
| `invoice_generated` | create_invoice, generate_statement | "Invoice · #id" card |
| `compliance_check` | audit_check, compliance_verify, validate_* | "Compliance · status" pill |

### Support (functionType: "support")

| Category | Tool name matches | Pill render |
|----------|------------------|-------------|
| `ticket_lookup` | search_tickets, get_ticket, zendesk_*, freshdesk_* | "Ticket · #id" pill |
| `knowledge_search` | search_kb, knowledge_base, help_center | "KB · query" pill |
| `draft_response` | draft_reply, compose_response, suggest_answer | "Draft reply" card with preview |
| `escalation` | escalate, transfer, assign_agent | "Escalated · reason" event row |
| `sentiment_analyzed` | analyze_sentiment, customer_mood, nps_* | "Sentiment · result" pill |
| `macro_applied` | apply_macro, canned_response, template_reply | "Macro · name" pill |

### Design/Creative (functionType: "design")

| Category | Tool name matches | Pill render |
|----------|------------------|-------------|
| `design_asset` | generate_design, create_mockup, figma_* | Design thumbnail card |
| `brand_check` | brand_guidelines, style_check, consistency_audit | "Brand check · status" pill |
| `media_processed` | resize_image, compress_video, convert_format | "Media · filename" pill |
| `animation_created` | create_animation, lottie_*, motion_* | Animation preview card |
| `prototype_created` | create_prototype, interactive_mockup | "Prototype · name" pill |

### HR (functionType: "hr")

| Category | Tool name matches | Pill render |
|----------|------------------|-------------|
| `candidate_lookup` | search_candidates, get_applicant, ats_* | "Candidate · name" pill |
| `document_drafted` | draft_offer, draft_policy, write_handbook | "Document · title" card |
| `schedule_action` | schedule_interview, book_meeting, calendar_* | "Scheduled · event" pill |
| `background_check` | run_background, verify_*, screening_* | "Check · status" pill |
| `onboarding_step` | onboard_*, training_assigned, setup_account | "Onboarding · step" pill |

### Legal (functionType: "legal")

| Category | Tool name matches | Pill render |
|----------|------------------|-------------|
| `contract_drafted` | draft_contract, generate_agreement, nda_* | "Contract · title" card |
| `clause_reviewed` | review_clause, check_terms, legal_review | "Review · section" pill |
| `regulatory_check` | check_regulation, compliance_*, gdpr_* | "Regulation · status" pill |

### Research (functionType: "research")

| Category | Tool name matches | Pill render |
|----------|------------------|-------------|
| `literature_search` | search_papers, arxiv_*, pubmed_*, scholar_* | "Papers · query" pill + count |
| `data_analysis` | analyze_data, run_experiment, statistical_test | "Analysis · method" card |
| `citation` | cite, add_reference, bibliography | "Citation · source" pill |
| `experiment_run` | run_simulation, model_train, benchmark_* | "Experiment · name" card |

### Operations (functionType: "operations")

| Category | Tool name matches | Pill render |
|----------|------------------|-------------|
| `workflow_triggered` | trigger_workflow, run_pipeline, automate_* | "Workflow · name" pill |
| `inventory_check` | check_inventory, stock_*, warehouse_* | "Inventory · item" pill |
| `notification_sent` | send_notification, alert_*, notify_* | "Notified · channel" pill |

---

## Aggregation Rules

### Pass 1: normalizeTranscript() (ported from AoA)

Operates on TranscriptEntry[] → TranscriptBlock[]:
- Consecutive assistant/user entries of same role → merged into one message block
- Consecutive thinking entries → merged into one thinking block
- tool_call + tool_result matched by toolUseId → single tool block with status
- Consecutive stderr → stderr_group
- Consecutive stdout → merged
- stdout appended to active running command tool
- system entries parsed for activity lifecycle (started/completed)
- After merging: groupCommandBlocks() groups consecutive command tools, groupToolBlocks() groups consecutive non-command tools

### Pass 2: aggregateBlocks() (new, inspired by vibe-kanban)

Operates on TranscriptBlock[] → (TranscriptBlock | AggregatedGroup)[]:

1. Classify each tool block via classifyToolEntry()
2. Walk blocks sequentially, grouping consecutive same-category blocks:
   - 2+ consecutive file_read → read_group
   - 2+ consecutive file_edit same file → edit_group (with cumulative +/- stats)
   - 2+ consecutive file_edit different files → multi_edit_group
   - 2+ consecutive search → search_group
   - 2+ consecutive web → web_group
   - 2+ consecutive same generic_tool → generic_group
   - thinking from previous turns → thinking_group (collapsed)
3. Single entries of any type → pass through as-is (no wrapping)

**Not aggregated:** messages (always shown), errors (always shown), system events (always shown), department-specific cards (too visually distinct), progress_update (always shown).

---

## Rendering Components

### File structure

```
ui/src/components/workspace/transcript/
├── StructuredRunBlock.tsx          — Main container: parses + normalizes + aggregates + renders
├── TranscriptMessageBlock.tsx      — Assistant/user chat bubbles with markdown
├── TranscriptThinkingBlock.tsx     — Collapsible thinking (dot for previous turns)
├── TranscriptToolPill.tsx          — Single tool call pill (the workhorse)
├── TranscriptToolCard.tsx          — Department-specific rich card (image, report, draft)
├── TranscriptAggregatedGroup.tsx   — Grouped pills with expand ("Read · 5 files")
├── TranscriptEditGroup.tsx         — Grouped file edits ("auth.ts · 3 edits · +6 -2")
├── TranscriptProgressBlock.tsx     — TodoWrite checklist with progress bar
├── TranscriptEventRow.tsx          — Init, result, system events (single-line)
├── TranscriptErrorBlock.tsx        — Stderr groups (red accent)
├── TranscriptStdoutBlock.tsx       — Raw stdout (collapsed by default)
├── classify-entry.ts               — classifyToolEntry() + EntryCategory type
├── aggregate-blocks.ts             — aggregateBlocks() pass 2
├── normalize-transcript.ts         — normalizeTranscript() + helpers (ported from AoA)
└── types.ts                        — TranscriptBlock, AggregatedGroup, EntryCategory types
```

### StructuredRunBlock (container)

Replaces RunBlock's `<pre>` dump. Props:
- `runId: string` — fetches log via heartbeatsApi.log()
- `adapterType: string` — selects parser from adapter registry
- `departmentType: string` — passed to classifyToolEntry for department-specific rendering
- `isRunning: boolean` — enables streaming mode
- `isLatest: boolean` — controls expand/collapse default
- `compact: boolean` — for TaskSlideOver compact mode

Internal flow:
1. Fetch log chunks via heartbeatsApi.log() (polls every 3s if running)
2. Parse via buildTranscript(chunks, getUIAdapter(adapterType).parseStdoutLine)
3. Normalize via normalizeTranscript(entries, isRunning)
4. Aggregate via aggregateBlocks(blocks, departmentType)
5. Map through renderTranscriptBlock() dispatcher

### TranscriptToolPill (most common component)

Visual spec:
- Full-width row, not inline — matches vibe-kanban screenshot style
- Height: 40px (h-10), vertically centered content
- Background: bg-muted/30 resting, bg-muted/50 on hover
- Rounded: rounded-lg
- Layout: `[16px icon] [flex-1 primary text] [meta text] [status icon] [expand caret]`
- Icon: 16px, muted color, category-specific (file, search, terminal, globe, etc.)
- Primary text: 13px sans-serif, truncated with ellipsis. Shows file path, query, command, etc.
- Meta text: 12px muted ("+5 -2" for edits, "exit 0" for commands, file size for uploads)
- Status: 14px — spinner (running), green checkmark (success), red X (error)
- Expand caret: appears on hover/focus, 14px chevron-right → chevron-down
- No borders — background only
- Monospace only for: file paths and command text. Everything else sans-serif.
- Click/Enter/Space toggles expanded state
- Expanded: shows tool input + result in indented block below, bg-muted/20, max-height 300px overflow-auto

### TranscriptToolCard (rich preview)

Used only for department-specific categories that benefit from preview (image_generated, report_generated, draft_response, design_asset, etc.).

Visual spec:
- Same full-width row base as pill
- Additional content area below header: rounded-xl, shadow-sm, bg-card
- Thumbnail: 80px square for images/video, rounded-lg
- Preview text: max 4 lines with "Show more"
- Action buttons: ghost variant, small — "Preview", "Save to Artifacts", "Edit"
- Falls back to TranscriptToolPill if preview data unavailable

### TranscriptProgressBlock (TodoWrite)

Visual spec:
- Collapsed: `☰ Tasks · N/M complete [thin progress bar] [expand caret]`
- Progress bar: 100% width below header, 3px height, bg-neutral-200, fill bg-emerald-500
- Expanded: checklist below
  - Completed: green circle-check icon + text
  - In-progress: blue spinner + text
  - Pending: empty circle + text (muted)
- Collapsed by default when all complete, expanded when in-progress
- Multiple TodoWrite calls in same run: show only latest state

### TranscriptMessageBlock

Visual spec:
- Agent message: left-aligned, bg-card, border, rounded-2xl rounded-tl-sm
  - Header: agent avatar (department accent ring) + agent name + relative time
  - Body: rendered markdown via MarkdownBody (existing component)
  - Long messages: truncated at 500 chars with "Show more"
- User message: handled by existing TimelineUserMessage (not in this component)

### TranscriptThinkingBlock

Visual spec:
- Current turn (streaming): expandable, muted bg, italic text
  - Header: "Thinking..." with animated dots
  - Content: thinking text in muted-foreground
- Previous turn: collapsed dot icon (●) with "Thinking" label
  - Click expands to show full thinking text
  - Always collapsed by default

### TranscriptEventRow

Visual spec:
- Single line, 32px height, muted
- Layout: `[tone icon] [label] · [text]`
- Tone coloring: info=blue, warn=amber, error=red, neutral=muted
- init: "ℹ init · model claude-sonnet... · session abc123"
- result: "✓ Completed · 1,200 in / 800 out · $0.02" or "✗ Failed · error message"

### TranscriptErrorBlock

Visual spec:
- Left border accent: 2px border-l-red-500
- Background: bg-red-500/5
- Collapsible: header shows "stderr (N lines)", expand shows lines
- Monospace text for error content

### TranscriptStdoutBlock

Visual spec:
- Collapsed by default with "Raw output" label
- Monospace, bg-muted/20, max-height 200px overflow-auto
- Only visible when user explicitly expands

---

## Visual Design Tokens

### Base Palette (no terminal aesthetics)

```
pill-bg:            bg-muted/30 (resting), bg-muted/50 (hover)
pill-text:          text-foreground/80
pill-meta:          text-muted-foreground text-xs
pill-icon:          text-muted-foreground h-4 w-4

status-success:     text-emerald-500 (checkmark icon only)
status-error:       text-red-500 (X icon + left border accent)
status-running:     text-blue-500 (spinner animation)
status-warning:     text-amber-500

card-bg:            bg-card
card-border:        border border-border
card-shadow:        shadow-sm
card-radius:        rounded-xl

additions:          text-emerald-500 ("+N")
deletions:          text-red-400 ("-N")
```

### Department Accent Colors (agent avatar ring, section headers)

```
software_development:   ring-blue-500
marketing:              ring-purple-500
finance:                ring-emerald-600
support:                ring-amber-500
hr:                     ring-pink-500
legal:                  ring-slate-600
research:               ring-indigo-500
design:                 ring-rose-500
operations:             ring-teal-500
general:                ring-neutral-500
```

### Typography

- Messages: system sans-serif, 14px
- Pills primary text: system sans-serif, 13px
- Pills meta text: system sans-serif, 12px, muted
- File paths in pills: font-mono, 13px
- Command text in pills: font-mono, 13px
- Everything else: sans-serif (NOT monospace)
- Error content: font-mono, 12px

---

## Integration Points

### RunBlock modification

Current RunBlock.tsx renders:
```tsx
<pre className="whitespace-pre-wrap text-foreground/90">{logData.content}</pre>
```

Replace with:
```tsx
<StructuredRunBlock
  runId={run.runId}
  adapterType={run.adapterType}
  departmentType={departmentType}
  isRunning={isRunning}
  isLatest={isLatest}
  compact={compact}
/>
```

### TimelineAgentMessage modification

Needs to pass `departmentType` down to RunBlock/StructuredRunBlock. Gets it from the project/department context of the current issue.

### WorkspaceTimeline modification

Needs to fetch/pass the departmentType from the issue's project. Already fetches the issue — add project lookup for functionType.

### Run block header enhancement

Show task reference in run header:
```
✓ Claude Code · Run abc123 · Task "Fix auth bug" · 45s · 2m ago
```

Not just run ID — includes which task this run is executing.

---

## What This Does NOT Change

- Heartbeat system — stays as-is
- Dependency chains — stays as-is
- Run lifecycle — stays as-is
- heartbeat_runs table — no schema changes
- heartbeat_run_events table — no schema changes
- NDJSON log storage — stays as-is
- WebSocket event system — stays as-is
- Cost tracking, approval gates, timers — all stay
- LiveRunWidget — stays as-is for now (future phase)
- AgentDetail page — stays as-is for now (future phase)
- TranscriptEntry type — no changes (10 kinds sufficient)
- Adapter parsers — no changes

---

## Files to Copy from AoA (as reference)

Copy to `aoa-2.5/reference/` (reference only, not imported directly):

1. `paperclip/ui/src/components/transcript/RunTranscriptView.tsx` — contains normalizeTranscript(), TranscriptBlock type, all helper functions, rendering components
2. `paperclip/ui/src/components/transcript/useLiveRunTranscripts.ts` — live transcript streaming hook (reference for future LiveRunWidget upgrade)

Port into new AoA files (adapted, not copied verbatim):
- normalizeTranscript() → `ui/src/components/workspace/transcript/normalize-transcript.ts`
- TranscriptBlock type → `ui/src/components/workspace/transcript/types.ts`
- Helper functions (isCommandTool, extractToolUseId, summarizeToolInput, etc.) → same normalize-transcript.ts file

---

## Testing Strategy

- Unit tests for classifyToolEntry() — verify all tool name mappings per department
- Unit tests for aggregateBlocks() — verify grouping rules, minimum-2 threshold, edit stats accumulation
- Unit tests for normalizeTranscript() — port AoA's existing RunTranscriptView.test.tsx as baseline
- Component tests for each renderer — verify correct props render correct visual output
- Integration test for StructuredRunBlock — mock heartbeatsApi.log(), verify full pipeline produces expected components

---

## Future Phases (out of scope)

- LiveRunWidget upgrade to use same renderers (streaming structured entries)
- AgentDetail page upgrade
- TaskSlideOver workspace mode upgrade
- Inline diff viewer for file edits
- Interactive "Use as Artifact" actions on cards
- Virtualized rendering (only needed if runs exceed ~500 entries)
