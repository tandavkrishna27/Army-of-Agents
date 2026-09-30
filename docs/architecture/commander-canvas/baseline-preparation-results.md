# Universe — bounded source-baseline preparation results

September 12, 2026. **First attempt retained; BASE remains open.** TK authorized the published [bounded preparation batch](bounded-engineering-preparation.md) by saying “lets do it” after publication at `3431c66f2e3a262c9a7f1119acaa0aaecfdbdc2a`. This report records execution, not implementation acceptance. No Universe source changes or source-base integration occurred.

**Latest status:** TK approved the container-only correction, and the [offline retry is now complete](baseline-retry-results.md). Both revisions pass typecheck, but the same three tests and one unhandled error remain on each. The original evidence below is preserved; it is superseded by the retry for current execution status. No implementation or base adoption is authorized.

## First attempt outcome (historical)

Both exact revisions installed with the frozen lockfile and passed all five approved package prebuilds. Both recursive typechecks failed because the container had Corepack but no direct `pnpm` executable on PATH. A plugin SDK package script invokes `pnpm` itself, so invoking its parent through `corepack pnpm` was insufficient. This is an **author-owned environment setup omission**, not evidence that replatform introduced a source regression. No source fix is proposed from this result.

Following the approved stop-on-failure rule, the four Vitest shards and root build were not run on either revision. **Tests executed: 0; no pass/fail/skip count is claimed for the unrun suites.** The container was stopped after logs were retained. No command timed out. The independent [DESIGN evidence inventory](design-state-coverage.md) is complete as an inventory; visual/runtime gates remain open.

| Stage | Existing pin | Replatform candidate |
|---|---|---|
| Source | `183e46a9c65fc3105c7e3d125629276814df7dbb` | `9200a66c42633019349de937a8b97979acac0f7a` |
| Frozen install | Exit 0, 44.997 s | Exit 0, 4.986 s |
| worker-protocol build | Exit 0, 1.705 s | Exit 0, 1.747 s |
| sandbox-fake-provider build | Exit 0, 0.989 s | Exit 0, 1.126 s |
| worker-daemon build | Exit 0, 1.467 s | Exit 0, 1.699 s |
| sandbox-provider-contract build | Exit 0, 0.866 s | Exit 0, 1.470 s |
| sandbox-e2b-provider build | Exit 0, 1.209 s | Exit 0, 1.620 s |
| Recursive typecheck | Exit 1, 2.909 s; missing direct pnpm | Exit 1, 3.104 s; same failure |
| Vitest shards 1–4 | Not run: prerequisite failed | Not run: prerequisite failed |
| Root build | Not run: prerequisite failed | Not run: prerequisite failed |
| Tracked source integrity before/after setup/checks | 7,662 entries; no changes | 7,664 entries; no changes |

Per-command SHA, cwd, exact command, start time, elapsed time, exit code and timeout/signal fields are preserved in the [setup ledger](evidence/base-preparation-2026-09-12/setup-results.json) and [check ledger](evidence/base-preparation-2026-09-12/checks-results.json). Each ledger points to its same-directory `.log` file by the original container path. The [evidence manifest](evidence/base-preparation-2026-09-12/manifest.json) hashes the copied logs and integrity results. Recorded package command execution ran from 14:10:54 to 14:12:14 UTC; image pull, export and setup also completed within the 45-minute bound. Each revision's check attempt was far below 150 minutes.

## Environment and source provenance

- Docker Desktop 4.62.0, Docker Engine 29.2.1, Linux amd64, kernel `6.6.87.2-microsoft-standard-WSL2`. No tests ran directly in Docker Desktop's internal WSL distribution.
- Resolved `node:24-bookworm` index digest: `sha256:6dac556d980b7f0e5498d08f08cee0ca67798b4ad6c23964a9214920e67758d0`.
- Executed Linux amd64 image: `node@sha256:b977d0f785d96029d8d4c0790b6bf1c2a4c72e0f26319808e7ba2e9d966a1ac3`; Debian 12 Bookworm, Node `v24.21.0`, Corepack `0.36.0`, pnpm `9.15.4`.
- Separate `git archive` snapshots at `/workspace/base` and `/workspace/candidate`, populated from the exact Git objects rather than the host working tree. Base tar SHA-256: `317e84ec5eeec569ce3a25bb564d7a2bc4254552da2415e52e65d30ec1bc479e`; candidate tar: `5549f56428432232377b02c9198ca7b0f3f43c2c1108ddaf8518704ac1b251dd`.
- Per-entry manifests checked file bytes and symbolic-link targets against those archives before and after each phase. No tracked file changed. Generated dist and dependency directories were confined to the disposable volume. Archives do not supply Git metadata; any future test depending on a checkout's `.git` must be attributed as an environment limitation, not silently repaired.
- Task resource name: `universe-preparation-e9637db9` for the stopped container and retained volume. Root was used only to initialize ownership of this new empty volume; source extraction, package installation, prebuilds and typechecks ran as UID/GID 1000. No host repository, Docker socket, user home, credentials or live database was mounted.
- Child commands used allowlisted PATH, fresh HOME/Corepack/cache/AoA directories, CI and locale. No DATABASE_URL or provider credentials were supplied. Both installations shared the isolated package cache, explaining the faster second install; node_modules and source snapshots were separate.
- Package download access existed only during setup. `docker network disconnect bridge universe-preparation-e9637db9` completed before checks; network inspection returned `{}` before checks and again before stop. No external network was re-enabled after failure.
- Source contains only tracked `.env.example` templates at the inspected env-file paths. No personal `.env`, CLI login, browser profile, SSH agent or secret directory was copied. No provider calls, paid compute, app server, external DB, migration or premature-draft test occurred.

Local archives, per-entry manifests and the orchestration script are retained in `C:/Users/TK/AppData/Local/Temp/universe-preparation-e9637db9a984480e8382feca62ead552`. The portable logs/results above are the published evidence; temporary local resources are not a permanent acceptance record.

## Failure diagnosis and limits

[Base typecheck](evidence/base-preparation-2026-09-12/base-typecheck.log) and [candidate typecheck](evidence/base-preparation-2026-09-12/candidate-typecheck.log) both report:

```text
packages/plugins/sdk typecheck$ pnpm --filter @armyofagents/shared build && tsc --noEmit
packages/plugins/sdk typecheck: sh: 1: pnpm: not found
ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL
spawn ENOENT
```

Read-only diagnosis confirmed `/usr/local/bin/corepack` exists and the pinned pnpm entrypoint is cached at `/workspace/home/corepack/v1/pnpm/9.15.4/bin/pnpm.cjs`, while `command -v pnpm` returned no path. `packages/plugins/sdk/package.json` has that direct pnpm call at both revisions. A few preceding packages printed “Done”; this is not a full workspace typecheck pass.

Install also warned that workspace executable links for not-yet-built plugin SDK and worker-daemon dist files could not be created. Install still exited 0. Those warnings are retained; the approved prebuilds do not establish every CLI link is now usable, and no extra linking/install retry was performed.

The newer candidate changes worker-admission audit/control paths, not this missing executable setup. With the same environment failure on both revisions, **candidate-only source failures are undetermined**, and no clean baseline claim or candidate adoption recommendation is justified. The existing source pin remains unchanged. BASE qualification must be resumed before presenting it as ready for implementation.

## Original environment correction proposal (subsequently approved and executed)

The approved proposal says: “Failure permits diagnosis and reporting, not source/dependency fixes, wider commands or unlimited retries.” The first attempt therefore stopped at that boundary; TK subsequently approved this exact correction. See the linked retry for its outcome. The next narrow batch would create the Corepack shim inside the same disposable user's home and include it in child PATH:

```sh
mkdir -p /workspace/home/bin
corepack enable --install-directory /workspace/home/bin pnpm
export PATH="/workspace/home/bin:$PATH"
cd /workspace/base
pnpm --version
cd /workspace/candidate
pnpm --version
```

Use the same immutable image, cached pnpm 9.15.4, source SHAs and disconnected network. Restart only this stopped task container; no new package downloads, installs, source edits, dependency updates, live services or host modification. Verify source integrity again, preserve the original logs, and run one additional attempt of the existing five prebuilds, recursive typecheck, four Vitest shards and root build in the approved dependency order. The prebuild rerun establishes the corrected environment consistently for both snapshots. Require `pnpm --version` to equal 9.15.4; no automatic alternate version. Allow at most 10 minutes for shim setup and 150 minutes per revision for checks. A new setup/prebuild/typecheck failure stops dependent work and is reported; independent shard results are retained if reached, and any failed shard blocks build. No further corrective retry is implicitly authorized.

This is an environment-only correction proposal for TK's scope approval. It does not change the source-base decision or authorize E1.1. After evidence, propose any base integration and the first coding batch separately. No new product choice is required by this environment failure.
