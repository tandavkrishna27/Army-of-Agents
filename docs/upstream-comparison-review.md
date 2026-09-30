# Upstream vs AoA Comparison Review

Date: 2026-05-25

## Scope

This document captures the review of the latest upstream codebase against the current AoA codebase.

Reviewed repositories:

- upstream: historical checkout (location no longer valid)
- AoA: historical checkout (location no longer valid)

Latest upstream pull range reviewed:

- Previous pulled baseline: `eb12c42009e55576ca980666f5f8bd1a19c26b9d`
- Latest upstream commit: `96f0279e081ccc2745f3898a5aa9309b4d015def`
- Range: `eb12c420..96f0279e`
- Approximate size: 77 commits, 712 files changed

This is a discussion document, not an implementation plan. It records what upstream has, what AoA has, where the systems diverged, which implementation appears stronger, and what AoA should consider porting.

## Executive Summary

Upstream and AoA are no longer simple forks.

Upstream is stronger as an execution/task/workspace backend. It has deeper issue execution mechanics, stronger adapter/runtime infrastructure, richer document governance, broader plugin host APIs, sandbox provider support, recovery actions, and operational UI polish.

AoA is stronger as an organization and commander system. It has Commander/internal agents, command-staff/crew workflows, threads/discussions, memory, marketplace governance, teams/org modeling, MCP, Git/workspace cockpit, and richer product operating-system surfaces.

The recommendation is not to merge upstream wholesale. AoA should selectively port upstream's hardened mechanics into AoA's architecture while protecting AoA's Commander, thread, memory, marketplace, MCP, and team systems.

## Highest-Value Upstream Ports

| Rank | Upstream capability | Why it matters | Suggested AoA approach |
|---:|---|---|---|
| 1 | Plugin invocation-scope and company-scope hardening | Security foundation for broader plugin APIs | Port before expanding plugin host capabilities |
| 2 | Document locking, restore, and diff UX | Focused, valuable, low product ambiguity | Add schema/routes/UI around AoA issue documents |
| 3 | Issue recovery actions | Makes failed/stale work visible and actionable | Adapt to AoA issue monitors, Commander, and threads |
| 4 | Adapter/runtime hardening | Improves real agent execution reliability | Port command redaction, managed homes, probes, safer installs |
| 5 | Issue blocking graph and tree ideas | Better dependency execution and blocked-work recovery | Map into AoA `task_dependencies` and thread scope deps |
| 6 | Kanban, blocked inbox, search, quicklook | Immediate UX and workflow lift | Port selected UI patterns without replacing AoA task surfaces |
| 7 | Routine env/revision/idempotency | Safer automation and routine replay | Port dispatch fingerprinting and revision linkage |
| 8 | Dynamic adapter UI and external adapter typing | Needed for extensibility | Pair type widening with runtime validation |
| 9 | Environment leases and remote execution | Strategic for cloud/remote execution | Larger design project; keep AoA `sandbox-docker` |
| 10 | Workspace Diff plugin | Useful first plugin candidate | Port after plugin API prerequisites |

## Things AoA Should Protect

| AoA capability | Why it should stay AoA-owned |
|---|---|
| Commander/internal-agent | upstream has no equivalent |
| Command staff, crew gates, cost caps, kill switch | Core AoA identity and safety model |
| Threads/discussions | AoA has a richer idea-to-work workflow layer |
| Memory | AoA is far ahead with memory items, versions, folders, assets, retrievals, and review |
| Marketplace install/trust/rollback | AoA has the better productized distribution and governance path |
| MCP bridge | Important AoA integration surface |
| `openclaw` adapter | More product-integrated than upstream `openclaw_gateway` |
| `sandbox-docker` | Simple local isolation upstream does not have |
| Git/workspace cockpit | AoA has stronger software-delivery workflow UI |

## Full Comparison Table

| Area | upstream has | AoA has / does not have | Type | Stronger today | Recommendation |
|---|---|---|---|---|---|
| Issue execution model | Rich issue execution state, adapter override, execution policy, monitor attempts, origin fingerprint, billing/request depth | Simpler issue model plus monitors/context bundles | Diverged | upstream | Study and port execution-state concepts, not the whole issue table |
| Issue blocking graph | `issue_relations`, blockers, blocked dependents, cycle checks | `task_dependencies`, thread scope dependencies | Diverged | upstream for task execution | Adapt blocker semantics into AoA dependencies and threads |
| Issue tree control | Tree holds, hold members, checkout blocking, tree-control routes | No equivalent full system | Gap | upstream | Consider if AoA needs issue-tree locking/holds |
| Issue recovery actions | `issue_recovery_actions`, active recovery state, recovery cards | Issue monitors/recovery policy, but no first-class recovery action model | Gap/partial | upstream | High-priority port, adapted to Commander and monitors |
| Issue work products | `issue_work_products` model | AoA has artifacts/memory assets, not same issue-work-product model | Diverged | Mixed | Map useful work-product concept to AoA artifacts/memory |
| Issue thread interactions | Structured issue interactions/cards | AoA has discussions/threads instead | Diverged | Mixed | Bridge issue activity into AoA threads; do not copy directly |
| Issue detail UI | Deep issue detail route, chat thread, run ledger, recovery cards, quicklook | Task slide-over and workspace/artifact context | Diverged | upstream | Port selected UI pieces |
| Large issue thread UX | Long-thread fixtures, scroll/virtualization/presentation polish | Less mature | Gap | upstream | Port performance patterns |
| Scheduled retry/continuation | Scheduled retry cards, continuation handoff | Partial monitor/watchdog concepts | Gap/partial | upstream | Port after recovery model |
| Blocked inbox | Dedicated blocked inbox attention view | No equivalent full attention inbox | Gap | upstream | Adapt to AoA blocked/dependency/crew states |
| Search | Standalone search route/UI | Search exists, but issue/inbox search is thinner | Partial | upstream | Port issue/inbox search UX patterns |
| Kanban scaling | Cold lane collapse, show more, mobile polish | Kanban exists but is simpler | Partial | upstream | Good focused UI port |
| Document locking | Lock/unlock docs, lock metadata, agent copy-on-write | No lock fields/behavior | Gap | upstream | High-priority port |
| Document restore | Revision restore endpoints/UI | Revisions/autosave partial, no full restore governance | Gap/partial | upstream | Port with lock model |
| Document diff modal | Rich diff/revision UX | Simpler document UI | Gap | upstream | Port after backend support |
| Document search/indexing | Trigram indexes and richer revision metadata | Thinner document model | Gap | upstream | Consider if docs become core in AoA |
| Routine env secrets | Routine env runtime contract | Partial env resolution elsewhere | Gap/partial | upstream | Port carefully |
| Routine revisions | Revision numbers, restore chains, run revision linkage | Routine revisions exist but less complete | Partial | upstream | Port dispatch/revision fidelity |
| Routine dispatch safety | Fingerprint/idempotency/concurrency controls | Less mature | Gap/partial | upstream | Port after schema review |
| Adapter set | `acpx_local`, `cursor_cloud`, `grok_local`, `pi_local`, `openclaw_gateway` | `claude`, `codex`, `cursor`, `gemini`, `opencode`, `openclaw` | Gap/diverged | upstream broader | Product decision per adapter |
| `openclaw_gateway` | Gateway adapter | AoA `openclaw` webhook/SSE/hire-hook adapter | Diverged | AoA for AoA product | Keep AoA `openclaw`; optional separate gateway |
| ACPX adapter | ACPX Claude/Codex local adapter | Missing | Gap | upstream | Consider later if ACP strategy matters |
| Cursor Cloud adapter | Cursor SDK/cloud agents | Missing | Gap | upstream | Consider if AoA wants cloud Cursor agents |
| Grok local adapter | Local Grok adapter with turn parsing | Missing | Gap | upstream | Likely easiest adapter to port |
| Pi local adapter | Pi coding agent adapter | Missing | Gap | upstream if desired | Low priority unless product wants it |
| Adapter-utils contract | Model profiles, quota windows, config schema, session management, retry/error metadata | Narrower adapter-utils | Gap/partial | upstream | High-value port |
| External adapter typing | Allows external adapter strings | Exact union conflicts with partial external support | Diverged | upstream | Widen with runtime validation |
| Adapter registry | Waits/restores external adapters, handles overrides better | Possible `getServerAdapter` paused-override bypass | Diverged | upstream | Investigate/fix AoA registry |
| Dynamic adapter UI | Worker-sandboxed parser, schema-driven config fields | Mostly static UI registry | Gap | upstream | Port carefully |
| Disabled adapter store | UI/server disabled adapter metadata | Missing/partial | Gap | upstream | Port with adapter UI work |
| Remote execution | SSH, sandbox, plugin-backed targets | Local plus `sandbox-docker` | Diverged | Mixed | Keep AoA Docker, add upstream model later |
| Environment leases | Lease acquire/resume/destroy, provider metadata | Simpler environment target/env vars | Gap | upstream | Needed before sandbox providers |
| Environment drivers | Local/SSH/sandbox/plugin drivers | No full driver model | Gap | upstream | Strategic port |
| Workspace realization | Realize workspace in remote/sandbox env | AoA eager/race workspace flows | Diverged | Mixed | Combine cautiously |
| Workspace tar sync/restore | Tar upload, baseline capture, restore/merge | Less complete | Gap | upstream | Needed for remote execution |
| Runtime command probing | Probe/install runtime commands | Simpler install/probe | Gap | upstream | Port safety pieces |
| Managed homes | Codex/Claude managed home hardening | AoA has MCP bridge strengths | Diverged | Mixed | Combine upstream managed homes with AoA MCP |
| Sandbox install hardening | Safer npm install command builder, command redaction | Missing/partial | Gap | upstream | High-priority safety port |
| Local Docker sandbox | Not same simple local Docker target | AoA has `sandbox-docker` | Diverged | AoA | Keep AoA implementation |
| MCP bridge in adapters | Not equivalent | AoA has neutral MCP bridge/config writer | Diverged | AoA | Preserve during adapter ports |
| Execution result hints | Less focus on `executionCwd`/`outputFiles` | AoA has these hints | Diverged | AoA | Preserve |
| Workspace runtime services | Service orchestration, close readiness, desired state, inherited services | TTL/race/idempotency/policy wrappers | Diverged | Mixed | Combine, do not overwrite |
| Generic authorization | Central auth service, scoped grants, manager-chain, assignment policy | Founder/team/department permissions | Diverged | Mixed | Port concepts, map to AoA org model |
| Agent permissions | Strong assignment/scope controls | Internal-agent/tool permissions and org RBAC | Diverged | Mixed | Reconcile carefully |
| Plugin invocation scope | Stronger worker invocation/company-scope hardening | Validation exists but weaker invocation scope | Gap/partial | upstream | Top security port |
| Plugin SDK breadth | Database namespaces, local folders, managed resources, scoped APIs | Smaller SDK, marketplace-focused | Gap | upstream | Port foundation before plugins |
| Plugin database namespace | Restricted plugin database APIs | Missing | Gap | upstream | Needed for LLM Wiki |
| Plugin local folders | Trusted local folder APIs | Missing | Gap | upstream, risky | Later, with security review |
| Plugin managed resources | Managed agents/routines/skills | AoA marketplace installs resources differently | Diverged | Mixed | Integrate with marketplace |
| Plugin scoped API routes | Plugin-exposed scoped API routes | Missing/partial | Gap | upstream | Port with auth hardening |
| Plugin environment drivers | Plugins can register environment drivers | Missing | Gap | upstream | Needed for sandbox providers |
| Sandbox provider plugins | E2B, Daytona, Modal, exe.dev, Cloudflare, fake provider | No provider packages | Gap | upstream | Later, after leases/secrets/audit |
| Workspace Diff plugin | First-party plugin | Missing | Gap | upstream | Good candidate after plugin APIs |
| LLM Wiki plugin | First-party plugin | Missing | Gap | upstream, heavy | Do not port first |
| Plugin docs/spec | Strong authoring docs | Marketplace docs/plans | Diverged | Mixed | Rebrand/use useful docs |
| Plugin UI bridge | Similar core bridge | Similar, plus marketplace UX | Diverged | Mixed | Keep AoA marketplace, harden bridge |
| Marketplace catalog | Less productized | Catalog, trust tiers, deps, install flow | Diverged | AoA | Keep AoA source of truth |
| Marketplace install | Not as complete | Install operations, consent, cascade previews | Diverged | AoA | Use AoA path for upstream plugins |
| Plugin SRI integrity | Not equivalent | Fail-closed integrity verification | AoA-only | AoA | Keep |
| Plugin rollback | Not equivalent | Snapshots/auto-revert | AoA-only | AoA | Keep |
| Per-company plugin install | More instance-wide | Scoped by company/trust tier | Diverged | AoA | Keep |
| Commander/internal-agent | Missing | Full Commander/chat/tool/runs/reminders | AoA-only | AoA | Protect |
| Command staff/crew | Missing | Roles, triggers, cost caps, kill switch | AoA-only | AoA | Protect |
| Internal agent cost caps | Missing | Per-role/model/cost controls | AoA-only | AoA | Keep |
| Crew kill switch | Missing | Company/thread crew pause | AoA-only | AoA | Keep |
| Threads lifecycle | No equivalent | Phase/claim/transfer/fork/merge/promote | AoA-only | AoA | Keep |
| Discussions capture | Issue comments canonical | Discussions/extraction/approval | Diverged | AoA for ideation | Keep, connect to issues |
| Memory system | Plugin/future-like | Full memory items/versions/folders/assets/retrieval | AoA-only | AoA | Keep |
| Memory embeddings/retrieval | Missing equivalent | Semantic/keyword/temporal retrieval audit | AoA-only | AoA | Keep |
| Memory review/approval | Missing equivalent | Pending review/version/lifecycle | AoA-only | AoA | Keep |
| Teams/org layer | Simpler org/agents | Teams, departments, leads, imports, role hierarchy | AoA-only | AoA | Keep |
| Team coordination | Missing equivalent | Team coordination surfaces | AoA-only | AoA | Keep |
| MCP server/API keys | Missing equivalent | MCP API keys/client connections/resources | AoA-only | AoA | Keep |
| GitHub/workspace Git | Less cockpit-like | GitHub app, project/workspace Git, PR dialogs | AoA-only | AoA | Keep |
| Workspace cockpit UI | Simpler workspace detail | Terminal, preview, Git graph, timeline | Diverged | AoA | Keep |
| File import | Missing equivalent | File import jobs/routes | AoA-only | AoA | Keep |
| Artifacts | Work products/documents | Artifacts service/schema | Diverged | Mixed | Map with work products |
| Briefs/debriefs | Missing equivalent | Briefs/debriefs | AoA-only | AoA | Keep if product wants |
| Notifications | Less equivalent | Notifications schema/routes | AoA-only | AoA | Keep |
| Suggestions | Less equivalent | Suggestions service/routes | AoA-only | AoA | Keep |
| Output detection | Missing equivalent | Output detection | AoA-only | AoA | Keep |
| Trust scores | Missing equivalent | Agent trust scores | AoA-only | AoA | Keep |
| Workflow templates | Missing equivalent | Workflow templates | AoA-only | AoA | Keep |
| Finance/quotas | Cost/finance pieces | Cost/finance plus provider quota windows | Diverged | Mixed | Compare separately before port |
| Company invites | Invite history/audit/revoke/copy/open flows | Broader team management, less polished invite audit | Diverged | upstream for invite audit | Port audit UX |
| Company access settings | Clear instance/company split | Unified control center | Diverged | Mixed | Borrow access audit, keep AoA breadth |
| Live ops dashboard | Active agent/live dashboard | Guidance/product cockpit dashboard | Diverged | Mixed | Port live ops widgets |
| i18n | i18next, locale validation, many locales | Mostly hard-coded English | Gap | upstream | Consider foundation |
| Mobile issue/inbox polish | Better issue/inbox mobile flows | Better Commander/workspace mobile surfaces | Diverged | Mixed | Port issue/inbox mobile patterns |
| Storybook/UX labs | More UX labs/stories/fixtures | Many tests, less same UX lab structure | Partial | upstream for UI fixture loops | Borrow where useful |
| Cloud Upstream sync | Local-to-cloud upstream sync | Missing | Gap | upstream if needed | Product decision |
| Cloud tenant import mutations | Cloud/import support | Portability exists but different | Diverged | Unknown | Needs product review |
| Provider vault secret UX | Provider vault/secret binding polish | Partial secret binding/provider work | Partial | upstream slightly | Compare before port |
| Runtime body limits/control-plane fixes | Shared body limit/runtime fixes | Route-specific limits | Gap/partial | upstream | Small safety port |
| Embedded Postgres native prep | Import/runtime reliability hardening | Startup hardening but not same | Gap/partial | upstream | Port if relevant |
| Agent start lock | `agent-start-lock` service | Missing equivalent | Gap | upstream | Consider duplicate-run prevention |
| Company search/rate limit | Company search + rate limit | Missing/partial | Gap | upstream | Low/medium priority |
| Company logos | `company_logos` schema | Missing | Gap | upstream for branding | Low priority |
| User profiles/sidebar prefs | Profile/sidebar preference split | Different profile/preferences | Diverged | Mixed | Low priority |
| Issue references/mentions | Rich issue reference mentions/pills | Project mentions/discussions | Diverged | upstream inside issues | Port to issue UX |
| Org chart | Org chart UI | Teams/org pages stronger | Diverged | AoA overall | Maybe borrow visual bits |
| Activity formatting/charts | Activity charts/live activity polish | Activity exists | Partial | upstream for ops | Borrow selectively |
| Feedback redaction/share | Feedback systems | Bundles/transmission/votes too | Diverged | Mixed | Separate compare if needed |
| API adapter support | Broader adapter patterns retained | AoA intentionally dropped API adapters for CLI-only | Diverged | Product decision | Do not undo casually |

## Migration And Integration Warnings

- Do not cherry-pick upstream migrations by number. AoA migration history has diverged and currently has local dirty migration/schema work.
- Treat AoA current schema modules, services, and routes as the live contract. Some old migration artifacts may not represent live product behavior.
- Do not replace AoA `openclaw` with upstream `openclaw_gateway`. They are different integrations.
- Do not replace AoA `sandbox-docker` with upstream sandboxing. They solve different problems.
- Do not port upstream remote execution without workspace sync/restore, leases, cleanup, secrets, and audit.
- Do not port upstream plugin providers without AoA marketplace consent, trust tiers, integrity checks, rollback, and secret/audit handling.
- Do not copy upstream authorization routes directly. Map any scoped-grant concepts into AoA founder/team/department/internal-agent rules.
- Do not let upstream issue comments replace AoA discussions/threads. Connect them where useful.

## Discussion Questions Before Implementation

1. Should AoA's issue model become closer to upstream's execution model, or should issue execution remain a separate layer around current AoA tasks?
2. Should blocked work be modeled primarily through AoA `task_dependencies`, upstream-style `issue_relations`, or a unified abstraction?
3. Which adapter ports are actually product priorities: `grok_local`, `cursor_cloud`, `acpx_local`, `pi_local`, or `openclaw_gateway`?
4. Should AoA support remote SSH and managed sandbox execution soon, or keep focusing on local plus `sandbox-docker` first?
5. Should plugin host expansion happen before or after marketplace trust/consent updates?
6. Is i18n a near-term product goal, or only a foundation to keep in mind?
7. Should Cloud Upstream sync be considered part of AoA's direction, or is it upstream-specific cloud infrastructure?

## Suggested First Discussion Order

1. Security foundation: plugin invocation-scope hardening.
2. Focused user value: document locks/restore/diff.
3. Agent reliability: issue recovery actions and blocked inbox.
4. Runtime reliability: adapter-utils and command hardening.
5. Strategic execution: remote/sandbox environments.
6. Product expansion: Workspace Diff, LLM Wiki, and sandbox providers.
