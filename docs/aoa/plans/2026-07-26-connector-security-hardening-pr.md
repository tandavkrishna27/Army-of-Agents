# Connector Security Hardening — dedicated PR plan

> Fresh PR, branched off main **after #301 merges**. #301 ships the connector feature with these items documented-as-known; this PR closes them.

**Goal:** Close the two architecture-level connector security gaps Codex flagged (run-token isolation, package-identity command authorization) plus the smaller approval items — using the enterprise-grade patterns the research surfaced, not the bypassable quick fixes Codex already refuted.

**Proof this is real (empirical, 2026-07-26):** a probe stdio connector run through real `claude --mcp-config --strict-mcp-config` received `AOA_API_KEY` **and** an unrelated sentinel var in its env → Claude Code passes its **full parent environment** to stdio MCP children. No per-child allowlist exists. So the run token leaks to every connector child, and per-child scrubbing (Option B) is impossible on Claude Code.

**Enterprise-grade direction (from the research decision brief, `2026-07-26-connectors-codex-round2-hardening.md` sibling):** credential **brokering** — the secret never enters the untrusted process. The MCP spec itself mandates this ("servers MUST NOT accept tokens not issued for them"). Env-var scrubbing is hygiene, never the boundary.

## Locked founder decisions (2026-07-26)

1. **Connector runs strip BOTH run bearers.** On a connector-attached run, AoA removes `AOA_API_KEY` (raw REST) **and** `AOA_RUNTIME_HOOK_TOKEN` (runtime permission prompts) from the CLI env, across **org (heartbeat) + crew** agents and **all four adapters** (claude/codex/gemini/opencode). Commander is already clean (carries neither) — no change. Re-routing the hook through the bridge to preserve mid-run prompts (WS1 "Option 2") is a **fast-follow only if** founders report the gap — connector tools are already auto-allowed (FU-25), so the practical prompt loss is small.
2. **BYO stdio = consented exec on the founder's own machine.** In `local_trusted`, a founder may approve any **exact-version-pinned** BYO stdio command via the existing command-consent dialog (loopback trust = their own machine). The curated **catalog** gets the strict identity allowlist + registry/integrity pinning. `authenticated`/cloud BYO stdio stays rejected by D7 (unchanged).

**Product follow-up (not this PR):** no per-agent "Connectors" view exists — assignment is per-connector (Settings → MCP Connectors → choose agents). An agent-page connectors tab is a UX enhancement, filed separately.

---

## Workstream 1 — Run-token isolation (Option A: connector runs are MCP-only)

**Decision to lock first (founder):** on a connector-attached run the agent reaches AoA **only through the governed stdio MCP bridge**, never a raw REST bearer. This is a capability trade (no raw REST on connector runs) and a documented behavior change. The bridge is DB-direct + RBAC/actor-scoped and does **not** need the token, so the agent keeps full *governed* access.

### Task 1.1 — Automated leak-regression test (the probe, productized)
**Files:** new `packages/adapters/claude-local/src/server/__tests__/connector-env-no-run-token.test.ts` (+ codex sibling).
- [ ] A fake stdio connector command that records the env it was spawned with; run `execute()` with a connector present + `authToken` set; assert the recorded child env has **no** `AOA_API_KEY` (and no ambient AoA secret). A no-connector run keeps the token (byte-identity).
- [ ] This is the guard that makes Option A verifiable and prevents regressions. Ablation-verify it fails on today's code.

### Task 1.2 — Strip the token from the CLI parent env on connector runs (both sources)
**Files:** `packages/adapters/claude-local/src/server/execute.ts`, `packages/adapters/codex-local/src/server/execute.ts`.
- [ ] Guard the overlay injection (execute.ts:261): don't set `env.AOA_API_KEY = authToken` when `connectorsPresent`.
- [ ] **Also** drop an explicitly-configured `config.env.AOA_API_KEY` (the loop ~256-258) when `connectorsPresent` — Codex's refutation: guarding only the auto-injection still leaks a configured key (overlay-preserved). Net invariant: **no `AOA_API_KEY` reaches claude's env on a connector run, from any source.**
- [ ] Codex adapter: confirm/repeat for its run-token path (execute.ts:311 region). codex-exec already fully scrubs; ensure no overlay re-adds the token on connector runs.
- [ ] Remote execution targets still get the token via the `authToken` param (not env), so SSH runs are unaffected.

### Task 1.3 — Update agent instructions
**Files:** `server/src/onboarding-assets/**/AGENTS.md` (the `AOA_API_KEY` REST guidance ~L37).
- [ ] Document: "On a connector-attached run, use the AoA MCP tools; the raw REST token is not provided." Remove/qualify the "curl with `AOA_API_KEY`" guidance for connector runs.

### Task 1.4 — Capability-gap audit (correct end-state)
- [ ] Enumerate the AoA REST capabilities agents actually use on connector runs; expose any gap as a governed MCP tool so the token can be dropped on **all** connector runs, not just covered flows. Record residual flows (if any) for Workstream 3.

---

## Workstream 2 — Package-identity command authorization (stdio installs)

Codex refutation of the quick allowlist: `npx evil@1.0.0` passes a launcher-name+`@version` check but runs arbitrary code; `npx --package/--call`, `uvx --from/--with`, `node -e` bypass the grammar; and only the catalog path was gated (BYO `local_trusted` + stored rows bypass "regardless of mode"). Decision #116 clause 7 requires: **pinned versions, a command allowlist, no shell interpolation — in every mode** + an audit entry per spawn.

### Task 2.1 — `assertStdioCommandSafe` at the shared create chokepoint
**Files:** `server/src/services/cli-spawn-safety.ts`, wired into `createConnector` (shared chokepoint — covers BOTH BYO and catalog, all modes), not just the install route.
- [ ] **Closed per-launcher argv grammar** (not a denylist): for `npx`/`uvx`, parse the exact allowed flags; reject `--package`/`--call`/`--from`/`--with`/git sources/local paths/extra executables. Remove `node` (arbitrary `-e`/preload).
- [ ] **Exact version pinning:** the package spec must be `name@<exact-version>` (reject ranges, tags, `@latest`, URLs, git refs).
- [ ] **No shell interpolation:** reject shell metacharacters in command/args.
- [ ] **Package identity** (the real threat, per research — pinning ≠ authorization): start with an allowlist of known-good package identities for the curated catalog; BYO stdio in `authenticated`/cloud stays behind the D7 gate + consent. (Full integrity/provenance — e.g. registry digest pinning — noted as a follow-on.)

### Task 2.2 — Delivery-time revalidation (fail closed for legacy/imported rows)
- [ ] Re-assert `assertStdioCommandSafe` at delivery (`selectConnectorRowsForAgent`) so a row that predates this check, or arrived via import/direct-DB, fails closed instead of executing.

### Task 2.3 — Audit per spawn (Decision #116 clause 7)
- [ ] Since the CLI (not AoA) spawns the child, define the audit point as the **delivery/spawn-request** event (connector delivered to a run) with connector id + command + trust tier. Note the limitation (AoA cannot observe the actual child exec) in the decision record.

---

## Workstream 3 — Token hardening for residual REST (Option C), if any survive 1.4

- [ ] For any flow that genuinely cannot move to the MCP bridge: mint the run token **short-TTL, `aud`-bound to AoA's API, downscoped** to the minimum operations (RFC 8707 audience + RFC 8693 exchange, or a per-run macaroon). This caps blast radius + enables fast revocation where a token must remain. Do **not** invest in DPoP/mTLS (useless against an in-process sibling until the key lives in a separate process = the broker).

---

## Workstream 4 — Smaller approval items (fold in here)

- [ ] **F4 (P1) approval/activation atomicity** — wrap the approval flip + `applyConnectorApproval` (and the sibling `hire_agent`/`crew_dispatch` side-effects) in a shared transactional/reconciliation path so a mid-op DB failure can't strand an install. Cross-cutting across approval types — do it uniformly.
- [ ] **F2 (P2) deliverability preview** — surface a distinct "credential unresolvable" reason in the Settings projection when a bound secret is deleted/disabled, instead of showing a silently-skipping connector as healthy.

---

## Keep permanently (hygiene, not the boundary)
- Round-1 ambient-secret scrub (DB URL, provider keys, master key, GitHub PAT) stays — it's correct hygiene. Treat it as hygiene, never the isolation boundary (the token leak proves scrub-of-overlay can't be the boundary).

## Sequencing
1. **Founder decision** on Option A (MCP-only on connector runs) — the one gate.
2. WS1 (token isolation) — highest severity, small once decided. Ship first.
3. WS2 (command authz) — the RCE-surface control. Ship second.
4. WS4 (approval items) — independent, low risk, any time.
5. WS3 (token hardening) — only for residual REST flows WS1.4 can't eliminate.

## Verification bar (per the CI lessons)
- Run **full `pnpm build` + per-package suites** (db/ui/adapters/shared/server), not `--filter server` only.
- Real-DB integration + connector e2e (`AOA_E2E_FORCE_WINDOWS=1`).
- Ablation-verify every security regression test bites.
- Linux CI (push) is the authoritative gate.

---

## Codex plan review — BLOCKING corrections (2026-07-26)

Codex judged v1 **not sound**. Fold these in before executing.

### WS1 corrections
- **[P1] All FOUR adapters, not two.** Delivery supports claude/codex/**gemini**/**opencode** (`mcp-connectors.ts:149`). Gemini (`gemini execute.ts:189`) + OpenCode (`opencode execute.ts:182`) also inject `AOA_API_KEY` from both `config.env` and `authToken`. Cover all four + every heartbeat/crew/Commander delivery path.
- **[P1] A SECOND bearer leaks: `AOA_RUNTIME_HOOK_TOKEN`** (`claude execute.ts:559`) also rides the parent env; a connector can use it to submit **fabricated permission requests** to the runtime broker (`runtime-hooks.ts:58`). Explicit trade required: stripping it breaks legit runtime-permission routing on connector runs; keeping it is a spoofing surface. Likely resolution: strip on connector runs + accept no runtime-permission prompts there, OR move the hook off the shared env.
- **[P1] Stop overclaiming "brokering".** `buildMcpBridgeSpec` writes `DATABASE_URL` + the master-key file **path** into the MCP config file (`cli-mode.ts:225`); a **same-OS-user** connector can read that config or sibling-process state regardless of env. Option A's real guarantee = "the run API bearer + runtime-hook bearer don't reach connector children," **NOT** "no AoA secret is reachable." The residual (same-user config/sibling read) only closes with **OS sandboxing** (separate least-priv user / container) — which AoA can't do while the vendor CLI spawns the child. State this as a known limitation.
- **[P1] Value-based strip, not just key names.** Strip case-folded `AOA_API_KEY` + wire alias `PAPERCLIP_API_KEY`, AND drop any overlay entry whose **value == authToken** (a configured arbitrary key could carry it).
- **[P2] Fix the remote-target claim.** No SSH here. Local ignores `authToken`; sandbox-docker **uses** it in a host callback bridge; provider sandbox ignores it (`execution-target.ts:511`). Pass `authToken: null` explicitly on connector runs so future target changes can't reintroduce it.
- **[P2] Test design.** `execute()` doesn't spawn the connector — the vendor CLI does. Add **parent-env unit tests per adapter** (assert the env AoA hands the CLI lacks both tokens); keep the real-claude probe as an opt-in integration test.

### WS2 corrections
- **[P1] Grammar authorizes an IDENTITY; it cannot make stdio non-arbitrary.** An approved package's entry point + build backend + **lifecycle scripts** + transitive deps are executable code. Model it as "an approved package runs code," not "grammar eliminates arbitrary exec."
- **[P1] Package identity is redirectable** via `npm_config_registry` / `.npmrc` / `UV_INDEX_URL` / `PIP_INDEX_URL` / mirrors / caches / locally-installed pkgs → a permitted `name@version` can resolve to attacker bytes. Must ALSO pin the **registry/config**, isolate cwd/cache, pin the **launcher binary**, and verify **distribution integrity (digest)** or vendor the approved artifacts.
- **[P1] Resolve the BYO contradiction.** Decision #116 permits BYO stdio in `local_trusted`; authenticated/cloud BYO stdio is **rejected by D7** (consent applies to CATALOG entries, not BYO). Founder must choose: (a) BYO must also match an operator identity allowlist (ends unrestricted local BYO), or (b) founder-approved exact identities = **explicitly consented arbitrary host exec** (not a known-good allowlist).
- **[P1] Delivery revalidation must SKIP, not throw.** Throwing in `selectConnectorRowsForAgent` fails the whole load → drops every healthy connector. Add an `unsafe_command` skip reason, surface it in deliverability, apply the same predicate to connector-tool auto-allow.
- **[P1] "Audit per spawn" is mischaracterized** — a delivery event isn't a spawn (CLIs lazily start/restart/cache/never start). Either rename to `mcp_connector.delivered` + amend Decision #116, or add an AoA-controlled launcher wrapper at the real exec boundary.
- **[P2]** Exact pinning IS meaningful under a trusted registry (immutable published versions) — but it's version-drift protection, not provenance/digest.

### WS3 — simplify
- **[P2]** Don't build RFC 8707/8693 unless WS1.4 proves a connector run still needs REST. Audience-binding adds little when every op targets one AoA API; token-exchange is over-engineering for an internally-minted run JWT.

### WS4 — reclassify
- **[P1]** Atomicity boundary belongs in the approval **service** (HTTP already wraps `approve()` in a tx; MCP calls it directly + logs after). DB mutations in one tx; external effects via outbox/idempotent reconcile.
- **[P2]** NOT "low risk" — it moves hire_agent/connector/crew/activity/hub/wakeup under one boundary → high-regression; give it its own failure-injection matrix.
- **[P2]** F2 needs a grouped company-scoped secret-state query (don't decrypt during list); thread the new reason through server types → UI types → render → tests.

**Highest-risk to get wrong:** omitting Gemini/OpenCode; leaking the runtime-hook token; trusting package names without registry/integrity pinning; approval atomicity only in HTTP routes.

**Meta-conclusion:** Option A is still correct and still the boundary — but the honest framing is **"remove the two run bearers from connector children; the same-user residual needs OS sandboxing to fully close."** WS2 is bigger than a validator: it's registry/integrity pinning + a BYO policy decision. Both need a founder decision recorded before execution.
