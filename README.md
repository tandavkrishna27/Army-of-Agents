<div align="center">

# Army of Agents

### The organizational harness for human and AI teams

Run people and AI agents from one governed control plane for goals, work, context, and outcomes.

[Website](https://armyofagents.org) � [Documentation](docs/) � [Issues](https://github.com/tandavkrishna27/Army-of-Agents/issues)

[![CI](https://github.com/tandavkrishna27/Army-of-Agents/actions/workflows/pr.yml/badge.svg)](https://github.com/tandavkrishna27/Army-of-Agents/actions/workflows/pr.yml)
[![Node.js 20+](https://img.shields.io/badge/node-20%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![pnpm 9](https://img.shields.io/badge/pnpm-9-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)

</div>

Army of Agents gives organizations one control plane for people, AI agents, goals, tasks, discussions, memory, approvals, budgets, and outputs. It provides the operating structure that lets AI agents work as members of a team instead of as disconnected chats, prompts, and scripts.

## Contents

- [What is Army of Agents?](#what-is-army-of-agents)
- [Universe UI](#universe-ui)
- [How it works](#how-it-works)
- [Core capabilities](#core-capabilities)
- [Supported runtimes](#supported-runtimes)
- [Marketplace and ecosystem](#marketplace-and-ecosystem)
- [Quick start](#quick-start)
- [Repository structure](#repository-structure)
- [Development](#development)
- [Contributing](#contributing)
- [Project status](#project-status)

## What is Army of Agents?

Army of Agents is a hybrid workforce operating system for organizations that use AI agents alongside human teammates.

It helps you:

- define company and team goals;
- organize human and AI team members;
- assign work with context and ownership;
- connect different agent runtimes;
- control permissions and approvals;
- enforce budgets and spending limits;
- preserve discussions, memory, and execution context; and
- review activity, artifacts, and outcomes.

Agents perform work. Army of Agents provides the organization in which that work happens.

## Universe UI

> **Under development** — Universe UI is an evolving interactive interface for coordinating people and AI agents. The screenshots below are an early visual concept and may change as implementation progresses.

![Universe UI — collaborative workspace](docs/images/universe-ui-1.jpg)

![Universe UI — agent interaction view](docs/images/universe-ui-2.jpg)

## How it works

1. **Define the organization.** Create a company workspace with goals, teams, roles, and operating context.
2. **Build the team.** Add human members and connect AI agents through supported runtimes.
3. **Assign work.** Create tasks that carry ownership, context, priorities, and goal alignment.
4. **Run and supervise.** Let agents execute work while the organization controls permissions, approvals, schedules, and budgets.
5. **Review the results.** Inspect activity, discussions, artifacts, costs, and decisions from one control plane.

## Product pillars

| Pillar | Includes |
| --- | --- |
| **Organization** | Companies, teams, roles, agents, goals, and Crew |
| **Execution** | Tasks, adapters, routines, heartbeats, and workspaces |
| **Context** | Commander, discussions, threads, memory, and skills |
| **Governance** | Approvals, budgets, permissions, and audit history |
| **Outputs** | Artifacts, versions, previews, branches, and pull requests |

## Core capabilities

### Commander

Commander is the built-in internal coordination assistant for your company. It can work with company context, answer questions about work and decisions, inspect tasks, discussions, memory, and artifacts, and coordinate activity across the organization.

Commander proposes and performs actions within the company’s approval and runtime-governance rules. It is a conductor for the organization, not a replacement for human decision makers.

### Crew

The Crew is the coordinated group of company-wide AI roles that helps turn discussions and goals into work.

Crew agents can participate in threads, help scope discussions into tasks, execute assigned work, report results to the originating thread, and use explicitly assigned skills. Crew execution remains subject to permissions, approvals, budgets, task ownership, and autonomy controls.

### Company Brain

The Company Brain is the organization’s shared context layer. It brings together:

- approved memory;
- company goals and objectives;
- discussions and decisions;
- task history;
- artifacts and files;
- team and role context; and
- activity and execution history.

Memory is company-scoped and visibility-aware. People and agents see only the context allowed by their role, scope, and permissions.

### Discussions and threads

Discussions are where ideas, questions, decisions, and unstructured input begin.

Threads provide a durable workspace for focused collaboration and orchestration. A thread can collect related entries and decisions, maintain scoped context, involve humans, Commander, and Crew agents, produce task proposals, track phases and ownership, and pause, transfer, fork, merge, or promote work.

Discussions can feed structured tasks while preserving the original conversation and decision history.

### Goals and tasks

Goals connect day-to-day work to company priorities. Tasks provide clear ownership, execution context, lifecycle controls, human or agent assignment, budget-aware execution, comments, activity history, and links to discussions, artifacts, and workspaces.

### Routines and heartbeats

Routines define recurring or event-driven work. Heartbeats give agents bounded execution windows to wake up, inspect assigned context, perform work, and report progress without requiring a separate chat window to remain open.

### Governance and approvals

Army of Agents keeps important decisions reviewable through:

- company and role permissions;
- approval gates;
- agent autonomy settings;
- budget hard stops;
- runtime approvals;
- activity logging;
- pause and kill controls; and
- company-scoped access boundaries.

### Artifacts and workspaces

Artifacts are durable outputs connected to the work that produced them. Engineering tasks can use isolated workspaces for source changes, terminals, previews, Git operations, reviews, and pull requests.

## Supported runtimes

Army of Agents connects to agent runtimes through adapters. The repository currently includes integrations for:

- Claude Code;
- Codex;
- Cursor;
- Gemini;
- OpenCode;
- OpenClaw;
- Hermes;
- generic local processes; and
- HTTP-based runtimes.

Availability depends on local configuration, credentials, and the runtime being installed on the host machine. If your runtime is not listed, the adapter SDK and generic process/HTTP integrations provide extension points for connecting it.

## Marketplace and ecosystem

Army of Agents connects to an ecosystem of catalogs, skills, plugins, agents, teams, and community resources.

- [aoa-marketplace](https://github.com/tandavkrishna27/aoa-marketplace) — source-of-truth monorepo for marketplace infrastructure and AoA-curated plugins, skills, agents, and teams.
- [aoa-marketplace-cdn](https://github.com/tandavkrishna27/aoa-marketplace-cdn) — public catalog distribution repository. Army of Agents uses its published catalog and connector manifests as the default external source.
- [AoA-Skills](https://github.com/tandavkrishna27/AoA-Skills) — canonical Commander instruction files, skills, model overlays, and platform configuration.
- [aoa-community](https://github.com/tandavkrishna27/aoa-community) — community-contributed tools, plugins, templates, teams, and learning resources.

The application maintains a cache and bundled fallback for catalog availability, so the marketplace is an integration point rather than a requirement for every local operation.

## Quick start

### Requirements

- Node.js
- pnpm
- Git
- PostgreSQL, or the embedded development database
- Any agent CLIs you intend to connect

### Install

```bash
git clone https://github.com/tandavkrishna27/Army-of-Agents.git
cd Army-of-Agents

corepack enable
pnpm install --frozen-lockfile
```

### Start the development server

```bash
pnpm dev
```

The local application runs at `http://localhost:3100`.

Useful checks:

```bash
curl http://localhost:3100/api/health
curl http://localhost:3100/api/companies
```

When `DATABASE_URL` is not set, development uses the bundled embedded PostgreSQL instance. Some agent integrations require their own local CLI installation and credentials.

## Repository structure

```text
server/          Express API, services, adapters, and background execution
ui/              React application
packages/db/     Drizzle schema, migrations, and database clients
packages/shared/ Shared types, validators, constants, and API contracts
packages/adapters Adapter utilities and runtime integrations
docs/            Architecture, API, deployment, and project documentation
```

## Development

Run the standard verification commands before submitting changes:

```bash
pnpm -r typecheck
pnpm test:run
pnpm build
```

For database schema changes:

```bash
pnpm db:generate
```

Before opening a pull request:

1. Read [`AGENTS.md`](AGENTS.md) for repository rules and development workflow.
2. Read [`CLAUDE.md`](CLAUDE.md) for the architecture baseline and naming map.
3. Check [`docs/architecture/decisions.md`](docs/architecture/decisions.md) before changing a product or platform contract.
4. Keep the database, shared types, server, UI, adapters, and documentation synchronized.
5. Run the verification commands below.

Additional project planning information is in [`docs/roadmap.md`](docs/roadmap.md).

## Contributing

Contributions should:

- preserve company-scoped data access;
- keep database, API, shared types, server, UI, and documentation contracts synchronized;
- preserve approval, budget, and audit invariants;
- use Drizzle for database schema changes;
- update affected documentation when behavior changes; and
- avoid changing locked architectural decisions without an explicit replacement decision.

Open an issue or pull request with the problem being solved, intended behavior, affected areas, verification steps, and any migration or compatibility considerations.

## Project status

Army of Agents is actively developed software. The current product line is version 1. Capabilities, integrations, and marketplace content continue to evolve.

## Learn more

- [armyofagents.org](https://armyofagents.org)
- [Architecture decisions](docs/architecture/decisions.md)
- [Project documentation](docs/)
- [Installation report](docs/aoa/reports/first-install-report.md)
