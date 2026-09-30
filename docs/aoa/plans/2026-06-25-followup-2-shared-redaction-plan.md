# Shared Redaction Module (Follow-up #2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the duplicated env-redaction patterns by extracting the byte-identical key regex + 9 value patterns + helper functions into ONE browser-safe shared module (`packages/shared/src/redaction.ts`) that both the Node-only server adapter-utils package and the browser UI import. Zero behavior change — the existing behavior-lock test suites in adapter-utils and ui must keep passing **unchanged**.

**Architecture:** `packages/shared` is browser-safe (only runtime dep is `zod`) and imports nothing from `adapter-utils`, so `adapter-utils` (and `ui`) depending on `shared` introduces no dependency cycle. The shared module holds pure data (`SENSITIVE_ENV_KEY`, `SENSITIVE_ENV_VALUE_PATTERNS`) + pure functions (`looksLikeSecretValue`, `shouldRedactSecretValue`, `redactEnvForLogs`) — no Node imports. `packages/adapter-utils/src/server-utils.ts` deletes its inline copies and re-exports `redactEnvForLogs` + `looksLikeSecretValue` from `@armyofagents/shared`, preserving every existing `@armyofagents/adapter-utils/server-utils` import path. `ui/src/lib/env-redaction.ts` imports the patterns + `shouldRedactSecretValue` from `@armyofagents/shared` and keeps its UI-only `redactEnvValue` (the `secret_ref` superset) + `formatEnvForDisplay` as thin wrappers. All ~40 UI imports of shared use the **root barrel** (`from "@armyofagents/shared"`), so the new module is re-exported from `packages/shared/src/index.ts`.

**Tech Stack:** TypeScript (ESM, `.js`-suffixed relative imports), pnpm workspace (`pnpm@9.15.4`), Vitest 3.2.6, `tsc` for build/typecheck. Test runners: `pnpm --filter @armyofagents/shared test`, `pnpm --filter @armyofagents/adapter-utils test:run`, `pnpm --filter @armyofagents/ui test:run`. Workspace build: `pnpm build` (`pnpm -r build`).

---

## File Structure

```
packages/shared/src/
  redaction.ts                         (NEW) — pure patterns + functions, re-exported from index.ts
  index.ts                             (EDIT) — add re-export of redaction members
  __tests__/redaction.test.ts          (NEW) — EXHAUSTIVE pattern/function test (every key fragment, all 9 value patterns, negatives/edges, barrel re-export). No e2e — pure functions; rationale in Task 1.

packages/adapter-utils/
  package.json                         (EDIT) — add @armyofagents/shared to dependencies
  src/server-utils.ts                  (EDIT) — delete inline constants/functions; re-export from shared
  src/__tests__/redact-env-for-logs.test.ts   (UNCHANGED — behavior oracle, must keep passing)

ui/src/lib/
  env-redaction.ts                     (EDIT) — import patterns + shouldRedactSecretValue from shared; keep wrappers
  __tests__/env-redaction.test.ts      (UNCHANGED — behavior oracle, must keep passing)
```

**Branch:** off `main` — `fix/followup-2-shared-redaction`. Own PR. AoA is not open source — no OSS license headers. Commit messages end with the trailer shown in each commit step.

**Verified facts honored by this plan (confirmed by hand against the worktree):**

- Server source: `packages/adapter-utils/src/server-utils.ts` — `SENSITIVE_ENV_KEY` at line 97-98, `SENSITIVE_ENV_VALUE_PATTERNS` (9 patterns) at lines 109-130, `looksLikeSecretValue` at lines 132-134, `redactEnvForLogs` at lines 198-207. That file imports `node:child_process`/`node:fs`/`node:os`/`node:path` (lines 1-4) → Node-only → that's why the UI copied rather than imported.
- UI copy: `ui/src/lib/env-redaction.ts` lines 10-31 (`SECRET_ENV_KEY_RE` + 9 `SECRET_ENV_VALUE_PATTERNS`) is byte-identical to the server's key regex + value patterns. `shouldRedactSecretValue` (lines 33-37) is the UI's combiner. `redactEnvValue` (39-56, handles `secret_ref` → `"***SECRET_REF***"`) and `formatEnvForDisplay` (58-69) are UI-only and stay in the UI file. The file also imports `asRecord` from `./run-metrics` (line 1) — keep it.
- `packages/shared` browser-safe: only runtime dep is `zod` (`packages/shared/package.json` line 34-36).
- `packages/shared/src/index.ts` is the barrel and imports nothing from adapter-utils → no cycle (verified by reading the barrel: all its `from` targets are `./*.js` shared-local modules).
- All UI imports of shared go through the root barrel `@armyofagents/shared` — so the re-export MUST be from `index.ts` (not the `./*` subpath).
- adapter-utils `package.json` currently has **no `dependencies` block** — adding `@armyofagents/shared` is a clean add (devDependencies has `@types/node` + `typescript`).
- Importers of `redactEnvForLogs` from `server-utils` (the re-export must keep these valid):
  - `server/src/adapters/utils.ts:19` — `from "@armyofagents/adapter-utils/server-utils"` (re-export shim for in-tree imports)
  - `server/src/adapters/process/execute.ts:9` — `from "../utils.js"` (the shim above)
  - `packages/adapters/claude-local/src/server/execute.ts:28` — `from "@armyofagents/adapter-utils/server-utils"`
  - `packages/adapters/codex-local/src/server/execute.ts:20` — same
  - `packages/adapters/cursor-local/src/server/execute.ts:25` — same
  - `packages/adapters/gemini-local/src/server/execute.ts:23` — same
  - `packages/adapters/opencode-local/src/server/execute.ts:21` — same
  - `server/src/__tests__/aoa-heartbeat-kind-guard.test.ts:110` — mocks `redactEnvForLogs` (does not import the real one; unaffected)
  - No consumer imports `looksLikeSecretValue` by name (it is `export`ed but currently only used internally by `redactEnvForLogs`). The re-export keeps it exported from `server-utils` for compat.

---

## Task 1 — Create the shared redaction module + its test (no consumers yet)

This task adds the new shared source + its **exhaustive** unit test (every key-name fragment, one value per all 9 value patterns under innocuous keys, plus negative/edge/passthrough cases) and proves the shared suite is green before any consumer is rewired. There is no Playwright e2e for this module — redaction is pure data/functions, so unit tests are the correct and complete tool (rationale recorded inline in the test step below).

**Files:**
- `packages/shared/src/redaction.ts` (NEW)
- `packages/shared/src/__tests__/redaction.test.ts` (NEW)

Steps:

- [ ] **Write the failing test first.** Create `packages/shared/src/__tests__/redaction.test.ts` importing from the not-yet-existing module (`../redaction.js`). This is the **exhaustive** oracle for the shared module — one concrete case for every distinct redaction scenario: each key-name fragment, each of the 9 value patterns under an *innocuous* key (the H4 value-shape path), and the negative/edge passthrough cases. It must fail at first because the module does not exist. Note: the value-shape cases deliberately use key names that do **not** match `SENSITIVE_ENV_KEY` (verified: `DATABASE_URL`, `CACHE`, `STORE`, `BILLING`, `PROVIDER`, `CLOUD`, `AWS_ID`, `SLACK`, `VENDOR`, `JWT`, `PEM_BLOB`, `STRIPE_LIVE`, `DEPLOY_PAT` all return `false` for the key regex) so each case truly exercises the value pattern, not the key shortcut:

  ```ts
  import { describe, it, expect } from "vitest";
  import {
    SENSITIVE_ENV_KEY,
    SENSITIVE_ENV_VALUE_PATTERNS,
    looksLikeSecretValue,
    shouldRedactSecretValue,
    redactEnvForLogs,
  } from "../redaction.js";

  // ---------------------------------------------------------------------------
  // Fixtures shared across the suites below.
  // ---------------------------------------------------------------------------

  // Key-name fragments that MUST trigger redaction regardless of value.
  // One entry per fragment in the SENSITIVE_ENV_KEY alternation, plus case mix.
  const SENSITIVE_KEY_CASES: Array<[string, string]> = [
    ["OPENAI_API_KEY", "key"],
    ["MY_TOKEN", "token"],
    ["MY_SECRET", "secret"],
    ["DB_PASSWORD", "password"],
    ["DB_PASSWD", "passwd"],
    ["AUTH_HEADER", "auth"],
    ["SESSION_COOKIE", "cookie"],
    ["X_CREDENTIAL", "credential"],
    ["API_BEARER", "bearer"],
    ["WEBHOOK_SIGNING", "signing"],
    ["FOO_WEBHOOK", "webhook"],
    ["NPM_CONFIG", "npm"],
    ["GH_PRIVATE", "private"],
    ["DB_CONNECTION", "connection"],
    // Case-insensitivity (regex is /…/i): lower-case fragment still matches.
    ["service_token", "token (lower-case)"],
  ];

  // One secret-looking VALUE per value pattern, each under an INNOCUOUS key
  // (key regex returns false) so the VALUE path — not the key path — is what
  // forces redaction. The pattern index each case targets is noted.
  const SECRET_VALUE_CASES: Array<[string, string, string]> = [
    // [innocuousKey, value, pattern]
    ["DATABASE_URL", "postgresql://user:s3cr3t@db.internal:5432/app", "p0 connection string (postgres)"],
    ["STORE", "mongodb+srv://u:p@cluster0.abc.mongodb.net/db", "p0 connection string (mongodb+srv)"],
    ["CACHE", "redis://:hunter2@cache:6379/0", "p0 connection string (redis)"],
    ["PROVIDER", "sk-ant-abcdefghijklmnop", "p1 sk-/sk-ant- provider key"],
    ["BILLING", "sk_live_abcdEFGH12345678", "p2 Stripe sk_live_"],
    ["CHECKOUT", "pk_test_abcdEFGH12345678", "p2 Stripe pk_test_"],
    ["DEPLOY_PAT", "ghp_abcdefghijklmnopqrstuvwxyz0123", "p3 GitHub ghp_"],
    ["VENDOR", "gho_abcdefghijklmnopqrstuvwxyz0123", "p3 GitHub gho_"],
    ["CLOUD", "AKIAIOSFODNN7EXAMPLE", "p4 AWS access key id"],
    ["SLACK", "xoxb-test-token-value", "p5 Slack token"],
    ["MESSENGER", "whsec_3f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c", "p6 generic prefix_<random> (whsec_)"],
    ["REGISTRY", "npm_abcdefghijklmnopqrstuvwxyz0123456789", "p6 generic prefix_<random> (npm_)"],
    [
      "JWT",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwfQ.dGhpc2lzYXNpZ25hdHVyZXZhbA",
      "p7 JWT (three base64url segments)",
    ],
    ["PEM_BLOB", "-----BEGIN RSA PRIVATE KEY-----", "p8 PEM private-key block"],
  ];

  // Plain, non-secret values under innocuous keys → must NEVER be redacted.
  const BENIGN_CASES: Array<[string, string]> = [
    ["AOA_API_URL", "http://localhost:3100"], // http (not a DSN scheme) → passthrough
    ["NODE_ENV", "production"],
    ["LOG_LEVEL", "info"],
    ["PORT", "8080"],
    ["REGION", "us-east-1"],
    ["NODE_VERSION", "v24.14.0"],
    ["AOA_AGENT_ID", "ff55fc57-b5e2-4b15-90fd-2fc97605e5d5"], // UUID is not JWT-shaped
  ];

  describe("SENSITIVE_ENV_KEY", () => {
    it.each(SENSITIVE_KEY_CASES)("matches %s (fragment: %s)", (key) => {
      expect(SENSITIVE_ENV_KEY.test(key)).toBe(true);
    });
    it.each(BENIGN_CASES.map(([k]) => [k]))("does not match benign key %s", (key) => {
      expect(SENSITIVE_ENV_KEY.test(key)).toBe(false);
    });
    it("does not match the innocuous keys used by the value-shape cases", () => {
      // Guards the H4 contract: each value-shape case must exercise the VALUE
      // path, so its key must NOT short-circuit via the key regex.
      for (const [key] of SECRET_VALUE_CASES) {
        expect(SENSITIVE_ENV_KEY.test(key)).toBe(false);
      }
    });
  });

  describe("SENSITIVE_ENV_VALUE_PATTERNS", () => {
    it("has exactly nine patterns", () => {
      expect(SENSITIVE_ENV_VALUE_PATTERNS).toHaveLength(9);
    });
    it("each entry is a RegExp", () => {
      for (const re of SENSITIVE_ENV_VALUE_PATTERNS) {
        expect(re).toBeInstanceOf(RegExp);
      }
    });
  });

  describe("looksLikeSecretValue", () => {
    it.each(SECRET_VALUE_CASES)("flags the %s value (%s)", (_key, value) => {
      expect(looksLikeSecretValue(value)).toBe(true);
    });
    it.each(BENIGN_CASES)("ignores the benign value of %s (%s)", (_key, value) => {
      expect(looksLikeSecretValue(value)).toBe(false);
    });
  });

  describe("shouldRedactSecretValue", () => {
    // Key-name path: true regardless of the (string) value.
    it.each(SENSITIVE_KEY_CASES)("redacts by sensitive key %s (fragment: %s)", (key) => {
      expect(shouldRedactSecretValue(key, "x")).toBe(true);
    });
    // Value-shape path: innocuous key, secret-looking string value → true.
    it.each(SECRET_VALUE_CASES)("redacts by value shape under innocuous key %s (%s)", (key, value) => {
      expect(shouldRedactSecretValue(key, value)).toBe(true);
    });
    // Negative: innocuous key + plain value → false.
    it.each(BENIGN_CASES)("does not redact benign %s=%s", (key, value) => {
      expect(shouldRedactSecretValue(key, value)).toBe(false);
    });
    // Non-string values under a benign key are not redacted here (callers
    // handle secret_ref objects upstream); a sensitive key still wins.
    it("ignores non-string values when the key is benign", () => {
      expect(shouldRedactSecretValue("PORT", 8080)).toBe(false);
      expect(shouldRedactSecretValue("PORT", true)).toBe(false);
      expect(shouldRedactSecretValue("PORT", null)).toBe(false);
      expect(shouldRedactSecretValue("PORT", undefined)).toBe(false);
      expect(shouldRedactSecretValue("PORT", { type: "secret_ref" })).toBe(false);
    });
    it("redacts a sensitive key even when the value is a non-string", () => {
      expect(shouldRedactSecretValue("API_KEY", 8080)).toBe(true);
      expect(shouldRedactSecretValue("API_KEY", { type: "secret_ref" })).toBe(true);
    });
  });

  describe("redactEnvForLogs", () => {
    it("redacts every sensitive-key entry to ***REDACTED***", () => {
      const env = Object.fromEntries(SENSITIVE_KEY_CASES.map(([k]) => [k, "irrelevant-value"]));
      const out = redactEnvForLogs(env);
      for (const [k] of SENSITIVE_KEY_CASES) {
        expect(out[k]).toBe("***REDACTED***");
      }
    });
    it("redacts every secret-looking VALUE under an innocuous key", () => {
      const env = Object.fromEntries(SECRET_VALUE_CASES.map(([k, v]) => [k, v]));
      const out = redactEnvForLogs(env);
      for (const [k] of SECRET_VALUE_CASES) {
        expect(out[k]).toBe("***REDACTED***");
      }
    });
    it("preserves benign values byte-for-byte (incl. the http:// API URL)", () => {
      const env = Object.fromEntries(BENIGN_CASES.map(([k, v]) => [k, v]));
      const out = redactEnvForLogs(env);
      for (const [k, v] of BENIGN_CASES) {
        expect(out[k]).toBe(v);
      }
    });
    it("handles an empty env object", () => {
      expect(redactEnvForLogs({})).toEqual({});
    });
    it("redacts a mixed env in a single pass, leaving benign keys untouched", () => {
      const out = redactEnvForLogs({
        OPENAI_API_KEY: "sk-whatever", // sensitive key
        DATABASE_URL: "postgresql://user:s3cr3t@db.internal:5432/app", // sensitive value
        NODE_ENV: "production", // benign
        AOA_API_URL: "http://localhost:3100", // benign
      });
      expect(out.OPENAI_API_KEY).toBe("***REDACTED***");
      expect(out.DATABASE_URL).toBe("***REDACTED***");
      expect(out.NODE_ENV).toBe("production");
      expect(out.AOA_API_URL).toBe("http://localhost:3100");
    });
  });
  ```

  > **Byte-identical to the oracles.** Every expectation above is intentionally identical to the two pre-existing oracle suites for the moved behavior — confirmed by hand against `packages/adapter-utils/src/__tests__/redact-env-for-logs.test.ts` and `ui/src/lib/__tests__/env-redaction.test.ts`:
  > - `redactEnvForLogs` cases reuse the exact key/value pairs from the adapter-utils oracle (`OPENAI_API_KEY`/`MY_SECRET`/`AUTH_TOKEN`, `DATABASE_URL`/`REDIS_DSN`/`STRIPE_LIVE`/`PROVIDER`/`DEPLOY_PAT`/`SIGNING`, `WEBHOOK_SIGNING`/`NPM_AUTH`/`AWS_ID`/`SLACK`, and the `NODE_ENV`/`AOA_API_URL`/`LOG_LEVEL`/`PORT` passthroughs) → same `***REDACTED***` / passthrough outcomes.
  > - `shouldRedactSecretValue` cases reuse the UI oracle's keys/values (`OPENAI_API_KEY`/`PASSWORD`/`WEBHOOK_SIGNING`/`NPM_TOKEN`/`DB_CONNECTION`, the `DATABASE_URL`/`CACHE`/`BILLING`/`GH`/`CLOUD`/`JWT` value-shape set, the `AOA_API_URL`/`AOA_AGENT_ID`/`NODE_VERSION` benign set) → same booleans, including `PORT`→`false`.
  > - **No e2e for this module — and why.** Redaction is pure data + pure functions over plain values; unit tests are the correct and complete tool and the cases above are exhaustive (every key fragment, every value pattern, every negative/edge). An e2e of the Run-detail env display would require seeding a heartbeat run with secret-bearing env just to re-prove the same function output through the UI — out of scope for this consolidation and strictly lower-value than the exhaustive unit coverage here. The existing two oracle suites must continue to pass **unchanged**.

- [ ] **Run the new test — expect FAIL** (module not found):
  `pnpm --filter @armyofagents/shared exec vitest run src/__tests__/redaction.test.ts`
  Expected: failure (`Cannot find module '../redaction.js'` / unresolved import).

- [ ] **Implement the shared module.** Create `packages/shared/src/redaction.ts` with the patterns copied **verbatim** from `packages/adapter-utils/src/server-utils.ts` (key regex line 97-98, value patterns 109-130, `looksLikeSecretValue` 132-134, `redactEnvForLogs` 198-207) plus `shouldRedactSecretValue` copied verbatim from `ui/src/lib/env-redaction.ts` lines 33-37. No Node imports. Exact content:

  ```ts
  // Browser-safe single source of truth for env secret redaction patterns +
  // helpers. Both the Node-only server adapter-utils package
  // (packages/adapter-utils/src/server-utils.ts) and the browser UI
  // (ui/src/lib/env-redaction.ts) import these — keeping the key regex and the
  // value patterns from drifting apart. Pure data + pure functions, no Node deps.
  //
  // H4 (Codex P1): widened beyond the original key|token|secret|… set to also
  // catch common secret-bearing env-name fragments whose VALUES are
  // provider-specific opaque strings the value patterns below can't all enumerate
  // — e.g. WEBHOOK_SIGNING (whsec_…), NPM_AUTH (npm tokens), *_CREDENTIAL, *_DSN,
  // *_CONNECTION, *_BEARER, *_PAT. Over-redacting a log value is safe.
  export const SENSITIVE_ENV_KEY =
    /(key|token|secret|password|passwd|auth|cookie|credential|bearer|signing|webhook|npm|private|connection)/i;

  // H4: key-name matching alone leaked secrets bound (via secret_ref) to env vars
  // whose NAME does not contain one of the words above — DATABASE_URL, STRIPE_LIVE,
  // NPM_AUTH, DSN, WEBHOOK_SIGNING, CONNECTION, PAT, … — in plaintext into the
  // persisted heartbeat_run_events row and the SSE broadcast. So ALSO redact a
  // value (regardless of key name) when it LOOKS like a secret. Over-redacting a
  // log value is safe; leaking one is not. (These mirror the
  // connection-string/provider-key/JWT/PEM rules in
  // server/src/services/prompt-snapshot.ts.)
  export const SENSITIVE_ENV_VALUE_PATTERNS: RegExp[] = [
    // Connection strings / DSNs (postgres://user:pass@host, mongodb+srv://, redis://, …)
    /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqp|kafka|nats|mssql|sqlserver):\/\/[^\s<>'")]+/i,
    // Anthropic / OpenAI-style provider keys (sk-… / sk-ant-…)
    /\bsk-(?:ant-)?[A-Za-z0-9_-]{12,}\b/,
    // Stripe-style keys (sk_live_…, pk_test_…, rk_live_…)
    /\b[sprSPR]k_(?:live|test)_[A-Za-z0-9]{8,}\b/,
    // GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_)
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
    // AWS access key id
    /\bAKIA[0-9A-Z]{16}\b/,
    // Slack tokens (xoxb-, xoxp-, xoxa-, xoxr-, xoxs-)
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
    // H4 (Codex P1): generic "<prefix>_<long-random>" token shape — catches
    // Stripe webhook signing (whsec_…), npm tokens (npm_…), and most vendor
    // "prefix_<base62>" keys regardless of the prefix.
    /\b[A-Za-z][A-Za-z0-9]{1,}_[A-Za-z0-9]{20,}\b/,
    // JWTs (three base64url segments)
    /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
    // PEM private-key blocks
    /-----BEGIN[A-Z ]*PRIVATE KEY-----/,
  ];

  export function looksLikeSecretValue(value: string): boolean {
    return SENSITIVE_ENV_VALUE_PATTERNS.some((re) => re.test(value));
  }

  /**
   * True when an env entry should be redacted: its KEY name looks sensitive,
   * or (for string values) its VALUE looks like a secret. Non-string values
   * with a benign key are not redacted here (callers handle secret_ref objects
   * upstream).
   */
  export function shouldRedactSecretValue(key: string, value: unknown): boolean {
    if (SENSITIVE_ENV_KEY.test(key)) return true;
    if (typeof value !== "string") return false;
    return SENSITIVE_ENV_VALUE_PATTERNS.some((re) => re.test(value));
  }

  export function redactEnvForLogs(env: Record<string, string>): Record<string, string> {
    const redacted: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      redacted[key] =
        SENSITIVE_ENV_KEY.test(key) || (typeof value === "string" && looksLikeSecretValue(value))
          ? "***REDACTED***"
          : value;
    }
    return redacted;
  }
  ```

  > Note: the verbatim source uses `RegExp[]` typed array literal exactly as above. `redactEnvForLogs` here is identical to `server-utils.ts:198-207`; `shouldRedactSecretValue` is identical to `env-redaction.ts:33-37`. Do not "improve" or reorder the patterns — the existing test suites are the behavior oracle and any change to the regex set or order would break them.

- [ ] **Run the new test — expect PASS:**
  `pnpm --filter @armyofagents/shared exec vitest run src/__tests__/redaction.test.ts`
  Expected: all assertions pass (including `SENSITIVE_ENV_VALUE_PATTERNS` length === 9).

- [ ] **Run the full shared suite + typecheck — expect PASS:**
  `pnpm --filter @armyofagents/shared test` (runs `vitest run`)
  `pnpm --filter @armyofagents/shared typecheck`
  Expected: all shared tests green; `tsc --noEmit` clean.

- [ ] **Commit:**
  ```
  git add packages/shared/src/redaction.ts packages/shared/src/__tests__/redaction.test.ts
  git commit -m "feat(shared): add browser-safe env-redaction module

Single source of truth for the env secret key regex + 9 value patterns +
helpers (looksLikeSecretValue, shouldRedactSecretValue, redactEnvForLogs),
copied verbatim from adapter-utils server-utils + ui env-redaction. No Node
deps; consumers rewired in follow-up commits. Zero behavior change.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

---

## Task 2 — Re-export redaction from the shared barrel

The barrel re-export is what makes `from "@armyofagents/shared"` resolve the new members (the `./*` subpath is unproven for these consumers).

**Files:**
- `packages/shared/src/index.ts` (EDIT)

Steps:

- [ ] **Add the re-export to the barrel.** In `packages/shared/src/index.ts`, after the existing `export { ... } from "./project-mentions.js";` block (ends at line 1094) — i.e. alongside the other small named re-export blocks — add:

  ```ts
  export {
    SENSITIVE_ENV_KEY,
    SENSITIVE_ENV_VALUE_PATTERNS,
    looksLikeSecretValue,
    shouldRedactSecretValue,
    redactEnvForLogs,
  } from "./redaction.js";
  ```

- [ ] **Add a barrel-resolution assertion to the shared test.** Append to `packages/shared/src/__tests__/redaction.test.ts` a block that imports from the package barrel to prove the re-export resolves (this is the contract the UI relies on):

  ```ts
  import * as sharedBarrel from "../index.js";

  describe("shared barrel re-export", () => {
    it("exposes the redaction members from the package root", () => {
      expect(typeof sharedBarrel.redactEnvForLogs).toBe("function");
      expect(typeof sharedBarrel.looksLikeSecretValue).toBe("function");
      expect(typeof sharedBarrel.shouldRedactSecretValue).toBe("function");
      expect(sharedBarrel.SENSITIVE_ENV_KEY).toBeInstanceOf(RegExp);
      expect(Array.isArray(sharedBarrel.SENSITIVE_ENV_VALUE_PATTERNS)).toBe(true);
    });
  });
  ```

- [ ] **Run the shared suite + typecheck — expect PASS:**
  `pnpm --filter @armyofagents/shared test`
  `pnpm --filter @armyofagents/shared typecheck`
  Expected: green, including the new barrel-resolution block.

- [ ] **Commit:**
  ```
  git add packages/shared/src/index.ts packages/shared/src/__tests__/redaction.test.ts
  git commit -m "feat(shared): re-export redaction module from the package barrel

UI consumers import shared via the root barrel, so the env-redaction members
must be re-exported from index.ts. Adds a barrel-resolution assertion.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

---

## Task 3 — Point adapter-utils at the shared module (delete inline copies, re-export)

The existing `redact-env-for-logs.test.ts` is the **behavior oracle** here — it imports `redactEnvForLogs` from `../server-utils.js` and must keep passing unchanged after the move.

**Files:**
- `packages/adapter-utils/package.json` (EDIT — add dependency)
- `packages/adapter-utils/src/server-utils.ts` (EDIT — delete inline, re-export)
- `packages/adapter-utils/src/__tests__/redact-env-for-logs.test.ts` (UNCHANGED — oracle)

Steps:

- [ ] **Run the oracle FIRST to capture the green baseline** (before any change):
  `pnpm --filter @armyofagents/adapter-utils test:run`
  Expected: PASS (4 tests in `redact-env-for-logs.test.ts`). This is the behavior we must preserve.

- [ ] **Add the workspace dependency.** In `packages/adapter-utils/package.json`, add a `dependencies` block (the file currently has none) before `devDependencies`:

  ```json
    "dependencies": {
      "@armyofagents/shared": "workspace:*"
    },
  ```

  Resulting top of the file (for clarity) — `files`/`scripts` unchanged, then:

  ```json
    "dependencies": {
      "@armyofagents/shared": "workspace:*"
    },
    "devDependencies": {
      "@types/node": "^24.6.0",
      "typescript": "^5.7.3"
    }
  ```

- [ ] **Install so the workspace symlink + lockfile update:**
  `pnpm install`
  Expected: lockfile updated, `@armyofagents/shared` linked into adapter-utils. (Run from repo root.)

- [ ] **Delete the inline constants/functions and re-export from shared.** In `packages/adapter-utils/src/server-utils.ts`:
  - Delete the `SENSITIVE_ENV_KEY` const block (lines 92-98 incl. its leading comment), the `SENSITIVE_ENV_VALUE_PATTERNS` block (lines 100-130 incl. its leading comment), the `looksLikeSecretValue` function (lines 132-134), and the `redactEnvForLogs` function (lines 198-207).
  - Add a top-of-file re-export so the symbol stays exported from `server-utils` (keeps every `@armyofagents/adapter-utils/server-utils` importer valid) and stays usable internally (`buildInvocationEnvForLogs` at line 903 calls `redactEnvForLogs`). Add this import+re-export near the top, after the existing `import type { AdapterSkillEntry, AdapterSkillSnapshot } from "./types.js";` (line 5):

    ```ts
    // Env secret redaction lives in the browser-safe shared package so the UI
    // (ui/src/lib/env-redaction.ts) and the adapters share ONE source of truth
    // for the key regex + value patterns. Re-exported here so existing
    // `@armyofagents/adapter-utils/server-utils` importers (every adapter
    // execute.ts + server/src/adapters/utils.ts) keep working unchanged.
    import { redactEnvForLogs, looksLikeSecretValue } from "@armyofagents/shared";
    export { redactEnvForLogs, looksLikeSecretValue };
    ```

  > After this edit: the comments at old lines 92-96 and 100-108 (which explained why the patterns were inlined in adapter-utils) are removed along with the code — their rationale now lives in `packages/shared/src/redaction.ts`. `buildInvocationEnvForLogs` (line ~903 → shifts up) still references `redactEnvForLogs`; it now resolves to the imported binding. No call sites change.

- [ ] **Run the adapter-utils oracle — expect UNCHANGED PASS:**
  `pnpm --filter @armyofagents/adapter-utils test:run`
  Expected: the same 4 `redact-env-for-logs.test.ts` tests pass, proving the move is behavior-preserving.

- [ ] **Typecheck adapter-utils — expect PASS:**
  `pnpm --filter @armyofagents/adapter-utils typecheck`
  Expected: `tsc --noEmit` clean (the re-export resolves `@armyofagents/shared`).

- [ ] **Commit:**
  ```
  git add packages/adapter-utils/package.json packages/adapter-utils/src/server-utils.ts pnpm-lock.yaml
  git commit -m "refactor(adapter-utils): source env redaction from @armyofagents/shared

Delete the inline SENSITIVE_ENV_KEY / SENSITIVE_ENV_VALUE_PATTERNS /
looksLikeSecretValue / redactEnvForLogs copies; re-export them from the shared
module. Adds @armyofagents/shared to dependencies. Existing
redact-env-for-logs.test.ts (the behavior oracle) passes unchanged. Zero
behavior change.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

---

## Task 4 — Point the UI env-redaction file at the shared module (keep wrappers)

The existing `ui/src/lib/__tests__/env-redaction.test.ts` is the UI behavior oracle — it imports `shouldRedactSecretValue`, `redactEnvValue`, `formatEnvForDisplay` from `../env-redaction` and must keep passing unchanged. `ui` already depends on `@armyofagents/shared` (`ui/package.json:27`), so no package.json change.

**Files:**
- `ui/src/lib/env-redaction.ts` (EDIT — delete inline copies, import from shared, keep wrappers)
- `ui/src/lib/__tests__/env-redaction.test.ts` (UNCHANGED — oracle)

Steps:

- [ ] **Run the UI oracle FIRST for a green baseline** (before any change):
  `pnpm --filter @armyofagents/ui exec vitest run src/lib/__tests__/env-redaction.test.ts`
  Expected: PASS (3 describe blocks: `shouldRedactSecretValue`, `redactEnvValue`, `formatEnvForDisplay`).

- [ ] **Rewrite `ui/src/lib/env-redaction.ts`** to import the patterns + `shouldRedactSecretValue` from shared and keep `REDACTED_ENV_VALUE`, `redactEnvValue`, `formatEnvForDisplay` as thin wrappers. Replace the whole file with:

  ```ts
  import { shouldRedactSecretValue } from "@armyofagents/shared";
  import { asRecord } from "./run-metrics";

  export const REDACTED_ENV_VALUE = "***REDACTED***";

  // Env secret key/value patterns + shouldRedactSecretValue now live in the
  // browser-safe shared package (packages/shared/src/redaction.ts) — single
  // source of truth shared with the server adapters. The UI keeps the
  // secret_ref-aware redactEnvValue + the display formatter as thin wrappers.
  export { shouldRedactSecretValue };

  export function redactEnvValue(key: string, value: unknown): string {
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      (value as { type?: unknown }).type === "secret_ref"
    ) {
      return "***SECRET_REF***";
    }
    if (shouldRedactSecretValue(key, value)) return REDACTED_ENV_VALUE;
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  export function formatEnvForDisplay(envValue: unknown): string {
    const env = asRecord(envValue);
    if (!env) return "<unable-to-parse>";

    const keys = Object.keys(env);
    if (keys.length === 0) return "<empty>";

    return keys
      .sort()
      .map((key) => `${key}=${redactEnvValue(key, env[key])}`)
      .join("\n");
  }
  ```

  > This deletes the byte-identical inline `SECRET_ENV_KEY_RE` + `SECRET_ENV_VALUE_PATTERNS` + the inline `shouldRedactSecretValue` body (old lines 5-37) and replaces them with a re-export of the shared `shouldRedactSecretValue`. `redactEnvValue` + `formatEnvForDisplay` bodies are unchanged from old lines 39-69. The test file imports `shouldRedactSecretValue` from `../env-redaction`, which the `export { shouldRedactSecretValue }` re-export keeps valid.

- [ ] **Run the UI oracle — expect UNCHANGED PASS:**
  `pnpm --filter @armyofagents/ui exec vitest run src/lib/__tests__/env-redaction.test.ts`
  Expected: all 3 blocks pass, proving the UI move is behavior-preserving. (Note: `shouldRedactSecretValue("PORT", { type: "secret_ref" })` is not asserted in the oracle; the shared version returns `false` for non-string values with a benign key, matching the old UI behavior — `redactEnvValue` handles `secret_ref` before calling `shouldRedactSecretValue`, so display behavior is unchanged.)

- [ ] **Run the full UI suite + typecheck — expect PASS** (catches any other importer of these symbols):
  `pnpm --filter @armyofagents/ui test:run`
  `pnpm --filter @armyofagents/ui typecheck`
  Expected: full UI vitest suite green; `tsc -b` clean.

- [ ] **Commit:**
  ```
  git add ui/src/lib/env-redaction.ts
  git commit -m "refactor(ui): source env redaction patterns from @armyofagents/shared

Delete the byte-identical inline key regex + value patterns + shouldRedactSecretValue
body; import shouldRedactSecretValue from the shared module and re-export it. Keep
the secret_ref-aware redactEnvValue + formatEnvForDisplay wrappers. Existing
env-redaction.test.ts (the UI behavior oracle) passes unchanged. Zero behavior change.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

---

## Task 5 — Workspace build, cross-package verification, open PR

adapter-utils gaining a `shared` dependency changes the build topo order; a full `pnpm build` confirms `shared` builds before `adapter-utils` (and before the adapter packages + ui that depend on adapter-utils).

**Files:** none (verification + PR only).

Steps:

- [ ] **Full workspace build — expect PASS:**
  `pnpm build` (`pnpm -r build`; `prebuild` runs `pnpm fetch-catalog` first)
  Expected: every package builds; `shared` builds before `adapter-utils` (topo order honored); no unresolved `@armyofagents/shared` import errors.

- [ ] **Full workspace typecheck — expect PASS:**
  `pnpm typecheck` (`pnpm -r typecheck`)
  Expected: clean across all packages.

- [ ] **Re-run all three affected test suites together — expect PASS:**
  `pnpm --filter @armyofagents/shared test:run`
  `pnpm --filter @armyofagents/adapter-utils test:run`
  `pnpm --filter @armyofagents/ui test:run`
  Expected: all green; the two behavior-oracle files (`redact-env-for-logs.test.ts`, `env-redaction.test.ts`) unchanged and passing.

- [ ] **Run the server suite that mocks redaction — expect PASS** (sanity that the re-export shim still works):
  `pnpm --filter @armyofagents/server exec vitest run src/__tests__/aoa-heartbeat-kind-guard.test.ts`
  Expected: PASS (this test mocks `redactEnvForLogs`; it must remain unaffected by the move).

- [ ] **Forbidden-token check — expect PASS** (repo policy gate):
  `pnpm check:tokens`
  Expected: clean (no OSS headers / forbidden tokens introduced).

- [ ] **Open the PR off `main`:**
  ```
  git push -u origin fix/followup-2-shared-redaction
  gh pr create --base main --title "refactor: shared env-redaction module (follow-up #2)" --body "<see below>"
  ```
  PR body (ends with the required generated-with trailer):
  - What: extract the byte-identical env-redaction key regex + 9 value patterns + helpers into `packages/shared/src/redaction.ts`; server adapter-utils + UI now re-import. Zero behavior change.
  - Why: kill the copy-paste drift between `packages/adapter-utils/src/server-utils.ts` and `ui/src/lib/env-redaction.ts` (PR #230 follow-up #2).
  - Safety: existing behavior-oracle suites pass unchanged; new focused shared test added; full `pnpm build` confirms topo order with adapter-utils → shared.
  - Scope note: broad consolidation of the ~9 *other* (already-diverged) redaction copies is deliberately deferred (see design doc "Deferred work").
  - Trailer: `🤖 Generated with [Claude Code](https://claude.com/claude-code)`

---

## Definition of done

- [ ] `packages/shared/src/redaction.ts` exists with the verbatim key regex (1), value patterns (9), `looksLikeSecretValue`, `shouldRedactSecretValue`, `redactEnvForLogs`; re-exported from `packages/shared/src/index.ts`.
- [ ] `packages/adapter-utils/src/server-utils.ts` has no inline redaction constants/functions; it imports + re-exports `redactEnvForLogs` and `looksLikeSecretValue` from `@armyofagents/shared`; `@armyofagents/shared` is in adapter-utils `dependencies`.
- [ ] `ui/src/lib/env-redaction.ts` imports `shouldRedactSecretValue` from `@armyofagents/shared` (re-exporting it) and keeps `redactEnvValue` + `formatEnvForDisplay` wrappers; no inline patterns.
- [ ] **Behavior oracles pass unchanged:** `packages/adapter-utils/src/__tests__/redact-env-for-logs.test.ts` and `ui/src/lib/__tests__/env-redaction.test.ts` are NOT edited and stay green.
- [ ] New `packages/shared/src/__tests__/redaction.test.ts` passes with **exhaustive coverage**: a concrete case for every `SENSITIVE_ENV_KEY` fragment (key-name path), one secret-looking value for **each of the 9** `SENSITIVE_ENV_VALUE_PATTERNS` under an *innocuous* key (the H4 value-shape path), negative/passthrough cases (plain values, empty env, non-string/null/undefined handling), the 9-pattern length assertion, and the barrel-resolution block (Task 2).
- [ ] **Byte-identical to the oracles:** every shared-test expectation for the moved functions (`redactEnvForLogs`, `shouldRedactSecretValue`, `looksLikeSecretValue`) matches the outcome asserted in the two pre-existing oracle suites for the same inputs (no behavior drift).
- [ ] **No e2e is expected or required** for this module — redaction is pure data/functions; unit tests are the correct and complete tool (rationale recorded in Task 1). The UI-only wrappers (`redactEnvValue` `secret_ref` → `***SECRET_REF***`, `formatEnvForDisplay` sort+join) stay covered by the unchanged UI oracle.
- [ ] `pnpm --filter @armyofagents/shared test:run`, `pnpm --filter @armyofagents/adapter-utils test:run`, `pnpm --filter @armyofagents/ui test:run`, and `pnpm --filter @armyofagents/server exec vitest run src/__tests__/aoa-heartbeat-kind-guard.test.ts` are all green.
- [ ] `pnpm build` and `pnpm typecheck` are clean across the workspace; `pnpm check:tokens` clean.
- [ ] PR opened off `main`; commits carry the `Co-Authored-By` trailer.

---

## Self-review

- **Zero behavior change is enforced by the two pre-existing oracle suites** (`redact-env-for-logs.test.ts`, `env-redaction.test.ts`), which are deliberately left untouched and re-run after each move. The new shared test is additive, not a replacement.
- **The new shared test is exhaustive, not a smoke test.** It carries a concrete case for every `SENSITIVE_ENV_KEY` fragment, one secret-looking value for each of the 9 value patterns under an *innocuous* key (so the value-shape path is exercised, not the key shortcut — verified by hand: every value-shape key returns `false` for the key regex), and the negative/edge set (plain values, empty env, non-string/null/undefined). A dedicated assertion locks the contract that the value-shape keys do not match the key regex.
- **Byte-identical to the oracles:** the shared-test inputs and expected outputs for `redactEnvForLogs` / `shouldRedactSecretValue` / `looksLikeSecretValue` are the same input→output pairs already asserted in the two oracle suites (cross-checked against `redact-env-for-logs.test.ts` and `env-redaction.test.ts`), so the shared module is proven to reproduce the exact existing behavior — not a re-interpretation.
- **No Playwright e2e for this follow-up — by design.** Redaction is pure data + pure functions over plain values; unit tests are the correct and complete verification tool and the cases above are exhaustive across all patterns. An e2e of the Run-detail env display would require seeding a heartbeat run with secret-bearing env to re-prove the same function output through the DOM — out of scope and strictly lower-value than the unit coverage. The UI-only wrappers (`redactEnvValue`'s `secret_ref` → `***SECRET_REF***` and `formatEnvForDisplay`'s sort+`key=value` join) remain covered by the unchanged UI oracle.
- **No dependency cycle:** `packages/shared/src/index.ts` imports nothing from adapter-utils (verified by reading the full barrel), so adapter-utils → shared is a clean DAG edge; `pnpm build` (Task 5) proves topo order.
- **Every `redactEnvForLogs` import path stays valid:** all importers use `@armyofagents/adapter-utils/server-utils` (or the `server/src/adapters/utils.ts` shim that re-exports from it), and the re-export keeps the symbol exported from `server-utils`. The one server test that references `redactEnvForLogs` only *mocks* it, so it is unaffected; it is re-run in Task 5 as a sanity check.
- **UI resolves via the root barrel**, matching all ~40 existing shared imports — the re-export is from `index.ts`, with a barrel-resolution assertion in the new test.
- **Possible double-check during execution:** (1) exact line numbers in `server-utils.ts` will shift as blocks are deleted — locate the blocks by their distinctive comments/identifiers rather than trusting absolute line numbers; (2) confirm `pnpm install` after the adapter-utils package.json edit actually creates the workspace symlink (some pnpm setups need it before `tsc` resolves `@armyofagents/shared`); (3) if `ui` typecheck (`tsc -b`) requires `@armyofagents/shared` to be *built* (not just source), the full `pnpm build` in Task 5 covers it — but if a mid-stream UI typecheck fails on an unbuilt shared dist, run `pnpm --filter @armyofagents/shared build` first.
