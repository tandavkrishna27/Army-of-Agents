# AOA CLI authentication output compatibility repair plan

**Date:** 2026-07-27
**Status:** Implementation verified; unrelated aggregate-suite flake documented; testing deployment pending
**Branch:** `codex/cli-auth-parser-fix-20260727`
**Base:** `origin/main` at `61d2985e`
**Primary target:** `testing.armyofagents.org` on the dedicated Hetzner/Linux deployment

## Outcome

Restore the already-shipped remote-safe subscription sign-in flows for the pinned
Claude and Codex CLIs without changing the credential-isolation architecture:

- Claude accepts the provider's current `claude.com` authorization URL.
- Codex surfaces a clean device URL and the real one-time device code from
  ANSI-formatted terminal output.
- Provider-owned HTTPS allow-listing, loopback rejection, scoped credential
  homes, challenge ownership, and post-login verification remain unchanged.
- Deterministic tests use sanitized fixtures shaped like the real CLI output so
  future CLI formatting changes fail CI before deployment.

## Verified root causes

| Provider | Observed production behavior | Root cause | Confidence |
|---|---|---|---|
| Claude | The CLI starts, but AOA returns “login could not start (no verification URL).” | Claude CLI `2.1.220` emits an authorization URL on `claude.com`; `PROVIDER_HOSTS.anthropic` permits only `claude.ai` and `anthropic.com`, so `assertProviderLoginUrl` rejects a legitimate provider URL. | 10/10 |
| Codex URL | AOA opens `https://auth.openai.com/codex/device%1B[0m`, which ends at an invalid/expired session page. | Codex CLI `0.145.x` colorizes its output. The streaming URL parser treats the SGR reset sequence as URL text, and URL serialization percent-encodes it as `%1B[0m`. | 10/10 |
| Codex code | AOA displays a prose fragment such as `COMMAND-LINE` instead of the one-time code. | The case-insensitive, unanchored device-code regex accepts any hyphenated 4–8 character words before it reaches the actual code line. | 10/10 |
| API-key route | A ChatGPT/Claude subscription does not remove API billing/quota requirements. | Provider API keys and consumer subscriptions are separate authentication and billing products. This is expected behavior, not the subscription-flow defect. | 10/10 |

## Premises

1. AOA continues to run provider CLIs locally inside its execution runtime.
2. The current remote-safe flows remain correct: Codex device authorization and
   Claude authorization URL plus pasted code.
3. Login output is untrusted terminal text. Normalize presentation controls for
   parsing, then retain the existing provider-owned HTTPS validation boundary.
4. The exact current CLI output is a compatibility contract worth testing, but
   secrets, live URLs, and real device codes must never be committed.
5. A successful CLI exit is not proof of authentication; the existing bounded
   provider probe remains final authority.

## What already exists

- `runStreamingLogin` monitors stdout/stderr independently, handles split chunks
  within each real stream, skips loopback callbacks, applies a discovery timeout,
  and returns the first verification URL.
- `assertProviderLoginUrl` already enforces HTTPS, rejects credentials embedded
  in URLs, and allow-lists provider-owned domains.
- `runCodexLogin` already uses `codex login --device-auth`, scopes `CODEX_HOME`,
  and separately exposes a `userCodePromise`.
- The login service already terminates failed children, releases challenge
  locks, bounds completion, and re-verifies credential evidence.
- Existing tests cover clean synthetic output, chunk boundaries, loopback URLs,
  challenge lifecycle, tenant ownership, and UI rendering of device codes.

## Scope

### In scope

1. Normalize ANSI/VT terminal controls before URL and device-code parsing.
2. Parse Codex device codes only after the pinned CLI's device-code prompt,
   never from an arbitrary hyphenated line.
3. Add `claude.com` to the Anthropic provider-owned URL allow-list.
4. Add regression fixtures for real-shaped Claude `2.1.220` and Codex `0.145.x`
   output, including ANSI, misleading hyphenated prose, chunk boundaries,
   independent stdout/stderr state, CR-only lines, and unterminated final lines.
5. Run focused tests, full typecheck, full test suite, and production build.
6. After deployment, repeat both subscription flows with disposable QA accounts
   and verify one bounded Commander turn for each provider.

### NOT in scope

- Replacing CLI adapters with OpenAI or Anthropic hosted-agent products.
- Reintroducing ordinary localhost OAuth on a remote server.
- Changing credential ownership, bindings, homes, encryption, or database schema.
- Broad onboarding visual redesign; the previously shipped dark/scroll fixes are
  separate and should be regression-tested, not rewritten here.
- Treating a ChatGPT or Claude subscription as provider API-key quota.
- Supporting unpinned future CLI versions without first recording their output.

## Architecture and data flow

```text
provider CLI stdout/stderr
          |
          v
bounded raw buffer per stdout/stderr stream
          |
          v
Node stripVTControlCharacters()
          |
          +----------------------------+
          |                            |
          v                            v
verification URL parser          Codex code-line parser
 - chunk-boundary safe            - standalone line only
 - skip loopback                  - uppercase alphanumeric
 - trim punctuation               - 4..8 + "-" + 4..8
          |                            |
          v                            |
provider HTTPS allow-list              |
          |                            |
          +-------------+--------------+
                        v
                challenge response
                        |
                        v
             browser completes sign-in
                        |
                        v
             existing provider probe
```

Shadow paths:

```text
no URL -> discovery timeout / child exit -> child terminated -> challenge released
ANSI split across chunks -> raw buffer retained -> normalize complete buffer -> parse
delimiter on other stream -> isolated parser state -> cannot truncate URL/code
unterminated final code -> child close -> final bounded-buffer flush -> parse
loopback URL first -> ignored -> first remote provider URL selected
foreign HTTPS URL -> parsed -> provider allow-list rejects it
hyphenated prose -> not a standalone uppercase code line -> ignored
no device code -> bounded device-code timeout -> child terminated -> challenge released
```

## Implementation plan

### T1 — Normalize terminal controls at parser boundaries (P1)

Files:

- `packages/adapter-utils/src/login-url-detector.ts`
- `packages/adapter-utils/src/login-url-detector.test.ts`
- `packages/adapter-utils/src/auth-failure-detector.test.ts`

Use Node's built-in `stripVTControlCharacters` against the accumulated bounded
buffer inside the shared matching boundary used by both the streaming detector
and `extractVerificationUrl`. Do not strip each incoming chunk separately, because
a control sequence can itself cross a chunk boundary. Keep the raw bounded buffer
so existing URL chunk semantics remain intact.

Acceptance:

- An ANSI-styled Codex URL resolves exactly to
  `https://auth.openai.com/codex/device`.
- Control-sequence fragments never appear percent-encoded in the returned URL.
- Split URLs, split ANSI sequences, loopback rejection, and idempotence still pass.
- One-shot auth-failure detection also returns a clean URL from ANSI output.

### T2 — Make Codex device-code extraction context-safe (P1)

Files:

- `packages/adapters/codex-local/src/server/login.ts`
- `packages/adapters/codex-local/src/server/__tests__/login.test.ts`

Normalize the accumulated output with Node's terminal-control stripper. Split it
into lines, locate the pinned CLI's “one-time code” or “device code” instruction,
and accept a standalone uppercase alphanumeric `4..8-4..8` line only within the
small following prompt window. Do not use a global shape-only fallback. Keep the
existing 8 KiB bound, dual-stream listeners, and timeout behavior.

Acceptance:

- Lowercase and uppercase `command-line`, `codex-auth`, and similar standalone
  prose outside the recognized prompt context are ignored.
- The later ANSI-styled real device code is returned uppercase.
- A code and URL split across emitted chunks are reconstructed.
- A delimiter from the other process stream cannot terminate partial output.
- CR-only terminal redraw lines are accepted.
- An unterminated final code is parsed only when child close proves end-of-stream.
- No-code output still rejects with `device-code-timeout`.

### T3 — Accept the current Claude provider domain without weakening validation (P1)

Files:

- `server/src/services/cli-auth-topology.ts`
- `server/src/__tests__/cli-auth-topology.test.ts`
- `packages/adapters/claude-local/src/server/__tests__/login.test.ts`

Add `claude.com` to the Anthropic provider host list. Preserve exact-host or
subdomain matching, HTTPS-only enforcement, and username/password rejection.

Acceptance:

- `https://claude.com/cai/oauth/authorize?...` is accepted.
- Provider subdomains are accepted.
- `claude.com.evil.example`, `evilclaude.com`, HTTP, loopback, and embedded
  credentials remain rejected.
- A sanitized Claude `2.1.220`-shaped adapter stream yields a `claude.com` URL
  that survives the runtime provider validation boundary.

### T4 — Verify and release through the existing gates (P1)

Run in order:

```sh
pnpm --filter @armyofagents/adapter-utils test:run
pnpm exec vitest run packages/adapters/codex-local/src/server/__tests__/login.test.ts
pnpm exec vitest run packages/adapters/claude-local/src/server/__tests__/login.test.ts
pnpm exec vitest run server/src/__tests__/cli-auth-topology.test.ts server/src/__tests__/commander-login-service.test.ts
pnpm -r typecheck
pnpm test:run
pnpm build
```

Then deploy through the existing testing workflow and run the live QA checklist:

1. Claude: start sign-in, confirm a clean `claude.com` link, paste the returned
   code, reach Verified, run one Commander turn.
2. Codex: start sign-in, confirm the URL contains no encoded escape bytes, confirm
   the displayed code matches the CLI-issued code, reach Verified, run one turn.
3. Cancel/retry each provider once.
4. Check server logs and browser console for leaked URLs, codes, tokens, or keys.
5. Recheck short-height scrolling and dark mode while the expanded auth panel is open.
6. Revoke both disposable QA credentials through AOA, confirm their scoped files
   are removed, and require the next Verify probe to return `needs_auth`.

## Error and rescue registry

| Codepath | Failure | Rescue/action | User impact | Test |
|---|---|---|---|---|
| URL normalization | ANSI sequence surrounds URL | Strip controls before matching | Clean provider link | Unit |
| URL streaming | URL/control split across chunks | Retain bounded raw buffer | Wait until complete | Unit |
| URL streaming | Other stream emits a delimiter while URL is partial | Keep one detector per stream | Never surface a truncated URL | Unit |
| URL validation | Foreign, HTTP, loopback, or credentialed URL | Reject at provider boundary | Sign-in does not start | Unit |
| Claude allow-list | Legitimate `claude.com` URL | Accept provider-owned domain | Flow starts | Unit |
| Codex code parser | Hyphenated prose precedes code | Standalone uppercase line match | Correct code shown | Unit/integration |
| Codex code parser | Other stream emits a delimiter while code is partial | Keep one bounded buffer per stream | Never surface a truncated code | Integration |
| Codex code parser | Final code has no line terminator | Parse complete buffers on child close | Code still completes | Integration |
| Codex code parser | No real code appears | Existing bounded timeout | Retry guidance | Unit |
| Login lifecycle | Parser rejects/times out | Terminate child, finalize challenge | User can restart | Existing service tests |
| Post-login probe | CLI exits but auth is unusable | Existing live verification | Never falsely advance | Existing route/UI tests |

No new catch-all rescue is introduced. No terminal output, URL query string, or
device code is added to logs or persisted state.

## Failure modes registry

| Codepath | Failure mode | Rescued? | Tested? | User sees | Logged? |
|---|---|---:|---:|---|---:|
| URL parser | ANSI becomes URL text | Yes | Yes | Clean link | No secret output |
| URL parser | Split escape/URL | Yes | Yes | Pending, then clean link | No |
| URL parser | Cross-stream delimiter truncates partial URL | Independent detectors | Yes | Pending, then clean link | No |
| URL validator | Host spoofing | Yes | Yes | Sign-in cannot start | Safe error only |
| Codex parser | Prose mistaken for code | Prompt-context gate | Yes | Correct code | No |
| Codex parser | Cross-stream delimiter truncates partial code | Independent buffers | Yes | Pending, then correct code | No |
| Codex parser | Final code lacks CR/LF | Close-time flush | Yes | Correct code | No |
| Codex parser | Code absent | Yes | Yes | Sign-in timeout/retry | Safe error |
| Challenge | CLI remains alive after parse failure | Existing rescue | Existing tests | Retry | Structured failure |

No row is silent, unrescued, and untested.

## Test coverage diagram

```text
Claude 2.1.220-shaped output
  + URL on claude.com ---------------- [NEW unit]
  + subdomain ------------------------ [NEW unit]
  + spoof/HTTP/credentials ----------- [expanded unit]

Codex 0.145.x-shaped output
  + ANSI URL ------------------------- [NEW unit]
  + ANSI split at chunk boundary ----- [NEW unit]
  + lowercase/uppercase prose decoys -- [NEW adapter test]
  + prompt-context gating ------------ [NEW adapter test]
  + real standalone device code ------ [NEW adapter test]
  + URL/code split across chunks ----- [NEW adapter test]
  + every character boundary --------- [NEW adapter test]
  + stdout/stderr delimiter isolation - [NEW adapter/shared tests]
  + CR-only lines --------------------- [NEW adapter test]
  + unterminated close-time code ------ [NEW adapter test]
  + code absent / timeout ------------ [existing unit]

Lifecycle and UI
  + child cleanup on parser failure --- [existing service tests]
  + device URL/code response ---------- [existing route tests]
  + code rendering/copy/poll ---------- [existing component tests]
  + live provider completion ---------- [manual Hetzner gate]
```

The hostile regression test is a single real-shaped Codex stream containing
multiple lowercase and uppercase hyphenated phrases outside the recognized prompt,
ANSI around both URL and code, and arbitrary chunk splits. The Friday-at-2am
confidence test is the same fixture through `runCodexLogin`, not only the pure
parser helper.

## Security review

- Terminal output stays untrusted and memory-only.
- Normalization broadens what can be parsed, but provider URL validation remains
  after parsing and is not bypassed.
- `claude.com` is added as an exact provider root with the existing boundary-safe
  subdomain check; suffix lookalikes remain rejected.
- No credentials, URLs, codes, database fields, or API response shapes change.
- No dependency is added; Node's built-in terminal-control normalization is used.

## Performance and operations

- Parsing remains bounded to 64 KiB for URLs and 8 KiB for device codes.
- Normalization is linear over those small buffers and runs only during login.
- No database, network, worker, or replica behavior changes.
- Rollback is a normal revert of parser/allow-list changes; no data rollback.
- After deployment, any recurrence should be diagnosed by capturing a sanitized
  CLI-version/output fixture, never by loosening URL validation globally.

## Developer perspective

The target operator is a founder or platform engineer running one dedicated AOA
QA instance. They expect “Sign in with Codex/Claude” to behave like a device
login: click, authenticate on the provider site, return to AOA, and continue.
They should not need to understand container localhost, ANSI terminal controls,
or regex parsing. On failure, they must be able to retry without restarting the
server or manually killing a CLI process.

Target time to verified subscription session: under five minutes, with the first
actionable provider link visible within the existing discovery timeout.

## Review scorecards

| Review | Initial | Target | Key standard |
|---|---:|---:|---|
| CEO/scope | 8/10 | 10/10 | Fix compatibility regressions; do not redesign auth |
| Engineering | 6/10 | 10/10 | Normalize once, validate after, realistic fixtures |
| DX | 5/10 | 9/10 | Correct link/code, recoverable retry, no terminal knowledge |

Design review is not applicable: this repair changes no layout or interaction
contract. Existing dark-mode, scrolling, accessibility, and long-error tests remain
release regressions and are rechecked live after deployment.

## Implementation tasks

- [x] **T1 (P1, human ~1h / Codex ~10m)** — Normalize VT controls in URL parsing and add real-shaped tests.
- [x] **T2 (P1, human ~1h / Codex ~15m)** — Harden Codex code extraction and test deceptive prose plus chunking.
- [x] **T3 (P1, human ~30m / Codex ~5m)** — Add `claude.com` to the Anthropic allow-list with spoofing tests.
- [x] **T4a (P1, human ~1h / Codex ~30m)** — Run focused tests, full typecheck, and production build.
- [ ] **T4b (P1)** — Restore an aggregate green test run; an unrelated OpenCode MCP test times out only under full-suite load and passes in isolation.
- [ ] **T4c (P1, human ~1h)** — Deploy through the testing workflow and perform live Hetzner sign-in canaries.

Sequential implementation is preferred because the two parser changes share the
same terminal-output contract and the final focused tests are quick. Parallel
worktrees would add coordination cost without shortening the critical path.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|---|---|---:|---:|---|---|
| CEO Review | `/autoplan` | Scope and strategy | 1 | PASS | Kept scope to output compatibility; no auth redesign |
| Codex Review | `/review` | Independent adversarial and structured review | 3 | PASS AFTER FIXES | Found and verified cross-stream truncation plus missing close-time flush; re-review and structured review found no remaining P1/P2 defect |
| Eng Review | `/autoplan` + `/review` | Architecture and tests | 4 | PASS AFTER FIXES | Fixed premature partial-line code, partial-ANSI URL resolution, CR-only parsing, stream isolation, and close-time final parsing; re-review found no remaining actionable findings |
| Design Review | `/autoplan` | UI/UX gaps | 0 | NOT APPLICABLE | No UI contract change |
| DX Review | `/autoplan` | Developer onboarding | 1 | PASS | Preserved click/authenticate/verify flow and retry semantics |

**VERDICT:** The CLI-auth implementation is locally verified. The normal aggregate test gate still has one unrelated load-sensitive timeout that passes in isolation; deployment should follow the repository's CI gate.

**Verification evidence:**

- Focused regression set: 365 tests passed (plus one existing platform-specific skip).
- `pnpm -r typecheck`: passed across 23 checked workspace projects.
- Final `pnpm test:run`: all affected tests passed; one unrelated OpenCode MCP test timed out under aggregate load.
- Isolated OpenCode MCP rerun: 4 tests passed, including the timed-out case in 6.93 seconds.
- `pnpm build`: passed; existing Vite chunk-size warnings remain.
- `git diff --check`: passed.

NO UNRESOLVED DECISIONS
