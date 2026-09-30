# Verify-step honesty + Claude paste-code bridge — design

**Date:** 2026-07-20
**Branch:** `claude/signup-onboarding-ui-animations-0724cb`
**Status:** approved in conversation, pending written review

---

## Problem

Two defects on one screen, reported from live use: *"it says verifying and nothing
is happening… it did not open any URL."*

### 1. The panel promises something it does not do

The `needs_auth` panel reads:

```
Choose one — no terminal required:
    Paste an API key      [Save key & verify]
    or
    I'll sign in myself in the CLI
```

"No terminal required" sits directly above an option that requires a terminal.
Choosing it starts a background poller that shows a spinner and nothing else — no
command to run, no link, no statement of what it is waiting for. The founder
reasonably expects the app to act, and it never does.

### 2. Claude has no in-app sign-in; Codex does

Verified by running the real CLI:

```
$ claude auth login
Opening browser to sign in…
If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?...
Paste code here if prompted >          <-- blocks reading stdin
```

Codex self-completes through a local `:1455` callback. Claude redirects to a
REMOTE callback (`platform.claude.com`) and then blocks on stdin for a pasted
code. The UI therefore gates interactive login to Codex only.

`packages/adapters/claude-local/src/server/login.ts:22-25` already documents this
gap and names the fix "the paste-code bridge". This design implements it.

---

## What already exists (verified, not assumed)

- The login route accepts `provider: "anthropic"` (`routes/commander-login.ts:37`).
- `runClaudeLoginStreaming` spawns `claude auth login` and tees output through
  the shared verification-URL detector, which skips loopback callbacks.
- Completion evidence is `<claude config home>/.credentials.json`. Confirmed
  present at `~/.claude/.credentials.json` on the dogfood machine.
- `resolveClaudeConfigHome` honours `CLAUDE_CONFIG_DIR` — which makes isolated
  testing possible without touching real credentials.
- The service already separates LIVE in-memory child handles (this process) from
  DURABLE DB rows (a prior process), and only ever unconditionally kills the
  former. This design follows that existing discipline rather than inventing one.

### The one blocking line

`packages/adapter-utils/src/streaming-login.ts`:

```ts
// stdin ignored: the device flow needs no input; stdout+stderr piped for URL detection.
stdio: ["ignore", "pipe", "pipe"],
```

True for Codex. False for Claude.

### Proven by experiment, not reasoning

The risky assumption was whether a stdin write reaches the child under the app's
REAL spawn configuration — on Windows `spawnTrackedChild` uses `shell: true` to
run `.cmd` wrappers, so the child is `cmd.exe /c claude auth login`, not `claude`
directly. A probe replicating those exact options wrote a deliberately invalid
code and the CLI answered:

```
Paste code here if prompted > Invalid code. Please make sure the full code was copied.
```

The write lands. The bridge is feasible on the platform that matters here.

### A trap the same probe exposed

Immediately after rejecting the code, the CLI printed `Login successful.` and
exited **0**. The login may genuinely have completed via the browser callback
independently of the bad paste — that is unresolved and does not matter. What
matters is the consequence:

> **The child's exit code and its own success message are not trustworthy
> completion evidence.**

Nor is bare file presence: `.credentials.json` already exists while holding a
REVOKED token. Completion must be established by re-running the probe.

---

## Design

### Component 1 — opt-in stdin (adapter-utils)

Add `stdin?: "ignore" | "pipe"` to `RunStreamingLoginOptions`, defaulting to
`"ignore"`. Only the Claude path passes `"pipe"`.

Codex's spawn stays byte-identical. A flow that already works takes no risk from
a change it does not need.

`runStreamingLogin` returns a `submitCode(code: string): boolean` on its result —
writes `code + "\n"` to the child's stdin, returns false when stdin is not piped
or the child has exited.

### Component 2 — live-challenge registry (server)

The service gains `Map<challengeId, { submitCode }>` for challenges started by
THIS process, populated on start and deleted on finalize/cancel/timeout.

This is deliberately in-memory. A challenge from a prior process has no live
child to write to, so the honest response is an error telling the founder to
start again — never a silent no-op, which is the failure mode we are removing.

### Component 3 — submit-code route

`POST /companies/:companyId/internal-agent/commander-login/:id/code`, body
`{ code: string }`, same authz as the sibling login routes.

- unknown/absent challenge in the registry → **409** "sign-in session expired,
  start again"
- empty/whitespace code → **400**
- otherwise write to stdin → **202**, and let the existing status polling decide
  the outcome

### Component 4 — completion authority

After a code is submitted, completion is decided by **re-running the verify
probe**, not by the child's exit code, its "Login successful" line, or the mere
existence of `.credentials.json`. The UI already re-verifies on completion; this
design makes that the authoritative signal rather than a convenience.

### Component 5 — UI

For `provider === "anthropic"`, the interactive login path is un-gated and shows:
the verification URL as a link, a code input, and a submit button.

The existing "I'll sign in myself in the CLI" watcher **stays** for both
providers. It is the fallback when the bridge cannot run — a challenge lost to a
server restart, a spawn failure, or a founder who simply prefers a terminal. It
is no longer the only non-API-key option for Claude, which is what made it feel
like a dead end.

Copy fixes, which stand alone and ship even if the bridge were dropped:

- Do not claim "no terminal required" unless every offered option is terminal-free.
- The CLI-watch state shows the literal command (`claude auth login`) with a copy
  control and says plainly that we are watching for it to finish — replacing an
  unexplained spinner.

---

## Error handling

| Case | Behaviour |
|---|---|
| Challenge not in registry (restart, other process) | 409, "start again" — never a hang |
| Empty code | 400 |
| Wrong code | Surface the CLI's own message; the founder may retry |
| Child exits before submit | `submitCode` returns false → 409 |
| No URL detected | Existing `login-url-timeout` path, unchanged |
| Overall duration | Existing post-URL deadline, unchanged |

The pasted code is a credential: never logged, never persisted, never echoed in a
response or an error message.

---

## Testing

**Unit** — `submitCode` writes to stdin when piped; returns false when stdin is
ignored or the child is dead; codex's spawn options are unchanged (guard against
regressing a working flow).

**Service** — registry populated on start, cleared on finalize/cancel/timeout;
lookup miss returns the not-live signal.

**Route** — 409 unknown id, 400 empty code, 202 happy path, and an assertion that
the code appears in no log line or response body.

**UI** — for anthropic: URL renders as a link and code input appears; submit
posts; a 409 renders "start again" rather than spinning. Copy: no "no terminal
required" when a terminal option is present; the watch state shows the command.

**Live** — against an ISOLATED `CLAUDE_CONFIG_DIR` pointing at a temp directory,
which presents a clean signed-out state without touching the dogfood machine's
real (now working) credentials. Complete a full sign-in through the UI: URL
appears, paste the code, probe re-runs, outcome flips to `verified`.

---

## Out of scope

- `claude setup-token` as an alternative acquisition path — worth a spike, but
  this design uses the mechanism already proven.
- The Agent-detail "Login to Claude Code" surface — Verify step only, per scope
  decision.
- Librarian access/recall work — deferred to its own spec.

---

## Success criteria

1. A founder with an expired Claude session completes sign-in without leaving the
   app.
2. No screen claims "no terminal required" while offering only terminal options.
3. The CLI-watch state states the command and what it is waiting for.
4. A submitted code on a dead/foreign challenge produces a clear error, not a hang.
5. Codex's existing login flow is behaviourally unchanged.
