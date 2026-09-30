# Structured Timeline — Session Prompts

**Plan:** `docs/superpowers/plans/2026-04-06-structured-timeline.md`
**Spec:** `docs/superpowers/specs/2026-04-06-structured-timeline-design.md`
**Reference files:** `reference/paperclip-RunTranscriptView.tsx`, `reference/paperclip-RunTranscriptView.test.tsx`

**Prerequisites:** Reference files from AoA already copied to `aoa-2.5/reference/`.

---

## Session 1 of 4: Types + normalizeTranscript Port

**Tasks:** 1, 2
**Creates:** `ui/src/components/workspace/transcript/types.ts`, `normalize-transcript.ts`, tests
**Estimated scope:** ~400 lines of new code + ~100 lines of tests

### Prompt

```
Read the following files before starting:
1. docs/superpowers/plans/2026-04-06-structured-timeline.md (the implementation plan — read the CRITICAL PORT NOTES in the header)
2. docs/superpowers/specs/2026-04-06-structured-timeline-design.md (the design spec)
3. reference/paperclip-RunTranscriptView.tsx (AoA's transcript rendering — source for the port)
4. reference/paperclip-RunTranscriptView.test.tsx (AoA's tests — reference for our tests)

Execute Task 1 (Types) and Task 2 (Port normalizeTranscript from AoA) from the implementation plan.

For Task 2, pay attention to these CRITICAL differences between AoA and AoA TranscriptEntry types:
- AoA's tool_call has NO toolUseId field. Use extractToolUseId(entry.input) only — do NOT reference entry.toolUseId.
- AoA's tool_result has NO toolName field. Hardcode "tool" as fallback name for unmatched results.
- Remove the density parameter from summarizeToolInput and summarizeToolResult — hardcode comfortable defaults.
- Import TranscriptEntry from @armyofagents/adapter-utils
- Import TranscriptBlock from the local ./types

Follow TDD strictly: write tests first, verify they fail, implement, verify they pass, commit after each task. The plan has the full test code and implementation instructions.
```

---

## Session 2 of 4: Entry Classification + Aggregation

**Tasks:** 3, 4
**Creates:** `classify-entry.ts`, `aggregate-blocks.ts`, tests for both
**Estimated scope:** ~350 lines of new code + ~150 lines of tests
**Depends on:** Session 1 (types.ts must exist)

### Prompt

```
Read the implementation plan at docs/superpowers/plans/2026-04-06-structured-timeline.md.

Execute Task 3 (Entry Classification System) and Task 4 (Aggregation Pass 2).

Before starting, verify these files from Session 1 exist:
- ui/src/components/workspace/transcript/types.ts
- ui/src/components/workspace/transcript/normalize-transcript.ts

These are pure TypeScript logic files with no React/UI code:
- classify-entry.ts: Maps tool names + department type to EntryCategory. Covers 60+ categories across 9 departments. The plan has the full implementation.
- aggregate-blocks.ts: Groups consecutive same-category TranscriptBlocks into AggregatedGroups (e.g., 5 file reads → one read_group). Minimum 2 consecutive entries to form a group.

Follow TDD strictly: write tests first, verify they fail, implement, verify they pass, commit after each task. The plan has complete test code and implementation code for both files.
```

---

## Session 3 of 4: Rendering Components

**Tasks:** 5, 6, 7, 8
**Creates:** 10 React components in `ui/src/components/workspace/transcript/`
**Estimated scope:** ~700 lines of component code
**Depends on:** Sessions 1-2 (types.ts, classify-entry.ts, aggregate-blocks.ts must exist)

### Prompt

```
Read the implementation plan at docs/superpowers/plans/2026-04-06-structured-timeline.md and the design spec at docs/superpowers/specs/2026-04-06-structured-timeline-design.md (especially the "Visual Design Language" and "Rendering Components" sections).

Before starting, verify these files from prior sessions exist:
- ui/src/components/workspace/transcript/types.ts
- ui/src/components/workspace/transcript/normalize-transcript.ts
- ui/src/components/workspace/transcript/classify-entry.ts
- ui/src/components/workspace/transcript/aggregate-blocks.ts

Execute Task 5 (TranscriptToolPill), Task 6 (Message, Thinking, Event, Error, Stdout components), Task 7 (AggregatedGroup, EditGroup, ProgressBlock), and Task 8 (TranscriptToolCard).

CRITICAL VISUAL RULES (from the design spec):
- NO terminal aesthetics — no black backgrounds, no green-on-black
- NO bordered boxes — pills use bg-muted/30 background, not borders
- Monospace font ONLY for file paths and commands, everything else is sans-serif
- Pills are full-width rows (h-10, rounded-lg), not inline compact elements
- Status icons: spinner (running/blue), checkmark (completed/emerald), X (error/red)
- Expand caret appears on hover only (opacity-0 group-hover:opacity-100)
- Rich cards (TranscriptToolCard) use rounded-xl + shadow-sm + bg-card

The plan has complete code for all components. Verify each compiles after creation. Commit after each task.
```

---

## Session 4 of 4: Container + Integration + Verification

**Tasks:** 9, 10, 11, 12
**Creates:** `StructuredRunBlock.tsx`, `index.ts`, integration tests
**Modifies:** `TimelineAgentMessage.tsx`, `WorkspaceTimeline.tsx`
**Estimated scope:** ~300 lines new + ~50 lines modified
**Depends on:** Sessions 1-3 (all transcript/ files must exist)

### Prompt

```
Read the implementation plan at docs/superpowers/plans/2026-04-06-structured-timeline.md.

Before starting, verify ALL transcript files from prior sessions exist:
- ui/src/components/workspace/transcript/types.ts
- ui/src/components/workspace/transcript/normalize-transcript.ts
- ui/src/components/workspace/transcript/classify-entry.ts
- ui/src/components/workspace/transcript/aggregate-blocks.ts
- ui/src/components/workspace/transcript/TranscriptToolPill.tsx
- ui/src/components/workspace/transcript/TranscriptMessageBlock.tsx
- ui/src/components/workspace/transcript/TranscriptThinkingBlock.tsx
- ui/src/components/workspace/transcript/TranscriptEventRow.tsx
- ui/src/components/workspace/transcript/TranscriptErrorBlock.tsx
- ui/src/components/workspace/transcript/TranscriptStdoutBlock.tsx
- ui/src/components/workspace/transcript/TranscriptAggregatedGroup.tsx
- ui/src/components/workspace/transcript/TranscriptEditGroup.tsx
- ui/src/components/workspace/transcript/TranscriptProgressBlock.tsx
- ui/src/components/workspace/transcript/TranscriptToolCard.tsx

Execute Task 9 (StructuredRunBlock container + index.ts), Task 10 (Wire into TimelineAgentMessage + WorkspaceTimeline), Task 11 (Integration tests), and Task 12 (Final build verification).

This session wires everything together and replaces the <pre> dump. Key details:

TASK 9 — StructuredRunBlock:
- Orchestrates the full pipeline: fetch log → parse NDJSON → buildTranscript → normalizeTranscript → aggregateBlocks → render
- Has a parseNdjsonContent helper that handles both NDJSON format and raw text fallback
- The plan has the complete implementation

TASK 10 — Integration (the critical wiring). Read the plan carefully for Task 10 — it has EXACT instructions for what to keep, remove, and replace in TimelineAgentMessage.tsx:
- KEEP: header section (lines 47-58) and file changes summary (lines 60-65)
- REMOVE: logExpanded state (line 25), logData query (lines 27-32), entire collapsible raw log section (lines 67-103)
- REPLACE: with <StructuredRunBlock> inside a border-t div
- Add adapterType and departmentType props
- In WorkspaceTimeline.tsx: get adapterType from agent.adapterType, get departmentType from a project query using issue.projectId. If projectsApi.get() doesn't exist, default to "general" and leave a TODO.

TASK 11 — Integration tests for StructuredRunBlock (loading, empty, waiting states)

TASK 12 — Run full build (npx vite build) and full test suite (npx vitest run). Fix any failures. Final commit.
```

---

## Post-Implementation Checklist

After all 4 sessions complete:

- [ ] Full build passes (`npx vite build`)
- [ ] Full test suite passes (`npx vitest run`)
- [ ] Workspace timeline renders structured pills instead of `<pre>` text
- [ ] Agent messages show as markdown chat bubbles
- [ ] Tool calls show as scannable pills with icons and status
- [ ] Consecutive same-type tools are grouped (e.g., "Read · 5 files")
- [ ] File edits show +/- stats
- [ ] TodoWrite renders as progress checklist
- [ ] Thinking blocks collapse for previous turns
- [ ] Errors show with red left border accent
- [ ] Reference files in `reference/` can be deleted after verification
