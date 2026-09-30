# AoA Roadmap

Planned features that are not yet built. Nothing in this document describes current system behavior — for that, see `CLAUDE.md` and `docs/architecture/`.

**Status of all items below: PLANNED, not implemented.**

---

## Autonomy Tiers

Per-agent autonomy levels 0–3 controlling how much a human needs to approve.

| Level | Behavior |
|-------|----------|
| 0 | Full approval required (current default for all agents) |
| 1 | Auto-execute known patterns, log for review |
| 2 | Execute and notify, founder reviews after |
| 3 | Full autonomy within guardrails |

Trust-based upgrade recommendations — agents earn autonomy through trust score improvement.

Decisions locked: #74, #75. New tables when built: `autonomy_audit_log`.

---

## Pipeline Templates

Repeatable task chains as JSON manifests (spec → design → code → test → UAT). One-click instantiation. Self-generated from existing work patterns.

Decision #76. New tables when built: `pipeline_templates`, `pipeline_instances`.

Agent table modification: `agents` gets `autonomyLevel` (0–3) and `autonomyConfig` columns.
Issue table modification: `issues` gets `pipelineInstanceId` and `pipelineStepOrder` columns.

---

## Service Connectors

Bidirectional sync with external tools. AoA = control plane. External tools = execution plane.

Planned integrations:
- GitHub — PR sync, branch management
- Figma — design file linking
- Linear — issue sync
- Slack — notification + action routing

Department-scoped. Decisions #77, #78. New tables when built: `connectors`, `connector_sync_log`.

---

## Department & Project Blueprints

Pre-configured department/project templates with bundled agents, goals, memory items, and pipeline templates. Available as built-in templates and via community marketplace (ClipHub).

Decision #79. New table when built: `blueprints`.

---

## Hosted Deployment (Cloud + Desktop)

Cloud execution via CLI-in-container: Claude CLI / codex / opencode bundled in worker images. Cloud workspaces run the CLI in isolated containers with per-tenant auth. Same upper-layer architecture as local AoA — the execution primitive is containerized CLI, not direct SDK calls.

Target platforms:
- Cloud (hosted SaaS)
- Windows desktop app
- macOS desktop app

Decisions #80, #81, #91.

---

## Additional Planned Features

- **Meeting integration:** Recall.ai → Discussion pipeline (meeting transcripts auto-enter as discussion entries)
- **Mobile app:** iOS/Android companion
- **Multi-company:** Single user managing multiple AoA instances
- **Advanced analytics:** Trend analysis across agents, goals, budget spend
- **Experiment system:** A/B testing agent configurations
- **Version merge logic:** When multiple artifact versions exist, tools to help merge rather than just pick a winner
- **Workflow template UI:** List + step builder + "instantiate for goal" UI (backend is already implemented — see `workflow_templates` table and `POST /api/companies/:cid/workflow-templates`)

---

## Deferred Items (From Current Implementation)

These are deferred from the current build — backend may exist, UI does not.

| Feature | Status |
|---------|--------|
| Workflow template UI (`/workflows` list + step builder) | Backend ready, UI deferred to 1.1 |
| Workspace Create PR — GitLab / Bitbucket support | GitHub-only MVP shipped; other providers deferred |
| Workspace breadcrumb fix (reads "Discussions") | Backlog cleanup |
| Workspace Create PR server-side idempotency key | Button-disable guard only for now |
| Memory feedback detectors — `content_removal`, `structure_change` | Schema types valid; detector functions not yet written |
| Memory Phase 2 (semantic link graph + embedding surfaces in UI) | Deferred |
| Company portability Phase E.3 (memory/artifacts/workflows in export) | Deferred |
| Company portability goals + budget incidents + ZIP + URL/GitHub imports | Deferred |
| Feedback per-vote "just this time" consent | Deferred |
| Feedback on artifact versions / plugin outputs / discussion items | Deferred |
| Feedback aggregation analytics + admin page | Deferred |
| Expanded smoke coverage (discussions, MCP, budgets, artifacts) | Deferred |
| Windows e2e CI parity (Issue #114) | Deferred |
| `anthropic/aoa` Docker image rename | Deferred (auto-resolves via `${{ github.repository }}`) |
| Canary-on-push auto-wiring | Deferred |
