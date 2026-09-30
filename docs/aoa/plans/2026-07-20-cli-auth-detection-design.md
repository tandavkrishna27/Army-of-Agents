# CLI auth detection + Verify-step honesty — design

**Date:** 2026-07-20
**Branch:** `claude/signup-onboarding-ui-animations-0724cb`
**Status:** approved, ready for implementation planning

---

## Problem

A founder whose Claude CLI sign-in has been revoked is dead-ended in onboarding,
and told the opposite of the truth.

Observed live on a real instance:

```
claude auth status  ->  { loggedIn: true, subscriptionType: "max" }   OK
claude --print      ->  401 "OAuth access token has been revoked."    FAIL
```

The Verify step rendered a single line — *"Working directory is valid: …"* — with
no indication anything had failed.

### Three defects, each amplifying the last

**1. Detection (root cause).** `CLAUDE_AUTH_REQUIRED_RE`
(`packages/adapters/claude-local/src/server/parse.ts:4`) decides whether a
failure means "needs login". It matches only *never-signed-in* phrasing. Measured
against real strings:

| Error | claude | codex | gemini |
|---|---|---|---|
| `Failed to authenticate. API Error: 401 … revoked` | no | no | no |
| `OAuth token expired` | no | no | no |
| bare `401` / `403` | no | no | no |
| `not logged in … run claude login` | yes | yes | yes |

The entire expired/revoked class is missed by every adapter. In practice this is
the *common* case: tokens expire on their own; users rarely un-login.

**2. Classification.** Because detection missed it, the probe emitted
`claude_hello_probe_failed` rather than `claude_hello_probe_auth_required`.
`classifyCommanderProbe` (`server/src/services/commander-verify.ts:73`) matches on
check *codes* only, so it fell through to a generic `failed`.

**3. Presentation.** `failed` renders as a dead end offering no recovery.

**Consequence:** the in-app recovery machinery already exists — API-key paste and
CLI-login auto-detect — but is unreachable, because a revoked token is never
classified as an auth problem. *(Defect 3 was fixed separately on 2026-07-20 in
`2d4ddea08`: the step showed `checks[0]` and discarded the rest. Defects 1 and 2
remain and are what this design addresses.)*

### Verified NOT broken

The onboarding CLI choice propagates correctly. Confirmed live: selecting Claude
wrote `cliTool=claude_cli, provider=anthropic`, and all 10 crew agents (Commander,
Librarian, Adjutant, Scout, Engineer, Navigator, Planner, Memory Keeper,
Chronicler, Steward) are on `claude_local`. No fix needed.

---

## Scope

**In:** Claude and Codex — the only two runtimes the onboarding step offers.

**Out:**
- In-app Claude sign-in via `claude setup-token` (own spike; Claude keeps
  API-key paste + terminal auto-detect for now).
- Inbox items and Settings banners for expired sessions.
- Gemini and acpx adapters. They share the gap, and the shared detector is
  available to them, but adopting it there is not this change.

Fixing detection improves agent-run failure *text* as a byproduct — the Librarian
failure card stops dumping raw JSON — but no new runtime UI is built.

---

## Architecture

One shared detector; both adapters use it; the server double-checks.

```
verify route
  -> adapter probe (claude-local | codex-local)
       hello probe fails
         -> detectAuthFailure(stdout+stderr+parsed)      [shared]
         -> if auth-ish: run the CLI's own status command
         -> emit a precise check: code + message + hint
  -> classifyCommanderProbe                              [server]
       matches auth codes, AND scans messages/details as a fallback
  -> outcome: needs_auth
  -> VerifyStep renders per-check list + recovery options [already built]
```

### Components

**1. `packages/adapters/utils/src/auth-failure-detector.ts` (new)**

```ts
export type AuthFailureKind = "none" | "signed_out" | "expired" | "invalid_key";
export function detectAuthFailure(text: string): {
  kind: AuthFailureKind;
  loginUrl: string | null;
};
```

Sits beside the existing `login-url-detector.ts` and `streaming-login.ts`, so
auth logic keeps one home. Pure and synchronous — testable against a table of
real error strings with no process spawning.

Distinguishing `expired` from `signed_out` is what lets the UI say "your session
was revoked" instead of "you are not signed in", which is the specific lie the
founder hit.

**2. `claude-local/src/server/parse.ts`** — `detectClaudeLoginRequired` delegates
to the shared detector and additionally returns `kind`. Its existing
`{requiresLogin, loginUrl}` shape is preserved so current callers
(`execute.ts:302`, `execute.ts:627`) are untouched.

**3. `claude-local/src/server/test.ts` (the probe)** — when the hello probe fails
*and* the detector says the failure is auth-ish, run `claude auth status` and
parse its JSON. Emit one of:

- `claude_hello_probe_auth_required` — no credentials. *"Sign in to Claude to continue."*
- `claude_hello_probe_auth_expired` — credentials exist but were rejected.
  *"Signed in as {email}, but that session has expired or been revoked. Sign in again."*
  When `auth status` reports a login without an email, drop the name and say
  "your Claude sign-in has expired or been revoked".

**4. `codex-local/src/server/test.ts`** — same two outcomes via `codex login
status`, emitting `codex_hello_probe_auth_required` /
`codex_hello_probe_auth_expired`.

Note the output shapes differ and the parsers are NOT interchangeable:

- `claude auth status` prints JSON — `{loggedIn, email, subscriptionType, …}`.
- `codex login status` prints prose — observed: `Logged in using ChatGPT`. There
  is no email to name, so the Codex expired copy says "your Codex sign-in" rather
  than naming an account.

Treat "did it print evidence of a stored login?" as the signal, and parse each
CLI's own format. Do **not** depend on the status command's exit code — it is
unverified for the logged-out case on both CLIs; parse the output instead, and
treat anything unrecognised as `signed_out`.

**5. `server/src/services/commander-verify.ts`** — `classifyCommanderProbe` also
matches `auth_expired`, and falls back to scanning check messages and details for
auth signals. Defence in depth: a future adapter that forgets the helper still
classifies as `needs_auth` rather than dead-ending the founder.

**6. `ui/src/onboarding/steps/VerifyStep.tsx`** — copy for the expired case
(naming the account), and the existing recovery options unchanged. The per-check
breakdown landed in `2d4ddea08`.

### Why status runs only on failure

The status command costs a subprocess. Running it only after the hello probe
fails keeps the happy path exactly as fast as today, and no information is lost:
its whole job is explaining a failure that already happened.

| `auth status` | hello probe | Outcome shown |
|---|---|---|
| not logged in | fails | `needs_auth` — "Not signed in yet" |
| logged in as X | fails | `needs_auth` — "Signed in as X, session revoked/expired" |
| (not run) | passes | `verified` |

---

## Error handling

- **Status command missing** (older CLI without `auth status`): treat as
  `signed_out` and keep today's behaviour. Never crash the probe.
- **Status command times out:** bounded wait; on timeout treat as unknown and
  fall back to `signed_out` copy.
- **Unparseable status output:** same fallback. The status command is an
  *enhancement* to the message, never a gate.
- **Raw `stream-json` never reaches the founder.** It stays in the check `detail`
  for debugging; the UI shows `message` + `hint`.
- **No secrets in messages.** Emails come from `auth status` and are shown; tokens
  and keys are never echoed.

---

## Testing

**Unit — detector (the core).** Table of real strings: the observed revoked 401,
`OAuth token expired`, bare `401`/`403`, `invalid api key`, `not logged in`, plus
negatives that must NOT match (`rate limit`, `max turns`, a task legitimately
discussing the word "unauthorized"). False positives matter: mislabelling a
content failure as an auth failure sends the founder to a sign-in screen that
cannot help.

**Adapter probe.** Mocked exec: hello fails + status logged-in → `auth_expired`
with the email in the message; hello fails + status logged-out → `auth_required`;
status missing/timeout → `auth_required` without crashing.

**Server classifier.** `auth_expired` code → `needs_auth`; an unknown code whose
detail contains a 401 → `needs_auth` (fallback path); a genuine non-auth failure
→ stays `failed`.

**UI.** Expired copy names the account and offers recovery; signed-out copy
differs; verified hides the breakdown.

**Live.** Re-run Verify on the `memstep` instance against the genuinely revoked
token and confirm it now reports expired-with-account and offers recovery. This
environment is the reason the bug was found; it is the acceptance test.

---

## Success criteria

1. A revoked Claude token produces `needs_auth`, not `failed`.
2. The Verify step distinguishes "never signed in" from "session expired", and
   names the account for the latter.
3. Recovery options appear for both cases.
4. Non-auth failures still classify as `failed` — no over-matching.
5. Codex behaves the same way as Claude.
