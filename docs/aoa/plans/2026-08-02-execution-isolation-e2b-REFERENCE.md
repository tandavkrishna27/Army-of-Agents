# Execution Isolation & E2B — Reference (understanding doc)

**Written:** 2026-08-02. **Last verified:** 2026-08-05. **Purpose:** a shared mental model + code-grounded map of how tenant isolation works today and how E2B sandboxing plugs in, so we can decide *what to build* for the cloud follow-up. Not a task plan — a reference to reason from.

> **Verification status (2026-08-05):** every code-grounded claim in this doc was re-checked against the `mt-cloud` worktree by a 5-way adversarial audit (default-skeptical, one agent per claim-cluster). **21/21 claims CONFIRMED** against the actual code — the file/line references below are current as of this date. Two new findings were added this pass: the managed→self-hosted change cost (§4) and the BYO-override precedence that already exists in code (§4). One framing was **corrected**: BYO E2B is **not replaced** by the AoA-operated model — the two **coexist** as a precedence stack (§4).

---

## 0. The one idea that makes everything click: TWO isolation planes

Two different questions, often conflated. Keeping them separate is what makes the design tractable:

| Plane | Question | Boundary | Status |
|---|---|---|---|
| **DATA** | *Which rows can an agent read/write?* (**who** the agent is) | `companyId` (+ org), enforced in SQL + a company-bound run-JWT, server-side | **Already built + solid** |
| **EXECUTION** | *Where does the agent's CLI/shell actually run?* (**where** it runs) | a sandbox (E2B microVM) around the untrusted process | **The deferred E2B work** |

**They are orthogonal.** Data isolation does **not** depend on the sandbox, and the sandbox does **not** enforce data isolation. This is the crucial point for your "one company = a sandbox with sub-sandboxes?" question — see §3.

---

## 1. The isolation requirements (invariants we must uphold)

Stated plainly (your words, formalized):

1. **Within a company:** Commander, crew, and org agents **share the same data/context** — memory, tasks, goals, artifacts are common to the company. There is **no data isolation *between* agents of the same company** (by design).
2. **Between companies:** agents **cannot** read/write each other's data, **cannot** talk to each other, and **cannot** share execution state.
3. **Between orgs:** same hard boundary as between companies (an org is the tenant; it owns companies).
4. **Multi-tenant reality:** many users → each can create many **orgs** → each org has many **companies** → each company has many **agents**, all on shared infrastructure, with **zero overlap** across org/company boundaries.

The layering is: **Org → Company → Agent.** The **company** is the hard data boundary; the **org** gates which companies a user can reach; **agents** are the actors *inside* a company that share its data.

---

## 2. DATA-plane isolation — how "no overlap between companies/orgs" is guaranteed (already built)

The hard tenant boundary is **`companyId`**, and it is enforced **server-side, everywhere**:

- Every DB query filters on it — `eq(memoryItems.companyId, companyId)`, `eq(issues.companyId, companyId)`, etc. (`server/src/services/memory.ts:587`, `server/src/services/internal-agent/aoa-agents/crew-context-bundle.ts:156/332`).
- The `companyId` an agent operates under comes from the **trusted run record / a company-bound run-JWT** (`createLocalAgentJwt`, `server/src/agent-auth-jwt.ts:68-82` → `company_id` + `run_id`; verified at `middleware/auth.ts:312`, which rejects if `agentRecord.companyId !== claims.company_id`). **The agent supplies only tool *arguments* — never the companyId** (`mcp/server.ts` sets `ToolContext.companyId` from the URL/JWT, and no tool reads a caller-supplied `companyId`). So an agent cannot even *name* another company's data.
- **Org gating:** in `cloud_auth`, reaching a company requires an active **org membership AND company membership** (`routes/authz.ts`), so a user in Org-A can't touch Org-B's companies.

**Consequence:** the "companies/orgs don't overlap" guarantee is a **property of the data layer**, true regardless of how execution is sandboxed. You do **not** need a VM-per-company to keep companies' *data* apart — that's already handled.

Intra-company scoping (the 4-layer memory model + department/project RBAC) is *soft*, in the app layer — and by design all a company's agents share the company's data (invariant #1).

---

## 3. EXECUTION-plane isolation — how sandboxing actually maps (the answer to your question)

**The threat E2B addresses:** an agent run is a CLI (claude/codex) executing model-generated **shell commands** — untrusted code. Without a sandbox, that code runs on the shared control-plane host and could touch the host filesystem, other tenants' files/processes, or the cloud metadata endpoint. The sandbox contains *that*.

### You don't nest sandboxes — you pick a granularity, and the tenant boundary rides in the JWT

E2B has no "sandbox inside a sandbox." So the real choices are a **flat granularity**:

| Granularity | What it means | Blast radius | Cost | Verdict |
|---|---|---|---|---|
| **Per-run (ephemeral)** | each agent *run* = a fresh microVM, destroyed after | strongest (one run can't affect the next or a sibling agent) | pay per run; cold-start each time | **Recommended default** |
| **Per-agent (warm/reuse)** | each agent keeps its own sandbox + repo between runs | strong (per agent) | idle cost per agent; warm starts | **For software-dev agents** that need a persistent checkout |
| **Per-company (shared)** | all a company's agents share one sandbox | weaker (agents in a company share a box) | cheapest | avoid unless cost forces; **no data-isolation benefit** |
| **Per-org** | one sandbox per tenant | weakest | cheapest | too coarse — don't |

**Why per-run is the natural fit:** the run-JWT is per-run, the `environment_leases` model is per-run/ephemeral, and it gives the cleanest blast radius. **A per-run sandbox can still only ever reach its own company's data**, because every DB call it makes goes through the company-bound run-JWT to the broker (§6). So:

> **Sandbox granularity is about *execution* blast radius + cost. The *data* boundary (org/company) is enforced separately by the JWT/broker.** You get company/org isolation for free from the data plane; the sandbox adds "untrusted code can't escape to the host / other processes" on top.

**So: not "one company sandbox with sub-sandboxes per agent."** It's **one sandbox per run (or per agent)**, each stamped with a **company-scoped run-JWT** that makes it data-blind to every other company. Simpler and safer than nesting.

---

## 4. The AoA-side E2B model — platform default + tenant override (they COEXIST)

The shift for cloud isn't "replace BYO with an AoA-operated sandbox." It's **add a platform-operated default *underneath* the BYO layer that already exists**, so the two form a precedence stack. Today BYO E2B is the *only* source of a sandbox; cloud adds an operator-level default so a tenant who configures nothing still gets isolation — while a tenant who *wants* their own E2B can still override, per company or per agent.

**Two independent axes (don't conflate them):**
- **Sandbox provider (E2B) = execution isolation.** On cloud this becomes **operator/instance-level by default** (one config for the whole deployment → every run gets a per-run sandbox), with **tenant override still available**. This platform default is the piece that doesn't exist yet.
- **Model provider key = per-company (tenant-owned), unchanged.** Resolved per company via the existing per-tenant credential resolver and injected into the sandbox at run time. A tenant signs up → adds their Anthropic/OpenAI key → it works across Commander + crew + org agents.

### The E2B key is a precedence stack — and the plumbing already exists

BYO does **not** go away; it becomes an override layer. Resolution order (most specific wins):

| Layer | Where it lives | When it wins |
|---|---|---|
| **Task** | `issue.executionEnvironmentId` | a specific task pins a specific environment |
| **Agent** | `agent.defaultEnvironmentId` | that agent always runs in its own environment |
| **Company** | an `environments` row the tenant created (`provider:e2b`, **their** key in config) | company-wide default |
| **Platform** | operator `E2B_API_KEY` / a platform-owned environment | fallback when nothing above is set |

**Precedence: task > agent > company > platform-default.** This is not aspirational — the code already resolves the key this way: `resolveE2bApiKey` does `config.apiKey ?? readString(env.E2B_API_KEY)` (`sandbox-provider-runtime.ts:236`), so a tenant's stored environment-config key **already** takes precedence over the platform-global `E2B_API_KEY`. The BYO-override mechanism is the *same* `environments` + per-run resolution this doc describes throughout; the only new pieces are **populating the platform fallback** and letting `agent.defaultEnvironmentId` / `issue.executionEnvironmentId` pin it.

**Guardrails for the override:** a tenant's BYO key stays an **encrypted company secret / environment config, never entering a VM** (same rule as `DATABASE_URL` / `GITHUB_PAT`), and on cloud any override must still resolve to a **genuinely isolated** sandbox — the D1 guard won't let a tenant "override" onto the shared host.

### Managed vs self-hosted E2B is a config knob, not a rewrite (verified 2026-08-05)

Because runs go through the `provider-sandbox` abstraction, and the provider passes **only `{apiKey, timeoutMs, metadata}`** to the E2B SDK today (verified: `Sandbox.create` at `sandbox-provider-runtime.ts:376`/`409`, `Sandbox.connect` at `:349` — **no** `domain`/base-URL is threaded anywhere; the only `sandboxDomain` reads are pulling the created sandbox's URL *out*), switching "managed E2B cloud" → "self-hosted E2B on our own box" is:

- **Code: trivial.** Thread a `domain` / `E2B_DOMAIN` config through those **3 SDK call sites** (mirror exactly how `apiKey`/`E2B_API_KEY` already resolve). **~10 lines + one config field.** Nothing else changes — leases, target types, the broker, run lifecycle, and every caller stay identical, because to them it's still "the E2B provider."
- **The real cost is infrastructure, not code.** Self-hosting means running E2B's open-source `infra` stack (orchestrator + Firecracker microVM hosts + template builder) on **bare-metal / nested-virt hosts** (Firecracker needs KVM — a dedicated Hetzner box, *not* a stock cloud VM). That's a devops project, entirely outside AoA's code.

**Recommendation (still your call — Open Decision #2):** **launch on managed E2B** (fastest, free credits, zero ops), but make `domain` a first-class knob from day one (unset = managed) so self-hosted is a later *config flip + infra standup*, never a re-architecture. E2B being fully open-source is exactly what makes this swap clean — a closed managed-only vendor would trap you. gVisor-self-hosted stays the lighter "no third party" fallback if Firecracker ops prove too heavy.

---

## 5. Coverage — which agents run in E2B today, and the gap

| Agent type | Reaches E2B today? | What's needed |
|---|---|---|
| **Org agents** (heartbeat) | **Yes** — `heartbeat.ts:4100-4118` calls `environmentRunOrchestrator(db).acquireForRun(...)` (env → lease → provider-sandbox) — but with gaps (file movement, bridge) | close the gaps (§7) |
| **Crew** (kind='aoa') | **No** — `runAoaAgent` resolves its target from `agent.adapterConfig` (`runner.ts:445`); zero `environmentRunOrchestrator`/`acquireForRun` wiring. **Also mints no run-JWT** — the crew `adapter.execute` passes literal `authToken: undefined` (`runner.ts:970`) | wire onto the same lease path **+ mint a run-JWT** |
| **Commander** | **No** — spawns its CLI with `cwd: tmpdir()` (`cli-mode.ts:1147-1152`), no workspace/environment/lease at all | wire onto the same lease path |

On `cloud_auth` today, crew + Commander are simply **refused** by the D1 guard — Commander calls it explicitly (`cli-mode.ts:804-815`), crew hits it via `resolveGuardedAdapterExecutionContext` → `heartbeat.ts:365-368` on the local target. So **"one setup covers Commander + crew + all agents"** literally requires **(a)** the operator-level default E2B, **(b)** wiring crew + Commander onto the E2B lease path, and **(c)** minting a run-JWT for crew — org + Commander already mint one; crew is the outlier (see §7.2).

---

## 6. How context + data flow into a sandbox (the run lifecycle, end to end)

This is the concrete "how it all works together." Per agent run, in E2B:

```
1. DISPATCH (control-plane host)
   - resolve the run's company + org (from the agent/task)
   - resolve the per-COMPANY model-provider key (Anthropic/OpenAI)  [tenant BYO]
   - mint a per-RUN, company-bound run-JWT (createLocalAgentJwt: company_id+agent_id+run_id)

2. ASSEMBLE CONTEXT (control-plane host — needs broad tenant-DB access)
   - persona bundle (AGENTS/SOUL/TOOLS/HEARTBEAT.md), task Why/What/How,
     bounded memory snapshot, recent history  → a finished prompt string

3. ACQUIRE SANDBOX (per-run, from the operator E2B)   [platform infra]

4. INJECT INTO THE VM (only what's safe):
   - the assembled prompt (stdin) + persona/skills/mcp-config files
   - the resolved model-provider key (per-company)
   - AOA_API_URL + the run-JWT (AOA_API_KEY)          ← the ONLY credential in
   - clone/upload the repo/workspace INTO the sandbox
   ✗ NEVER: DATABASE_URL, secrets master key, GITHUB_PAT, operator ~/.claude

5. RUN the CLI inside the sandbox (network = ALLOWLIST, not none):
   allowed egress = { control-plane MCP broker, model-provider API, git/npm }

6. LIVE TOOLS during the run:
   CLI  --(MCP over allowlisted egress, auth = run-JWT)-->  control-plane BROKER
   broker runs the tool against Postgres, SCOPED to the JWT's companyId
   (memory/tasks/goals/artifacts, ask_human, writes) — VM never touches the DB

7. CAPTURE OUTPUTS (git diff INSIDE the VM → pull changed files OUT)
   → existing asset-storage / detectedOutputs / artifact path (host-side)

8. TEARDOWN: destroy the sandbox + revoke/expire the run-JWT
```

The tenant boundary is enforced at **step 6** (the JWT is company-scoped, the broker filters by companyId) — so no matter what the sandbox does, it can only ever reach its own company's data. The sandbox (steps 3–5,7) adds execution isolation.

---

## 7. What has to be built (the follow-up scope, derived from the above)

1. **Operator-level E2B config** (endpoint + key), used as the **default** sandbox provider on `cloud_auth` when a run needs a sandbox (today E2B is per-company BYO only). *(New.)*
2. **Networked MCP broker** — the core re-architecture. Today the bridge is a **stdio child of the CLI holding a direct `DATABASE_URL` Postgres handle** (`internal-agent/mcp-bridge.ts:342-347`, `StdioServerTransport`) — fine on the control-plane host, impossible from inside a VM. Move it **off** the VM: the sandbox reaches the **control-plane HTTP MCP endpoint** (`server/src/mcp/server.ts:394` — `POST /companies/:companyId/mcp`, which already implements the company-bound agent-JWT actor model) using the run-JWT. Port the **richer internal tool registry** (`ask_human`, `submit_extracted_items`, `create_scope_draft`, Commander ⚡CONFIRM, the per-agent allowlist) onto that HTTP surface with identical gating. Re-point the org runtime-permission hook (today falls back to `127.0.0.1:${PORT}`, `heartbeat.ts:4762-4764`) to a routable control-plane URL. **Crew needs a run-JWT first** — it passes `authToken: undefined` today (`runner.ts:970`) where org passes one (`heartbeat.ts:4800`), so crew is furthest from broker-ready. **Never let `DATABASE_URL` / the master key enter the VM.**
3. **Env posture flip** — from "inherit `process.env` minus a denylist" (`mergeChildEnv`, `packages/adapter-utils/src/server-utils.ts:392-436` — inherit-then-strip) to a **from-scratch allowlist**: only the provider key + run-JWT + run-identity env enter the VM.
4. **Bidirectional file movement** — clone/upload the repo IN; run `git diff` **inside** the sandbox and pull changed files OUT into the existing asset-storage path; expose runtime services/preview URLs via E2B's `sandboxDomain` instead of host loopback. *(The real E2B provider exists but stages nothing in and pulls nothing out — this is the biggest build gap.)*
5. **Wire crew + Commander onto the E2B lease path** (they bypass environments today) so one setup covers all three agent types.
6. **Provider-credential injection** — keep per-company resolution; inject the resolved key into the sandbox (or have the broker inject it so the raw key never sits in the VM env — decision).
7. **D1 guard** — recognize an E2B target as genuine isolation so the guard flips from **refuse → sandbox** on `cloud_auth` (the guard is the explicit placeholder for exactly this; a tenant-authored runtime string is deliberately NOT accepted as proof).
8. **(Self-hosted path)** endpoint/base-URL config + a Hetzner **dedicated-box KVM/Firecracker spike** (mirror the gVisor Gate-B checkpoints) before committing.

---

## 8. Open decisions (need your input — I've marked my leans)

1. **Sandbox granularity / statefulness.** Ephemeral **per-run** (clean/safe/cheap-idle, but re-inject + re-clone every run) vs **per-agent warm** (fast resume, repo + deps persist, but idle cost + lifecycle). See the research in **§8.1** — E2B's pause/resume has largely closed the old "ephemeral-only" trade-off. *Lean: **hybrid** — ephemeral per-run default, per-agent warm for `software_development` (keyed off the `functionType` signal AoA already has). Matches Copilot-ephemeral + Devin/Replit/Cursor-stateful.*
2. **Managed vs self-hosted E2B for launch.** Verified (§4): self-hosted is a **~10-line config knob**; the real cost is infra, not code. So this is a launch-*sequencing* call, not an architecture fork. *Lean: launch **managed** (free credits, zero ops), ship `domain` as a config knob day one so self-hosted (Hetzner dedicated + KVM/Firecracker) is a later config flip + infra standup.*
3. **Egress model.** Does AoA **proxy the model provider** (so the VM's only egress is the broker) or **allowlist provider hosts** from the VM? *Lean: allowlist to start; proxy later for a tighter boundary.*
4. **Where the provider key lives.** Inject the resolved key into the **VM env**, or have the **broker inject it** so it never sits in the sandbox? *Lean: broker-injected is tighter but bigger; VM-env is simpler to start.*

### 8.1 — Sandbox statefulness & what other platforms do (research, 2026-08-05)

**Statefulness = does the sandbox's filesystem (+ memory) survive between an agent's runs?** That single question *is* the per-run vs per-agent choice:

| | **Per-run ephemeral (stateless)** | **Per-agent warm (stateful)** |
|---|---|---|
| Lifecycle | fresh microVM per run → destroy after | agent keeps its sandbox, paused/snapshotted between runs, resumed next time |
| Pros | strongest isolation (a run can't affect the next or a sibling), cheapest idle, nothing to leak/corrupt, trivial lifecycle | fast resume, repo + `node_modules` + build caches already there (huge for iterative coding), continuity across a long task |
| Cons | cold start + re-inject context + **re-clone repo & re-install deps every run** | idle cost (a paused sandbox still costs storage), state can accumulate/corrupt, more lifecycle to manage |

**E2B closed the old trade-off.** E2B **pause/resume** persists the *full* filesystem **and** memory via Firecracker snapshots, resuming in **5–30 ms** ([E2B persistence docs](https://e2b.dev/docs/sandbox/persistence)) — so we don't have to pick a religion; the same provider does both. **One caveat to design around:** an open bug ([E2B #884](https://github.com/e2b-dev/E2B/issues/884)) breaks filesystem persistence after *multiple* pause/resume cycles (first resume is fine, later ones lose state) — workaround: **pause once per agent turn**, not per command.

**What the platforms do** (the industry has split by task type): **GitHub Copilot's coding agent = ephemeral per-task VM; Cursor and Devin each ship their own VM per task (Devin uses dedicated, longer-lived VMs); Replit Agent = a persistent project container** ([coding-agent sandbox survey](https://gist.github.com/wincent/2752d8d97727577050c043e4ff9e386e), [Northflank](https://northflank.com/blog/best-code-execution-sandbox-for-ai-agents)). The rule everyone converges on: **ephemeral for short tasks, stateful/fast-resume for long-running coding agents that check out a repo and iterate** ([Modal](https://modal.com/resources/best-code-execution-sandbox-replit-agent)). MicroVMs (Firecracker/Kata) give the strongest isolation (own kernel) — which is exactly what E2B is built on.

**Best-case for AoA → hybrid, and we already have the routing signal.** Ephemeral-per-run for the majority (Commander chat, crew replies, org agents posting comments/updates); warm per-agent (pause/resume) for `software_development` agents with a repo. AoA already distinguishes these via `functionType: software_development` + `executionWorkspacePolicy`, so the router can pick ephemeral vs warm per agent automatically.

---

## 9. What already exists (the starting point — you're not at zero)

- **A real E2B provider** — `createE2bSandboxRuntimeProvider` (`server/src/services/sandbox-provider-runtime.ts:340`): `import('e2b')`, `Sandbox.create/connect`, `commands.run`. Wired for **org agents** via the environment/lease orchestrator.
- **`provider-sandbox` execution-target type** + `environment_leases` (per-run leases) + `environment-run-orchestrator`.
- **The company-bound run-JWT** (`createLocalAgentJwt`) + **the HTTP MCP endpoint** with the agent-actor model (`server/src/mcp/server.ts`) — the exact credential + transport the networked broker needs.
- **The D1 guard** (`unsandboxed-multitenant-guard.ts`) + **cloud-environment-policy** (`cloud-environment-policy.ts:13-32` — on `cloud_auth`, only `driver:sandbox`+`provider:e2b` with `target == null` && `executionTargetId == null` is permitted; anything else throws `CLOUD_ENVIRONMENT_TARGET_UNAVAILABLE`. E2B is *already* the designated cloud isolation path).
- **Solid data-plane isolation** (§2) — the foundation that makes all of this safe regardless of sandbox granularity.

**Bottom line:** the data plane already guarantees org/company separation. The E2B work is a bounded execution-isolation project — its heart is **the networked broker (move the DB creds off the VM, reach the control plane via the run-JWT) + file movement + crew/Commander coverage + an operator-level E2B default.** The sandbox granularity is per-run (or per-agent warm), *not* nested per-company.
