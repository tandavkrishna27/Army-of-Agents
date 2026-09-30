# AOA remote CLI authentication test plan

**Companion plan:** `2026-07-27-remote-cli-auth-onboarding-plan.md`
**Release rule:** R0/R1 Hetzner tests gate the incident release. R2/R3 suites
gate their own later releases and do not delay R0/R1.
## R0 — diagnostics, non-Git probe, theme, and layout

### Unit/component

- Verify renders every structured check and sanitized detail disclosure.
- Detail sanitization failure omits detail rather than showing raw text.
- Codex hello probe uses the exact supported non-Git flag.
- Stable errors render exact Problem → Cause → Fix copy.
- Mascot shrinks/hides at the short-height breakpoint.
- Async status uses live-region/alert semantics and moves focus predictably.

### Browser

- Chromium, Firefox, and WebKit at 320×568, 390×844, 768×1024,
  1366×768, and 1440×900.
- 100%, 125%, 200%, and 400% zoom where supported.
- DevTools docked left, right, and bottom; responsive emulation on/off.
- Global light, dark, and system preferences; onboarding stays dark without
  changing the saved preference.
- Navigation into/out of onboarding has no white frame.
- Inject a FlowEngine render exception and a pre-React bootstrap failure; both
  produce dark recovery UI.
- Render 20+ checks, a 2,000-character safe error, and a long URL. The page
  remains reachable by wheel, touch, keyboard, and screen reader.
- Visual keyboard does not cover the active field/CTA.
- Reduced motion, forced colors, keyboard-only, axe, and screen-reader smoke.

### Live Hetzner

- Capture console error, unhandled rejection, screenshot, computed styles, and
  scroll metrics while reproducing the reported Inspect/white-screen behavior.
- Do not close the defect until the observed exception or layout/theme cause is
  recorded in the implementation PR.
- Run the Codex hello probe inside `/app` without `.git` and prove the result is
  no longer the trust-directory failure.

## R1 — dedicated Hetzner API key and subscription flows

### API-key candidate rotation

```text
candidate -> validate -> activate -> CLI environment -> bounded hello
```

- Valid candidate atomically becomes active and retains rollback metadata.
- Invalid candidate never replaces the active version.
- Transient network/TLS/provider failure returns a retryable classified error
  and never replaces the active key.
- Failure after encrypted candidate persistence but before activation leaves the
  active version unchanged.
- Two founders rotating concurrently cannot interleave versions.
- Direct validation classifies invalid key, insufficient scope, billing/quota,
  rate limit/Retry-After, TLS/custom CA, proxy, model unavailable, provider 5xx,
  timeout, and unknown.
- CLI environment receives only the selected secret and never leaks it through
  process args, logs, errors, activity, or diagnostics.

### Parser and process contracts

- Pinned real CLI fixture for every supported version.
- Output split at every byte boundary, mixed stdout/stderr, ANSI/control
  sequences, carriage-return redraw, oversized output, invalid UTF-8, no newline,
  multiple URLs, malicious URL before valid URL, disallowed scheme/host, expired
  device code, and changed/unknown output.
- Spawn uses argv arrays without shell interpolation.
- Windows wrapper behavior is covered separately in R3.
- Child timeout, cancellation, signal escalation, process exit before discovery,
  and output after cancellation.

### Challenge lifecycle

```text
start -> material discovered -> user action -> CLI completion -> live readiness probe
```

- Owner can start/status/code/cancel; another company or user sees not found.
- Operator can cancel a stuck challenge but cannot view/submit auth material.
- Duplicate owner/provider/target start returns/rejoins the owned challenge or a
  stable conflict according to contract.
- Per-user, per-company, and per-runtime limits return 429 + Retry-After.
- Crash before PID backfill, after PID backfill, after credential write, and
  before DB finalization.
- Concurrent cancel, expiry, process exit, and successful probe settle once.
- Browser refresh can read status but must Start again for memory-only URL/code.
- Server restart reports expired/start again; no endless polling.
- One login-worker replica is enforced in R1.
- Two-replica simulation proves the non-owner cannot signal a PID or accept code.
- Terminal rows expire and boot cleanup releases process/DB capacity.

### Codex device authorization

- Ordinary loopback login is never invoked on a remote target.
- Start returns allow-listed HTTPS host, user code, and expiry.
- UI shows hostname, labelled readonly code, Copy, Cancel, expiry, and Start again.
- Popup/new-tab blocked and Copy link fallback.
- Process exit/auth-file presence without live probe never marks ready.
- Real disposable QA subscription completes, then a bounded Commander turn passes.

### Claude paste-code

- Start returns allow-listed HTTPS host and expiry; raw query URL is not visible
  in diagnostics/logs.
- Empty, oversized, repeated, expired, wrong-owner, and post-exit code submission.
- Transient network failure retains the entered code; accepted/expired clears it.
- Stale credential file plus misleading CLI success still requires live probe.
- Real disposable QA subscription completes, then a bounded Commander turn passes.

### Policy

- Dedicated approved target shows subscription methods.
- Hosted multi-tenant without Gate 0 shows disabled controls, reason, company API
  key recommendation, and policy link.
- Provider kill switch disables only that flow and leaves onboarding recoverable.

## R2 — credential binding and real execution isolation

```text
agent -> governed credential binding -> execution target -> isolated ephemeral home
```

- Correct owner/company/provider/target binding succeeds.
- No binding, wrong provider, target mismatch, cross-company credential, and
  unapproved binding fail closed.
- Revoked/suspended/departed owner pauses dependent agents/runs and surfaces repair.
- A Company A process cannot open Company B credential files in the real runtime;
  same-UID directory-only isolation intentionally fails this test.
- Worker receives only the bound credential volume/secret.
- No ambient shared home or “first credential” fallback is reachable.
- Binding create/change/revoke requires permissions, approval where governed, and
  activity logging.
- Load test challenge/run isolation at 10× expected concurrency.

## R3 — `/aoa` migration and native platforms

### Data-layout compatibility

Test all combinations:

| Image | Compose | Expected |
|---|---|---|
| old | old | Existing data loads |
| new | new | Existing data loads at `/aoa` |
| new | old | Fail closed with exact remount/upgrade action |
| old | new | Fail closed with exact rollback mount action |

Also test:

- Fresh empty install versus existing volume sentinel.
- Legacy path symlink with no legacy mount shadowing it.
- Backup, restore, rollback, and re-upgrade.
- UID/GID change and ownership repair.
- No new write through the legacy path.

### Native

- Current/previous macOS major: keychain/file behavior, local data directory,
  CLI discovery, login, logout, custom CA, permissions.
- Windows 11 PowerShell/native: LocalAppData path, ACLs, Git Bash requirements,
  process quoting, Ctrl-Break/termination, long paths, spaces/non-ASCII username.
- Ubuntu current LTS native: `~/.aoa`, file modes, systemd environment, proxy/CA.
- Until ACL/isolation tests pass, Windows subscription auth is local single-user only.

## Diagnostics, redaction, and docs

- Snapshot `aoa doctor --json` schema and exit codes.
- Every diagnostic field has a sensitivity classification.
- Fuzz secrets/codes/tokens/URLs into stdout, stderr, environment, provider
  responses, exceptions, and child output; none appear in doctor, support bundle,
  HTTP error, activity, telemetry, or browser console.
- `--offline` makes no network request.
- UI Download diagnostics matches doctor schema and redaction.
- Clean operator follows each R1 Linux guide verbatim with copy/paste commands.
- Measure nine journey milestones and enforce p50/p90 budgets from the main plan.

## Required commands

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

Focused suites run before the full sweep:

- adapter streaming login and provider parsers;
- Commander login, code, key, verify, and route authz;
- provider readiness and secret rotation;
- onboarding Verify, theme/bootstrap, and storage migration;
- Docker bootstrap/layout compatibility;
- Playwright onboarding and provider-auth specifications.

Real subscription sign-ins are manual release gates with disposable QA accounts.
Deterministic CI uses recorded/sanitized fixtures and mocked provider endpoints.
