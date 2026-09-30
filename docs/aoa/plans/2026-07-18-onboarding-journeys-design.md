# Signup / Onboarding Journeys — Design Spec

**Status:** Locked for planning (v2, supersedes the v1 draft)
**Date:** 2026-07-18
**Branch:** `claude/signup-onboarding-ui-animations-0724cb` (worktree `optimistic-mendel-26100d`)
**Target:** UI-first onboarding redesign (`ui/src/onboarding/`, `ui/src/pages/Auth.tsx`, Home/Dashboard, plus a new crew agent + a braindump ingestion path). Google auth + invite issuance/claim already exist and are NOT re-litigated.
**Theme:** **Dark only** for v1, using the existing AoA tokens (warm near-black surfaces, brand red `#b82d1c` / glow red `#D13A26`). A light (warm-cream) theme is a later pass.

**Companion artifacts (living):**
- Flow chart: <https://claude.ai/code/artifact/2388ec95-adf1-4b0d-840b-40d31bedad14>
- Clickable mockup: <https://claude.ai/code/artifact/a54319fc-7d2d-432f-8e82-6198c0ee6d7b>

---

## 1. Goal

Turn first-run from a **setup form** into a **guided story that teaches the product**. Onboarding's job is to make a founder *understand AoA* (shared Memory, Agents/Crew, the many ways work is created, human+agent execution, review) while doing just enough real setup to make it concrete. Setup is a byproduct of the narrative.

Ships three v1 journeys: **Founder** (new company), **Invited teammate**, **Returning**.

## 2. Design principles

1. **Story over form** — each required step is a chapter that teaches one pillar through one real action.
2. **Persona changes content, not just copy** — a founder *bringing existing work* (In-flight) gets a different first move than one *just exploring*.
3. **Honor the multi-entry truth** — the Map (and the first-job step) shows work has many origins (Commander / Discussion / Direct) and two doers (human + agent).
4. **Required = story beats; optional = plumbing** — the only hard gate is a **verified engine** (no engine → dead product). Everything else is skippable / just-in-time.
5. **A department = a complete unit** — a folder/repo **+** its own Memory-Library brain (`domain` memory) **+** a worker agent.

## 3. Motion language (ported from the AoA marketing site)

Source repo (reference, read-only): `AoA-Website-main/`. Stack there: React + framer-motion + Canvas 2D (no three.js in actual motion, no Lottie). We port the *look/feel*, re-implemented in AoA's stack.

**Signature (carry over verbatim):**
- **Color = state:** red `#D13A26`/`#b82d1c` = active/working, amber `#c47a20`/`#d9a938` = thinking, green `#4a9a4a`/`#4fb67e` = done. Blue/teal/indigo/violet + the six `--data-*` accents = *agent identity*, not state.
- **Living idle loops** (2–5s ease-in-out): logo "o" spins (5s), red dot breathes (2s), agent floats (3s), antenna pulses (2s), visor scan (1.5s), constellation drifts.
- **Speed encodes urgency:** working ~0.5s pulses, thinking ~2.5–3s, done ~0.35s.
- **Reveal grammar:** fade + 40px up, `0.7s easeOut`, `useInView(-100px, once)`, stagger `0.15s`.
- **Panel transitions:** `AnimatePresence mode="wait"`, out fades up ~16px, in fades up from ~24px, ~`0.45s easeOut`.
- **Draw-on:** SVG `pathLength 0→1`, depth-staggered `0.18s`/level + `0.04s`/sibling.
- **Typewriter + mono** for system/boot copy at **55ms/char** with a blinking cursor.
- **Springy micro-interactions:** dots `cubic-bezier(0.34,1.56,0.64,1)`; node hover spring `stiffness 400 / damping 30`.
- Everything honors `prefers-reduced-motion`.

**Reusable primitives to build (Workstream 1):** animated `AoaLogo` (spinning o + breathing dot), `ConstellationBg` (28 nodes, <90px links, red node hopping 3–7s), `AgentCharacter` (navy `#1a1a2e` body / `#333` stroke, glowing identity-colored eyes, working/thinking/done states), `LoadingDots` (red→green), a `fadeUp`/`Reveal` wrapper, a `DrawOnMap` primitive.

## 4. The journeys

### Journey 1 — Founder (new company)

**Act I — The Spine** *(required; ends with a live engine)*
1. **You** — Human Operating Profile (name, title, timezone). *Reuse `HumanProfileStep`.*
2. **Your Company** — name only (vision/mission parked). *Reuse `OrgStep`.* Seeds identity memory.
3. **Your Engine** — pick Commander model (Claude/Codex) + root folder, then **Verify**. *Reuse `CommanderStep` + `EnvironmentStep` + `VerifyStep`.*
   - **Hard gate.** Three verify methods: (a) paste API key, (b) device login, (c) **do it yourself in the CLI → auto-detect & verify (polling)** ← the new method to add.

**Act II — Home, first run** *(the Map IS Home)*
4. **The Map** + **door band**. The Map teaches the machine (Commander/Discussion/Direct → Task → Agent/Human → Review → Memory). The persona fork is the door band under it. *(Map UI is a net-new surface — design owned by us.)*

**Act III — Your first move** *(persona fork; v1 = two live doors)*
- **🚚 In-flight — "Bring your work in"** (the value path):
  1. **Define departments** — min 1, add more. First = **Software** (function-type grid, folder-browse, GitHub). *Extend `DepartmentStep` with the real `FolderBrowserDialog` + GitHub-URL validation + multi-department.*
  2. **Integrations** *(optional, extensible)* — connect **GitHub** (App/auth → private repos, or paste URL → public). Future home for plugins/other products. *Partly-existing infra (`github_installations`, `github_pat`, `routes/github.ts`).*
  3. **Braindump** — one box per department; Software's pre-shows its connected repo/folder. *(Net-new capture surface.)*
  4. **Librarian organizes** — the **Librarian** (new crew agent) files each braindump into the **Memory Library** (= existing `domain` memory, per department); **founder approves inline.** *(New agent + new ingestion path; reuses extraction engine + `domain` memory store.)*
  5. **Create agent per department** — the **real org-agent create form** (name, purpose, **adapter** selection) **or pick from the marketplace**. *Reuse `AgentConfigForm` adapter controls + `SnapshotInstallModal` team/agent install.*
  6. **First job** — create a first **Task** (assigned to the new agent) **and/or** start a **Discussion**, side-by-side, **skippable**. *(Reuse existing task/discussion create; new lightweight onboarding surface.)*
  7. → Home, steady state, where the assigned agent is *actually working*.
- **🧭 Explorer — "Look around"** — straight to Home steady state; plumbing deferred to just-in-time / the Getting-Started checklist.
- **🌱 Greenfield — "Coming with just an idea"** — **parked** ("coming soon" door). Needs Commander skills; own design pass.

**Act IV — Home, steady state** — the existing Dashboard control room; the Map/doors **relax** into the existing Getting-Started checklist (extended). Optional plumbing fires JIT.

### Journey 2 — Invited teammate
1. **Accept invite** (link/token or tokenless open-invite) — reuse `InviteLanding.tsx` + `/onboarding/join`.
2. **Human Operating Profile** — reuse `HumanProfileStep`.
3. **"The machine you're joining"** — a slimmed, **read-only mini-Map** (net-new small surface).
4. → Home, steady state. **(v1: no engine step for invited teammates.** Commander config + provider creds are company-scoped, not per-human, so there's nothing clean to reuse for "each human's own CLI." A per-user runtime/auth model is a **separate deployment-pass initiative**, not v1 — see Codex review + WS10.)

### Journey 3 — Returning user
Already onboarded → straight to Home steady state + pending-invite cards. Nothing net-new.

## 5. Capability audit — reuse / extend / new (verified against code)

**Reuse anchors (do NOT rebuild):** `DEPARTMENT_FUNCTION_TYPES` (`packages/shared/src/constants.ts:1445`, 11 values), `NewProjectDialog` + `FolderBrowserDialog`, `AGENT_ADAPTER_TYPES` (`constants.ts:38`) + `AgentConfigForm`, the AoA crew seeders (`server/src/services/internal-agent/aoa-agents/ensure-all-crew.ts`), marketplace `SnapshotInstallModal` + `CascadeTreePreview`, the Dashboard Getting-Started checklist (`ui/src/pages/Dashboard.tsx`).

**Consolidated gap list (each tagged):**

| # | Item | Tag |
|---|------|-----|
| G1 | Wire real `FolderBrowserDialog` into onboarding `DepartmentStep` (currently bare text input) | extend |
| G2 | Reuse `isGitHubRepoUrl` validation on onboarding's repo field | extend |
| G3 | **Integrations step**: GitHub App/auth connect for **private repos** (+ paste-URL for public); extensible to plugins | extend (infra partly exists) |
| G4 | **Workspace-root capability, deployment-split** (instance-admin filesystem gate breaks non-admin founders → 403). One interface, two impls: `local_trusted` browses the founder's real disk (reaches existing repos); `authenticated`/multi-tenant is jailed to a server-owned per-company base. Covers all four fs ops (home/drives/browse/mkdir) + jail hardening. Future `environments`/`environment_leases` volumes swap in below the seam. | **v1 — WS0a** (not deferred) |
| G5 | Surface adapter/marketplace in onboarding create-agent. NOTE: `SnapshotInstallModal` is **not** a picker (needs a catalog-pick + a new `deptId` prop). | extend (WS7) |
| G6 | **Librarian** — a genuinely separate, general-purpose crew agent (NOT a Memory Keeper trigger). Needs a **registered role** across `instructionBundleRole`/autonomy/trigger-prompt + an instruction bundle **and its own marketplace package** (legacy seeder alone misses marketplace-managed companies). | **new** (full crew-role build) |
| G7 | **Per-department braindump** capture surface | **new** |
| G8 | Braindump → Librarian ingestion → `domain` memory, proposal via `memoryService.create` (`source:"agent"`, forces `status:"pending"`), **inline founder approval through the authenticated approval path** (not a direct `writeMemoryAndIndex`). | **new** (reuses extraction + memory store) |
| G9 | **The Map** surface (founder) + **mini-Map** (invited) + the `DrawOnMap` primitive | **new** |
| G10 | **First-job** onboarding surface (task and/or discussion) | new (reuses create APIs) |
| G11 | **Persisted `firstRunCompleted` flag** on onboarding-progress — the existing vision+dept+agent+goal checklist never completes for In-flight/Explorer. (`setupStatus` itself stays computed; this is the one real schema change.) | **new — WS0b** |
| G12 | Auth + Splash restyle (centered; animated logo splash) | extend |
| G13 | The motion-system primitives (§3) as reusable components | new |

## 6. Decisions ledger

| # | Decision |
|---|----------|
| D1 | Hybrid shape: spine → Home-first-run (Map + doors) → persona first move → Home steady. |
| D2 | Verify = hard gate for founders; 3 methods incl. **CLI auto-detect**. |
| D3 | The Map **is** Home (first-run mode → relaxes to steady). |
| D4 | Fork = **door band**. |
| D5 | Department = brain + worker; choice-based (min 1; first = Software w/ folder+GitHub). |
| D6 | v1 doors = In-flight + Explorer; Greenfield parked. |
| D7 | Invited teammates get a read-only mini-Map, then Home. **No own-engine step in v1** (company-scoped Commander ≠ per-human; per-user engine deferred to a deployment-pass initiative — Codex-flagged incompatibility). |
| D8 | Returning = straight to Home. |
| D9 | Company step = name only (vision/mission parked). |
| D10 | Memory piece = **Memory Library** (= existing `domain` memory) + a **new, separate, general-purpose "Librarian"** agent — reusable beyond onboarding, distinct from discussion-bound Memory Keeper (product call over Codex's "just extend Memory Keeper"). Full crew-role registration + its own marketplace package. Proposals via `memoryService.create(source:"agent")`; inline founder approval via the authenticated approval path. |
| D11 | **Integrations step** — v1 = GitHub (App/auth for private repos + URL for public); extensible to plugins. Callback needs an onboarding-return param; graceful fallback when the App isn't configured. |
| D12 | Create-agent = real form (adapter) **or** marketplace agent/team; marketplace surfaced in v1 (requires a catalog-pick + a `deptId` extension to `SnapshotInstallModal`). |
| D13 | **First-job** step = task and/or discussion, side-by-side, skippable (exact layout TBD at build). |
| D14 | **Dark theme only** for v1. Tokens scoped for the onboarding route, but applied to **portalled dialog containers** too (Radix portals to `body` and won't inherit a nested scope). |
| D15 | **Filesystem = one capability, deployment-split** (WS0a), in v1: `local_trusted` browses the founder's **real disk** (so "bring your work" reaches existing repos); `authenticated`/multi-tenant is **jailed** to a server-owned per-company base. Same interface; environment-backed volumes swap in later without touching onboarding. |
| D17 | **Onboarding is a state-machine redesign** (WS0c), not registry inserts: new `OnboardingState` values + advancement rules, and the persona fork happens **on Home after the spine**, not as blocking pre-Home wizard steps. |
| D16 | **First-run vs steady Home gates on a persisted `firstRunCompleted` flag** (WS0b), not the legacy 4-item checklist. |

**Parked / deferred:** Greenfield idea-mode; marketplace-team-per-department multi-batch; vision/mission placement; light theme; GitHub PAT beyond the Integrations App/URL path; invited-on-local engine detection precision; **managed-cloud multi-tenant storage backend** (per-company volumes/containers on `environments`/`environment_leases` — swaps in under the WS0a seam); onboarding agent hire-approval gating.

## 7. Screen inventory (with build tags)

| Screen | Journey | Build |
|---|---|---|
| S0 Splash (animated logo) | Founder | new (small) |
| S1 Auth (centered) | Founder | extend |
| S2 You / S3 Company | Founder | reuse |
| S4 Engine / S5 Verify (+CLI auto-detect, real folder browse) | Founder | reuse + extend |
| **S6 The Map** (first-run Home + door band) | Founder | **new** |
| S7a Departments (folder-browse + GitHub validation + multi) | In-flight | extend |
| **S7b Integrations** (GitHub) | In-flight | extend (infra partial) |
| **S7c Braindump** | In-flight | **new** |
| S7d **Librarian** organizes → Memory Library (inline approve) | In-flight | **new** |
| S7e Create agent (form+adapter **or** marketplace) | In-flight | extend |
| **S7f First job** (task/discussion) | In-flight | new (reuse APIs) |
| S8 Home steady (relaxed checklist) | In-flight/Explorer | extend |
| I1 Invite landing | Invited | reuse |
| **I3 Machine you're joining** (mini-Map) → Home | Invited | **new (small)** |
| ~~I4 Engine~~ | Invited | **dropped from v1** — per-user engine is a deployment-pass initiative (D7) |
| R1 Returning Home | Returning | reuse |

## 8. Out of scope
Auth mechanics (Google OAuth, invite issuance/claim); the parked items in §6; the full light theme; the exact animation source-port (visual parity is an implementation detail of Workstream 1).

## 9. Implementation decomposition (feeds the plan)

Ordered, independently-shippable workstreams (details in the implementation plan):
- **WS0 — Platform prerequisites** (WS0a deployment-split filesystem capability; WS0b `firstRunCompleted`+`firstRunPersona` flag; WS0c onboarding state-machine redesign). *Blocks WS3–WS9.*
- **WS1 — Motion foundation** (primitives from §3 + dark tokens). *Everything visual depends on this.*
- **WS2 — Auth + Splash** (centered, animated logo).
- **WS3 — Spine polish** (steps 1–3 restyle; engine CLI-auto-detect verify; real folder browse).
- **WS4 — Departments upgrade** (folder browser + GitHub validation + multi-department).
- **WS5 — Integrations step** (GitHub App/URL).
- **WS6 — Librarian + Memory Library** (new crew agent + braindump capture + ingestion + inline approval).
- **WS7 — Create-agent step** (real form + marketplace surface).
- **WS8 — First-job step** (task/discussion).
- **WS9 — The Map + Home first-run** (Map surface + `setupStatus` extension + steady-state relax).
- **WS10 — Invited + Returning** (mini-Map + skippable engine).

Each WS gets its own detailed bite-sized plan when it's next to build; WS1 is detailed first as the foundation and template.
