# Sprint 5 — Security Audit Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use **superpowers:subagent-driven-development** to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close 6 verified findings from the Sprint 4 audit across three small focused PRs — transcribe path removal, cloud-readiness (body caps + trust-proxy knob), and cross-tenant + audit hardening.

**Architecture:** Each PR has its own worktree off `origin/main`. No file overlap between PRs, so they merge in any order. All tests use the existing vitest + `createSequenceDb` mock pattern (per CLAUDE.md "V2 Test Patterns"). All commits include the standard `Co-Authored-By: Claude Opus 4.7 (1M context)` footer.

**Tech Stack:** Express 5.x, Drizzle ORM, Zod validators, Vitest, better-auth, helmet (post #157), express-rate-limit (post #156), `assertCompanyAccess` / `assertBoard` / `getActorInfo` from `server/src/routes/authz.ts`.

---

## File Structure

### PR S5-A worktree files
- Modify: `server/src/routes/transcription.ts`
- Delete: `server/src/services/transcription.ts`
- Delete: `server/src/__tests__/transcription.test.ts`
- Modify: `ui/src/components/DiscussionCaptureModal.tsx`
- Modify: `ui/src/__tests__/DiscussionCaptureModal.test.tsx`
- Modify: `ui/src/__tests__/DiscussionDetail.test.tsx`
- Create: `server/src/__tests__/routes-transcription.test.ts`
- Create: `.changeset/security-transcription-deprecate-openai-path.md`

### PR S5-B worktree files
- Modify: `server/src/config.ts`
- Modify: `server/src/app.ts`
- Modify: `server/src/index.ts`
- Modify: `server/src/middleware/rate-limit.ts`
- Modify: `packages/shared/src/validators/company-portability.ts`
- Modify: `docs/deploy/environment-variables.md`
- Modify: `server/src/__tests__/rate-limit.test.ts`
- Modify: `server/src/__tests__/company-portability-preview-export.test.ts`
- Create: `.changeset/security-cloud-readiness-body-caps-trust-proxy.md`

### PR S5-C worktree files
- Modify: `server/src/routes/feedback.ts`
- Modify: `server/src/auth/better-auth.ts`
- Modify: `server/src/routes/agents.ts`
- Modify: `server/src/__tests__/routes-feedback.test.ts`
- Modify: `server/src/__tests__/better-auth-config.test.ts`
- Modify: `server/src/__tests__/agents-keys-routes.test.ts`
- Create: `.changeset/security-cross-tenant-audit-hardening.md`

---

## Common Patterns

### Pattern A — Express route test scaffold

```ts
import express from "express";
import request from "supertest";
import { describe, it, expect, vi } from "vitest";

// 1. Mock @armyofagents/db with the established Proxy pattern (see helpers/drizzle-mock.ts)
// 2. Mock services that the route consumes
// 3. Build a tiny app with just the actor middleware + the route under test
// 4. Inject req.actor via a pre-route middleware

function buildApp(actor: ReqActor, mockDb: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).actor = actor; next(); });
  app.use(routesUnderTest(mockDb));
  return app;
}
```

Reference: `server/src/__tests__/routes-feedback.test.ts:1-81` (canonical), `server/src/__tests__/agents-keys-routes.test.ts:1-90` (canonical with `logActivity` mock).

### Pattern B — Changeset

`.changeset/<slug>.md`:

```md
---
"@armyofagents/server": patch
---

<one-paragraph description matching the PR title>
```

### Pattern C — TDD step quintet (per task)

1. Write the failing test
2. Run test to verify it fails (cite expected error)
3. Write minimal implementation
4. Run test to verify it passes
5. Commit (named per task)

---

# PR S5-A — Transcribe path removal

**Worktree:** `.worktrees/sprint-5-a-transcribe`
**Branch:** `fix/security-transcribe-501-stub`

## Task A1: Replace transcribe route with 501 stub

**Files:**
- Modify: `server/src/routes/transcription.ts`
- Test: `server/src/__tests__/routes-transcription.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `server/src/__tests__/routes-transcription.test.ts`:

```ts
import express from "express";
import request from "supertest";
import { describe, it, expect } from "vitest";
import { transcriptionRoutes } from "../routes/transcription.js";

describe("POST /companies/:companyId/transcribe (501 stub)", () => {
  it("returns 501 with a documented body explaining the deprecation", async () => {
    const app = express();
    app.use((req, _res, next) => {
      (req as any).actor = { type: "board", userId: "u1", companyId: "c1" };
      next();
    });
    app.use(transcriptionRoutes({} as any));

    const res = await request(app)
      .post("/companies/c1/transcribe")
      .attach("audio", Buffer.from("fake"), "test.mp3");

    expect(res.status).toBe(501);
    expect(res.body).toMatchObject({
      error: "transcription_not_available",
      message: expect.stringContaining("Internal Agent"),
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run server/src/__tests__/routes-transcription.test.ts`
Expected: FAIL because the route still calls the OpenAI service and either succeeds with 200 (mocked) or errors with 5xx.

- [ ] **Step 3: Replace `server/src/routes/transcription.ts` body**

Full replacement file:

```ts
import { Router } from "express";
import type { Db } from "@armyofagents/db";
import { transcribeLimiter } from "../middleware/rate-limit.js";
import { assertCompanyAccess } from "./authz.js";

/**
 * Transcription is deprecated as a server-side OpenAI path per Decision #91
 * (CLI-only execution; transcription will move to a Commander sub-agent task).
 * The route stays mounted with the rate limiter intact (prevents flooding the
 * 501 itself) and the original method+path so existing UI clients can detect
 * the deprecation and degrade gracefully.
 */
export function transcriptionRoutes(_db: Db) {
  const router = Router();

  router.post(
    "/companies/:companyId/transcribe",
    transcribeLimiter,
    (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      res.status(501).json({
        error: "transcription_not_available",
        message:
          "Voice transcription will be added via the Internal Agent. " +
          "See Decision #91 (CLI-only execution).",
      });
    },
  );

  return router;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run server/src/__tests__/routes-transcription.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/transcription.ts server/src/__tests__/routes-transcription.test.ts
git commit -m "$(cat <<'EOF'
fix(transcribe): replace OpenAI path with 501 stub pending Commander sub-agent

Decision #91 moves AoA to CLI-only execution; transcription will become a
Commander sub-agent task. The route returns 501 with a documented body so
UI clients can degrade gracefully. transcribeLimiter stays in place to
prevent flooding the 501 itself.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Task A2: Delete the orphan service file + its test

**Files:**
- Delete: `server/src/services/transcription.ts`
- Delete: `server/src/__tests__/transcription.test.ts`

- [ ] **Step 1: Confirm no remaining importers**

Run: `grep -rn "from.*services/transcription" server/src/ ui/src/ packages/`
Expected: zero hits (the route no longer imports it).

- [ ] **Step 2: Delete both files**

```bash
rm server/src/services/transcription.ts server/src/__tests__/transcription.test.ts
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm --filter @armyofagents/server typecheck 2>&1 | grep "error TS" | wc -l`
Expected: 65 (matches baseline; no new errors from the deletions).

- [ ] **Step 4: Commit**

```bash
git add -u
git commit -m "$(cat <<'EOF'
chore(transcribe): delete orphan service + unit test after route deprecation

Service was the only consumer of the OpenAI Whisper path. Route now returns
501 directly. Deleting both unblocks future cleanup and removes the silent
process.env.OPENAI_API_KEY fallback entirely.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Task A3: UI 501 handling in DiscussionCaptureModal

**Files:**
- Modify: `ui/src/components/DiscussionCaptureModal.tsx`
- Modify: `ui/src/__tests__/DiscussionCaptureModal.test.tsx`

- [ ] **Step 1: Read the current handler at line 201**

Run: `sed -n '195,215p' ui/src/components/DiscussionCaptureModal.tsx`
Confirm the `transcriptionApi.transcribe(...)` call site and how errors are surfaced today.

- [ ] **Step 2: Write the failing test**

Modify `ui/src/__tests__/DiscussionCaptureModal.test.tsx` — add a new test in the existing describe:

```ts
it("surfaces a graceful 'voice not yet wired' state when transcribe returns 501", async () => {
  vi.mocked(transcriptionApi.transcribe).mockRejectedValueOnce(
    Object.assign(new Error("Not implemented"), {
      status: 501,
      body: { error: "transcription_not_available", message: "..." },
    }),
  );

  render(<DiscussionCaptureModal {...defaultProps} />);
  // ... trigger voice input flow ...
  await waitFor(() => {
    expect(
      screen.getByText(/voice input is not yet available/i),
    ).toBeInTheDocument();
  });
  expect(screen.getByRole("button", { name: /paste|write/i })).toBeEnabled();
});
```

(Adapt the trigger to whatever `defaultProps` and the existing 200-path test use.)

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test:run ui/src/__tests__/DiscussionCaptureModal.test.tsx`
Expected: FAIL — current code probably throws an unhandled error or shows a generic "Transcription failed" message.

- [ ] **Step 4: Update the catch branch in `DiscussionCaptureModal.tsx`**

In the catch block around line 201, add a 501-specific branch that sets an explicit "voice not yet wired" UI state:

```tsx
} catch (err: any) {
  if (err?.status === 501) {
    setVoiceState({
      kind: "unavailable",
      message:
        "Voice input is not yet available in this build. " +
        "Please use Paste or Write for now.",
    });
    return;
  }
  // ... existing error handling
}
```

Render the unavailable state above the existing capture controls:

```tsx
{voiceState.kind === "unavailable" && (
  <Alert>
    <AlertDescription>{voiceState.message}</AlertDescription>
  </Alert>
)}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test:run ui/src/__tests__/DiscussionCaptureModal.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/DiscussionCaptureModal.tsx ui/src/__tests__/DiscussionCaptureModal.test.tsx
git commit -m "$(cat <<'EOF'
feat(ui): handle transcribe 501 with graceful 'voice unavailable' state

Server now returns 501 for /transcribe pending the Commander sub-agent
migration. UI catches the 501 and surfaces an explicit 'voice not yet
wired' Alert with the existing Paste/Write controls intact, so the modal
remains usable.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Task A4: Update DiscussionDetail test mock

**Files:**
- Modify: `ui/src/__tests__/DiscussionDetail.test.tsx:125-127`

- [ ] **Step 1: Read the existing mock**

```bash
sed -n '120,135p' ui/src/__tests__/DiscussionDetail.test.tsx
```

- [ ] **Step 2: Update the mock to a no-op (or 501-rejecting) shape**

If the existing mock returns `{ text: "..." }`, switch to `mockRejectedValue` with a 501 shape — or, if the test asserts the 200 path explicitly, leave the mock and let the new component-level handling pass through unchanged. Re-run the file and verify it still passes.

- [ ] **Step 3: Run all UI tests**

Run: `pnpm --filter @armyofagents/ui test:run`
Expected: all pass; if anything broke from the API change, fix the mock and re-run.

- [ ] **Step 4: Commit**

```bash
git add ui/src/__tests__/DiscussionDetail.test.tsx
git commit -m "$(cat <<'EOF'
test(ui): align DiscussionDetail mocks with deprecated transcribe path

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Task A5: Changeset

- [ ] **Step 1: Create `.changeset/security-transcription-deprecate-openai-path.md`**

```md
---
"@armyofagents/server": patch
"@armyofagents/ui": patch
---

Deprecate the server-side OpenAI Whisper transcription path. POST /companies/:cid/transcribe now returns 501 with a documented body pending the Commander sub-agent migration (Decision #91). Removes the silent `process.env.OPENAI_API_KEY` fallback that could bill the host operator for tenant audio. UI degrades to a "voice input not yet available" state with Paste/Write controls intact.
```

- [ ] **Step 2: Commit**

```bash
git add .changeset/security-transcription-deprecate-openai-path.md
git commit -m "chore: changeset for transcribe path removal

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

## Task A6: Verification + push

- [ ] **Step 1: Run all server tests touched**

Run: `pnpm test:run server/src/__tests__/routes-transcription.test.ts`
Expected: PASS.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @armyofagents/server typecheck 2>&1 | grep "error TS" | wc -l`
Expected: 65 (matches baseline).

- [ ] **Step 3: UI test suite**

Run: `pnpm --filter @armyofagents/ui test:run 2>&1 | tail -10`
Expected: all green.

- [ ] **Step 4: Push + open PR**

```bash
git push -u origin fix/security-transcribe-501-stub
gh pr create --base main --head fix/security-transcribe-501-stub \
  --title "fix(security): replace transcribe OpenAI path with 501 stub (Sprint 5)" \
  --body "<see template>"
```

---

# PR S5-B — Cloud readiness: body caps + trust-proxy knob

**Worktree:** `.worktrees/sprint-5-b-cloud-readiness`
**Branch:** `fix/security-cloud-readiness`

## Task B1: Add `trustProxy` field to Config + parse env var

**Files:**
- Modify: `server/src/config.ts`

- [ ] **Step 1: Write the failing test**

Add to `server/src/__tests__/config.test.ts` (create if missing — mirror existing config tests if any):

```ts
import { describe, it, expect } from "vitest";
import { loadConfig } from "../config.js";

describe("loadConfig — trustProxy", () => {
  it("defaults to false", () => {
    delete process.env.AOA_TRUST_PROXY;
    expect(loadConfig().trustProxy).toBe(false);
  });
  it('parses "true" / "false" / number / CIDR list', () => {
    process.env.AOA_TRUST_PROXY = "true";
    expect(loadConfig().trustProxy).toBe(true);
    process.env.AOA_TRUST_PROXY = "false";
    expect(loadConfig().trustProxy).toBe(false);
    process.env.AOA_TRUST_PROXY = "2";
    expect(loadConfig().trustProxy).toBe(2);
    process.env.AOA_TRUST_PROXY = "10.0.0.0/8,192.168.0.0/16";
    expect(loadConfig().trustProxy).toEqual(["10.0.0.0/8", "192.168.0.0/16"]);
  });
  it("rejects malformed numeric input", () => {
    process.env.AOA_TRUST_PROXY = "not-a-number-cidr";
    expect(() => loadConfig()).toThrow(/AOA_TRUST_PROXY/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run server/src/__tests__/config.test.ts`
Expected: FAIL — `Config.trustProxy` doesn't exist yet.

- [ ] **Step 3: Add the field + parser**

In `server/src/config.ts:33-64` Config interface:

```ts
export interface Config {
  // ... existing fields
  /**
   * Express trust-proxy setting. Set when AoA runs behind a reverse proxy
   * (Cloudflare, ALB, nginx). Without this, `req.ip` reads the proxy's
   * IP and rate limits collapse to one shared bucket.
   * - false (default): trust the socket peer only
   * - true: trust the X-Forwarded-* headers from any source (DANGEROUS without a real proxy)
   * - number N: trust the N-th hop in X-Forwarded-For (recommended for cloud)
   * - string[]: list of CIDRs to trust as proxies
   */
  trustProxy: boolean | number | string[];
}
```

In `loadConfig()` body, add the parser:

```ts
function parseTrustProxy(raw: string | undefined): boolean | number | string[] {
  if (raw === undefined || raw === "") return false;
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^\d+$/.test(raw)) return Number(raw);
  if (raw.includes(",") || raw.includes("/")) {
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  }
  throw new Error(
    `AOA_TRUST_PROXY="${raw}" is not a valid value. ` +
      `Use "true", "false", a hop count (e.g. "1"), or a comma-separated CIDR list.`,
  );
}

// In the return: trustProxy: parseTrustProxy(process.env.AOA_TRUST_PROXY),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run server/src/__tests__/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/config.ts server/src/__tests__/config.test.ts
git commit -m "$(cat <<'EOF'
feat(config): add AOA_TRUST_PROXY env var + Config.trustProxy field

Operators behind a reverse proxy (Cloudflare/ALB/nginx) need to opt in
to trusting X-Forwarded-* headers, otherwise req.ip reads the proxy IP
and IP-keyed rate limits collapse to one bucket. Default is false to
prevent XFF spoofing on direct deployments.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Task B2: Wire `app.set("trust proxy", ...)` in createApp

**Files:**
- Modify: `server/src/app.ts:138`
- Modify: `server/src/index.ts` (or wherever createApp is invoked)
- Modify: `server/src/__tests__/rate-limit.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `server/src/__tests__/rate-limit.test.ts`:

```ts
describe("trust proxy integration with rate limiter", () => {
  it("buckets per spoofed IP when trust proxy is true and XFF set", async () => {
    const app = express();
    app.set("trust proxy", true);
    app.use((req, _res, next) => { (req as any).actor = { type: "none" }; next(); });
    app.post("/test", signinLimiter, (_req, res) => res.json({ ok: true }));

    const ip1Hits = [];
    for (let i = 0; i < 12; i++) {
      const r = await request(app).post("/test").set("X-Forwarded-For", "1.2.3.4");
      ip1Hits.push(r.status);
    }
    expect(ip1Hits.filter((s) => s === 200).length).toBe(10);
    expect(ip1Hits.filter((s) => s === 429).length).toBe(2);

    // Different XFF IP should still have its own bucket
    const r = await request(app).post("/test").set("X-Forwarded-For", "5.6.7.8");
    expect(r.status).toBe(200);
  });

  it("ignores XFF when trust proxy is false (default)", async () => {
    const app = express();
    app.set("trust proxy", false);
    app.use((req, _res, next) => { (req as any).actor = { type: "none" }; next(); });
    app.get("/probe", (req, res) => res.json({ ip: req.ip }));

    const r = await request(app).get("/probe").set("X-Forwarded-For", "1.2.3.4");
    expect(r.body.ip).not.toBe("1.2.3.4");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run server/src/__tests__/rate-limit.test.ts`
Expected: PASS on the second test (already correct), FAIL on the first if `app.set("trust proxy", true)` isn't being respected by the limiter (limiters use the same `req.ip` so this should work — confirm).

Actually — Express `app.set("trust proxy")` is per-app, and the limiter reads `req.ip` which honors it. So the test really validates that the wiring path works end-to-end. If both pass, the test still serves as a regression guard.

- [ ] **Step 3: Modify `server/src/app.ts:130-138` (createApp opts + setting)**

Add to the `opts` type:

```ts
trustProxy: boolean | number | string[];
```

Inside `createApp` body, immediately after `const app = express()`:

```ts
app.set("trust proxy", opts.trustProxy);
```

- [ ] **Step 4: Modify `server/src/index.ts` (or wherever createApp is invoked)**

Find the `createApp(db, { ... })` call and add `trustProxy: config.trustProxy` to opts.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test:run server/src/__tests__/rate-limit.test.ts`
Expected: all pass (existing 5 + 2 new = 7).

- [ ] **Step 6: Commit**

```bash
git add server/src/app.ts server/src/index.ts server/src/__tests__/rate-limit.test.ts
git commit -m "$(cat <<'EOF'
feat(server): wire trustProxy config into Express app + rate limiter

Operators behind a reverse proxy can now set AOA_TRUST_PROXY=true (or a
hop count / CIDR list). Without this, IP-keyed rate limiters bucket all
traffic through the proxy IP and defenses are useless.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Task B3: Per-route body-size cap for /api/companies/import

**Files:**
- Modify: `server/src/app.ts` (mount before companies routes)

- [ ] **Step 1: Write the failing test**

Add to `server/src/__tests__/company-portability-preview-export.test.ts` (extend existing test file):

```ts
describe("import body-size cap", () => {
  it("returns 413 for bodies over 20MB on /api/companies/import/preview", async () => {
    // Construct ~21MB JSON
    const big = { __pad: "x".repeat(21 * 1024 * 1024) };
    const res = await request(app)
      .post("/api/companies/import/preview")
      .set("Content-Type", "application/json")
      .send(big);
    expect(res.status).toBe(413);
  });

  it("accepts a 1MB legitimate-shape body", async () => {
    const small = { schemaVersion: 2, manifest: {/*...*/}, files: { "x.json": "y".repeat(1024 * 1024) } };
    const res = await request(app)
      .post("/api/companies/import/preview")
      .set("Content-Type", "application/json")
      .send(small);
    // It can return 4xx for schema reasons but NOT 413
    expect(res.status).not.toBe(413);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run server/src/__tests__/company-portability-preview-export.test.ts`
Expected: FAIL on the 413 test — without a per-route limit, the 100KB global default already 413's the 21MB body, so the test "passes by accident" only if the global is 100KB. But once we set a per-route 20MB limit, the global may not apply. Confirm the test is meaningful for the post-fix state.

If the global default already 413's, switch the failing test target to a 30MB body (above the 20MB per-route cap we'll set):

```ts
const big = { __pad: "x".repeat(30 * 1024 * 1024) };
expect(res.status).toBe(413);
```

- [ ] **Step 3: Add per-route limit in `server/src/app.ts`**

Find where the company routes are mounted (likely line ~252 area). Before that, add:

```ts
// Company-import endpoints accept legitimately-larger bundles than the 100KB
// global default; cap at 20MB to bound DoS via inflated payloads.
app.use(
  ["/api/companies/import", "/api/companies/import/preview"],
  express.json({
    limit: "20mb",
    verify: (req, _res, buf) => {
      if (buf && buf.length > 0) {
        (req as unknown as { rawBody?: Buffer }).rawBody = buf;
      }
    },
  }),
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run server/src/__tests__/company-portability-preview-export.test.ts`
Expected: 413 test passes for 30MB; small-body test passes (no 413 surfaced).

- [ ] **Step 5: Commit**

```bash
git add server/src/app.ts server/src/__tests__/company-portability-preview-export.test.ts
git commit -m "$(cat <<'EOF'
fix(import): cap /api/companies/import body size at 20MB

Per-route express.json limit prevents OOM via inflated payloads. The
global 100KB limit is too small for legitimate company-bundle imports;
20MB is sized above realistic worst-case bundles (10K cost-events warn
threshold + array caps from Task B4) and below typical LB limits.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Task B4: Zod array caps on portability schema

**Files:**
- Modify: `packages/shared/src/validators/company-portability.ts`

- [ ] **Step 1: Write the failing test**

Extend `server/src/__tests__/company-portability-preview-export.test.ts`:

```ts
describe("import schema array caps", () => {
  it("rejects bundles with > 10000 issues (one cost-event order beyond the warn threshold)", async () => {
    const bundle = {
      schemaVersion: 2,
      manifest: { /* minimal valid manifest */ },
      issues: Array.from({ length: 10_001 }, (_, i) => ({ id: `i-${i}` /* ... */ })),
    };
    const res = await request(app)
      .post("/api/companies/import/preview")
      .send(bundle);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.body).toMatchObject({ error: expect.stringMatching(/array|too many|exceeds/i) });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run server/src/__tests__/company-portability-preview-export.test.ts`
Expected: FAIL — Zod accepts unbounded arrays today.

- [ ] **Step 3: Add `.max()` caps in `packages/shared/src/validators/company-portability.ts:306-372`**

Locate `portabilityManifestSchema` (or the equivalent top-level shape). Add caps:

```ts
const portabilityManifestSchema = z.object({
  // ... existing fields
  agents: z.array(agentEntrySchema).max(1000, "agents: cap 1000 per bundle"),
  projects: z.array(projectEntrySchema).max(1000, "projects: cap 1000 per bundle"),
  issues: z.array(issueEntrySchema).max(10_000, "issues: cap 10000 per bundle"),
  goals: z.array(goalEntrySchema).max(1000, "goals: cap 1000 per bundle"),
  costEvents: z.array(costEventEntrySchema).max(100_000, "costEvents: cap 100000 (above 10K warn threshold)"),
  financeEvents: z.array(financeEventEntrySchema).max(100_000, "financeEvents: cap 100000"),
  budgetPolicies: z.array(budgetPolicyEntrySchema).max(1000, "budgetPolicies: cap 1000"),
  quotaWindows: z.array(quotaWindowEntrySchema).max(10_000, "quotaWindows: cap 10000"),
  // skills, routines, envInputs match the realistic Paperclip-bundle sizes
  skills: z.array(skillEntrySchema).max(1000, "skills: cap 1000"),
  routines: z.array(routineEntrySchema).max(1000, "routines: cap 1000"),
  envInputs: z.array(envInputEntrySchema).max(1000, "envInputs: cap 1000"),
});
```

(Adjust field names + entry-schema names to match actual code; recon found the schema at `:306-317` so the cap additions go on those lines.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run server/src/__tests__/company-portability-preview-export.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/validators/company-portability.ts server/src/__tests__/company-portability-preview-export.test.ts
git commit -m "$(cat <<'EOF'
fix(portability): add Zod array length caps to import schema

Bounds DoS via deeply-repeated array entries (10M issues = 500MB allocations
during Zod walk). Caps sized above realistic worst-case bundles per the
existing 10K cost-events warn threshold. Operators hitting a cap on a
legitimate bundle should file a bug; raising a cap is a follow-up.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Task B5: Update env-var docs + rate-limit comment

**Files:**
- Modify: `docs/deploy/environment-variables.md`
- Modify: `server/src/middleware/rate-limit.ts:13-19`

- [ ] **Step 1: Add `AOA_TRUST_PROXY` to env-var docs**

Append to the table or list in `docs/deploy/environment-variables.md`:

```markdown
| `AOA_TRUST_PROXY` | `false` | Express trust-proxy setting. Set to `true` (trust any proxy), a hop count like `1` (recommended for cloud), or a comma-separated CIDR list. Required when running behind Cloudflare/ALB/nginx — without it, `req.ip` reads the proxy IP and rate limits collapse. **Never set to `true` on a directly-exposed deployment** (allows X-Forwarded-For spoofing). |
```

- [ ] **Step 2: Update the comment in `rate-limit.ts:13-19`**

Replace the existing "we deliberately don't set trust proxy" block with:

```ts
// Note on trust-proxy + req.ip:
// IP-keyed rate limits read req.ip, which honors Express's `trust proxy`
// setting. Operators behind a reverse proxy must set AOA_TRUST_PROXY
// (env var, parsed in config.ts) to a hop count or CIDR list — see
// docs/deploy/environment-variables.md. Default is `false` to prevent
// X-Forwarded-For spoofing on directly-exposed deployments.
```

- [ ] **Step 3: Run brand-check locally (optional, CI also enforces)**

Run: `pnpm check:tokens` (or whatever the brand-check script is) — confirm no broken refs.

- [ ] **Step 4: Commit**

```bash
git add docs/deploy/environment-variables.md server/src/middleware/rate-limit.ts
git commit -m "$(cat <<'EOF'
docs(deploy): document AOA_TRUST_PROXY env var + update rate-limit comment

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Task B6: Changeset + PR

- [ ] **Step 1: Create `.changeset/security-cloud-readiness-body-caps-trust-proxy.md`**

```md
---
"@armyofagents/server": patch
"@armyofagents/shared": patch
---

Cloud-readiness hardening:
- New `AOA_TRUST_PROXY` env var lets operators opt into Express's `trust proxy` setting (boolean / hop count / CIDR list). Required for cloud deploys behind Cloudflare/ALB/nginx — without it, IP-keyed rate limits from PR #156 collapse to one shared bucket.
- `/api/companies/import` and `/api/companies/import/preview` capped at 20MB body size (was unbounded by the global default's 100KB, which already silently 413'd legitimate bundles).
- Zod array length caps on the portability schema prevent CPU-bound validation on inflated payloads (10M issues → 500MB Zod walk).
```

- [ ] **Step 2: Commit + push + open PR**

```bash
git add .changeset/security-cloud-readiness-body-caps-trust-proxy.md
git commit -m "chore: changeset for cloud-readiness hardening

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"

git push -u origin fix/security-cloud-readiness
gh pr create --base main --head fix/security-cloud-readiness \
  --title "fix(security): cloud readiness — body caps + trust-proxy knob (Sprint 5)" \
  --body "<see template>"
```

---

# PR S5-C — Cross-tenant + audit hardening

**Worktree:** `.worktrees/sprint-5-c-hardening`
**Branch:** `fix/security-cross-tenant-audit-hardening`

## Task C1: Feedback DELETE companyId check

**Files:**
- Modify: `server/src/routes/feedback.ts:166-175`
- Modify: `server/src/__tests__/routes-feedback.test.ts:309-345`

- [ ] **Step 1: Write the failing test**

Append to `server/src/__tests__/routes-feedback.test.ts` (in the existing DELETE describe block):

```ts
it("returns 403 when actor's company differs from vote's company (cross-tenant)", async () => {
  const mockGetById = vi.fn().mockResolvedValue({
    id: "vote-1",
    companyId: "company-A",
    authorUserId: "user-1",
  });
  const mockDismiss = vi.fn();
  // Wire mocks ...

  const app = buildApp(
    { type: "board", userId: "user-1", companyId: "company-B" },
    { /* mockDb */ },
  );
  const res = await request(app).delete("/api/feedback-votes/vote-1");

  expect(res.status).toBe(403);
  expect(mockDismiss).not.toHaveBeenCalled();
});

it("succeeds when actor's company matches vote's company", async () => {
  // ... matching companyIds → expect 200, dismiss called
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run server/src/__tests__/routes-feedback.test.ts`
Expected: FAIL — current handler doesn't load the vote or check companyId.

- [ ] **Step 3: Modify `server/src/routes/feedback.ts:166-175`**

Replace the handler body:

```ts
router.delete("/feedback-votes/:voteId", async (req, res) => {
  const voteId = req.params.voteId as string;

  // Load vote + assert cross-tenant access before dismiss
  const vote = await votes.getById(voteId);
  if (!vote) {
    res.status(404).json({ error: "vote_not_found" });
    return;
  }
  assertCompanyAccess(req, vote.companyId);

  const authorUserId =
    req.actor.type === "board" ? req.actor.userId ?? "local-board" : "local-board";

  const dismissed = await votes.dismissVote(voteId, authorUserId);
  if (!dismissed) {
    res.status(403).json({ error: "not_vote_author" });
    return;
  }
  res.json({ ok: true });
});
```

If `getById` doesn't exist on `feedback-votes` service, add it as a thin wrapper around the existing internal lookup (mirror `secrets.ts` pattern).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run server/src/__tests__/routes-feedback.test.ts`
Expected: all 5 (existing 4 + 1 new) pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/feedback.ts server/src/services/feedback-votes.ts server/src/__tests__/routes-feedback.test.ts
git commit -m "$(cat <<'EOF'
fix(security): cross-tenant gate on DELETE /feedback-votes/:voteId

Loads the vote first and assertCompanyAccess against vote.companyId before
dismissal. Closes a defense-in-depth gap where a UUID-knowledge attacker
in company A could delete a vote in company B (same authorUserId literal
in local_trusted multi-instance). Mirrors the load → check → mutate
pattern in sibling routes (POST/GET in same file).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Task C2: Better-auth http://-only-in-local-trusted

**Files:**
- Modify: `server/src/auth/better-auth.ts:106-107`
- Modify: `server/src/__tests__/better-auth-config.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `server/src/__tests__/better-auth-config.test.ts`:

```ts
describe("deriveAuthTrustedOrigins — scheme rules per deployment mode", () => {
  it("authenticated mode: HTTPS only, no http:// fallback", () => {
    const config = mkConfig({
      deploymentMode: "authenticated",
      allowedHostnames: ["example.com"],
      authBaseUrlMode: "auto",
    });
    const origins = deriveAuthTrustedOrigins(config);
    expect(origins).toContain("https://example.com");
    expect(origins).not.toContain("http://example.com");
  });

  it("local_trusted mode: both http:// and https:// allowed (loopback dev)", () => {
    const config = mkConfig({
      deploymentMode: "local_trusted",
      allowedHostnames: ["localhost"],
      authBaseUrlMode: "auto",
    });
    const origins = deriveAuthTrustedOrigins(config);
    expect(origins).toContain("http://localhost");
    expect(origins).toContain("https://localhost");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run server/src/__tests__/better-auth-config.test.ts`
Expected: FAIL on the `authenticated` test — current code adds both schemes.

- [ ] **Step 3: Modify `server/src/auth/better-auth.ts:91-112`**

Find the loop adding `http://` and `https://` for each `allowedHostnames` entry. Gate the `http://` add on `local_trusted` only:

```ts
for (const hostname of config.allowedHostnames ?? []) {
  const trimmed = hostname.trim();
  if (!trimmed) continue;
  origins.push(`https://${trimmed}`);
  if (config.deploymentMode === "local_trusted") {
    origins.push(`http://${trimmed}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run server/src/__tests__/better-auth-config.test.ts`
Expected: PASS (existing 7 + 2 new = 9 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/auth/better-auth.ts server/src/__tests__/better-auth-config.test.ts
git commit -m "$(cat <<'EOF'
fix(auth): drop http:// from authenticated-mode trustedOrigins

In authenticated/cloud_auth deployments, allowedHostnames previously
generated both http://<host> and https://<host> entries — meaning a
downgrade-attack landing on http:// was accepted as a trusted origin
for credentialed flows. Local_trusted keeps both schemes (loopback dev
is the trust boundary). Operators needing http:// for staging can still
opt in via the explicit BETTER_AUTH_URL path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Task C3: Agent-keys POST: standardize logActivity shape

**Files:**
- Modify: `server/src/routes/agents.ts:1278-1299`
- Modify: `server/src/__tests__/agents-keys-routes.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `server/src/__tests__/agents-keys-routes.test.ts` (use the existing `mockLogActivity` mock at line 82):

```ts
it("POST /agents/:id/keys logs agent.key_created with canonical actor shape", async () => {
  // ... existing setup that creates a key
  await request(app).post(`/api/agents/${agentId}/keys`).send({ name: "k" });

  expect(mockLogActivity).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      action: "agent.key_created",
      entityType: "agent",
      entityId: agentId,
      actorType: expect.any(String),
      actorId: expect.any(String),
      // Canonical fields from getActorInfo:
      agentId: undefined, // or the calling agent's id if actor is agent
      runId: undefined,
      details: expect.objectContaining({ keyId: expect.any(String) }),
    }),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run server/src/__tests__/agents-keys-routes.test.ts`
Expected: FAIL — current code uses old shape (raw `actorType: "user", actorId: req.actor.userId ?? "board"`).

- [ ] **Step 3: Modify `server/src/routes/agents.ts:1278-1299`**

Replace the `logActivity` call body:

```ts
const actor = getActorInfo(req);
await logActivity(db, {
  companyId: agent.companyId,
  actorType: actor.actorType,
  actorId: actor.actorId,
  agentId: actor.agentId,
  runId: actor.runId,
  action: "agent.key_created",
  entityType: "agent",
  entityId: agent.id,
  details: { keyId: key.id, name: key.name },
});
```

(Import `getActorInfo` from `./authz.js` if it isn't already imported in this file.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run server/src/__tests__/agents-keys-routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/agents.ts server/src/__tests__/agents-keys-routes.test.ts
git commit -m "$(cat <<'EOF'
fix(audit): standardize POST /agents/:id/keys activity-log to canonical shape

Switches to ...getActorInfo(req) spread for parity with MCP key routes
and other recent activity-log emitters. No behavior change to the route
itself; this is audit-log shape consistency.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Task C4: Agent-keys DELETE: add logActivity

**Files:**
- Modify: `server/src/routes/agents.ts:1301-1317`
- Modify: `server/src/__tests__/agents-keys-routes.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `server/src/__tests__/agents-keys-routes.test.ts`:

```ts
it("DELETE /agents/:id/keys/:keyId emits agent.key_revoked activity log", async () => {
  // ... setup an existing key
  await request(app).delete(`/api/agents/${agentId}/keys/${keyId}`);

  expect(mockLogActivity).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      action: "agent.key_revoked",
      entityType: "agent",
      entityId: agentId,
      details: expect.objectContaining({ keyId }),
    }),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run server/src/__tests__/agents-keys-routes.test.ts`
Expected: FAIL — DELETE has no logActivity call.

- [ ] **Step 3: Modify `server/src/routes/agents.ts:1301-1317`**

After `await svc.revokeKey(...)`:

```ts
const actor = getActorInfo(req);
await logActivity(db, {
  companyId: agent.companyId,
  actorType: actor.actorType,
  actorId: actor.actorId,
  agentId: actor.agentId,
  runId: actor.runId,
  action: "agent.key_revoked",
  entityType: "agent",
  entityId: agent.id,
  details: { keyId },
});
```

(`agent` is loaded earlier in the handler for the cross-tenant check; if not, load it before the revoke for both purposes.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run server/src/__tests__/agents-keys-routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/agents.ts server/src/__tests__/agents-keys-routes.test.ts
git commit -m "$(cat <<'EOF'
fix(audit): emit agent.key_revoked activity log on DELETE /agents/:id/keys/:keyId

Agent-key revocations were silent in the activity log. Adds logActivity
with canonical actor shape matching the MCP key routes. Forensic-trail
gap closed: 'when did this agent stop having access?' now has an answer.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Task C5: Changeset + PR

- [ ] **Step 1: Create `.changeset/security-cross-tenant-audit-hardening.md`**

```md
---
"@armyofagents/server": patch
---

Cross-tenant + audit hardening:
- DELETE /feedback-votes/:voteId now loads the vote and `assertCompanyAccess` before dismissal (DiD against UUID-knowledge attacks across companies).
- Better-auth trustedOrigins drops `http://<host>` in `authenticated`/`cloud_auth` deployments (downgrade-attack surface). `local_trusted` keeps both schemes for loopback dev.
- POST /agents/:id/keys activity log now uses the canonical `getActorInfo` spread for shape parity.
- DELETE /agents/:id/keys/:keyId now emits `agent.key_revoked` (was silent in the activity log — incident-forensics gap closed).
```

- [ ] **Step 2: Commit + push + open PR**

```bash
git add .changeset/security-cross-tenant-audit-hardening.md
git commit -m "chore: changeset for cross-tenant + audit hardening

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"

git push -u origin fix/security-cross-tenant-audit-hardening
gh pr create --base main --head fix/security-cross-tenant-audit-hardening \
  --title "fix(security): cross-tenant + audit-log hardening (Sprint 5)" \
  --body "<see template>"
```

---

## Self-review (writing-plans skill checklist)

**Spec coverage.** Each verified finding (1, 2, 3, 4, 6, 7) maps to one or more tasks. Findings 5, 8, 9 are explicitly dropped per the spec's "Dropped from scope" section — no plan tasks.

**Placeholder scan.** No "TBD", no "fill in details", no "similar to Task N". Each step has actual code or an actual command. The few `<see template>` references for `gh pr create --body` are the standard PR-body template the implementer fills from the changeset content; this matches Sprints 1-4's pattern.

**Type consistency.**
- Config field `trustProxy: boolean | number | string[]` — matches Express's `app.set("trust proxy", ...)` accepted types.
- `getActorInfo(req)` return shape — already established in `server/src/routes/authz.ts`; tasks C3/C4 use the existing spread shape.
- `assertCompanyAccess(req, companyId)` — same signature used 30+ times across the codebase.
- `feedback-votes.getById(voteId)` — Task C1 may need to add this to the service if it doesn't exist; Step 3 notes the fallback path.

**Open questions tracked.** Two from the spec are deferred to runtime:
1. 20 MB body cap fits real customer bundles? Will know on first complaint; raise then.
2. Whether existing UI test for `DiscussionDetail` needs the mock update — answered by running the suite after Task A4.

**Suggested execution order.**
- All three PRs are independent (no file overlap). Recommended: dispatch S5-A and S5-C in parallel (UI + server, no shared files), then S5-B (touches `app.ts` + `index.ts` which others might re-mount middleware before/after).
- If conflicts arise on `app.ts` (S5-B and S5-C both touch it indirectly via auth middleware), rebase the second PR onto main after the first lands.
