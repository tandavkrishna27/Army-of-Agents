# WRK-009 — Design: stop shipping the success fabricator in the worker image

**Epic:** `E4-worker-daemon`. **Terrain:** [`SPIKE-worker-walking-skeleton.md`](../../../SPIKE-worker-walking-skeleton.md) §F6.
**Start SHA:** the commit that adds this file.
**Why first:** the spike's step 0 — the only step whose value is destroyed by doing it later.

---

## 1. The problem, stated precisely

`createFakeSandboxProvider` lives at `packages/worker-daemon/src/supervisor/fake-provider.ts` —
**inside the daemon's own production source tree** — is re-exported from the public barrel
(`src/index.ts:380`), and therefore **ships in the production worker image**. Verified by running it:

```
$ docker run --rm --entrypoint sh localhost/aoa/worker:<sha> -c 'find / -name "fake-provider*"'
/worker-app/dist/supervisor/fake-provider.js
```

What it does when reached: `fake-provider.ts:309` returns `exitCode: script.exitCode ?? 0`, so a
default-constructed instance reports success. `supervisor.ts:398` maps `exitCode === 0` to
`status: "succeeded"`, the durable sink uploads a `terminal` event, and the server **completes a
tenant attempt for work that never ran**.

**Severity, stated honestly.** It has **no production constructor** — grep across `packages`,
`server`, `tests`, `scripts`, `docker` finds only its definition and the barrel export. So this is a
**loaded footgun in the shipped artifact, not a live vulnerability**, and this design does not claim
otherwise.

What makes it urgent anyway:

1. It is the **only** `SandboxProvider` the daemon can import — `packages/sandbox-e2b-provider`
   *depends on* worker-daemon, so the arrow cannot be reversed, and E4-D01 permits only
   `@armyofagents/worker-protocol` + `pino`.
2. `supervisor.ts:195-200` `createSpecFor` already hardcodes `env: {}`. Composing the loop is a
   handful of lines, and the only provider in reach fabricates success.
3. **A fabricated success is byte-identical to a real one on every existing gate.** No test, no
   contract, no CI job distinguishes them — so nothing would catch the mistake after it was made.

## 2. The fix is to put it where its siblings already live

This is not a new convention. `packages/worker-daemon/src/__tests__/support/` already holds every
other double in the package: `fake-control-plane.ts`, `poll-fixtures.ts`, `supervisor-fixtures.ts`,
`enroll-fixtures.ts`, `event-fixtures.ts`, `renewal-fixtures.ts`. **`fake-provider.ts` is the
outlier**, and moving it is a correction rather than an invention.

`packages/worker-daemon/tsconfig.json` excludes `src/__tests__`, so the move alone removes it from
the emitted `dist/` and therefore from the image.

**Three changes:**

1. Move `src/supervisor/fake-provider.ts` → `src/__tests__/support/fake-provider.ts`.
2. Drop the two re-export lines from `src/index.ts` (`:380` and the type block at `:381-386`).
   **Verified safe:** the only cross-package consumer of a symbol by that name imports it from
   `@armyofagents/sandbox-fake-provider`, a different package
   (`sandbox-provider-contract/src/__tests__/contract-nonvacuous.test.ts:7`). Nothing imports it
   from the worker-daemon barrel.
3. Update the ~15 test imports from `../supervisor/fake-provider.js` to `./support/fake-provider.js`.

## ★ 3. What this design deliberately does NOT add

**A "refusing" default provider.** The obvious companion change is to ship a provider whose `create`
throws, as the safe default for a future composition. This design **omits it on purpose**: nothing
composes the loop yet, so it would be production code with **no caller** — the exact failure class
this programme keeps finding, and one I have shipped twice today. It belongs in the ticket that
actually composes the loop, where it will have a caller and can be proven.

Also note it is **not required for safety here**: `supervisor.ts:285-296` already converts a
create-throw into a durable `terminal{status:"failed", errorCode:"create_failed"}` with cleanup
escalation. A composition given no provider fails loudly today. The hazard was never the absence of
a refusing default — it was the presence of a *lying* one.

## 4. The guard — because a move alone is undone by the next person

`docker/images/__tests__/image-contents.test.mjs` already makes least-privilege assertions against
the **built images** ("worker: NO server/db/ui"). A test double in the image is exactly that class
of assertion, so the guard goes there rather than in a new script.

**Add:** the worker image contains no `fake-provider*` and no `__tests__` path.

**Anti-vacuity — this matters more than the assertion.** The test SKIPs without a Docker daemon and
built images, so a green local run proves nothing. The assertion must therefore be written so that
it fails against **today's** image, and this is verifiable right now: I have a worker image built at
`58e810b6d` that genuinely contains `/worker-app/dist/supervisor/fake-provider.js`. The guard is run
against that image BEFORE the move (must FAIL) and after (must PASS). A guard that has only ever
been observed passing is not a guard.

## 5. Tests

| Area | Test |
|---|---|
| Guard, fail-first | run the new image assertion against the pre-move image → **must fail** |
| Guard, pass | run it against the post-move image → **must pass** |
| Barrel | `createFakeSandboxProvider` is no longer exported from `@armyofagents/worker-daemon` |
| No regression | the ~15 supervisor/cleanup suites still pass from the new import path |
| Boundary | `check-worker-daemon-boundary.mjs` still passes (the move keeps it inside `src`) |

## 6. Out of scope

- **The refusing provider** (§3) — belongs with the composition ticket.
- **`packages/sandbox-fake-provider`** — a separate package, not in the worker image at all
  (worker-daemon's runtime deps are exactly `worker-protocol` + `pino`). Untouched.
- **F5, the POSIX enrolment-path rejection.** Real and verified, but a different defect with a
  different fix. Its own ticket.

## 7. Rollback

`git revert`. The move is mechanical and the guard is additive.
