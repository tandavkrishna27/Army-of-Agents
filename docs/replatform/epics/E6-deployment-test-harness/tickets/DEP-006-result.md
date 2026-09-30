# DEP-006 Result — Staging manifests and configuration contract

**Status:** `complete + CI-GREEN` — both lanes green at landed SHA `845e81811`: PR gate suite (incl. the `policy` staging-manifest check) **and** `d1-merge-train` (live `e6f-12` **5/5** on the real CI compose engine). Also proven locally (`docker compose config` needs no running stack). **LAST ticket of E6 — E6 is now COMPLETE.**
**Disposition:** `pass` (all locally-runnable gates green incl. every adversarial-review fix; live render proven with the real compose engine).
**Date opened (UTC):** `2026-08-16`
**Epic:** `E6-deployment-test-harness` (remainder; LAST DEP). **Plan task:** `DEP-006 — Staging manifests and configuration contract (program-design.md:725-731)`.
**Implementer:** `Claude subagent (general-purpose) — worktree C:\e3`. **Reviewer:** `Claude adversarial-review Workflow (5 dimensions → refute-by-default verify, 16 agents) + controller re-verification + fix round`.
**Start SHA:** `198b2b4aa` (design-doc commit).

## Acceptance model + framing

DEP-006 renders + statically/CI-validates a staging deployment and asserts the already-landed DEP-003/008/009 substrate, rather than rebuilding orchestration (the DEP-008 scope-honesty precedent). Delivered:

- **`docker-compose.staging.yml`** — additive, dormant staging render: 8 services (`migrate` one-shot + 2 control-plane + 4 workers + a new `adapter-manager`) split into two failure domains (domain-a/domain-b: 1 CP + 2 workers each; migrate + adapter shared), external DB/object-store/realtime/admission as top-level `x-external` injected pointers (no embedded services), migration-first `depends_on … service_completed_successfully`, N/N-1 `deploy.update_config`, bounded worker drain (`stop_grace_period` + `stop_signal` + a documented `com.aoa.drain-hook` label), bounded autoscaling labels, and `E2B_API_KEY` injected (rotatable) ONLY into `adapter-manager` on `provider-ctl-net`, absent everywhere else.
- **`scripts/lib/staging-manifest-invariants.mjs` + `scripts/check-staging-manifest.mjs` + `scripts/check-staging-manifest.test.mjs`** — a pure static config-contract validator mirroring `check-d1-compose`, asserting §2.1–§2.8 with a reject-clone per invariant (non-vacuity). Wired into `pr.yml`'s always-on `policy` job.
- **`tests/d1/e6f-12-staging-render.test.mjs`** — live `docker compose config` render/parity validation on `d1-merge-train` (Linux-CI; SKIPs off `AOA_D1_LIVE`).
- **Docs + crosswalk** — `docs/deploy/staging.md`, env-key coverage in `environment-variables.md`, and DEP-006 dispositions appended to CM-010/CM-012 with the CLI-001/D2 deferral. No `DE-*` threat-register edit (DEP-006 owns none); no frozen worker-protocol edit.

## Findings (adversarial review — 16 agents, 10 raw → 5 confirmed after refute-by-default; all fixed)

- **HIGH (boot/CI-blocker, reproduced live) — `x-*` label keys are Compose extension fields.** The render carried its failure-domain / autoscaling / drain metadata as `x-`-prefixed **label** keys. `docker compose config --format json` hoists ANY `x-` key (even inside a `labels:` map) into a synthetic `#extensions` field, so the labels were DROPPED from the rendered model — `e6f-12` test #3 would read `undefined` and turn the required foundation lane RED, and a real `docker compose up` would apply none of the labels. **Reproduced live** (`worker-a1.labels` rendered as `{"#extensions": "map[x-…]"}`). **Fixed:** renamed all four keys to real reverse-DNS labels (`com.aoa.failure-domain` / `com.aoa.autoscaling-min|max` / `com.aoa.drain-hook`) in the manifest + the module pins + the test corpus (now importing the pins — no hardcoded label strings); **verified live** the `com.aoa.*` keys render as real labels and `e6f-12` passes **5/5**. Added a guard test asserting no label pin is `x-`-prefixed.
- **MEDIUM — provider-control absence scanned only `environment:`.** `E2B_API_KEY` delivered via `env_file` / `secrets` / `configs` / a volume mount / `command` / `entrypoint` would bypass the boundary check while passing green (empirically proven). **Fixed:** `checkProviderControlBoundary` now, for every non-adapter service, forbids `env_file`, rejects any `secrets`/`configs`/`volumes` entry named for the provider-control credential (`/e2b|provider[-_]?c(tl|ontrol)/i` — legit worker secrets don't match), and scans `command`/`entrypoint` for the `E2B_` token. Three reject-clones added.
- **MEDIUM — `INJECTION_VALUE_RE` accepted `${VAR:-baked-literal}`.** A `${AOA_STAGING_E2B_API_KEY:-sk-real}` default resolves to the baked literal when the deploy var is unset, defeating the "rotatable, not baked" assertion. **Fixed:** tightened to the bare-var form `/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/` (rejects `:-`/`:=`/`-`/`+`) for the credential and the `x-external` pointers; the current bare `${VAR}` values still pass. Reject-clone added.
- **LOW — `checkAdmittedImageRefs` used `img.includes(token)`.** A fully hardcoded attacker ref merely embedding the token as a path component (`ghcr.io/evil/AOA_STAGING_WORKER_IMAGE@sha256:…`) passed. **Fixed:** require the interpolation-prefix form `^\$\{TOKEN(:-…)?\}`; reject-clone added.
- **LOW — `d1-merge-train` paths filter omitted the staging artifacts.** A staging-only edit would not re-run the live `e6f-12` parity proof. **Fixed:** added `docker-compose.staging.yml` + the two staging scripts to the `paths:` list. Also softened the `e6f-12` header's "static and live never diverge" claim (the test exists precisely because they *can* diverge).

## Commands (verbatim, re-run by the controller after the fixes)

| Command | Result |
|---|---|
| `node scripts/check-staging-manifest.mjs` | **OK** (exit 0) on the real manifest |
| `node --test scripts/check-staging-manifest.test.mjs` | **27/27** (21 original + 6 new reject-clones; each invariant has a non-vacuous reject) |
| `AOA_D1_LIVE=1 node --test tests/d1/e6f-12-staging-render.test.mjs` | **5/5 LIVE** (real `docker compose config`; incl. the `com.aoa.failure-domain` render that was the HIGH failure) |
| `docker compose -f docker-compose.staging.yml config --format json` | renders `com.aoa.*` as REAL labels (HIGH fix confirmed; pre-fix showed `#extensions`) |
| `node scripts/check-d1-compose.mjs` | **PASS** (d1 unaffected) |
| `git status` | no `distributed-execution-threat-*` / `packages/worker-protocol/` edits |

## Residual risk / scope-honesty

1. **No real multi-host / external-store staging bring-up.** DEP-006 renders + statically/CI-validates the manifest; the live external-store deployment is deferred to the deploy pipeline / a REL ticket (documented in `staging.md` §deferrals, not dropped).
2. **No real-E2B provider-control rotation/revocation runtime.** Contracted against DEP-008's hostile reference + deferred to CLI-001/D2 (CM-012/CM-010 co-owner); DEP-006 owns the manifest-boundary expression + absence assertions only.
3. **§2.4 "no second counter" + §2.5 protocol/metadata/log absence** are compose-layer proxies (flag + env/network shape); the runtime single-counter is DEP-009's and the log/metadata redaction is DEP-005/DEP-008's — DEP-006 asserts, not re-implements.

## Gate recommendation

`ready for independent review` — all locally-runnable gates green incl. every adversarial-review fix re-verified, and the live `e6f-12` compose-render proven with the real engine. The `d1-merge-train` live lane is DEC-03 Linux-CI authority.

## Review attempt history

| Attempt | Reviewer | Reviewed revision | Disposition | Evidence/findings |
|---:|---|---|---|---|
| 1 | Claude adversarial-review Workflow (16 agents) + controller | implementer working tree | `approved after fixes` | 10 raw → 5 confirmed (refute-by-default): HIGH `x-` label extension (reproduced live) + 2 MEDIUM provider-control gaps + 2 LOW; all fixed + re-verified; corpus 27/27; `e6f-12` 5/5 live; d1 unaffected; no forbidden edits |
