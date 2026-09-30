# MCP Connectors — Follow-up Register

Everything identified across Plans 1, 2 and 2b that was **deliberately not fixed in place**,
plus constraints discovered along the way that future work inherits.

Kept as a standing document so these do not survive only as buried plan amendments.
Last updated 2026-07-24 (`integration/connectors-marketplace`; FU-17…FU-23 added by
Plan 3a Task 12's adversarial sweep, on top of HEAD `dab442416`).

Severity: **P1** = user-visible correctness or security · **P2** = robustness / maintenance ·
**P3** = docs, cleanup, cosmetics.

---

## Open

### FU-1 — Connector delivery skips are invisible to founders · P1
*Tracked as session task #27.*

A connector can be skipped at delivery time (`secret_unreachable`, `reserved_name`, D7 block)
and today that lands **only in a run log line**. Server-side `ConnectorSkipReason` goes to
`logger.warn` (`server/src/services/mcp-connectors-loader.ts:180`); `MCPConnectorsSection.tsx`
shows no health or last-skip state. A founder must open the specific run's log and know to
look for it.

This directly contradicts the stated goal of the whole workstream — *no connector ever
vanishes silently*. Fix: a per-connector "not delivered to `<agent>`: `<reason>`" badge in
Settings. Plan 3 §4.6 should share this surface with the "Needs setup" badge; both answer
"why isn't this connector working?"

### FU-2 — `${TOKEN}` in a stdio `command` is never substituted · P2
`buildConnectorSpecs` substitutes placeholders in `args`, `envTemplate` and `headers`, but
copies `command` verbatim. So `command: "/opt/${TOKEN}/srv"` emits the literal `${TOKEN}` to
codex and opencode with no skip. It fails loudly at spawn rather than silently, and the
writers are self-consistent with the builder — but it is an undocumented hole in the
substitution surface. Either substitute it or reject it at create time.

### FU-3 — Concurrent runs in the same cwd race on config read-modify-write · P2
Individual writes are atomic (`renameWithRetry`), but read-modify-write is not. Two
simultaneous `writeOpenCodeMcpConfigJson` calls in one cwd produced `config=[aoa,alpha]`,
losing `beta`. Pre-existing for the MCP bridge; connectors widen the blast radius. Needs a
lock or a per-run config path.

### FU-4 — gemini loads ZERO MCP servers under `folderTrust` · P1 (no known remedy)
With `security.folderTrust.enabled: true`, gemini disables **every** MCP server including
AoA's own bridge, so gemini agents get no tools at all.

**Empirically disproven remedies** (probed 2026-07-24 with a stdio recorder, isolated HOME):

| config | result |
|---|---|
| plain | not spawned — "folder is untrusted" |
| `--skip-trust` | **not spawned** (warning suppressed, servers still disabled) |
| per-server `"trust": true` | not spawned |

All three spawn normally when `folderTrust` is disabled (the default). There is no trust
registry AoA can write — `~/.gemini/projects.json` is only a project-name map and no
`trustedFolders.json` is ever created.

Shipped mitigation: detect-and-warn, implemented in
`packages/adapters/gemini-local/src/server/execute.ts` (tests in
`__tests__/gemini-folder-trust.test.ts`). **Do not "fix" this by
adding `--skip-trust`** — it advertises "Trust the current workspace for this session" but
does not re-enable MCP. Plan 2b amendment B7-CORRECTED holds the detail. Revisit if
gemini-cli changes behaviour upstream.

### FU-5 — codex cannot deliver stdio connectors that carry a secret · P2 (by design)
Codex expands no `${VAR}` in stdio `args`/`env` **and** does not pass its own environment to
MCP children, so there is no route for the credential. Such connectors are skipped with
`secret_unreachable`.

**Forbidden "fixes"**, recorded so nobody re-derives them: expanding the placeholder at
write time puts a live token on disk and reverses D5; `shell_environment_policy.inherit=all`
is global and would leak every env var — including other connectors' tokens — into every
shell command the agent runs.

Only resolvable if codex adds stdio env-var-name indirection (it has `bearer_token_env_var`
and `env_http_headers` for HTTP only).

### FU-6 — gemini stdio expansion never re-confirmed live under trust · P3
The per-CLI matrix's gemini stdio row rests on a single probe. The Task 7 reviewer could not
re-verify it because servers never spawned under folder trust, and the model call 403s on
this machine's API key. Re-probe on a gemini install with working quota.

### FU-7 — codex emits a duplicate table header on out-of-fence collision · P3
If a user hand-writes `[mcp_servers.notion]` outside the AoA-managed fence and a managed
connector has the same name, both headers land in `config.toml`. Codex takes last-wins, so
it is cosmetic — but confusing to read.

### FU-8 — Commander's codex path passes no connectors · P2
Plan 2 wired Commander connector delivery for the claude path; `cli-mode.ts`'s codex branch
does not pass `mcpServers`. Pre-existing, not a Plan 2b regression, but it means a
codex-mode Commander sees no external connectors.

### FU-9 — Marketplace catalog does not scale past ~10k items · P2 (constraint)
The browser downloads the **entire** catalog (`ui/src/api/marketplace.ts:105`) and every
filter/sort is a pure client-side function. Measured 2026-07-24: **1.47 MB / 514 items**,
~2,154 B per non-skill item.

This is why Plan 3 rejects bulk registry import (design §3.2) and uses a search endpoint.
Any future work that wants a large catalog must first add server-side search and pagination
— which affects every item type, not just connectors.

### FU-10 — Governance: authenticated-mode activation is approval-only · P3 (decision)
A founder **cannot** self-activate a connector via PATCH in `authenticated` mode; the
`install_mcp_connector` approval is the sole activation path (C2). This is deliberate and
strict. Open question for the founder: relax to self-serve, or keep board accountability?

### FU-11 — codex managed-home cleanups (Plan 2b B2N8) · P3
(a) `CODEX_ENV_TEST_AGENT_ID` is reachable by normalisation — any id starting with a
non-allowlisted char followed by `env-test` collapses onto `_env-test`. Unreachable from the
DB (uuid PKs), but a sibling root would make collision structurally impossible.
(b) Orphaned legacy per-company homes (`~/.codex/aoa-instances/<companyId>/…`) are no longer
read and are never swept.
(c) `docs/aoa/plans/2026-06-24-provider-switching-watched-walkthrough.md:98,116,128,146`
still documents the per-company path with stale line numbers.

### FU-16 — the credential axis is DORMANT: nothing sets `requiresSecret: true` yet · P2
Recorded so the state of this subsystem is not overread.

`requires_secret` is `notNull().default(false)`, and every live writer sets it **false**:
the BYO create route hard-codes `requiresSecret: false` (`routes/mcp-connectors.ts:228`,
a founder supplies credentials up front) and `mcpConnectorService.create` defaults
`input.requiresSecret ?? false`. `McpConnectorCatalogEntrySchema` carries the field
(`packages/shared/src/mcp-connector-catalog.ts:65`) but nothing feeds a catalog entry into
`createConnector` yet.

So `needs_credentials` is currently **unreachable in production**, and every guard built for
it — credential-aware approve/reject, the binding endpoint, the FU-15 PATCH gate — is
correct-in-advance and exercised only by unit tests against synthetic rows. That is
deliberate, not a gap; the axis wakes up when the catalog install route lands (Plan 3a
Task 10/11).

⚠ **Task 13's integration test must explicitly cover it**: install a catalog connector with
`requiresSecret: true`, assert it lands `needs_credentials` and is NOT delivered by
`selectConnectorRowsForAgent`, bind a secret, assert it flips `active` (or stays
`pending_approval` in `authenticated` until the board approves) and only then reaches an
agent. Without that, the first real `needs_credentials` row in the fleet will be the first
one anything has ever seen.

### FU-14 — `catalog.json` parsing is fleet-brittle: one unknown enum value freezes it · P1
Discovered while designing Plan 3, and the reason connectors ship in their own
`connectors.json` rather than as a new catalog item type.

`server/src/services/aoa-marketplace.ts:107` does `MarketplaceCatalogFileSchema.parse(json)`
and `type` is a hard `z.enum`. **One** item with an unknown type fails the whole-array
parse; the catch at `:116` calls `writeCache(null, "cdn", "failure", …)` which *preserves
the existing catalog*. Proven live against the real 514-item catalog: adding a single
`type: "connector"` item flips `safeParse` from `true` to `false`.

So any instance running an older shared package would serve its last good catalog
**forever**, silently — for skills, agents, teams and plugins too — with the reason visible
only in `lastSyncStatus`. Not an error, just permanent staleness.

⚠ **Decision #96 does not cover this.** #96 permits additive *optional fields* because zod
`.strip()` drops unknown keys; `.strip()` does nothing for an unknown **enum value**.
`MarketplaceCategorySchema`, `MarketplaceTagSchema`, and `isSchemaVersionSupported`
(strict equality on `"1.0.0"`) have the same blast radius.

Because AoA is self-hosted, the fleet cannot be forced to upgrade, so this constrains every
future catalog schema change. Fix: per-item `safeParse` with drop-and-warn, or `type` as
`z.string()` with a known-type refinement at the render/dispatch layer — shipped as a
forward-compat release *before* any CDN change that relies on it.

### FU-17 — the `install_mcp_connector` approval carries NO role gate · P1
*Found by the Task 12 adversarial sweep. Regression tests:
`server/src/__tests__/mcp-connector-approval-adversarial.test.ts` (`[ESC-1]`).*

Every connector mutation in `routes/mcp-connectors.ts` is founder-only, and C2 blocks
even the founder from PATCH→active in `authenticated` **precisely so that activation
flows through this approval**. But `POST /approvals/:id/approve` (`routes/approvals.ts:132`),
`/reject` (:260) and `/request-revision` (:305) run only `assertBoard` +
`assertCompanyAccess` — no `assertRole`, and `approve()` itself does no role lookup.

So a plain **`team_member`** can activate a connector (real `applyConnectorApproval` →
`updateIfStatus(id, "pending_approval", {status:"active"})`), after which Commander
receives it with no founder step at all (D3 exempts Commander from the founder-only
per-agent opt-in) and the CLI spawns the command on the AoA host. The same actor can
`reject` a founder's pending connector to `disabled`, which is **terminal** in
`authenticated`. The pending payload is also returned unredacted by
`GET /companies/:cid/approvals`, so the target id is discoverable.

The asymmetry that shows this is an oversight, not a decision: the identical action via
the MCP `approval-decision` tool **does** require founder. The HTTP door is weaker than
the MCP door.

⚠ **The fix is a governance decision, not a patch** — see FU-10. Founder-only makes the
approval a self-approval formality in `authenticated` (the founder both requests and
resolves it), which is arguably not what D6's "board approval" meant. Options: (a)
founder-only, matching connector CRUD; (b) `team_lead`+; (c) require a decider distinct
from the requester. Whichever is chosen must be **type-scoped** — `hire_agent` and
`approve_ceo_strategy` are genuinely board decisions and must stay board-resolvable.

### FU-18 — `POST /approvals/:id/resubmit` has no board gate · P2
*Connector-specific half CLOSED (see below); the route-level hole remains.*

The handler runs `assertCompanyAccess` and one actor check that fires **only** for
`type === "agent"`. An `mcp` API-key actor — not a board user at all — reaches it and
rewrites `payload` wholesale (`z.record(z.unknown())`); `boardMutationGuard` does not
cover it either (it only inspects `board` actors).

⚠ **Do NOT "fix" this with a bare `assertBoard(req)`** — that would 403 the *requesting
agent*, which this route deliberately supports. The right shape is "board OR the
requesting agent". There is a `REGRESSION FLOOR` test pinning the agent path.

### FU-19 — D7 is a CREATE-TIME-ONLY gate; delivery never re-asks · P1
*Regression tests: `mcp-connector-install-adversarial.test.ts` (`[ESC-3]`).*

`assertTransportAllowed` has exactly three call sites, all in `routes/mcp-connectors.ts`
(shelf projection :360, install :429, BYO create :497). None is on the read/delivery
path, and `ConnectorSkipReason` has no D7 value — the "D7 block" reason FU-1 already
names **does not exist**.

Consequence: a founder registers a `stdio` BYO connector under `local_trusted`
(permitted, `status: "active"`), the operator later converts the instance to
`authenticated` (`AOA_DEPLOYMENT_MODE` + restart; the DB carries over). The row is
untouched, `selectConnectorRowsForAgent` still returns it, `buildConnectorSpecs` still
emits `{kind:"stdio", command:"npx", …}` with `skipped: []`, and the command now runs on
a multi-tenant host — the exact thing D7 exists to prevent. Verified live against
embedded-postgres: after the flip `assertTransportAllowed("stdio","authenticated","byo")`
throws while the identical connector is still delivered.

Fix: re-assert the gate at delivery (`selectConnectorRowsForAgent` /
`loadEnabledConnectorRows`, reporting a `d7_blocked` skip reason — which also needs
FU-1's surface), **or** sweep on mode transition and flip such connectors to `disabled`.
A gate whose whole justification is "may this host execute this command" must be
evaluated against the host's *current* mode.

### FU-20 — a literal credential in `headerTemplate` / `envTemplate` / `args` is accepted end-to-end · P1
*Regression tests: `mcp-connector-install-adversarial.test.ts` (`[ESC-4]`).*

`templateRecord = z.record(z.string(), z.string())` constrains keys but imposes **nothing
on values**, and nothing downstream does either. A founder who pastes a real token gets
it stored in `company_mcp_connectors.header_template` — plain jsonb, **not** the
encrypted `company_secrets` store — and from there:

- (a) written verbatim into `<CODEX_HOME>/config.toml` and into `<cwd>/opencode.json`,
  where *cwd is the agent's working directory* (a git repo the agent can commit and push);
- (b) returned in full by `GET /companies/:cid/mcp-connectors`, which is `assertBoard`
  only with **no founder check** — every board member reads it back;
- (c) **not** masked by `redactSensitiveBodyFields`: the patterns are anchored
  (`/^api[_-]?key$/i`), so `X-Api-Key` passes straight through and the error handler logs
  the full value on any 5xx.

Three independent decisions, each with a `.fails` test: reject literals at write time
(what counts as a literal? entropy? prefix? an `${...}` allow-shape?); widen redaction to
substring-match header-ish key names (blast radius: every log in the app); strip templates
from the list route for non-founders (or make list founder-only).

✅ **Partially mitigated in Task 12**: the Settings header hint said
`Authorization: Bearer ${MCP_TOKEN}`, but `buildConnectorSpecs` substitutes **only** the
literal `${TOKEN}` — so a founder copying the app's own example built a connector that
authenticates as no-one, and the obvious workaround is pasting the real token. Both the
placeholder and the `${VAR}` helper text now say `${TOKEN}`, with a regression guard.

### FU-21 — `claude_local` drops `authTokenEnvVar`: catalog HTTP connectors authenticate as no-one · P1
*Regression tests: `mcp-connector-install-adversarial.test.ts` (`[ESC-5]`).*

D5 seeds catalog template KEYS with empty values, so a bound-secret http connector's spec
is `{kind:"http", url, headers:{Authorization:""}, authTokenEnvVar:"AOA_MCP_X_TOKEN"}` —
the credential signal rides on `authTokenEnvVar` alone. `buildMcpConfig`
(`internal-agent/cli-mode.ts:231`) maps http specs to `{type, url, headers}` and
**discards** it, emitting `{"type":"http","url":…,"headers":{"Authorization":""}}` with
`skipped: []` while the real token sits unused in the spawn env.

codex synthesises `bearer_token_env_var`, opencode `Authorization: Bearer {env:…}`, gemini
`Authorization: Bearer ${…}` — all per commitment I3 ("an empty map would emit a remote
server with NO auth and no skip… synthesise the conventional bearer header instead").
claude, the default adapter for heartbeat **and** Commander, does neither. This is exactly
the first-real-`needs_credentials`-row failure FU-16 warns about.

Not patched here because the right expansion syntax for claude's `.mcp.json` headers needs
an empirical check (a wrong guess ships a literal `${VAR}` — FU-2's failure mode in a new
place). Minimum: stop emitting empty-string header values.

### FU-22 — one additive `connectors.json` field empties the shelf fleet-wide, reported as fresh · P1
*Regression tests: `mcp-connector-install-adversarial.test.ts` (`[ESC-6]`).*

`McpConnectorCatalogEntrySchema` is `.strict()`, so a purely **additive optional** field
(say `iconUrl`) on every entry drops every entry: `{entries: [], dropped: [a,b,c],
malformed: false}`. The cache layer (`services/mcp-connector-catalog.ts:134-144`) reads
`malformed: false` as a real CDN answer, so it sets `cached = []` **and refreshes
`fetchedAtMs`** — the empty shelf is returned with `stale: false` (the founder is told it
is healthy) and pinned for another 6 h with no refetch. Every older instance in a
self-hosted fleet loses its whole connector shelf from one forward-compatible publish.
The only trace is a `logger.warn`, invisible in the API response (same class as FU-1).

The distinguishing signal already exists and is discarded: a curator legitimately emptying
the shelf yields `dropped.length === 0`; this yields `dropped.length === N`.

⚠ **This is a decision, not a bug fix** — `mcp-connector-catalog-service.test.ts:282`
deliberately asserts the opposite ("an all-dropped payload still replaces the cache —
every entry was answered for"), and that test only ever exercises a *structurally broken*
entry, never a well-formed-but-newer one. Reversing it must be explicit. Options: treat
`kept === 0 && dropped > 0` like a malformed envelope (keep cache, `stale: true`, do not
refresh `fetchedAtMs`), or drop `.strict()` so unknown fields are stripped per-entry.
Note this is the connector-side twin of FU-14 and constrains every future CDN change.

### FU-23 — the connector env-scrub module is dead code · P1
*Regression tests: `mcp-connector-install-adversarial.test.ts` (`[ESC-7]`).*

`buildConnectorProcessEnv` / `mergeConnectorEnv` (`services/mcp-connectors-env.ts`) are
referenced by **nothing** except their own unit test. Production merges connector tokens
into `config.env` and every connector-capable adapter spawns the CLI with the full
unscrubbed server environment (`claude-local/…/execute.ts:251`, `opencode-local:235`,
`gemini-local:242`, Commander's `cli-mode.ts`). The CLI then spawns each stdio connector
as a child that inherits it — verified live with a minimal 18-key env and a recorder MCP
server: `DATABASE_URL`, `BETTER_AUTH_SECRET`, `AOA_AGENT_JWT_SECRET`, `GITHUB_PAT`,
`OPENAI_API_KEY` and every *other* connector's `AOA_MCP_*_TOKEN` all reached the child.
Only codex is protected, and only incidentally (B2N9).

The module's own header promises "AoA's own secrets must never reach a third-party
server", so today it reads as an implemented control that is not implemented.

⚠ **Not a drop-in wiring job**: `buildScrubbedCliEnv` removes `DATABASE_URL`, which
`server/src/index.ts:450` deliberately exposes *so the AoA MCP bridge child can inherit
it*. Scrubbing at the adapter boundary would break the bridge. Needs per-child scoping
(bridge keeps its env, connector children get the scrubbed one), which the current
single-`spawnEnv` shape cannot express. Either do that or delete the module.

---

## Pre-existing, not caused by this work

### FU-12 — wall-clock assertions flake under full-suite load · P2
`discussions-routes-contract`, `teams-routes-contract` and `routines-routes-contract` each
failed a 3000 ms budget under full-suite load and passed in isolation (e.g. 1482 ms). It is
not a specific file — it is whichever loses the scheduling race. Either raise the budget or
stop asserting wall-clock in a parallel suite.

**Widened 2026-07-24 (Plan 3a Tasks 7/8):** the same class also hits
`packages/adapters/opencode-local` — `execute-target.test.ts` and
`execute-mcp-gate.test.ts` spawn real subprocesses, take ~3.9 s each in isolation, and hit
the 30 s `testTimeout` under load. Measured across three consecutive full-suite runs on an
unchanged tree the failing set was 6, 4 and 7 files, always drawn from this pool — so a
full-suite failing-file count is only meaningful when diffed against a baseline run on the
same machine, and any file in this pool must be re-run in isolation before it is called a
regression.

### FU-13 — `github-integration` test asserts the wrong host · P2
Expects `http://localhost:5173/…`, gets `http://127.0.0.1:3100/…`. Confirmed failing on
clean HEAD.

---

## Closed during Plan 3a (recorded so they are not re-opened)

- **Confused-deputy payload swap on `install_mcp_connector` approvals** (Task 12) ·
  found by the adversarial sweep. `approvalService.resubmit` rewrites `payload`
  wholesale and its system-internal denylist covered only `crew_dispatch`. So an actor
  who could reach `request-revision` (any board member) then `resubmit` (any
  company-scoped actor, including an MCP API key — FU-18) could point an approval at a
  *different* `connectorId` while it kept displaying the original `serverName`: the
  founder approves "notion" and an `npx`-spawning stdio connector goes `active`,
  including one whose own approval is still pending or already rejected. Fixed by
  hoisting the denylist to an exported `SYSTEM_INTERNAL_APPROVAL_TYPES` set and adding
  `install_mcp_connector` — it is not in `CREATABLE_APPROVAL_TYPES` (nor even in
  `APPROVAL_TYPES`); its only producer is `createConnector`. Add any future
  system-internal type to that set in the same commit.

- **FU-15 — `local_trusted` PATCH could set `active` on an uncredentialed connector** ·
  found while closing C2/C3, was the last exception to invariant #3. Fixed in the PATCH
  handler: activation is now refused, in **every** deployment mode, unless
  `resolveConnectorStatus` would permit `active` on the credential axis — the founder is
  pointed at `POST …/:id/credentials` instead. `local_trusted`'s *governance* latitude is
  untouched (a connector needing no secret can still be hand-flipped
  `active → disabled → active`). With this, the "never `active` while a required secret is
  unbound" invariant is codebase-wide: `company_mcp_connectors` has exactly two writers and
  every route into them consults the resolver.

## Closed during Plans 1/2/2b (recorded so they are not re-opened)

- **RCE chain** — missing D7 stdio gate + PATCH `pending_approval→active` + client-trusted
  `source`. Fixed as a set; `source` is now server-forced.
- **Arg-injection bypass** — the crew runner sanitised `args` while the adapter *prefers*
  `extraArgs`, so a founder's path survived and AoA's own config was shadowed. Fixed by
  targeting the adapter-preferred key.
- **Data-loss bug** — an unmatched `# >>> aoa-managed` comment in a user's config caused
  strip-to-EOF, silently deleting the remainder. Fixed: unmatched start fence is not a
  fence, plus atomic write.
- **Silently unauthenticated codex connectors** — non-bearer HTTP auth was dropped and a
  bogus `Authorization` invented. Fixed via `env_http_headers` (verified live: the real
  header value reaches the server).
- **In-file catalog marker key is fatal on opencode** — an unrecognised top-level key makes
  opencode reject the *entire* config, loading zero MCP servers including AoA's bridge.
  Hence the sidecar manifest, stored outside the agent cwd.

### FU-24 — shelf offers uninstallable unverified-stdio connectors when the signing secret is unset · P2
Found in live verification 2026-07-25. The shelf projection (`routes/mcp-connectors.ts:401-418`)
correctly omits `consentToken` when `resolveConsentSecret()` throws (neither `BETTER_AUTH_SECRET`
nor `AOA_AGENT_JWT_SECRET` set) — it logs a warning and degrades. But `installable` stays `true`
and `consentRequired` stays `true`, so the UI renders an enabled Install button + consent dialog
for an unverified stdio entry that **can never install**: the founder confirms, the request goes
out with no token, and the install route 400s ("Review the exact command … and confirm it").
The founder sees a dead button and an unexplained failure; the real reason (no server signing
secret) is only in a log line nobody reads.

Fix options: (a) when `secret` is null, mark consent-requiring entries `installable: false` with
an `unavailableReason` naming the misconfiguration, so the shelf shows them as unavailable rather
than falsely actionable; or (b) surface a single shelf-level banner "consent-gated installs are
unavailable: server signing secret not configured". (a) is consistent with how D7-refused entries
already render. Real deployments set a signing secret (both names are provisioned by
`pnpm aoa onboard`), so this bites dev/misconfigured instances — but a silently-dead Install button
is exactly the "capability vanishes with no explanation" failure this workstream exists to prevent.
Note: HTTP connectors are unaffected (they need no consent token).

---

## Live round-trip PROVEN (2026-07-25)

A real heartbeat agent run (claude_local, run `a8fe4d6b`) called an installed filesystem
connector end-to-end: `list_allowed_directories` → `list_directory` → `read_text_file`, and
got back the exact file contents (`"hello from the connector round-trip test — written
2026-07-25"`). This proves the whole chain live: install → per-agent assign → agent run →
MCP config built (FU-21 path) → env scrubbed (FU-23: `mcp__aoa__*` bridge AND
`mcp__filesystem__*` connector both present) → npx server spawned → connected → tool called →
real data returned. Not a test — a live run.

### FU-25 — agents can't call connector tools unattended without dangerouslySkipPermissions · P2
The FIRST run (`f2e1a585`) had the connector fully delivered — `mcp__filesystem__*` tools were
in the session — but every tool call returned "Claude requested permissions … but you haven't
granted it yet", and the agent burned the whole run fighting the permission bridge (env
expansion + curl also blocked) and exited without doing the task. Setting
`adapterConfig.dangerouslySkipPermissions: true` on the agent fixed it (run `a8fe4d6b`
succeeded). So an out-of-box agent with connectors assigned cannot USE them in an unattended
heartbeat run unless permissions are pre-granted or the approval/runtime-permission bridge
(W5b) actually surfaces the request to a human. Worth a clear default/UX: either connectors
imply their tool names are pre-approved for the assigned agent, or the permission prompt must
route to the founder. Today a founder assigns a connector, the agent silently can't call it,
and the only evidence is buried in the run log.

### Observation (not a bug) — stdio connectors are scoped to the agent's WORKSPACE, not their configured path
The filesystem connector was installed with `args=[…, "C:\Users\TK\.aoa\fs-probe"]`, but
`list_allowed_directories` returned the agent's workspace dir, not fs-probe. This is the MCP
"roots" protocol: claude tells the server its root is the run's workspace. Net effect: a
filesystem/stdio connector operates on the agent's workspace regardless of the path in its
args. Arguably safer (scoped per-run), but surprising — a founder pointing filesystem at
`/data` would find the agent sees its workspace instead. Document it, or pass the configured
path through as an explicit root.

### Notion live test (2026-07-25): hosted = OAuth-only, local stdio = WORKS with ntn_ token
Two runs against a real Notion account settled how Notion connectors must be shipped:

- **Hosted `mcp.notion.com/mcp` (HTTP) is OAuth-only.** Run `88f33e98`: the connector
  delivered fine (FU-21 synthesized the bearer, tools present) but Notion exposed only
  `mcp__notion__authenticate` / `complete_authentication` and returned a browser
  `https://mcp.notion.com/authorize?...` URL. Confirmed by Notion's docs: the hosted server
  does not accept bearer tokens and is "not designed for cloud-based agentic workflows that
  run without human interaction." So the `ntn_` integration token CANNOT authenticate the
  hosted endpoint. **The shipped catalog "Notion" entry (HTTP → mcp.notion.com) will never
  work headlessly — it requires Plan 4's OAuth broker.**
- **Local `npx @notionhq/notion-mcp-server` (stdio) WORKS with the ntn_ token.** Run
  `1f3b06d6`: a BYO stdio connector with `envTemplate {"NOTION_TOKEN":"${TOKEN}"}` +
  `secretRef mcp:notion` authenticated live — `mcp__notion-local__API-post-search` returned
  `error=False` with a real Notion API list response + `request_id`. (0 results only because
  the integration wasn't shared with any page yet.) This also proves the **stdio-secret path
  works end-to-end on claude_local** (claude expands `${VAR}` in stdio env; contrast FU-5,
  codex-only), and that FU-20's `${TOKEN}` placeholder round-trips through the BYO route.

**Catalog implication (feeds Plan 3b + Plan 4):** flagship remote MCPs are increasingly
OAuth-only (Notion confirmed; Linear/others likely). The curated catalog should either ship
the LOCAL/stdio variant where one exists (works today) or mark the hosted entry
`requiresOAuth` and gate it behind Plan 4. Shipping a hosted-Notion HTTP entry that can only
ever OAuth-fail headlessly would be a bad first impression. A `connectors.json` entry needs a
way to say "this one needs OAuth, not a token."

### FU-26 — delivery-time D7 re-check does not catch catalog REVOCATION/demotion · P2
Found by the FU-19-followup security review. The persisted `trustTier` lets a verified catalog
stdio connector survive a `local_trusted → authenticated` mode conversion (the intended fix).
But the persisted tier is NOT re-validated against the live catalog at delivery: if a
`verified` stdio entry is later demoted to `community` (or found malicious) in `connectors.json`
after install, the row keeps its stored `"verified"` and keeps executing on the host in
`authenticated`. Matches the narrow scope of the fix (mode conversion), and install already
committed to running it — but connector *revocation* is unhandled. If revocation is in the
threat model, the delivery gate (or a periodic sweep) should reconcile stored tier against the
current catalog and flip a demoted connector to `disabled` with a visible reason. Related to
the "installed connector should reflect catalog updates" concern (Decision #96 territory).

### FU-27 — pre-0180 verified catalog stdio connectors fail closed after a mode conversion · P3
Any verified catalog stdio connector installed BEFORE migration `0180` has `trust_tier = null`,
so after a `local_trusted → authenticated` conversion it is dropped (fail-closed) until
reinstalled. Safe direction, availability-only, narrow case. A one-time backfill (re-resolve
tier from the catalog for `source='catalog'` rows) would remove the reinstall requirement, but
isn't worth it unless a real deployment hits it.

### FU-28 — reserved serverName rejected at create · FIXED
The FU-25 review noted the connector create/BYO path did not reject a serverName colliding
with an AoA-owned reserved/bridge name (`aoa`, `playwright`). Not exploitable (such a connector
is stripped at delivery via `stripReservedMcpServerNames` and rejected by the FU-25 auto-allow
parser — a dead connector, not a privilege), but confusing UX. **Fixed**: `createConnectorSchema`
now rejects a reserved serverName with a clear 400 (superRefine + `RESERVED_MCP_SERVER_NAMES`).
Tests added to `mcp-connectors-routes.test.ts`.

### FU-29 — deliverability does not detect a deleted bound secret · P3
FU-1's computed-at-list-time deliverability (option A) intentionally does NOT detect the case
where a connector's `secretRef` points at a soft-deleted `company_secrets` row — that's a
runtime resolve-failure the loader only learns at delivery (option-B territory, needs a run or
a live secret read). Not in FU-1's required cases. If surfacing "credential was deleted" in
Settings is wanted, it's a small follow-up: have the list endpoint check secret existence for
each bound `secretRef`, or persist the loader's last resolve-failure.

---

## Codex independent review (2026-07-25) — 8 findings, ALL FIXED

An independent Codex adversarial review of the connector security surface (D7 gate, tool
auto-allow, approval authz, create/delivery, consent, catalog parse) found 8 real defects —
none false positives — that survived the internal adversarial reviews. All fixed + ablated;
consolidated suite 938 green + 192 db green, typecheck clean.

- **Finding 1 (HIGH, FIXED `d072221b4`)** — template value validation only checked
  "contains a `${...}`", so `"Bearer ${TOKEN} sk-live-REAL"` put a literal secret on disk and
  `"Bearer ${ANTHROPIC_API_KEY}"` exfiltrated an AMBIENT AoA credential into a third-party
  request. Now anchored to `/^([A-Za-z][A-Za-z0-9-]* )?\$\{TOKEN\}$/` (only the connector's own
  `${TOKEN}`), + args reject any non-`${TOKEN}` `${...}`, + URL-userinfo rejected. Verified
  all legit forms pass / all exfil forms reject.
- **Finding 2 (HIGH, FIXED `d20aa9736`)** — a BYO connector referencing `${TOKEN}` with no
  `secretRef` went `active` but authenticated as no-one. Now `requiresSecret` is derived from
  the `${TOKEN}` reference; a placeholder-without-secretRef is rejected at create.
- **Finding 4 (FIXED `2deb4114c`)** — create+approval now atomic (one txn); racy
  check-then-insert replaced with a narrow unique-constraint catch → clean 409; activity log
  best-effort post-commit (a log failure no longer 500s a committed create).
- **Finding 6 (FIXED `872a7ccf4`)** — approval/bind guarded on secret-boundness (not status
  alone) with a bounded re-read/retry, so a bind racing an approval can't strand a
  secret-bound connector inactive.
- **Finding 3 (FIXED `eb5a03f15`)** — the runtime auto-allow now re-checks the LIVE connector
  probe even when a trust rule matches, so disabling/unassigning a connector revokes its tools
  even if the founder previously chose "always allow". Non-connector rules byte-identical.
- **Finding 5 (FIXED `0b70cf9c0`)** — a catalog entry carrying a value-bearing template alias
  (`headerTemplate`/`envTemplate`) is now DROPPED at parse (pre-`safeParse` denylist) rather
  than silently `.strip()`-retained; FU-22 additive-field forward-compat preserved.
- **Finding 7 (FIXED `0b70cf9c0`)** — duplicate catalog `id`s are deduped at parse (first-wins,
  matching the install `find()`), so a trailing malicious clone can't shadow the primary.
- **Finding 8 (FIXED `f7bf3654e`)** — the auto-allow parser now rejects a blank/separator-only
  tool portion (`mcp__notion__ ` no longer resolves to `notion`).

### FU-30 — marketplace aggregator should also reject duplicate connector ids · P3
The AoA-side parser now dedups ids (Finding 7 defense-in-depth), but the `aoa-marketplace`
builder (`aggregate-connectors`) should reject duplicate ids at BUILD time so a collision never
ships in `connectors.json`. Flag for the marketplace repo (`feat/connectors-catalog`).

### FU-31 — `mcp_connector.delivered` audit should reflect the ADAPTER-written set · P2
`resolveAgentConnectors` emits `mcp_connector.delivered` at the SERVER-SIDE resolution point
(after `buildConnectorSpecs`, PR #304 / Codex F5). A downstream adapter writer can still drop a
connector before it reaches the CLI — codex → `secret_unreachable` for a secret-bearing stdio
spec (`codex-config-toml.ts`), sandbox-docker → all MCP skipped (`execute.ts`) — so those are
audited as delivered though they never reached the CLI. Fully accurate requires each adapter
writer to report its surviving connector ids (or the audit to move post-write, per adapter). Not
done in #304 to avoid a 4-writer refactor + upstream duplication of the drop predicates (drift).
The drops ARE separately observable today (McpWriterSkipReason warnings + the deliverability
preview's `secret_unreachable`); this event errs toward recording that AoA MADE the connector
available. Revisit when adapter writers gain a uniform "delivered ids" report.
