# CLI Auth Detection + Verify-Step Honesty Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a revoked or expired CLI sign-in classify as `needs_auth` (not a generic `failed`), so the onboarding Verify step tells the founder the truth — "signed in as X, but that session was revoked" — and offers the recovery options that already exist.

**Architecture:** One shared `detectAuthFailure()` in `@armyofagents/adapter-utils`, consumed by the claude-local and codex-local probes. When the hello probe fails with an auth-ish signal, the probe runs the CLI's own status command to separate "never signed in" from "signed in but rejected". The server classifier gains an `auth_expired` match plus a message/detail fallback so a future adapter that forgets the helper still classifies correctly.

**Tech Stack:** TypeScript, vitest, pnpm workspaces. Packages: `packages/adapter-utils`, `packages/adapters/claude-local`, `packages/adapters/codex-local`, `server`, `ui`.

**Spec:** `docs/aoa/plans/2026-07-20-cli-auth-detection-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/adapter-utils/src/auth-failure-detector.ts` (create) | Pure classifier: error text → `none` / `signed_out` / `expired` / `invalid_key` |
| `packages/adapter-utils/src/auth-failure-detector.test.ts` (create) | Detector table tests, positives + negatives |
| `packages/adapter-utils/src/index.ts` (modify) | Re-export the detector |
| `packages/adapters/claude-local/src/server/parse.ts` (modify) | `detectClaudeLoginRequired` delegates to shared detector, adds `kind` |
| `packages/adapters/claude-local/src/server/auth-status.ts` (create) | Run + parse `claude auth status` |
| `packages/adapters/claude-local/src/server/test.ts` (modify) | Emit `auth_required` vs `auth_expired` |
| `packages/adapters/codex-local/src/server/auth-status.ts` (create) | Run + parse `codex login status` |
| `packages/adapters/codex-local/src/server/test.ts` (modify) | Same two outcomes for Codex |
| `server/src/services/commander-verify.ts` (modify) | Classify `auth_expired`; message/detail fallback |
| `ui/src/onboarding/steps/VerifyStep.tsx` (modify) | Expired-case copy naming the account |

Task order: 1 (detector) → 2 (claude parse) → 3 (claude status) → 4 (claude probe) → 5 (codex) → 6 (server) → 7 (UI) → 8 (live).

---

## Task 1: Shared auth-failure detector

**Files:**
- Create: `packages/adapter-utils/src/auth-failure-detector.ts`
- Create: `packages/adapter-utils/src/auth-failure-detector.test.ts`
- Modify: `packages/adapter-utils/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/adapter-utils/src/auth-failure-detector.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { detectAuthFailure } from "./auth-failure-detector.js";

// The exact 401 observed on a live instance with a revoked Claude token.
const REVOKED_401 =
  'Failed to authenticate. API Error: 401 {"type":"error","error":' +
  '{"type":"authentication_error","message":"OAuth access token has been revoked."},"request_id":null}';

describe("detectAuthFailure — expired/revoked credentials", () => {
  it("classifies the observed revoked-token 401 as expired", () => {
    expect(detectAuthFailure(REVOKED_401).kind).toBe("expired");
  });

  it("classifies an expired OAuth token as expired", () => {
    expect(detectAuthFailure("OAuth token expired, please re-authenticate").kind).toBe("expired");
  });

  it("classifies a bare 401 as expired", () => {
    expect(detectAuthFailure("API Error: 401").kind).toBe("expired");
  });

  it("classifies 403 as expired", () => {
    expect(detectAuthFailure("API Error: 403 Forbidden").kind).toBe("expired");
  });
});

describe("detectAuthFailure — never signed in", () => {
  it("classifies claude's not-logged-in message as signed_out", () => {
    expect(detectAuthFailure("You are not logged in. Please run `claude login`.").kind).toBe(
      "signed_out",
    );
  });

  it("classifies codex's login prompt as signed_out", () => {
    expect(detectAuthFailure("Not logged in. Please run `codex login`.").kind).toBe("signed_out");
  });

  it("classifies a generic login-required message as signed_out", () => {
    expect(detectAuthFailure("login required").kind).toBe("signed_out");
  });
});

describe("detectAuthFailure — bad key", () => {
  it("classifies an invalid API key as invalid_key", () => {
    expect(detectAuthFailure("Invalid API key provided").kind).toBe("invalid_key");
  });

  it("classifies a missing OPENAI_API_KEY as invalid_key", () => {
    expect(detectAuthFailure("OPENAI_API_KEY is missing").kind).toBe("invalid_key");
  });
});

// False positives send the founder to a sign-in screen that cannot help them,
// so non-auth failures MUST stay `none`.
describe("detectAuthFailure — must NOT over-match", () => {
  it("ignores rate limits", () => {
    expect(detectAuthFailure("API Error: 429 rate limit exceeded").kind).toBe("none");
  });

  it("ignores max-turns exhaustion", () => {
    expect(detectAuthFailure("Run stopped: maximum turns reached").kind).toBe("none");
  });

  it("ignores a 500", () => {
    expect(detectAuthFailure("API Error: 500 internal server error").kind).toBe("none");
  });

  it("ignores prose that merely discusses authorization", () => {
    expect(
      detectAuthFailure("The task is to add an authorization header to the request handler."),
    ).toMatchObject({ kind: "none" });
  });

  it("returns none for empty input", () => {
    expect(detectAuthFailure("").kind).toBe("none");
  });
});

describe("detectAuthFailure — login URL", () => {
  it("extracts a verification URL when present", () => {
    const r = detectAuthFailure("Please log in at https://claude.ai/device/ABC-123 to continue");
    expect(r.kind).toBe("signed_out");
    expect(r.loginUrl).toBe("https://claude.ai/device/ABC-123");
  });

  it("returns null loginUrl when absent", () => {
    expect(detectAuthFailure("not logged in").loginUrl).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/adapter-utils && npx vitest run src/auth-failure-detector.test.ts`
Expected: FAIL — `Failed to resolve import "./auth-failure-detector.js"`.

- [ ] **Step 3: Write the implementation**

Create `packages/adapter-utils/src/auth-failure-detector.ts`:

```ts
/**
 * Shared auth-failure classifier for CLI adapters.
 *
 * Every adapter previously carried its own regex, and all of them matched only
 * NEVER-SIGNED-IN phrasing ("not logged in", "please run `x login`"). The
 * expired/revoked class — which is the common case in practice, since tokens
 * expire on their own — was missed by all of them. A missed auth signal makes
 * the probe report a generic failure, which the server classifies as `failed`,
 * which leaves the founder with no recovery offer at all.
 *
 * Separating `expired` from `signed_out` is what lets the UI say "your session
 * was revoked" instead of the false "you are not signed in".
 *
 * Pure and synchronous: no process spawning, so it is exhaustively testable
 * against a table of real error strings.
 */

export type AuthFailureKind = "none" | "signed_out" | "expired" | "invalid_key";

export interface AuthFailureDetection {
  kind: AuthFailureKind;
  /** Verification URL when the CLI printed one, else null. */
  loginUrl: string | null;
}

/** Credentials are absent — the user has never signed in (or signed out). */
const SIGNED_OUT_RE =
  /(?:not\s+logged\s+in|please\s+log\s+in|log\s*in\s+required|login\s+required|requires\s+login|not\s+authenticated|please\s+authenticate|please\s+run\s+`?\w+\s+login`?|run\s+`?\w+\s+auth(?:\s+login)?`?\s+first)/i;

/**
 * Credentials exist but the server rejected them. `authentication_error` and
 * `token has been revoked` are the shapes Anthropic returns; the bare status
 * codes cover CLIs that surface only the HTTP status.
 */
const EXPIRED_RE =
  /(?:revoked|expired|authentication_error|failed\s+to\s+authenticate|\b401\b|\b403\b|unauthorized|authentication\s+required|invalid\s+credentials)/i;

/** A key was supplied and is wrong or absent. */
const INVALID_KEY_RE =
  /(?:invalid(?:\s+or\s+missing)?\s+api[_\s-]?key|api[_\s-]?key\s+(?:is\s+)?(?:required|missing|invalid)|(?:openai|anthropic)[_\s-]?api[_\s-]?key\s+(?:is\s+)?(?:not\s+set|missing|required|invalid))/i;

/**
 * Failures that contain auth-adjacent words but are NOT auth problems. Checked
 * first: "429 rate limit" must never route the founder to a sign-in screen.
 */
const NOT_AUTH_RE = /(?:\b429\b|rate\s*limit|\b5\d{2}\b|max(?:imum)?\s+turns?|timed?\s*out)/i;

const URL_RE = /(https?:\/\/[^\s'"`<>()[\]{};,!?]+[^\s'"`<>()[\]{};,!.?:]+)/i;

export function detectAuthFailure(text: string): AuthFailureDetection {
  const haystack = (text ?? "").trim();
  if (!haystack) return { kind: "none", loginUrl: null };

  const loginUrl = haystack.match(URL_RE)?.[1] ?? null;

  // Order matters. A rate limit or 500 can sit next to the word "unauthorized"
  // in a log dump; treating that as an auth failure would send the founder to a
  // sign-in screen that cannot fix it.
  if (NOT_AUTH_RE.test(haystack) && !EXPIRED_RE.test(haystack.replace(NOT_AUTH_RE, ""))) {
    return { kind: "none", loginUrl: null };
  }

  // invalid_key before signed_out: "OPENAI_API_KEY is missing" is a key problem,
  // and its remedy (set a key) differs from signing in.
  if (INVALID_KEY_RE.test(haystack)) return { kind: "invalid_key", loginUrl };

  // signed_out before expired: an explicit "not logged in" is unambiguous, and
  // such messages often also carry the word "unauthorized".
  if (SIGNED_OUT_RE.test(haystack)) return { kind: "signed_out", loginUrl };

  if (EXPIRED_RE.test(haystack)) return { kind: "expired", loginUrl };

  return { kind: "none", loginUrl: null };
}

/** True when the failure is any kind of auth problem. */
export function isAuthFailure(kind: AuthFailureKind): boolean {
  return kind !== "none";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/adapter-utils && npx vitest run src/auth-failure-detector.test.ts`
Expected: PASS, 17 tests.

If "ignores prose that merely discusses authorization" fails, the prose contains
no auth-failure verb and no status code — confirm `NOT_AUTH_RE`/`EXPIRED_RE`
aren't matching the bare word "authorization"; `EXPIRED_RE` uses `unauthorized`,
which does not appear in that sentence.

- [ ] **Step 5: Export from the package index**

Modify `packages/adapter-utils/src/index.ts` — append:

```ts
export { detectAuthFailure, isAuthFailure } from "./auth-failure-detector.js";
export type { AuthFailureKind, AuthFailureDetection } from "./auth-failure-detector.js";
```

- [ ] **Step 6: Typecheck and commit**

```bash
cd packages/adapter-utils && npx tsc --noEmit
git add packages/adapter-utils/src/auth-failure-detector.ts packages/adapter-utils/src/auth-failure-detector.test.ts packages/adapter-utils/src/index.ts
git commit -m "feat(adapters): shared auth-failure detector separating expired from signed-out"
```

---

## Task 1 outcome — corrections applied (read before Task 2)

Task 1 shipped, but code review found a **critical defect in the code this plan
originally specified**. The detector in the tree now differs from the Task 1
listing above. Treat the committed code as the source of truth, not the listing.

What changed, and why it matters to later tasks:

1. **The `NOT_AUTH_RE` escape branch was wrong.** It re-tested the stripped
   residual against `EXPIRED_RE` only, so any input carrying a noise token AND a
   sign-in signal returned `none` — e.g. ``Login timed out. Please run `claude
   login`.`` classified as `none` rather than `signed_out`. That is the exact
   under-detection this feature exists to eliminate, and "login timed out" is
   standard device-flow phrasing. Replaced with: strip noise once via a `/g`
   `NOT_AUTH_STRIP`, then classify the residual invalid_key → signed_out →
   expired. `NOT_AUTH_STRIP` must never be passed to `.test()` (`/g` makes
   `.test()` stateful via `lastIndex`).

2. **`URL_RE` was deleted.** It duplicated and regressed
   `login-url-detector.ts`, which already skips loopback callbacks — `codex
   login` prints `http://localhost:1455` BEFORE the real auth URL, so the naive
   matcher produced a dead localhost link. The detector now calls a new exported
   `extractVerificationUrl(text)` from that module. It is NOT re-exported from
   the package index; if Task 4 or 5 wants it directly, import from
   `@armyofagents/adapter-utils/login-url-detector` or add the barrel export.

3. **`5\d{2}` was anchored** to `(?:error|status|HTTP)\D{0,10}5\d{2}`,
   because the bare form matched any three-digit number (`Used 512 tokens.`).

4. **The classifier regexes are now built from named pattern arrays** joined with
   `|`, so each alternative is individually greppable. Tasks 2-5 that add
   CLI-specific wording should add entries to those arrays, not edit a 200-char
   literal.

5. **Signature widened** to `detectAuthFailure(text: string | null | undefined)`.

6. **Input contract, now documented in the module header and binding on Tasks
   2-5:** feed this ONLY process failure output (stdout/stderr/parsed CLI error
   fields), never transcript or agent-authored content. Prose that merely
   discusses auth (`Return 401 Unauthorized when the Authorization header is
   missing`) will classify as an auth failure.

Detector suite is 25 tests; `packages/adapter-utils` is 166 passed / 1 skipped
(the skip is pre-existing and unrelated).

---

## Task 2: Claude parse.ts delegates to the shared detector

**Files:**
- Modify: `packages/adapters/claude-local/src/server/parse.ts:4` and `:124-141`
- Test: `packages/adapters/claude-local/src/server/parse.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/adapters/claude-local/src/server/parse.test.ts`:

```ts
describe("detectClaudeLoginRequired — expired credentials (regression)", () => {
  const REVOKED_401 =
    'Failed to authenticate. API Error: 401 {"type":"error","error":' +
    '{"type":"authentication_error","message":"OAuth access token has been revoked."},"request_id":null}';

  it("treats a revoked token as requiring login", () => {
    const r = detectClaudeLoginRequired({ parsed: null, stdout: REVOKED_401, stderr: "" });
    expect(r.requiresLogin).toBe(true);
  });

  it("reports kind=expired for a revoked token, not signed_out", () => {
    const r = detectClaudeLoginRequired({ parsed: null, stdout: REVOKED_401, stderr: "" });
    expect(r.kind).toBe("expired");
  });

  it("still reports kind=signed_out when never signed in", () => {
    const r = detectClaudeLoginRequired({
      parsed: null,
      stdout: "You are not logged in. Please run `claude login`.",
      stderr: "",
    });
    expect(r.requiresLogin).toBe(true);
    expect(r.kind).toBe("signed_out");
  });

  it("does not flag a rate limit as a login problem", () => {
    const r = detectClaudeLoginRequired({
      parsed: null,
      stdout: "API Error: 429 rate limit exceeded",
      stderr: "",
    });
    expect(r.requiresLogin).toBe(false);
    expect(r.kind).toBe("none");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/adapters/claude-local && npx vitest run src/server/parse.test.ts -t "expired credentials"`
Expected: FAIL — the revoked case returns `requiresLogin: false`, and `kind` is undefined.

- [ ] **Step 3: Implement**

In `packages/adapters/claude-local/src/server/parse.ts`, add the import at the top (beside the existing `@armyofagents/adapter-utils` imports on lines 1-2):

```ts
import { detectAuthFailure, type AuthFailureKind } from "@armyofagents/adapter-utils";
```

Delete the `CLAUDE_AUTH_REQUIRED_RE` constant on line 4 (the shared detector replaces it), and replace the body of `detectClaudeLoginRequired`:

```ts
export function detectClaudeLoginRequired(input: {
  parsed: Record<string, unknown> | null;
  stdout: string;
  stderr: string;
}): { requiresLogin: boolean; loginUrl: string | null; kind: AuthFailureKind } {
  const resultText = asString(input.parsed?.result, "").trim();
  const haystack = [
    resultText,
    ...extractClaudeErrorMessages(input.parsed ?? {}),
    input.stdout,
    input.stderr,
  ].join("\n");

  // Shared detector: the old local regex matched only never-signed-in phrasing
  // and missed every revoked/expired/401 failure.
  const { kind } = detectAuthFailure(haystack);

  return {
    requiresLogin: kind !== "none",
    loginUrl: extractClaudeLoginUrl([input.stdout, input.stderr].join("\n")),
    kind,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/adapters/claude-local && npx vitest run src/server/parse.test.ts`
Expected: PASS — the new block plus all pre-existing parse tests.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/claude-local/src/server/parse.ts packages/adapters/claude-local/src/server/parse.test.ts
git commit -m "fix(claude-local): detect revoked/expired credentials as requiring login"
```

---

## Task 3: `claude auth status` reader

**Files:**
- Create: `packages/adapters/claude-local/src/server/auth-status.ts`
- Create: `packages/adapters/claude-local/src/server/auth-status.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/adapters/claude-local/src/server/auth-status.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseClaudeAuthStatus } from "./auth-status.js";

describe("parseClaudeAuthStatus", () => {
  it("reads a logged-in account", () => {
    const out = JSON.stringify({
      loggedIn: true,
      authMethod: "claude.ai",
      email: "ada@example.com",
      subscriptionType: "max",
    });
    expect(parseClaudeAuthStatus(out)).toEqual({ loggedIn: true, account: "ada@example.com" });
  });

  it("reads a logged-in account with no email", () => {
    expect(parseClaudeAuthStatus(JSON.stringify({ loggedIn: true }))).toEqual({
      loggedIn: true,
      account: null,
    });
  });

  it("reads a logged-out state", () => {
    expect(parseClaudeAuthStatus(JSON.stringify({ loggedIn: false }))).toEqual({
      loggedIn: false,
      account: null,
    });
  });

  // An older CLI without `auth status` prints usage text or an error. We must
  // degrade to "assume signed out" rather than throw inside the probe.
  it("treats unparseable output as not-logged-in instead of throwing", () => {
    expect(parseClaudeAuthStatus("error: unknown command 'auth'")).toEqual({
      loggedIn: false,
      account: null,
    });
  });

  it("treats empty output as not-logged-in", () => {
    expect(parseClaudeAuthStatus("")).toEqual({ loggedIn: false, account: null });
  });

  it("tolerates surrounding log noise around the JSON", () => {
    const out = 'warning: config\n{"loggedIn":true,"email":"ada@example.com"}\n';
    expect(parseClaudeAuthStatus(out)).toEqual({ loggedIn: true, account: "ada@example.com" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/adapters/claude-local && npx vitest run src/server/auth-status.test.ts`
Expected: FAIL — cannot resolve `./auth-status.js`.

- [ ] **Step 3: Implement**

Create `packages/adapters/claude-local/src/server/auth-status.ts`:

```ts
/**
 * Reads `claude auth status`, which reports whether CREDENTIALS EXIST locally —
 * not whether they still work. A revoked token still yields `loggedIn: true`;
 * that mismatch is precisely the trap this exists to expose. Pair it with the
 * hello probe: status says who is signed in, the probe says whether it works.
 *
 * Parsing only. The caller owns spawning, so this stays synchronously testable.
 */

export interface ClaudeAuthStatus {
  /** Credentials are present on disk. Says nothing about validity. */
  loggedIn: boolean;
  /** Account label to show the founder ("ada@example.com"), when known. */
  account: string | null;
}

const SIGNED_OUT: ClaudeAuthStatus = { loggedIn: false, account: null };

/**
 * Never throws: an older CLI without `auth status` prints usage text, and the
 * probe must degrade to signed-out copy rather than crash mid-verification.
 */
export function parseClaudeAuthStatus(stdout: string): ClaudeAuthStatus {
  const text = (stdout ?? "").trim();
  if (!text) return SIGNED_OUT;

  // The CLI may emit warnings around the JSON, so take the outermost object.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return SIGNED_OUT;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return SIGNED_OUT;
  }
  if (!parsed || typeof parsed !== "object") return SIGNED_OUT;

  const obj = parsed as Record<string, unknown>;
  const loggedIn = obj.loggedIn === true;
  const email = typeof obj.email === "string" && obj.email.trim() ? obj.email.trim() : null;
  return { loggedIn, account: loggedIn ? email : null };
}

/** Argv for the status probe. Kept here so the probe and tests agree. */
export const CLAUDE_AUTH_STATUS_ARGS = ["auth", "status"] as const;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/adapters/claude-local && npx vitest run src/server/auth-status.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/claude-local/src/server/auth-status.ts packages/adapters/claude-local/src/server/auth-status.test.ts
git commit -m "feat(claude-local): parse claude auth status (credential presence, not validity)"
```

---

## Field evidence from the REAL claude CLI (read before Task 4)

A reviewer ran `claude` 2.1.126 with a deliberately invalid key rather than
reasoning from mocks. The actual failure payload:

```json
{"type":"result","subtype":"success","is_error":true,"api_error_status":401,
 "result":"Failed to authenticate. API Error: 401 {...authentication_error...}"}
```

Exit code is 1. Four consequences for Task 4:

1. **`subtype` is `"success"` on an auth FAILURE.** `is_error: true` is the real
   signal. Any probe logic that trusts `subtype` will mis-read this. (This is the
   same class as the known Commander bug where `handleResultEvent` ignored
   `is_error` and produced silent empty turns.)
2. **`api_error_status: 401` is a STRUCTURED field.** Prefer it over regex-
   matching prose where available — a number beats a pattern. Treat the shared
   text detector as the fallback for CLIs that don't provide one.
3. **The 401 text lives in `parsed.result`**, which Task 2b deliberately excluded
   from the haystack (it is also where agent prose lives). Detection therefore
   depends on `stdout` being included, which is gated on `exitCode !== 0`. That
   gate is load-bearing — do not "simplify" it away.
4. **`parsed.errors` is never populated by this CLI.** The existing
   `extractClaudeErrorMessages` path is real but unexercised in practice; do not
   assume auth errors arrive there.

Also fold into Task 4 (identified in the Task 2b review, inert today but live the
moment Task 7 renders it): `detectClaudeLoginRequired` throws away a correctly-
gated `loginUrl`. `detectAuthFailure` returns `loginUrl: null` whenever
`kind === "none"`, but parse.ts destructures only `{ kind }` and falls back to
`extractClaudeLoginUrl`, which returns the FIRST URL of any kind when no
auth-shaped URL matches. Destructure `loginUrl` from the shared detector and
prefer it.

---

## Task 4: Claude probe emits auth_required vs auth_expired

**Files:**
- Modify: `packages/adapters/claude-local/src/server/test.ts:219-245`
- Test: `packages/adapters/claude-local/src/server/test.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/adapters/claude-local/src/server/test.test.ts`. Match the
mocking style already used in that file for `runAdapterExecutionTargetProcess`;
if it mocks a module, add the status call to the same mock queue.

```ts
describe("claude probe — expired vs signed-out (regression)", () => {
  const REVOKED_401 =
    'Failed to authenticate. API Error: 401 {"type":"error","error":' +
    '{"type":"authentication_error","message":"OAuth access token has been revoked."},"request_id":null}';

  it("emits auth_expired and names the account when credentials exist but are rejected", async () => {
    // hello probe fails with a 401; `claude auth status` says still logged in.
    const result = await runProbeWith({
      hello: { exitCode: 1, stdout: REVOKED_401, stderr: "", timedOut: false },
      authStatus: { exitCode: 0, stdout: JSON.stringify({ loggedIn: true, email: "ada@example.com" }) },
    });
    const check = result.checks.find((c) => c.code === "claude_hello_probe_auth_expired");
    expect(check).toBeTruthy();
    expect(check?.message).toContain("ada@example.com");
    expect(result.checks.some((c) => c.code === "claude_hello_probe_failed")).toBe(false);
  });

  it("emits auth_required when there are no credentials at all", async () => {
    const result = await runProbeWith({
      hello: { exitCode: 1, stdout: "You are not logged in. Please run `claude login`.", stderr: "", timedOut: false },
      authStatus: { exitCode: 1, stdout: JSON.stringify({ loggedIn: false }) },
    });
    expect(result.checks.some((c) => c.code === "claude_hello_probe_auth_required")).toBe(true);
  });

  it("falls back to auth_required when the status command is unavailable", async () => {
    const result = await runProbeWith({
      hello: { exitCode: 1, stdout: REVOKED_401, stderr: "", timedOut: false },
      authStatus: { exitCode: 1, stdout: "error: unknown command 'auth'" },
    });
    expect(result.checks.some((c) => c.code.startsWith("claude_hello_probe_auth"))).toBe(true);
    expect(result.checks.some((c) => c.code === "claude_hello_probe_failed")).toBe(false);
  });

  it("leaves a non-auth failure as a plain failure", async () => {
    const result = await runProbeWith({
      hello: { exitCode: 1, stdout: "API Error: 500 internal server error", stderr: "", timedOut: false },
      authStatus: { exitCode: 0, stdout: JSON.stringify({ loggedIn: true, email: "ada@example.com" }) },
    });
    expect(result.checks.some((c) => c.code === "claude_hello_probe_failed")).toBe(true);
  });
});
```

Add this helper to the same file. It reuses the provider-sandbox runner seam the
existing tests already use, dispatching on argv: `--print` is the hello probe,
`auth`+`status` is the new status call.

```ts
import { testEnvironment } from "./test.js";
import type { AdapterProviderSandboxRunInput } from "@armyofagents/adapter-utils";

type FakeRun = { exitCode: number; stdout: string; stderr?: string; timedOut?: boolean };

async function runProbeWith(opts: { hello: FakeRun; authStatus: FakeRun }) {
  const runner = {
    execute: vi.fn(async (input: AdapterProviderSandboxRunInput) => {
      const isStatus = input.args.includes("auth") && input.args.includes("status");
      const r = isStatus ? opts.authStatus : opts.hello;
      return {
        exitCode: r.exitCode,
        signal: null,
        timedOut: r.timedOut ?? false,
        stdout: r.stdout,
        stderr: r.stderr ?? "",
      };
    }),
  };
  return testEnvironment({
    adapterType: "claude_local",
    companyId: "company-1",
    config: { command: "claude", env: {} },
    environmentName: "probe-test",
    executionTarget: {
      type: "provider-sandbox",
      provider: "e2b",
      providerLeaseId: "sandbox-1",
      remoteCwd: "/home/user/aoa-workspace",
      shell: "bash",
      runner,
    },
  });
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/adapters/claude-local && npx vitest run src/server/test.test.ts -t "expired vs signed-out"`
Expected: FAIL — no `claude_hello_probe_auth_expired` check is ever emitted.

- [ ] **Step 3: Implement**

In `packages/adapters/claude-local/src/server/test.ts`, add near the existing imports:

```ts
import { CLAUDE_AUTH_STATUS_ARGS, parseClaudeAuthStatus } from "./auth-status.js";
```

Replace the `else if (loginMeta.requiresLogin) { … }` branch (lines ~235-245) with:

```ts
      } else if (loginMeta.requiresLogin) {
        // The hello probe says auth failed. Ask the CLI whether credentials
        // even exist, so we can tell "never signed in" from "signed in but the
        // session was revoked" — the second is the common case and used to be
        // reported as a generic failure with no recovery offered.
        //
        // Runs ONLY on the failure path, so the happy path costs nothing extra.
        // Any problem here degrades to the signed-out message; the status
        // command enriches the message, it never gates the result.
        let account: string | null = null;
        let credentialsExist = false;
        try {
          const statusProbe = await runAdapterExecutionTargetProcess(
            target ?? { type: "local" },
            {
              runId,
              command,
              args: [...CLAUDE_AUTH_STATUS_ARGS],
              cwd,
              env,
              runtimeCommandSpec: null,
              timeoutSec: 10,
              graceSec: 2,
              onLog: async () => {},
            },
          );
          const status = parseClaudeAuthStatus(statusProbe.stdout);
          credentialsExist = status.loggedIn;
          account = status.account;
        } catch {
          // Older CLI or spawn failure — fall through as signed out.
        }

        if (credentialsExist) {
          checks.push({
            code: "claude_hello_probe_auth_expired",
            level: "warn",
            message: account
              ? `Signed in as ${account}, but that session has expired or been revoked.`
              : "Your Claude sign-in has expired or been revoked.",
            ...(detail ? { detail } : {}),
            hint: "Sign in again — paste an API key below, or run `claude login` in a terminal and we'll detect it.",
          });
        } else {
          checks.push({
            code: "claude_hello_probe_auth_required",
            level: "warn",
            message: "Claude CLI is installed, but you're not signed in yet.",
            ...(detail ? { detail } : {}),
            hint: loginMeta.loginUrl
              ? `Run \`claude login\` and complete sign-in at ${loginMeta.loginUrl}, then retry.`
              : "Run `claude login` in this environment, then retry the probe.",
          });
        }
      } else if ((probe.exitCode ?? 1) === 0) {
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/adapters/claude-local && npx vitest run src/server/test.test.ts`
Expected: PASS — the new block plus all pre-existing probe tests.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/claude-local/src/server/test.ts packages/adapters/claude-local/src/server/test.test.ts
git commit -m "feat(claude-local): distinguish expired sign-in from never-signed-in in the probe"
```

---

## Task 5: Codex parity

**Files:**
- Create: `packages/adapters/codex-local/src/server/auth-status.ts`
- Create: `packages/adapters/codex-local/src/server/auth-status.test.ts`
- Modify: `packages/adapters/codex-local/src/server/test.ts:60` and `:294-300`

- [ ] **Step 1: Write the failing test for the status parser**

Create `packages/adapters/codex-local/src/server/auth-status.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseCodexAuthStatus } from "./auth-status.js";

// `codex login status` prints PROSE, not JSON — observed: "Logged in using ChatGPT".
describe("parseCodexAuthStatus", () => {
  it("reads the ChatGPT logged-in line", () => {
    expect(parseCodexAuthStatus("Logged in using ChatGPT")).toEqual({
      loggedIn: true,
      account: "ChatGPT",
    });
  });

  it("reads an API-key logged-in line", () => {
    expect(parseCodexAuthStatus("Logged in using an API key")).toEqual({
      loggedIn: true,
      account: "an API key",
    });
  });

  it("reads a logged-out line", () => {
    expect(parseCodexAuthStatus("Not logged in")).toEqual({ loggedIn: false, account: null });
  });

  it("treats unrecognised output as not-logged-in", () => {
    expect(parseCodexAuthStatus("error: unknown command 'login'")).toEqual({
      loggedIn: false,
      account: null,
    });
  });

  it("treats empty output as not-logged-in", () => {
    expect(parseCodexAuthStatus("")).toEqual({ loggedIn: false, account: null });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/adapters/codex-local && npx vitest run src/server/auth-status.test.ts`
Expected: FAIL — cannot resolve `./auth-status.js`.

- [ ] **Step 3: Implement the status parser**

Create `packages/adapters/codex-local/src/server/auth-status.ts`:

```ts
/**
 * Reads `codex login status`. Unlike `claude auth status` this prints PROSE,
 * not JSON — observed output: "Logged in using ChatGPT". Like its Claude
 * sibling it reports that credentials EXIST, not that they still work.
 *
 * There is no email in the output, so `account` carries the auth method and the
 * expired copy says "your Codex sign-in" rather than naming a person.
 */

export interface CodexAuthStatus {
  loggedIn: boolean;
  account: string | null;
}

const SIGNED_OUT: CodexAuthStatus = { loggedIn: false, account: null };

/** Never throws — unrecognised output degrades to signed-out. */
export function parseCodexAuthStatus(stdout: string): CodexAuthStatus {
  const text = (stdout ?? "").trim();
  if (!text) return SIGNED_OUT;

  if (/not\s+logged\s+in/i.test(text)) return SIGNED_OUT;

  const match = text.match(/logged\s+in\s+using\s+(.+?)\s*$/im);
  if (match) return { loggedIn: true, account: match[1]?.trim() || null };

  if (/^logged\s+in\b/im.test(text)) return { loggedIn: true, account: null };

  return SIGNED_OUT;
}

/** Argv for the status probe. */
export const CODEX_AUTH_STATUS_ARGS = ["login", "status"] as const;
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/adapters/codex-local && npx vitest run src/server/auth-status.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write the failing probe test**

Append to `packages/adapters/codex-local/src/server/test.test.ts`. Add a
`runProbeWith` helper of the same shape as Task 4's, but dispatching on Codex
argv (`login`+`status` is the status call, everything else is the hello probe)
and passing `adapterType: "codex_local"` with `config: { command: "codex", env: {} }`.
Check the existing tests in that file first — if it stubs a different seam than
the provider-sandbox runner, follow whichever seam that file already uses.

```ts
describe("codex probe — expired vs signed-out (regression)", () => {
  it("emits auth_expired when credentials exist but are rejected", async () => {
    const result = await runProbeWith({
      hello: { exitCode: 1, stdout: "API Error: 401 unauthorized", stderr: "", timedOut: false },
      authStatus: { exitCode: 0, stdout: "Logged in using ChatGPT" },
    });
    expect(result.checks.some((c) => c.code === "codex_hello_probe_auth_expired")).toBe(true);
  });

  it("emits auth_required when not signed in", async () => {
    const result = await runProbeWith({
      hello: { exitCode: 1, stdout: "Not logged in. Please run `codex login`.", stderr: "", timedOut: false },
      authStatus: { exitCode: 1, stdout: "Not logged in" },
    });
    expect(result.checks.some((c) => c.code === "codex_hello_probe_auth_required")).toBe(true);
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `cd packages/adapters/codex-local && npx vitest run src/server/test.test.ts -t "expired vs signed-out"`
Expected: FAIL — `codex_hello_probe_auth_expired` is never emitted.

- [ ] **Step 7: Implement the probe change**

In `packages/adapters/codex-local/src/server/test.ts`, add the import:

```ts
import { detectAuthFailure } from "@armyofagents/adapter-utils";
import { CODEX_AUTH_STATUS_ARGS, parseCodexAuthStatus } from "./auth-status.js";
```

Delete the `CODEX_AUTH_REQUIRED_RE` constant (line 60) and replace the
`} else if (CODEX_AUTH_REQUIRED_RE.test(authEvidence)) { … }` branch with:

```ts
      } else if (detectAuthFailure(authEvidence).kind !== "none") {
        // Same two-outcome split as claude-local: ask whether credentials exist
        // so an expired session isn't reported as "never signed in".
        let credentialsExist = false;
        let account: string | null = null;
        try {
          const statusProbe = await runAdapterExecutionTargetProcess(
            target ?? { type: "local" },
            {
              runId,
              command,
              args: [...CODEX_AUTH_STATUS_ARGS],
              cwd,
              env,
              runtimeCommandSpec: null,
              timeoutSec: 10,
              graceSec: 2,
              onLog: async () => {},
            },
          );
          const status = parseCodexAuthStatus(statusProbe.stdout);
          credentialsExist = status.loggedIn;
          account = status.account;
        } catch {
          // Fall through as signed out.
        }

        if (credentialsExist) {
          checks.push({
            code: "codex_hello_probe_auth_expired",
            level: "warn",
            message: account
              ? `Codex is signed in using ${account}, but that session has expired or been rejected.`
              : "Your Codex sign-in has expired or been rejected.",
            ...(detail ? { detail } : {}),
            hint: "Sign in again — paste an API key below, or run `codex login` in a terminal and we'll detect it.",
          });
        } else {
          checks.push({
            code: "codex_hello_probe_auth_required",
            level: "warn",
            message: "Codex CLI is installed, but you're not signed in yet.",
            ...(detail ? { detail } : {}),
            hint: "Configure OPENAI_API_KEY in adapter env/shell or run `codex login`, then retry the probe.",
          });
        }
      } else {
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd packages/adapters/codex-local && npx vitest run src/server/`
Expected: PASS — new block plus all pre-existing codex probe tests.

- [ ] **Step 9: Commit**

```bash
git add packages/adapters/codex-local/src/server/
git commit -m "feat(codex-local): distinguish expired sign-in from never-signed-in"
```

---

## Task 6: Server classifier

**Files:**
- Modify: `server/src/services/commander-verify.ts:66-78`
- Test: `server/src/__tests__/commander-verify.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `server/src/__tests__/commander-verify.test.ts` (create it with the
same import style as neighbouring service tests if absent):

```ts
import { describe, it, expect } from "vitest";
import { classifyCommanderProbe } from "../services/commander-verify.js";

const probe = (checks: { code: string; level?: string; message?: string; detail?: string }[]) =>
  ({ adapterType: "claude_local", status: "fail", checks, testedAt: new Date().toISOString() }) as never;

describe("classifyCommanderProbe — auth outcomes", () => {
  it("classifies an expired session as needs_auth so recovery is offered", () => {
    const r = classifyCommanderProbe(
      probe([{ code: "claude_hello_probe_auth_expired", level: "warn", message: "session revoked" }]),
    );
    expect(r.outcome).toBe("needs_auth");
  });

  it("still classifies auth_required as needs_auth", () => {
    const r = classifyCommanderProbe(
      probe([{ code: "claude_hello_probe_auth_required", level: "warn", message: "not signed in" }]),
    );
    expect(r.outcome).toBe("needs_auth");
  });

  // Defence in depth: an adapter that forgets the shared detector must not
  // dead-end the founder just because its code name is unrecognised.
  it("falls back to needs_auth when an unknown code carries a 401 in its detail", () => {
    const r = classifyCommanderProbe(
      probe([
        {
          code: "some_future_adapter_probe_failed",
          level: "error",
          message: "probe failed",
          detail: 'API Error: 401 {"type":"authentication_error"}',
        },
      ]),
    );
    expect(r.outcome).toBe("needs_auth");
  });

  it("leaves a genuine non-auth failure as failed", () => {
    const r = classifyCommanderProbe(
      probe([{ code: "claude_hello_probe_failed", level: "error", message: "API Error: 500" }]),
    );
    expect(r.outcome).toBe("failed");
  });

  it("does not treat a rate limit as an auth problem", () => {
    const r = classifyCommanderProbe(
      probe([{ code: "claude_hello_probe_failed", level: "error", detail: "429 rate limit exceeded" }]),
    );
    expect(r.outcome).toBe("failed");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run src/__tests__/commander-verify.test.ts`
Expected: FAIL — `auth_expired` and the 401-detail fallback both return `failed`.

- [ ] **Step 3: Implement**

In `server/src/services/commander-verify.ts`, add the import:

```ts
import { detectAuthFailure } from "@armyofagents/adapter-utils";
```

Replace the body of `classifyCommanderProbe`:

```ts
export function classifyCommanderProbe(result: AdapterEnvironmentTestResult): {
  outcome: CommanderVerifyOutcome;
  result: AdapterEnvironmentTestResult;
} {
  if (result.status === "pass") return { outcome: "verified", result };
  const codes = result.checks.map((c) => c.code);
  const anyCode = (needle: string) => codes.some((c) => c.includes(needle));

  // `auth_expired` is the revoked/expired session; `auth_required` is never
  // signed in. Both are recoverable in-app, so both are needs_auth.
  if (anyCode("auth_required") || anyCode("auth_expired") || anyCode("login")) {
    return { outcome: "needs_auth", result };
  }
  if (anyCode("command_unresolvable") || anyCode("not_installed") || anyCode("install")) {
    return { outcome: "not_installed", result };
  }

  // Defence in depth: classify on the TEXT when the code is unrecognised. An
  // adapter that hasn't adopted the shared detector would otherwise dead-end
  // the founder on a plain `failed` with no recovery offered — the exact bug
  // this change exists to fix.
  const blob = result.checks
    .map((c) => `${c.message ?? ""} ${(c as { detail?: string }).detail ?? ""}`)
    .join("\n");
  if (detectAuthFailure(blob).kind !== "none") {
    return { outcome: "needs_auth", result };
  }

  if (result.status === "warn") return { outcome: "verified", result };
  return { outcome: "failed", result };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npx vitest run src/__tests__/commander-verify.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
cd server && npx tsc --noEmit -p tsconfig.json
git add server/src/services/commander-verify.ts server/src/__tests__/commander-verify.test.ts
git commit -m "fix(commander-verify): classify expired sessions as needs_auth, with a text fallback"
```

---

## Task 7: Verify-step copy for the expired case

**Files:**
- Modify: `ui/src/onboarding/steps/VerifyStep.tsx`
- Test: `ui/src/onboarding/steps/__tests__/VerifyStep.test.tsx`

The per-check breakdown and `authHintFrom()` already exist (commit `2d4ddea08`).
This task makes the headline reflect the server's finer distinction.

- [ ] **Step 1: Write the failing test**

Append to `ui/src/onboarding/steps/__tests__/VerifyStep.test.tsx`:

```ts
describe("VerifyStep — expired vs never-signed-in copy", () => {
  beforeEach(() => vi.clearAllMocks());

  it("names the account and says the session expired", async () => {
    post.mockRejectedValueOnce(
      new ApiError("Request failed: 422", 422, {
        outcome: "needs_auth",
        result: {
          status: "fail",
          checks: [
            {
              code: "claude_hello_probe_auth_expired",
              level: "error",
              message: "Signed in as ada@example.com, but that session has expired or been revoked.",
              hint: "Sign in again — paste an API key below, or run `claude login` in a terminal.",
            },
          ],
        },
      }),
    );
    render(<VerifyStep ctx={ctx} onComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    expect(await screen.findByText(/ada@example\.com/)).toBeTruthy();
    expect(screen.getByText(/expired or been revoked/i)).toBeTruthy();
    // Recovery must be offered — the dead end is the bug.
    expect(screen.getByText(/Paste an API key/i)).toBeTruthy();
  });

  it("uses not-signed-in copy when there are no credentials", async () => {
    post.mockRejectedValueOnce(
      new ApiError("Request failed: 422", 422, {
        outcome: "needs_auth",
        result: {
          status: "fail",
          checks: [
            {
              code: "claude_hello_probe_auth_required",
              level: "error",
              message: "Claude CLI is installed, but you're not signed in yet.",
            },
          ],
        },
      }),
    );
    render(<VerifyStep ctx={ctx} onComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    expect(await screen.findByText(/not signed in yet/i)).toBeTruthy();
    expect(screen.queryByText(/expired or been revoked/i)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ui && npx vitest run src/onboarding/steps/__tests__/VerifyStep.test.tsx -t "expired vs never-signed-in"`
Expected: FAIL — the needs_auth panel prints its own generic sentence and the
account never appears.

- [ ] **Step 3: Implement**

In `ui/src/onboarding/steps/VerifyStep.tsx`, replace the needs_auth panel's
leading paragraph:

```tsx
            <p className="text-text">
              {checks.find((c) => c.code?.includes("auth_expired"))?.message ??
                authHintFrom(checks) ??
                `The ${providerLabel} CLI is installed but needs sign-in.`}{" "}
              Choose one — no terminal required:
            </p>
```

The server already writes the precise sentence (naming the account when it knows
it), so the UI shows it verbatim rather than re-deriving it.

- [ ] **Step 4: Run to verify it passes**

Run: `cd ui && npx vitest run src/onboarding/steps/__tests__/VerifyStep.test.tsx`
Expected: PASS — new block plus all pre-existing VerifyStep tests.

- [ ] **Step 5: Commit**

```bash
git add ui/src/onboarding/steps/VerifyStep.tsx ui/src/onboarding/steps/__tests__/VerifyStep.test.tsx
git commit -m "feat(onboarding): Verify step names the account when a session expired"
```

---

## Task 8: Live verification against the genuinely revoked token

The `memstep` instance on port 3120 has a real revoked Claude token. This is the
environment the bug was found in and is the acceptance test — no mock can prove
the end-to-end classification.

- [ ] **Step 1: Rebuild the changed packages**

```bash
cd /c/Users/TK/.aoa/wt/memstep
git fetch && git checkout <this-branch-commit>
pnpm --filter @armyofagents/adapter-utils build
pnpm --filter @armyofagents/shared build
```

- [ ] **Step 2: Restart the instance**

Kill the running dev-runner, then:

```bash
cd /c/Users/TK/.aoa/wt/memstep
AOA_INSTANCE_ID=memstep AOA_HOME=/c/Users/TK/.aoa/wt/memstep/.aoa PORT=3120 \
AOA_EMBEDDED_POSTGRES_PORT=54430 AOA_DEV_LOCAL_IDENTITY=1 \
node scripts/dev-runner.mjs watch > /tmp/memstep.log 2>&1 &
```

Wait for `/api/health` to return `"status":"ok"`.

- [ ] **Step 3: Hit the verify route directly**

```bash
CID=dfb844b4-ddda-4c7e-b38a-d9642ca59d2f
curl -s -X POST "http://127.0.0.1:3120/api/companies/$CID/internal-agent/verify" \
  -H "content-type: application/json" -d '{}' | python -m json.tool
```

Expected, and each is a hard gate:
- `outcome` is `needs_auth` (was `failed`)
- a check with code `claude_hello_probe_auth_expired`
- its `message` contains `tandavkrishna27@gmail.com`
- no raw `stream-json` in `message` (it may remain in `detail`)

- [ ] **Step 4: Confirm in the browser**

Open the Verify step and confirm it shows the per-check breakdown with the
failure marked failed, the expired sentence naming the account, and the API-key
and terminal-detect recovery options.

- [ ] **Step 5: Full suites**

```bash
cd ui && npx vitest run
cd ../server && npx vitest run src/__tests__/commander-verify.test.ts src/__tests__/aoa-trigger-prompt.test.ts src/__tests__/braindump.test.ts
cd ../packages/adapter-utils && npx vitest run
cd ../adapters/claude-local && npx vitest run
cd ../codex-local && npx vitest run
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git commit --allow-empty -m "test: live-verify expired-session classification against a revoked token"
```

---

## Out of scope (deliberate)

- **In-app Claude sign-in** via `claude setup-token`. Claude keeps API-key paste
  plus terminal auto-detect; Codex keeps its device login. Needs its own spike.
- **Inbox items / Settings banners** for expired sessions.
- **Gemini and acpx adapters.** They share the gap and can adopt
  `detectAuthFailure` later; this change does not touch them.
