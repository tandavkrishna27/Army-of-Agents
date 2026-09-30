# QA Result — <Lane, scope, revision, and attempt>

**Date (UTC):** `<YYYY-MM-DD>`
**Epic:** `<E#-name>`
**Record path:** `<docs/replatform/epics/.../qa/<filename>.md>`
**Scope slug:** `<stable scope slug used in the filename>`
**Revision:** `<exact 40-character git SHA>`
**Attempt:** `<positive integer>`
**Supersedes:** `<prior immutable QA record path or none>`
**Lane:** `D0`, `E6-D1-FOUNDATION`, `D1`, `D1-HA`, `E10-REALTIME-FOUNDATION`, `D2`, `D3`, `D4`, `D5`, `D6`, `desktop`, `merge-train`, `nightly`, `weekly`, or `release`
**Result:** `pass`, `fail`, or `blocked_external`
**Failure class:** `none`, `product`, `harness`, `provider`, or `environment`
**Campaign start (UTC):** `<RFC3339 or not_applicable>`
**Campaign end (UTC):** `<RFC3339 or not_applicable>`

> This file is immutable from its first commit. A correction, rerun, changed decision, or changed revision creates a higher attempt and links this path through `Supersedes`.

## Topology and environment

Record control-plane replicas, worker count/failure domains, database, object store, realtime/admission stores, provider/fake provider, image and desktop artifact digests, protocol contract hash, provider/template/policy versions, and feature/configuration hashes. For D6, link the immutable support matrix and list every row ID with workload, target/provider, OS/version, credential/locality/fallback, mobility mode, and directed handoff or `not_applicable`. Do not record secrets.

For D4/D6, record the frozen schedule-manifest path/hash, timezone, expected samples, observed samples, missing samples, numerator, denominator, and permitted exclusions by stable fault-window ID. D6 must include coding, browser, and service for every participating Organization; desktop and mobility may remain disabled under their hard-negative rules.

### Frozen schedule and samples (D4/D6)

| Field | Value |
|---|---|
| Schedule manifest path | `<immutable path or not_applicable>` |
| Schedule manifest SHA-256 | `<64-hex or not_applicable>` |
| Timezone | `<IANA/UTC or not_applicable>` |
| Expected samples | `<integer or not_applicable>` |
| Observed samples | `<integer or not_applicable>` |
| Missing samples | `<integer or not_applicable>` |
| Numerator | `<integer or not_applicable>` |
| Denominator | `<integer or not_applicable>` |
| Exclusion count and stable fault-window reasons | `<value or not_applicable>` |

### D6 mandatory and advertised rows

| Matrix row ID | Organization | Workload | Target/provider | OS/version | Credential binding | Locality | Fallback | Mobility/direction | Expected/observed/missing | Numerator/denominator | Result |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `<stable row ID>` | `<Organization>` | `coding`, `browser`, or `service` | `<target/provider>` | `<value or not_applicable>` | `<mode>` | `<mode>` | `<mode>` | `<mode/direction or not_applicable>` | `<counts>` | `<counts>` | `pass` or `fail` |

Every D6 Organization has at least one row for each of coding, browser, and service. Disabled desktop/mobility closure is recorded separately and never substitutes for a mandatory workload row.

## Commands

| Command | Exit code | Duration | Result summary |
|---|---:|---:|---|
| `<exact command>` | `<code>` | `<duration>` | `<counts>` |

For D0, distinguish per-ticket focused evidence from the immutable rollup. The rollup records `pnpm -r typecheck`, `pnpm test:run`, `pnpm -r build`, the authoritative root `pnpm build`, three consecutive critical-suite executions, and the final clean-worktree assertion.

## Assertions and evidence

| Requirement ID | Class | Required value/condition | Observed value | Evidence | Result |
|---|---|---|---|---|---|
| `<stable ID>` | `REQUIRED`, `HARD`, `INITIAL`, or `OBSERVED` | `<condition or threshold>` | `<actual value>` | `<redacted log/metric/artifact reference>` | `pass`, `fail`, or `recorded` |

## Failures

For every failure, classify `product`, `harness`, `provider`, or `environment`; include the first causal error and stable finding/ticket link.

## Cleanup

Record sandbox termination, object cleanup/quarantine, test database cleanup, and any retained controlled artifacts.

## Gate effect

State which ticket, merge train, or epic gate this run permits or blocks.

State every applicable REQUIRED condition and every HARD, INITIAL, and OBSERVED metric from `docs/replatform/test-gates.md`, its observed value, and the decision. D6 records aggregate, mandatory coding/browser/service, and per-matrix-row SLI numerator/denominator plus disabled desktop/mobility negative evidence. REQUIRED/HARD/INITIAL failures block `pass`; a HARD failure always makes the overall result `fail`. `blocked_external` is valid only when the external lane/schedule could not start; after a campaign starts, scheduled external failures count and a missed threshold is `fail`.
