# OpenClaw Comparison Review

Date: 2026-05-25

Scope:

- OpenClaw repo reviewed at `C:\Users\TK\OneDrive\Desktop\Claude Data\Paperclip-AoA\openclaw`
- AoA repo compared at `C:\Users\TK\OneDrive\Desktop\Claude Data\Paperclip-AoA\AoA-2.5`
- Paperclip repo compared at `C:\Users\TK\OneDrive\Desktop\Claude Data\Paperclip-AoA\paperclip-master\paperclip-master`

This document extends the Paperclip comparison work with a separate OpenClaw review. OpenClaw should not be treated as another Paperclip-style upstream. It is a different kind of system: a personal, multi-channel assistant/runtime with a deep plugin, provider, channel, daemon, memory, MCP, and approval model. AoA should learn from selected runtime patterns, not copy the product architecture wholesale.

## Executive Summary

OpenClaw is strongest where AoA is likely to need harder runtime discipline:

- plugin activation and ownership boundaries
- channel/message security policy
- host exec approvals and approval forwarding
- ACP/subagent runtime policy
- active-memory recall controls
- provider/model setup metadata
- daemon/doctor/setup repair workflows
- MCP and plugin tool boundary hardening

AoA remains stronger as a founder/company/workforce product:

- Commander/internal agent
- org chart and command staff
- board approvals
- discussions/threads
- structured memory with approval gates
- marketplace trust/install/rollback
- teams/RBAC
- cost caps and kill switch
- execution workspaces and Git cockpit

Paperclip remains the best reference for issue execution mechanics:

- issue workflow/recovery
- document locking/restore/diff mechanics
- runtime services
- sandbox/provider execution
- Kanban/inbox/search ergonomics
- task dependency and blocker surfaces

Recommended stance: use Paperclip for issue/task execution hardening, OpenClaw for runtime/platform safety patterns, and preserve AoA's company/Commander/memory product direction.

## High-Level Product Difference

| Codebase | Primary Shape | Best At | What Not To Overfit |
|---|---|---|---|
| AoA | Hybrid Workforce OS for solo founders/teams | Commander, org/team model, board governance, memory, marketplace, discussions | Do not dilute the founder/company workflow into a generic personal assistant |
| Paperclip | AI work orchestration and issue execution control plane | Issues, execution recovery, documents, runtime services, sandboxing | Do not wholesale overwrite AoA's newer product layers |
| OpenClaw | Personal multi-channel assistant and runtime | Channels, plugins, providers, approvals, daemon/setup, active recall | Do not copy channel-first architecture as AoA's core model |

## Detailed Comparison

| Area | OpenClaw Has | AoA Has Similar? | Paperclip Has Similar? | Better Implementation | AoA Recommendation |
|---|---|---:|---:|---|---|
| Plugin activation planning | Manifest-driven activation by command, provider, channel, route, agent harness, and capability. Reasons distinguish explicit activation hints from manifest ownership fallback. | Partial plugin lifecycle and marketplace, but no equally explicit activation planner. | Mature plugin host, but less OpenClaw-style provider/channel activation. | OpenClaw | Borrow activation planning for AoA plugins: load/enable plugins because a concrete trigger requires them, with recorded reasons. |
| Plugin metadata snapshots | Process-stable plugin metadata snapshot and lookup table. Rebuilds on config/inventory changes instead of polling hot paths. | Not as formalized. | Some host/runtime caching, but less explicit. | OpenClaw | Use for AoA marketplace/config validation/UI hints so metadata inspection stays cheap and deterministic. |
| Plugin boundary discipline | Plugins should import public SDK/helper subpaths, manifest metadata, and documented runtime helpers only. Core remains plugin-agnostic. | AoA has SDK/worker model and authz, but still carries legacy Paperclip wire compatibility. | Paperclip has broader plugin host APIs. | OpenClaw for boundary rules; AoA for trust/install model. | Define hard AoA plugin import/manifest boundaries before the marketplace grows. |
| Plugin config validation | Native `openclaw.plugin.json` is inspected before runtime loads. Config schema, UI hints, provider setup, channel config, and ownership metadata are manifest-owned. | AoA validates plugin config and manages lifecycle, but could make pre-runtime manifest validation more central. | Paperclip has plugin config/runtime surfaces. | OpenClaw | Adopt metadata-first validation before worker/runtime execution. |
| Marketplace/publishing | ClawHub publishing is owner-scoped; package scope must match owner; releases can be hidden until review/security checks finish. | AoA marketplace has trust/install/rollback direction. | Paperclip ecosystem exists. | AoA + OpenClaw combined | Borrow owner/scope/provenance/review rules for AoA marketplace publishing. |
| Channel architecture | First-class plugins for Slack, Telegram, iMessage, Discord, WhatsApp, Matrix, Teams, Feishu, LINE, Mattermost, etc. | AoA is not channel-first. | Paperclip is not channel-first. | OpenClaw | Do not copy breadth. Borrow channel policy primitives if AoA adds ChatOps/mobile approvals. |
| Channel security audit | Audits open DM policies, wildcard allowlists, dangerous name matching, and shared-session leakage risks. | AoA has auth, invites, allowed hostnames, board approval, but not this channel-specific audit layer. | Not comparable. | OpenClaw | Add AoA doctor/security checks for adapters, webhooks, MCP bridge, marketplace plugins, OpenClaw gateway config, and allowed-hostname drift. |
| Exec approvals | Host exec policy with `allow-once`, `allow-always`, `deny`, allowlist matching, ask fallback, strict inline eval, local approval state, and file-binding drift checks. | AoA has board approvals and Commander `requiresConfirmation`, but not host-exec approval depth. | Paperclip has governance/approval workflow, not this host approval model. | OpenClaw | Borrow decision vocabulary and durable allowlist pattern for Commander/tool execution. |
| Approval forwarding | ACP and channel flows can relay approval prompts and resolve them through channel-specific UI/reactions. | AoA approvals are mostly board/UI/API centric. | Not comparable. | OpenClaw | Useful future path for Slack/Telegram/mobile approval workflows. |
| ACP/subagent policy | ACP spawn checks include runtime policy, requester session requirements, sandbox restrictions, resume-session constraints, depth/children limits, and allowed target agents. | AoA has Commander delegation, subagents, tool allowlists, and cost controls, but runtime-policy checks are simpler. | Paperclip has adapters/runtime execution hardening. | OpenClaw for runtime policy; AoA for org semantics. | Strengthen AoA delegation with spawn depth, max child runs, allowed target agents, session ownership, and sandbox compatibility checks. |
| Subagent completion model | Isolated child sessions, push-based completion, idempotent parent handoff, result metadata, and parent verification guidance. | AoA has `delegate_to_subagent` and command-staff direction. | Paperclip has issue execution and recovery mechanics. | OpenClaw for subagent runtime; Paperclip for task recovery. | Borrow completion handoff semantics and parent verification. |
| Active Memory | Bounded blocking memory subagent before prompt build. Supports timeout, setup grace timeout, circuit breaker, per-session toggles, context modes, prompt style, tool allowlist, and transcript recovery. | AoA memory is deeper structurally: layers, approval gates, feedback patterns, semantic search, domain/identity memory. | Paperclip weaker than AoA here. | AoA for memory product; OpenClaw for recall runtime. | Keep AoA memory model. Borrow recall gating, timeout/circuit breaker, "return NONE" prompt discipline, and session toggles. |
| Memory plugin slot | Memory is an exclusive plugin slot; only one memory plugin can be active. | AoA memory is core product state, not a plugin slot. | Not comparable. | Depends on product goal. | Do not replace AoA memory. Consider provider/backend plugin slots later only for storage/search engines. |
| QMD/memory backend handling | QMD manager has scoped caches, open-failure cooldowns, MCP daemon startup, timeout handling, and scoped query policy. | AoA has semantic search and memory services, but not this exact backend runtime hardening. | Not comparable. | OpenClaw | Borrow backend cooldown/timeout/scoped teardown ideas for any future external memory search provider. |
| Doctor/setup | `openclaw doctor` has lint, fix, non-interactive, deep scans, service repair, state migrations, security warnings, plugin/tool allowlist warnings, channel status, sandbox repair, config cleanup. | AoA has docs/scripts and smoke flows, but no central doctor command at this depth. | Paperclip has ops/runtime improvements, but not same broad doctor. | OpenClaw | Add `aoa doctor` eventually. Initial checks: DB, env, secrets, plugins, marketplace, MCP, OpenClaw adapter, hostnames, queues, runtime providers. |
| Daemon/service management | launchd/systemd/schtasks, service env audit, restart handoff, service path/runtime checks. | AoA mostly app/server/dev runner today. | Paperclip runtime services are closer to work execution than local assistant daemon. | OpenClaw | Borrow only if AoA ships local desktop/agent runner or background service. |
| Provider/model catalog | Plugin-owned provider catalog, setup metadata, auth evidence, model normalization, pricing/source policy. | AoA has internal-agent provider implementations and adapter model/profile APIs. | Paperclip recently improved adapter/runtime/model profiles. | OpenClaw for provider metadata; Paperclip for adapter UI/runtime integration. | Use manifest/provider metadata ideas to improve AoA model picker and provider setup. |
| MCP bridge | Plugin tools are exposed through MCP handlers and wrapped with before-tool-call hooks. Recent code shows attention to bounded tools/list discovery. | AoA MCP bridge has fail-closed role env, company/user env requirements, and per-AoA-agent tool allowlists. | Paperclip has related adapter/runtime surfaces. | OpenClaw slightly deeper on generic MCP/plugin runtime; AoA strong on product auth context. | Audit AoA `tools/list` bounds, schema exposure, tool-call hooks, and confirmation handling. |
| Tool authorization | OpenClaw combines runtime policy, tool policy, channel/group policy, sandbox policy, exec approval, and plugin before-call hooks. | AoA has role/capability gates and default-deny tool allowlists for AoA agents. | Paperclip has governance and execution policies. | Mixed | Keep AoA's role/capability gates and add OpenClaw-style pre-call policy layers where external tools are involved. |
| Onboarding/wizard | Setup wizard, official plugin selection, provider/channel setup, security notes, post-install migration. | AoA quickstart/setup docs and OpenClaw docker smoke script. | Paperclip quickstart. | OpenClaw | Borrow wizard/doctor split: wizard sets up, doctor diagnoses and repairs. |
| UI diagnostics | Plugin inspect/status, approvals UI, sessions, usage, channel config. | AoA has stronger product UI for marketplace, memory, discussions, Commander, agents. | Paperclip has strong board/issue UI. | Mixed | Borrow targeted diagnostics panels, not full UI model. |
| Manager-of-managers stance | OpenClaw explicitly avoids agent-hierarchy/manager-of-managers frameworks as default product direction. | AoA's command staff and org hierarchy are product pillars. | Paperclip has CEO/delegation model. | AoA for product fit; OpenClaw as warning. | Keep AoA hierarchy, but cap recursion and keep delegation observable, bounded, and cost-aware. |

## Highest-Value Ideas To Borrow

### 1. Plugin Activation Planner

OpenClaw's planner is one of the most directly useful ideas. It answers: which plugin is relevant to this command/provider/channel/route/capability, and why?

AoA should consider an activation plan object for plugin execution:

- trigger kind: command, route, marketplace surface, tool, provider, webhook, UI slot
- plugin ids to activate
- reasons: manifest command owner, route owner, tool contract, provider owner, explicit activation hint
- diagnostics: disabled, blocked, missing config, missing permission, version mismatch

This would help AoA avoid loading or trusting broad plugin surfaces when only one narrow contribution is needed.

### 2. AoA Doctor

OpenClaw's doctor is a product-quality operations pattern, not just a script. AoA could start smaller:

- `aoa doctor --lint`
- `aoa doctor --fix`
- checks for env, database, migrations, secrets provider config, plugin health, marketplace state, MCP bridge config, OpenClaw adapter connectivity, allowed hostnames, queue/heartbeat status, and stale runtime sessions

This would be especially helpful before hosted execution, marketplace installs, and local OpenClaw gateway onboarding.

### 3. Runtime Approval Vocabulary

OpenClaw's `allow-once`, `allow-always`, and `deny` model is clearer than AoA's current mix of board approvals, confirmation markers, and tool-specific gates.

AoA should consider this split:

- board approval: strategic/product governance
- runtime approval: local command/tool execution permission
- durable runtime trust: allow-always scoped to actor/tool/command/context
- one-shot runtime trust: allow-once scoped to exact request

That would make Commander and MCP tool execution less ambiguous.

### 4. Active Memory Runtime Controls

AoA memory is product-superior, but OpenClaw's recall path has useful operational controls:

- bounded recall before prompt build
- timeout and setup grace timeout
- timeout circuit breaker by agent/model
- per-session active-memory toggle
- allowed chat/session scope
- tool allowlist for memory recall tools
- prompt styles from strict to recall-heavy
- explicit `NONE` when memory is weak

AoA should borrow these for Commander context assembly and internal-agent memory recall.

### 5. Subagent Safety Limits

OpenClaw's subagent/ACP controls are a strong guardrail set:

- max spawn depth
- max children per agent
- allowed target agents
- requester session required
- resume-session ownership constraints
- sandbox compatibility checks
- push-based completion and parent verification

AoA's command staff should keep its hierarchy, but delegation should inherit these runtime limits.

### 6. Channel/External Runtime Security Audit

OpenClaw audits high-risk exposure patterns such as open DMs and wildcard allowlists. AoA should translate this idea to its own world:

- adapter callback URLs exposed to unsafe hosts
- OpenClaw gateway token missing or stored inline
- marketplace plugin with broad tool permissions
- MCP bridge without explicit user role/company/user env
- webhook plugin enabled without auth secret
- plugin UI slot from unverified package
- external runtime configured with localhost that will break inside Docker

### 7. Provider Metadata and Setup Evidence

OpenClaw's provider metadata is cheap to inspect without loading runtime code. AoA can use the same idea for:

- provider setup UI
- model picker grouping
- env var detection
- auth state diagnostics
- model aliases
- pricing/cost display
- provider-specific health checks

This pairs well with AoA's cost caps and internal-agent provider registry.

### 8. MCP Tool Boundary Hardening

AoA already has important MCP safeguards:

- fail closed if role/company/user env is missing
- per-agent tool allowlist for AoA agents
- role and capability gates

OpenClaw adds useful patterns:

- before-tool-call hooks also applied through MCP bridge
- bounded tool discovery concerns
- explicit plugin tool ownership
- runtime policy layered over tool availability

AoA should audit whether `tools/list` can become too broad and whether tool confirmation markers should become structured approval requests.

## Ideas To Avoid Or Defer

| Idea | Why Not Copy Directly |
|---|---|
| Channel-first assistant architecture | AoA's product is a company/workforce OS. Channels should be integrations, not the core mental model. |
| Memory as a single plugin slot | AoA's memory is a strategic product surface with layers, approval, feedback, and domain context. Keep it first-class. |
| Massive provider/channel breadth | Breadth adds setup, security, support, and testing burden. AoA should add only channels/providers that support the founder workflow. |
| Replacing command staff because OpenClaw avoids manager-of-managers | OpenClaw's warning is useful, but AoA's hierarchy is intentional. The right move is bounded delegation, not removal. |
| Full daemon/service stack immediately | Useful only when AoA has a local background runner/desktop agent. For now, borrow doctor checks and OpenClaw connectivity diagnostics. |
| Plugin ecosystem complexity before trust model is locked | AoA should define permissions, provenance, owner scopes, rollback, and activation before encouraging broad third-party plugins. |

## AoA Action Backlog

| Priority | Candidate | Source Inspiration | Why It Matters |
|---|---|---|---|
| P0 | Audit AoA MCP `tools/list` and `tools/call` boundaries | OpenClaw MCP/plugin tool handlers | Prevents broad tool exposure and makes Commander safer. |
| P0 | Convert Commander confirmation marker into structured runtime approvals | OpenClaw exec approvals | Better UX and safer tool execution than text markers. |
| P0 | Add subagent spawn limits and target-agent policy | OpenClaw ACP/subagent policy | Keeps command staff from recursive, expensive, or unsafe delegation. |
| P1 | Add active-memory recall timeout/circuit breaker | OpenClaw active-memory plugin | Protects Commander latency and avoids repeated slow memory recalls. |
| P1 | Add plugin activation planning | OpenClaw activation planner | Reduces plugin blast radius and improves marketplace trust. |
| P1 | Add `aoa doctor --lint` skeleton | OpenClaw doctor | Gives us a safety net for setup, plugins, MCP, OpenClaw adapter, env, and hostnames. |
| P1 | Add marketplace owner/scope/provenance rules | ClawHub publishing model | Makes AoA marketplace safer before third-party packages grow. |
| P2 | Add provider metadata manifests | OpenClaw provider catalog | Improves provider setup UI, model selection, and cost visibility. |
| P2 | Add OpenClaw adapter diagnostics | OpenClaw doctor + AoA OpenClaw integration | Helps debug Docker/host callback/auth/session-key problems. |
| P2 | Add external channel approval design | OpenClaw channel approvals/reactions | Useful if AoA adds Slack/Telegram/mobile governance. |

## Specific AoA Surfaces To Revisit

- `server/src/services/internal-agent/mcp-bridge.ts`
- `server/src/services/internal-agent/authorize-tool.ts`
- `server/src/services/internal-agent/tool-registry.ts`
- `server/src/services/internal-agent/tools/delegate-to-subagent.ts`
- `server/src/services/internal-agent/context-assembly.ts`
- `server/src/services/internal-agent/cost-caps.ts`
- `packages/adapters/openclaw/src/server/execute.ts`
- `packages/adapters/openclaw/src/server/execute-common.ts`
- `server/src/routes/plugins.ts`
- `server/src/routes/marketplace.ts`
- `packages/plugins/sdk/src/`
- `docs/start/openclaw-integration.md`

## Specific OpenClaw References Reviewed

- `README.md`
- `VISION.md`
- `AGENTS.md`
- `src/plugins/activation-planner.ts`
- `src/plugins/activation-context.ts`
- `src/plugins/manifest.ts`
- `src/security/audit-channel.ts`
- `src/agents/acp-spawn.ts`
- `src/acp/permission-relay.ts`
- `src/mcp/plugin-tools-handlers.ts`
- `extensions/active-memory/openclaw.plugin.json`
- `extensions/active-memory/index.ts`
- `docs/plugins/architecture.md`
- `docs/plugins/manifest.md`
- `docs/tools/exec-approvals.md`
- `docs/tools/subagents.md`
- `docs/gateway/doctor.md`
- `docs/clawhub/publishing.md`

## Working Recommendation

Use OpenClaw as a runtime safety and extensibility reference, not as a product template.

For the next discussion, the practical order should be:

1. MCP/tool-call hardening
2. Commander runtime approvals
3. subagent/delegation limits
4. active-memory recall controls
5. plugin activation planner
6. `aoa doctor`
7. marketplace provenance/publishing rules

The first three are the highest risk-reduction items because they sit directly on Commander, tool execution, and delegation. The next three improve reliability and maintainability. Marketplace provenance becomes critical before we encourage broad third-party plugin usage.
