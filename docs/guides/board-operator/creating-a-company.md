---
title: Creating an Organization
summary: Complete the guided founder onboarding flow
---

An organization is the top-level unit in AoA. Its agents, human teammates,
tasks, objectives, memory, and budgets are company-scoped in the API and
database.

> **Naming note:** The top-level executive agent is called the "Director" throughout the AoA UI. Its underlying agent role is `cxo`.

## Start the Founder Flow

A new user with no company membership is routed to `/onboarding`. From the
Lobby, **Create organization** opens the same route. AoA records each completed
step and resumes an interrupted setup.

For an authenticated empty instance, the first Google user becomes the instance
administrator. The environment step is instance-admin-only because it writes
local machine configuration.

## 1. Set Up Your Profile

Enter your name, title, and timezone. These three fields are required. A short
bio and social links are optional. The profile is global to your user account;
AoA materializes company-specific profile data when you join an organization.

## 2. Create the Organization

Enter the organization name. Vision and mission are configured after onboarding,
so you can finish the operational setup first.

If the organization was created before the browser closed or a later step
failed, AoA shows the existing organization and continues. Do not create a
duplicate.

## 3. Set Up the Environment

Choose an absolute root folder. AoA performs a blocking write probe before it
saves the environment. If the probe fails, select a writable folder and retry;
the flow stays on this step and does not persist a broken environment.

## 4. Choose and Verify Commander

Choose one of the supported local Commander runtimes:

- **Claude** — Anthropic Claude Code CLI
- **Codex** — OpenAI Codex CLI

The verification step checks the selected CLI. If authentication is required,
paste the provider API key into the encrypted company secret store. Codex also
offers an interactive in-app sign-in URL; Claude's interactive paste-code bridge
is not yet exposed in onboarding. Verification must succeed before setup
continues.

## 5. Create the First Department

The department defaults to **Engineering** and a folder below the organization
root. You can change the name, function, and workspace options before creating
it. A Team Lead must always be assigned to a department, but ordinary members
may remain unscoped.

## 6. Create the First Agent

The first agent defaults to **Director**, inherits the verified Commander
runtime, and is assigned to the department. Review the runtime label and purpose,
then choose **Create & assign**.

## 7. Review and Finish

Review the organization, department, Commander, and agent summary. **Finish
setup** returns you to the Lobby with the new organization available.

## Continue Building

Onboarding creates a runnable foundation; it does not invent your strategy.
Next:

1. Add vision, mission, and measurable objectives.
2. Invite teammates from **Team**, or add a person directly when you explicitly
   want to bypass email verification.
3. Add departments and agents, set budgets, and assign work.

See [Inviting and Joining](./inviting-and-joining.md) for the human teammate
flow.
