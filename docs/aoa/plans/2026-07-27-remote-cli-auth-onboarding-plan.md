# AOA remote CLI authentication and resilient onboarding plan

**Date:** 2026-07-27
**Status:** Reviewed by CEO, design, engineering, and DX passes
**Primary target:** Hosted AOA on Hetzner/Linux at `testing.armyofagents.org`
**Supported targets:** Linux, macOS, and Windows; native and containerized installs

## Outcome

AOA onboarding must detect the runtime topology, offer only authentication flows
that can finish in that topology, isolate subscription credentials by company and
user, verify API keys with actionable errors, remain dark and scrollable at every
viewport, and use AOA as the canonical product and filesystem name.

This plan fixes both reported failures:

1. API keys are accepted, stored through the existing secret system, and verified
   by a real provider call with structured failure classification.
2. Subscription sign-in uses a remote-safe flow: Claude URL plus pasted code;
   Codex device authorization. A hosted server never asks a user's browser to
   complete a callback on the server's `localhost`.

## Verified current state and root causes

| Area | Verified state | Root cause / risk |
|---|---|---|
| Deployment | The testing deployment pipeline completed and `/api/health` is healthy. | This is not a failed Hetzner deployment. |
| CLI installation | The Docker image installs both Claude Code and Codex. | Installing either CLI on the Hetzner host does not help; AOA executes the binaries inside its container/runtime. |
| Codex verification | `/app` is valid and `codex` resolves, but the live hello probe fails. | The probe can fail outside a trusted Git repository unless the adapter supplies the supported skip flag; the UI currently hides `check.detail`, so the exact cause is obscured. |
| Codex subscription | Current code starts ordinary `codex login`, whose callback listener is container-local. | A laptop browser resolving `localhost` cannot reach a listener inside the remote container. |
| Claude subscription | Current code can surface the Claude URL and write a pasted code to the live CLI process. | This is remote-capable, but credentials are written to a host-shared home and lifecycle/error handling is not modeled as a provider capability. |
| Credential isolation | `resolveAuthHome` receives provider environment only; current Docker homes are shared. | One company/user can overwrite, contend with, or accidentally reuse another tenant's subscription credentials. |
| API-key path | Secret resolution and adapter probes already exist. | Probe failures are inferred from free-form codes/text and the Verify screen omits diagnostic detail. |
| Verify layout | `body` is `overflow: hidden`; the step grows naturally and has no bounded vertical scroll region. | Long checks/auth panels can extend beyond the viewport and become unreachable. |
| Dark appearance | Onboarding uses a scoped dark token set, while the global theme can still change with stored/system preference. | Inspect/device emulation can expose a light body/root, a theme transition, or a render failure. The exact white-screen trigger needs a captured browser error and computed-style assertion. |
| Naming | Runtime data is mounted at `/paperclip`; PostgreSQL defaults also retain the legacy name. | A direct rename can orphan existing named-volume data or break rollback. |

## Premises

1. AOA runs local CLI agents; this work does not replace them with provider cloud
   agents.
2. Operating system and deployment topology are separate dimensions.
3. A subscription login may be offered only when the installed CLI exposes a
   browser-safe, non-loopback flow that AOA can complete.
4. Hosted multi-tenant subscription credentials must never share a credential
   home.
5. A successful auth process exit or credential-file presence is evidence, not
   proof; the provider probe is the final authority.
6. Legacy wire identifiers remain only where `docs/architecture/wire-compat.md`
   requires them. New display text, paths, logs, and identifiers use AOA.
7. Shared hosted storage of a human subscription session is a product/security
   policy decision, not merely an implementation detail. It is disabled until
   official-provider eligibility and AOA ownership rules are approved.

## Gate 0: provider policy and execution ownership

Before enabling subscription auth in a hosted multi-tenant deployment, record an
approved matrix for each provider/auth mode:

- supported deployment profiles;
- interactive versus unattended-use eligibility;
- personal, business, and enterprise-account restrictions;
- who owns the credential and who may execute with it;
- revocation, suspension, offboarding, and audit behavior;
- official provider evidence and the date/version checked;
- an operator kill switch for that provider/auth mode.

Safe policy until this gate passes:

- Local single-user: API key or personal subscription, subject to provider rules.
- Remote company-dedicated: API key; personal subscription only when explicitly
  enabled for that user and execution target.
- Hosted multi-tenant: company API keys by default; subscription auth disabled.

Gate 0 has two independent approvals:

1. Provider/product policy permits the intended account and execution use.
2. The execution target supplies a real tenant/user security boundary. Separate
   `0700` directories owned by the same OS user provide routing isolation only;
   they are not security isolation.

Credential ownership is explicit:

- `personal_subscription`: belongs to one user, never silently reassigned.
- `company_api_key`: belongs to one company and is suitable for governed automation.
- future `company_service_identity`: reserved for provider-supported service identity.

User departure, suspension, or revocation pauses dependent runs and surfaces a
repair action. AOA never falls back to another user's subscription.

## Scope

### In scope

- AOA canonical container home (`/aoa`) with a staged legacy-path migration.
- Runtime capability/topology detection for Linux, macOS, and Windows.
- Remote-safe Codex and Claude subscription flows.
- Company/user-scoped subscription credential homes.
- API-key save, validation, redaction, and structured errors.
- Honest installation and verification diagnostics.
- Dark-mode stability, responsive layout, scrolling, accessibility, and long-error handling.
- Unit, integration, browser, container, deployment, security, migration, and rollback tests.
- Provider CLI version pinning and compatibility checks.

### Not in scope

- Replacing CLI adapters with OpenAI or Anthropic cloud-agent products.
- Automating identity-provider credentials or bypassing provider terms.
- Renaming frozen plugin, HTTP, database-row, or external integration wire contracts.
- Supporting additional CLI providers before their login capabilities are measured.
- General redesign of onboarding steps unrelated to Commander authentication.

## Target architecture

```text
Browser
  |
  v
VerifyStep / Provider readiness UI
  |
  v
Topology + capability policy
  |---------------------|----------------------|
  v                     v                      v
API key              Claude subscription    Codex subscription
encrypted secret     URL + pasted code       device URL + user code
  |                     |                      |
  +-----------> tenant-scoped runtime environment <-----------+
                         |
                         v
                  provider-specific probe
                         |
                         v
        verified | auth_required | key_invalid | billing
        rate_limited | network | unsupported | cli_error
```

## 1. Detect topology and capabilities

Add a server-owned runtime descriptor rather than inferring behavior from browser
hostnames. Model three independent axes:

```ts
type RuntimePlatform = "linux" | "darwin" | "win32";
type NetworkLocation = "local" | "remote";
type TrustBoundary = "single_user" | "single_tenant" | "multi_tenant";
type ExecutionOwnership = "aoa_hosted" | "tenant_hosted" | "user_hosted";
type InstallProfile =
  | "local_single_user"
  | "remote_single_tenant"
  | "hosted_multi_tenant";

type ProviderAuthCapability = {
  provider: "openai" | "anthropic";
  cliInstalled: boolean;
  cliVersion: string | null;
  apiKey: boolean;
  subscriptionMode: "loopback" | "device_code" | "paste_code" | "manual" | "none";
  browserSafeRemotely: boolean;
};
```

Resolution rules:

- `AOA_INSTALL_PROFILE` is the required high-level operator setting; advanced
  overrides are `AOA_NETWORK_LOCATION`, `AOA_TRUST_BOUNDARY`, and
  `AOA_EXECUTION_OWNERSHIP`.
- Precedence is explicit axis override → install profile → safe installer
  recommendation. Conflicting values fail startup with a problem/cause/fix error.
- Docker authenticated/public recommends but does not silently select
  `hosted_multi_tenant`; native private setup recommends `local_single_user`.
- The install profile explicitly records all three axes. Deployment mode and
  exposure may recommend values but cannot establish a security boundary.
- Ambiguous installs fail closed for subscription auth and require an operator
  choice during bootstrap.
- `process.platform`, container detection, executable lookup, and CLI version
  determine installation mechanics and capability, not tenant policy.
- The server publishes a read-only descriptor to onboarding. The browser never
  decides whether a flow is safe.
- Capability adapters own supported commands and output parsers by pinned CLI
  version. Unsupported/unknown versions disable subscription sign-in with a
  specific upgrade/downgrade message.

Do not offer ordinary loopback Codex OAuth in either remote topology.

## 2. Canonical AOA filesystem path and migration

Make `/aoa` canonical in the image, Compose file, entrypoint, examples, logs, and
new tests:

- `HOME=/aoa`
- `AOA_HOME=/aoa`
- `AOA_CONFIG=/aoa/instances/<id>/config.json`
- `aoa-data:/aoa`

Migration must preserve the existing `aoa-data` named volume. Changing its mount
target does not change the volume contents. For one major compatibility window:

- Create `/paperclip -> /aoa` as a legacy symlink in the image.
- Warn once when a legacy environment/path is observed.
- Keep legacy `PAPERCLIP_*` environment reads and frozen wire identifiers only
  as documented compatibility aliases.
- Never write new state through the legacy path.
- Record a data-layout version sentinel and an image/Compose compatibility
  version. Startup fails closed when data is visible at an incompatible mount;
  it must never silently initialize an empty installation.
- Document rollback: the previous image must be started with the same volume
  explicitly mounted at its old target.
- Do not rename the PostgreSQL database in this change. That is a separate
  operator migration with materially higher rollback risk; only remove the
  legacy product word from user-visible/default-new-install surfaces where a
  safe dual-read path exists.

Add a CI brand rule: new occurrences of the legacy product word fail unless the
line is in the documented wire-compat allow-list or migration documentation.

## 3. Credential ownership, binding, and execution isolation

Replace global credential homes with target-scoped homes:

```text
/aoa/execution-targets/<target-id>/auth/<company-id>/<user-id>/openai
/aoa/execution-targets/<target-id>/auth/<company-id>/<user-id>/anthropic
```

Requirements:

- Resolve with `(executionTargetId, companyId, userId, provider)`, never
  provider/environment alone.
- Use opaque validated IDs; never concatenate untrusted path fragments.
- Create directories mode `0700`; credential files remain provider-native and
  are never returned through the API.
- Run the CLI with only its scoped home:
  - Codex: `CODEX_HOME=<scoped path>`
  - Claude: `CLAUDE_CONFIG_DIR=<scoped path>`
  - Set `HOME` to a non-shared AOA execution home where the CLI also inspects it.
- Login challenge uniqueness becomes `(companyId, userId, provider, authHome)`.
- Status, submit-code, cancel, probe, and agent execution enforce the same scope.
- Revoke/delete removes only the selected user's provider credential directory
  after an explicit confirmation and audit entry.
- Record activity without URL query strings, codes, tokens, API keys, or
  credential contents.

The directory scheme provides deterministic routing. In a shared process running
as one Unix user it does not prevent a compromised CLI/agent from reading sibling
directories. Therefore hosted multi-tenant subscription auth stays disabled until
the execution target uses a tenant/user-owned worker, container, VM, or separate
OS identity with only that credential mounted.

Add explicit logical records:

- `provider_credentials`: company, provider, owner user, execution target, kind,
  state, verified/revoked/suspended timestamps.
- `agent_provider_credential_bindings`: agent, credential, approving actor,
  approval and audit timestamps.

At run start, resolve exactly one governed binding. Never choose the current
founder, first available credential, or an ambient shared home. A revoked,
suspended, departed-owner, or target-mismatched credential pauses dependent runs.
Deliver credentials to an isolated worker or ephemeral per-run home.

If Gate 0 later permits subscriptions in `multi_tenant`, they remain per-user,
per-company, per-execution-target, and bound to specific governed consumers.
Company-shared automation should use a company API-key secret.

The challenge and credential APIs remain execution-target-neutral so a future
tenant-owned or user-owned worker can hold provider credentials without putting
them in the AOA control plane. Add an ADR comparing central hosted, company-
dedicated, user-owned, and remotely paired workers before broad rollout.

## 4. Remote-safe subscription flows

### Claude

- Run the pinned supported `claude auth login --claudeai` command in the scoped home.
- Parse and return only an allow-listed HTTPS authorization URL.
- Keep stdin piped; accept the one-time pasted code over the existing
  company/user-scoped challenge endpoint.
- Treat codes as secrets: bounded length, never logged/persisted/echoed, rate
  limited, cleared after delivery.
- On restart or lost in-memory child, return `challenge_expired` and offer Start again.
- Re-probe after process completion; only a successful live probe marks verified.

### Codex

- Replace ordinary `codex login` with the pinned CLI's device authorization mode
  (`codex login --device-auth`, subject to a compatibility contract test).
- Parse a provider HTTPS verification URL, human-readable device code, and expiry.
- Return structured `{ verificationUrl, userCode, expiresAt }`; never return a
  container-loopback URL.
- Poll challenge status with bounded backoff and support cancel/expiry/restart.
- Re-probe after completion; never trust exit code or `auth.json` presence alone.
- If the installed version does not support device authorization, disable the
  button and show the exact supported version range.

Challenge logical identity is `(executionTargetId, companyId, userId, provider)`;
physical `authHome` is derived only inside the owning worker and is never used for
authorization. Enforce one pending challenge with a partial unique database index.
Start/status/code/cancel predicates include company, provider, target, and owner
user. A separate operator-only cancellation path cannot view or submit auth material.

For R1, run one dedicated login-worker replica. Before horizontal scaling, add a
runtime-instance ID, lease generation/heartbeat, and owner-routed commands; only
the owning runtime may signal its PID.

Authorization URLs/codes are memory-only by default. A browser refresh can poll
status but must Start again to recover actionable material. The alternative—
encrypted short-lived material with strict TTL—requires a separate security review.

### Local single-user exception

AOA may support a loopback flow only when a capability test proves the browser and
CLI callback share the same machine. Device/paste-code remains the preferred
uniform path because it behaves consistently across native and container installs.

## 5. API-key flow and real error classification

Use the existing secret-binding system and make the probe contract structured:

```ts
type ProviderProbeFailure =
  | "missing_key"
  | "invalid_key"
  | "insufficient_scope"
  | "billing_or_quota"
  | "rate_limited"
  | "network"
  | "tls_or_proxy"
  | "model_unavailable"
  | "cli_not_installed"
  | "cli_version_unsupported"
  | "working_directory"
  | "provider_error"
  | "unknown";
```

Rules:

- Validate format only as an early hint; never claim validity from prefix alone.
- Save as an encrypted company/user-scoped secret reference, not plaintext agent config.
- API keys remain company-scoped in this work; subscription credentials are user-owned.
- Validate an encrypted candidate before activation. A confirmed invalid candidate
  never replaces the active key. A transiently unverifiable candidate may be kept
  inactive only after explicit user confirmation. Activate atomically and retain
  version metadata for rollback.
- Probe with a minimal, bounded provider request; avoid unnecessary token spend.
- Set explicit timeout, cancellation, retry-after handling, and no automatic retry
  for invalid credentials.
- Redact credential-like substrings from stdout, stderr, exceptions, activity, and telemetry.
- Return stable `code`, safe `summary`, actionable `remediation`, optional
  `supportId`, and sanitized `detail`.
- Render `detail` in a collapsed “Technical details” disclosure with Copy details;
  never expose raw environment or secrets.
- For Codex execution probes outside Git repositories, pass the supported
  `--skip-git-repo-check` flag or run in a generated trusted workspace. Cover the
  exact command in a contract test.
- Prefer a direct minimal provider HTTP request for API-key validity and stable
  HTTP error classification, while separately confirming the CLI receives the
  resolved secret. This does not replace CLI execution.
- Report readiness as separate dimensions: credential recognized, provider
  reachable, billing/entitlement, requested model available, and CLI compatible.
  A transient outage must not replace the active credential. Report the failure
  as retryable without mislabeling the candidate invalid.

## 6. Onboarding UX, dark-mode stability, and scrolling

### Information hierarchy

The provider is derived from the configured Commander adapter; Verify is not a
provider picker. If no provider resolves, link back to Commander environment
configuration.

1. Context chip: provider/CLI and detected execution environment.
2. Current state: Ready, Needs sign-in, Not installed, Unsupported version, or Check failed.
3. One “Recommended for this installation” action with credential ownership and
   billing explanation.
4. Alternatives (API key or subscription) behind a disclosure and only when supported.
5. Expandable check details and support ID.

Copy must distinguish:

- API key: provider API billing; company credential when stored at company scope.
- Subscription: the user's provider account; personal credential tied to that user.
- Policy-disabled: why the method is unavailable and where the operator can review policy.

### Layout

- Make the onboarding route the only vertical scroll owner on mobile and at zoom.
- Replace the body-dependent layout with a shell using `min-height: 100vh` plus
  `min-height: 100dvh`,
  `overflow-y: auto`, safe-area padding, and an inner content column.
- Do not vertically center a step once its content exceeds the viewport.
- Show failed checks first plus a count; put the full list behind “Show all”.
  A capped internal checks scroller is permitted only at a desktop breakpoint
  and never in narrow, zoomed, or forced-colors layouts.
- Wrap unbroken URLs/error strings with `overflow-wrap:anywhere`.
- Keep the primary action reachable; on small screens it may be sticky inside the
  shell only when it cannot overlap content or the visual keyboard. Include
  sufficient bottom safe-area padding.
- Order narrow/short-height screens as context → status → action → diagnostics.
  Shrink or hide the decorative mascot before it can push recovery below the fold.

### Theme

- Set a static dark boot background on `html`, `body`, and `#root` before JavaScript.
- The onboarding route owns tokens through
  `[data-aoa-onboarding-theme="dark"]`; it must not depend on `html.dark`.
- Set background, foreground, and `color-scheme: dark` on the onboarding shell
  and all portal surfaces.
- Do not mutate the user's saved global theme merely to render onboarding.
- Mount an onboarding error boundary above FlowEngine and theme-sensitive
  children, with a dark fallback, support ID, Retry, and Copy diagnostics.
- Add a static root-bootstrap fatal fallback for failures that occur before React
  or above that boundary.
- Capture `window.error` and unhandled rejections in QA builds with redacted details.
- Navigating into and out of onboarding restores the saved global preference
  without a white frame.

### Required states

Loading, idle, checking, ready, needs auth, invalid API key, expired challenge,
unsupported CLI version, CLI absent, offline/network failure, rate limit, provider
outage, partially parsed output, cancelled, and unexpected/render error.

If Commander is not yet operational, onboarding offers an explicit Configure
later path that records a waiver/degraded state rather than claiming verification.
Optional additional providers never block the rest of AOA.

“Configure later” is offered only for approved unavailable/transient states, not
invalid credentials or a policy/security failure. The CTA reads “Continue with
Commander unavailable,” lists what remains disabled, lands on a persistent
repair banner, and links back to the same setup flow.

### UI state and transition contract

| State | Primary action | Secondary action | Exit and focus behavior |
|---|---|---|---|
| Checking | Disabled “Checking…” | Cancel only if safe | `aria-live=polite`; no overlapping checks |
| Needs auth | Recommended method | Expand alternatives | Focus outcome heading |
| API key editing | Save and verify | Cancel | Invalid key focuses field; transient failure leaves the active key unchanged |
| Device challenge | Continue at provider + Copy code | Cancel | Show provider hostname, expiry, Start again after expiry |
| Paste-code challenge | Submit code | Cancel | Keep code on transient network failure; clear after accepted/expired |
| Polling/return | “Waiting for provider…” | Check now / Cancel | Resume after tab refresh when durable; announce milestones, not every second |
| Concurrent challenge | Rejoin owned challenge or Try later | Cancel owned challenge | Explain 409 without exposing another tenant/user |
| Post-login probe failed | Recheck readiness | Start sign-in again when auth-specific | Never claim connected from process exit alone |
| Ready | “Connected and verified” | View checks | Announce success, then move destination focus predictably |
| Policy disabled | Use company API key | View policy | Disabled subscription control explains why |
| Render/bootstrap error | Retry | Copy support ID | Dark fallback receives focus |

Additional interaction requirements:

- Authorization actions show the allow-listed provider hostname; full
  query-bearing URLs are not rendered as visible text or included in diagnostics.
- External-link controls state that a new tab opens and provide a Copy link fallback.
- Device codes are labelled readonly values with a 44px Copy control.
- Use `role=alert` for failures, visible focus, non-color icons plus text, WCAG AA
  contrast, reduced-motion behavior, and static decorative animation when requested.
- Every message follows Problem → likely cause → next action; technical details are
  collapsed and omitted entirely if sanitization fails.

## 7. Installation behavior

- Docker/release images install pinned, tested Claude and Codex versions.
- Native installs detect missing binaries and show OS-specific commands from a
  versioned provider manifest.
- AOA never claims to have installed a CLI until a post-install `--version` check
  succeeds under the same runtime user and PATH as agent execution.
- Hosted Docker UI describes the binary as “installed in the AOA runtime,” not
  “installed on your server.”
- Add an `aoa doctor`/diagnostic endpoint or command output for topology, platform,
  runtime user, safe PATH locations, CLI versions, writable scoped homes, and
  provider reachability. It must never print credentials.
- The onboarding capabilities endpoint returns only sanitized enums and supported
  methods. Detailed runtime user, PATH, mount, and doctor data is operator-only.
- Cache executable/version detection per execution target with bounded refresh.
- Add per-user, per-company, and per-runtime challenge/process limits with
  database enforcement, `429`/`Retry-After`, boot cleanup, and terminal-row retention.
- Container canonical storage is `/aoa`; native Linux/macOS use the platform user
  data directory/`~/.aoa`; Windows uses validated local application data plus ACL
  handling. Platform paths are never persistent logical identities.

## API and data-contract changes

- `GET /api/runtime-capabilities` returns topology/platform/provider capabilities.
- Login start response becomes a discriminated, one-time challenge:

```ts
type LoginChallenge =
  | { kind: "paste_code"; challengeId: string; verificationUrl: string; expiresAt: string }
  | { kind: "device_code"; challengeId: string; verificationUrl: string; userCode: string; expiresAt: string };
```

- All login routes require authenticated user and company access; challenge
  ownership includes `startedByUserId`.
- Add stable structured probe-error fields to shared types without breaking
  existing `checks[]` consumers.
- Persist no authorization URL query string or one-time code. Persist only opaque
  IDs, status, provider, scope, runtime owner/lease, timestamps, PID identity
  evidence, and sanitized failure code.
- Database migration adds/updates indexes for company/user/provider challenge
  scope. Generate through the repository migration workflow.
- Capabilities are target-scoped:
  `GET /api/execution-targets/:executionTargetId/capabilities`, with `checkedAt`
  and operator-authorized Refresh. There is no ambiguous global capability result.

Stable error envelope:

```ts
type AoaReadinessError = {
  code: string;
  problem: string;
  likelyCause: string;
  nextAction: string;
  retryable: boolean;
  docsUrl: string;
  supportId: string;
  detail?: string; // sanitized or omitted
};
```

Canonical mappings include invalid key, billing/quota, rate limit, TLS/custom CA,
proxy/egress, non-Git Codex workspace, unsupported CLI version/output, expired
challenge, lost login worker, and provider/model unavailable. Tests assert exact
problem/cause/action copy rather than enum names alone.

## Delivery sequence

### R0 — immediate diagnostic and layout recovery

1. **Observability and reproduction**
   - Surface sanitized `check.detail`.
   - Add support IDs and dark error boundary.
   - Reproduce the white-screen trigger and long-content failure in Playwright.
   - Fix the non-Git Codex probe and prove the exact container command.
2. **Responsive onboarding**
   - Single scroll owner, dark containment, long-content behavior, accessibility.

### R1 — Hetzner/Linux auth recovery behind flags

3. **Capability foundation**
   - Runtime topology descriptor, provider capability interface, pinned versions,
     and unsupported-version behavior.
4. **API-key verification**
   - Structured classifier, minimal direct validation, CLI environment verification,
     timeout/rate-limit/billing/network errors.
5. **Remote-safe login on an approved dedicated QA profile**
   - Codex device authorization and Claude paste-code, both kill-switch protected.
6. **First-turn gate**
   - Run or offer one bounded Commander hello turn after readiness, reporting
     credential, reachability, model, and CLI dimensions independently.

### R2 — hosted credential boundary

7. **Credential isolation**
   - Explicit credential records/bindings, DB constraints, authorization checks,
     ownership lifecycle, and execution-target-neutral login contracts.
   - A real per-tenant/user execution boundary; same-UID directories are
     documented only as routing isolation.
   - Hosted multi-tenant subscription remains disabled unless Gate 0 passes.

### R3 — canonical home and broader platforms

8. **AOA home migration**
   - `/aoa` canonical image/Compose/entrypoint plus legacy symlink and rollback docs.
9. **macOS/Windows native support**
   - Platform-specific installation, process, permissions, and auth matrix.
10. **Deployment canary**
   - Backup, migrate testing, run live matrix, observe, then promote.

Each phase lands independently with tests and a rollback point. Do not combine
filesystem migration, tenant isolation, both providers, and UI layout in one
unreviewable release.

R0/R1 release gates cover only the explicitly dedicated Hetzner Linux Docker QA
target. R2 and R3 tests do not block that incident recovery. Each later release
adds its own acceptance gate before production enablement.

## Operator and recovery interfaces

Choose one supported diagnostic contract:

```sh
aoa doctor
aoa doctor --json
```

The machine-readable schema and exit codes are stable. Checks include build,
install profile, execution target, CLI path/version compatibility, scoped-home
writability, network/TLS/proxy reachability, database/layout version, and effective
provider policy. `--offline` skips network probes. Output is redacted; the UI
“Download diagnostics” action uses the same schema and excludes raw environment,
credentials, query-bearing URLs, and one-time codes.

Dedicated local/single-tenant escape hatch:

```sh
aoa auth login --provider codex --execution-target <id> --owner <user-id>
aoa auth login --provider claude --execution-target <id> --owner <user-id>
```

The command resolves the same governed credential record and execution target as
the UI. It never asks operators to hand-construct `HOME`, `CODEX_HOME`, or
`CLAUDE_CONFIG_DIR`. Disable this command for shared multi-tenant targets unless
Gate 0 is fully satisfied.

## Documentation deliverables

- Five-minute existing-Hetzner recovery quickstart.
- Auth-mode and credential-ownership decision guide.
- API-key setup/troubleshooting guide with billing distinction.
- Codex device-auth guide.
- Claude paste-code guide.
- `aoa doctor` and support-bundle guide, including exact Docker invocation.
- `/aoa` upgrade, incompatible-layout, rollback, and backup-restore guide.
- Provider policy/admin guide and effective-settings reference.

Every stable error code links directly to the relevant anchor. Commands are
copy/paste tested on Linux before R1.

## DX success budgets

Measured from a healthy deployed AOA screen to the first successful Commander turn:

- Existing Hetzner API key: p50 ≤3 minutes, p90 ≤5 minutes.
- Approved subscription flow: p50 ≤7 minutes, p90 ≤10 minutes.
- Fresh Docker installation to first turn: ≤15 minutes.
- Diagnostic identification and documented repair: ≤10 minutes.

Collect milestone durations and retry counts without auth material.

## Test diagram

| Codepath / user flow | Unit | Integration | Browser/E2E | Live/container |
|---|---|---|---|---|
| Topology defaults and override | Matrix by mode/platform | Capabilities route/authz | Correct options shown | Linux Docker + native smoke |
| Legacy volume at new `/aoa` target | Path resolver | Bootstrap existing fixture volume | N/A | Upgrade and rollback rehearsal |
| Scoped auth-home construction | Traversal/permission cases | Cross-company/user isolation | User sees only own status | Inspect runtime UID/mode |
| Credential binding | State/owner transitions | Agent→credential→target authz | Repair/offboarding states | Adversarial sibling-read denial |
| Claude URL + pasted code | Parser/stdin/redaction | Start/status/code/cancel/restart | Full mocked state machine | Real clean-home login |
| Codex device code | Parser/version/expiry | Start/poll/cancel/restart | Full mocked state machine | Real clean-home login |
| API key | Classifier table | Secret save/resolve/probe/authz | Invalid/rate-limit/network UI | Real disposable low-value keys |
| Key rotation | Candidate state machine | Concurrent atomic activation | Working key survives invalid replacement | Rollback active version |
| Codex hello probe | Exact argv | Non-git workspace | Error detail disclosure | `/app` container probe |
| Long Verify content | Component snapshots/DOM | N/A | 20+ checks, long URL/error | Chrome/Firefox/WebKit |
| Dark stability | Theme state tests | N/A | reload, Inspect viewport, system emulation, render crash | QA deployment |
| Accessibility | Component semantics | N/A | keyboard, focus, axe, 200% zoom | Manual screen-reader pass |

## Detailed verification matrix

### Platforms and packaging

- Ubuntu current LTS Docker/Compose (primary Hetzner path).
- Ubuntu native process.
- macOS current and previous major, native.
- Windows 11 PowerShell/native.
- Container runtime user UID/GID changed from default.
- Reverse proxy HTTPS with forwarded host/proto.

### Viewports and appearance

- 320×568, 390×844, 768×1024, 1366×768, 1440×900.
- 100%, 125%, 200%, and 400% browser zoom where practical.
- Dark, light, and system global preferences; onboarding remains dark.
- DevTools docked left/right/bottom and responsive device emulation.
- Reduced motion, keyboard-only, high contrast/forced colors where supported.

### Security and tenancy

- Company A cannot read, cancel, submit to, probe, or reuse company B's challenge.
- Two users in one company do not share subscription credentials.
- A process executing Company A work cannot open Company B credential files at the
  runtime boundary; a same-UID directory-only design fails this gate.
- Path traversal IDs cannot escape `/aoa/auth`.
- API keys, pasted codes, device codes, callback URLs, and tokens do not appear in
  logs, DB activity payloads, browser telemetry, or error bodies.
- Login endpoints are rate limited and CSRF/origin protections remain effective.
- Authorization URLs are HTTPS and match provider host allow-lists.
- Symlink/path checks prevent credential writes through attacker-controlled links.
- Two application instances cannot signal each other's PIDs or bypass challenge limits.

### Required repository checks

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

Also run focused suites for adapter login, Commander login/verify/key routes,
provider readiness, onboarding, theme/storage migration, Docker bootstrap, and
Playwright browser tests.

## Acceptance criteria

1. A fresh hosted Linux deployment detects `hosted_multi_tenant` and never offers
   loopback Codex OAuth.
2. On an approved remote single-tenant/dedicated QA execution target, Codex
   subscription sign-in completes through device authorization and a live probe.
3. On an approved remote single-tenant/dedicated QA execution target, Claude
   subscription sign-in completes through URL plus pasted code and a live probe.
4. Company/user credentials are isolated and cross-tenant tests prove no shared state.
5. Valid API keys verify; invalid, billing, rate-limit, model, proxy/TLS, and
   network failures show distinct problem/cause/fix messages.
6. Existing `aoa-data` survives migration to `/aoa`; a documented rollback rehearsal succeeds.
7. The Verify screen remains fully reachable with 20+ long checks at 320×568 and 200% zoom.
8. Opening/docking DevTools and emulating light/system preferences cannot turn the
   onboarding route white.
9. A render failure produces a dark recovery screen, never a blank page.
10. No new non-allow-listed legacy product-name occurrences are introduced.
11. R0/R1 repository checks and the dedicated Hetzner/Linux matrix pass before
    incident-release promotion; later platform/migration matrices gate R2/R3 only.
12. Shared hosted subscription auth cannot be enabled without Gate 0 approval and
    a provider-specific operator flag.
13. On a hosted multi-tenant target without Gate 0 approval, subscription controls
    are unavailable with a plain reason, company API key recommendation, and policy link.
14. An invalid replacement API key leaves the previous active key untouched.
15. All four old/new image × old/new Compose combinations either locate the same
    data safely or fail closed with remediation; none silently bootstraps empty state.

## Deployment and rollback

1. Snapshot the Hetzner volumes and database.
2. Deploy to testing with feature flags:
   - `AOA_SCOPED_CLI_AUTH`
   - `AOA_CODEX_DEVICE_AUTH`
   - `AOA_CANONICAL_HOME`
3. Run migration/readiness checks before enabling sign-in buttons.
4. Complete real Claude and Codex sign-ins using disposable QA users.
5. Run a Commander turn for each provider and auth mode.
6. Observe sanitized login/probe metrics for at least one QA cycle.
7. Roll back by disabling provider flags first. If rolling back the image, mount
   the unchanged `aoa-data` volume at the old image's expected target as documented.
8. Promote only after backup restore and rollback rehearsals both pass.

## Failure modes registry

| Failure | Detection | User rescue | Operational rescue |
|---|---|---|---|
| Unsupported CLI output/version | Capability contract fails | Show supported version and command | Pin/rebuild image |
| Device/paste challenge expires | `expiresAt`/process status | Start again | Reap scoped child/row |
| Server restarts mid-login | no live child | Start again; no endless polling | Boot reaper |
| Provider outage/network | structured probe code | Retry later; proxy/TLS guidance | Health/egress diagnostics |
| Existing volume not mounted | migration sentinel absent | Block startup; never initialize silently | Restore correct mount |
| Cross-tenant challenge request | ownership mismatch | Report not found | Security event without secret data |
| UI render exception | error boundary | Retry/copy support ID | Redacted client error trace |
| Excessively long diagnostics | layout E2E | Scroll/collapse/copy details | N/A |
| Login worker mismatch | runtime lease/owner mismatch | Retry on owning worker / Start again | Reap only owner-scoped PID |
| Invalid key rotation | candidate probe fails | Keep current working key | Inspect inactive candidate/audit |

## What already exists and should be reused

- Adapter environment probes and Commander probe classification.
- Encrypted secret references and runtime secret resolution.
- Durable login challenge rows, PID identity checks, cancel, timeout, and boot reaping.
- Claude streaming URL detection and stdin paste-code bridge.
- Provider readiness abstractions and onboarding Verify tests.
- AOA localStorage theme migration and wire-compat documentation.
- Docker health checks and testing deployment pipeline.

## Decision audit trail

| # | Decision | Classification | Rationale | Rejected |
|---|---|---|---|---|
| 1 | Separate OS/platform detection from local/remote topology. | Auto-decided | They govern different behavior; conflating them recreates the localhost bug. | OS-only detection |
| 2 | Prefer device/paste-code flows even locally. | Auto-decided | One capability-driven path reduces platform-specific failures. | Loopback as default |
| 3 | Scope human subscription credentials by company and user. | Auto-decided | Required for hosted tenant isolation. | Global or company-shared subscription home |
| 4 | Keep legacy wire names only through the documented allow-list. | Auto-decided | Safe rebrand without breaking integrations. | Blind repository-wide replacement |
| 5 | Canonicalize `/aoa` with a compatibility window. | Auto-decided | Meets product naming goal while preserving existing volumes and rollback. | Immediate destructive rename |
| 6 | Treat the live provider probe as completion authority. | Auto-decided | Process exit and credential files can be stale or misleading. | File presence as success |
| 7 | Make onboarding a self-contained dark surface with one scroll owner. | Auto-decided | Prevents white flashes and unreachable long content. | Global theme mutation or nested page scroll traps |
| 8 | Treat execution ownership as distinct from topology and platform. | User challenge accepted | Prevents the control plane from becoming the permanent credential boundary by accident. | Central-filesystem-only contract |
| 9 | Default hosted multi-tenant installs to company API keys. | User challenge accepted | Provider policy and human-session custody must be approved first. | Subscription enabled by default |
| 10 | Split delivery into R0–R3. | Auto-decided | Restores Hetzner QA quickly without coupling the incident fix to migrations and cross-platform work. | One large release |
| 11 | Use one vertical scroll owner on mobile/zoom. | Auto-decided | Nested scrolling makes error recovery inaccessible at the exact failing sizes. | Always-scrollable checks panel |
| 12 | Make onboarding dark independently of `html.dark`. | Auto-decided | Prevents DevTools/system preference from changing the route and covers pre-React failures. | ThemeProvider-only fix |
| 13 | Treat scoped directories as routing, not tenant security. | User challenge accepted | All CLI processes currently share the same OS identity. | Claiming `0700` as isolation |
| 14 | Add explicit agent-to-credential bindings. | User challenge accepted | A per-user login is unusable safely unless runs select it through a governed relation. | Ambient/first credential selection |
| 15 | Stage API-key replacement before activation. | Auto-decided | A typo must not destroy a working credential. | Save-then-probe replacement |
| 16 | Keep challenge auth material memory-only in R1. | Auto-decided | Avoids persisting sensitive query URLs/codes; refresh honestly starts over. | Raw durable login URL |
| 17 | Standardize on `aoa doctor --json`. | Auto-decided | One stable diagnostic contract improves support, UI downloads, CI, and redaction testing. | Unspecified endpoint-or-command |
| 18 | Add an AOA-owned dedicated-target login escape hatch. | Auto-decided | Operators need recovery without hand-building provider homes. | Raw Docker/env instructions |
| 19 | Gate R0/R1 independently from R2/R3. | Auto-decided | Restores Hetzner QA without waiting for native-platform or data-layout programs. | One global acceptance gate |

## Review scorecards

| Review | Result | Key condition |
|---|---|---|
| CEO | Conditional approval | Provider policy + execution ownership Gate 0; narrow R0/R1 |
| Design | 7.3/10 average | Resolve policy/acceptance conflict; exact state, focus, scroll, and theme contracts |
| Engineering | Architecture 6, Tests 7, Performance 6, Security 5, Error paths 8, Deployment safety 5 | Real runtime isolation and explicit credential binding before multi-tenant subscriptions |
| DX | Target 9/10 | Exact install profile, stable errors, doctor, escape hatch, docs, measured TTHW |

### Cross-phase consensus

- The reported Hetzner failure is real and the diagnosis is consistent.
- API-key billing and subscription access are distinct and must be explained.
- Codex device authorization and Claude paste-code are the right remote-safe
  mechanisms on a dedicated approved target.
- Human subscription sessions must not be enabled in a shared multi-tenant runtime
  merely because directories are scoped.
- R0/R1 should ship independently; `/aoa`, native platforms, and true tenant
  execution isolation remain required but separately gated.
- The white-screen issue is not closed until browser evidence identifies the
  actual exception or computed-style/layout cause.
