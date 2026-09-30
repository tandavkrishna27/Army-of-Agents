# Onboarding — Review & Full-Flow QA Plan

**Date:** 2026-07-19
**Branch:** `claude/signup-onboarding-ui-animations-0724cb` (77 commits vs `main`)
**Purpose:** Before pushing the marketplace PR or merging the branch, do a thorough review (staff self-review + **Codex**) and a proper end-to-end test of the whole onboarding flow, then gate everything on those passing.

**Gate held:** the `aoa-librarian` marketplace PR is staged locally but **NOT pushed** — it waits for review + tests to pass.

---

## Scope

Two layers of change on this branch:
- **A. The onboarding redesign (WS0–WS10)** — the bulk of the diff, built + two-stage-reviewed in prior sessions but **never Codex-reviewed** (Codex was blocked by 2FA then).
- **B. This session's work** — onboarding-runs-entirely-in-`/onboarding` + Lobby handoff + resume routing (`00180c3c0`), the deferred-item fixes (`7c33d7020`…`c05006de7`), and Items 1–2 (splash logo, agent-picker filter) + Item 3 (marketplace content, un-pushed).

**Codex-review scope decision (confirm with user):** review **B (this session's code)** in depth, or the **whole branch diff vs main** (A+B, ~78k lines — large, slower, mostly re-review of already-reviewed code). Recommended: **B first** (the un-reviewed new logic), then optionally spot-review A's highest-risk areas (routing, state machine).

---

## Phase A — Automated verification sweep

Prove the branch is green before human/Codex review.

- [ ] A1. UI unit/component suite: `cd ui && npx vitest run` — record pass/fail; fix any red.
- [ ] A2. Server suite: `cd server && npx vitest run` — record pass/fail (note CI-only drizzle-ESM-cycle files); fix any red that runs locally.
- [ ] A3. Typecheck: `cd ui && npx tsc --noEmit`; `cd server && npx tsc --noEmit`; `pnpm --filter @armyofagents/shared build`.
- [ ] A4. Coverage check per changed area — every file touched this session has at least one test asserting its new behavior (splash logo, crew filter, onboarding-in-flow, resume routing, memory-folders, invited terminal, useHomeSummary, CreateAgents effect). List any gaps → add tests.
- [ ] A5. Marketplace repo: `aoa-librarian` validates — catalog tests green + `agent:aoa-curated/aoa-librarian` in aggregated `catalog.json` (already confirmed; re-run before push).

**Done when:** all local suites green, typecheck clean, no coverage gap in changed areas.

## Phase B — Code review

- [ ] B1. **Staff self-review** per item against a checklist: correctness, edge cases, error handling, follows existing patterns, no dead code, no placeholder, tests match behavior. Items: onboarding-in-flow + resume routing; splash logo + sizing; crew filter; marketplace content; the deferred fixes.
- [ ] B2. **Codex review** of the agreed scope. Run Codex CLI on the diff; capture findings by severity (P1/P2/P3).
- [ ] B3. Triage + fix: address every P1 and justified P2; record why any finding is declined. Re-run Codex if code changed materially.

**Done when:** self-review checklist passes for each item; Codex P1s resolved; findings log written.

## Phase C — End-to-end flow QA (live, isolated `journey2` :3100)

Drive the real flow on the isolated Google-auth instance. A matrix of journeys × conditions; for each, record expected vs actual + DB verification + proof.

**Founder — new company (full spine + tail):**
- [ ] C1. Splash: real SVG logo renders at the right size, breathing dot + spinning "o" animate; reduced-motion disables animation.
- [ ] C2. Spine step-by-step: Profile (Continue-disabled-when-empty), Company (empty→error, prefix), Environment (real folder browse), Commander (provider), Verify (hard-gate CLI auth), spine-complete.
- [ ] C3. Unified chrome (Item 4, once built): phase rail persists spine → persona → tail, correct phase highlighted, no duplicate "Step N of M".
- [ ] C4. Persona fork — each door: **In-flight** (full tail), **Explorer** (short-circuit → Lobby), **Greenfield** (as designed).
- [ ] C5. In-flight tail: Departments (happy + GitHub-invalid gate), Integrations (503 → paste fallback), Braindump (text; + file drop & repo ingest once Item 5 built), Librarian (propose → approve → reject/retry), **CreateAgents (crew hidden, regular agents + form shown)**, First-job (task / discussion / skip).
- [ ] C6. Completion → **Lobby** (not the company dashboard); DB shows `firstRunCompletedAt` stamped only at the true end.

**Resume + routing:**
- [ ] C7. Abandon mid-tail → reload `/` → routed back into `/onboarding` (resumeFirstRunCompanyId), resumes the tail, not the dashboard.
- [ ] C8. Returning user (firstRunCompleted) → Lobby; **dashboard never shows onboarding** (Home is the steady dashboard on every route).
- [ ] C9. Second company (`?new=1`) from the Lobby.

**Invited (needs a 2nd real Google account):**
- [ ] C10. Accept invite → profile → auto-admit (email match) vs pending (mismatch) vs tokenless-consent vs reject→re-invite → admitted MiniMap → Lobby. *(Requires a 2nd account; if unavailable, cover via the 27 unit tests + defer the live 2-human run.)*

**For each row:** note pass/fail, capture a DB check or `read_page`/console proof, and file any bug for fix + regression test.

**Done when:** every drivable row passes live; bugs fixed + regression-tested; invited coverage either live-run or explicitly deferred.

## Phase D — Marketplace PR (gated on A–C)

- [ ] D1. Re-run marketplace catalog tests + aggregate; confirm `aoa-librarian` present.
- [ ] D2. Push branch + open PR (with user's final go-ahead — the diff gate).
- [ ] D3. After merge: confirm `catalog.json` on the CDN includes `aoa-librarian`; the app's team-reconcile picks it up for a member.

## Phase E — Sign-off

- [ ] E1. All suites green + typecheck clean.
- [ ] E2. Codex P1s resolved; findings log attached.
- [ ] E3. Live flow QA matrix passed (or deferrals explicit).
- [ ] E4. Ready to open the branch → `main` PR (separate from the marketplace PR).

---

## Notes / assumptions

- Items 4 (unified chrome) and 5 (memory rework) from the implementation plan are **not yet built** — C3, and the file-drop/repo parts of C5, will be exercised once those items land. This QA plan is the standing rubric; earlier items (1–3, onboarding-in-flow) are testable now.
- Live QA uses the isolated `journey2` instance to avoid touching any real data; server code changes require a restart, UI changes a rebuild.
