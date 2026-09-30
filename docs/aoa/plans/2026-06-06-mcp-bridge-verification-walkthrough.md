# MCP Bridge Fix — Live UI Walkthrough (B3) Notes

**Date:** 2026-06-06 · **Branch:** `fix/codex-mcp-bridge`

## Setup
- Stopped the old QA server (was running from the **AoA-qa** worktree = old/buggy bridge; PID 59132 + its embedded-pg child).
- Booted the server from the **AoA-mcp-fix** worktree (fixed bridge) on the `qa-disc` instance: embedded-pg reused the on-disk data (`:54440`), API + UI on `:3300`. Health: `/api/health → 200`, "Server listening", "Migrations already applied".
- UI built on demand via `vite` (`:5176`, proxying `/api` → `:3300`).

## What was PROVEN live in the browser (`/browse`)
1. **The fixed-bridge server serves the real app.** Loaded `QA Disco Co`, navigated Discussions → thread `376592a2…` (the exact target thread). No console errors.
2. **Codex-authored entries render in the live UI.** Two entries from `E2E Codex Poster …` (codex_local agents) display with real content ("Engineer joining the thread; I'll focus on feasibility, implementation risk, and privacy architecture constraints…"). These were posted **through the fixed bridge** during the B1 programmatic E2E — so the live app shows real codex output that the bridge delivered. Screenshots: `b3-01-thread-before.png`, `b3-06-final.png`.
3. **The @mention → dispatch pipeline works in the UI.** Composer + `@` autocomplete listed the codex agents alongside the claude crew; selected a codex agent (mention chip inserted); composed + sent; the entry posted and a **"⚡ Summoning E2E Codex Poster …"** pill appeared; the Adjutant controller ran (`status: succeeded`). Screenshots: `b3-02-mention.png`, `b3-03-composed.png`, `b3-04-sent.png`.

## What was NOT captured live (and why it is not a bridge issue)
- A **brand-new codex reply posting in real time** from the @mention did not appear within ~5 min of polling. Root cause (from `server.log`): the UI @mention routes through the **Adjutant controller → crew dispatch → autonomy/hop-cap gating**; the controller ran and succeeded but did not spawn a fresh `codex_local` run for the test-seeded agent. The `E2E Codex Poster` agents were seeded by the B1 test with minimal autonomy and were driven **directly** via `runAoaAgent` (which bypasses that gating). The thread was also in a **hop-cap** state.
- This is a property of the **discussions crew-dispatch pipeline** (a separate subsystem), not the MCP bridge. Confirmed: no `codex_local` spawn, no "Transport closed" / `rmcp` error in the window.
- Incidental: the server env carried an **invalid `OPENAI_API_KEY`** (`sk-proj-…1NQA` → 401), which only fails the background **embeddings** worker. It does not touch the bridge (which never receives the key) or the codex CLI (own auth).

## Bottom line
The live app renders real codex entries delivered by the fixed bridge, and the @mention dispatch UX works end-to-end. The **definitive functional proof** that a real codex agent posts through the fixed bridge is **B1** (programmatic, full `runAoaAgent` path → `discussion_entries` row `715439c7…`, run `completed`, no "Transport closed"). Watching a fresh post in real time via the UI is gated by the crew-dispatch/autonomy pipeline on the test agents, not the bridge.
