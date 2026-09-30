---
title: "Paperclip ↔ AoA"
summary: "Lineage, wire-compat surfaces, and what's intentionally preserved"
---

## Lineage

AoA (Army of Agents) is built on [Paperclip](https://github.com/paperclipai/paperclip), an open-source AI agent orchestration project. Paperclip provides the foundation: the heartbeat push-execution system, adapter registry, atomic task checkout, ticketing pipeline, and the core server/UI scaffolding.

AoA layers a **Hybrid Workforce OS** on top for solo founders. Everything V1 and beyond is additive: thread-based Discussions (replacing the Debrief/Brief pipeline), the Internal Agent ("Commander"), 4-layer Memory with approval gating, immutable Artifact versions, per-task Execution Workspaces, RBAC (founder / team_lead / team_member), bidirectional MCP with a generated tool registry, a feedback and trust-score system, and the V3 roadmap items (autonomy tiers, connectors, blueprints, hosted execution).

The short version: **Paperclip is the execution primitive. AoA is what you build a company with.**

## What's renamed and what isn't

Everything a user or developer sees has been renamed to AoA: the CLI banner, log prefixes (`[aoa]`), CSS classes (`aoa-*`), localStorage keys (`aoa:*`), token prefixes (`aoa_invite_`, `aoa_mcp_`), environment variables (`AOA_*`), plugin example keys (`aoa.hello-world`), and all doc and UI prose.

Wire-compat surfaces are **intentionally preserved** under the legacy `paperclip` name to avoid breaking existing data, plugins, and integrations. The canonical and current allow-list lives at [wire-compat.md](../architecture/wire-compat.md). Representative surfaces include:

1. `PAPERCLIP_*` environment variables — mirrored to `AOA_*` equivalents; both are accepted.
2. `paperclipai` CLI binary alias — kept alongside the `aoa` bin in the
   repository and intended scoped CLI artifact. This does not make the
   upstream `paperclipai` npm package an AoA distribution.
3. `paperclipPlugin` manifest key — the plugin wire protocol identifier read by the host runtime.
4. `__paperclipPluginBridge__` — the in-page bridge injected by the plugin loader.
5. `paperclip-feedback-envelope-v2` / `paperclip-feedback-bundle-v2` — feedback payload schema versions (immutable once published).
6. `hermes-paperclip-adapter` — an external npm package name outside this repo.
7. `PaperclipPluginManifest` / `paperclipConfigSchema` — type-level aliases exported for backward-compatible plugin typing.
8. `paperclip_session_key` — HTTP integration field name expected by existing external clients.
9. `X-Paperclip-Run-Id` — HTTP response header consumed by existing integrations and OpenClaw join records.
10. `paperclip:/.*` localStorage keys — legacy reads allowed only inside `lib/storage-migrations.ts` and the `ui/index.html` FOUC bootstrap fallback; all new writes use `aoa:`.

The list above explains the compatibility boundary; use the linked architecture
document, rather than this overview, when deciding whether a particular legacy
identifier may remain.

## Why wire-compat was preserved

Renaming a user-visible string costs nothing. Renaming a wire surface breaks things silently and at a distance. Three categories of breakage drove the decision to keep these names:

**Existing user state.** LocalStorage keys like `paperclip.theme` are already written into users' browsers. DB rows contain `paperclip_session_key` values. A hard rename would log users out or corrupt preferences with no warning.

**The plugin ecosystem.** Plugins identify themselves with the `paperclipPlugin` manifest key and communicate through `__paperclipPluginBridge__`. The `@paperclipai/*` npm packages are published under that scope. Renaming the wire identifier would silently break every installed plugin until authors republished.

**Existing HTTP integrations.** External services that call AoA over HTTP already parse `X-Paperclip-Run-Id` response headers and send `paperclip_session_key` in their request bodies. OpenClaw join records store these values. A rename would require a coordinated migration across every integration simultaneously.

The allow-list is the boundary. Everything on it is frozen. Everything off it is a bug if it still says "Paperclip."

## What you'll see in the codebase

Running `grep -r paperclip .` will return hits. Most are intentional. A quick rule of thumb:

- **Wire-compat (intentional):** anything in a `LEGACY_*` constant; anything inside `dist/` or `build/`; anything in `.changeset/*.md`; any string literal that is a key, header name, or schema version field; any OpenClaw protocol field.
- **Bug (should be AoA):** prose in docs or comments; log prefixes like `[paperclip]`; CSS class names like `paperclip-mdxeditor`; env var references in eval prompts or new code; `pcp_` token prefixes; plugin example keys like `paperclip.hello-world`.

## For new contributors

The brand-check CI job in `.github/workflows/pr.yml` (Guards 1–9) enforces this boundary on every PR; Guard 9 additionally catches `AOA_*` env vars added to code without a matching entry in `docs/deploy/environment-variables.md`.
