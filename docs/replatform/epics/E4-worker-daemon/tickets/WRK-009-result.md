# WRK-009 Result — stop shipping the success fabricator in the worker image

**Status:** LANDED. Spike step 0.
**Epic:** `E4-worker-daemon`. **Start SHA:** `a9c59efc8` ([`WRK-009-design.md`](./WRK-009-design.md)).
**Terrain:** [`SPIKE-worker-walking-skeleton.md`](../../../SPIKE-worker-walking-skeleton.md) §F6-F9.

---

## 1. What landed

`createFakeSandboxProvider` no longer exists in the worker daemon's production source tree, is no
longer re-exported from the public barrel, and no longer ships in the worker image. It now lives in
`src/__tests__/support/` beside every other double in the package, where `tsconfig.json`'s exclude
keeps it out of the emitted `dist/`.

**But the move alone did not fix it, and that is the substance of this ticket.** Two further defects
stood between "the file is gone from source" and "the file is gone from the artifact", and a third
meant the guard proving either would never have run.

## 2. Acceptance

| Clause | Artifact | State |
|---|---|---|
| No test double in the worker image | `image-contents.test.mjs`, run against the built image | ✅ |
| The assertion can fail | run against the pre-move image → `AssertionError: no fake/test-double provider` | ✅ fail-first proven |
| Not exported from the barrel | `src/index.ts` re-export + type block removed | ✅ |
| No regression | 118 test files / **669 tests** pass from the new import path | ✅ |
| E4-D01 boundary intact | `check-worker-daemon-boundary.mjs` | ✅ |
| **The guard actually runs** | wired into `d1-merge-train.yml` after `build.sh` | ✅ **new — see §3** |
| Images reproducible from source | `**/dist` excluded from the build context | ✅ **new — see §3** |

Guards: `check-worker-daemon-boundary`, `check-guard-inventory`, `check-dependency-graph`,
`check-d1-compose`, `check-ci-lanes` — all pass. Image assertions **4/4 against real built images**.

## ★ 3. The move did not work, and chasing why produced the real findings

**3.1 — The images were not reproducible from source (spike F7).** After the move, a full rebuild
still contained `/worker-app/dist/supervisor/fake-provider.js`. `.dockerignore` excluded
`node_modules` but never `dist`, so `COPY packages/worker-daemon/ packages/worker-daemon/` carried
the developer's local `dist/` into the build, and `tsc` wrote into that same directory without
removing outputs whose source was gone.

The specific bug is that a moved file kept shipping. The general one is worse: **every image
depended on whatever `dist/` happened to be on the machine that built it.** CI escapes it only
because its tree starts clean — which is also why CI could never have caught it.

Verified safe before changing: every Dockerfile compiles its own `dist` inside the image
(`RUN pnpm build` / `RUN tsc`), and `COPY --from=build` copies between *stages*, which
`.dockerignore` does not affect. Build context measured **403 MB → 19.5 kB**.

This is the second instance today of a build output surviving a rebuild (F4 was `dist/migrations`).
Two in one day is a pattern.

**3.2 — The guard would never have run (spike F8).** `image-contents.test.mjs` had **no CI
invocation anywhere**. `pr.yml:390` runs only the static Dockerfile checks and says the built-image
lane "is wired by DEP-004's image lane" — which does not exist. So the design's §4 reasoning
("the guard goes there because that file already makes least-privilege assertions against the built
images") checked that the file's *content* was apt and never that the file *runs*.

Now invoked in `d1-merge-train.yml` immediately after `build.sh` — the only place in the repo with
both a Docker daemon and both images built.

**3.3 — A latent crash proved 3.2, rather than an absence of evidence.** `build.sh:52` emits
`${name^^}_IMAGE`; bash `^^` uppercases but does not translate the hyphen, so the file records
`CONTROL-PLANE_IMAGE`. Both image test files parsed with `/^([A-Z_]+)=(.*)$/`, which does not match a
hyphen — the line was dropped and every control-plane assertion ran `docker run undefined:latest`.
**Had that lane ever executed with Docker present, it would have hard-failed the first time.**

Fixed in the **consumer**, deliberately: `d1-merge-train.yml` greps `^CONTROL-PLANE_IMAGE=` to point
compose at the built tags, so "correcting" `build.sh` to emit an underscore would have silently
broken D1 bring-up — a worse failure than the one being repaired.

Two control-plane assertions that had never executed now run and pass.

## ★ 4. One of my own assertions was wrong, in the direction that gets guards deleted

The first draft asserted no `__tests__` path anywhere under `/worker-app` — and failed, on
`node_modules/.pnpm/zod@3.24.2/.../lib/__tests__/Mocker.js`. **Third-party packages legitimately ship
their own test directories**, which we neither control nor execute.

A guard that fails for a reason it was not written for is not a stricter guard; it is one the next
person deletes, taking the real assertion with it. Now scoped to `/worker-app/dist` — our own emitted
output — with the reasoning recorded inline.

The sibling `fake-provider` assertion is deliberately left **unscoped**: that one is about a
fabricating provider reaching the image by *any* route, including `packages/sandbox-fake-provider`
arriving as a dependency into `node_modules`.

## 5. Deliberately NOT in this push

- **`image-startup-smoke.test.mjs` stays un-wired (spike F9).** Its parser is fixed (same one-line
  defect) but its worker case mounts `--tmpfs /worker`, landing a root-owned tmpfs over the
  Dockerfile's `chown node:node /worker`, so the non-root daemon dies with `mkdir: cannot create
  directory '/worker/tmp'`. **A defect in the test, not the image** — D1 uses a named volume, which
  inherits image ownership. Wiring it red would assert the worker image is broken when it is not.
  The reason is recorded in both files. Own ticket.
- **Extending `check-guard-inventory.mjs` to cover test files.** F8 evaded the standing guard built
  for exactly this failure class, because that guard scans only `scripts/check-*.mjs` and
  `verify-*.mjs`. The defect lived in the blind spot of its own detector. Real, and its own ticket —
  widening a guard's scope deserves its own fail-first proof.
- **Adding `packages/worker-daemon/**` to the D1 trigger paths.** A known limitation, stated rather
  than hidden: on this long-lived integration branch the D1 lane fires on `docker/**` (which now
  covers the guard) and on `.dockerignore` (added here), but NOT on the daemon source path where the
  fabricator would actually return. The `merge_group` trigger carries no paths filter, so the guard
  does run before anything reaches main — but on-branch pushes touching only daemon source will not
  exercise it. Widening a heavy live lane is an Integration Gate Owner cost decision, not mine to
  make silently.
- **The refusing default provider.** Unchanged from the design: it would be production code with no
  caller until something composes the loop. `supervisor.ts:285-296` already turns a create-throw into
  a durable `terminal{status:"failed"}`, so a composition given no provider fails loudly today.

## 6. What this does not claim

The fabricator had **no production constructor** — this closed a loaded footgun in a shipped
artifact, not a live vulnerability. It matters because it is the only `SandboxProvider` the daemon
can import under E4-D01, and because a fabricated success is byte-identical to a real one on every
other gate.

**Nothing in this ticket makes a worker execute anything.** F1 (no identity mechanism in the
container) and F5 (POSIX enrolment paths rejected outright) both still stand, and both sit ahead of
execution on the same hop.
