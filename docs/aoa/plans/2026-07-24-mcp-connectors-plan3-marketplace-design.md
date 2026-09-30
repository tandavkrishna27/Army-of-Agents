# Plan 3 — Marketplace Connectors (Design, revised)

**Date:** 2026-07-24 (revised after adversarial review)
**Branch:** `integration/connectors-marketplace`
**Status:** design revised; splits into **3a** (curated shelf) and **3b** (long tail)
**Depends on:** Plans 1 + 2 + 2b (complete, `53180c129`)
**Decisions:** extends #116 (connectors). Interacts with #96 (two-repo catalog) and #97
(`derivePackages`) — see §3.3 and §9.
**Follow-ups:** `docs/aoa/plans/mcp-connectors-followups.md`

> **Revision note.** The first draft of this design was reviewed against the codebase and
> contained five critical defects, including one that would have silently frozen the
> marketplace catalog on every deployed AoA instance. Those corrections are folded in
> below and marked ⚠ where a naive reading would reintroduce them.

---

## 1. Problem

Plans 1/2/2b built the whole connector runtime — a founder can register an external MCP
server and it reaches heartbeat agents, crew agents and Commander across all four CLI
adapters, with secrets held in process env rather than on disk.

What is missing is **discovery**. The only way to add a connector today is
Settings → Connectors → Add, typing URL, transport, header template and token by hand.

---

## 2. Shape

1. **Connectors are browsable and installable in one click.**
2. **The long tail is a search, not a shelf** — never bulk-imported into `catalog.json` (§3.2).
3. **Nothing reaches an agent implicitly** — inert until credentials are supplied *and* an
   agent is opted in.

Sizing: **~20–40 curated connectors** in 3a. Further curation is follow-up work.

---

## 3. Measurements that shaped this

### 3.1 The install dispatch is one switch

`marketplace-install/orchestrator.ts` dispatches on `catalogItem.type` at `:211`/`:214`/
`:242`/`:252`, with an else-throw at `:256`.

⚠ **The `feat/viewer-upgrade` dependency is NOT a blocking gate.** Its orchestrator change
is a 13-line localized edit inside the `team` case (Decision #111). The region a connector
case occupies is untouched. Treat as *rebase before merge*, not *wait for*.

### 3.2 The catalog is downloaded whole and filtered in the browser

`ui/src/api/marketplace.ts:105` fetches the entire catalog file; `filterByType:198`,
`filterByCategory:227`, `sortItems:257` are pure client-side functions. There is **no
server-side search or pagination**.

Measured live 2026-07-24: **1,544,110 B (1.47 MB) / 514 items** (498 skill, 11 agent,
4 plugin, 1 team); **2,154 B** average per non-skill item.

| if registry snapshotted in | added | new total |
|---|---|---|
| lean (400 B) | +3.7 MB | **5.1 MB** |
| today's density (2,154 B) | +19.7 MB | **21.2 MB** |

**Bulk import into `catalog.json` is rejected.** This is a property of the marketplace
generally, not of connectors — recorded as FU-9.

### 3.3 ⚠ A new item type in `catalog.json` bricks every older instance

`aoa-marketplace.ts:107` does `MarketplaceCatalogFileSchema.parse(json)`, and `type` is a
hard `z.enum`. **One** unknown item fails the whole-array parse. The catch at `:116` writes
`writeCache(null, "cdn", "failure", …)`, which *preserves the existing catalog*.

Proven live against the real 514-item catalog:

```
baseline catalog parses: true
catalog + ONE connector item parses: false
=> invalid_enum_value ... received 'connector', path ["items",514,"type"]
```

Net effect on any instance running today's shared package: it serves its last
pre-connector catalog **forever**, silently, for skills/agents/teams/plugins too.

⚠ **Decision #96 does NOT cover this.** #96 permits *additive optional fields*, because
zod `.strip()` drops unknown keys. `.strip()` does nothing for an unknown **enum value**.
The first draft cited #96 as mitigation; that was wrong.

`MarketplaceCategorySchema`, `MarketplaceTagSchema` and `isSchemaVersionSupported`
(strict equality on `"1.0.0"`) have the identical blast radius.

**Design consequence — this is why connectors get their own file (§4.1).** AoA is
self-hosted; the fleet cannot be forced to upgrade, so gating a CDN publish on fleet
forward-compatibility is a gate that may never open.

---

## 4. Architecture — Plan 3a (curated shelf)

### 4.1 A separate `connectors.json` artifact

**All** connectors — curated in 3a, long-tail in 3b — live in a second CDN artifact,
`connectors.json`, published from `MeteoriteLabs/aoa-marketplace-cdn`. `catalog.json` is
**not modified** and `MarketplaceItemTypeSchema` gains no new value.

Why this rather than a new item type:

- **Zero fleet risk** (§3.3). Older instances never fetch the file and simply show no
  connectors — correct degradation, not silent breakage.
- Reuses the proven cache + periodic sync + bundled-snapshot fallback machinery.
- Keeps `catalog.json` at 1.47 MB.
- **Works on air-gapped instances**, which a live registry proxy does not.

Trust reuses the existing `trust: { tier: "verified" | "community" | "unverified", … }`
shape (`marketplace.ts:165-172`).

⚠ Do **not** add a parallel `verified: boolean`. The first draft proposed one; the existing
three-value tier already expresses it (including the literal `"unverified"` tier 3b needs),
and two representations of one fact drift apart. Fail-closed still holds: absent tier ⇒
community, and tier is set only in the AoA-controlled repo, **never** read from
registry-supplied metadata.

Fleet-brittleness of `catalog.json` remains a latent bug regardless of this plan — a
forward-compat hardening (per-item `safeParse` with drop-and-warn) is filed as **FU-14**.

### 4.2 Install path — extract, then reuse

⚠ The first draft said "call the existing `mcpConnectorService`, so everything already
reviewed applies unchanged". **False.** That service is deliberately thin — its own header
says the load-bearing validation lives in the route. `svc.create()` is a bare INSERT.

The governance logic is ~80 lines in the POST handler (`routes/mcp-connectors.ts:176-257`):
D7 gate, `(companyId, serverName)` 409, secretRef existence, status derivation from
deployment mode, `install_mcp_connector` approval creation, activity log.

**Required task:** extract a shared `createConnector(...)` service function; both the route
and the orchestrator call it. Otherwise D6/D7 exist in two places and the marketplace copy
is the one without test coverage.

`source` is set **server-side** to `"catalog"` — ⚠ *not* `"marketplace"`; the codebase
vocabulary is `"byo" | "catalog"` (`company_mcp_connectors.ts:32`) and `assertTransportAllowed`
switches on `"catalog"`. Never accepted from the client (C3 precedent).

### 4.3 ⚠ Credential state is a second dimension, not a fifth status

The first draft added a `needs_credentials` status to the single `status` column. That
collides with the D6 approval machine in two ways:

- `approvals.ts:260-262` flips **any** non-active status to `active` on approve — so
  approving would activate a connector with **no credentials**, exactly what the design
  forbids.
- `approvals.ts:321` only disables rows in `pending_approval`, so **rejecting** a
  `needs_credentials` connector is silently a no-op.

The real model is two orthogonal axes: **approval** (`pending_approval` / approved /
rejected) × **credential** (bound / unbound). Activation requires `approved && secretBound`.

Implement as a separate `secretBound`-style field, keeping `status` as the governance axis.
No DB migration needed for the column type — `status` is `text().notNull().default("pending_approval")`,
not a pg enum. Must be updated in step: `updateConnectorSchema`'s `z.enum` (`routes/mcp-connectors.ts:145`),
the UI union (`ui/src/api/mcpConnectors.ts:23`), and `StatusBadge`
(`MCPConnectorsSection.tsx:32-34`, which has **no fallback return** — an unknown status
renders no badge at all).

✅ **`selectConnectorRowsForAgent` (`mcp-connectors.ts:110-117`) is an allowlist** —
`if (c.status !== "active") return false;` — and is the sole delivery chokepoint. Any new
state is excluded from agent delivery for free. **Do not "helpfully" convert it to a
denylist.**

### 4.4 ⚠ There is no secret-binding write path today — 3a must add one

`ConnectorPatch` is `{ displayName?, status? }` and `updateConnectorSchema` is `.strict()`
on those two, with a deliberate comment that transport-relevant fields cannot be edited.
Routes are GET / POST / PATCH / DELETE / PUT `…/agents` — nothing sets `secretRef` after
create. The POST handler also validates `secretRef` existence at write time, which is the
invariant an unbound install must violate.

So the central journey — install → configure → active — **cannot be built today**.

Add `POST …/:id/credentials`, which sets `secretRef` and re-derives status via the *same*
helper the install path uses. ⚠ It must **never** accept a caller-supplied status — a naive
`PATCH {secretRef, status:"active"}` reopens the C2 activation bypass the existing handler
works to close.

### 4.5 ⚠ D7 must become verification-aware

`assertTransportAllowed` (`routes/mcp-connectors.ts:69-80`) currently reads:

```ts
if (source === "catalog") return; // verified catalog entries only (C3)
```

The comment says *verified*; the code checks only *source*. That was safe because — as its
own docstring states — no route could construct a `catalog` source. **Plan 3 builds that
route and introduces unverified entries**, so an unverified stdio connector would bypass D7
and spawn a process on a shared host in `authenticated` mode.

Change to `if (source === "catalog" && tier === "verified") return;`.

⚠ The §4.6 consent gate is **not** a substitute. Consent is a *UX* gate proving the founder
saw the command; D7 is an *authorization* gate about whether the deployment permits host
exec at all. They are additive.

### 4.6 The consent gate — server-enforced

Installing an **unverified stdio** connector requires an acknowledgement bound to the exact
command, and the route rejects the install without it.

Rationale: a stdio connector spawns a process on the AoA host with the server's privileges.
Until now the founder typed that command, so consent was implicit in typing it. A card with
an Install button removes that property. The motivating case is **secretless stdio**, which
has no credential modal — without this gate the sequence is click → code executes → no
prompt at any point, and per D6 `local_trusted` (where D7 permits stdio) is the solo-founder
default.

No such primitive exists in the codebase; it is net-new. Enforcement at the route is viable:
`startInstallOperation` runs synchronously in the request and `dispatchInstall` is
fire-and-forget after it, so the check goes before `startInstallOperation`.

⚠ Three requirements: the field **must** be added to `SingleInstallRequestSchema` (plain
`z.object` **strips** unknown keys, so an unlisted field is silently dropped and the gate
silently disappears); it must bind to the exact command (short-TTL HMAC over
`itemId + command + args`), not be a bare `true`; and the resolved command must be
snapshotted into the operation row to close the TOCTOU window across a catalog re-sync.

### 4.7 ⚠ Marketplace RBAC must be decided, not defaulted

`canInstallType` (`routes/marketplace-installs.ts:57-68`) returns `true` for `team_lead` on
anything that is not a plugin. Adding connectors without touching it grants team leads
ungated connector installs — while direct connector CRUD is `assertRole(…, "founder")`.
The marketplace would be a strictly weaker door onto the same object, by omission.

3a sets connectors to **founder-only**, matching CRUD. A `allowTeamLeadConnectors` setting
can follow if wanted. Also check `resolveInstallDecision`'s `"request"` branch — a team
member's request terminates at `"requested"` with no approve route, a dead end today.

### 4.8 Agent exposure

Unchanged (D3/D4): install enables the connector for **no** crew agents; the founder opts
each in. Commander receives all `active` connectors automatically — ⚠ on the **claude path
only**; `cli-mode.ts:770` gates on `cliTool === "claude_cli"`, so codex-mode Commander gets
none (FU-8).

### 4.9 UI

Connector cards matching existing card chrome (design-system §9.13–9.18, `:738`–`:829`); a
**"Needs setup"** badge deep-linking to Settings → Connectors, sharing a surface with FU-1's
connector-health work.

⚠ `pathToItemType` (`ui/src/lib/marketplace-constants.ts:92-103`) is a runtime allowlist of
four string comparisons returning `null` → 404. It will **not** raise a TS error, so
connector detail routes would silently 404. By contrast `TYPE_ICONS`/`TYPE_LABELS` are
`Record<MarketplaceItemType, …>` and *will* fail compile — useful fail-fast.

---

## 5. Architecture — Plan 3b (long tail)

A generation job pulls the registry, normalises entries, and publishes them into
`connectors.json` with `trust.tier: "unverified"`. The browser fetches the file lazily when
the Connectors surface opens.

Because normalisation happens **at generation time**, the runtime never meets registry
schema drift. The generator must handle what the live registry actually returns:

- **The registry supplies no command** — only `registryType` + `identifier` + `runtimeHint`.
  AoA *synthesizes* the command, so §4.6's consent binds to an AoA-derived string that must
  be computed once and reused.
- **Runtimes beyond npm** — `npx` / `uvx` / `docker` / nuget. "Runtime not installed on the
  host" is a real failure class.
- **Multiple packages per server** — selection policy must be explicit.
- **`remotes[].type` is `streamable-http` or `sse`.** AoA's union is `http | stdio`;
  `buildConnectorSpecs` skips anything else as `unknown_transport`. SSE-only servers are
  un-installable and should be filtered at generation with a recorded count.
- **Duplicates** — entries are version-scoped; the same server appears more than once.

---

## 6. Error handling

| Condition | Behaviour |
|---|---|
| `connectors.json` unreachable | Connectors surface degrades; `catalog.json` unaffected |
| Older instance, no knowledge of the file | shows no connectors; catalog sync unharmed |
| stdio blocked by D7 for the deployment mode | install refused with the deployment-mode reason |
| Unverified stdio install without consent token | route rejects (400) — before `startInstallOperation` |
| Unverified stdio in `authenticated` mode | refused by D7 **regardless** of consent (§4.5) |
| Installed but unconfigured | credential-unbound; badge shown; never delivered (§4.3 allowlist) |
| Approval pending (`authenticated`) | activation requires `approved && secretBound` |

---

## 7. Testing

Every review round in Plans 1/2/2b found a real defect that passed first-pass green tests —
an RCE chain, an arg-injection bypass, a data-loss bug, silently-unauthenticated connectors.
Three of four were adversarial-category.

| Layer | Coverage |
|---|---|
| **Unit** | `connectors.json` parse with absent fields; trust-tier fail-closed; registry→spec normalisation; consent-token validation + TTL + command binding |
| **Contract** | install + credential-binding API shapes (`*-routes-contract` pattern) |
| **Service** | shared `createConnector` dispatch via sequence-based mock DBs (house pattern) |
| **Integration** (embedded-PG) | install → unbound → bind secret → approved → `active` → loader delivers to a real run; approve/reject against an unbound row (§4.3) |
| **E2E** (Playwright) | browse → install → badge → configure. ⚠ Windows is skipped **in CI only** (Issue #114); run locally with `AOA_E2E_FORCE_WINDOWS=1` (`tests/e2e/playwright.config.ts:18-25`) |
| **Adversarial** | unverified stdio rejected without consent; unverified stdio rejected by D7 in `authenticated` even *with* consent; trust tier uninjectable from registry data; consent token unbindable to a different command; client-supplied `source` ignored; prototype pollution via connector names; **regression: publishing connectors does not alter `catalog.json` parsing** |

---

## 8. Risks

1. **Curation is real, recurring work** — ~20–40 entries genuinely vetted. Marked verified
   without review, the trust tier is a label and §4.5's gate degrades to nothing.
2. **Two-repo coordination** — `connectors.json` must be publishable from the CDN repo
   (unverified: that repo is not in this worktree).
3. **`catalog.json` remains fleet-brittle** (§3.3) — avoided here, not fixed. FU-14.
4. **Registry schema drift** — contained to the generation job, not the runtime.

---

## 9. Out of scope

- **Bulk import into `catalog.json`** — rejected (§3.2).
- **OAuth-brokered connectors** — Plan 4; the credential-unbound state is deliberately the
  shape OAuth needs.
- **Flagship UI-rich plugins** — Plan 4.
- **Server-side marketplace search/pagination** — FU-9.
- **`catalog.json` forward-compat hardening** — FU-14.
- **`derivePackages`** — connectors are excluded from *synthesis* (skill-items-only), but
  ⚠ `derivePackages.ts:65-79` checks explicit `packageId` **before** the skill guard, so a
  connector carrying `packageId` would be grouped and rendered with the skill-themed
  `PackageCard`. Since connectors are not catalog items here this cannot arise, but do not
  restate it as "connectors are excluded from #97".
