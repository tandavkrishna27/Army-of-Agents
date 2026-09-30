# Multi-Tenant Cloud — Follow-up Branch HANDOFF

**Written:** 2026-08-02. **For:** the next session that takes the deferred multi-tenant-cloud work forward as the NEXT PR (the "fix all the remaining bugs" follow-up).

---

## 1. Where things stand (read this first)

- **PR #316** = the multi-tenant cloud control plane. Branch **`claude/multitenant-cloud`**, worktree **`C:/Users/TK/.aoa/wt/mt-cloud`** (a detached worktree at a SHORT path — required so embedded-Postgres `initdb` doesn't hit the Windows MAX_PATH limit under the deep OneDrive checkout).
- **Remote HEAD = `1eb61ec7`.** Required Linux checks are green on that committed head and the PR is mergeable; the advisory LLM evaluation is failed/non-required. The newer pre-landing audit fixes are still an uncommitted local working tree and therefore have no fresh Linux CI evidence. **Do not merge until they are committed/pushed and the new required checks pass.**
- **Current local audit:** the P1–P5 control plane and later audit fixes are represented in the dirty worktree. Recursive typecheck, the final clean full test rerun, build, forbidden-token scan, db no-drift, and diff hygiene pass locally; independent security, scope/API, architecture, and runtime-lifecycle passes report no remaining P1/P2. The authoritative findings and incomplete external gates are in `2026-08-02-pr316-final-prelanding-audit-plan.md`.

### Branch strategy for the follow-up
The follow-up is a **SEPARATE, FRESH branch**, NOT stacked on `claude/multitenant-cloud`.
- **Preferred:** land #316 to `main` first, then branch the follow-up off `main`.
- If starting before #316 merges: branch off `claude/multitenant-cloud`, but be ready to rebase onto `main` once #316 lands.
- Reuse the same detached-worktree-at-short-path pattern (`.aoa/wt/<name>`) — see the memory file `windows-embedded-pg-maxpath-boot.md` / `qa-isolated-main-instance.md`.

---

## 2. Existing specs to READ before planning (the deferred work is already partly designed)

| Doc | Covers |
|-----|--------|
| `docs/architecture/decisions.md` §117 | Execution-target registry, hardened gVisor sandbox, route-by-credential, per-org concurrency clamp. THE locked design for Initiative 1. |
| `docs/aoa/plans/2026-07-29-aoa-multitenant-cloud-master-scope.md` | Master scope + the D-decisions (D1 unsandboxed guard, D6 hire-approval, D8 break-glass, etc.). |
| `docs/aoa/plans/2026-07-29-aoa-mt-phase5-execution-gvisor.md` | The gVisor/execution-isolation phase plan (Initiative 1). |
| `docs/aoa/plans/2026-07-29-aoa-mt-phase3-authz-isolation.md` | AuthZ/isolation phase (org membership, break-glass, D1). |
| `docs/aoa/guides/gvisor-worker-image.md` | The runsc worker-image spec — **has a "SPEC ONLY — NOT YET VALIDATED ON HARDWARE" banner + 4 UNRUN checkpoints A/B/C/D.** A cloud pool on `bridge` is unshippable until checkpoint D passes on real hardware (Gate-B). |
| `docs/deploy/database.md` | Multi-replica migration topology note (added by batch-4). |
| The 4 review-batch plans in `docs/aoa/plans/2026-08-0{1,2}-*.md` | The already-shipped fixes (context, not new work). |

---

## 3. The follow-up scope — all remaining/deferred work ("the bugs to fix here")

Grouped by initiative. Each item: **[origin]** file:line — what + why + status.

### Initiative 1 — Real gVisor execution isolation (the headline; spec: phase5-gvisor + gvisor-worker-image + Decision #117)
Today P5 org runtime is **intentionally INERT** (schema + fail-closed D1 guard shipped; no pool executes tenant runs). This initiative makes it real.
- **Multi-worker `GvisorPoolClient` + runsc pool + worker transport.** The `createGvisorSandboxRuntimeProvider` seam exists (`server/src/services/gvisor-sandbox-provider.ts`) but no pool client. `worker_token_hash` auth is DONE (migration 0194, hashed token); the pool that consumes it is deferred.
- **Move the whole workspace lifecycle across the worker boundary.** The provider/worker protocol must cover provision, teardown/cleanup, one-shot jobs, and runtime services—not only the final adapter process. #316 now refuses these local command sinks in `cloud_auth`; the follow-up must not weaken that cutover invariant.
- **Task 0 hardware spike (Gate-B):** run the 4 checkpoints in `gvisor-worker-image.md` (A: runsc present w/o nested virt; B: pinned `claude`/`codex` CLIs survive under runsc; C: hardened flags don't starve Node; D: filtered `bridge` reaches provider API but NOT metadata/RFC1918/control-plane). **D must pass on real hardware before any cloud pool ships.**
- **Docker sink clamps are already fixed locally in #316:** multi-tenant hardening forces removal, `network: none`, and fixed memory/CPU/PID ceilings. The follow-up must preserve these invariants in the real worker transport rather than reimplementing the old deferred task.

### Initiative 2 — agent→org-threading + `org_default` provider runtime (spec: master-scope + phase3)
Today `org_default` provider assignments are **inert** (no row can exist; all credential callers pass `organizationId: null` by design).
- **[bot P2-latent] Thread the real organizationId before credential lookup — in ALL THREE callers uniformly:** `server/src/services/internal-agent/aoa-agents/runner.ts:~578` (crew), `server/src/services/heartbeat.ts:~3210` (org agent), `server/src/services/internal-agent/cli-mode.ts:~738` (Commander). Each currently hardcodes `organizationId: null` with a "follow-up" comment. Resolve `agent.companyId → companies.organizationId` before the resolver so `org_default` assignments activate. **Fix all three together** — fixing only crew re-creates the false "inconsistency" a reviewer flagged.
- **Provider create/assign API** — the gating dependency: `server/src/routes/provider-connections.ts` only lists/verifies/revokes; no endpoint mints a `provider_assignments` row (org_default / company_default / agent_override). Build it (RBAC: founder for org_default). Without it, Initiative-2's org-threading activates a still-empty scope.
- **Per-org concurrency is already fixed locally in #316:** atomic advisory-lock claims and oldest-first cross-agent promotion are wired for `cloud_auth`. The follow-up consumes this behavior; it is not an open implementation task.

### Initiative 3 — URL-namespace multi-org UX
- Replace the bare `/issues/:id…` routes (feedback, output-detection, task-outputs, artifacts, activity, agents live/active-run, issues) with **company-qualified `/companies/:companyId/issues/:id`** routes. This is the real fix for the cross-org identifier ambiguity. The interim SAFE fixes already shipped on #316: `getByIdentifier` actor-scoping + reject-ambiguous 409 + the normalizer `notFound(404)` on identifier-shaped miss + the `getById` UUID guard. This initiative is route-contract + frontend work.
- #316 also temporarily restores **global** `companies.issue_prefix` uniqueness because the current board namespace is `/:companyPrefix/*`; otherwise a user in two Organizations can be routed to the wrong accessible company. Once company-ID-qualified routing ships, relax the index back to `(organization_id, issue_prefix)`.
- Direct `main` → #316 upgrades are safe because `main` already enforces global prefix uniqueness and the complete migration chain runs before the new server starts. Any disposable QA/preview database that ran an intermediate, unmerged #316 head between migrations 0188 and 0196 must check `SELECT issue_prefix, count(*) FROM companies GROUP BY issue_prefix HAVING count(*) > 1;` before applying 0197. If it returns rows, rebuild that preview DB or deliberately rename the colliding prefixes before migration; do not silently rewrite identifiers or shared links.

### Initiative 4 — Migration / deploy hardening
- **[audit A2-deferred] Drop the 0188 sentinel `organization_id` default (fail-closed)** — `packages/db/src/schema/companies.ts:15` `.notNull().default("00000000-0000-0000-0000-000000000001")`. It's fail-OPEN (an insert omitting `organization_id` silently buckets into the sentinel org). Prereq: audit EVERY company-insert path to set `organization_id` explicitly (the create path now does via `createWithOperator`; check seed/portability/test paths), THEN drop the default via a migration so a NULL fails the NOT NULL constraint. A tracking comment is already at that schema line (batch-4).
- **(Optional) Migration backfills → boot reconcilers** — the strict alternative to the documented C14 hand-edit exception (0189/0195 hand-append backfills + idempotency guards, which drizzle-kit can't emit). Only do this if you want to eliminate the exception entirely; the documented exception (synced across CLAUDE.md/AGENTS.md/Decision #19) is currently the accepted posture.

### Initiative 5 — Governed break-glass (spec: D8 in master-scope)
- Today ONLY `sweepExpired` + the REST `hasActiveBreakGlass` read are wired; **grant/revoke have no endpoint** (marked deferred/inert with a defensive comment in `server/src/services/operator-break-glass.ts`). If you build grant/revoke endpoints, you MUST also: (1) wrap `grant()`'s insert + `materializeMembership` + `audit` in ONE `db.transaction` (it's currently non-transactional); (2) make REST and BOTH cookie-auth WS upgrade paths (`live-events-ws.ts`, `upgrade-auth.ts`) share ONE access decision — the WS paths don't consult the grant today; (3) `materializeMembership` currently creates only an ORG membership — break-glass would also need the COMPANY membership the WS branches require.

### Initiative 6 — Non-blocking hardening / cleanups (small, do opportunistically)
- **[bot, defense-in-depth] WS agent-socket mid-session revocation** — the batch-4 membership sweep (`live-events-ws.ts`) re-validates BOARD sockets only; AGENT sockets are handshake-checked only (terminated/pending), not re-validated mid-session. Add agent-status re-validation to the sweep if agent mid-session revocation matters.
- **DRY the active-org∩company invariant** — it now has ~4 implementations (`middleware/auth.ts`, `services/upgrade-auth.ts`, `routes/authz.ts`, and `live-events-ws.ts::hasActiveCloudMembership`). Consolidate into one helper.
- **assignment↔connection org/company DB constraint** — latent (the backfill is the only writer today, always stamps matching tenant). Add the DB constraint so a future writer can't diverge.
- **2 stale prose comments** — `routes/companies.ts:343` + `internal-agent/aoa-agents/ensure-commander.ts:217` still say `svc.create()` where it's now `createWithOperator` (functional claim still true; cosmetic).
- **Cross-tenant RBAC invariant sweep** — a systematic pass asserting every mutating route re-authorizes on the resolved company (my audit found IDOR/authz clean, but a codified invariant test would prevent regressions).

### Required before production (NOT a code fix — a QA gate)
- **Live 2-account cloud_auth browser test on QA/staging.** The safety-gated `AOA_E2E_TEST_SUPPORT` mint makes local two-identity authorization and isolation testing possible on a private loopback test instance. Deploy `cloud_auth` to QA/staging to validate the real Google OAuth signup/callback and walk the browser journey with TWO real accounts and orgs (signup → create org → create company → invite → cross-tenant isolation checks).

---

## 4. How to work in this repo (operational)

- **Worktree:** `C:/Users/TK/.aoa/wt/mt-cloud`. Run everything from there.
- **Server tests:** server has NO `test` script — from the worktree root run `pnpm test:run <pattern>` (vitest). The `a|b` positional is a SUBSTRING filter, not regex — pass multiple patterns as separate args.
- **Typecheck:** `pnpm -r typecheck`. **Brand/tokens:** `node scripts/check-forbidden-tokens.mjs` (bans undocumented `AOA_*` literals in `server/src` — import the constant instead). **DB no-drift:** `pnpm db:generate` then `git status` (should add no migration).
- **Integration tests** (`*.integration.test.ts`) are `describe.skipIf(process.platform !== "linux")` (embedded-PG + committed `initdbFlags`). To run one locally on Windows: flip to `skipIf(false)`, run, **then REVERT to `process.platform !== "linux"` before committing.**
- **`live-events-ws.ts` is git-flagged BINARY** (a pre-existing NUL byte in a comment, also on main). Edits work; verify by READING the file, not `git diff`.
- **Known Windows full-suite flakes** (ignore — they pass in isolation, none are real): `adapter-opencode-local` `execute-*` subprocess tests (80–120s under parallel load) + the `*-routes-contract` factory-import tests (`discussions-routes-contract`, `routines-routes-contract`). ALWAYS re-run a suspected flake in isolation before treating it as real; a signature-change that breaks a call-arg assertion (e.g. `.toHaveBeenCalledWith`) IS real — grep `<fn>).toHaveBeenCalledWith` after any signature change.
- **CI:** `verify` runs ~45–50 min (timeout bumped to 60 in batch-3, `pr.yml:365`). Pushing supersedes an in-progress run. **Linux CI is the authoritative gate** — Windows local skips integration + e2e.
- **Migrations:** Drizzle only (`packages/db/src/schema/`, `pnpm db:generate`). The C14 exception (hand-appended idempotency guards + data backfills, e.g. 0189/0195) is documented in CLAUDE.md/AGENTS.md/Decision #19 — don't re-flag it.

### Established fix patterns (reuse these — they're proven)
- **Every local command sink fails closed on cloud:** `assertUnsandboxedMultitenantAllowed` covers agent/crew/Commander/probes, all local Docker shapes (a `runsc` string is not provenance), workspace provision/cleanup/jobs, and local runtime services. Startup reaps identity-matched legacy runtime PIDs before restart and blocks cloud boot on an unverifiable live PID. Tracked runtime identity is persisted before readiness; stops wait/escalate/confirm the process group and retain active unhealthy tracking on any unconfirmed cleanup. Provider sandboxes remain allowed; self-hosted remains unchanged.
- **Atomic multi-step write:** mirror `createSelfServeOrganization` (`services/organizations.ts`) / `createWithOperator` (`services/companies.ts`) — insert + access-write in one `db.transaction`, unique-key retry OUTSIDE, best-effort seeders AFTER, bind the access service to the tx handle.
- **Advisory lock for concurrent-replica safety:** `pg_advisory_lock(hashtext('aoa:<name>'))` (see `client.ts` migrator + `first-user-bootstrap.ts`).
- **The skills workflow that's been working:** writing-plans → plan-review (a code-reviewer agent — it has caught a load-bearing must-fix in EVERY batch) → subagent-driven-development (fresh implementer per task + spec + quality review) → full local suite (real exit capture, NOT piped through `tail`) → holistic review → push → PR comment + `@codex review`. For a whole-codebase audit, use a Workflow (6 dimensions × default-refuted verification) — it found a P2 four Codex rounds missed.

---

## 5. Memory pointers
- `mt-journey-correctness-fixes.md` — the full #316 history (all 4 batches + the audit, per-finding root causes, commit ranges).
- `windows-embedded-pg-maxpath-boot.md`, `qa-isolated-main-instance.md`, `running-aoa-instance-windows.md` — running/QA-ing an instance locally.
- `aoa-multitenancy-provider-initiative` (linked topic) — the provider/multi-tenant thread.
