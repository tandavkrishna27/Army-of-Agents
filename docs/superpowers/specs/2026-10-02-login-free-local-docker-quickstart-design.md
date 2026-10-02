# Login-Free Local Docker Quickstart — Design

**Status:** Draft for founder review
**Date:** 2026-10-02

## Goal

Give a newcomer a repeatable Docker Compose path to try AoA locally without an AoA account or Google OAuth setup, while preserving the existing authenticated Docker deployment defaults.

## Approved product intent

- This is a **single-user local trial**, not a shared or remotely hosted deployment.
- “Login-free” means no AoA/Google human sign-in. It does not provide a Codex or Claude subscription; the user must still select and authenticate their own provider in onboarding to run agents.
- The supported host targets are Windows with Docker Desktop (Linux containers, typically WSL 2), macOS with Docker Desktop, and Linux with Docker Engine/Compose where practical. This is not an iOS/iPadOS target.
- The default authenticated Docker deployment must not silently become login-free.
- The first run should not require a manually provisioned Google OAuth client, external PostgreSQL server, or edits to a secrets file.

## Proposed user experience

From a checked-out AoA repository, the user runs:

```sh
docker compose -f docker-compose.local.yml up --build
```

The image builds locally, Compose starts the app, and the user opens `http://127.0.0.1:3100` (or the documented configured local port) to reach `/onboarding`. The app uses embedded PostgreSQL and persists its AoA home in a dedicated Compose-managed volume. Stopping with `docker compose -f docker-compose.local.yml down` preserves that data; removing the volume is a separate, explicitly destructive reset action.

The README should feature this as the Docker local-trial option and keep source/developer setup separate. First build requires internet access for image layers and package installation. It may take materially longer than later starts.

## Deployment and trust design

Add a new `docker-compose.local.yml`; do not change `docker-compose.yml` or `docker-compose.quickstart.yml` defaults. The new service must explicitly configure:

- `AOA_DEPLOYMENT_MODE=local_trusted` and `AOA_DEPLOYMENT_EXPOSURE=private`.
- `AOA_DEV_LOCAL_IDENTITY=1`, the explicit local identity permitted by the locked onboarding/auth decision for loopback-only local quickstarts. This is not a multi-user or remote deployment setting.
- `AOA_INSTALL_PROFILE=local_single_user`, which is essential: the existing Compose default is `hosted_multi_tenant`, where provider subscription sign-in is disabled. Keep topology axes consistent with this profile if they are set explicitly: local network location, single-user trust boundary, and user-hosted execution ownership.
- The AoA server listener bound to `127.0.0.1` inside the container. Since Docker port forwarding cannot reach that listener directly, a small in-container TCP relay forwards the published port to the loopback listener. Publish the host port specifically on `127.0.0.1`, not `0.0.0.0`, and do not make the bind address externally configurable in this local-trust file.
- A distinct named volume for `/aoa`, so the local-trust trial cannot silently reuse authenticated deployment data. Use Compose project scoping so separate checkout directories naturally get separate volumes.
- Embedded PostgreSQL (leave `DATABASE_URL` unset) and the image’s bundled Codex/Claude CLIs.

The relay is transport only; it does not authenticate requests. The security boundary is a trusted, single-user machine and a host port published only on loopback. The documentation must plainly warn users not to expose the trial to a LAN/public interface, put it behind a shared reverse proxy, or attach untrusted containers to its Compose network. A person with access to the host’s Docker daemon is within this local trust boundary.

This follows the repository’s locked decision that human identity is Google-only outside the loopback trust boundary and that a loopback `local_trusted` quickstart may use the explicit local development identity. It also preserves the server’s startup invariant that `local_trusted` itself binds to a loopback address.

## Onboarding and provider behavior

- The app opens directly to the existing resumable onboarding route without Google OAuth credentials.
- Onboarding remains forward-only and requires Commander provider selection and tooling verification; this design does not add a skip path.
- With the local single-user topology, provider subscription login capability should be available in the existing onboarding UI (Codex device sign-in and Claude’s supported code-paste flow). Provider authentication remains the user’s responsibility and is stored under the persistent `/aoa` volume.
- “Docker started” is not represented as “agent is ready”: Compose health means the app is serving, while onboarding/provider verification determines whether Commander can run.
- Provider sign-in and a real provider-backed Commander response are distinct acceptance checks. The latter requires valid user-owned provider credentials and must not be faked as a successful live run.

## Compatibility and non-goals

- Existing `docker-compose.yml` and `docker-compose.quickstart.yml` remain authenticated and continue to require Google OAuth as documented.
- No Google OAuth broker, shared client secret, hosted login service, or AoA user-account system is introduced. AoA does not supply a provider subscription or provider secret; the user-owned provider login flows already present in onboarding remain available.
- No LAN/multi-user access, production Docker deployment redesign, published-image distribution, or provider credential provisioning is included.
- No change to the non-skippable provider choice/verification behavior in onboarding.

## Error handling and lifecycle

- Missing Docker/Compose, an unavailable Docker daemon, or a port collision must have actionable documented troubleshooting. A conflicting port may be changed without changing the host bind from loopback.
- The health check must probe the actual app listener inside the container, not infer health solely from the relay being open.
- Compose must start without Google OAuth variables and must not log generated secrets or provider credentials.
- First-run initialization and a container restart must preserve the same local operator identity, onboarding state, database, and provider auth files through the dedicated volume.
- `down` preserves data. Documentation for `down -v` must explicitly say it permanently removes the local trial data.
- An authenticated-mode negative regression check must continue to demonstrate that absent Google credentials do not accidentally produce an unauthenticated authenticated-mode server.

## Verification and acceptance criteria

1. `docker compose -f docker-compose.local.yml config` succeeds with no `.env` file and resolves the host publish address to `127.0.0.1`; the server remains configured for `HOST=127.0.0.1`, `local_trusted`, and `local_single_user`.
2. The real local Compose image builds and starts with Google OAuth variables absent; its health endpoint reports `local_trusted`, and the browser reaches `/onboarding` without an AoA/Google sign-in screen.
3. The Compose configuration has a dedicated persistent volume and a host-port override that does not permit changing the published host interface away from loopback.
4. The local onboarding UI reports Codex/Claude subscription sign-in capability under the configured topology. Exercise at least the Codex device sign-in completion path when valid user credentials are available; otherwise report the live-provider portion as environment-limited and still cover its flow with existing/added automated tests.
5. Stop and restart the local stack; verify onboarding/company state and provider auth state persist. Verify `down` does not delete the volume.
6. Confirm the existing authenticated Compose configuration is unchanged and its server still fails closed without Google credentials.
7. Verify platform assumptions on Windows Docker Desktop/WSL2, macOS Docker Desktop (Apple silicon and Intel where available), and Linux Compose. Run actual container smoke tests on available platforms; if a macOS Docker runtime is unavailable in this task environment, do not claim a live Mac test—provide the exact Mac smoke procedure and report that limitation.
8. Run the repository’s targeted tests, typechecks/build as affected, Compose config validation, and the real Docker smoke test on this Windows host if its Docker daemon is available.

## Known risks and questions for implementation

- The local-trial container is intentionally unauthenticated to its trusted local operator. A host bind-address regression would expose full control; keep both a configuration assertion and an actual Docker-publish inspection in the smoke test.
- The app listener/relay split must have predictable startup, health, signal handling, and shutdown behavior on the Linux container runtime used by both Docker Desktop and Linux Engine.
- Windows/macOS bind-mount semantics can vary; use a Compose-managed named volume for `/aoa`, not a host-path bind mount, unless implementation evidence requires otherwise.
- Existing `docker-compose.quickstart.yml` already has a different authenticated quickstart. Keep naming and README wording unambiguous so users can distinguish local trial from authenticated/shared deployment.
- The README quickstart PR is separate and currently has uncommitted edits in another worktree. Resolve integration/rebase deliberately; do not copy or overwrite those edits.

## Repository references

- `docs/architecture/decisions.md`, “Onboarding And Multi-User Supersession”: Google-only identity outside loopback; loopback `local_trusted` quickstart may use explicit local development identity.
- `docker-compose.yml` and `docker-compose.quickstart.yml`: current authenticated defaults and `0.0.0.0` host-port publishing.
- `server/src/index.ts`: loopback bind and private-exposure invariants for `local_trusted`.
- `server/src/auth/better-auth.ts` and `server/src/middleware/auth.ts`: local identity gate and synthetic local-board operator.
- `server/src/services/cli-auth-topology.ts`: install-profile consistency and provider subscription sign-in capability.
- `scripts/docker-onboard-smoke.sh` and `Dockerfile.onboard-smoke`: existing local-trusted Docker proof of concept using a loopback relay and explicit local identity.
- `docs/deploy/docker.md`: current authenticated Docker docs and keyless-trial limitation to be updated after design approval.
