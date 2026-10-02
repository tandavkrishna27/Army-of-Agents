# AoA first-install report

Date: 2 October 2026 (Asia/Calcutta)

Source repository: [tandavkrishna27/Army-of-Agents](https://github.com/tandavkrishna27/Army-of-Agents)

Verified source commit: [`0becd281c4db611494e5694965d11da3a9eee455`](https://github.com/tandavkrishna27/Army-of-Agents/commit/0becd281c4db611494e5694965d11da3a9eee455)

## Scope

This clean-worktree check verifies the login-free local source-checkout path through first-run setup and the beginning of founder onboarding. It does not claim that a first company was created or that an AI provider completed a live task.

## Environment and steps

- Windows, Node.js 24.14.0, pnpm 9.15.4.
- Fresh Git worktree at the source commit above; no existing AoA data reused.
- Ran `pnpm install --frozen-lockfile`, then `pnpm build` to generate workspace package outputs.
- Started `pnpm aoa onboard --yes` with a temporary worktree-local data directory and loopback port 3317. Google OAuth variables and `DATABASE_URL` were unset; no provider was configured.

## Results

- Frozen dependency installation completed; the lockfile was already up to date.
- `pnpm build` completed successfully. Existing non-blocking build output included dynamic/static import and large-chunk warnings.
- The first start attempt before `pnpm build` failed because the source server imports the generated `@armyofagents/plugin-sdk/dist/index.js`. After building the workspace, the same onboarding command started successfully. The build prerequisite is now included in the README and detailed quickstart.
- CLI doctor reported 9 checks passed, including loopback-only `local_trusted`, embedded PostgreSQL, and “No LLM provider configured (optional).”
- `GET /api/health` returned HTTP 200 with `deploymentMode: local_trusted` and `deploymentExposure: private`.
- `GET /onboarding` returned HTTP 200, and the browser rendered the first onboarding step (1 of 8) without a sign-in prompt.
- `GET /api/companies` returned an empty list, as expected before completing onboarding.
- Test data, generated config, database, and logs were isolated under a temporary directory in the worktree. No existing AoA instance was modified.

## Not covered

The profile/company onboarding steps were not submitted. A real Commander or agent response was not tested because no provider CLI or credentials were configured. This smoke check is limited to dependency installation, workspace build, bootstrap/doctor, API health, and rendering the first onboarding step; it is not evidence of full onboarding completion or live agent execution.

## Provenance note

An earlier version of this report cited source commit `64f403625cc0028c616b8fcf7936a601281759a2`, which is not resolvable in the public repository. Its historical test claims are not treated as independently reproducible evidence here; this report records the narrower checks rerun against the publicly reachable commit linked above.
