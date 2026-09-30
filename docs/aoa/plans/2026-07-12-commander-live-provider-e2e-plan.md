# Commander Live-Provider E2E Plan

**Date:** 2026-07-12
**Branch:** `codex/commander-cockpit`
**Status:** Executed; overall verdict `FAIL` with evidence in `docs/aoa/qa/commander-live-provider-2026-07-12/`

## Purpose

Replace the synthetic Commander fixture with a fresh, understandable company whose attention items are produced by real Claude/Codex runs. Every question, permission, review, output, and status must be traceable to its originating company, department, project, task, agent, run, and human action.

## Safety and isolation

- Start a new `local_trusted` instance on app port `3202` and embedded PostgreSQL port `54422`.
- Use a new AOA home and database. Do not reuse or mutate the synthetic Northstar instance on `3201`.
- Enable `AOA_RUNTIME_DECISION_ROUTING=1` before server startup.
- Restrict agent work to a dedicated directory under the new instance's `.aoa-qa` workspace.
- Use authenticated local Claude/Codex CLIs. This is an intentional live-provider dogfood run and may consume subscription usage.
- Do not expose tokens, session data, provider credentials, or raw private answers in committed evidence.
- Do not directly insert lifecycle records or seed final statuses. Identity and starting configuration may use supported APIs only.

## Real company

Create `Harbor Launch Studio` with:

- Department: `Product and Engineering`.
- Project: `Customer Validation Pilot`.
- Founder: local board user.
- Product lead: `Priya Rao`, created through Team API.
- Product Analyst: `Maya Product Analyst`, org agent using `claude_local`.
- Launch Engineer: `Dev Launch Engineer`, org agent using `codex_local`.
- Company completion default: `review_required`.
- Every task has a responsible human and explicit acceptance criteria.

## Causal workflow

### LP-01 - Adapter readiness

Run the supported environment test for `claude_local` and `codex_local`. Record installed/authenticated/live-probe results. If one provider fails, mark its track `BLOCKED`; do not replace it with fake output.

### LP-02 - Source Discussion

Create a real Discussion titled `Choose the first customer segment`. Its human entry explains the decision between boutique agencies and early-stage SaaS teams. Create the product task from this decision context using supported task APIs and preserve the Discussion reference in the task context bundle where supported.

### LP-03 - Live work question

Assign the product task to Maya. The task explicitly requires Maya to call `ask_founder` before reaching a recommendation, with two meaningful segment options and concise trade-offs.

Verify while the run is alive:

- Real heartbeat run exists and is tied to Maya and the task.
- One `work_question` exists and is tied to the same run/task.
- Commander Triage and Inbox show an understandable question, not a generic approval label.
- Task Work and execution workspace surfaces are inspected for the same question; missing synchronized rendering is reported as a product gap.

Answer the question through the supported UI/API within the five-minute live relay window. Verify the decision terminalizes as relayed and the same run continues with the answer.

### LP-04 - Real runtime permission

After the answer, Maya must write `customer-segment-recommendation.md` inside the isolated task workspace. With supervised routing enabled, the real file-change permission must appear in the Hub/Inbox with agent, task, run, action, and target context. Approve it through the supported endpoint and verify the run continues.

If Claude's run does not naturally request a file permission, run one bounded Codex implementation task that creates `validation-experiment.md` under its own isolated workspace. Do not manufacture a database approval row.

### LP-05 - Task review

Because the company default is `review_required`, the agent must submit the product task to `in_review`, not `done`. Verify:

- Reviewer materializes from the responsible human.
- Commander Awaiting Review shows the task once.
- The row opens the canonical task slide-over and stays on Commander.
- The slide-over explains source Discussion, agent, run/work evidence, criteria, responsible human, reviewer, and outputs.
- Human approval transitions the task to `done` and removes it from Awaiting Review.

### LP-06 - Codex bounded implementation

Run Dev on a second task based on the approved product decision. Require a concrete workspace output and acceptance criteria. Observe its real run, output, and completion/review behavior. If supervised Codex app-server is not healthy, report `BLOCKED` with the exact handshake/runtime evidence and continue no further on that track.

### LP-07 - Commander understanding

Ask Commander to explain:

1. What decision Maya needed and how the founder answered.
2. What permission was approved and why.
3. What is awaiting review or completed.
4. Which source Discussion and outputs support the recommendation.

Judge the answer against persisted records. Missing retrieval or confusing terminology is a finding, not filled in manually.

## Product semantics under test

- Work question: agent needs information to continue.
- Runtime permission: agent needs authority for a concrete tool action.
- Task review: agent says work is ready for human acceptance.
- Business approval: governed domain decision only. It remains absent unless the real workflow creates one.

These four concepts must never be represented by interchangeable generic approval cards.

## Evidence and stop conditions

Write `docs/aoa/qa/commander-live-provider-2026-07-12/` with redacted state, run timeline, results, findings, and browser screenshots.

Stop a provider track when:

- Environment probe fails.
- Authentication or credits block execution.
- The agent attempts to write outside the isolated workspace.
- A pending question/permission cannot be safely answered before timeout.
- The run/task relationship becomes ambiguous.

The campaign is complete only when the fresh review URL is open for the user and every scenario is marked `PASS`, `FAIL`, `BLOCKED`, or `EXPECTED_GAP` with evidence.

## Review notes

- **CEO review:** hold scope. The minimum credible story is one real question, one real permission, one real review, one real output, and one Commander explanation. Generic seeded approvals are removed from the methodology.
- **Design review:** information must read as a narrative: source, requester, reason, requested action, consequence, and next step. Surface presence alone is insufficient.
- **Engineering review:** use provider probes first, preserve run/task/decision IDs, honor the five-minute relay window, and never seed lifecycle end states.
- **DX review:** keep the live workflow reproducible through supported APIs and document exact environment switches and blocked-provider evidence.
