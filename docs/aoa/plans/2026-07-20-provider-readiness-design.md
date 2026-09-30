# Provider Readiness & Authentication — Design

**Date:** 2026-07-20
**Status:** Design approved, pending implementation plan
**Branch:** one branch / one worktree, staged (A → B → C)

---

## 1. Context

Commander runs **keyless** — it executes entirely through a locally-installed CLI (`claude`, `codex`, …). That makes the CLI's authentication state a hard runtime dependency, but AoA currently exposes almost no way to see or fix that state from inside the product.

This design was triggered by a live investigation (2026-07-20) into "Commander chat is broken — no livestream, no reply". Reproduced end-to-end in an isolated instance:

- The composer UI (PR #291) was **not** the cause. The send path works: `POST /internal-agent/chat` → 200, the turn runs, the Send→Stop button flips, the user message persists.
- The real cause: the `claude` CLI returned `401 "OAuth access token has been revoked"` (exit 1).
- The SSE stream carried only `event: thinking` then `event: done` with `tokenUsage: {0,0,0}` — **no content and no error**. Nothing was persisted, and the UI showed no error at all.

Two defects underlie that experience:

1. **No proactive surface.** There is no place in the product to see "is my Claude CLI installed and signed in?", and no in-app way to fix it, except during onboarding.
2. **No reactive surface.** A failed CLI run is silently swallowed (see §9).

The existing onboarding step already solves (1) — but only for Commander, only during onboarding, and only for two providers. This design generalises it.

### Current state (verified)

| Surface | What exists today |
|---|---|
| Onboarding `VerifyStep` (`ui/src/onboarding/steps/VerifyStep.tsx`) | Full guided flow: probe → `not_installed` install hint / `needs_auth` → paste API key **or** interactive device login → auto re-verify. Commander-only, anthropic/openai-only. |
| Agent config (`ui/src/components/AgentConfigForm.tsx:1169`) | A passive **"Test environment"** button rendering pass/warn/fail + text hints. **No actions** — no install, no key, no sign-in. |
| Settings → Commander (`CommanderSection.tsx`) | CLI/model/provider selection + a `testConnection` button. Explicitly states "No API key required — the CLI handles authentication". No credential UI. |
| Settings → Secrets | A full raw vault: Inventory / Bindings / Provider Keys (E2B sandbox creds) / Vault providers / Audit. Advanced, secret-row oriented. |

---

## 2. Goals / Non-goals

### Goals
- One centralized place to get **every** provider's tooling working: see status, test, install, and authenticate.
- Cover authentication by **API key** and, where technically possible, **interactive login**.
- Make readiness visible **on each agent**, without duplicating auth UI per agent.
- Preserve, byte-for-byte, the existing **per-agent credential override** behaviour.
- Pair the proactive surface with the reactive fix so runtime auth failures are never silent again.

### Non-goals (v1)
- **Per-agent interactive login.** Auth is host-shared per provider (§6); per-agent credential isolation via interactive login is a much larger effort and is explicitly out of scope.
- Replacing or restructuring the existing Secrets vault.
- Auth for non-credentialed adapters (`process`, `http`) or webhook/endpoint tokens (`openclaw`, `openclaw_gateway`) — those are per-agent endpoint config, not shared credentials.
- Hosted-API execution paths. AoA remains keyless-except-embeddings (Decision #104); this feature is about making the **local CLIs** usable, not about adding hosted inference.

---

## 3. Locked decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **Scope:** framework for all providers first (status + test + API key), then wire interactive login per CLI. Both stages land on **one branch / one worktree**. | Designing the provider abstraction against the *full* provider list up front avoids building a 2-provider seam and retrofitting five more. |
| D2 | **Placement:** a new top-level **Settings → Providers** tab. | Secrets stays the advanced raw vault; Providers is the human-facing "get my tooling working" page. Commander tab is Commander-scoped by name, so it would mislead as this grows. |
| D3 | **Probe strategy:** persist last probe result; on load show cached status instantly, auto-refresh only **in-use** providers; per-card `Test` + a `Test all`. | Each probe spawns a real CLI (~1–3s). Probing 8+ providers on every page load would cost 10–20s and a subprocess storm. |

**Definition — "in-use provider":** a provider whose `adapterType` is either (a) the adapter resolved from Commander's configured `cliTool`, or (b) the `adapterType` of at least one non-archived agent in the company. Everything else renders from cache only until the user presses `Test`. Auto-refresh is additionally skipped when the cached result is newer than a staleness threshold (default 5 minutes) so repeated navigation does not re-spawn CLIs.
| D4 | **Credential resolution:** `agent env binding → company provider key → host CLI login`. | The new company-level default must never stomp an existing per-agent override. |
| D5 | **Honesty in UI:** API keys are per-company; interactive login writes a **host-shared** credential home. Label them differently. | Pretending they have the same scope would be actively misleading on a multi-company host. |
| D6 | **Extract, don't duplicate:** one shared readiness component consumed by Settings, agent config, and onboarding. | Two drifting copies of an auth flow is the failure mode this design exists to prevent. |

---

## Relationship to `runtime_provider_keys`

AoA already has a company-scoped table literally named `runtime_provider_keys`. It is **not** the same thing as this design's provider credentials, and the two stay separate.

- **What it is:** sandbox/infrastructure runtime credentials. Its provider enum is `["e2b"]` (`packages/shared/src/constants.ts`), the row points at a `company_secrets` secret (`packages/db/src/schema/runtime_provider_keys.ts`), and its only consumer is `resolveCredential()` in `server/src/services/runtime-provider-keys.ts`, called from two live sites — `server/src/services/environment-probe.ts` and `resolveRuntimeProviderConfig` in `server/src/services/environment-runtime.ts` — both hard-gated on `provider === "e2b"`. Routes live under `/companies/:companyId/runtime-provider-keys` in `server/src/routes/secrets.ts`. **No LLM or CLI credential passes through it today.**
- **What we do instead:** CLI/LLM provider credentials are stored in `company_secrets` under the reserved name `provider:<id>` and injected through **adapter env resolution** (§6).
- **Why separate:** the consumption mechanism is different — sandbox keys are resolved by the sandbox-provider registry at environment-probe time, CLI keys are resolved into an adapter's process env at spawn time. CLI providers also need host-login semantics (interactive login writing a host-shared credential home, per D5) that the sandbox registry has no concept of, plus a probe/readiness lifecycle it does not model.
- **Name collision fix:** the Secrets vault sub-tab previously labelled "Provider Keys" is renamed **"Sandbox Providers"**, freeing the name "Providers" for the new top-level Settings tab (D2). This is a **copy-only** rename — no table, column, route, type, or component is renamed.
- **Rejected alternative:** extending `RUNTIME_PROVIDER_KEY_PROVIDERS` to include the CLI providers. It would force per-provider host-login state and probe results into a schema built for a one-secret-per-sandbox-vendor registry, couple CLI readiness to the environment-probe path, and require a migration plus changes to a live E2B code path for no gain — the credentials would still have to be re-resolved into adapter env anyway.

---

## 4. Provider inventory & capability matrix

Derived from the adapter registry (`server/src/adapters/registry.ts`, 14 adapters). **Grok is present** as a first-class adapter (`grok_local`, "Grok Build").

| Provider (adapterType) | In v1 tab | API key | Interactive login today |
|---|---|---|---|
| Claude (`claude_local`) | ✅ | `ANTHROPIC_API_KEY` (also Bedrock) | Runner exists (`claude auth login`) but **blocks on a paste-code prompt** — cannot self-complete. Key-only in practice. |
| Codex (`codex_local`) | ✅ | `OPENAI_API_KEY` / `auth.json` | ✅ **Fully wired** — `codex login` self-completes via local callback. |
| Gemini (`gemini_local`) | ✅ | `GEMINI_API_KEY` / `GOOGLE_API_KEY` / GCA OAuth | CLI has `gemini auth login` — **not wired** (hint only). |
| Cursor (`cursor`) | ✅ | `CURSOR_API_KEY` | CLI has `agent login` — **not wired**. |
| Cursor Cloud (`cursor_cloud`) | ✅ | `CURSOR_API_KEY` (live-validated) | n/a (managed remote). |
| OpenCode (`opencode_local`) | ✅ | provider-managed | CLI has `opencode auth login` — **not wired**. |
| Grok (`grok_local`) | ✅ | env passthrough only | CLI has `grok login` — **not wired**. |
| Pi (`pi_local`) | ✅ | provider keys (incl. `XAI_API_KEY`) | none. |
| ACPX (`acpx_local`) | shown as "inherits" | inherits Claude/Codex | inherits. |
| Hermes (`hermes_local`) | ❌ | `PAPERCLIP_API_KEY` wire-protocol, JWT-injected | n/a — not a user credential. |
| OpenClaw / Gateway | ❌ | endpoint token in agent config | n/a — per-agent, not shared. |
| `process` / `http` | ❌ | none | n/a. |

**Consequence:** "login for everything" is *not* uniformly achievable today. Stage B must begin with a per-CLI spike (§8) and fall back to "API key + copyable command" for any CLI that cannot be driven from a web UI.

---

## 5. Architecture

### 5.1 Provider descriptor registry (the central new abstraction)

A code-level registry keyed by adapter type. It replaces the hardcoded `"anthropic" | "openai"` enums and the provider ternaries currently scattered across `commander-key.ts`, `commander-login.ts`, and `commander-login-runtime.ts`.

```ts
interface ProviderDescriptor {
  id: string;                    // stable id, e.g. "anthropic"
  label: string;                 // "Claude"
  adapterType: string;           // "claude_local"
  kind: "local_cli" | "managed_api";
  credential: {
    apiKey?: { envVar: string; secretName: string; placeholder: string };
    login?: {
      runner: LoginRunner;           // spawn + URL detection
      resolveAuthHome: (env) => string;
      credentialFile: string;        // completion evidence
      selfCompletes: boolean;        // false → show manual-command fallback
    };
  };
  installHint: { mac: string; win: string; linux: string; docsUrl?: string };
}
```

This is the seam Stage B plugs new logins into — adding a provider becomes a descriptor entry plus a login runner, not a new route.

### 5.2 Reuse (do not fork)

Three pieces are already provider-agnostic and get **promoted**, not rewritten:

- **The probe.** A generic route already exists: `POST /companies/:companyId/adapters/:type/test-environment` (`server/src/routes/agents.ts:530`), which takes an adapter type + config and resolves runtime secrets. The Commander verify route is effectively a founder-gated specialization of it.
- **The classifier.** `classifyCommanderProbe` (`server/src/services/commander-verify.ts:66-79`) maps a probe result to `verified | needs_auth | not_installed | failed` purely by matching check-code substrings (`auth_required`, `command_unresolvable`, `install`). Every local CLI adapter already emits consistent codes (`*_hello_probe_auth_required`, `*_command_unresolvable`). Promote to a shared `classifyProbeOutcome`.
- **The login runner.** `runStreamingLogin` (`packages/adapter-utils/src/streaming-login.ts:51`) can spawn any command and extract a verification URL. It is already provider-agnostic — the anthropic/openai restriction lives only in the Commander service/route.

**Known classifier gaps to fix while promoting:**
- Codes like `codex_openai_api_key_missing` / `cursor_api_key_missing` do **not** contain `auth_required`, so they currently fall through to `verified` via the benign-warn branch. They should classify as `needs_auth`.
- The substring `install` also matches `pi_package_install_failed`, misclassifying a package failure as `not_installed`. Tighten matching to explicit code sets per outcome rather than loose substrings.
- `acpx_local` emits missing-credential checks at `info` level, so an unauthenticated ACPX probe returns `pass` → `verified`. Either raise those levels or special-case ACPX as "inherits".

### 5.3 New routes

Company-scoped. **Writes founder-gated** (matching current `commander-*` guards); **reads** allowed to config-readers (matching the generic probe's `assertCanReadConfigurations`).

| Route | Method | Purpose |
|---|---|---|
| `/companies/:cid/providers` | GET | Descriptors + cached status per provider. |
| `/companies/:cid/providers/:providerId/test` | POST | Run probe, persist result, return outcome. |
| `/companies/:cid/providers/:providerId/key` | POST | Generalized `commander-key` (secret name from descriptor). |
| `/companies/:cid/providers/:providerId/login/start` | POST | Generalized `commander-login/start`. |
| `/companies/:cid/providers/:providerId/login/:challengeId` | GET | Poll status. |
| `/companies/:cid/providers/:providerId/login/:challengeId/cancel` | POST | Cancel pending challenge. |

The existing `commander-verify` / `commander-key` / `commander-login` routes are **re-pointed at these services** and kept as thin wrappers so onboarding continues to work unchanged. A contract test guards that.

### 5.4 Status cache (new table)

Drizzle-only migration (`pnpm db:generate`; never raw SQL — CLAUDE.md rule #1).

`provider_readiness_status`: `companyId`, `providerId`, `outcome`, `checks` (jsonb), `testedAt`, `testedByUserId`. Unique on `(companyId, providerId)`.

Powers D3: instant cached render + "checked 2m ago", refreshed on demand.

---

## 6. Credential model

### 6.1 Resolution chain (D4)

```
agent's adapterConfig.env binding  →  company provider key  →  host CLI login
```

- **Agent binding (unchanged).** `AgentConfigForm` → "Permissions & Configuration" writes `adapterConfig.env[ENVVAR] = { type: "secret_ref", secretId, version }`, materialized into `company_secret_bindings (targetType: "agent")`. This wins over everything. **This design must not rewrite these.**
- **Company provider key (new).** Stored in `company_secrets` (encrypted, versioned) with a descriptor-derived name. Applied when an agent has no explicit binding for that env var.

  **Naming must not collide with the two conventions already in use:** `Commander <provider> API key` (the existing Commander pasted key, written by `commander-key.ts`) and the `llm:<providerId>` slug (the embeddings key, e.g. `llm:openai`, surfaced in Settings → Memory). The descriptor's `secretName` therefore uses a distinct, reserved namespace — `provider:<providerId>` — and the implementation must include a migration/adoption path deciding whether an existing `Commander anthropic API key` row is *reused* as the company key for that provider or left alone as an agent-scoped binding. Recommended: leave existing rows untouched and let the resolution chain (§6.1) pick up the agent binding first, so no in-place rewrite of user data occurs.
- **Host CLI login (existing).** The CLI's own credential file in its shared home.

  **Pre-existing keys MUST be detected, not ignored (required for Task 7/9).** Three secret-name conventions already bind these env vars: `llm:<provider>` (embeddings, Settings → Memory), the legacy env-style name (`ANTHROPIC_API_KEY` itself, still read by `PROVIDER_SECRET_NAMES` in `server/src/services/internal-agent/providers/index.ts`), and `Commander <provider> API key` (`server/src/services/commander-key.ts`, written with `key: envVar`). They are enumerated in `KNOWN_EXTERNAL_SECRET_BINDINGS` in `packages/shared/src/providers/provider-catalog.ts` and pinned by test, so a fourth binding fails CI rather than surfacing in production.

  The Providers tab must therefore look up **every** known binding for a provider's env var and render the card as *already configured* (naming which mechanism supplied it), rather than presenting an empty input. Without this, a founder who pasted an Anthropic key during Commander onboarding sees "no key configured", pastes a second time, and ends up with two secrets claiming one env var — after which a rotation updates only one and the other goes silently stale. Note this is a *detection* requirement only; per the recommendation above, existing rows are still left untouched.

**There is no single runtime chokepoint.** An earlier revision of this document claimed runtime resolution "already flows through the `resolveAdapterConfigForRuntime` chokepoint, which is agent-generic", and the implementation plan's call-site enumeration inherited that error. It is false, and wiring the fallback only into that method leaves the feature **inert for org-agent heartbeat runs — AoA's primary agent execution path**.

The real inventory, verified against `server/src` and pinned by `server/src/__tests__/provider-key-callers.test.ts` (a repo-wide scan, so a seventh path cannot appear unnoticed):

| Path | How it resolves | Where the fallback applies |
|---|---|---|
| `routes/agents.ts` ×3 (opencode constraint check, `:type` probe route, claude-login) | `resolveAdapterConfigForRuntime` | inside that method |
| `services/commander-verify.ts` (Commander probe) | `resolveAdapterConfigForRuntime` | inside that method |
| `services/company-skills.ts` (`usage`) | `resolveAdapterConfigForRuntime` | inside that method |
| `services/internal-agent/aoa-agents/runner.ts` (crew agents) | `resolveAdapterConfigForRuntime` | inside that method |
| **`services/heartbeat.ts` (org agents)** | **assembles `resolvedEnv` itself** from three scope-specific `resolveEnvBindings` calls (project → environment → agent, later winning) so it can record which scope won each key | **applied explicitly at the `resolvedConfig` assignment** |

Both entry points call the same `applyCompanyKeyFallbackForRuntime` service method, which shares one precedence predicate (`needsCompanyKeyFallback`) with the pure merge — so the two paths cannot drift on "when does the company key apply?".

The vault is read **only when the fallback would actually be used**. Resolving unconditionally would fail an agent whose own binding is the credential whenever the vault hiccups, and would write a `secret_access_events` row claiming a key was consumed when it was discarded immediately after.

### 6.2 Scope honesty (D5)

- **API key** → per-company secret. Card label: *"Key saved for this company."*
- **Interactive login** → writes the **host-shared** credential home: `CODEX_HOME ?? ~/.codex`, `CLAUDE_CONFIG_DIR ?? ~/.claude`. Card label: *"Signed in on this machine (shared by all companies on this host)."*

The login slot is keyed `(provider, authHome)` and serialized by a Postgres advisory lock, so two companies on one host cannot log in concurrently — a pending challenge owned by another company returns 409. The UI must surface that conflict as a comprehensible message, not a raw error.

---

## 7. UI surfaces

One shared component (`ProviderReadinessCard` / `ProviderAuthPanel`), three consumers (D6).

1. **Settings → Providers** (new tab). A card per provider: label/icon, status badge (Ready / Needs sign-in / Not installed / Unknown), "checked 2m ago", expandable probe-check detail, and actions `[Test] [Paste key] [Sign in]`. `Sign in` renders only when the descriptor supports a self-completing login; otherwise a copyable install/login command. Not-installed cards show the OS-appropriate install hint.

   Wiring requires four edits: `SettingsSectionId` union + a `SETTINGS_SECTIONS` entry (Operations group) in `ui/src/components/settings/SettingsLayout.tsx`, and `VALID_SECTIONS` + a `renderActiveSection` case in `ui/src/pages/SettingsPage.tsx` (its `default` is an exhaustive `never`, which will force the case).

2. **Agent config page.** A compact readiness badge for that agent's adapter plus a link to Settings → Providers. The existing per-agent key/env fields are untouched. The current passive `AdapterEnvironmentResult` is folded into the shared component so hints become actionable.

3. **Onboarding `VerifyStep`.** Refactored into a thin wrapper over the shared component — one implementation, no drift. Its blocking behaviour (only `verified` advances `COMMANDER_VERIFIED`) is preserved.

---

## 8. Staging

One branch, clean stage boundaries so we can stop and ship at any of them.

**Stage A — framework (delivers the core value)**
Provider descriptor registry · backend genericization (routes + promoted classifier, with the §5.2 classification fixes) · `provider_readiness_status` table · Settings → Providers tab with status + Test + API-key paste for all providers · agent-page readiness badge · onboarding refactored onto the shared component.

**Stage B — interactive login breadth**
Opens with a **per-CLI spike**: for each of Gemini, Cursor, OpenCode, Grok, determine whether its `login` can be driven headlessly (URL emitted? self-completes? requires stdin/browser?). Then wire the ones that can. Any CLI that cannot be driven in-app gets API-key + a copyable command — never a Sign-in button that can't finish.

**Stage C — completion & the reactive half**
Claude paste-code bridge (lets `claude auth login` self-complete) + the runtime error-surfacing fix (§9).

---

## 9. The paired runtime fix

The reactive half of the same problem, folded into Stage C.

- `handleResultEvent` (`server/src/services/internal-agent/parse-stream-json.ts:310`) reads the CLI's stream-json `result` event but **ignores `is_error: true` and `api_error_status`**, unconditionally emitting a successful `done`. An auth-failed run therefore looks like an empty success.
- `streamProcessOutput` (`server/src/services/internal-agent/cli-mode.ts:905`) **never checks the child process exit code**; stderr is only `logger.warn`'d, never surfaced.

**Fix:** emit an `{ type: "error", message }` chunk when `is_error` / `api_error_status` is set (surfacing the CLI's own `result` text), and optionally on a nonzero exit with no content. The UI already handles the `error` SSE event. The message should deep-link to Settings → Providers.

---

## 10. Test strategy

**Unit**
- Descriptor registry completeness — a failing test if any local-CLI adapter lacks a descriptor.
- `classifyProbeOutcome`, table-driven over the **real** check codes emitted by each adapter's `testEnvironment`, including the §5.2 gap cases.
- Secret-name derivation; OS install-hint selection.
- The D4 resolution chain (agent → company → host), including precedence.

**Integration**
- Key save → vault write/rotate → `secret_ref` → `resolveAdapterConfigForRuntime` read-back.
- Login lifecycle: pending → completed / failed / timeout; same-company takeover; cross-company 409; cancel; orphan reaper with PID-identity verification.
- Probe caching: write-through, staleness stamp, in-use auto-refresh selection.

**Contract**
- Shapes of the six new routes.
- **Regression guard:** re-pointed `commander-*` routes keep onboarding's existing contract.

**E2E (Playwright)**
- Providers tab renders cached status without spawning probes.
- `Test` updates a card's status + timestamp.
- Paste key → status flips to Ready.
- Onboarding Verify still passes end-to-end.

**Regression (explicit)**
- Saving a company-level provider key does **not** modify any agent's `adapterConfig.env` bindings.

**Security**
- Founder-gating on all write/login routes; config-reader access to reads.
- Cross-tenant login-slot conflict behaves correctly.
- No plaintext key in any response, log line, or audit row.

---

## 11. Risks & open items

| Risk | Mitigation |
|---|---|
| Some CLIs' `login` may be undrivable from a web UI (browser OAuth / stdin prompt). | Stage B opens with a spike; fall back to API-key + copyable command. Never render a dead Sign-in button. |
| Claude login blocks on a paste-code prompt. | Deferred to Stage C as an explicit bridge task; Claude is key-only until then. |
| Host-shared login is surprising on multi-company hosts. | D5 labelling + explicit 409 conflict copy. |
| Loosening the classifier could change onboarding's blocking behaviour. | Contract + E2E regression tests on `VerifyStep` before touching the classifier. |
| Large single branch. | Stage boundaries are independently reviewable and shippable. |

**Open (deferred, not blocking):** per-agent `authHome` isolation. The plumbing partially exists (codex has a managed per-company home; `CODEX_HOME` / `CLAUDE_CONFIG_DIR` are honoured), but the login runtime does not thread it. Revisit only if per-agent credential isolation becomes a real requirement.

---

## 12. Practical setup note

The current worktree sits on a deep OneDrive path where the embedded Postgres `initdb` fails (the share-file path is 261 chars, 1 over Windows `MAX_PATH`, and the bundled `initdb.exe` is not long-path aware). Implementation and verification should use a worktree at a short path (e.g. `C:\Users\TK\.aoa\wt\<name>`) so each stage can be verified against a running instance.

---

## Appendix: cross-provider credential dependencies (UI note)

A provider can depend on another provider's credential in **two** ways, and the UI must render both:

1. **`credentialOwnerId`** (guarded, modelled) — the provider stores nothing of its own; it reads the owner's secret. `pi → anthropic`, `cursor_cloud → cursor`. The card must link to the owner rather than offering a second input, since two inputs writing one secret means saving either silently overwrites the other.
2. **`alternativeEnvVars` naming another provider's primary** (display-only) — e.g. Cursor also accepts `OPENAI_API_KEY`, which is Codex's primary. So saving a Codex key can also authenticate Cursor.

Case 2 is safe at the storage layer: `alternativeEnvVars` is READ-ONLY by contract (nothing is ever written under an alternative), so no duplicate secret can arise. It is nonetheless **invisible to the founder** unless the card says so. The Providers tab should surface it as informational context ("also satisfied by your Codex key"), not as a second credential input.

---

## Merge contract: CLI auth detection branch

Sibling branch `claude/signup-onboarding-ui-animations-0724cb` adds auth-failure *detection*
(a shared `detectAuthFailure()` in `packages/adapter-utils`, plus probes emitting
`*_hello_probe_auth_expired`). The two branches are complementary — detection there,
classification here — but they touch the same code. Rules for the merge:

**1. Non-negotiable — do NOT reintroduce these two lines.** Their Task 6 rewrites
`classifyCommanderProbe`'s body starting with `if (result.status === "pass") return verified`
and ending with `if (result.status === "warn") return verified`. Both were deliberately
removed here. ACPX emits missing-credential checks at **info** level, so an
unauthenticated probe returns `status: "pass"` — the first line reports it **Ready**.
That is the exact false-green this feature exists to eliminate, and it fails silently:
no error, no test failure, just a founder told everything works when nothing is signed in.

**2. Retarget, don't re-fork.** Their Task 6 edits `server/src/services/commander-verify.ts`.
On this branch that body was promoted to `server/src/services/providers/classify-probe.ts`
and `classifyCommanderProbe` is now a thin delegate. Apply their change to
`classify-probe.ts` so it benefits BOTH onboarding and the Providers tab. Applying it to
`commander-verify.ts` recreates two divergent classifiers — the condition Task 4 removed.

**3. Already done here — no merge work needed.** `"_auth_expired"` is in
`AUTH_FAILURE_SUFFIXES` as of this commit, so expired sessions already classify as
`needs_auth`. Note ours matches the code **suffix**; theirs uses a loose
`.includes("auth_expired")`. Keep the suffix form — it is stricter and is pinned by test.

**4. Still to adopt from them — the text/detail fallback.** When no code matches, run the
concatenated `message`/`detail` blob through their `detectAuthFailure()` and classify
`needs_auth` if it reports anything but `none`. Deliberately NOT implemented here:
`detectAuthFailure` lives in their `packages/adapter-utils`, and duplicating it would
create two detectors. **Placement is critical — it must sit BELOW rule 2 (authoritative
live success).** Above it, a probe that genuinely succeeded but whose detail quotes an
earlier 401 would flip to `needs_auth`. Suggested position: between rule 5 (credential
hints) and rule 6 (`status === "fail"`).

**5. Also overlapping.** Both branches modify `ui/src/onboarding/steps/VerifyStep.tsx` —
this branch added outcome handling plus the shared `isNonBlockingProbeOutcome` predicate;
theirs adds expired-case copy. Semantically compatible; expect a textual conflict only.
