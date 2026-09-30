# Paperclip → AoA Migration Reference

AoA (Army of Agents) was built on top of Paperclip, an open-source AI agent orchestration platform. This document tracks everything that changed — naming, wire protocols, deprecated tables, and compatibility rules. It exists so this information doesn't clutter `CLAUDE.md`.

**CLAUDE.md must not reference Paperclip** except via a link to this file.

---

## What Paperclip Is

Paperclip is the open-source base from which AoA was forked. AoA is a proprietary product. The two projects have diverged significantly. Paperclip parity was maintained through Phase E (company portability) to allow bundle imports from Paperclip v1 deployments.

---

## Naming Map

The DB and API routes kept Paperclip names. Only UI labels changed.

| Paperclip UI Name | AoA UI Name | DB Table | API Route |
|-------------------|-------------|----------|-----------|
| Issue | Task | `issues` | `/issues` |
| Dashboard | Home | — | `/dashboard` |
| Costs | Budget | `cost_events` | `/costs` |
| Org | Team | — | — |
| Debrief | Discussion | `discussions` | `/discussions` |
| Brief Item | Extracted Item | `discussion_extracted_items` | — |

Goals, Agents, Company, Settings, Activity, Inbox — unchanged.

---

## Wire Protocol Contracts (Do Not Rename)

The `hermes_local` adapter uses two environment variables that are wire-protocol contracts with the `hermes-paperclip-adapter` package:

```
PAPERCLIP_RUN_ID     ← always injected from ctx.runId
PAPERCLIP_API_KEY    ← injected from agent JWT when not explicitly configured
```

**These must NOT be renamed to `AOA_*`.** The hermes adapter reads them by exact name. Renaming breaks hermes agents in the field.

See `server/src/adapters/registry.ts` — the `hermesLocalAdapter.execute` wrapper for the full injection logic.

---

## Export Bundle Compatibility

AoA's company export format (`schemaVersion: 2`) is backward-compatible with Paperclip v1 bundles on import. Unknown bundle sections warn-and-continue rather than failing, so a Paperclip v1 export can be imported into AoA.

The export and import format is implemented in:
- `server/src/services/company-portability.ts`

---

## Deprecated Tables (Kept for Rollback Safety)

These tables exist in the schema but are not used by new code. They are kept to allow rollback to legacy Brief/Debrief behavior if needed.

| Table | Replaced By | Status |
|-------|-------------|--------|
| `debriefs` | `discussions` | @deprecated — new code uses discussions |
| `briefs` | `discussions` | @deprecated — new code uses discussions |
| `brief_items` | `discussion_extracted_items` | @deprecated — new code uses extracted items |
| `discussion_annotations` | posts + replies (`discussion_entries.parentEntryId`) | @deprecated UI — table + API retained for rollback |

Do not write new code that reads or writes these tables. Do not delete them without a deliberate migration plan.

### Inline Annotations → Posts + Replies (Threads Crew P0)

Threads moved from inline margin-note annotations to a **posts + replies** model
(spec §6, D4/D6). As of Threads Crew **P0**:

- The **Thread surface** UI entry points were removed: the shared
  `ui/src/components/threads/EntryRow.tsx` no longer renders an Annotate button,
  highlight selection, or annotation list, and
  `ui/src/components/threads/ThreadTab.tsx` no longer wires `addAnnotation`.
  Replies (`discussion_entries.parentEntryId`) replace them.
- **Retained as a deprecated stub** (rollback-safe, like `debriefs`/`briefs`):
  the `discussion_annotations` table, `discussionService.addAnnotation`, the
  `POST /companies/:cid/discussions/:did/entries/:eid/annotations` route, and the
  `discussionsApi.addAnnotation` client. Do **not** build new features on them.
- **Follow-up (not done in P0):** the legacy **Discussion surface**
  `ui/src/pages/DiscussionDetail.tsx` has its own local `ThreadEntryRow` with a
  separate annotation UI. Removing that is deferred to a later Threads phase.

---

## Package Scope

The npm package scope changed from `@paperclip/*` to `@armyofagents/*`.

Current packages:
- `@armyofagents/adapter-claude-local`
- `@armyofagents/adapter-codex-local`
- `@armyofagents/adapter-cursor-local`
- `@armyofagents/adapter-opencode-local`
- `@armyofagents/adapter-gemini-local`
- `@armyofagents/adapter-openclaw`
- `@armyofagents/adapter-utils`
- `@armyofagents/db`
- `@armyofagents/shared`

The `hermes-paperclip-adapter` package retains its original name (external dependency, not in this repo).

---

## Removed Adapters (Decision #91)

The following adapter types were removed in Sprint 2A and must not be re-added:

| Removed Type | Was |
|-------------|-----|
| `claude_api` | Direct Anthropic SDK calls |
| `openai_api` | Direct OpenAI SDK calls |
| `gemini_api` | Direct Google SDK calls |

All agent execution is now CLI-only. The Provider SDK utilities in `server/src/services/internal-agent/providers/` are kept exclusively for extraction + embedding generation. They are not registered in the adapter registry and must not be used for agent task execution.

---

## Historical Specs (Archived)

Historical session records live under `docs/archive/`. Active execution plans
live under `docs/aoa/plans/`. Neither is the current runtime contract: prefer the
current codebase and authoritative reference documentation.
