# Crew Execution Hardening — Phase 1: Foundation — Implementation Plan (v2, Codex-revised)

> **✅ SHIPPED 2026-07-23 on `feat/viewer-upgrade` (unpushed).** All 11 tasks (T1–T11) plus T1b, T9b landed via subagent-driven development, each through a two-stage review (spec-compliance + code-quality). **Live-verified end-to-end on a real instance:** a real crew agent (claude_local) ran a real task through the full pipeline — transcript persisted (T1), operator `~/.claude` isolated + per-run credentials provisioned (T2/T3), workspace resolved to the agent-home floor instead of the AoA repo (T5), Commander's skills delivered / crew's empty by default (T6/D17), bridge connected with `mcp__aoa__*` tools and correct crew identity (T8). **The root cause of "crew runs never complete" was found by reading the T1 transcript (T10): the default autonomy was Manual (0), at which the A4 dial-gate forbids `set_task_status` from advancing the task while the completion guard mislabeled the non-advance as a failure — proven by controlled variation (Manual→fail, Assist→in_review) and fixed by defaulting to Assist + gating the guard on `effectiveAutonomy >= 1`.** Follow-ups filed: D18 dial-split, idempotent crew retry, T3b (readiness probe), T3c (org session-identity strip), the unscoped `crew-context-bundle` thread read, and the pre-existing `HeartbeatsTab` main-branch breakage. Phase 2 (marketplace provisioning) and Phase 3 (viewer completion) are the master plan's remaining phases.

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make crew agent runs observable, hermetic, correctly-skilled and correctly-scoped — so a crew agent can complete a task and Discussions/Workspace work end-to-end.

**Architecture:** Crew agents (`kind='aoa'`) run via `runAoaAgent` → `adapter.execute` (claude_local). The org/heartbeat path already does transcripts + skill injection correctly; we **mirror it rather than invent mechanisms**, then add isolation, workspace resolution, and skill scoping. **Isolation ships crew-only first** and expands to org only after auth/workspace/toolchain tests pass.

**Tech Stack:** TypeScript (NodeNext, `.js` specifiers), Express, Drizzle, Vitest.

**Non-goals:** marketplace crew provisioning + catalog authoring (Phase 2), viewer/Office (Phase 3).

---

## v2 revision log (what Codex caught in v1)

| # | v1 defect | v2 fix |
|---|---|---|
| 1 | `actorType:"aoa"` invented — real vocabulary is `actorType:"agent"` + `agentKind:"aoa"`; `ask_human` requires it (`ask-human-tool.ts:33`), so v1 would have **forbidden `ask_human` for Scout/Engineer** | T8 uses `"agent"`+`agentKind` |
| 2 | `use_skill` rewrite gated on `ctx.agentId`, which **silently disables Commander** (production Commander bridges have no `agentId`; it resolves via `internalAgentConfig.agentId`, `skill-tools.ts:86`). v1's own test masked it | T9 keeps Commander's resolution, adds a separate agent-backed branch |
| 3 | "T3 before T4 prevents lockout" was **false** — `skillKeys` defaults `[]` (`agents.ts:43`) and crew seeding never sets it, so delivery *and* enforcement are both dead on arrival | Surfaced explicitly; **D17** then settled it — Phase 1 ships no defaults and T7 proves the founder-assigned path instead |
| 4 | Pinned `HOME`/`USERPROFILE` → breaks git/SSH/npm for tools the agent launches | T2 isolates **`CLAUDE_CONFIG_DIR` only**; home relocation is an explicit, separately-tested decision |
| 5 | Neutral cwd assumed to give crew a workspace — crew tasks aren't workspace-backed; scratch cwd means they **can't touch the repo** and breaks session resume (`execute.ts:450`) | New T5 (explicit workspace resolution) |
| 6 | Neutral cwd claimed to satisfy "no repo CLAUDE.md" — false for real workspace runs | New T4 uses documented `CLAUDE_CODE_DISABLE_CLAUDE_MDS` / `CLAUDE_CODE_DISABLE_AUTO_MEMORY` + an explicit policy |
| 7 | Blind whole-run retry → duplicate comments/artifacts (`post-task-comment-tool.ts:82`, `attach-task-artifact-tool.ts:121` are non-idempotent) | T10 diagnoses only; retry deferred behind idempotency |
| 8 | Missed that `createToolCallHandler` applies **Commander policy to every actor** (`mcp-bridge.ts:143`) while listing gates it correctly (`tool-registry.ts:199`) | T8 fixes the coupling + adds bridge-level tests |
| 9 | Wrong harness (`aoa-runner-loopback.test.ts` never calls `runAoaAgent`) | Use `aoa-runner-task-execution.test.ts:149` |
| 10 | T4 pseudocode wouldn't compile (`agents` is a Drizzle table, not a service) | Use `ctx.services.agents.getById` + company check |
| 11 | Raw `onMeta` persists **full prompts/context** (`execute.ts:583`) | T1 redacts + defines retention/access |
| 12 | `aoa-${agentId}` log-id fallback risks collisions | Use the run UUID (`runner.ts:168`); missing = invariant failure |
| 13 | Changing shared `execution-target.ts` claims all local adapters use a managed home | Claude-specific opt-in |

---

## Test strategy — required coverage per task

The repo has **five** distinct test layers. A task is not done until it has coverage at every layer that applies to it. Unit-testing a pure function proves the function is right; it does **not** prove it is wired — and "correct but not wired" is the failure mode that has bitten this branch twice (Phase 5's fail-closed defeated by hook coalescing; T1's sink existing while the test harness masked whether the runner used it).

| Layer | Location | Pattern |
|---|---|---|
| **L1 Unit / pure** | `server/src/**/__tests__/*.test.ts` | Import and call directly. No mocks. |
| **L2 Service + mock DB** | `server/src/__tests__/*.test.ts` | Proxy table stubs + `createSequenceDb`. Mock `@armyofagents/db` and `drizzle-orm`. |
| **L3 Schema / migration** | `packages/db/src/__tests__/*-schema.test.ts` | e.g. `commander-wave1-schema.test.ts`. Asserts columns, nullability, defaults, FK/cascade. |
| **L4 Integration (real PG)** | `server/src/__tests__/*.integration.test.ts` | Embedded Postgres. On Windows use `initdbFlags: ["--encoding=UTF8","--locale=C"]`. |
| **L5 E2E (Playwright)** | `tests/e2e/*.spec.ts` | `seedCompany` + the **fake-claude CLI harness** (`helpers/fake-claude.ts`), which records every invocation. Linux is the required gate; Windows self-skips in CI but **runs locally via `AOA_E2E_FORCE_WINDOWS=1`**. |

### The fake-claude harness is the key asset for T2–T6

`readFakeClaudeInvocations()` returns `FakeClaudeInvocation[]`, currently `{ argv, stdin, cwd }` — it captures what the CLI was *actually* invoked with. That makes the isolation and skill-delivery work provable end-to-end instead of only at unit level.

> **T2 must extend it with `env`.** Without captured env there is no way to prove `CLAUDE_CONFIG_DIR` was pinned and ambient `ANTHROPIC_*` was dropped **in the real spawn** — which is the entire point of T2–T4. This is an additive field on a shared helper; existing specs that destructure `{argv, stdin, cwd}` are unaffected.

### Coverage matrix

| Task | L1 Unit | L2 Service+mock | L3 Schema | L4 Integration | L5 E2E |
|---|---|---|---|---|---|
| **T1** | `redactMeta`, sink, warn-latch ✅ | runner wiring ✅ | **ADD** — `logStore`/`logRef` present + nullable | **ADD** — migration 0179 applies + pointer round-trips | — |
| **T2** | `buildIsolatedClaudeEnv` | — | — | — | **ADD** — env capture + isolation spec (see below) |
| **T3** | `provisionClaudeConfigHome` | — | — | — | credentials-only home; no `settings.json`/`plugins/`/user `skills/` in the spawned config dir |
| **T4** | env policy per D16 | — | — | — | folded into the T2 isolation spec |
| **T5** | resolution helper | runner sets `paperclipWorkspace` | — | **ADD** — real workspace resolved for a `software_development` project | **ADD** — assert spawn `cwd` is the workspace (harness already records `cwd`) |
| **T6** | — | `context.skills` set / omitted / warn-on-failure | — | — | **ADD** — attached skill reaches the CLI (assert via `argv` / skills dir) |
| **T7** | — | — | — | assign → deliver → enforce round-trip | **EXTEND** `agent-skill-toggle-persist.spec.ts` — attached skill is delivered, unattached is denied |
| **T8** | actor-identity shape | **bridge-level** (not just tool-level) | — | — | `ask_human` still works for crew |
| **T9** | tool-level allow/deny | **bridge-level** + Commander-no-`ctx.agentId` regression | — | cross-company agent lookup denied | denied-skill surfaces cleanly |
| **T10** | regression test for the identified root cause | — | — | — | — |
| **T11** | — | — | — | — | full multi-surface live verification |

### Test-type rules for this phase

1. **Every security boundary gets a negative test.** T9 is the boundary (D7 open library + D8 per-agent curation): unattached skill denied, cross-company agent denied, Commander unaffected. A test that only proves the happy path proves nothing about a boundary.
2. **Every "we didn't break the other path" claim gets an explicit test**, not an assertion in a report. T2 is crew-only opt-in ⇒ an org/heartbeat test must prove org env is unchanged.
3. **Every wiring change gets a layer above unit.** If a task adds a function AND calls it, the call site needs L2 or L5 coverage. T1's review caught exactly this — the runner suite could not assert the sink was wired until the store was mocked.
4. **Prefer extending an existing spec** over adding a new one where the surface already has coverage (T7 → `agent-skill-toggle-persist.spec.ts`).
5. **Integration tests must be Windows-runnable** (`initdbFlags` as above) so they can be verified locally, not only on the Linux gate.

---

## Task 1: Crew run transcripts (P1) — with redaction + real run id

> **Step 1 investigation COMPLETE (2026-07-23).** Findings below corrected this task's design. Do not re-derive them; do verify anything you depend on.

### Established facts

**The store API takes no `kind` field** (`run-log-store.ts:30-38`):
```ts
begin(input: { companyId: string; agentId: string; runId: string }): Promise<RunLogHandle>
append(handle, event: { stream: "stdout"|"stderr"|"system"; chunk: string; ts: string }): Promise<void>
finalize(handle): Promise<RunLogFinalizeSummary>   // { bytes, sha256?, compressed }
read(handle, opts?): Promise<RunLogReadResult>
```

**Heartbeat splits the two callbacks across two stores** — it does NOT put meta in the log file:
- `onLog(stream, chunk)` → `runLogStore.append(handle, { stream, chunk, ts })` (`heartbeat.ts:3857-3868`) plus a live event.
- `onMeta(meta)` → `appendRunEvent(...{ eventType: "adapter.invoke", payload: meta })` → the **`heartbeat_run_events` table** (`heartbeat.ts:3968-3976`).

**Crew has no equivalent events table**, so crew meta must ride the NDJSON as a `system`-stream chunk.

**The redaction risk is confirmed** — `AdapterInvocationMeta` (`adapter-utils/src/types.ts:171`) carries `prompt?`, `env?` and `context?`. *(Heartbeat persists this unredacted into `heartbeat_run_events.payload` today. Pre-existing, org-path, out of scope — file a follow-up, do not fix here.)*

**`internal_agent_runs` has no `logStore`/`logRef` columns** (`internal_agent.ts:288-311`), unlike `heartbeat_runs` which sets both immediately after `begin()` (`heartbeat.ts:3849-3856`). Filesystem-only therefore means the transcript is *reconstructable* but not *findable*.

### Design (revised by the above)

- `onLog` mirrors heartbeat exactly.
- `onMeta` → one **redacted** `system`-stream chunk in the same NDJSON (no new table).
- **Add nullable `logStore` + `logRef` to `internal_agent_runs`**, mirroring `heartbeat_runs`, set right after `begin()`. Two nullable columns is a small price for a transcript you can actually locate; without it, T10 has to guess paths. *(This supersedes v2's "filesystem-only, defer discoverability" call — the investigation changed the answer.)*
- `finalize()` on run end, on **both** the success and failure paths.

- [x] **Step 1: Read the real API.** — done, above.

- [ ] **Step 2: Confirm the ID + lifecycle invariant.** Use the run row's UUID assigned at `runner.ts:168`. **No `aoa-${agentId}` fallback** — it collides across runs. Missing run id ⇒ throw (invariant failure), don't silently degrade. Note `begin()` truncates an existing path, so call it exactly once per run.

- [ ] **Step 3: Write the failing test** against the REAL append signature:

```ts
import { describe, it, expect, vi } from "vitest";
import { createCrewRunLogSink, redactMeta } from "../crew-run-log.js";

describe("redactMeta", () => {
  it("drops prompt/context/env and keeps operational fields", () => {
    const out = redactMeta({
      adapterType: "claude_local", command: "claude", commandArgs: ["--print"],
      cwd: "/w", prompt: "SECRET PROMPT", env: { TOKEN: "sk-leak" }, context: { payload: "SECRET" },
    });
    expect(out.command).toBe("claude");
    expect(out.cwd).toBe("/w");
    expect(out.prompt).toBeUndefined();
    expect(out.env).toBeUndefined();
    expect(out.context).toBeUndefined();
    expect(out.promptChars).toBe(13);            // length only, for debugging
    expect(out.contextKeys).toEqual(["payload"]); // shape only, never values
  });
});

describe("createCrewRunLogSink", () => {
  it("forwards log chunks verbatim and meta as one redacted system chunk", async () => {
    const append = vi.fn().mockResolvedValue(undefined);
    const handle = { store: "local_file" as const, logRef: "r" };
    const sink = createCrewRunLogSink({ store: { append }, handle });

    await sink.onLog("stdout", "hello\n");
    await sink.onMeta({ adapterType: "claude_local", command: "claude", prompt: "SECRET PROMPT" });

    expect(append).toHaveBeenCalledTimes(2);
    const [, first] = append.mock.calls[0];
    expect(first).toMatchObject({ stream: "stdout", chunk: "hello\n" });
    expect(typeof first.ts).toBe("string");

    const [, second] = append.mock.calls[1];
    expect(second.stream).toBe("system");
    const parsed = JSON.parse(second.chunk);
    expect(parsed.event).toBe("adapter.invoke");
    expect(parsed.meta.command).toBe("claude");
    expect(parsed.meta.prompt).toBeUndefined();
    expect(second.chunk).not.toContain("SECRET PROMPT");   // the real guarantee
  });

  it("never throws when the store fails", async () => {
    const append = vi.fn().mockRejectedValue(new Error("disk full"));
    const sink = createCrewRunLogSink({ store: { append }, handle: { store: "local_file", logRef: "r" } });
    await expect(sink.onLog("stderr", "boom")).resolves.toBeUndefined();
    await expect(sink.onMeta({ adapterType: "claude_local", command: "claude" })).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 4: Run → FAIL.** `pnpm test:run server/src/services/internal-agent/aoa-agents/__tests__/crew-run-log.test.ts`

- [ ] **Step 5: Implement `crew-run-log.ts`.** `redactMeta` keeps `adapterType`/`command`/`commandArgs`/`commandNotes`/`cwd`/`promptMetrics`, drops `prompt`/`env`/`context`, and substitutes `promptChars`/`contextKeys`. Sink takes an injected `{ store, handle }` seam. Every append best-effort (never throws, never rejects).

- [ ] **Step 6: Add the columns.** Nullable `logStore` + `logRef` on `internal_agent_runs`, mirroring `heartbeat_runs`. **`pnpm db:generate` — never hand-write SQL** (Critical Rule #1).

- [ ] **Step 7: Wire into `runner.ts`.** `begin()` after the run row exists (`runner.ts:168`), persist the handle to the new columns, replace `onLog: async () => {}, onMeta: async () => {}` (~L569) with the sink, and `finalize()` on **both** the success and failure exits. Change nothing else in that call.

- [ ] **Step 8: Verify + commit.** `pnpm -r typecheck`, crew suites, and a migration-idempotency check PASS.
```bash
git commit -m "feat(crew): persist redacted crew run transcripts (crew runs were a black box)"
```

- [ ] **Step 9: Capture evidence.** Dispatch one crew task; confirm the NDJSON exists and `logRef` is populated on the run row. **Report a redaction-safe summary (stream kinds, chunk counts, exit code) — do NOT paste raw transcript lines.**

---

## Task 2: Ambient Claude-config isolation (crew-only opt-in)

> **Investigation COMPLETE (2026-07-23) — this task was redesigned. Do NOT build `buildIsolatedClaudeEnv`; the mechanism already exists.**

### Established facts

**The strip seam already exists and is already hardened.** `mergeChildEnv(parentEnv, overlayEnv, unsetEnvKeys)` (`adapter-utils/src/server-utils.ts:368-394`) removes an inherited key **only if the overlay did not set it** — so a pinned value survives while the ambient one is dropped. It is already **case-insensitive on Windows** (`:380-382`), which is precisely the trap a hand-rolled `delete env[key]` would fall into (`CLAUDE_CONFIG_DIR` vs `Claude_Config_Dir` are the same variable on Windows).

**It is threaded end-to-end already:** `spawnTrackedChild`/runner (`server-utils.ts:431`, `:508`, `:517`), `execution-target.ts:101,138`, `streaming-login.ts:49,73`.

**There is precedent for a per-adapter opt-in.** codex-local passes `unsetEnvKeys: ["OPENAI_API_KEY"]` at four call sites (`codex-local/src/server/execute.ts:508`, `execute-app-server.ts:192`, `jsonrpc-client.ts:322`, `test.ts:259,348`) to keep the AoA server's key out of agent runs. **claude-local passes none** — that is the gap.

**The leak point** is `execute.ts:251` (`{ ...process.env, ...env }`) and the equivalent merge inside the spawn path.

**`ANTHROPIC_API_KEY` is not cosmetic** — ⚠️ *mechanism corrected 2026-07-23; the first version of this line was wrong and the implementer caught it.* It does **not** flow through `resolveClaudeBillingType`. That helper reads the adapter's **overlay** env (`buildAoaEnv` + `AOA_*` + `config.env`, assembled at `execute.ts:183`) and is called at `:366` with that overlay, which never merges `process.env`. The real leak is that **the spawned child inherits the ambient key and the `claude` CLI itself switches to API-key auth** — so a crew run silently bills against the operator's key instead of the subscription. Same severity, different mechanism, and the same leak codex already closes. **Assert on the child env, not on the billing-type helper.**

### Design (revised)

- **Use `unsetEnvKeys`.** Do not write a parallel env builder.
- **Add `unsetEnvPrefixes`** alongside it in `mergeChildEnv` — *additive*, so every existing caller is unchanged. Needed because `CLAUDE_*`/`ANTHROPIC_*` is a prefix class: an enumerated list silently leaks any newly-introduced variable, and D9 requires crew agents see *nothing* from the host config. Reuse the existing `sameKey` case-folding for prefix matching (Windows-insensitive, POSIX-exact) — do not write a second comparison rule.
- **Pin `CLAUDE_CONFIG_DIR` in the overlay `env`**, so the strip's "overlay wins" rule preserves it automatically.
- **Never touch `HOME`/`USERPROFILE`** — git, SSH and npm all resolve through them for tools the agent launches.
- **Crew-only opt-in** (D15): thread an explicit flag from the crew runner; org/heartbeat behaviour is unchanged until T11's expansion gate.

- [ ] **Step 1: L1 — extend `mergeChildEnv`.** Failing tests first, in the existing `adapter-utils/src/server-utils.test.ts` (there is already a `describe("mergeChildEnv — unsetEnvKeys escape hatch")` block — extend it, don't start a new file):
  - a prefix strips every ambient matching key;
  - an overlay-set key matching the prefix **survives** (same rule as `unsetEnvKeys`);
  - on Windows, a differently-cased ambient key matching the prefix is dropped;
  - **no prefixes supplied ⇒ byte-identical behaviour to today** (regression guard for codex).

- [ ] **Step 2: L1 — the claude-local strip list.** Export one shared const naming the prefixes (`CLAUDE_`, `ANTHROPIC_`) plus a documented **keep-list** for anything that must survive. Test that `PATH` and `HOME`/`USERPROFILE` are untouched.

- [ ] **Step 3: Wire it, crew-only.** Pass `unsetEnvPrefixes` + the pinned `CLAUDE_CONFIG_DIR` from claude-local's execute path **only when the crew opt-in flag is set**. Do **not** broaden `adapterExecutionTargetUsesManagedHome` (shared by pi/cursor/codex).

- [ ] **Step 4: L5 — extend the fake-claude harness with `env` capture.** Add `env: Record<string,string>` to `FakeClaudeInvocation` (`tests/e2e/helpers/fake-claude.ts:35-40`) and record it in the fake CLI. **Additive** — existing specs destructure `{argv, stdin, cwd}` and are unaffected.

- [ ] **Step 5: L5 — the isolation spec.** New `tests/e2e/crew-config-isolation.spec.ts`: seed a company + crew agent, set a poisoned ambient `ANTHROPIC_API_KEY` on the server process, dispatch a crew run, then assert **on the recorded invocation env** that `CLAUDE_CONFIG_DIR` is the per-run dir, `ANTHROPIC_API_KEY` is absent, and `PATH` + `HOME`/`USERPROFILE` survived. *This is the assertion that proves the code is **wired**, not merely correct.* Runs locally on Windows via `AOA_E2E_FORCE_WINDOWS=1`.

- [ ] **Step 6: L2 — the no-regression proof.** An explicit test that an **org/heartbeat** claude_local run still receives ambient env unchanged (D15). Per test-rule #2, this is a test, not a claim in a report.

- [ ] **Step 7: Verify + commit.** adapter-utils + claude-local + codex-local suites (codex is the `unsetEnvKeys` incumbent — it must stay green), org/heartbeat suites, `pnpm -r typecheck`.
```bash
git commit -m "feat(agents): isolate ambient Claude config for crew runs via unsetEnvPrefixes"
```

---

## Task 3: Per-run Claude config home provisioning (auth)

> 🚨 **T3 became a BLOCKING prerequisite the moment T2 landed.** T2 pins `CLAUDE_CONFIG_DIR` to an **empty** per-run directory, so on this branch a crew run against the real `claude` CLI is **unauthenticated** until T3 provisions credentials into it. This is by design — T2's brief scoped provisioning out — but it means the branch cannot complete a live crew run until T3 ships. Do not attempt live crew verification (T10, T11) before this task.

**Files:** `packages/adapters/claude-local/src/server/` (a `provisionClaudeConfigHome` helper) + wherever the per-run root is created; test alongside.

> **Step 1 investigation COMPLETE (2026-07-23).** Findings below; verify anything you depend on, but do not re-derive them.
>
> **Auth is file-based on Windows, and the filename is already abstracted in-repo.** `resolveClaudeConfigHome(env)` = `env.CLAUDE_CONFIG_DIR ?? ~/.claude` (`claude-local/src/server/login.ts:14-16`). The credential file is **`.credentials.json`** — described in-repo as "dogfood-verified filename" and already modelled as `credentialFileName` on the provider-login runner registry (`server/src/services/commander-login-runtime.ts:41-42,72`), where codex uses `auth.json` and claude uses `.credentials.json`. **Reuse that abstraction; do not hardcode a second copy of the filename.**
>
> **A real operator config home contains 20 entries** — verified by listing names on this machine. `.credentials.json` is 471 bytes. The other 19 are exactly the contamination sources: `CLAUDE.md`, `settings.json`, `plugins/`, `skills/`, `projects/`, `sessions/`, `ide/`, `shell-snapshots/`, `mcp-needs-auth-cache.json`, `history.jsonl`, `telemetry/`, `cache/`, `tasks/`, `plans/`, `backups/`, `chrome/`, `debug/`, `session-env/`, `.last-cleanup`. Provisioning copies **one** of those 20.

- [ ] **Step 1: Confirm the source resolution.** Resolve the *operator's* config home with `resolveClaudeConfigHome(process.env)` **before** T2's strip applies — the strip pins `CLAUDE_CONFIG_DIR` to the per-run dir, so resolving after it would read the empty target and copy nothing. If credentials are keychain-backed on any other target platform, isolation must not assume file copy — record that if you find it.
- [ ] **Step 2: Failing test** — provisioning creates `<root>/.claude` containing the credentials and **no** `settings.json`, **no** `plugins/`, **no** user `skills/`.
- [ ] **Step 3: Implement** `provisionClaudeConfigHome(rootDir)`: mkdir, copy only the credentials file from the resolved source config home, and assert nothing else is copied. Fail loudly with an actionable error if credentials are absent (an unauthenticated agent must not silently run).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Lifecycle.** Cleanup already exists from T2 — the per-run dir is `fs.rm`'d in `execute.ts`'s `finally`, `.catch(()=>{})` so it can never fail a run, mirroring `skillsDir`/`hookSettingsTmpDir`. **What T3 changes is the stakes.** The dir is created *before* the `try` opens, so anything throwing in between (`prepareAdapterExecutionTargetRuntime`, the remote syncs, the instructions `readFile`) leaks it — as does a SIGKILL. Today an orphan is junk; **once T3 lands it is credentials at rest.**
  - [ ] Add a **boot-time sweep** of `os.tmpdir()/aoa-claude-config-*` older than N hours. There is no existing temp-dir sweeper in the repo (checked `server/src/index.ts` — workspace TTL and cleanup-retry sweepers exist, nothing for temp dirs), so this is new. Model the registration on the existing sweepers.
  - [ ] Consider tightening dir permissions at creation now that it holds a credential. `mkdtemp` is already the right primitive (see `codex-exec.ts:88-101` for why a deterministic name would be attackable) — this is about mode, not naming.

- [ ] **Step 6: Close the readiness/run split (deferred here from T2).** Readiness probes the **host** config (`claude-local/src/server/test.ts:153`; login challenges keyed on `CLAUDE_CONFIG_DIR ?? ~/.claude`) while a crew run uses the isolated dir. Left unfixed, Settings → Providers reports anthropic verified while every crew run fails login-required, and the founder's natural remedy (`claude auth login` → credentials into `~/.claude`) does not help. Thread the same crew opt-in into the readiness probe so the crew card measures the directory crew actually uses. **Precedent:** codex mirrors its strip into readiness for exactly this reason (`codex-local/src/server/test.ts:258-259`, `:348`).
  *(T2 shipped the cheap half — a `commandNotes` line naming the pinned dir, so the pre-T3 failure is self-explaining.)*

- [ ] **Step 7b: Strip the session-identity subset for ORG runs (separable, no credential work).** *Observed and independently reproduced during T2, 2026-07-23 — this is evidence, not inference.*

  With the fixture allowlist in place, an **org** (non-isolated) claude_local spawn was recorded carrying, among ~22 keys:
  ```
  CLAUDE_CODE_SESSION_ID   CLAUDE_CODE_HOST_SESSION_ID   CLAUDE_CODE_CHILD_SESSION=1
  CLAUDE_CODE_ENTRYPOINT=claude-desktop   CLAUDE_CODE_EXECPATH   CLAUDE_AGENT_SDK_VERSION
  CLAUDE_PID   ANTHROPIC_BASE_URL   …
  ```
  The reviewer confirmed the recorded `CLAUDE_CODE_SESSION_ID` was **their own live session id**. Chain: Claude Code desktop session → shell → `pnpm test:e2e` → `webServer.env = {...process.env}` → AoA server → heartbeat → claude-local → child CLI. Every hop is plain `process.env` inheritance; **AoA introduces none of it.**

  **Why this is not telemetry.** `CLAUDE_CODE_CHILD_SESSION=1` + `CLAUDE_CODE_SESSION_ID` + `CLAUDE_CODE_ENTRYPOINT` *declare the child to be a continuation of a specific live session* — a behavioural input to the CLI. This is the most plausible mechanism for the live hijack that motivated D9, and it matches a lesson already in this project's history (the Commander 401 that turned out to be a Claude Code child-session artifact → "never diagnose CLI auth from inside a CC subprocess").

  **Why it matters more than its size suggests:** the affected configuration — a server started from an agent-hosted or Claude-desktop-hosted shell — is exactly how AoA is developed, QA'd and live-verified. It silently contaminates the evidence used to validate agent behaviour. That is a **development-integrity** problem, and it is worse than a production bug of equal size because it corrupts the instrument.

  **Why it can ship independently of T3:** that subset carries no credential and no founder-configured auth mode, so stripping it for org runs kills the hijack mechanism **without** needing any provisioning story. Treat it as a separable slice; it does not have to wait for the full org expansion at T11.

- [ ] **Step 7: Document the env-based-auth escape hatch.** An operator whose Claude access is env-based (`CLAUDE_CODE_USE_BEDROCK`, `ANTHROPIC_BEDROCK_BASE_URL`, `ANTHROPIC_BASE_URL`) loses it for crew runs under T2's strip. The mitigation already works — those keys survive in `adapterConfig.env` via overlay-wins — and T2 documented it in `ambient-config.ts`. Verify it still holds **after** provisioning lands, since T3 introduces a second auth source that could mask it.
- [ ] **Step 6: Verify + commit.**
```bash
git commit -m "feat(agents): provision a minimal per-run Claude config home (credentials only)"
```

---

## Task 4: Claude-instruction isolation (the `CLAUDE.md` policy)

> **T4 may already be mostly satisfied by T2 — verify before implementing.** The operator's global instructions live at `~/.claude/CLAUDE.md`, inside the config home. T2 pins `CLAUDE_CONFIG_DIR` to a fresh empty per-run dir, and T3 copies only `.credentials.json` into it — so the global `CLAUDE.md`, `settings.json`, `plugins/` and `skills/` should **already** be unreachable, which is D16's "block global" half for free. **Do not assume this: prove it** with an assertion on a real run, and confirm the *other* half (a project repo's own `CLAUDE.md` still loads, per D16) rather than silently blocking both. If both halves already hold, T4 is a verification + decision-record task, not an implementation task — say so plainly rather than inventing work.

**Decision required before coding — record it in `docs/architecture/decisions.md`:** a project workspace that is a real repo will still load its `CLAUDE.md`. D16 is already locked (block global, allow project); this step records the rationale and the mechanism. For completeness the alternatives considered were:
- **(A) Enforce D9 globally** — set `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` for agent runs, so ONLY AoA's `--append-system-prompt-file` instructions apply. *(Recommended: matches D9 "agents see only AoA-provisioned instructions".)*
- **(B) Allow project `CLAUDE.md`** as legitimate context for a trusted workspace, and accept that repo instructions influence agents.

- [ ] **Step 1: Record the decision** (A or B) with rationale.
- [ ] **Step 2: Failing test** asserting the chosen env vars are (or are not) set for a crew run.
- [ ] **Step 3: Implement** in the env builder from T2.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Verify + commit.**
```bash
git commit -m "feat(agents): explicit Claude-instruction isolation policy for agent runs"
```

---

## Task 5: Crew workspace resolution (crew tasks must be workspace-backed)

> 🚨 **T4 raised this task's severity — it is no longer only a capability gap, it is an active contamination.** Verified 2026-07-23: the crew runner never sets a workspace, so `cwd` falls through to `process.cwd()` (`claude-local/src/server/execute.ts:188`) — **the AoA server's own repository**. Every crew run therefore loads *AoA's* `CLAUDE.md`, i.e. this codebase's development instructions, into an agent meant to be doing the customer's work.
>
> This is the most likely mechanism behind the live hijack that motivated the whole isolation workstream, and it is **not** what D16's "allow the workspace repo's `CLAUDE.md`" tier intends — a crew agent has no workspace, so what it actually inherits is the server's directory by accident.
>
> **Consequence for this task:** resolving a workspace is not only about giving the agent a repo to work in; it is what makes tier two of D16 mean the right thing. Until it lands, "project instructions are allowed" is actively harmful rather than merely absent. Where no workspace resolves, decide explicitly what `cwd` should be — inheriting the server's repo must stop being the fallback.

**Why:** crew tasks are **not** workspace-backed today — the crew runner never sets `context.paperclipWorkspace` (heartbeat resolves it at `heartbeat.ts:1549` → `:3628`). Without this, a crew agent has no repo to work in, and a scratch cwd also breaks Claude session resume (`execute.ts:450` requires identical cwd).

**Files:** `runner.ts` (context assembly); mirror `heartbeat.ts:1549-3628`; test `server/src/__tests__/crew-workspace-resolution.test.ts`.

- [ ] **Step 1: Read heartbeat's workspace resolution** and record exactly which inputs it uses (project, `executionWorkspacePolicy`, `functionType`, existing workspace reuse).
- [ ] **Step 2: Failing test** — a crew task on a `software_development` project resolves a workspace and passes `context.paperclipWorkspace`; a task with no project/policy resolves none and does **not** fabricate one.
- [ ] **Step 3: Implement** resolution in the crew runner, mirroring heartbeat. Preserve precedence: workspace cwd > configured cwd > fallback.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Verify + commit.**
```bash
git commit -m "feat(crew): resolve execution workspaces for crew tasks (mirrors heartbeat resolution)"
```

---

## Task 6: Deliver company skills to crew (P3) — warning-grade

**Files:** `runner.ts`; mirror `heartbeat.ts:4003-4013`; **harness pattern: `server/src/__tests__/aoa-runner-task-execution.test.ts:149`** (NOT `aoa-runner-loopback.test.ts`, which never calls `runAoaAgent`); test `server/src/__tests__/crew-skills-context.test.ts`.

- [ ] **Step 1: Failing tests** — (a) resolved skills land on `context.skills`; (b) empty list ⇒ key omitted entirely (so the adapter's `dbSkills.length > 0` branch is unchanged); (c) a resolver failure logs a **warning** and does not fail the run.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — resolve via `companySkillService(db).listRuntimeSkillEntries(companyId, agentId)`; set `context.skills` only when non-empty. **Do not swallow errors silently** — mirror heartbeat's warn-then-continue so broken skill storage is visible:

```ts
let agentSkills: RuntimeSkillEntry[] = [];
try {
  agentSkills = await companySkillService(db).listRuntimeSkillEntries(companyId, agentId);
} catch (err) {
  log.warn({ err, companyId, agentId }, "crew skill resolution failed; continuing without skills");
}
const context: Record<string, unknown> = { aoaInstruction: instruction, payload };
if (agentSkills.length > 0) context.skills = agentSkills;
```

- [ ] **Step 4: Run → PASS.** **Step 5: Verify + commit.**
```bash
git commit -m "feat(crew): deliver company/marketplace skills to crew agents at runtime"
```

---

## Task 7: Prove the founder-assigned skill path end-to-end (no defaults — D17)

**Why the shape changed.** v2 originally proposed seeding default `skillKeys` per role. **D17 rejects that:** Commander's skills are Commander's job, and each crew agent's real set is declared in its marketplace agent template (D6) — which Phase 2 delivers. Inventing a Phase-1 map is guesswork Phase 2 deletes.

**So Phase 1 assigns NO defaults.** That is not a regression (crew agents get zero skills today) and it *does* close P4's hole. What Phase 1 must prove is that a skill a founder attaches in the Skills tab is **actually delivered (T6) and actually enforced (T9)** — making the tab honest (P7) and leaving Phase 2 to populate it from templates.

**Files:** integration test only — `server/src/__tests__/crew-skill-assignment-e2e.test.ts`. No seeder change.

- [ ] **Step 1: Confirm the assignment route works** — `PATCH …/agents/:id` validates `skillKeys` against the company's installed skills and 422s on unknown/ambiguous keys (`agents.ts:1514-1516`). Record the exact request shape; do not modify it.
- [ ] **Step 2: Write the failing integration test** spanning assignment → delivery → enforcement:
  - assign one installed skill to a crew agent via the route;
  - `listRuntimeSkillEntries(companyId, agentId)` returns exactly that skill;
  - the crew runner puts it on `context.skills` (T6);
  - `use_skill` with that key succeeds, and with a *different* installed key returns `NOT_ENABLED` (T9);
  - clearing `skillKeys` returns the agent to delivering nothing.
- [ ] **Step 3: Run → FAIL** until T6 and T9 are both in.
- [ ] **Step 4: Run after T9 → PASS.** No implementation of its own; this task is the seam that proves the other two.
- [ ] **Step 5: Fix the UI copy (P7).** `AgentSkillsTab.tsx:273-275` claims *"Skills injected into this agent's context on every run"* — true only once T6 ships, and only for attached skills. Reword to state that only attached skills are injected.
- [ ] **Step 6: Commit.**
```bash
git commit -m "test(crew): prove founder-assigned skills are delivered and enforced end-to-end"
```

---

## Task 8: Correct crew actor identity + bridge policy coupling

**Files:** `runner.ts` (~L337-354 bridge params), `mcp-bridge.ts` (~L143 `createToolCallHandler`, ~L291/327 context reconstruction), `authorize-tool.ts` (reference: crew is distinguished by `agentKind`, `:52`); tests at the **bridge** level.

- [ ] **Step 1: Failing tests** — (a) a crew bridge call presents `actorType:"agent"` + `agentKind:"aoa"`; (b) **`ask_human` is permitted for crew** (it requires exactly that combination, `ask-human-tool.ts:33`); (c) a crew tool call is **not** subjected to Commander-only policy.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** Set `actorType: "agent"` (+ ensure `agentKind: "aoa"` and `agentId` flow) in the crew bridge params — **never `"aoa"` as an actorType**. Then make `createToolCallHandler` apply `resolveCommanderToolPolicy` **only for `actorType === "commander"`**, matching how tool *listing* already gates it (`tool-registry.ts:199`), so crew tools can't be advertised then rejected.
- [ ] **Step 4: Run → PASS.** **Step 5:** Update the stale `ToolContext`/`McpConfigParams` comments that describe only Commander/board actors.
- [ ] **Step 6: Verify + commit.**
```bash
git commit -m "fix(crew): correct crew actor identity (agent+aoa) and stop applying Commander policy to crew tool calls"
```

---

## Task 9: Enforce `skillKeys` scoping (P4 — the security boundary)

**Depends on T8** (correct identity). T7 is the harness that proves T6+T9 together — write it before, run it after.

**On the "lockout" concern:** enforcing while `skillKeys` is empty denies every skill to every crew agent. Under D17 that is the *intended* Phase-1 state — crew agents receive no skills today, so nothing regresses, and the open-library hole (D7/P4) closes immediately. Founder-assigned skills are the escape hatch, proven by T7.

**Files:** `server/src/services/internal-agent/tools/skill-tools.ts` (~L86-112); tests at both tool and bridge level.

- [ ] **Step 1: Failing tests** — (a) crew agent denied a skill not in its `skillKeys` (`NOT_ENABLED`); (b) crew agent allowed one that is; (c) **Commander's existing gate still works with NO `ctx.agentId`** (resolved via `internalAgentConfig.agentId`) — this is the regression v1 would have shipped; (d) an agent from another company cannot be resolved.
- [ ] **Step 2: Run → the crew tests FAIL, Commander test PASSES** (proving no regression baseline).
- [ ] **Step 3: Implement — keep Commander's path, add an agent branch.** Do **not** collapse them into one `ctx.agentId` check:

```ts
// The skillKeys allowlist is the security boundary for an intentionally OPEN
// skill library (D7): anyone may install skills from any source, so an agent
// must only invoke skills deliberately attached to it (D8).
// Commander resolves its agent id from internalAgentConfig (its bridge has no
// ctx.agentId) — that path must be preserved exactly.
let scopedAgentId: string | null = null;
if (ctx.actorType === "commander") {
  scopedAgentId = await resolveCommanderAgentId(ctx);        // existing behavior
} else if (ctx.actorType === "agent" && ctx.agentKind === "aoa" && ctx.agentId) {
  scopedAgentId = ctx.agentId;                                // crew
}
if (scopedAgentId) {
  const agent = await ctx.services.agents.getById(scopedAgentId);
  if (!agent || agent.companyId !== ctx.companyId) {          // getById is NOT company-scoped
    return { success: false, error: "NOT_ENABLED: agent not found in this company", summary: "" };
  }
  const allowed: string[] = Array.isArray(agent.skillKeys) ? agent.skillKeys : [];
  if (!allowed.includes(skill.key)) {
    return { success: false, error: `NOT_ENABLED: skill '${skill.key}' is not attached to this agent`, summary: "" };
  }
}
```

- [ ] **Step 4: Run → all PASS.** **Step 5:** Add a **bridge-level** test (not just direct `execute`) so policy/authorization coupling is covered.
- [ ] **Step 6: Verify + commit.**
```bash
git commit -m "fix(crew): enforce per-agent skillKeys for crew use_skill (Commander path preserved, company-scoped)"
```

---

## Task 10: Diagnose crew completion (P5) — **no blind retry**

**Blocked on T1.** Guard hit: `runner.ts:644` ("completed without moving the task").

- [ ] **Step 1: Reproduce with a transcript** (post T1–T9). Answer from the log: did the CLI start? were the AoA MCP tools listed (is `set_task_status` present)? was any tool called? any error? **Record before changing code.**
- [ ] **Step 2: Classify** as exactly one of: (a) MCP bridge not connected → agent never saw `set_task_status`; (b) tool visible but not called → prompt/instruction problem (fix the crew trigger prompt to state the completion contract); (c) CLI failed early (auth/model/args).
- [ ] **Step 3: Write a regression test** for the identified cause; fix; confirm PASS.
- [ ] **Step 4: Live-verify** a crew task completes and moves to `in_review`/`done`.
- [ ] **Step 5: Retry is OUT OF SCOPE here.** `post_task_comment` (`post-task-comment-tool.ts:82`) and `attach_task_artifact` (`attach-task-artifact-tool.ts:121`) are **non-idempotent**, so a whole-run retry duplicates comments/artifacts. File a follow-up: "idempotency keys / checkpoint-aware retry for crew runs" — a prerequisite for any automatic retry.
- [ ] **Step 6: Commit.**
```bash
git commit -m "fix(crew): <root cause> — crew runs complete and move the task"
```

---

## Task 11: Completion gate + docs reconciliation

- [ ] `pnpm -r typecheck`, the touched suites, and `pnpm build` → PASS. **Org/heartbeat suites explicitly included** (T2 is crew-opt-in, so they must be unchanged).
- [ ] **Live end-to-end** on the isolated instance: Discussion → scope → dispatch → (1) transcript persisted, (2) no operator hooks/skills present, (3) only the agent's attached skills, (4) task **completes**, (5) **"Run finished"** entry with clickable chips, (6) each chip opens the right Thread body.
- [ ] **Denied-skill check:** a crew agent invoking an unattached skill gets `NOT_ENABLED`. **`ask_human` still works for crew** (T8 regression guard).
- [ ] **Isolation-expansion gate (explicit).** Only after auth + workspace + toolchain tests pass, decide whether to extend T2/T3/T4 isolation beyond crew. Record each decision; do **not** flip either silently. **Two distinct populations:**
  - **Org / heartbeat agents** — same claude-local adapter, so the wiring is the one T2 already built. Lowest-risk expansion.
  - **Commander** — *deferred here by product-owner decision, 2026-07-23.* Commander runs CLI-mode through `cliModeService`, **not** `runAoaAgent`, so T2's crew-only opt-in does not reach it. It has the same `~/.claude` exposure (hooks, third-party skills, plugins) and is the most visible surface, but it is a **second wiring site with its own auth path**, and a broken Commander is more disruptive than a broken crew agent. Evaluate it only once crew isolation is proven live, using the T1 transcripts as evidence that isolation did not break auth or the toolchain.
- [ ] **Docs:** update `docs/architecture/decisions.md` (hermetic execution + the T4 CLAUDE.md policy) **and reconcile `CLAUDE.md:212`**, which currently states `use_skill` is board/Commander-only and `ask_human` is heartbeat-only — both now inaccurate for crew.

---

## Self-review

**Coverage:** P1→T1, P2→T2+T3+T4, P7b→T5, P3→T6, P7c→T7 (proof harness), P4b→T8, P4→T9, P5→T10, P7→T7 Step 5, P6 deferred (re-run ergonomics are not on the critical path to a completing crew run).

**Ordering:** T1 → T2 → T3 → T4 → T5 → T6 → T7 (write) → T8 → T9 → T7 (run) → T10 → T11. T9 **must** follow T8 (else wrong actor identity). T10 **must** follow T1 (else undiagnosable).

**Deliberate Phase-1 end state:** crew agents hold no default skills (D17). Real per-agent sets arrive in Phase 2 from marketplace agent templates (D6). Phase 1's job is that the *machinery* is correct and the founder-assigned path works.

**Blast radius:** T2/T3/T4 ship **crew-only**; org/heartbeat is untouched until the T11 expansion gate. T8's bridge-policy change affects all non-Commander actors — bridge-level tests are mandatory, not optional.

**Known unknowns, stated honestly:** T10's root cause is unknown until a transcript exists (diagnose-then-classify, no pretend fix). T3's auth-mode assumption is file-based credentials — verified on Windows, must be re-checked per platform.

**Deferred (tracked, not dropped):** crew log discoverability in the run API/UI; crew re-run ergonomics; idempotent/checkpoint-aware retry.
