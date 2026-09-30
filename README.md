<h1 align="center">Army of Agents (AoA)</h1>

<p align="center">
  <strong>Command Center for Your Human + AI Team</strong>
</p>

<p align="center">
  Run a <strong>hybrid workforce</strong> of AI agents and human teammates from one control room — coordinated, budgeted, and governed.<br/>
  <em>Agents extend your team; they don't replace it.</em>
</p>

<p align="center">
  <a href="#quickstart"><strong>Quickstart</strong></a> &middot;
  <a href="#aoa-marketplace"><strong>Marketplace</strong></a> &middot;
  <a href="#development"><strong>Development</strong></a> &middot;
  <a href="https://github.com/MeteoriteLabs/aoa"><strong>GitHub</strong></a>
</p>

<br/>

## What is AoA?

**If an agent is an _employee_, AoA is the _company_.**

AoA is a **Hybrid Workforce Operating System** — a Node.js server and React UI that runs AI agents alongside humans to operate a business. Built for founding teams of any size, from solo founders to small teams: bring your own agents, invite your teammates, assign goals, and track work and budget from Home.

It looks like a task manager — but under the hood it has Team structure, budgets, governance, goal alignment, and agent coordination.

**Manage business goals, not pull requests.**

|        | Step            | Example                                                            |
| ------ | --------------- | ------------------------------------------------------------------ |
| **01** | Define the goal | _"Build the #1 AI note-taking app to $1M MRR."_                    |
| **02** | Hire the team   | CEO, CTO, engineers, designers, marketers — agents, humans, or both. |
| **03** | Approve and run | Review strategy. Set budgets. Hit go. Monitor from Home.  |

<br/>

## Works with

<div align="center">
<table>
  <tr>
    <td align="center"><strong>Works<br/>with</strong></td>
    <td align="center"><img src="https://cdn.simpleicons.org/anthropic/D97706" width="32" height="32" alt="Claude Code" /><br/><sub>Claude Code</sub></td>
    <td align="center"><img src="https://cdn.simpleicons.org/googlegemini/4285F4" width="32" height="32" alt="Gemini" /><br/><sub>Gemini</sub></td>
    <td align="center"><img src="https://cdn.simpleicons.org/openai/000000/FFFFFF" width="32" height="32" alt="Codex" /><br/><sub>Codex</sub></td>
    <td align="center"><img src="https://cdn.simpleicons.org/cursor/000000/FFFFFF" width="32" height="32" alt="Cursor" /><br/><sub>Cursor</sub></td>
    <td align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="ui/public/brands/opencode-logo-dark-square.svg"><img src="ui/public/brands/opencode-logo-light-square.svg" width="32" height="32" alt="OpenCode" /></picture><br/><sub>OpenCode</sub></td>
    <td align="center"><img src="https://cdn.simpleicons.org/gnubash/4EAA25" width="32" height="32" alt="Bash" /><br/><sub>Bash</sub></td>
  </tr>
</table>

<em>If it can receive a heartbeat, it's hired.</em>

</div>

Any agent that can receive a heartbeat is hireable. Built-in adapters:

- **CLI agents:** Claude Code, Codex, Cursor, Gemini, OpenCode, OpenClaw, Hermes
- **Generic runtimes:** `process` (any local executable, including bash), `http` (any HTTP endpoint)

If your runtime isn't listed, the adapter SDK lets you wire it up.

<br/>

## AoA is right for you if

- You want to run a business with a **hybrid workforce** of AI agents and human teammates
- You **coordinate many different agents** (OpenClaw, Codex, Claude, Cursor) toward a common goal
- You have **20 simultaneous Claude Code terminals** open and lose track of who's doing what
- You want agents running **24/7**, but still want to audit work and chime in when needed
- You want to **monitor spend** and enforce budgets
- You want managing your team to **feel like using a task manager** — from one local control room

<br/>

## Features

<table>
<tr>
<td align="center" width="33%">
<h3>Bring Your Own Agent</h3>
Any agent, any runtime, one Team chart. If it can receive a heartbeat, it's hired.
</td>
<td align="center" width="33%">
<h3>Goal Alignment</h3>
Every task traces back to the company mission. Your team — agents and humans — knows <em>what</em> to do and <em>why</em>.
</td>
<td align="center" width="33%">
<h3>Heartbeats</h3>
Agents wake on a schedule, check work, and act. Delegation flows up and down the Team chart.
</td>
</tr>
<tr>
<td align="center">
<h3>Cost Control</h3>
Monthly budgets per agent. When they hit the limit, they stop. No runaway spend.
</td>
<td align="center">
<h3>Multi-Company</h3>
One deployment, many companies. Complete data isolation. One control plane for your portfolio.
</td>
<td align="center">
<h3>Ticket System</h3>
Every conversation traced. Every decision explained. Full tool-call tracing and immutable audit log.
</td>
</tr>
<tr>
<td align="center">
<h3>Governance</h3>
You're the board. Approve hires, override strategy, pause or terminate any agent — at any time.
</td>
<td align="center">
<h3>Team Chart</h3>
Hierarchies, roles, reporting lines. Your team has bosses, titles, and job descriptions.
</td>
<td align="center">
<h3>Workspace Ready</h3>
Run coding agents in isolated per-task workspaces.
</td>
</tr>
<tr>
<td align="center">
<h3>Discussions & Memory</h3>
Threaded discussions feed a layered memory store (identity, domain, active context, working). Your team recalls what matters.
</td>
<td align="center">
<h3>Artifacts</h3>
Versioned, immutable deliverables. Spec → design → code → test pipelines with full lineage.
</td>
<td align="center">
<h3>Internal Agent ("Commander")</h3>
Always-on AI assistant for coordination, proactive monitoring, and workflow management.
</td>
</tr>
</table>

<br/>

## Problems AoA solves

| Without AoA                                                                                                                           | With AoA                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| You have 20 Claude Code tabs open and can't track which one does what. On reboot you lose everything.                                 | Tasks are ticket-based, conversations are threaded, sessions persist across reboots.                                                   |
| You manually gather context from several places to remind your bot what you're actually doing.                                        | Context flows from the task up through the project and company goals — your team always knows what to do and why.                      |
| Folders of agent configs are disorganized and you're re-inventing task management, communication, and coordination between agents.    | AoA gives you Team charts, ticketing, delegation, and governance out of the box — so you run a company, not a pile of scripts.          |
| Runaway loops waste hundreds of dollars of tokens and max your quota before you even know what happened.                              | Cost tracking surfaces token budgets and throttles agents when they're out. Management prioritizes with budgets.                       |
| You have recurring jobs (customer support, social, reports) and have to remember to manually kick them off.                           | Heartbeats handle regular work on a schedule. Management supervises.                                                                   |
| You have an idea, you have to find your repo, fire up Claude Code, keep a tab open, and babysit it.                                   | Add a task in AoA. Your coding agent works on it until it's done. Management reviews their work.                                       |

<br/>

## Why AoA is special

AoA handles the hard orchestration details correctly.

|                                   |                                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Atomic execution.**             | Task checkout and budget enforcement are atomic, so no double-work and no runaway spend.                      |
| **Persistent agent state.**       | Agents resume the same task context across heartbeats instead of restarting from scratch.                     |
| **Runtime skill injection.**      | Agents can learn AoA workflows and project context at runtime, without retraining.                            |
| **Governance with rollback.**     | Approval gates are enforced, config changes are revisioned, and bad changes can be rolled back safely.        |
| **Goal-aware execution.**         | Tasks carry full goal ancestry so agents consistently see the "why," not just a title.                        |
| **Portable company templates.**   | Export/import orgs, agents, and skills with secret scrubbing and collision handling.                          |
| **True multi-company isolation.** | Every entity is company-scoped, so one deployment can run many companies with separate data and audit trails. |
| **Isolated workspaces.**          | Per-task git worktrees for engineering work. Run dev servers, open in your IDE, raise PRs without crosstalk.  |

<br/>

## What AoA is not

|                              |                                                                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Not a chatbot.**           | Agents have jobs, not chat windows.                                                                            |
| **Not an agent framework.**  | We don't tell you how to build agents. We tell you how to run a company made of them.                          |
| **Not a workflow builder.**  | No drag-and-drop pipelines. AoA models companies — with Team charts, goals, budgets, and governance.            |
| **Not a prompt manager.**    | Agents bring their own prompts, models, and runtimes. AoA manages the organization they work in.               |
| **Not a single-agent tool.** | This is for teams. If you have one agent, you probably don't need AoA. If you have twenty — you definitely do. |
| **Not a code review tool.**  | AoA orchestrates work, not pull requests. Bring your own review process.                                       |

<br/>

## Quickstart

Install from a source checkout. No account is required for local use.

```bash
git clone https://github.com/MeteoriteLabs/aoa.git
cd aoa
pnpm install
pnpm aoa onboard --yes
```

Keep the command running and open the URL it prints. Use `pnpm aoa run` from
the checkout for later starts. This starts the API server at
`http://localhost:3100`; an embedded PostgreSQL database is created
automatically.

The MeteoriteLabs AoA CLI is not currently published to npm. Do not use
`npx aoa`: that package name does not identify this repository. Use the source-checkout command until a scoped release is published.

> **Requirements:** Node.js 20.3+, pnpm 9.15+

Open the URL to continue through guided setup. The first-time flow creates your
profile and organization, verifies a writable workspace and your Commander CLI,
then creates your first department and agent. The loopback-only quickstart uses
a local board identity, so it does not require a Google account; authenticated
or remotely exposed deployments use Google sign-in.

<br/>

## AoA Marketplace

Browse the catalog for agents, skills, teams, and packages that extend your AoA instance — AoA-curated and community-contributed.

Related projects:

- [aoa-marketplace](https://github.com/MeteoriteLabs/aoa-marketplace) — source-of-truth monorepo: catalog infrastructure plus all AoA-curated plugins, skills, agents, and teams.
- [aoa-marketplace-cdn](https://github.com/MeteoriteLabs/aoa-marketplace-cdn) — public CDN that serves the catalog to every AoA instance.
- [AoA-Skills](https://github.com/MeteoriteLabs/AoA-Skills) — canonical Commander skills and instruction files (Brainstorm, Sprint Planning, Team Design, and more).
- [aoa-community](https://github.com/MeteoriteLabs/aoa-community) — community-contributed templates, teams, and discussion.

<br/>

## FAQ

**What does a typical setup look like?**
Locally, a single Node.js process manages an embedded Postgres and local file storage. For production, point it at your own Postgres and deploy however you like. Configure projects, agents, and goals — the team takes care of the rest.

If you're a solo founder you can use Tailscale to access AoA on the go. Then later you can deploy to e.g. Vercel when you need it.

**Can I run multiple companies?**
Yes. A single deployment can run an unlimited number of companies with complete data isolation.

**How is AoA different from agents like OpenClaw or Claude Code?**
AoA _uses_ those agents. It orchestrates them into a company — with Team charts, budgets, goals, governance, and accountability — and brings your human teammates into the same workspace.

**Why should I use AoA instead of just pointing my OpenClaw to Asana or Trello?**
Agent orchestration has subtleties in how you coordinate who has work checked out, how to maintain sessions, monitor spend, and establish governance — AoA does this for you.

(Bring-your-own-ticket-system is on the Roadmap.)

**Do agents run continuously?**
By default, agents run on scheduled heartbeats and event-based triggers (task assignment, @-mentions). You can also hook in continuous agents like OpenClaw. You bring your agent and AoA coordinates.

<br/>

## Development

```bash
pnpm dev              # Full dev (API + UI, watch mode)
pnpm dev:once         # Full dev without file watching
pnpm dev:server       # Server only
pnpm build            # Build all
pnpm typecheck        # Type checking
pnpm test:run         # Run tests
pnpm db:generate      # Generate DB migration
AOA_DEPLOYMENT_MODE=local_trusted pnpm db:migrate  # Apply migrations
```

<br/>

## Roadmap

See [`docs/roadmap.md`](docs/roadmap.md) for planned work. `CLAUDE.md` remains the source of truth for shipped behavior.

<br/>

## Resources

- `docs/start/quickstart.md` — local setup guide
- `CLAUDE.md` — current architecture baseline for agents and engineers
- `docs/architecture/decisions.md` — locked product and architecture decisions
- [GitHub Issues](https://github.com/MeteoriteLabs/aoa/issues) — report bugs and request features

<br/>

## License

Proprietary &copy; 2026 Army of Agents. All rights reserved.
