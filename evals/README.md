# AoA Agent Evals

Eval framework for testing AoA agent behaviors across models and prompt versions. Forked from Paperclip's Phase 0 promptfoo harness and extended for AoA's two agent types.

See [the Paperclip evals framework plan](../../paperclip-master/paperclip-master/doc/plans/2026-03-13-agent-evals-framework.md) for the original design rationale.

## Agent types under test

AoA has two distinct agent surfaces with different behavioral contracts:

- **Task agents** — adapter-executed (claude_local, openai_api, etc.), run inside a short heartbeat window, same pick-task → checkout → execute → report loop Paperclip uses. Tests live in `promptfoo/tests/task-agent-*.yaml`.
- **Internal Agent** — always-on conversation-driven coordinator with 30 tools across 8 categories (discussion, query, action, memory, workflow, file, coordination, analysis). Extracts user intent, routes through tools, never writes memory directly (Decision #15). Tests live in `promptfoo/tests/internal-agent-*.yaml`.

## Quick Start

### Prerequisites

No install needed — the `evals:smoke` script shells out to `npx promptfoo@0.103.3 eval` so promptfoo is fetched on demand. If you prefer a global install:

```bash
pnpm add -g promptfoo
```

You need an API key for at least one provider. Set one of:

```bash
export OPENROUTER_API_KEY=sk-or-...    # OpenRouter (recommended — covers all 4 configured models)
export ANTHROPIC_API_KEY=sk-ant-...     # Anthropic direct
export OPENAI_API_KEY=sk-...            # OpenAI direct
```

The 4-model fan-out in `promptfooconfig.yaml` (Claude Sonnet 4, GPT-4.1, Codex 5.4, Gemini 2.5-pro) all resolve through OpenRouter — that's the easiest single-key setup.

### Run evals

```bash
# Smoke test (all configured models, all test YAMLs)
pnpm evals:smoke

# Or run promptfoo directly
cd evals/promptfoo
promptfoo eval

# View results in browser
promptfoo view

# Validate config before committing
cd evals/promptfoo && promptfoo validate
```

Without API keys, promptfoo will fail per-provider with auth errors — the harness itself still loads and counts cases, which is enough to verify YAML integrity.

### What's tested

Phase 0 covers narrow behavioral evals for both agent surfaces.

**Task agents** (ported from Paperclip):

| Case | Category | What it checks |
|------|----------|---------------|
| Assignment pickup | `core` | Picks in_progress before todo |
| Progress update | `core` | Posts status comment before exiting |
| Blocked reporting | `core` | Sets status to blocked with explanation |
| No work exit | `core` | Exits cleanly with no assignments |
| Checkout before work | `core` | Always checks out before modifying |
| 409 conflict handling | `core` | Stops on 409, picks different task |
| Approval required | `governance` | Requests approval instead of bypassing |
| Company boundary | `governance` | Refuses cross-company actions |

**Internal Agent** (new for AoA):

| Case | Category | What it checks |
|------|----------|---------------|
| Query routing | `core` | Routes "what tasks are blocked?" to `query_tasks`, does not hallucinate |
| Memory suggestion boundary | `core` | Routes "add a memory" through `suggest_memory`, NEVER calls `create_memory` (Decision #15) |

### Adding new cases

1. Add a test entry to an existing `promptfoo/tests/*.yaml` file, or create a new file matching the glob in `promptfooconfig.yaml`.
2. Use deterministic assertions (`contains`, `not-contains`, `javascript`) — avoid rubric-based grading in Phase 0.
3. Run `pnpm evals:smoke` to validate.

Each future Phase C / Phase B / Phase E feature session should add at least one eval case for the behavior it ships.

### Phases

- **Phase 0 (current):** Promptfoo bootstrap — narrow behavior evals with deterministic assertions
- **Phase 1:** TypeScript eval harness with seeded scenarios and hard checks against a real AoA instance
- **Phase 2:** Pairwise and rubric scoring layer for comparing prompt revisions
- **Phase 3:** Efficiency metrics integration (token budget, cost, latency)
- **Phase 4:** Production-case ingestion — replay redacted founder sessions as evals
