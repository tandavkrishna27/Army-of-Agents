---
title: Quickstart
summary: Run Army of Agents locally and complete founder onboarding
---

This tutorial gets Army of Agents running on your machine, creates the first company, and brings you to the Home screen.

## Prerequisites

- Node.js 20.3 or newer
- pnpm 9 or newer
- Git
- Optional: a local agent CLI such as Claude Code or OpenAI Codex if you want Commander or agents to run immediately

<Info>
  You do not need to create a PostgreSQL database for the default local flow. Army of Agents uses embedded PostgreSQL when `DATABASE_URL` is unset.
</Info>

## 1. Clone and install

<Steps>
  <Step title="Clone the repository">

```sh
git clone https://github.com/tandavkrishna27/Army-of-Agents.git
cd Army-of-Agents
```

  </Step>
  <Step title="Install dependencies">

```sh
pnpm install
```

  </Step>
</Steps>

## 2. Start the local instance

For the fastest first run, use the CLI bootstrap:

```sh
pnpm aoa onboard --yes
```

With no environment overrides, this writes a loopback-only `local_trusted` configuration, uses embedded PostgreSQL, stores files locally, stores secrets locally in encrypted form, and starts the app.

Keep the command running and open the URL it prints. The default URL is:

```txt
http://localhost:3100
```

If you already configured the instance earlier, restart it with:

```sh
pnpm aoa run
```

## 3. Complete founder onboarding

A new user is routed to `/onboarding`. The flow resumes at the first incomplete step, so it is safe to refresh the browser or fix a failed check and continue.

<Steps>
  <Step title="Create your human profile">
    Enter your name, title, and timezone. This becomes the initial operator identity.
  </Step>
  <Step title="Name the company">
    Create the first company workspace. One Army of Agents instance can contain multiple companies.
  </Step>
  <Step title="Choose the company root folder">
    Pick an absolute folder path and let Army of Agents verify write access.
  </Step>
  <Step title="Configure Commander">
    Choose a supported Commander runtime and complete the local CLI verification if you want Commander available immediately.
  </Step>
  <Step title="Create the first department">
    Add a department and choose its workspace folder.
  </Step>
  <Step title="Create the first agent">
    Add an agent, select an adapter, and assign it to the department.
  </Step>
  <Step title="Review and finish">
    Confirm the setup summary and enter the product.
  </Step>
</Steps>

## 4. Verify the app is healthy

In another terminal, run:

```sh
curl http://localhost:3100/api/health
curl http://localhost:3100/api/companies
```

The health endpoint should return a successful response from the API. The companies endpoint should show the company you created after onboarding.

## Local development command

If you want the normal developer process instead of the one-command bootstrap, run:

```sh
pnpm dev
```

This starts the API and UI at [http://localhost:3100](http://localhost:3100). When Google OAuth credentials are absent, the loopback development identity is enabled for local use.

<Warning>
  Do not expose the local development identity to a network. Authenticated or public deployments must configure real authentication.
</Warning>

## Environment overrides

The quickstart respects inherited environment variables. Review your shell before using `--yes` if you have set values such as:

- `AOA_DEPLOYMENT_MODE`
- `HOST`
- `DATABASE_URL`
- `AOA_PUBLIC_URL`
- storage or secrets variables

## Troubleshooting

<AccordionGroup>
  <Accordion title="pnpm is missing">
    Install pnpm 9 or newer, then re-run `pnpm install`.
  </Accordion>
  <Accordion title="Port 3100 is already in use">
    Stop the other process or set a different host or port configuration before starting Army of Agents.
  </Accordion>
  <Accordion title="The database looks stale during local testing">
    Stop the app, remove the default local database folder, and start again: `rm -rf ~/.aoa/instances/default/db && pnpm dev`.
  </Accordion>
  <Accordion title="Commander CLI verification fails">
    Confirm the selected local CLI is installed and authenticated outside Army of Agents, then retry the verification step.
  </Accordion>
</AccordionGroup>

## Next steps

<CardGroup cols={2}>
  <Card title="First agent run" href="/start/first-agent-run">
    Create a task, wake an agent, and inspect the result.
  </Card>
  <Card title="Core concepts" href="/start/core-concepts">
    Learn the vocabulary behind Companies, Team, Commander, Crew, Tasks, Discussions, and Memory.
  </Card>
</CardGroup>
