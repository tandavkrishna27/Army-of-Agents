# Future session: "Memory for all agents — how it should work"

> DEFERRED by founder (2026-06-03) to its own dedicated design session. NOT v1-blocking.
> This captures the parked retrieval/scoping work + related open questions so the
> separate session starts from a complete brief.

## Why a separate session
This is entangled with the whole memory architecture across **all** agents (crew + Commander). It deserves a focused design discussion, not a bolt-on.

## Topics to cover

### 1. Department-scoped retrieval
Today Scout + the auto-injected context bundle search **company-wide** — `searchMultiPath(companyId, …)` filters by company only; memory can narrow by *layer*, not department. But the data IS department-organized (`memory_items.departmentId`, the `domain` layer) and threads CAN be department-scoped (`discussions.scopeType='department'`). 
**Goal:** a software thread → the crew searches the software department's knowledge first. Pass the thread's scope into the context bundle (`crew-context-bundle.ts`) + the search tools (`find_similar_memory_hnsw`, `search_discussions`, `query_threads`, `find_similar_threads`).

### 2. Repo / board routing
Which repo does an agent read? Code access goes through **execution workspaces** (task → its project/department → that project's git repo → a worktree). With multiple boards/repos, routing is "task → its project → that project's repo." 
**Goal:** extend so the crew can search/read the RIGHT repo **during a thread discussion** (not only task execution). Ties together Memory + workspaces + projects.

### 3. Embedding / provider keys (raised 2026-06-03)
Semantic memory search uses an OpenAI embedding model via the **embeddings worker** (`server/src/services/embeddings-worker.ts`), which reads the key from `config.apiKey ?? process.env.OPENAI_API_KEY` (server env). Agent + extraction LLM calls can be **per-company** (Settings → LLM Providers + company secrets / AWS Secrets Manager). 
**Open question:** should **embeddings** also be per-company / UI-configurable (each company supplies its own embedding key/provider), or stay instance-level infrastructure? Decide the key-provisioning model for memory across all agents.

### 4. (Expand as the design develops)
Retrieval ranking/strictness per agent, working-memory TTLs, cross-agent memory sharing/visibility, etc.

## Status
DEFERRED — revisit in a dedicated memory-architecture session.
