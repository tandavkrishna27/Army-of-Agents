# Verify-Step Honesty + Claude Paste-Code Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a founder whose Claude session expired sign back in without leaving the app, and stop the Verify step promising things it does not do.

**Architecture:** `runStreamingLogin` gains opt-in stdin piping and a `submitCode()`; the commander-login service keeps an in-memory registry of challenges started by THIS process; a new route writes the pasted code to the live child's stdin; completion is decided by re-running the probe, never by the child's exit code. The UI un-gates interactive login for Claude and keeps the terminal path as an honest fallback.

**Tech Stack:** TypeScript, vitest, pnpm workspaces. Packages: `packages/adapter-utils`, `packages/adapters/claude-local`, `server`, `ui`.

**Spec:** `docs/aoa/plans/2026-07-20-verify-honesty-and-claude-login-design.md`

---

## Field evidence (verified — do not re-derive)

Running the real CLI:

```
$ claude auth login
Opening browser to sign in…
If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?...
Paste code here if prompted >          <-- blocks reading stdin
```

A probe replicating the app's REAL spawn options (Windows `shell: true`, so the
child is `cmd.exe /c claude auth login`) wrote an invalid code and the CLI
answered `Invalid code. Please make sure the full code was copied.` — **the stdin
write lands**.

The same probe then printed `Login successful.` and exited **0** right after
rejecting that code. And `~/.claude/.credentials.json` already exists while
holding a REVOKED token. **Therefore: exit code, the CLI's success message, and
credential-file presence are all untrustworthy as completion evidence.** Only
re-running the verify probe is authoritative.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/adapter-utils/src/streaming-login.ts` (modify) | Opt-in stdin piping + `submitCode()` |
| `packages/adapter-utils/src/streaming-login.test.ts` (modify) | Cover stdin opt-in, submitCode, codex-unchanged guard |
| `packages/adapters/claude-local/src/server/login.ts` (modify) | Pass `stdin: "pipe"` for claude |
| `server/src/services/commander-login.ts` (modify) | Live-challenge registry + `submitCode` |
| `server/src/routes/commander-login.ts` (modify) | `POST .../:id/code` |
| `server/src/__tests__/commander-login-code-route.test.ts` (create) | Route contract |
| `ui/src/api/commander-auth.ts` (modify) | `submitCommanderLoginCode` client |
| `ui/src/onboarding/steps/VerifyStep.tsx` (modify) | Un-gate anthropic, code input, copy fixes |
| `ui/src/onboarding/steps/__tests__/VerifyStep.test.tsx` (modify) | UI behaviour |
| `server/src/services/file-import.ts` + `routes/memory-assets-upload.ts` (modify) | pptx honesty |
| `ui/src/onboarding/inflight/BraindumpStep.tsx` (modify) | Repo-chip honesty |

Order: 1 (stdin) → 2 (claude opts in) → 3 (registry) → 4 (route) → 5 (client) → 6 (UI) → 7 (honesty batch) → 8 (live).

---

## Task 1: Opt-in stdin + submitCode

**Files:**
- Modify: `packages/adapter-utils/src/streaming-login.ts`
- Test: `packages/adapter-utils/src/streaming-login.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/adapter-utils/src/streaming-login.test.ts`, following that
file's existing fake-spawn pattern (read it first — it injects `spawn` via the
`opts.spawn` DI seam and returns a fake `TrackedChildHandle` whose `child` is an
EventEmitter with `stdout`/`stderr` streams).

```ts
describe("runStreamingLogin — stdin opt-in", () => {
  it("ignores stdin by default so codex's spawn is unchanged", () => {
    let captured: unknown;
    runStreamingLogin({
      runId: "r1", command: "codex", args: ["login"], cwd: "/tmp", env: {},
      spawn: (_r, _c, _a, opts) => { captured = opts.stdio; return makeFakeHandle(); },
    });
    expect(captured).toEqual(["ignore", "pipe", "pipe"]);
  });

  it("pipes stdin when explicitly requested", () => {
    let captured: unknown;
    runStreamingLogin({
      runId: "r1", command: "claude", args: ["auth", "login"], cwd: "/tmp", env: {},
      stdin: "pipe",
      spawn: (_r, _c, _a, opts) => { captured = opts.stdio; return makeFakeHandle(); },
    });
    expect(captured).toEqual(["pipe", "pipe", "pipe"]);
  });
});

describe("runStreamingLogin — submitCode", () => {
  it("writes the code with a trailing newline to the child's stdin", () => {
    const written: string[] = [];
    const handle = makeFakeHandle({ stdin: { write: (s: string) => { written.push(s); return true; }, writable: true } });
    const r = runStreamingLogin({
      runId: "r1", command: "claude", args: ["auth", "login"], cwd: "/tmp", env: {},
      stdin: "pipe", spawn: () => handle,
    });
    expect(r.submitCode("ABC-123")).toBe(true);
    expect(written).toEqual(["ABC-123\n"]);
  });

  it("returns false when stdin was not piped", () => {
    const handle = makeFakeHandle({ stdin: null });
    const r = runStreamingLogin({
      runId: "r1", command: "codex", args: ["login"], cwd: "/tmp", env: {}, spawn: () => handle,
    });
    expect(r.submitCode("ABC-123")).toBe(false);
  });

  it("returns false once the child's stdin is no longer writable", () => {
    const handle = makeFakeHandle({ stdin: { write: () => true, writable: false } });
    const r = runStreamingLogin({
      runId: "r1", command: "claude", args: ["auth", "login"], cwd: "/tmp", env: {},
      stdin: "pipe", spawn: () => handle,
    });
    expect(r.submitCode("ABC-123")).toBe(false);
  });
});
```

If the existing file has no `makeFakeHandle`, write one that returns
`{ child, pid: 1, pgid: 1, startedAt: new Date(), terminate: () => {} }` where
`child` is an `EventEmitter` with `stdout`/`stderr` as `EventEmitter`s and a
`stdin` property from the test's options.

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/adapter-utils && npx vitest run src/streaming-login.test.ts`
Expected: FAIL — `stdin` is not an accepted option and `submitCode` is not a function.

- [ ] **Step 3: Implement**

In `packages/adapter-utils/src/streaming-login.ts`:

Add to `StreamingLoginResult`:

```ts
export interface StreamingLoginResult {
  handle: TrackedChildHandle;
  urlPromise: Promise<string>;
  exitPromise: Promise<number | null>;
  /**
   * Write a pasted auth code to the child's stdin.
   *
   * Claude's flow REQUIRES this: `claude auth login` prints its URL and then
   * blocks on "Paste code here". Codex self-completes via a local callback and
   * never needs it. Returns false when stdin was not piped or the child has
   * already gone, so the caller can report an honest error instead of hanging —
   * a silent no-op here is the exact failure this feature removes.
   */
  submitCode(code: string): boolean;
}
```

Add to `RunStreamingLoginOptions`:

```ts
  /**
   * stdin disposition. Defaults to "ignore" — codex's device flow needs no
   * input, and leaving its spawn byte-identical keeps a working flow risk-free.
   * Claude passes "pipe" because its login blocks reading a pasted code.
   */
  stdin?: "ignore" | "pipe";
```

Change the spawn:

```ts
  const handle = spawnFn(opts.runId, opts.command, opts.args, {
    cwd: opts.cwd,
    env: opts.env,
    graceSec: 5,
    unsetEnvKeys: opts.unsetEnvKeys,
    stdio: [opts.stdin ?? "ignore", "pipe", "pipe"],
  });
```

Add before the return, and include `submitCode` in the returned object:

```ts
  const submitCode = (code: string): boolean => {
    const stdin = child.stdin;
    if (!stdin || stdin.writable === false) return false;
    stdin.write(`${code}\n`);
    return true;
  };

  return { handle, urlPromise, exitPromise, submitCode };
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/adapter-utils && npx vitest run`
Expected: PASS — new tests plus every pre-existing test in the package.

- [ ] **Step 5: Typecheck and commit**

```bash
cd packages/adapter-utils && npx tsc --noEmit
git add packages/adapter-utils/src/streaming-login.ts packages/adapter-utils/src/streaming-login.test.ts
git commit -m "feat(adapter-utils): opt-in stdin piping + submitCode for streaming login"
```

---

## Task 2: Claude opts into piped stdin

**Files:**
- Modify: `packages/adapters/claude-local/src/server/login.ts:42-52`
- Test: `packages/adapters/claude-local/src/server/login.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { runClaudeLoginStreaming } from "./login.js";

describe("runClaudeLoginStreaming", () => {
  it("pipes stdin because claude's login blocks on a pasted code", () => {
    let captured: unknown;
    runClaudeLoginStreaming({
      runId: "r1",
      env: { CLAUDE_CONFIG_DIR: "/tmp/claude-home" } as NodeJS.ProcessEnv,
      spawn: (_r, _c, _a, opts) => {
        captured = opts.stdio;
        return makeFakeHandle();
      },
    });
    expect(captured).toEqual(["pipe", "pipe", "pipe"]);
  });

  it("runs `claude auth login`", () => {
    let argv: string[] = [];
    runClaudeLoginStreaming({
      runId: "r1",
      env: { CLAUDE_CONFIG_DIR: "/tmp/claude-home" } as NodeJS.ProcessEnv,
      spawn: (_r, _c, a, _o) => { argv = a; return makeFakeHandle(); },
    });
    expect(argv).toEqual(["auth", "login"]);
  });
});
```

Define `makeFakeHandle()` locally as in Task 1.

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/adapters/claude-local && npx vitest run src/server/login.test.ts`
Expected: FAIL — stdio is `["ignore","pipe","pipe"]`.

- [ ] **Step 3: Implement**

In `packages/adapters/claude-local/src/server/login.ts`, add `stdin: "pipe"` to
the `runStreamingLogin` call:

```ts
  const result = runStreamingLogin({
    runId: args.runId,
    command: args.command ?? "claude",
    args: ["auth", "login"],
    cwd: authHome,
    env: { CLAUDE_CONFIG_DIR: authHome },
    // Claude blocks on "Paste code here" — see the module header. Codex does not
    // and deliberately keeps the default "ignore".
    stdin: "pipe",
    discoveryTimeoutMs: args.discoveryTimeoutMs,
    spawn: args.spawn,
  });
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/adapters/claude-local && npx vitest run`
Expected: PASS, whole package.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/claude-local/src/server/login.ts packages/adapters/claude-local/src/server/login.test.ts
git commit -m "feat(claude-local): pipe stdin for the paste-code login flow"
```

---

## Task 3: Live-challenge registry in the login service

**Files:**
- Modify: `server/src/services/commander-login.ts`
- Test: `server/src/__tests__/commander-login-service.test.ts`

Read the existing service first. `LoginRunLike` currently exposes
`{ handle, urlPromise, exitPromise, authHome }`. `startChallenge` holds `run` in
a closure. You are adding a process-local map so a LATER request can reach the
same child.

- [ ] **Step 1: Write the failing test**

Append to `server/src/__tests__/commander-login-service.test.ts`, matching its
existing dependency-injection style (it builds the service with fake `deps`):

```ts
describe("commander login — submitCode registry", () => {
  it("delivers a code to the live child of a challenge this process started", async () => {
    const submitted: string[] = [];
    const svc = buildServiceWithFakes({
      runLogin: () => ({
        handle: { pid: 1, pgid: 1, terminate: () => {} },
        urlPromise: Promise.resolve("https://claude.com/x"),
        exitPromise: new Promise<number | null>(() => {}),
        authHome: "/tmp/home",
        submitCode: (c: string) => { submitted.push(c); return true; },
      }),
    });
    const { challengeId } = await svc.startChallenge({
      companyId: "c1", provider: "anthropic", startedByUserId: "u1",
    });

    expect(svc.submitCode(challengeId, "ABC-123")).toBe("delivered");
    expect(submitted).toEqual(["ABC-123"]);
  });

  it("reports not-live for a challenge this process did not start", () => {
    const svc = buildServiceWithFakes({});
    expect(svc.submitCode("some-other-id", "ABC-123")).toBe("not-live");
  });

  it("reports not-live once the child refuses the write", async () => {
    const svc = buildServiceWithFakes({
      runLogin: () => ({
        handle: { pid: 1, pgid: 1, terminate: () => {} },
        urlPromise: Promise.resolve("https://claude.com/x"),
        exitPromise: new Promise<number | null>(() => {}),
        authHome: "/tmp/home",
        submitCode: () => false, // child already exited
      }),
    });
    const { challengeId } = await svc.startChallenge({
      companyId: "c1", provider: "anthropic", startedByUserId: "u1",
    });
    expect(svc.submitCode(challengeId, "ABC-123")).toBe("not-live");
  });
});
```

`buildServiceWithFakes` should reuse whatever helper the file already has for
constructing the service with fake deps; if it has none, write one that supplies
minimal fakes for `store`, `resolveAuthHome`, `credentialPresent`, `terminate`,
`newId`, and `env`, with the `runLogin` override merged in.

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run src/__tests__/commander-login-service.test.ts`
Expected: FAIL — `svc.submitCode` is not a function.

- [ ] **Step 3: Implement**

In `server/src/services/commander-login.ts`:

Add `submitCode` to `LoginRunLike`:

```ts
export interface LoginRunLike {
  handle: { pid: number | null; pgid: number | null; terminate: () => void };
  urlPromise: Promise<string>;
  exitPromise: Promise<number | null>;
  authHome: string;
  /** Deliver a pasted auth code to the live child. False when it cannot be delivered. */
  submitCode?: (code: string) => boolean;
}
```

It is OPTIONAL so codex's runner needs no change.

Inside the service factory, add a process-local registry:

```ts
/**
 * Challenges started by THIS process, keyed by challengeId.
 *
 * Deliberately in-memory and NOT persisted: delivering a pasted code requires
 * the live child's stdin, which only exists in the process that spawned it. A
 * challenge from a prior process (server restart) therefore cannot receive a
 * code, and the honest answer is "start again" — mirroring the existing
 * LIVE-handle vs DURABLE-row distinction this service already draws for kills.
 */
const liveRuns = new Map<string, { submitCode?: (code: string) => boolean }>();
```

Register on start (where the challenge id and `run` are both in scope) and delete
on every terminal path — completion, failure, timeout, and cancel:

```ts
liveRuns.set(challengeId, { submitCode: run.submitCode });
```
```ts
liveRuns.delete(challengeId);
```

Expose:

```ts
export type SubmitCodeResult = "delivered" | "not-live";

  submitCode(challengeId: string, code: string): SubmitCodeResult {
    const live = liveRuns.get(challengeId);
    if (!live?.submitCode) return "not-live";
    return live.submitCode(code) ? "delivered" : "not-live";
  },
```

Do NOT log `code` anywhere. It is a credential.

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npx vitest run src/__tests__/commander-login-service.test.ts src/__tests__/commander-login-route.test.ts src/__tests__/commander-login-runtime-store.test.ts`
Expected: PASS, including all pre-existing cases.

- [ ] **Step 5: Wire the runtime**

In `server/src/services/commander-login-runtime.ts`, `runLogin` already returns
the result of `runClaudeLoginStreaming` / `runCodexLogin`. Since Task 1 added
`submitCode` to `StreamingLoginResult`, the claude branch now carries it
automatically — confirm by typecheck, and add nothing if it already flows.

- [ ] **Step 6: Typecheck and commit**

```bash
cd server && npx tsc --noEmit -p tsconfig.json
git add server/src/services/commander-login.ts server/src/services/commander-login-runtime.ts server/src/__tests__/commander-login-service.test.ts
git commit -m "feat(commander-login): registry of live challenges + submitCode"
```

---

## Task 4: The submit-code route

**Files:**
- Modify: `server/src/routes/commander-login.ts`
- Create: `server/src/__tests__/commander-login-code-route.test.ts`

- [ ] **Step 1: Write the failing test**

Model the harness on `server/src/__tests__/commander-login-route.test.ts` — read
it first and reuse its express-app + fake-service setup.

```ts
describe("POST commander-login/:id/code", () => {
  it("202s when the code is delivered to a live challenge", async () => {
    const service = { submitCode: vi.fn(() => "delivered") };
    const res = await request(appWith(service))
      .post("/api/companies/c1/internal-agent/commander-login/ch1/code")
      .send({ code: "ABC-123" });
    expect(res.status).toBe(202);
    expect(service.submitCode).toHaveBeenCalledWith("ch1", "ABC-123");
  });

  it("409s when the challenge is not live in this process", async () => {
    const service = { submitCode: vi.fn(() => "not-live") };
    const res = await request(appWith(service))
      .post("/api/companies/c1/internal-agent/commander-login/ch1/code")
      .send({ code: "ABC-123" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/start again/i);
  });

  it("400s on an empty code without touching the service", async () => {
    const service = { submitCode: vi.fn() };
    const res = await request(appWith(service))
      .post("/api/companies/c1/internal-agent/commander-login/ch1/code")
      .send({ code: "   " });
    expect(res.status).toBe(400);
    expect(service.submitCode).not.toHaveBeenCalled();
  });

  // The code is a credential: it must never reach a response body.
  it("never echoes the code back", async () => {
    const service = { submitCode: vi.fn(() => "delivered") };
    const res = await request(appWith(service))
      .post("/api/companies/c1/internal-agent/commander-login/ch1/code")
      .send({ code: "SUPER-SECRET-CODE" });
    expect(JSON.stringify(res.body)).not.toContain("SUPER-SECRET-CODE");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run src/__tests__/commander-login-code-route.test.ts`
Expected: FAIL — 404, the route does not exist.

- [ ] **Step 3: Implement**

Add to `server/src/routes/commander-login.ts`, after the `/start` handler and
using the same `gate(req, res, companyId)` authz as its siblings:

```ts
  router.post(
    "/companies/:companyId/internal-agent/commander-login/:id/code",
    async (req: Request, res: Response) => {
      const companyId = req.params.companyId as string;
      if (!(await gate(req, res, companyId))) return;

      const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
      if (!code) {
        res.status(400).json({ error: "code is required" });
        return;
      }

      // NB: never log `code` — it exchanges for a live credential.
      const result = service.submitCode(req.params.id as string, code);
      if (result === "not-live") {
        res.status(409).json({
          error: "This sign-in session is no longer active. Start sign-in again.",
        });
        return;
      }
      res.status(202).json({ ok: true });
    },
  );
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npx vitest run src/__tests__/commander-login-code-route.test.ts src/__tests__/commander-login-route.test.ts`
Expected: PASS both files.

- [ ] **Step 5: Typecheck and commit**

```bash
cd server && npx tsc --noEmit -p tsconfig.json
git add server/src/routes/commander-login.ts server/src/__tests__/commander-login-code-route.test.ts
git commit -m "feat(commander-login): POST :id/code delivers a pasted auth code"
```

---

## Task 5: UI API client

**Files:**
- Modify: `ui/src/api/commander-auth.ts`

- [ ] **Step 1: Implement (thin client, covered by Task 6's tests)**

Add alongside `startCommanderLogin`:

```ts
/**
 * Deliver the code the founder pasted from the browser sign-in page.
 *
 * Claude's `claude auth login` blocks reading this on stdin; the server writes
 * it to the live child. A 409 means the sign-in session is gone (server
 * restarted) and the founder must start again.
 */
export function submitCommanderLoginCode(args: {
  companyId: string;
  challengeId: string;
  code: string;
}): Promise<{ ok: true }> {
  return api.post(
    `/companies/${args.companyId}/internal-agent/commander-login/${encodeURIComponent(args.challengeId)}/code`,
    { code: args.code },
  );
}
```

- [ ] **Step 2: Typecheck and commit**

```bash
cd ui && npx tsc --noEmit -p tsconfig.json
git add ui/src/api/commander-auth.ts
git commit -m "feat(ui): commander-login submit-code client"
```

---

## Task 6: VerifyStep — un-gate Claude, add the code input, fix the copy

**Files:**
- Modify: `ui/src/onboarding/steps/VerifyStep.tsx`
- Test: `ui/src/onboarding/steps/__tests__/VerifyStep.test.tsx`

Read the component first. Today the interactive-login block is wrapped in
`{provider === "openai" && ( … )}` with a comment saying Claude needs a
paste-code bridge. That bridge now exists.

- [ ] **Step 1: Write the failing tests**

Append to the test file, following its existing patterns (it mocks `api.post`,
`../../../api/commander-auth`, and drives the step by clicking "Verify"; a 422 is
delivered by rejecting `post` with `new ApiError("Request failed: 422", 422, body)`).
Add `submitCommanderLoginCode` to the existing `commander-auth` mock.

```ts
describe("VerifyStep — Claude in-app sign-in", () => {
  beforeEach(() => vi.clearAllMocks());

  const NEEDS_AUTH = {
    outcome: "needs_auth",
    result: { status: "warn", checks: [
      { code: "claude_hello_probe_auth_expired", level: "warn",
        message: "Signed in as ada@example.com, but that session has expired or been revoked." },
    ] },
  };

  it("offers interactive sign-in for Claude, not just Codex", async () => {
    post.mockRejectedValueOnce(new ApiError("Request failed: 422", 422, NEEDS_AUTH));
    startCommanderLogin.mockResolvedValue({ challengeId: "ch1", loginUrl: "https://claude.com/x" });
    render(<VerifyStep ctx={ctx} onComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    const btn = await screen.findByRole("button", { name: /sign in with claude/i });
    fireEvent.click(btn);

    expect(await screen.findByText(/https:\/\/claude\.com\/x/)).toBeTruthy();
    expect(screen.getByLabelText(/paste the code/i)).toBeTruthy();
  });

  it("submits the pasted code", async () => {
    post.mockRejectedValueOnce(new ApiError("Request failed: 422", 422, NEEDS_AUTH));
    startCommanderLogin.mockResolvedValue({ challengeId: "ch1", loginUrl: "https://claude.com/x" });
    submitCommanderLoginCode.mockResolvedValue({ ok: true });
    render(<VerifyStep ctx={ctx} onComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    fireEvent.click(await screen.findByRole("button", { name: /sign in with claude/i }));

    fireEvent.change(await screen.findByLabelText(/paste the code/i), { target: { value: "ABC-123" } });
    fireEvent.click(screen.getByRole("button", { name: /submit code/i }));

    await waitFor(() =>
      expect(submitCommanderLoginCode).toHaveBeenCalledWith({
        companyId: "c1", challengeId: "ch1", code: "ABC-123",
      }),
    );
  });

  it("tells the founder to start again when the session is gone (409)", async () => {
    post.mockRejectedValueOnce(new ApiError("Request failed: 422", 422, NEEDS_AUTH));
    startCommanderLogin.mockResolvedValue({ challengeId: "ch1", loginUrl: "https://claude.com/x" });
    submitCommanderLoginCode.mockRejectedValue(
      new ApiError("Request failed: 409", 409, { error: "This sign-in session is no longer active. Start sign-in again." }),
    );
    render(<VerifyStep ctx={ctx} onComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    fireEvent.click(await screen.findByRole("button", { name: /sign in with claude/i }));
    fireEvent.change(await screen.findByLabelText(/paste the code/i), { target: { value: "ABC-123" } });
    fireEvent.click(screen.getByRole("button", { name: /submit code/i }));

    expect(await screen.findByText(/start sign-in again/i)).toBeTruthy();
  });
});

describe("VerifyStep — honest recovery copy", () => {
  beforeEach(() => vi.clearAllMocks());

  const NEEDS_AUTH = {
    outcome: "needs_auth",
    result: { status: "warn", checks: [
      { code: "claude_hello_probe_auth_required", level: "warn",
        message: "Claude CLI is installed, but you're not signed in yet." },
    ] },
  };

  it("does not claim 'no terminal required'", async () => {
    post.mockRejectedValueOnce(new ApiError("Request failed: 422", 422, NEEDS_AUTH));
    const { container } = render(<VerifyStep ctx={ctx} onComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    await screen.findByText(/not signed in yet/i);
    expect(container.textContent).not.toMatch(/no terminal required/i);
  });

  it("shows the literal command while watching for a terminal sign-in", async () => {
    post.mockRejectedValueOnce(new ApiError("Request failed: 422", 422, NEEDS_AUTH));
    render(<VerifyStep ctx={ctx} onComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    fireEvent.click(await screen.findByRole("button", { name: /sign in myself/i }));

    expect(await screen.findByText("claude auth login")).toBeTruthy();
    expect(screen.getByText(/we'll detect it automatically/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ui && npx vitest run src/onboarding/steps/__tests__/VerifyStep.test.tsx`
Expected: FAIL — no Claude sign-in button, no code input, and the "no terminal
required" string is present.

- [ ] **Step 3: Implement**

Three changes in `ui/src/onboarding/steps/VerifyStep.tsx`:

**(a) Un-gate interactive login.** Replace `{provider === "openai" && (` around
the interactive-login block with `{(provider === "openai" || provider === "anthropic") && (`,
and delete the stale "Codex-only" comment. Label the trigger button
`Sign in with {providerLabel}`.

**(b) Add the code input for anthropic.** When `login` is set and
`provider === "anthropic"`, render below the URL:

```tsx
<label className="block font-medium text-text" htmlFor="commander-login-code">
  Paste the code from that page
</label>
<input
  id="commander-login-code"
  className="w-full rounded-md border border-border-strong bg-field px-2 py-1.5 text-text outline-none focus:border-brand focus:ring-1 focus:ring-brand"
  autoComplete="off"
  value={loginCode}
  onChange={(e) => setLoginCode(e.target.value)}
/>
<Button
  type="button"
  size="sm"
  disabled={codeBusy || !loginCode.trim()}
  onClick={() => void submitCode()}
>
  {codeBusy ? "Submitting…" : "Submit code"}
</Button>
{codeError && <p className="text-destructive">{codeError}</p>}
```

with state `const [loginCode, setLoginCode] = useState("")`,
`const [codeBusy, setCodeBusy] = useState(false)`,
`const [codeError, setCodeError] = useState<string | null>(null)` and:

```tsx
  const submitCode = async () => {
    if (!ctx.companyId || !login) return;
    setCodeBusy(true);
    setCodeError(null);
    try {
      await submitCommanderLoginCode({
        companyId: ctx.companyId,
        challengeId: login.challengeId,
        code: loginCode.trim(),
      });
      setLoginCode("");
      // Completion is decided by the PROBE, never by the CLI's own exit code or
      // success message — both were observed lying after an invalid code.
      await check();
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as { error?: string } | null) : null;
      setCodeError(body?.error ?? (e instanceof Error ? e.message : "Could not submit the code."));
    } finally {
      setCodeBusy(false);
    }
  };
```

Import `submitCommanderLoginCode` from `../../api/commander-auth`.

**(c) Fix the copy.** Replace the panel's `Choose one — no terminal required:`
with `Choose one:`. In the CLI-watch state, replace the bare spinner text with:

```tsx
<p>
  Run <code className="rounded bg-field px-1 py-0.5">claude auth login</code> in a
  terminal — we'll detect it automatically and continue.
</p>
```

Use the provider's real command: `claude auth login` for anthropic,
`codex login` for openai.

- [ ] **Step 4: Run to verify it passes**

Run: `cd ui && npx vitest run src/onboarding/steps/__tests__/VerifyStep.test.tsx`
Expected: PASS — new tests plus all pre-existing ones.

Then: `cd ui && npx vitest run src/onboarding`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
cd ui && npx tsc --noEmit -p tsconfig.json
git add ui/src/onboarding/steps/VerifyStep.tsx ui/src/onboarding/steps/__tests__/VerifyStep.test.tsx
git commit -m "feat(onboarding): in-app Claude sign-in + honest recovery copy"
```

---

## Task 7: Honesty batch — pptx and the repo chip

Same theme as the rest of this plan: stop implying capabilities we do not have.

**Files:**
- Modify: `server/src/routes/memory-assets-upload.ts:11-21`
- Test: `server/src/__tests__/memory-assets-upload-types.test.ts` (create)
- Modify: `ui/src/onboarding/inflight/BraindumpStep.tsx`
- Test: `ui/src/onboarding/inflight/__tests__/BraindumpStep.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `server/src/__tests__/memory-assets-upload-types.test.ts`.

The invariant worth locking is that the UPLOAD allowlist never accepts a type
the extractor cannot read — testing `SUPPORTED_MIME_TYPES` alone would assert
something already true and would not catch the change. So export the set from
the route module first:

in `server/src/routes/memory-assets-upload.ts`, change
`const SUPPORTED_UPLOAD_MIME_TYPES_SET` to
`export const SUPPORTED_UPLOAD_MIME_TYPES_SET`.

```ts
import { describe, it, expect } from "vitest";
import { SUPPORTED_MIME_TYPES } from "../services/file-import.js";
import { SUPPORTED_UPLOAD_MIME_TYPES_SET } from "../routes/memory-assets-upload.js";

const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
// Types we store deliberately without reading (the founder can see them in the
// memory tree; the Librarian is told not to describe them).
const STORE_ONLY = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp",
  "video/mp4", "video/webm", "video/quicktime",
]);

describe("upload allowlist honesty", () => {
  // A type that uploads but is never extracted is a silent no-op: the founder
  // drops a deck, sees it accepted, and the Librarian reads nothing from it.
  it("does not accept .pptx, which nothing can extract", () => {
    expect(SUPPORTED_UPLOAD_MIME_TYPES_SET.has(PPTX)).toBe(false);
  });

  it("every accepted type is either extractable or deliberately store-only", () => {
    const extractable = new Set<string>(SUPPORTED_MIME_TYPES);
    const unexplained = [...SUPPORTED_UPLOAD_MIME_TYPES_SET].filter(
      (t) => !extractable.has(t) && !STORE_ONLY.has(t),
    );
    expect(unexplained).toEqual([]);
  });
});
```

If pptx extraction is ever implemented, add it to `SUPPORTED_MIME_TYPES` — the
second test then admits it automatically, and neither test needs editing.

Append to `ui/src/onboarding/inflight/__tests__/BraindumpStep.test.tsx`:

```ts
it("does not imply the Librarian reads the connected repo", async () => {
  list.mockResolvedValue([
    makeDept({ id: "d1", urlKey: "software", name: "Software",
      primaryWorkspace: { id: "ws1", repoUrl: "https://github.com/acme/product", cwd: null } }),
  ]);
  const { container } = render(<BraindumpStep companyId="c1" onDone={vi.fn()} />);
  await screen.findByText("https://github.com/acme/product");
  // The chip states what is connected; it must not promise reading.
  expect(container.textContent).toMatch(/not read yet|for reference/i);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && npx vitest run src/__tests__/memory-assets-upload-types.test.ts`
Expected: FAIL — pptx is currently IN the upload allowlist, so both tests fail
(the second reports it as an unexplained accepted type).

Run: `cd ui && npx vitest run src/onboarding/inflight/__tests__/BraindumpStep.test.tsx`
Expected: FAIL — no such wording.

- [ ] **Step 3: Implement**

In `server/src/routes/memory-assets-upload.ts`, remove the pptx entry from
`SUPPORTED_UPLOAD_MIME_TYPES_SET` so a deck is rejected with the route's existing
clear `Unsupported file type` 400 rather than being silently accepted and never
read:

```ts
const SUPPORTED_UPLOAD_MIME_TYPES_SET = new Set<string>([
  ...SUPPORTED_MIME_TYPES,
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  // .pptx intentionally NOT accepted: nothing extracts it, so accepting it
  // would take the founder's deck and read nothing from it. Add it back here
  // AND to SUPPORTED_MIME_TYPES together, never separately.
]);
```

In `ui/src/onboarding/inflight/BraindumpStep.tsx`, add a caption under the chip:

```tsx
{box.repoChip && (
  <p className="mt-1 text-[10px] text-very-dim">Connected for reference — not read yet.</p>
)}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd server && npx vitest run src/__tests__/memory-assets-upload-types.test.ts`
Run: `cd ui && npx vitest run src/onboarding/inflight/__tests__/BraindumpStep.test.tsx`
Expected: PASS both.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/memory-assets-upload.ts server/src/__tests__/memory-assets-upload-types.test.ts ui/src/onboarding/inflight/BraindumpStep.tsx ui/src/onboarding/inflight/__tests__/BraindumpStep.test.tsx
git commit -m "fix: stop accepting unreadable .pptx and stop implying repo reading"
```

---

## Task 8: Live verification against an isolated config dir

**Never test this against the dogfood machine's real credentials** — they
currently work, and a failed experiment would break the user's CLI. Use a
throwaway `CLAUDE_CONFIG_DIR`, which `resolveClaudeConfigHome` honours.

- [ ] **Step 1: Rebuild and restart the instance**

```bash
cd /c/Users/TK/.aoa/wt/memstep
git checkout --detach <this-branch-HEAD>
pnpm install --prefer-offline
pnpm --filter @armyofagents/adapter-utils build
pnpm --filter @armyofagents/shared build
pnpm --filter @armyofagents/db build
```

Kill the process listening on 3120, then start with an ISOLATED claude home so
the probe sees a signed-OUT state:

```bash
mkdir -p /c/Users/TK/AppData/Local/Temp/claude-test-home
cd /c/Users/TK/.aoa/wt/memstep
AOA_INSTANCE_ID=memstep AOA_HOME=/c/Users/TK/.aoa/wt/memstep/.aoa PORT=3120 \
AOA_EMBEDDED_POSTGRES_PORT=54430 AOA_DEV_LOCAL_IDENTITY=1 \
CLAUDE_CONFIG_DIR=/c/Users/TK/AppData/Local/Temp/claude-test-home \
node scripts/dev-runner.mjs watch > /tmp/memstep3.log 2>&1 &
```

Wait for `/api/health` to return `"status":"ok"`.

- [ ] **Step 2: Confirm the probe reports signed-out**

```bash
CID=dfb844b4-ddda-4c7e-b38a-d9642ca59d2f
curl -s -X POST "http://127.0.0.1:3120/api/companies/$CID/internal-agent/verify" \
  -H "content-type: application/json" -d '{}' | python -m json.tool
```

Expected: `outcome: "needs_auth"` with `claude_hello_probe_auth_required` (NOT
`auth_expired` — the isolated home has no credentials at all).

- [ ] **Step 3: Drive the UI sign-in**

Open the Verify step in the browser, click **Sign in with Claude**, and confirm:
- a `https://claude.com/...` URL appears as a link
- a "Paste the code" input appears
- the panel does NOT say "no terminal required"

Complete the sign-in in the browser, paste the code, submit.

Expected: the step re-verifies and the outcome flips to `verified`.

- [ ] **Step 4: Verify the 409 path**

Restart the server while a challenge is pending, then submit a code.
Expected: "This sign-in session is no longer active. Start sign-in again." — not
a hang and not a silent no-op.

- [ ] **Step 5: Confirm the real credentials are untouched**

```bash
claude auth status
```

Expected: still logged in as before. The isolated `CLAUDE_CONFIG_DIR` must not
have disturbed `~/.claude`.

- [ ] **Step 6: Full suites**

```bash
cd packages/adapter-utils && npx vitest run
cd ../adapters/claude-local && npx vitest run
cd ../codex-local && npx vitest run
cd ../../ui && npx vitest run
cd ../server && npx vitest run src/__tests__/commander-login-code-route.test.ts src/__tests__/commander-login-route.test.ts src/__tests__/commander-login-service.test.ts src/__tests__/commander-verify.test.ts
```

Expected: all green.

- [ ] **Step 7: Commit**

```bash
git commit --allow-empty -m "test: live-verify in-app Claude sign-in against an isolated config dir"
```

---

## Out of scope

- `claude setup-token` as an alternative acquisition path (own spike).
- The Agent-detail "Login to Claude Code" surface.
- Librarian access/recall and repo reading — deferred to its own spec.
- Orphan-asset cleanup and the cross-tab braindump run-id collision.
- Item 4 (unified onboarding flow chrome).
