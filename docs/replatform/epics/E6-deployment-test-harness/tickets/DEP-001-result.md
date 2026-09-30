# DEP-001 Result — Separate signed least-privilege images + fail-closed admission

**Status:** `complete` (local + static; live container build/smoke deferred to final CI)
**Disposition:** `pass` (logic + posture locally verified; `docker build` / startup-smoke are Linux-CI-only, currently billing-blocked)
**Date opened (UTC):** `2026-08-13`
**Epic:** `E6-deployment-test-harness` (partial: `E6-D1-FOUNDATION`)
**Plan task:** `DEP-001 — Separate signed least-privilege images (E6 §2.2)`
**Implementer:** `Claude subagent (opus) — worktree C:\e3`
**Reviewer:** `Claude adversarial-review Workflow (4 dimensions → dedup → refute-by-default verify; 6 agents) + fix-round verification`
**Start SHA:** `aff1b11c5` (DEP-000 commit)

## Acceptance model + CI caveat

The multi-agent adversarial-review Workflow is the independent check. It returned **2 confirmed
findings (0 blocking, 1 should-fix, 1 nit)** — the two highest-stakes dimensions (fail-closed
admission; worker-image least-privilege) came back **clean**. The `docker build`, image-contents,
and startup-smoke tests are Linux/CI-only and currently **blocked by the org GitHub Actions
billing outage**; they are honestly gated behind `AOA_DEP001_IMAGE_TEST=1` and skip locally. The
pure admission logic, deps-stage parity, and static Dockerfile posture are fully Windows-local
verified.

## Scope

- **`docker/control-plane/Dockerfile`** — server + UI only, built as a full closure then reduced
  to a pruned `pnpm --filter @armyofagents/server deploy --prod` output (`/cp-app`: server dist +
  production node_modules) plus the built UI at `/cp-app/ui-dist` (served via
  `server/src/app.ts` `uiDistCandidates → ../ui-dist`). NO docker-cli, worker-daemon, or agent
  CLIs. Non-root, read-only root, base pinned by digest, HEALTHCHECK → /api/health, OCI revision
  label.
- **`docker/worker/Dockerfile`** — `packages/worker-daemon` only via `pnpm deploy --prod`; dep
  closure EXACTLY worker-daemon + worker-protocol + pino (zod transitive) per **E4-D01** — no
  server/db/ui/shared/drizzle/adapter-utils. Non-root, read-only root, digest-pinned, local
  health/metrics only.
- **Supply chain (test roots):** `docker/images/{build.sh, sbom.sh, sign.sh, provenance.sh,
  allowlist.json}`. `sign.sh` signs the canonical simple-signing payload (binding digest + source
  revision) with a test ECDSA-P256 key.
- **Admission (security core):** `scripts/lib/image-admission.mjs` (+ `verify-image-admission.mjs`
  wrapper) — fail-closed: a single admit point reached only after signature (vs pinned trust
  root), allowlist-membership, and provenance checks all pass; a corrupt PEM/signature is caught →
  reject, never a crash/bypass. `allowlist.json` empty ⇒ admits nothing.
- **Deps-stage parity:** `scripts/check-image-deps-stages.mjs` extends the deps-stage gate to both
  new Dockerfiles. **pr.yml** gains 3 `policy` steps (split-image parity + admission test + static
  Dockerfile test); the existing combined-Dockerfile check is untouched.
- **Base digest:** real `node:lts-trixie-slim@sha256:0711b541…` multi-arch index digest (resolved
  + cross-verified from Docker Hub 2026-08-13), commented resolve-at-build.

## Independent adversarial review + fix round (2 confirmed, both fixed; security core clean)

The **admission fail-closed** and **worker-image least-privilege** dimensions found **no defect**
(no path admits an unsigned/tampered/non-allowlisted/replayed digest; the worker image copies only
the `pnpm deploy --prod` output, no server/db leak).

- **SHOULD-FIX — control-plane image shipped the whole monorepo source, and the exclusion test was
  vacuous.** The old `COPY . .` → `COPY --from=build /app /app` (no prune) baked worker-daemon/cli/
  adapter SOURCE into the "server+UI only" image; the static exclusion test only grepped the
  Dockerfile TEXT (which `COPY . .` never spells) so it passed vacuously. (Inert bloat, not a
  runnable escalation — source is uncompiled + absent from node_modules.) **Fixed:** production
  stage now copies ONLY `/cp-app` (pruned server deploy) + `/cp-app/ui-dist`; no whole-tree copy.
  `dockerfile-static.test.mjs` strengthened to FORBID any `COPY --from=build /app …` in the
  production stage, with a baked-in RED-proof fixture (non-vacuous). Proven RED against the old
  Dockerfile → GREEN after (25 static tests).
- **NIT — `sign.sh` cosign branch produced an openssl-unsignable key** (aborted fail-closed, images
  silently never sign when cosign present). **Fixed:** dropped the cosign branch; always the
  deterministic openssl ECDSA-P256 path (the tested producer); the canonical payload + verifier
  are unchanged, round-trip re-confirmed (admission 22/22).

## Operator-directed Windows-local evidence (from `C:\e3`; Docker build = Linux CI, billing-blocked)

| Lane | Result |
|---|---|
| `node --test scripts/lib/__tests__/image-admission.test.mjs` (fail-closed admission) | PASS — **22/22** (non-vacuous: sabotaging the signature guards reddens exactly the signature-dependent tests) |
| `node --test docker/images/__tests__/dockerfile-static.test.mjs` (posture + non-vacuous exclusion) | PASS — **25/25** (digest-pin, non-root, read-only, HEALTHCHECK, OCI label, no whole-tree copy) |
| `node --test scripts/check-image-deps-stages.test.mjs` + `node scripts/check-image-deps-stages.mjs` | PASS — 8/8 + parity PASS |
| `scripts/verify-image-admission.mjs` CLI (admit / tampered / unsigned / missing) | PASS — admit exit 0; all reject paths exit 1 |
| `pnpm check:frozen-worker-protocol-v1 -- --source-sha b7a842870…` | PASS — zero changed worker-protocol files |
| **DEFERRED to CI** (`docker build` via `docker/images/build.sh`, `image-contents.test.mjs`, `image-startup-smoke.test.mjs`) | SKIP locally (no Docker; gated by `AOA_DEP001_IMAGE_TEST=1`) — **honestly not run** |

## Decision

DEP-001 is `complete`/`pass` for its locally-verifiable surface: fail-closed admission, both
Dockerfiles' least-privilege structure + static posture, deps-stage parity, and the supply-chain
producer↔verifier payload agreement. The actual container build + startup-smoke are the only
DEFERRED items (Linux/CI, billing-blocked) — not faked. Next: **DEP-002** (isolated D1 compose
topology) — compose structure locally lintable; live startup = CI.

> **AMENDED by Blocker B (Unit 1).** The worker image closure is no longer two packages.
> `worker-networked-host` — DEP-011 Slice 2b's CONTAINER boot root — was given an image home,
> so the closure is now SEVEN: worker-daemon, worker-protocol, worker-networked-host,
> provider-wire, provider-capability, sandbox-e2b-provider, sandbox-provider-contract. The
> `e2b` SDK is therefore inside the image too (`provider-wire` VALUE-imports
> `sandbox-e2b-provider/errors.js`), verified present at
> `/worker-net-app/node_modules/.pnpm/node_modules/e2b` on the built image. That is
> structurally safe — the container worker holds no E2B key and never constructs an E2B
> transport; the real one lives in the adapter-manager — but the "exactly two packages"
> statement was FALSE once the bin shipped, and a false closure claim is worse than a wider
> true one. E4-D01's real invariant is untouched: `worker-daemon` still imports no provider
> (`check-worker-daemon-boundary.mjs` is byte-unchanged), the networked driver lives OUTSIDE
> it, and the two `pnpm deploy` trees are separate so nothing reaches the daemon's own
> `node_modules` (asserted: `/worker-app` has no `sandbox-e2b-provider`).
