# Connector Hardening + Live Verification Plan

**Date:** 2026-07-25
**Branch:** `integration/connectors-marketplace`
**Goal:** close every fixable follow-up, then prove the whole journey works live — browse → install → bind → an agent actually uses the connector.
**Register:** `docs/aoa/plans/mcp-connectors-followups.md` (FU-1…FU-23)

---

## 1. Triage — the honest state of the 22

"Fix all 22" is the wrong target. Two are already closed, two cannot be fixed, two are
decisions, and one blocks the live demo. Grouped by what action they actually need:

### Already closed — register is stale (verify + mark)
| FU | Why |
|----|-----|
| **FU-17** approval role gate | Fixed in `d322de0a2` — `install_mcp_connector` now requires founder or team_lead on approve/reject/request-revision |
| **FU-16** credential axis dormant | Resolved by Task 11 — the catalog install route is the first live producer of `requiresSecret: true` |

### WON'T FIX — documented limits, no known remedy
| FU | Why |
|----|-----|
| **FU-4** gemini `folderTrust` | `--skip-trust` and per-server `trust` both **empirically disproven**; no trust registry AoA can write. Detect-and-warn is shipped. Revisit only if gemini-cli changes. |
| **FU-5** codex stdio secrets | Codex expands no `${VAR}` in stdio and does not pass its env to MCP children. No route exists. Skips with a reason. Both "fixes" are forbidden (one writes a live token to disk, the other leaks every env var into every shell command). |

### WAVE 1 — blocks the live demo or is actively unsafe
| FU | Sev | What |
|----|-----|------|
| **FU-21** | P1 | `claude_local` drops `authTokenEnvVar` → every catalog HTTP connector authenticates as no-one, on the default adapter. **Blocks the end-to-end test.** |
| **FU-19** | P1 | D7 is create-time only; delivery never re-asks. A stdio connector created under `local_trusted` keeps executing after conversion to `authenticated`. |
| **FU-20** | P1 | A literal credential pasted into `headerTemplate`/`envTemplate`/`args` is stored in plain jsonb (not `company_secrets`), written to CLI config on disk, and logged. |
| **FU-22** | P1 | One **additive optional** field in `connectors.json` drops every entry and overwrites the cache, reported as fresh. Directly hostile to our own publish plan. |
| **FU-23** | P1 | The env-scrub module is dead code, so AoA's own secrets reach every third-party MCP child. ⚠ `DATABASE_URL` is deliberately exposed for the AoA bridge — a naive fix breaks it. |

### WAVE 2 — correctness and visibility
| FU | Sev | What |
|----|-----|------|
| **FU-18** | P2 | `/approvals/:id/resubmit` has no board gate. Inert for connectors (system-internal denylist) but live for `hire_agent`. Correct shape: board **or** the requesting agent. |
| **FU-1** | P1 | Delivery skips are invisible — a connector silently not delivered, with the reason only in a run log. Contradicts the workstream's stated goal. |
| **FU-21b/FU-8** | P2 | Commander's codex path passes no connectors at all. |
| **FU-2** | P2 | `${TOKEN}` in a stdio `command` is never substituted — undocumented hole in the substitution surface. |
| **FU-14** | P1 | `catalog.json` is fleet-brittle: one unknown enum value freezes the catalog on every deployed instance. Affects all item types, not just connectors. |
| **FU-13** | P2 | `github-integration` asserts the wrong host and **is red on `origin/main`** — blocks the required `verify` check for every PR. |

### WAVE 3 — housekeeping
FU-3 (same-cwd read-modify-write race), FU-6 (gemini stdio unverified live), FU-7 (duplicate
TOML header), FU-11 (codex managed-home cleanups), FU-12 (wall-clock flakes).

### DECISIONS — not bugs
| FU | Question |
|----|----------|
| **FU-9** | Catalog does not scale past ~10k items. A constraint 3b must design around, not a defect. |
| **FU-10** | Founder + team_lead may approve (**decided**). The *member-request* path does not exist yet — new functionality, not a missing check. |

---

## 2. Wave 1 — detail

### FU-21 — claude_local must honour `authTokenEnvVar`
`buildMcpConfig` (`server/src/services/internal-agent/cli-mode.ts:231`) maps http specs to
`{type, url, headers}` and discards `authTokenEnvVar`. Codex uses `bearer_token_env_var` /
`env_http_headers`; opencode synthesises `Authorization: Bearer {env:VAR}`. Claude must
synthesise `Authorization: Bearer ${VAR}` when a secret exists and no header references it —
the same rule, on the adapter that matters most.

⚠ Claude expands `${VAR}` in `--mcp-config` (verified live in Plan 2b). Do **not** write the
value; write the placeholder.

### FU-19 — re-assert D7 at delivery
Add a D7 check on the read/delivery path and a `ConnectorSkipReason` value for it (FU-1
already names a "D7 block" reason that does not exist). A connector that is no longer
admissible must be **skipped with a reason**, not delivered.

### FU-20 — reject literal credentials at the boundary
`templateRecord = z.record(z.string(), z.string())` constrains keys and nothing else. Require
template *values* to be either empty or a `${…}` placeholder, on create and on any path that
writes them. A founder pasting a real token should get a clear 400 telling them to use a
secret ref — not silent plaintext persistence.

### FU-22 — an all-dropped payload must not replace a good shelf
`McpConnectorCatalogEntrySchema` is `.strict()`, so one additive optional field drops every
entry with `malformed: false`, and the cache treats that as a real answer.

Two changes, both needed:
1. Make the entry schema tolerate **unknown optional fields** (that is what Decision #96's
   `.strip()` is for) while keeping `.strict()`-like rejection of the things that matter —
   a field carrying a secret value must still be refused.
2. Treat "every entry dropped and there was at least one" as suspicious: keep the cache and
   report `stale: true`, rather than publishing an empty shelf as fresh.

⚠ A legitimately empty `entries: []` must still replace the cache — a curator withdrawing
every connector is a real state.

### FU-23 — make the env scrub live, without breaking the bridge
`buildConnectorProcessEnv` / `mergeConnectorEnv` are imported by nothing. Route connector
spawns through them. ⚠ `buildScrubbedCliEnv` removes `DATABASE_URL`, which `index.ts:450`
deliberately exposes so the AoA MCP bridge child inherits it — a naive routing breaks the
bridge. Establish what each child legitimately needs before scrubbing.

---

## 3. Live verification (the point of all this)

Runs against a real instance, from the browser, after Wave 1:

1. **Browse** — Marketplace → Connectors shows the shelf.
2. **Install** — a verified HTTP connector (Notion) installs into the selected company.
3. **Consent** — an unverified stdio entry shows the exact argv and blocks Install until confirmed.
4. **Appears** — Settings → Connectors shows it as **Needs setup**.
5. **Bind** — add a credential → status flips to **active**.
6. **Enable** — grant it to a specific agent.
7. **USE IT** — an agent run (and Commander) actually calls a tool on that connector and gets
   a real response. This is the step FU-21 currently breaks and the only one that proves the
   whole chain.

Step 7 is the acceptance criterion. Everything before it is necessary and insufficient.

---

## 4. Sequencing

Wave 1 → live verification → Wave 2 → Wave 3 → Plan 3b.

Wave 1 first because FU-21 makes step 7 impossible and FU-22 makes our own CDN publish
dangerous. Live verification before Wave 2 so a real failure re-prioritises the rest.
