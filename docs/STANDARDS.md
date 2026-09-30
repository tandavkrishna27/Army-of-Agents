# Documentation Standards

Standards for creating, maintaining, and retiring documentation in this project. The primary audience for all docs is AI agents (Claude Code, Codex, etc.) and the engineers working alongside them.

## Principles

1. **Code is truth.** If a doc contradicts the code, the code wins. Update the doc, not the code (unless the code is the bug).
2. **No duplicate information.** One authoritative source per topic. Reference, don't copy.
3. **No orphan references.** Every file path or link in a doc must exist. Remove or update broken references immediately. Relative links are resolved from the doc's own location in the repo — a file at `docs/guides/board-operator/foo.md` needs `../../../server/` to reach `server/`, not `../server/`.
4. **Grounded, not aspirational.** Docs describe what is built, not what is planned. Planned work goes in `docs/roadmap.md`.

---

## Document Types

### Reference Docs (`docs/architecture/`, `docs/api/`, `docs/adapters/`, `docs/deploy/`, `docs/start/`)

Stable, code-verified documentation describing current system behavior.

- **Owner:** Must be updated whenever the feature it describes changes.
- **Verification:** Every claim must be checkable against source code.
- **Audience:** AI coding agents + engineers.

### How-To Guides (`docs/guides/`)

Task-oriented walkthroughs for specific user roles (board operators, agent developers).

- **Owner:** Must reflect the current UI and API.
- **Audience:** Human users of AoA (founders, team leads, agent authors).

### Plans (`docs/archive/plans/`)

Work artifacts from development sessions. Describe what was built and how decisions were made during implementation.

- **Status:** Archived. Not actively maintained.
- **Do not use** as a source of truth for current system behavior.

### Session Logs (`docs/archive/sessions/`)

Raw session-tracking documents from development (plans, specs, execution logs). Write-once artifacts.

- **Status:** Archived. Not actively maintained.
- **Do not use** as a source of truth for current system behavior.

---

## Plan Lifecycle

```
1. ACTIVE (during development)
   Location: docs/plans/<feature>.md  (if needed at all)
   Purpose: Track implementation decisions as they're made

2. FEATURE SHIPS
   └── Extract Tier 1: Architectural/product decisions → docs/architecture/decisions.md
   └── Extract Tier 2: System behavior changes → relevant docs/architecture/<feature>.md or docs/api/*.md
   └── Archive plan → docs/archive/plans/<feature>.md
   └── Delete from docs/plans/ (or docs/aoa/plans/ etc.)

3. ARCHIVED
   Location: docs/archive/plans/
   Purpose: Historical record only. Not referenced in active docs.
```

### Extraction Tiers

When a feature ships, extract from the session log / plan into permanent docs:

| Tier | What | Where |
|------|------|-------|
| 1 — MUST | Architectural or product decision that locks behavior | `docs/architecture/decisions.md` |
| 1 — MUST | Any change to how a system works (new feature, behavior change) | `docs/architecture/<feature>.md` or relevant section |
| 1 — MUST | API contract change (new endpoint, changed payload) | `docs/api/<domain>.md` |
| 2 — SHOULD | Schema change (new table, column, deprecated table) | `CLAUDE.md` Database Schema section |
| Skip | Debugging steps, failed attempts, implementation details | Stay in archive |
| Skip | Anything derivable from reading the code | Not needed in docs |

---

## Session Log Standard

Session logs in `docs/archive/sessions/` follow this naming convention:

```
YYYY-MM-DD-<kebab-description>.md      (plan/execution log)
YYYY-MM-DD-<kebab-description>-design.md  (visual/UX design spec for that session)
```

After a session completes:
1. Run the extraction tiers above.
2. Move the session log to `docs/archive/sessions/`.
3. Do not edit the archived log — it's a historical record.

---

## Doc Health Checklist

Run this when a feature ships or when any doc file is edited:

- [ ] **No broken links** — every relative file path resolves from the doc's own location in the repo
- [ ] **No stale paths** — no `docs/aoa/`, `docs/superpowers/`, or any other retired path prefixes
- [ ] **No aspirational claims** — if a feature is planned but not built, it belongs in `docs/roadmap.md` only
- [ ] **CLAUDE.md schema table** — if tables were added/changed/deprecated, update the Database Schema section
- [ ] **decisions.md** — if a behavior was locked, add the decision
- [ ] **docs.json** — if a new doc file was added, register it in the Mintlify nav
- [ ] **Naming map** — if UI labels or API route names diverged, update the Naming Map in CLAUDE.md

---

## CLAUDE.md Maintenance

`CLAUDE.md` is the primary always-loaded context file for AI coding agents. Keep it:

- **Current:** Update the Database Schema and Architecture sections when features ship.
- **Lean:** Architecture details live in `docs/architecture/`. CLAUDE.md points to them.
- **No orphan paths:** Every file path in CLAUDE.md must exist. Run a quick check before committing.
- **No V-numbers:** Describe features by name, not development phase (no "V2", "V2.5", etc.).
- **No Paperclip branding:** Paperclip origins tracked in `docs/paperclip-migration.md` only.

---

## Folder Structure

```
docs/
├── STANDARDS.md            ← this file
├── paperclip-migration.md  ← Paperclip→AoA tracking (wire protocol, deprecated tables)
├── roadmap.md              ← Planned but not yet built
├── docs.json               ← Docs site config (Mintlify navigation + metadata)
├── favicon.svg             ← Docs site favicon
├── images/                 ← Docs site assets (logo-dark.svg, logo-light.svg)
├── architecture/           ← Stable reference: decisions, design system, feature deep-dives
├── api/                    ← REST API endpoint reference
├── adapters/               ← Adapter authoring + per-adapter reference
├── deploy/                 ← Ops: deployment modes, env vars, database, Docker
├── guides/
│   ├── board-operator/     ← How-tos for founders and team leads
│   └── agent-developer/    ← How-tos for agent authors
├── start/                  ← What is AoA, quickstart, core concepts
├── cli/                    ← CLI command reference
└── archive/
    ├── sessions/           ← Session work logs (plans, specs, execution logs)
    ├── plans/              ← Archived shipped-feature plans
    └── audits/             ← Point-in-time audit reports
```

**Website asset files (`docs.json`, `favicon.svg`, `images/`):** These drive the Mintlify docs site. Do not rename or move them — they are referenced by the build config. When adding a new doc file, register it in `docs.json` so it appears in the site nav.
