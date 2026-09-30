# Enterprise Memory — Real-CLI Acceptance Runbook

**Purpose:** prove, on a live instance with a **real CLI agent**, that Commander, org agents, and crew agents actually read and write memory correctly across every input and output path — with RBAC holding. This is the human-run acceptance gate that sits on top of the automated tests. Each phase's "real-run" task references the scenarios it must pass.

**Companion to** `2026-07-30-memory-enterprise-overview.md`. Automated coverage (unit / integration / E2E / fake-CLI real-run) lives in the phase plans; this doc is the **live real-CLI** layer.

---

## Preconditions / setup (once per run)

1. Local instance booted (`local_trusted`), a real CLI configured and logged in (claude_local or codex_local). On Windows use the detached-worktree + embedded-pg setup (short path, `AOA_HOME` / `PORT` / `AOA_EMBEDDED_POSTGRES_PORT`).
2. `llm:openai` key set in Settings → Memory (so embeddings run; otherwise retrieval degrades to keyword, note it).
3. Seed fixture:
   - Company `Acme`, departments **Alpha** and **Beta**.
   - Org agent **`org-alpha`** assigned to Alpha (adapter = real CLI). Crew present (Memory Keeper, Librarian). Commander enabled.
   - Memory fixtures: one `identity` item (company vision), one `domain` item scoped to **Alpha**, one `domain` item scoped to **Beta**, one `agent`-private item owned by a *different* agent, one `working` item.
4. Verification surfaces you'll use each scenario: the **Memory UI**, a **DB query** (`memory_items` / `memory_retrievals`), and the **run log / task comments**.

---

## INPUT scenarios (write paths) — every way memory gets in

| # | Path | Action | Expected | Verify | Gates |
|---|------|--------|----------|--------|-------|
| **I1** | Manual | Founder adds a memory (Quick Add) scoped to Alpha | Lands `approved` (founder authority), scoped Alpha | Memory UI + `memory_items` row | P1 |
| **I2** | Discussion | Create a thread, add an entry, run extraction, approve an item | New `memory_items` row, `provenance_kind` traces to the thread | UI + row `source_ref` | P1 |
| **I3** | Braindump | Submit a braindump + a file for Alpha | Librarian proposes `status='pending'` items from the text | Inbox review + rows pending | P1 |
| **I4** | Run-Miner | Assign a task to `org-alpha`, let the **real CLI** run to completion | A **pending** fact candidate appears with `provenance_kind='run'`, `source_ref=<runId>` — never auto-approved durable | `memory_items` pending + run log | **P3** |
| **I5a** | Commander (working) | Tell Commander "remember for this task: X" | Auto-created `working` memory, scoped, reversible, `approved` | Commander + row `layer='working'` | P1 |
| **I5b** | Commander (durable) | Tell Commander "make it policy that Y" | Proposed `status='pending'` (durable/protected gated), not silently applied | Row pending + Commander says "proposed" | P1 / P5 |
| **I6** | External / MCP | Push MCP content containing an instruction-injection string and a fake secret | **Quarantined** (`status='quarantined'`), founder notified; not retrievable | Row quarantined + notification | **P3** |

## OUTPUT scenarios (retrieval) — every actor, with RBAC

| # | Actor | Action | Expected | Verify | Gates |
|---|-------|--------|----------|--------|-------|
| **O1** | Commander | Ask Commander a question whose answer is in Alpha memory | Retrieves the Alpha item; recall audited as `commander_context` | Answer cites it + `memory_retrievals` | P1 |
| **O2** | Org agent | Run `org-alpha` on an Alpha task | Context includes: identity **core** + **current goal** + Alpha domain memory + dependency outputs. Retrieval **audited**. | Run log / context dump + `memory_retrievals` rows | P1 |
| **O3** | Org agent RBAC (negative) | Same run | Beta's scoped item and the other agent's private item are **absent** from context and from any `memory.search` the agent makes | Context dump has neither; leakage = FAIL | **P1** |
| **O4** | Crew agent | Spawn a crew agent from an Alpha thread | Context includes thread/task-scoped Alpha memory, RBAC-filtered, and the retrieval is now **audited** (was not before) | `memory_retrievals` rows for the crew run | P1 |
| **O5** | Always-on core | Any of O2/O4 | A small deterministic core block is present every run: agent role + current goal + "identity/policies exist — use memory.search". Small, not a dump. | Context dump | P1 |
| **O6** | Map | Any agent run (after P2) | Agent receives a MEMORY_MAP listing only **its** readable spaces (Alpha, not Beta) | Mounted map file / context | **P2** |

## CROSS-CUTTING scenarios

| # | What | Action | Expected | Gates |
|---|------|--------|----------|-------|
| **X1** | Autonomy dial | Set company autonomy to Supervised; run I4 | Durable run-mined facts stay **pending**. Then set Alpha to a looser level and confirm the disposition changes per the tier table | **P5** |
| **X2** | Correction / forgetting | Mark an approved item "outdated" (sets `invalidated_at`) | It disappears from the **next** retrieval (O1/O2) but stays in history / DB | **P4** |
| **X3** | Guardian | Create a near-duplicate memory; let the Guardian sweep | Guardian raises a **pending** consolidation proposal (merge/supersede); never auto-approves | **P4** |
| **X4** | Trust promotion | After a class shows sustained approve-without-edit, promote it in the panel | That class now auto-approves for the trusted agent; **protected** classes still cannot be promoted | **P5** |

---

## Phase gate map

- **P1** must pass: I1, I2, I3, I5a, I5b, O1, O2, **O3 (leakage — hard gate)**, O4, O5.
- **P2**: O6.
- **P3**: I4, I6.
- **P4**: X2, X3.
- **P5**: X1, X4.

**Hard rule:** O3 (cross-scope leakage) is a release blocker. If any agent ever sees another department's scoped memory or another owner's private memory in a real run, the phase is not done.
