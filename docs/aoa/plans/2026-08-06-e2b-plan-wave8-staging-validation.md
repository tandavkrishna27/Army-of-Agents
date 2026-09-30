# E2B Cloud Execution Isolation — Implementation Plan (Wave 8: Staging validation & live user-flow verification)

> **For agentic workers:** this wave runs AFTER Waves 0–7 are built and their unit/integration/fake-provider tests are green. It is the **live gate**: prove the system actually works against **real E2B** with real user flows, and prove the security invariants on a real VM. Use the `/browse` skill (gstack) for the browser E2E steps.
>
> **Spec:** `docs/aoa/plans/2026-08-05-cloud-execution-isolation-e2b-spec.md`. **Shared seams:** the INDEX.

---

## Wave 8 — Staging validation & live user-flow verification

**Goal:** close the one gap unit/integration/fake-provider tests can't cover — that the whole thing **works end-to-end against real E2B** with real founder flows, real tenant isolation, and the never-in-VM invariants proven inside a real sandbox. This is the definition-of-done for "cloud actually works," not just "CI green."

**Why it's a separate wave:** real Firecracker microVMs can't run in CI, and the execution path is `cloud_auth`-gated (inert on `local_trusted`). So this is a **manual/scripted staging pass** against a live instance + real E2B — documented here so it is never silently skipped.

**Prerequisite (external):** a **real E2B** — a managed E2B account (`E2B_API_KEY`), or a self-hosted E2B box (`E2B_DOMAIN` + key). The founder is setting this up.

---

### Part A — Staging setup

**A1. Bring up a `cloud_auth` staging instance.**
- `deploymentMode = cloud_auth` (multi-tenant; `tenantIsolationEnforced()` true), a real Postgres, a real secrets master key, `AOA_AGENT_JWT_SECRET`/`BETTER_AUTH_SECRET` set.
- Set the operator-level E2B (U1 platform default): `E2B_API_KEY` (managed) **or** `E2B_DOMAIN`+key (self-hosted). Confirm `AOA_ALLOW_UNSANDBOXED_MULTITENANT` is **unset** (so the D1 guard is live).
- Can be a local process in `cloud_auth` mode pointed at real E2B (reuse the isolated-instance pattern: detached worktree, worktree-local `.aoa/config.json`, `PORT`), or a deployed staging box.

**A2. Seed two tenants (for cross-tenant isolation).**
- Org A → Company A; Org B → Company B. Each company adds **its own** provider API key (Anthropic/OpenAI) via **Settings → Providers** (the U12 BYO-key flow). Do **not** set an operator `~/.claude`-derived key for the tenants.

---

### Part B — Live user-flow checklist (the "does it actually work" proof)

Run each on the real instance; the **Expected** column is the pass condition. Any failure blocks ship.

| # | Flow | Expected |
|---|---|---|
| B1 | **BYO-key readiness** — Company A adds its key, hits "Verify" (Settings → Providers / onboarding) | Readiness probe (U13) runs in a **real E2B sandbox** and returns pass — **not** `readiness_unavailable_on_cloud` |
| B2 | **Commander** — open Commander, ask a question | Responds; the run executed in a real E2B sandbox (U4) and reached the DB via the **broker** (U2), not a local bridge |
| B3 | **Crew** — dispatch a crew agent (e.g. a Librarian memory task) | Runs in a real ephemeral sandbox; writes memory via the broker; loops the result back to its thread (W3a) |
| B4 | **Org agent** — assign an org agent a task | Runs in E2B; produces output; run-summary comment posts with token/cost populated |
| B5 | **Discussion → task** (launch-critical) — create a discussion, add entries, let Adjutant scope | Extraction (U13) runs in a sandbox → scope draft → crew dispatch → **a real task is created**. (Fails today on cloud without U13.) |
| B6 | **Software-dev PR** — an org `software_development` agent edits a repo | Diff captured from the VM; **host opens a PR** (U6); the PR appears in GitHub |
| B7 | **Crew artifact capture** — a crew agent produces a file/doc | Captured to `task_outputs` as `detected_file` with `reviewState: needs_review` (Decision #67); visible in the task viewer |
| B8 | **Preview URL** — a software-dev agent starts a dev server | The sandbox port resolves to a preview URL (E2B `getHost`, D4) that loads in the browser |
| B9 | **Plugin** — a sandboxed agent invokes a plugin tool | Routed through the broker to the **host-resident** worker (U10); returns a result; worker never entered the VM |
| B10 | **stdio connector** — attach an npx-style connector (e.g. Notion-local) to a crew agent | Runs **inside the sandbox** (U11); a connector tool call succeeds |
| B11 | **HTTP/OAuth connector** — attach the Notion-hosted OAuth connector | Token injected into the VM env; tool call works; a forced token expiry refreshes **host-side** and the next run still authenticates |
| B12 | **Warm reuse** — run a software-dev agent twice | 2nd run **resumes** the paused sandbox fast (U7); a background crew agent stays **ephemeral** (fresh each run) |
| B13 | **Compaction** — hold a long Commander conversation | Compaction (U13 summarizer) runs in a sandbox; `summarizedContext` advances; no context overflow |

---

### Part C — Live security invariants (prove on a real VM)

- **C1 Never-in-VM:** run a diagnostic agent whose task dumps its process env (and reads the staged `--mcp-config` file) inside a real sandbox → assert **absent**: `DATABASE_URL`/`DIRECT_DATABASE_URL`, the secrets master key, `GITHUB_PAT`, `CLAUDE_CODE_OAUTH_TOKEN`, host-ambient `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` (embeddings), operator `~/.claude`. This is the S7/§9 invariant proven live (a green CI test is not enough here).
- **C2 Cross-tenant isolation:** from Company A's sandboxed run, attempt to read Company B's memory/tasks via the broker → **denied** (the run-JWT scopes to Company A). Confirms the data plane holds under real execution.
- **C3 Egress reality:** confirm the VM can reach the broker + model API + git/npm + the company's connector hosts, and note (per §12) that on **managed** E2B egress may be open — record the actual posture for the self-hosted decision.

---

### Part D — Browser E2E (Playwright / `/browse`)

Add/scripted browser checks for the UI-facing pieces (the parts pure server tests miss):
- **D1** Settings → Providers: paste an API key → validated state (drives B1's UI).
- **D2** Task viewer: a crew/org run's captured files appear as `task_outputs`; the **preview-URL** link opens (drives B7/B8's UI).
- **D3** Commander: streams a response on cloud (drives B2's UI).

---

### Part E — Deployment-mode regression (don't break desktop)

- **E1** Run B2–B7's equivalents on a **`local_trusted`** instance → agents run on the host via the local CLI (stdio bridge, **no E2B**), exactly as before. Proves the sandbox-scoping rule (§13) held and desktop is **unregressed**.
- **E2** Confirm subscription **login-through-URL** still works on `local_trusted` (Settings → Providers) and is **disabled** on the shared cloud pool (`cli-auth-topology`).

---

**Wave 8 exit criteria (= ship gate):**
- All of B1–B13 pass on **real E2B**.
- C1 (never-in-VM) and C2 (cross-tenant) proven **live** on a real sandbox; C3 egress posture recorded.
- D1–D3 browser flows green.
- E1–E2: `local_trusted` desktop flows **unchanged** (no regression).
- **Prerequisite for W7's own exit:** add a **fake-provider post-flip integration test** in W7 (a full org+crew+Commander sandbox dispatch succeeds after the D1-guard flip) so CI catches guard-flip regressions without waiting for this manual pass.

Only when Wave 8 is green is the cloud execution-isolation feature actually **done**.
