---
title: Quickstart
summary: Get AoA running in minutes
---

Get AoA running locally, then complete the guided founder setup.

## Quick Start

```sh
git clone https://github.com/tandavkrishna27/Army-of-Agents.git
cd Army-of-Agents
pnpm install
pnpm aoa onboard --yes
```

With no environment overrides, `onboard --yes` writes a loopback-only
`local_trusted` configuration that uses embedded PostgreSQL, local storage, and
local encrypted secrets, then immediately starts AoA. Keep that command running
and open the URL it prints. Use `pnpm aoa run` from the checkout later when you
want to restart an already configured instance.

The quickstart is environment-aware. Variables such as `AOA_DEPLOYMENT_MODE`,
`HOST`, `DATABASE_URL`, `AOA_PUBLIC_URL`, and the storage settings replace the
corresponding defaults, so review inherited environment variables before using
`--yes`.

> The Army of Agents CLI is not currently published to npm. The package
> unscoped `aoa` does not identify this repository, so do not use
> `npx aoa` for AoA. Until a scoped release is published
> and smoke-tested, use `pnpm aoa` from this repository.

Open [http://localhost:3100](http://localhost:3100). A new user is routed to
`/onboarding`, where AoA resumes at the first incomplete step:

1. Complete your Human Operating Profile: name, title, and timezone.
2. Name your organization.
3. Choose an absolute root folder and pass the write check.
4. Choose Claude or Codex as Commander and verify the local CLI.
5. Create your first department and its workspace folder.
6. Create and assign your first agent.
7. Review the setup and finish.

The flow saves progress after each step. If you close the browser or a check
fails, return to AoA and continue rather than creating the organization again.

## Local Development

Prerequisites: Node.js 20.3+ and pnpm 9+.

```sh
pnpm install
pnpm dev
```

This starts the API server and UI at [http://localhost:3100](http://localhost:3100).

No external database or Google account is required for this loopback development
flow. `pnpm dev` enables the local development identity when Google OAuth
credentials are absent. Do not use that identity for an authenticated or
network-exposed deployment.

## One-Command Bootstrap

```sh
pnpm aoa run
```

This auto-onboards if config is missing, runs health checks with auto-repair, and starts the server.

## Authenticated Deployment

Google is the only human sign-in provider. An authenticated deployment must set
both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`; the server refuses to start
without them. The first Google user on an empty instance becomes the instance
administrator and enters the same founder onboarding flow.

See [Authentication](/api/authentication) for the trust boundaries and
[Onboarding API](/api/onboarding) for the route contracts.

## After Setup

After the review step:

1. Add your company vision and objectives.
2. Invite human teammates or add them directly.
3. Build out the Team with more agents and departments.
4. Set budgets and assign initial tasks.

<Card title="Core Concepts" href="/start/core-concepts">
  Learn the key concepts behind AoA
</Card>

<Card title="Invite and Join" href="/guides/board-operator/inviting-and-joining">
  Bring a human teammate into the organization
</Card>
