# Onboarding Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild AoA first-run as a guided, story-driven onboarding across three journeys (founder / invited / returning) with the marketing site's motion language, grounded in the existing `FlowEngine` + steps.

**Architecture:** A shared **motion foundation** (pure CSS + Canvas 2D primitives, dark tokens) underpins ten ordered, independently-shippable workstreams (WS1–WS10). We reuse the registry-driven `FlowEngine` and every existing step/dialog as building blocks; net-new work is narrow (the Map surface, the Librarian crew agent + braindump→Memory-Library ingestion, the braindump/first-job surfaces, the Integrations step). No new runtime dependency — the mockup proved logo/constellation/agent/dots/reveals/draw-on all work in CSS + Canvas.

**Tech Stack:** React 19 + Vite + Tailwind v4 (`ui/src/`), vitest (`pnpm --filter @armyofagents/ui test:run <path>`), Express 5 + Drizzle (`server/`, `packages/db/`). Spec: [`2026-07-18-onboarding-journeys-design.md`](2026-07-18-onboarding-journeys-design.md).

---

## Decisions locked before coding

- **Zero new runtime *libraries*, but small JS controllers are expected.** Motion is CSS keyframes + Canvas 2D + `requestAnimationFrame`, plus lightweight hand-rolled controllers where CSS alone can't express it: an `IntersectionObserver` hook for in-view reveals, a `useTypewriter` hook (setTimeout sequencing), a mount/unmount swap for wait-mode enter/exit, and a spring via `cubic-bezier`. Do NOT add `framer-motion`/`motion` (not installed; AoA's convention is hand-rolled). (Codex P2: "pure CSS" was overstated — the controllers are in-scope, just dependency-free.)
- **Dark theme — scope it where it actually renders.** New tokens live under an `.onboarding-dark` scope, but Radix dialogs (`FolderBrowserDialog`, `SnapshotInstallModal`) **portal to `document.body`** and would inherit global tokens, not the scope (Codex P1). Approach: for the onboarding route, set the dark token set on a wrapper **and** on the portal container (Radix `Dialog.Portal container=` / a themed portal root), OR force the global dark root for the duration of onboarding and restore on exit. Pick per-dialog at build; do NOT assume a nested `.onboarding-dark` reaches portalled content.
- **Reuse over rebuild** (spec §5 anchors). Extend existing steps/dialogs; never fork `DEPARTMENT_FUNCTION_TYPES`, `AGENT_ADAPTER_TYPES`, `AgentConfigForm`, or the crew seeders. Note the extend-not-as-is caveats: `FolderBrowserDialog` hits instance-admin filesystem routes (→ WS0), `isGitHubRepoUrl` is function-local and must be exported (→ WS4), `SnapshotInstallModal` needs a catalog-pick + `deptId` API extension (→ WS7).
- **Every motion component honors `prefers-reduced-motion`** (snap to final state / render static). Tested requirement.
- **Two platform prerequisites are in v1, not deferred (Codex P1):** a **company-scoped workspace-root capability** (jailed filesystem browse/mkdir; the instance-admin gate breaks non-admin founders) and a **persisted "first-run done" flag** (the existing vision+dept+agent+goal checklist never completes for In-flight/Explorer). Both are WS0.

## Workstream sequencing (dependency order)

0. **WS0 — Platform prerequisites** *(WS0a deployment-split filesystem capability + WS0b first-run flag + WS0c onboarding state-machine redesign; blocks WS3–WS9)*
1. **WS1 — Motion foundation** *(detailed below; everything visual depends on it)*
2. **WS2 — Auth + Splash**
3. **WS3 — Spine polish** (steps 1–3; engine CLI-auto-detect verify; real folder browse — needs WS0)
4. **WS4 — Departments upgrade** (needs WS0)
5. **WS5 — Integrations step (GitHub)**
6. **WS6 — Librarian + Memory Library** (server + UI)
7. **WS7 — Create-agent step** (real form + marketplace)
8. **WS8 — First-job step**
9. **WS9 — The Map + Home first-run** (needs WS0 first-run-done flag)
10. **WS10 — Invited + Returning**

WS0 and WS1 are the two foundations. Each of WS2–WS10 gets expanded into its own detailed bite-sized plan when it reaches the front of the queue. **WS1 is detailed in full below** as the pattern template for the rest; **WS0 is outlined with concrete file targets** because it unblocks the spine.

---

## WS0 — Platform prerequisites *(build first; unblocks WS3/WS4/WS9)*

### WS0a — Company workspace-root capability, deployment-split *(Codex P1 ×3: authz can't be deferred; all four fs ops; jail-vs-existing-work)*
- **Problem:** `FolderBrowserDialog` (`FolderBrowserDialog.tsx:68-89,119-146,155-169`) calls **four** ops — `home`, `drives`, `browse`, `mkdir` — all gated by `assertCanManageInstanceSettings` (`filesystem.ts:44-45,136-137,159-160,201-203`). A non-admin founder 403s on **all four** (not just browse/mkdir), breaking the Engine + Department steps.
- **Design — one capability, two implementations behind the same interface** (deployment-split, per user decision):
  - **`local_trusted`:** the founder IS trusted (loopback). Browse the **real filesystem** scoped to their **home area** (like today's founder flow) so they can reach **existing repos anywhere on disk** — this is what makes "bring your work in" real (Codex P1: a fresh server-owned jail can't see pre-existing repos). Authorized by company membership, not instance-admin.
  - **`authenticated` / multi-tenant:** **jailed** to a server-owned per-company base `<INSTANCE_WORKSPACE_BASE>/<companyId>` (NOT the user-mutable `company.rootFolder`, which a member can `PATCH`). Existing-work import in multi-tenant is a later concern (mount/import into the volume) — tracked, not v1.
  - Both go through a single `resolveCompanyWorkspaceRoot(companyId, deploymentMode)` resolver — the seam where the future `environments`/`environment_leases` volume backend swaps in without touching onboarding UI.
- **Jail hardening (Codex P1):** containment check = `realpath` then **separator/case-safe prefix** comparison; for `mkdir`, resolve the **nearest existing ancestor** and check *that* is in-jail (target doesn't exist yet); reject symlinks that escape and guard the **symlink-replace race** (re-check after open, or `O_NOFOLLOW`-style). Tests must cover `..`, absolute-outside, **symlinked dir, prefix-collision (`/base/co` vs `/base/co2`), Windows case/separator, and mkdir-through-symlink** — not just `..`/abs.
- **Files:** `server/src/routes/filesystem.ts` (company-scoped `home`/`drives`/`browse`/`mkdir` handlers — in jailed mode `drives` is disabled/replaced and `home` returns the jail root; membership authz), `resolveCompanyWorkspaceRoot()` helper + jail util, `ui/src/api/filesystem.ts` (company-scoped client), `ui/src/components/FolderBrowserDialog.tsx` (accept a `companyId`/scoped-api prop + a mode that hides the drive picker when jailed; instance-settings keeps the admin path).
- **Tests:** `local_trusted` member browses their real home + an existing repo; `authenticated` member is jailed (browse/mkdir/home in-jail, drives hidden); all escape vectors above rejected; non-member 403; instance-settings path unchanged.

### WS0b — First-run-done flag *(Codex P1: the Map/steady-Home gate never completes)*
- **Problem:** Home shows first-run until `hasVisionMission && hasDepartment && hasAgent && hasGoal` (`ui/src/pages/Dashboard.tsx:181-213`). We park vision and don't require a goal, and Explorer creates nothing → In-flight/Explorer users are stuck in first-run forever.
- **Design:** add persisted **`firstRunCompletedAt`** + **`firstRunPersona`** (`"manual" | "in_flight" | "explorer" | null`) on the onboarding-progress record (`packages/db/src/schema/onboarding_progress.ts`) plus a home-service field so `showOnboarding` = `!firstRunCompleted` (not the 4-item checklist). `firstRunPersona` is written at the door band (WS9) so In-flight vs Explorer resume correctly; completion is set when the founder finishes the persona path or clicks "Enter the control room." This is the one genuine **schema change** (Codex corrects G11 — `setupStatus` is otherwise computed, not persisted).
- **Backfill = an idempotent startup routine, NOT `db:generate` (Codex re-review P1).** `pnpm db:generate` only adds columns; it will not compute `SETUP_COMPLETE → now()`. Ship a startup backfill in the pattern of `backfill-template-origin.ts` (runs every boot, touches only rows where `firstRunCompletedAt IS NULL` **and** the progress is already complete). "Complete" must be checked against BOTH representations Codex flagged — `currentState === "SETUP_COMPLETE"` and the `completedStates` array containing it (`server/src/services/onboarding.ts:56-64`). Also default `firstRunCompleted = true` in `home.ts` when **no** onboarding-progress row exists (pre-existing members). Only genuinely-new onboarding writes `null`.
- **Write authz + audit (Codex P1):** the persona/completion write endpoint derives `userId` from the **board actor** (never the client), updates **only that actor's `(userId, companyId)` row** with optimistic concurrency, enforces company access, validates `firstRunPersona` against the enum, and **activity-logs** completion/persona changes. Extend `server/src/routes/onboarding.ts` (the existing advance route) rather than a new unauthenticated endpoint.
- **Files:** `packages/db/src/schema/onboarding_progress.ts` (+ `pnpm db:generate`), a startup backfill routine (registered where `backfill-template-origin` is), `server/src/routes/onboarding.ts` (authz'd persona/completion write), `server/src/services/home.ts` (expose flag + missing-row default), `packages/shared/src/types/home.ts` (contract), `ui/src/pages/Dashboard.tsx` (read the flag).
- **Tests:** new onboarding shows first-run until the flag is set; setting it flips Home to steady-state even with no goal; Explorer reaches steady-state after dismiss; **existing `SETUP_COMPLETE` (via both `currentState` and `completedStates`) and a row-less returning member skip first-run**; the write rejects a mismatched actor / invalid persona; persona persists across reload.

### WS0c — Onboarding state-machine redesign *(Codex P1 ×2: this is NOT "insert a registry entry")*
- **Problem:** the flow is a strict, server-enforced state machine. `FlowEngine` won't navigate Home until Department → Agent → Review complete (`FlowEngine.tsx:83-87`), server advancement **rejects skipped prerequisites** (`server/src/services/onboarding.ts:147-159`), and `OnboardingState` is a fixed ordered union (`packages/shared/src/onboarding.ts:16-50`). So: (a) Explorer can't reach Home after verify; (b) In-flight hits Department before the Map; (c) new steps (Integrations/Braindump/Librarian/First-job) have **no `OnboardingState` value, ordering, dependency, or completion semantics** and cannot be registry-inserted under the current contract.
- **Design:** treat the state machine as first-class work that lands **before** WS3–WS9 wire their steps.
  - Add the new states + ordering to `packages/shared/src/onboarding.ts` (or an onboarding-v2 track) and mirror in `ui/src/onboarding/steps/index.ts` + `registry.ts`; extend `server/src/services/onboarding.ts` advancement + prerequisite rules for them.
  - **Decouple "spine complete → land on Home-first-run"** from "all steps done": after `COMMANDER_VERIFIED`, the founder lands on Home (WS9), and the persona-path steps (In-flight tail) advance **from there**, not as blocking pre-Home wizard steps. Explorer completes the spine and sets `firstRunCompleted` immediately.
  - Decide per step whether it's a `FlowEngine` step or a Home-hosted surface, and encode that so the engine + server agree (Codex: today a registry entry can't just be inserted).
- **Files:** `packages/shared/src/onboarding.ts`, `ui/src/onboarding/steps/index.ts`, `ui/src/onboarding/registry.ts`, `ui/src/onboarding/FlowEngine.tsx`, `server/src/services/onboarding.ts`.
- **Tests:** Explorer reaches Home steady-state right after verify; In-flight sees the Map before Department; each new state advances/enforces prerequisites correctly; no regression to the founder happy path.

---

**WS1 is detailed in full below.**

---

## File Structure — WS1 (Motion foundation)

All new, co-located under a new `motion/` folder so the primitives are one focused unit:

- Create: `ui/src/onboarding/motion/motion.css` — keyframes + the `.onboarding-dark` token scope + agent-character classes (imported once by the barrel).
- Create: `ui/src/onboarding/motion/AoaLogo.tsx` — animated wordmark (spinning "o" + breathing dot). Props: `size?: number`, `hideDot?: boolean`.
- Create: `ui/src/onboarding/motion/ConstellationBg.tsx` — Canvas 2D node field. Props: `className?`.
- Create: `ui/src/onboarding/motion/AgentCharacter.tsx` — the robot. Props: `state?: "idle"|"working"|"thinking"|"done"`, `eyeColor?: string`, `size?: "sm"|"md"|"lg"`, `label?: string`.
- Create: `ui/src/onboarding/motion/LoadingDots.tsx` — 3-dot widget. Props: `state: "idle"|"loading"|"done"`.
- Create: `ui/src/onboarding/motion/Reveal.tsx` — fade-up wrapper. Props: `delay?: number`, `as?: keyof JSX.IntrinsicElements`, `children`.
- Create: `ui/src/onboarding/motion/index.ts` — barrel export (also imports `motion.css` once).
- Create: `ui/src/onboarding/motion/useInView.ts` — `IntersectionObserver` hook (`{ once, margin:"-100px" }`) so `Reveal` can fire on scroll-in, matching the site's `useInView` grammar (Codex P2 — CSS alone can't do in-view triggering).
- Create: `ui/src/onboarding/motion/useTypewriter.ts` — setTimeout char sequencer (55ms/char) for the splash/boot copy.
- Test: `ui/src/onboarding/motion/__tests__/{AoaLogo,ConstellationBg,AgentCharacter,LoadingDots,Reveal}.test.tsx`.
- **Note (Codex P2):** `Reveal` must actually implement its documented `as` (polymorphic tag) prop and accept an optional `inView` mode via `useInView`. The **`DrawOnMap`** primitive is built in **WS9** (co-located with the Map that consumes it), not WS1.

Source-of-truth motion values (from the design brief): logo o-spin `5s`, dot breathe `2s`; constellation 28 nodes / links `<90px` / red node hops every `3000+rand·4000ms`; agent float `3s`, antenna `2s`, visor scan `1.5s`; working eye/led `.6s/.5s`, thinking `2.5s`, done `.35s`; loading dots bounce `.65s` staggered `.13s`, spring `cubic-bezier(0.34,1.56,0.64,1)`; reveal `fadeUp .7s cubic-bezier(.16,.8,.3,1)`, stagger `.09–.15s`. Colors: robot body `#1a1a2e`/stroke `#333`/visor `#0a0a18`; states red `#D13A26` / amber `#c47a20` / done `#4a9a4a`.

---

## WS1 — Task 1: Motion tokens + keyframes CSS

**Files:**
- Create: `ui/src/onboarding/motion/motion.css`
- Test: (verified via the component tests in Tasks 2–6; this task ships the stylesheet they rely on)

- [ ] **Step 1: Write `motion.css`** with the scoped token root, keyframes, and agent classes. Port verbatim from the proven mockup (`scratchpad/onboarding-mockup.html` `<style>`), scoping tokens under `.onboarding-dark`:

```css
/* ui/src/onboarding/motion/motion.css */
.onboarding-dark{
  --bg:#0a0a0a; --stage:#0d0d0d; --card:#1c1a19; --card-2:#211f1d; --field:#131211;
  --text:#eeeeee; --dim:#999; --very-dim:#737373; --border:#242424; --border-strong:#383838;
  --brand:#b82d1c; --brand-hover:#d13a26; --glow-red:#D13A26; --amber:#d9a938; --think:#c47a20;
  --green:#4fb67e; --done:#4a9a4a; --indigo:#6470dc; --teal:#3fa8c7;
  --robot:#1a1a2e; --robot-stroke:#333; --visor:#0a0a18;
  --mono:'Geist Mono',ui-monospace,monospace;
}
@keyframes obd-spin{to{transform:rotate(360deg)}}
@keyframes obd-breathe{0%,100%{transform:scale(1);box-shadow:0 0 0 rgba(209,58,38,0)}50%{transform:scale(1.35);box-shadow:0 0 7px rgba(209,58,38,.7)}}
@keyframes obd-fadeUp{to{opacity:1;transform:none}}
@keyframes obd-bounce{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}
@keyframes a-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}
@keyframes a-ant{0%,100%{box-shadow:0 0 0 rgba(209,58,38,0)}50%{box-shadow:0 0 7px rgba(209,58,38,.8)}}
@keyframes a-scan{from{left:-30%}to{left:110%}}
@keyframes a-eyepulse{0%,100%{opacity:1}50%{opacity:.5}}
@keyframes a-flash{0%,100%{opacity:1}50%{opacity:.2}}
@keyframes a-swing{from{transform:rotate(-18deg)}to{transform:rotate(18deg)}}
@keyframes a-nod{0%,100%{transform:rotate(0)}25%{transform:rotate(5deg)}75%{transform:rotate(-3deg)}}
@keyframes a-wave{from{transform:rotate(-25deg)}to{transform:rotate(45deg)}}
@keyframes a-rise{0%{transform:translateY(0);opacity:.6}100%{transform:translateY(-14px);opacity:0}}
/* NOTE: full agent-character selector block (.agent, .a-head, .is-working, .is-thinking, .is-done, …)
   is ported verbatim from the mockup <style> and lives here. */
@media (prefers-reduced-motion: reduce){
  /* Stops the always-on CSS loops (logo spin, agent float, antenna, visor scan).
     Reveal + typewriter + constellation decide reduced-motion in JS (they render
     the final/visible state), so they don't depend on this rule. */
  .onboarding-dark *{animation:none !important; transition:none !important}
}
```

(The full `.agent*` selector block is large but already written and validated in the mockup — copy it verbatim into this file. It is intentionally not re-pasted here to avoid drift; the mockup is the source.)

- [ ] **Step 2: Commit**

```bash
git add ui/src/onboarding/motion/motion.css
git commit -m "feat(onboarding): motion tokens + keyframes stylesheet"
```

## WS1 — Task 2: AoaLogo component

**Files:**
- Create: `ui/src/onboarding/motion/AoaLogo.tsx`
- Test: `ui/src/onboarding/motion/__tests__/AoaLogo.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { render } from "@testing-library/react";
import { AoaLogo } from "../AoaLogo";
test("renders the AoA wordmark with a spinning ring and a dot by default", () => {
  const { container } = render(<AoaLogo size={40} />);
  expect(container.querySelector('[data-part="ring"]')).toBeTruthy();
  expect(container.querySelector('[data-part="dot"]')).toBeTruthy();
});
test("hideDot omits the breathing dot", () => {
  const { container } = render(<AoaLogo size={40} hideDot />);
  expect(container.querySelector('[data-part="dot"]')).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/ui test:run src/onboarding/motion/__tests__/AoaLogo.test.tsx`
Expected: FAIL — "Cannot find module '../AoaLogo'".

- [ ] **Step 3: Write minimal implementation**

```tsx
// ui/src/onboarding/motion/AoaLogo.tsx
export function AoaLogo({ size = 40, hideDot = false }: { size?: number; hideDot?: boolean }) {
  const s = `${size}px`;
  return (
    <span className="obd-logo" style={{ fontSize: s, display: "inline-flex", alignItems: "center", gap: ".06em", fontWeight: 800, letterSpacing: "-.03em", lineHeight: 1 }}>
      <span>A</span>
      <span data-part="ring" style={{ width: ".60em", height: ".60em", borderRadius: "50%", border: ".12em solid var(--text)", borderRightColor: "transparent", borderBottomColor: "transparent", animation: "obd-spin 5s linear infinite" }} />
      <span>A</span>
      {!hideDot && <span data-part="dot" style={{ width: ".15em", height: ".15em", borderRadius: "50%", background: "var(--glow-red)", alignSelf: "flex-end", marginBottom: ".12em", animation: "obd-breathe 2s ease-in-out infinite" }} />}
    </span>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/ui test:run src/onboarding/motion/__tests__/AoaLogo.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add ui/src/onboarding/motion/AoaLogo.tsx ui/src/onboarding/motion/__tests__/AoaLogo.test.tsx
git commit -m "feat(onboarding): animated AoaLogo (spinning o + breathing dot)"
```

## WS1 — Task 3: ConstellationBg component

**Files:**
- Create: `ui/src/onboarding/motion/ConstellationBg.tsx`
- Test: `ui/src/onboarding/motion/__tests__/ConstellationBg.test.tsx`

- [ ] **Step 1: Write the failing test** (jsdom has no real canvas; test the guard + DOM, not pixels)

```tsx
import { render } from "@testing-library/react";
import { ConstellationBg } from "../ConstellationBg";
test("renders a canvas and does not throw when 2d context is unavailable", () => {
  const { container } = render(<ConstellationBg />);
  expect(container.querySelector("canvas")).toBeTruthy();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/ui test:run src/onboarding/motion/__tests__/ConstellationBg.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation** (port the mockup's canvas algorithm; guard `getContext` null for jsdom + respect reduced-motion)

```tsx
// ui/src/onboarding/motion/ConstellationBg.tsx
import { useEffect, useRef } from "react";
export function ConstellationBg({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cvs = ref.current; const ctx = cvs?.getContext("2d");
    if (!cvs || !ctx) return; // jsdom / no-canvas guard
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const dpr = window.devicePixelRatio || 1;
    let W = 0, H = 0, raf = 0, redIdx = 0, redTimer: number | undefined;
    let dots: { x:number;y:number;vx:number;vy:number;r:number;o:number }[] = [];
    const size = () => { const r = cvs.getBoundingClientRect(); W = cvs.width = r.width*dpr; H = cvs.height = r.height*dpr; };
    const init = () => { dots = Array.from({length:28},()=>({x:Math.random()*W,y:Math.random()*H,vx:(Math.random()-.5)*.72*dpr,vy:(Math.random()-.5)*.72*dpr,r:(.8+Math.random()*1.8)*dpr,o:.15+Math.random()*.15})); };
    const hop = () => { redIdx = Math.floor(Math.random()*dots.length); redTimer = window.setTimeout(hop, 3000+Math.random()*4000); };
    const MAXD = 90*dpr;
    const frame = () => {
      ctx.clearRect(0,0,W,H);
      for (let i=0;i<dots.length;i++){ const d=dots[i]; d.x=(d.x+d.vx+W)%W; d.y=(d.y+d.vy+H)%H;
        for (let j=i+1;j<dots.length;j++){ const e=dots[j]; const dist=Math.hypot(d.x-e.x,d.y-e.y);
          if (dist<MAXD){ ctx.strokeStyle=`rgba(255,255,255,${0.05*(1-dist/MAXD)})`; ctx.lineWidth=.5*dpr; ctx.beginPath(); ctx.moveTo(d.x,d.y); ctx.lineTo(e.x,e.y); ctx.stroke(); } } }
      for (let i=0;i<dots.length;i++){ const d=dots[i]; ctx.beginPath();
        if (i===redIdx){ ctx.fillStyle="rgba(209,58,38,0.7)"; ctx.shadowBlur=6*dpr; ctx.shadowColor="#D13A26"; ctx.arc(d.x,d.y,3*dpr,0,7); }
        else { ctx.fillStyle=`rgba(255,255,255,${d.o})`; ctx.shadowBlur=0; ctx.arc(d.x,d.y,d.r,0,7); } ctx.fill(); }
      ctx.shadowBlur=0; raf = requestAnimationFrame(frame);
    };
    size(); init(); if (!reduce){ hop(); frame(); } else { frame(); cancelAnimationFrame(raf); }
    const onResize = () => { size(); init(); };
    window.addEventListener("resize", onResize);
    return () => { cancelAnimationFrame(raf); if (redTimer) clearTimeout(redTimer); window.removeEventListener("resize", onResize); };
  }, []);
  return <canvas ref={ref} className={className} style={{ position:"absolute", inset:0, display:"block", zIndex:0 }} />;
}
```

- [ ] **Step 4: Run test to verify it passes** — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add ui/src/onboarding/motion/ConstellationBg.tsx ui/src/onboarding/motion/__tests__/ConstellationBg.test.tsx
git commit -m "feat(onboarding): ConstellationBg canvas node field"
```

## WS1 — Task 4: AgentCharacter component

**Files:**
- Create: `ui/src/onboarding/motion/AgentCharacter.tsx`
- Test: `ui/src/onboarding/motion/__tests__/AgentCharacter.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { render } from "@testing-library/react";
import { AgentCharacter } from "../AgentCharacter";
test("applies the state class and label", () => {
  const { container, getByText } = render(<AgentCharacter state="working" label="MEMORY" eyeColor="#D13A26" />);
  expect(container.querySelector(".agent.is-working")).toBeTruthy();
  expect(getByText("MEMORY")).toBeTruthy();
});
test("idle state has no is-* modifier", () => {
  const { container } = render(<AgentCharacter />);
  const el = container.querySelector(".agent")!;
  expect(el.className).not.toMatch(/is-(working|thinking|done)/);
});
```

- [ ] **Step 2: Run test to verify it fails** — Expected: FAIL, module not found.
- [ ] **Step 3: Write minimal implementation** (render the DOM tree the `.agent*` CSS in Task 1 targets; port the factory from the mockup's `agent()`)

```tsx
// ui/src/onboarding/motion/AgentCharacter.tsx
type State = "idle" | "working" | "thinking" | "done";
export function AgentCharacter({ state = "idle", eyeColor, size = "md", label }:
  { state?: State; eyeColor?: string; size?: "sm"|"md"|"lg"; label?: string }) {
  const cls = ["agent", size !== "md" ? size : "", state !== "idle" ? `is-${state}` : ""].filter(Boolean).join(" ");
  const eye = eyeColor ? { background: eyeColor } : undefined;
  return (
    <div className={cls}>
      <div className="a-badge">✓</div>
      <div className="a-bubbles"><i/><i/><i/></div>
      <div className="a-antenna-tip"/><div className="a-antenna-pole"/>
      <div className="a-head"><div className="a-visor"><span className="a-eye" style={eye}/><span className="a-eye" style={eye}/></div></div>
      <div className="a-body">
        <div className="a-arm l"/><div className="a-arm r"/>
        <div className="a-leds"><span className="a-led"/><span className="a-led"/><span className="a-led"/></div>
        <div className="a-progress"><i/></div>
      </div>
      <div className="a-legs"><div className="a-leg"><div className="a-leg-u"/><div className="a-foot"/></div><div className="a-leg"><div className="a-leg-u"/><div className="a-foot"/></div></div>
      {label && <div className="a-cap">{label}</div>}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes** — Expected: PASS (2 tests).
- [ ] **Step 5: Commit**

```bash
git add ui/src/onboarding/motion/AgentCharacter.tsx ui/src/onboarding/motion/__tests__/AgentCharacter.test.tsx
git commit -m "feat(onboarding): AgentCharacter with working/thinking/done states"
```

## WS1 — Task 5: LoadingDots component

**Files:**
- Create: `ui/src/onboarding/motion/LoadingDots.tsx`
- Test: `ui/src/onboarding/motion/__tests__/LoadingDots.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { render } from "@testing-library/react";
import { LoadingDots } from "../LoadingDots";
test("reflects state in the wrapper class", () => {
  const { container, rerender } = render(<LoadingDots state="loading" />);
  expect(container.querySelector(".dots.loading")).toBeTruthy();
  rerender(<LoadingDots state="done" />);
  expect(container.querySelector(".dots.done")).toBeTruthy();
});
```

- [ ] **Step 2: Run test to verify it fails** — Expected: FAIL, module not found.
- [ ] **Step 3: Write minimal implementation**

```tsx
// ui/src/onboarding/motion/LoadingDots.tsx
export function LoadingDots({ state }: { state: "idle"|"loading"|"done" }) {
  return <span className={`dots ${state}`}><i/><i/><i/></span>;
}
```

(The `.dots`, `.dots.loading i` bounce/stagger, and `.dots.done i` green-glow rules move into `motion.css` in Task 1.)

- [ ] **Step 4: Run test to verify it passes** — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add ui/src/onboarding/motion/LoadingDots.tsx ui/src/onboarding/motion/__tests__/LoadingDots.test.tsx
git commit -m "feat(onboarding): LoadingDots (red->green) widget"
```

## WS1 — Task 6: Reveal wrapper + barrel

**Files:**
- Create: `ui/src/onboarding/motion/Reveal.tsx`
- Create: `ui/src/onboarding/motion/index.ts`
- Test: `ui/src/onboarding/motion/__tests__/Reveal.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { render } from "@testing-library/react";
import { Reveal } from "../Reveal";
test("renders children and applies a delay style", () => {
  const { getByText, container } = render(<Reveal delay={0.18}>hello</Reveal>);
  expect(getByText("hello")).toBeTruthy();
  expect((container.firstChild as HTMLElement).style.animationDelay).toBe("0.18s");
});
```

- [ ] **Step 2: Run test to verify it fails** — Expected: FAIL, module not found.
- [ ] **Step 3: Write minimal implementation**

```tsx
// ui/src/onboarding/motion/usePrefersReducedMotion.ts
import { useSyncExternalStore } from "react";
const QUERY = "(prefers-reduced-motion: reduce)";
export function usePrefersReducedMotion() {
  return useSyncExternalStore(
    (cb) => { const m = matchMedia(QUERY); m.addEventListener("change", cb); return () => m.removeEventListener("change", cb); },
    () => matchMedia(QUERY).matches,
    () => false,
  );
}

// ui/src/onboarding/motion/Reveal.tsx
import type { ElementType, ReactNode } from "react";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";
export function Reveal({ children, delay = 0, as, inView = false }:
  { children: ReactNode; delay?: number; as?: ElementType; inView?: boolean }) {
  const Tag = as ?? "div";
  const reduce = usePrefersReducedMotion();
  // Reduced motion is decided in JS, NOT CSS (Codex P1: jsdom doesn't apply
  // @media prefers-reduced-motion to computed styles, and a direct component
  // test never loads motion.css — so a CSS-only override is neither reliable
  // nor testable). Render the FINAL visible state, no animation, no opacity:0.
  if (reduce) return <Tag>{children}</Tag>;
  const anim = { opacity: 0, transform: "translateY(24px)", animation: "obd-fadeUp .7s cubic-bezier(.16,.8,.3,1) forwards", animationDelay: `${delay}s` };
  if (!inView) return <Tag style={anim}>{children}</Tag>;
  return <RevealInView Tag={Tag} anim={anim}>{children}</RevealInView>;
}
// RevealInView uses useInView (IntersectionObserver hook) to attach `anim` only
// after the element scrolls into view; before that it renders the hidden start state.
```

- [ ] Add tasks for **`useInView.ts`** (IntersectionObserver hook, `{ once, margin }`) and **`useTypewriter.ts`** (setTimeout char sequencer; **returns the full string immediately when `usePrefersReducedMotion()` is true**), each with its own test — they are in the file list but were previously unimplemented (Codex P1).
- [ ] **Reveal test (now viable):** mock `matchMedia(...).matches = true` and assert the rendered element has **no** inline `opacity:0` (reduced path returns the bare tag). Second test: default path has the `animation`/`opacity:0` start. Third: `as="section"` renders a `<section>`; `inView` defers the animation until the observer fires (mock `IntersectionObserver`).

```ts
// ui/src/onboarding/motion/index.ts
import "./motion.css";
export { AoaLogo } from "./AoaLogo";
export { ConstellationBg } from "./ConstellationBg";
export { AgentCharacter } from "./AgentCharacter";
export { LoadingDots } from "./LoadingDots";
export { Reveal } from "./Reveal";
```

- [ ] **Step 4: Run test to verify it passes** — Expected: PASS.
- [ ] **Step 5: Typecheck + commit**

```bash
pnpm --filter @armyofagents/ui typecheck
git add ui/src/onboarding/motion/Reveal.tsx ui/src/onboarding/motion/index.ts ui/src/onboarding/motion/__tests__/Reveal.test.tsx
git commit -m "feat(onboarding): Reveal fade-up wrapper + motion barrel"
```

**WS1 acceptance:** `pnpm --filter @armyofagents/ui test:run src/onboarding/motion` green; `typecheck` clean; primitives importable from `@/onboarding/motion`.

**WS1 test-depth + robustness (Codex P2):** beyond DOM-existence, add — fake-timer tests for the typewriter cadence + the constellation red-node hop; assertions that `ConstellationBg`/`AoaLoadingWidget` clean up their `rAF`/timeout/listeners on unmount; a mocked canvas 2d context; and an accessible treatment for the logo/agent (an `aria-label` or `role="img"`/decorative `aria-hidden`). `ConstellationBg` should also react to **container** resize via `ResizeObserver` (window-resize alone leaves a stale canvas when only the layout changes), with cleanup.

---

## WS2–WS10 — Outlines (each expands into its own detailed plan when built)

### WS2 — Auth + Splash
- **Files:** modify `ui/src/pages/Auth.tsx` (centered layout; remove `<AsciiArtAnimation/>` split); create `ui/src/onboarding/SplashScreen.tsx` (AoaLogo + ConstellationBg + typewriter "Assembling your workforce…" 55ms/char → fade to auth); wire splash before `/auth`.
- **Splash "first visit" persistence (Codex P2 — specify it):** show once per browser via a `localStorage` flag (e.g. `aoa.splashSeen`); do NOT show on OAuth back-navigation or when an existing session redirects straight through (respect `Auth.tsx:22-48` bfcache/`next` handling). Under reduced-motion, skip the animated sequence and go straight to auth.
- **Reuse:** WS1 primitives; existing `authApi.signInSocial`.
- **Tests:** Auth renders centered single Google button (extend `Auth.test.tsx`); splash shows once then sets the flag; direct `/auth`, OAuth back-nav, and existing-session redirect do NOT replay it; reduced-motion skips straight to auth.
- **Retire:** `ui/src/components/AsciiArtAnimation.tsx` (delete once no importers).

### WS3 — Spine polish
- **Files:** restyle `HumanProfileStep`/`OrgStep`/`CommanderStep`/`EnvironmentStep`/`ReviewStep` in `ui/src/onboarding/steps/` with `Reveal` + stepper chrome; **add CLI-auto-detect verify method** to `VerifyStep.tsx` (poll `internalAgentApi` verify until authed — mirror the existing Codex device-login poll); wire the real `FolderBrowserDialog` into `EnvironmentStep` root-folder field.
- **Reuse:** `FolderBrowserDialog`, existing verify polling in `VerifyStep`.
- **Tests:** extend each step's `__tests__`; new: CLI-auto-detect transitions idle→verified on poll success; folder browse opens dialog and writes the path.

### WS4 — Departments upgrade *(needs WS0a)*
- **Prereq (Codex P2):** first extract `isGitHubRepoUrl` from `NewProjectDialog.tsx:172-184` (function-local, not exported) into a shared validator (e.g. `packages/shared/src/validators/github.ts` or `ui/src/lib/`), and repoint `NewProjectDialog` to it — so onboarding can import it.
- **Files:** `ui/src/onboarding/steps/DepartmentStep.tsx` — replace bare folder text input with `FolderBrowserDialog` + Browse button (gitAware for software), wired to the **WS0a company-scoped filesystem API** (not the instance-admin routes); use the shared `isGitHubRepoUrl` for repo validation; support **multiple departments** (list + "Add department", first = Software). Keep idempotency + mkdir-surfacing (`DepartmentStep.tsx:88-98`) + `REPO_ONLY_CWD_SENTINEL` branching.
- **Partial-failure semantics (Codex P2):** `DepartmentStep` creates the department **before** mkdir/workspace (`DepartmentStep.tsx:66-129`), so a mid-sequence failure can leave a department with no folder/brain/agent. With multiple departments this compounds. Define per-department idempotency + a retry/resume presentation ("Software created, folder failed — retry"), don't fail the whole step silently.
- **Reuse:** `DEPARTMENT_FUNCTION_TYPES` (`constants.ts:1445`), `FolderBrowserDialog` (with WS0a scoped-api prop), shared `isGitHubRepoUrl`.
- **Tests:** multi-department add/remove; software shows folder+repo, non-software hides them; invalid GitHub URL blocks continue; browse/mkdir succeed for a non-admin company member (via WS0a); a mid-sequence mkdir failure leaves a retryable state, not a broken department; existing idempotency tests still pass.

### WS5 — Integrations step (GitHub)
- **Files:** create `ui/src/onboarding/steps/IntegrationsStep.tsx` + registry entry (order between Departments and Braindump, `journeys:["founder"]`, `shouldInclude` = any software dept). GitHub card with two modes: **Connect (App/auth)** → drive existing `server/src/routes/github.ts` install/`github_installations` flow; **paste URL** → public. Extensible list scaffold (plugins placeholder, disabled).
- **Codex caveats to handle:** (a) the install **callback always redirects to Settings** (`github.ts:737-792`). To land back on onboarding, **extend the signed `state` payload** (`github-app.ts:20-34`) with an onboarding return target and **allowlist it to internal routes** — do NOT accept a free-form/unsigned `return` query param (open-redirect + callback could detach from the intended company; Codex P1). (b) The GitHub **App requires server env config** — install-url already returns **503** when unconfigured (`github.ts:749-792`); surface that as a graceful "GitHub App not set up on this instance; use paste-URL" fallback, not a broken button. (c) `company_secrets.github_pat` is a **named generic secret row**, not a column (`company_secrets.ts:7-35`) — read/write it as a secret.
- **Reuse:** `github.ts` install/callback/status/repo-list, `github_installations` (`schema:13-31`).
- **Tests:** step renders GitHub card; paste-URL path validates via shared `isGitHubRepoUrl`; connect path initiates install with the onboarding return param (mock the API); App-not-configured shows the paste-URL fallback; non-software company skips the step (`shouldInclude` false).

### WS6 — Librarian + Memory Library *(net-new core; heaviest WS)*

**Decision (overriding Codex P1-3):** the Librarian is a **genuinely separate, general-purpose knowledge-organizing agent** — reusable beyond onboarding — NOT a trigger on Memory Keeper (which stays discussion-pipeline-bound). This is a product call: we accept the extra registration cost for a first-class reusable agent. That makes the following non-optional.

**A registered new crew role — not just a seeder (Codex P1-5).** Adding `librarian` touches every crew registry:
- `server/src/services/internal-agent/aoa-agents/seed-crew-agent.ts:53-68,260-267` — `instructionBundleRole` must accept `librarian` (+ ship an **instruction asset bundle** for it, like the other roles). Codex re-review P2: the bundle wiring also touches `seed-commander-bundle.ts` and `default-agent-instructions.ts` — audit both and add `librarian` where the other roles appear, not just `seed-crew-agent.ts`.
- `server/src/services/internal-agent/aoa-agents/autonomy.ts:14-45` — add `librarian` to the role union + autonomy map. **Decide + document (Codex P2):** its **minimum autonomy level**, exact **trigger kind/source** (braindump ingestion, not mention/sweep), **payload cap**, and **tool allowlist** — the registry tests are only meaningful once these are fixed.
- `server/src/services/internal-agent/aoa-agents/aoa-trigger-prompt.ts:44-55` — register its trigger prompt.
- Create `server/src/services/internal-agent/aoa-agents/ensure-librarian.ts` and add it to the `ensure-all-crew.ts` roster.

**Marketplace package — a real cross-repo deliverable (Codex P1-6).** "Marketplace-managed" means a company has an `aoa` agent whose `templateOrigin` does NOT end in `@legacy` (`ensure-all-crew.ts:20-33`); legacy hard-coded seeders get a synthetic `…@legacy` origin (`backfill-template-origin.ts:44`) and are **skipped** for marketplace-managed companies. So `ensure-librarian.ts` alone covers ONLY legacy companies — marketplace-managed ones never get the Librarian unless it's in the catalog. Two coverage paths, both required:

- **This repo (legacy path) — the `@legacy` origin isn't automatic (Codex re-review P1).** `seedCrewAgent` currently inserts **no** `templateOrigin` (`seed-crew-agent.ts:94-115`), and the backfill's `CREW_NAMES` is a **closed list without Librarian** (`backfill-template-origin.ts:29-52`). So `ensure-librarian.ts` alone won't produce the promised origin. Fix one of: extend `seedCrewAgent` to stamp the origin, OR add `Librarian` to `CREW_NAMES`. Cover both new and pre-existing rows.
- **`aoa-marketplace-cdn` repo (SEPARATE — `https://github.com/MeteoriteLabs/aoa-marketplace-cdn`; published catalog `…github.io/aoa-marketplace-cdn/catalog.json`):** add the **Librarian to the standard AoA crew `team` package** (a `type:"agent"` member, `templateOrigin` `aoa-curated/standard-crew/librarian`, NOT `@legacy`). PR against that repo, **linked to this work as an explicit gate**. No schema bump (Decision #96), catalog data only.
- **Reconcile for EXISTING marketplace-managed companies (Codex re-review P1).** `checkCrewUpdates` iterates only **already-installed** agents (`marketplace-install/crew-updater.ts:121-156`) — adding a new team member to the CDN will **not** create the missing Librarian on companies that already installed the crew. Add explicit **team-package reconciliation / member-add-on-update** semantics (detect roster delta → install the new member), or a one-time reconcile pass. This is the subtle part — test it directly.
- **Snapshot fallback:** after the CDN PR lands, `pnpm fetch-catalog` → regenerate `ui/src/aoa-marketplace-snapshot.json`. Until the CDN + snapshot both contain the Librarian, **feature-gate** the Librarian onboarding step so it doesn't reference a not-yet-shipped agent (Codex: the CDN dependency is a real sequencing gate, WS6 is NOT locally shippable without it).
- **Tests:** legacy company gets exactly one Librarian with the `@legacy` origin (new + pre-existing rows); a marketplace-managed company that **already installed** the crew gets the Librarian added on the reconcile/update path; fresh marketplace install includes it; no duplicate across paths.

**Memory-write boundary (corrected — Codex re-review).** Earlier draft said "don't use `writeMemoryAndIndex`" — that was wrong. `writeMemoryAndIndex` (`memory-write.ts:131-160`) **delegates to `memoryService.create`** (`memory.ts:290-307`), which forces agent-origin items to `status:"pending"`, validates `layer`/`sourceContext`, and enqueues the embedding. So **either is safe with `source:"agent"`; prefer `writeMemoryAndIndex` for its documented indexing contract.** The invariant to hold: proposals are written as `source:"agent"`, `layer:"domain"`, with `sourceContext` (department + braindump linkage) → they land `pending`.
- **Inline founder approval** in `LibrarianStep` calls the existing **authenticated approval route** (`server/src/routes/memory.ts:466-508`, which applies founder/domain authz + activity-logging), not a raw write. (`assertCrewMemoryWrite` at `ensure-command-staff.ts:274-286` has no prod call sites — not the guard.)

**Durable braindump ingestion contract (Codex P1).** Define real infrastructure, not a hand-wave:
- **Capture:** a per-department braindump record (new table or reuse a discussion-entry-like row) keyed by `(companyId, departmentId, idempotencyKey)`, with content-size limits.
- **Dispatch:** on submit, enqueue a Librarian run over each dump via the crew dispatcher (`runAoaAgent`), passing a structured payload (departmentId + dump ref). Decide + document **whether the Librarian extracts via its own tools or the server invokes the extraction engine** (`server/src/services/extraction.ts:189-195,310-378`) and hands the Librarian structured candidates — pick one and specify it.
- **Status machine + resume:** `pending → running → proposed → (approved|failed)`, deduped on the idempotency key so a reload/retry doesn't double-run or double-propose; a failed/no-engine run surfaces actionable copy (mirror the discussion-extraction failure UX), never a silent hang.
- **Tests:** dump → dispatch → proposals scoped to the right department; retry is idempotent; no-CLI/extraction-failure shows the failure state + retry.

**Braindump ingestion.** Add a per-department braindump capture + a trigger that dispatches the Librarian (via the crew dispatcher / `runAoaAgent`) over each dump, reusing the extraction engine (`server/src/services/extraction*.ts`) to produce candidate `domain` items scoped to that department.

- **UI files:** `ui/src/onboarding/steps/BraindumpStep.tsx` (per-department boxes; Software pre-shows connected repo) + `LibrarianStep.tsx` (`AgentCharacter` thinking→done while extracting; list proposed `domain` items; inline approve via the authenticated approval path).
- **Tests:** `librarian` accepted by `instructionBundleRole`/autonomy/trigger registries; `ensure-librarian` seeds idempotently + appears in BOTH legacy and marketplace-managed rosters; braindump → `memoryService.create(source:"agent", layer:"domain", sourceContext:…)` yields `status:"pending"` items scoped to the right department; inline approve uses the founder approval route and enqueues embedding; reduced-motion Librarian snaps to done. **DB:** any new columns via `pnpm db:generate` (Drizzle only — no raw SQL).
- **Gate:** highest-risk WS (new role across registries + memory-write semantics + marketplace coordination) — its own dedicated Codex pass before implementation.

### WS7 — Create-agent step
- **Files:** `ui/src/onboarding/steps/AgentStep.tsx` — surface the real create form (name, purpose, **adapter** via `AgentConfigForm` controls) per department, **plus** a "pick from marketplace" path.
- **Codex P1 — the marketplace path is more than "open `SnapshotInstallModal`":** that modal (`SnapshotInstallModal.tsx:35-62,81-99,146-147`) requires an already-selected `CatalogItem`, exposes **no `deptId` prop**, derives a **mutable company** selection, and **clears department whenever company changes**. So this WS must: (a) add an inline **catalog picker** (browse `agent`/`team` items) to choose the item first, and (b) **extend the modal's API to lock BOTH `companyId` AND `deptId`** (preselected + non-editable) — locking dept alone is unsafe because a changeable company would invalidate or cross-target the department (Codex: cross-company risk).
- **Reuse:** `AgentConfigForm`, `AGENT_ADAPTER_TYPES` (`constants.ts:38`), the marketplace catalog list + `SnapshotInstallModal`/`CascadeTreePreview` (with the new `deptId` prop), `agentsApi`. Keep auto-assign to department (`projectsApi.assignAgent`).
- **Tests:** create-form path creates + assigns an org agent with chosen adapter; catalog-pick → install path opens with the locked deptId and installs into the right department; idempotent reuse of same-name agent preserved.

### WS8 — First-job step
- **Files:** create `ui/src/onboarding/steps/FirstJobStep.tsx` — side-by-side **Create task** (title + assignee = new agent) / **Start discussion**; **Skip to Home**. (Side-by-side vs two-step layout finalized during build — Decision #13.)
- **Reuse:** existing task-create + discussion-create APIs/dialogs.
- **Tests:** task path creates a task assigned to the agent; discussion path creates a thread; skip advances without creating; step is skippable (no required fields).

### WS9 — The Map + Home first-run *(net-new surface; needs WS0b)*
- **Files:** create `ui/src/onboarding/motion/DrawOnMap.tsx` (the deferred WS1 primitive — SVG edges draw via `pathLength`/CSS `stroke-dashoffset`, depth-staggered) + `ui/src/onboarding/Map.tsx` (nodes: human=white/red, agent=dark/zinc, memory=indigo; door band under it) + `MiniMap.tsx` (read-only, for WS10); integrate into `ui/src/pages/Dashboard.tsx` first-run branch.
- **Persona persistence (Codex re-review P2):** clicking a door writes **`firstRunPersona`** (the WS0b field) via the onboarding-progress/home API — In-flight vs Explorer must survive a reload/resume, not just live in component state. Completion (`firstRunCompletedAt`) is set separately when the founder reaches Home. Define the write endpoint here (extend the onboarding-progress update route).
- **Gating (Codex P1-1 corrected):** first-run vs steady-Home is gated on the **WS0b `firstRunCompleted` flag**, NOT the vision+dept+agent+goal checklist (which never completes for our flows). `setupStatus` itself stays a **computed** response — no schema change here (the schema lives in WS0b). The Map/doors relax into the existing Getting-Started card once the flag is set.
- **Reuse:** Dashboard Getting-Started checklist scaffolding; `OrgHierarchyChart` draw-on grammar as reference.
- **Tests:** Map renders all nodes + edges; door band routes In-flight/Explorer and records the persona; Home flips to steady-state when `firstRunCompleted` is set (even with no goal); reduced-motion draws instantly.

### WS10 — Invited + Returning
- **Scope decision (Codex P1 — invited "own engine" is architecturally incompatible with v1):** Commander config + provider creds are **company-scoped, not per-human** (`internal_agent.ts:20-24,137-140`), and invited progress terminates at `JOIN_REQUESTED` (`onboarding.ts:53-59`). Reusing founder verify would inspect/overwrite the *company's* Commander, not authenticate the teammate's own CLI. **So v1 invited teammates DO NOT set up an engine** — the per-user runtime/auth model (per-human Commander credentials + new post-approval continuation states) is a **separate deployment-pass initiative**, not this project. Invited flow = profile → mini-Map → Home.
- **Files:** `ui/src/pages/OnboardingFlow.tsx` invited path → `MiniMap` "the machine you're joining" → Home; confirm Returning lands on Dashboard steady-state with pending-invite cards (likely no change).
- **Reuse:** `InviteLanding`, `InvitedJoinTerminal`, `MiniMap`.
- **Tests:** invited runs profile → mini-Map → Home (no engine step); returning shows pending-invite cards + steady-state Home.

---

## Self-review

- **Spec coverage:** every spec §7 screen maps to a WS (S0/S1→WS2; S2–S5→WS3; S6→WS9; S7a→WS4; S7b→WS5; S7c/S7d→WS6; S7e→WS7; S7f→WS8; S8→WS9; I1/I3/I4→WS10; R1→WS10). Every §5 gap is assigned (G13→WS1; G12→WS2; G1/G2→WS4; G3→WS5; G6/G7/G8→WS6; G5→WS7; G10→WS8; G9→WS9; **G4→WS0a (pulled into v1, not deferred); G11→WS0b (persona flag)**).
- **Codex round-1 findings addressed:** P1 filesystem authz→**WS0a**; P1 first-run gate→**WS0b**; P1 Librarian-vs-Memory-Keeper→product decision to keep separate + full role registration + marketplace package in **WS6**; P1 memory-write boundary→**WS6** (`memoryService.create source:"agent"`); P1 `SnapshotInstallModal` not-a-picker→**WS7** (catalog pick + `deptId` API); P1 portalled-dialog theming→**Decisions**; P2 `isGitHubRepoUrl` export→**WS4**; P2 GitHub callback/env/PAT→**WS5**; P2 CSS-only motion→**WS1** controllers + DrawOnMap→**WS9**; P2 G11 mis-tag→**WS0b**.
- **Codex thorough-round findings addressed:** state-machine-is-real→**WS0c**; new steps need OnboardingState values→**WS0c**; invited-engine incompatible→**WS10** (dropped from v1); WS0a missing home/drives + jail-vs-existing-work→**WS0a** (deployment-split, all 4 ops, hardening); WS0b backfill-mechanism + write authz→**WS0b**; WS1 hooks + reduced-motion-in-JS + portal theming→**WS1/Decisions**; braindump ingestion contract→**WS6**; `writeMemoryAndIndex` claim was wrong→**WS6** (corrected); marketplace convergence/reconcile + legacy origin roster→**WS6**; WS7 lock company+dept→**WS7**; CDN gate→**WS6**; GitHub signed-state open-redirect→**WS5**; P2s (splash persistence, multi-dept partial-failure, Librarian autonomy/trigger, constellation ResizeObserver, test depth) folded into WS2/WS4/WS6/WS1.
- **Placeholders:** WS1 tasks contain full code; the `.agent*` CSS block is explicitly sourced from the validated mockup. WS0 + WS2–WS10 are outlines by design (skill's decomposition guidance) — each is expanded to bite-sized form before it is built.
- **Type consistency:** motion prop names (`state`, `eyeColor`, `size`, `label`, `delay`, `hideDot`) are consistent across WS1 and referenced identically in WS6/WS9.
- **Risk callouts:** **WS0a** (jailed filesystem authz — tenant-isolation critical), **WS5** (GitHub App infra nuances), and **WS6** (new crew role across registries + memory-write semantics + marketplace coordination) are highest-risk and get dedicated Codex passes before implementation.
