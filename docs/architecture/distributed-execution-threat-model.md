# Distributed Execution Threat Model

**Measured state, 2026-09-08 — read this before the tables below.** This register
covers **30 crossings**, all of them Critical (22) or High (8). Every one has now
been audited for delivery, and the tally is **1 `delivered`, 25 `partial`, 4
`not-delivered`, 0 `unaudited`**: **exactly one of thirty came back whole.**
`partial` is not a softer `delivered` — it means the crossing was audited and its
clauses split, with at least one control enforced by a named line exhibited
*denying* and **at least one control that is not there**. ★ **The zero in the
`unaudited` column is not good news.** It means nothing here is unknown any more,
not that anything here got safer.

**What this record locks, and what it does not.** It locks the trust boundaries and
the **required** controls — the charter — together with the verification gates,
residual risks, and owning backlog tickets for the Decision #121 fenced outbound
worker protocol. It does **not** establish that those controls exist: the
`Required control` column of the register below is a charter, not a report. Only
`deliveryStatus` and `deliveryEvidence` on each crossing speak to what was built,
and "Required vs delivered" below is how to read them.

Read that in both directions. Several rows carry real, measured enforcement — the
audit exhibited DE-01's tenant RLS *denying* across 4,460 adversarial operations,
with PostgreSQL's refusal text read back verbatim. Four rows carry a measured
absence: DE-08, DE-23, DE-25 and DE-26 are chartered Critical/High controls
recorded `not-delivered`. The remaining twenty-five hold in part and are each
missing something named. Read a row's own evidence before relying on its control.

This document is the rendered, explained view of the authoritative
machine-readable record
[`distributed-execution-threat-controls.json`](distributed-execution-threat-controls.json):
every control ID (`DE-NN`), severity, control, verification, and owner in the
register below is derived from that JSON, and the structural checker
(`scripts/check-distributed-execution-foundation.mjs`) fails on any drift between
the two in either direction — including the tally above, which it recomputes from
the JSON on every run.

It consumes the lifecycle record
([`distributed-execution-lifecycles.md`](distributed-execution-lifecycles.md))
and the authority record
([`distributed-execution-authority.md`](distributed-execution-authority.md)),
and it treats Decision #103 (plugin boundary) and Decision #117
(execution-target/gVisor boundary) as inputs under repair. Distributed execution
is default-off; `AOA_ALLOW_UNSANDBOXED_MULTITENANT` is forbidden at `cloud_auth`
startup (DE-14).

## Trust boundaries

Each row names the trusted side, the less-trusted side, and the primary
authentication at the crossing. The full control set (authentication,
authorization, confidentiality, integrity, revocation, audit, failure mode,
severity, owner tickets, and verification lane) for every crossing lives in the
JSON and is rendered in the register that follows.

| Boundary | Trusted side | Untrusted/less-trusted side | Authentication |
|---|---|---|---|
| Browser/UI → control plane | tenant-scoped API | browser input | Better Auth/session + live membership |
| Worker → control plane | job/lease APIs | enrolled device | device key + short-lived audience-bound session |
| Worker host → sandbox | worker supervisor | tenant workload | provider/sandbox identity + lease fence |
| Provider manager → expired/replaced resource | cleanup-only management boundary | stale tenant effect authority and foreign/sensitive resource data | resource/ownership/generation/deadline-bound monotonic cleanup authority with management-only inspect projection |
| Control plane → object store | artifact broker | object bytes/keys | scoped service identity and presigned grants |
| Control plane → secret store | secret broker | secret material | service identity + tenant/lease authorization |
| Control plane → connector provider | MCP OAuth broker | access/refresh token and remote API | company-scoped grant + fenced refresh lease |
| Worker/sandbox → context APIs | control-plane memory/context service | company memory and actor scope | worker session + tenant/job/lease/fence authorization |
| Sandbox → network | filtered egress | external destinations | destination policy and credential-injecting proxy |
| Legacy → distributed owner | cutover transaction | duplicate executor | single-writer owner and rollout flag |

Additional crossings closed by the register below and mandated by the foundation
hardening amendment — placement/target registry (DE-18), context/memory API
(DE-19), realtime broker (DE-21), telemetry/evidence store (DE-22),
backup/restore (DE-23), desktop installer/updater (DE-24), local folder (DE-25),
real-provider isolation (DE-26), multi-replica coordination (DE-27), quarantine
promotion (DE-28), owner-credential routing (DE-29), and capability-claim
admission (DE-30) — extend the same trusted/less-trusted split. The post-fence
cleanup crossing (DE-17) preserves a cleanup authority that is possible,
least-privilege, ownership-scoped, idempotent, deadline-bounded, and incapable of
restoring effect authority.

## Threat and control register

The register is the rendered view of the `crossings` array in
[`distributed-execution-threat-controls.json`](distributed-execution-threat-controls.json).
Every `DE-NN` control is present in both; the checker enforces exact ID-set
parity (both directions, count included) plus per-ID threat/severity/required
control/verification/owner parity. Owner cells name defined backlog tickets in
[`../replatform/program-design.md`](../replatform/program-design.md); an unknown
owner ticket is rejected. Every Critical/High control carries a release test —
either a `REL-*` owner ticket or a `releaseTest` field in the JSON — and the
verification lane (`D0`–`D6`) names the deployment-progression gate that
exercises it.

| ID | Threat | Severity | Required control | Verification | Owner |
|---|---|---|---|---|---|
| DE-01 | Cross-tenant database access | Critical | non-owner role, forced RLS, tenant transaction | real PostgreSQL adversarial tests | TEN-002/TEN-003/TEN-005 |
| DE-02 | Mixed-tenant relationships | Critical | composite tenant constraints | negative SQL integration | TEN-004 |
| DE-03 | Worker credential replay | High | one-use enrollment, device key, short sessions | replay/expiry tests | JOB-002/WRK-002 |
| DE-04 | Double execution | Critical | atomic lease and fencing | concurrent claim/stale fence | JOB-003/JOB-004 |
| DE-05 | Late result overwrite | Critical | terminal immutability and quarantine | lost-ACK/replacement tests | JOB-005/JOB-006 |
| DE-06 | Cross-tenant object key | Critical | tenant/job prefixes and fenced commit | MinIO malicious-key tests | DAT-002 |
| DE-07 | Secret or connector-token exfiltration | Critical | existing OAuth broker, opaque execution handles, live lease/fence, broker-owned refresh, audit, redaction | wrong-tenant/fence/refresh/log corpus | DAT-004/DAT-005/REL-001 |
| DE-08 | Metadata/control-plane SSRF | Critical | default-deny egress and blocked ranges -- ★ AMENDED 2026-09-11: at the managed-shared tier the operative control is the credential taxonomy (no exfiltratable secret in the VM), NOT egress denial; egress denial is a self-hosted/tenant-hosted concern. | DNS/IP/metadata tests | DAT-005 |
| DE-09 | Sandbox escape/host command | Critical | tenant commands only inside provider sandbox | image/capability/provider tests | WRK-004/REL-004 |
| DE-10 | Worker crash and orphan sandbox | High | restart reconciliation and provider cleanup | crash-point suite | WRK-007/CLI-004 |
| DE-11 | Browser cookie/trace leakage | High | job-scoped sensitive artifacts and TTL | browser retention/authorization | BRW-003/BRW-004/REL-001 |
| DE-12 | Service split brain | Critical | desired-state reconciler, generation, active fence | partition/drain/generation tests | SVC-002/SVC-003/SVC-005 |
| DE-13 | Noisy-neighbor starvation | High | per-Organization quotas/fair scheduling | multi-tenant load | JOB-007/REL-002 |
| DE-14 | Unsafe hosted fallback | Critical | startup rejects process-wide unsafe override | configuration test | FND-005 |
| DE-15 | Supply-chain image compromise | Critical | pinned digest, scan, signature, kill switch | release gate | REL-004 |
| DE-16 | Cloud plugin code escape | Critical | cloud plugins remain disabled pending separate worker | process/composition plus route/dispatcher/UI negatives and release regression | FND-006/FND-008/REL-005 |
| DE-17 | Cleanup is blocked after fence loss or cleanup authority is escalated | Critical | separate resource-bound monotonic cleanup authority with effect operations unrepresentable | post-fence cleanup, cross-resource denial, and escalation corpus | WRK-004/DEP-008/CLI-004/REL-004 |
| DE-18 | Target-generation replacement | Critical | monotonic placement generation and admission fence | target-replacement and stale-generation tests | JOB-004/MIG-004 |
| DE-19 | Context or memory over-scope | Critical | scoped context API, no memory-table access, actor and visibility enforcement | actor-scope and visibility adversarial tests | DAT-007/TEN-005/REL-001 |
| DE-20 | Duplicate executor across the legacy cutover | Critical | single-writer owner and rollout flag | cutover, drain, and rollback rehearsal | MIG-002/MIG-008/REL-003 |
| DE-21 | Cross-tenant realtime fan-out | High | tenant-scoped topics and authorized catch-up | realtime fan-out and catch-up authorization tests | MIG-003 |
| DE-22 | Audit or evidence overwrite | High | append-only evidence with Supersedes and redaction on transmit | append-only evidence and supersede-integrity tests | FND-005/REL-005 |
| DE-23 | Cross-tenant backup or restore | Critical | tenant-scoped encrypted backup and provenance-checked restore | disaster-recovery and migration rehearsal | REL-003/DAT-002 |
| DE-24 | Desktop supply-chain compromise | Critical | signed installers and signed update with drain and rollback | signed-update, drain, and rollback tests | DSK-003/DSK-004 |
| DE-25 | Out-of-grant local folder mutation | High | explicit folder grants and local sandbox capability | folder-grant and offline-policy tests | DSK-002/DAT-006 |
| DE-26 | Real-provider isolation failure | Critical | managed sandbox isolation conformance on the real provider | real-provider isolation conformance suite | DEP-008/REL-004 |
| DE-27 | Multi-replica coordination hazard | High | shared-admission ownership and serialized admission | two-replica admission and partition tests | FND-005/REL-002 |
| DE-28 | Quarantine promotion | Critical | quarantine prefix with no automatic promotion | late-output quarantine and no-auto-promote tests | JOB-005/JOB-006 |
| DE-29 | Owner-credential misrouting | Critical | company-scoped grant and fenced refresh with owner routing | wrong-owner routing and refusal corpus | DAT-004/DAT-005/REL-001 |
| DE-30 | Malicious capability claim | Critical | server-derived capabilities from verified identity and live membership | capability-spoofing and stale-membership tests | JOB-002/TEN-002 |

### Required vs delivered

**The `Required control` column above is a charter, not a report.** Every clause in
the JSON record (`authentication`, `authorization`, `confidentiality`, `integrity`,
`revocation`, `audit`) states what the control *must* do. Until 2026-09-06 the record
carried no field able to say whether any of it had been *built*, so a Critical crossing
measured absent read exactly like one that holds. `deliveryStatus` in
[`distributed-execution-threat-controls.json`](distributed-execution-threat-controls.json)
is that distinction, and the foundation checker requires it on every crossing:

| Value | Meaning |
|---|---|
| `delivered` | An **author's assertion**, not a machine-established fact, that the control is implemented and exercised by a test driving the real mechanism. The checker requires only that `deliveryEvidence` prose exists and that no open finding's free text names the crossing id; it reads no test file and executes no control. See the scope limit below. |
| `partial` | The crossing **has been audited** and its clauses split: at least one is enforced by a named line that was exhibited *denying*, and at least one is **absent**. Must cite a live finding, exactly as `not-delivered` must — the absent half is always owned. ★ **This is not a softer `delivered`.** A `partial` row has controls that are not there; read the evidence for which. |
| `not-delivered` | The control was **measured absent**. Must cite a live finding in `scripts/finding-ownership.json`. |
| `unaudited` | **No delivery audit has been performed.** Read as *unknown*, never as *holds*. |

**Scope limit — do not over-read a `delivered` value.** The refusal that backs
`delivered` fires only for a crossing whose id appears as a literal token (`DE-nn`) in
the `reason` or `successor` free text of an open finding in
`scripts/finding-ownership.json`. When that limit was first written it bound **one
crossing out of thirty**; after W20 and W20B it binds **twenty-nine of thirty**, and the
one crossing it does not bind is DE-02 — the only `delivered` row in the register. Read
that precisely: the refusal is no longer vacuous, but it is now vacuous exactly where a
`delivered` claim lives, because a crossing an open finding names *cannot* be
`delivered`. So the clause has become a strong ratchet against flipping a measured-absent
row to `delivered`, and it still says nothing whatever about whether DE-02 holds. The
coupling also remains editorial rather than structural: rewording a finding so its prose
no longer contains the crossing id releases the refusal, without changing that finding's
status, severity or ownership. A `delivered` value is therefore a human claim with a
human citation — audit the citation; do not infer that the control is implemented,
tested or safe from the fact that the checker passed.

**The tally today: 1 `delivered`, 25 `partial`, 4 `not-delivered`, 0 `unaudited`** — of
30 crossings, all of them Critical (22) or High (8). Read that plainly, and read it as the
bad news it is: **every crossing in this register has now been audited, and exactly one of
thirty came back whole.** ★ **A zero in the `unaudited` column is not health.** Going from
twenty-eight unaudited to none moved this register from *unknown* to *known-bad*: nothing
here got safer, and twenty-nine rows now carry a measured statement that some control they
charter is not there. That is a better state to be in and a worse-looking one, and the
worse-looking number is the true one.

The field was introduced by a register-repair change that audited two crossings (DE-02 and
DE-08). W20 audited twelve more — DE-01, DE-03, DE-04, DE-05, DE-06, DE-07, DE-09, DE-10,
DE-11, DE-12, DE-13 and DE-14 — and **every one of the twelve came back `partial`**: an
enforcement half with a named deny line whose refusal is exercised, and an absent half.
W20B then recorded the remaining sixteen — DE-15 through DE-30 — of which thirteen are
`partial` and three (DE-23, DE-25, DE-26) are `not-delivered`.

★ **Why those sixteen landed a commit late, recorded here because the failure is the wave's
own subject.** All twenty-eight audits completed. The orchestrator passed them to the
recording unit as one inline JSON string truncated with `.slice(0, 90000)` — **a silent cap,
in the wave built to find silent caps.** DE-15 through DE-30 never arrived and DE-14 arrived
half-formed. The recording unit noticed the gap and **refused to write rows it had not been
given**, which is why the twelve it did record can be trusted; W20B recovered the other
sixteen from disk, re-verified every load-bearing citation at `file:line` against tip, and
completed DE-14. **Seven of the sixteen recovered records cited at least one line number that
is wrong at tip**, and two carry a substantive correction: DE-21's auditor stated that no
audit writer exists in the realtime module, which is false — the module logs at eight sites,
and the real (worse) finding was that the *deny* path is the one path that never reaches one
(★ partly superseded on 2026-09-09: five of `authorizeUpgrade`'s deny disjuncts now write an
attributable row, the rest still write nothing, and DE-21 stays `partial` — the row's own
`★ UNIT C` clause is the statement, not this sentence);
and DE-16's audit clause, which the auditor left unsettled, was measured here. Every row
names its own corrections in its evidence.

**Read each row's own `★ PROVENANCE OF THIS ROW` clause before citing it.** The static
measurements — deny lines, caller and write-chokepoint censuses, the greps behind each
absence claim — were executed by the landing unit at tip. The integration, property and
vector suite *runs* were the reachability auditors'; for those the landing unit verified only
that the file exists, that its sole skip predicate is win32-without-`AOA_RUN_WIN_INTEGRATION`,
and that the required `verify` gate runs the whole suite. DE-14 is the one exception: its deny
was executed directly by the landing unit over a seven-case matrix.

The same partition holds for W20B's sixteen, and the two things it *did* execute beyond the
static measurements are named so nobody has to guess. It ran `gh run view 34199424265`, which
confirms the two-replica D1 campaign was `success` on `3814b90f3` (one commit before tip) —
but it did **not** read that run's logs, so DE-27's six named gate results remain the
auditor's. And it re-ran DE-22's decisive measurement itself, in git: `git log --follow` over
the E5 exit-gate QA record returns two commits, the second of which rewrote a supposedly
write-once record in place while its `Supersedes` field still says there was nothing to
supersede. Everything else — every vitest, `node --test` and keyed-E2B run cited anywhere in
those sixteen rows — belongs to the auditors. ★ This partition is the same discipline that
caught eight W20 rows opening "ENFORCED, and exhibited denying" over suites the *auditors* had
run: provenance slippage one step removed from the read-back that fooled DE-08.

The absent halves cluster into a small number of classes, each filed as a finding rather
than left in prose. W20 named three; W20B's sixteen fell into the same three (as siblings,
so each finding's count stays true to the cohort it measured) plus one more:

- **`E0-F010`** — eight crossings assert that denials are *audited*; on all eight, as filed, the
  deny path returned before anything durable was written. ★ **As at 2026-09-10, SIX still do:**
  DE-06's and DE-14's audit clauses closed that day and both are struck from the cohort. Across
  the whole class — this cohort plus `E0-F013`'s — **three of seventeen are closed and fourteen
  are open;** the authoritative count is `E0-F013`'s Status block in
  `docs/replatform/epics/E0-foundation/findings.md`, and no count is stated twice here. ★ **2026-09-11
  (E0-F013 Decision 1):** E0-F010 is now **FIVE** (DE-12's audit clause was resolved by amendment and
  struck) and the whole-class open count is **TWELVE** (DE-12 and DE-20 both resolved by amendment,
  leaving three whole-delivered + two amended-resolved). The `1 delivered / 25 partial / 4
  not-delivered` register tally is unchanged — no `deliveryStatus` flipped. The post-ruling "closable
  ever" ceiling is SIXTEEN under convention (ii) (17 − DE-17, the sole audit clause still blocked on
  an unbuilt mechanism) — the same convention that already counts DE-06/DE-14 as closable though
  their crossings stay `partial`. The closable-ever ceiling is not the register status; the tally
  above is unchanged. See the decision paper §7 / §8 1.7.
- **`E0-F013`** — the same class, second cohort: **nine more** crossings, of which five
  record nothing at all and four record the *success* path and not the refusal. ★ **AMENDED
  2026-09-11 by E0-F013 Decision 1:** DE-27's clause is NOT unwritable. The ruling adopted the
  WEAK reading (1.2c) — it drops the partition conjunct as vacuous and classifies the
  cross-replica-admission conjunct as ordinary Group B/C audit-write wiring (durably record the two
  admission refusals), which needs NO replica identity; the earlier "unwritable / no replica
  identity of any kind" was the STRONG reading the ruling did not adopt. DE-20's audit clause was
  also resolved by amendment (it left the cohort). Authoritative post-ruling counts live in
  `E0-F013`'s Status block.
- **`E0-F011`** — four crossings are defended by a control whose **arming path is dead**:
  two with zero production callers, one enabled by an environment variable set in no
  manifest, one gated on a deny that is unreachable-as-a-refusal (its DB column now HAS a writer, but
  the sole production submitter always supplies a matching generation).
- **`E0-F014`** — the same class, second cohort: **five more**, including the rollback DE-20
  calls "atomic" (zero callers) and the immutability check for the QA/handoff evidence
  ledger — whose rule this repository has already broken three times, CI-green.
- **`E0-F012`** — three crossings name a mechanism **no code attempts** (a capability
  restriction never passed to the provider, a fair-share scheduler with no tenant term, a
  "scoped service identity" that is one bucket-wide credential).
- **`E0-F015`** — the three `not-delivered` rows W20B measured: DE-23 (no tenant parameter
  anywhere in the backup/restore path), DE-25 (every deny line behind a zero-caller
  factory), DE-26 (a conformance suite never run against the provider it certifies, which
  is already measured dropping a required isolation input).
- **`E0-F016`** — two crossings assert a property their code does not have: DE-30's
  capabilities narrow "immediately" except for the one principal whose role rides a
  ten-minute token, and DE-19's "context authority ends with the lease" over a lane where
  no line reads run status at all.
- **`E8-F011`** — DE-11 specifically: ★ **CORRECTED 2026-09-11 (E0-F013 Decision 1): the audit
  control is now PARTIALLY IMPLEMENTED** — the retention override is durably recorded by
  `recordRetentionDecision` (`artifact-retention-audit.ts`, drained at `artifact-commit.ts:482`) and
  a successful object-access grant by `recordObjectAccessGrant` (`artifact-object-access-audit.ts`,
  access half riding DE-06). The one sub-property still measured absent outright is **purge on job
  completion**; the retention audit record is now WRITTEN. DE-11 stays `partial` for the BRW-003
  coverage gap (neither audit half has fired on a genuinely sensitive kind yet), the still-absent
  purge-on-completion clause, and the `UNKNOWN` encryption + TTL clauses — NOT for a DE-06 access-half
  dependency, which is discharged (DE-06's object-access unit delivered the access record 2026-09-10). *(Amended 2026-09-09 by W22B. This line read "all four
  of its named controls are absent" until the register recorded that DE-11's encryption clause, its
  TTL clause and the TTL-expiry half of its purge clause are `UNKNOWN` pending an artifact-bucket
  inspection: source shows the application never asks for them, which is not the same as the bucket
  not providing them. The other half of the purge clause is unaffected — no bucket setting can
  observe job completion; the application audit record, by contrast, is now written by the retention
  and object-access writers above.)* DE-11's `deliveryStatus` is unchanged at `partial`.

`scripts/check-threat-control-audit-debt.mjs` pins the unaudited count as a **ceiling that
can only fall**, and that pin is now **zero** — so the ratchet's live work is its other two
arms: no crossing may return to `unaudited`, and DE-02 may not stop being `delivered`.
Today **four** crossings are `not-delivered`. Three were measured by W20B and are carried by
`E0-F015` above — **DE-23** (cross-tenant backup or restore, Critical), **DE-25**
(out-of-grant local folder mutation, High) and **DE-26** (real-provider isolation failure,
Critical). The fourth is the original:

- **DE-08 (Metadata/control-plane SSRF, Critical) is NOT DELIVERED.** Default-deny
  egress and blocked metadata/control-plane ranges are **required and absent**, not
  in force. Finding `E8-F003` records the measurement against real E2B sandboxes —
  with a positive control and an apparatus control that both held — that the declared
  egress allowlist is inert and that `169.254.169.254` answers from inside the guest.
  DE-08's clause fields are written in the required form for this reason. The control
  remains chartered and its severity is unchanged; nothing here closes it.

### Hardening-amendment coverage

The register represents every crossing the foundation hardening amendment
requires and adds a threat for each named risk:

- **Malicious capability claims** — DE-30: server-derived capabilities; self-asserted claims are never trusted.
- **Owner-credential misrouting** — DE-29: company-scoped grant and fenced refresh route a credential only to its matching owner.
- **Target-generation replacement** — DE-18: monotonic placement generation and an admission fence stop a replaced target from resurrecting work.
- **Desktop supply chain / local folder mutation** — DE-24 and DE-25: signed installers/updates with drain and rollback, and grant-confined local filesystem effects.
- **Multi-replica coordination** — DE-27: shared-admission ownership serializes admission so two control-plane replicas cannot double-admit work.
- **Real-provider isolation** — DE-26: managed sandbox isolation conformance is proven on the real provider, not only in local mocks.
- **Quarantine promotion** — DE-28: quarantined late output is never auto-applied or auto-selected as a checkpoint.
- **Evidence overwrite** — DE-22: append-only evidence under the Supersedes rule; there is no delete path.

The **post-fence cleanup** crossing (DE-17) keeps cleanup possible after fence
loss while making effect operations unrepresentable: cleanup authority is
resource/ownership/generation/deadline-bound and monotonic, permits only
list/inspect/cancel/kill/destroy/reconcile, is idempotent and deadline-bounded,
and can never create, execute, resume, checkpoint, reveal foreign resources, open
egress, or otherwise restore effect authority.

## Residual risks and release exclusions

The following are explicitly **excluded** from the shipped surface for this
program and are not mitigated by the controls above. Each remains a known
residual risk carried forward to a later epic; none may be silently enabled.

- **Public service ingress.** `service` ships with controlled outbound access and connector/queue consumption only; tenant-defined public service ingress is excluded.
- **Cloud plugins.** Hosted cloud plugins remain disabled (DE-16) pending a separately isolated plugin-worker architecture and its release evidence; FND-006/FND-008 enforce the exclusion.
- **Unvalidated gVisor bridge egress.** The deferred gVisor pool is not implemented; unvalidated gVisor bridge egress is excluded until its isolation and egress controls are validated.
- **Active-active multi-region writes.** DE-27 covers a two-replica shared-admission configuration only; active-active multi-region writes are excluded, and no AoA database is a peer replica of another.
- **Unattended orphan-output application.** Late, replaced, or orphaned output must never reach authoritative state: unattended orphan-output application into authoritative state is excluded and never automatic — that half is structural, since no promotion or checkpoint-selection operation exists anywhere in the frozen protocol to invoke. ★ **Corrected 2026-09-08:** the clause "late, replaced, or orphaned output *is quarantined*" was true of the receiver and false of the system. No shipped path can write a quarantined artifact row at all: `runOrphanQuarantine` sits three layers behind the zero-production-caller `createStartupReconciler` (`E0-F011` item 1, `E0-F014` item 5). A late result is therefore **dropped, not quarantined**, and a live deployment showing zero quarantine traffic is showing an unwired producer rather than a working control. See `deliveryStatus: partial` on DE-05 and DE-28.
- **Cross-tenant backup or restore (DE-23), out-of-grant local folder mutation (DE-25), and real-provider isolation conformance (DE-26).** Like DE-08 and unlike the entries above, these are **not deliberate scope exclusions**: all three are chartered controls with owner tickets on disk, and all three were measured **`not-delivered`** by W20B on 2026-09-08 (finding `E0-F015`). DE-23's backup and restore code path has no organization or tenant parameter of any kind, so a restore overwriting every tenant with a whole-instance snapshot is its normal behaviour rather than its failure mode. DE-25's grant, base-containment and secret-floor refusals are real, well-tested and reachable only through a factory with zero production callers. DE-26's certified conformance suite has two call sites, both keyless doubles, and the real provider is already measured silently dropping the `ownershipSelector` the double honours. Listing them here is the point: the preamble above says these are residual risks and **not** mitigated controls, and before this entry existed the register's charter language placed all three on the mitigated side. Nothing in this document closes any of them.
- **Sandbox egress to cloud metadata and the control plane (DE-08).** This is a residual risk, **not** a mitigated control, and its absence from this list until 2026-09-06 placed it on the mitigated side by the preamble above. Default-deny egress and blocked metadata/control-plane ranges are **required and absent**: finding `E8-F003` measured, against real E2B sandboxes with a positive control and an apparatus control that both held, that the declared egress allowlist is inert and that `169.254.169.254` answers from inside the guest. Unlike the other entries here, DE-08 is not a deliberate scope exclusion — it is a Critical control that was chartered, whose sole owner ticket (DAT-005) is complete, and that no layer enforces. See `deliveryStatus: not-delivered` on DE-08 and "Required vs delivered" above. Nothing in this document closes it. **★ RATIFIED 2026-09-11 (founder):** this exclusion is now the **terminal, disclosed disposition** of DE-08 at the **managed-shared** tier (options 1 + 3 + 4 of `DECISION-REQUEST-de08-sandbox-egress.md`). `REL-001` treats DE-08 as an accepted, disclosed residual at that tier rather than a blocking gate; egress denial remains **required** at the self-hosted/tenant-hosted boundary, where the operator controls the network. Confidentiality at the managed-shared tier is carried by the **credential taxonomy** (host/operator/cross-tenant secrets never enter the VM; blast radius = one company's own data and own provider key), whose airtightness is now **load-bearing and unverified** — filed as follow-up `E8-F012`. The ruling moves the named control; it does **not** fix the enforcement gap, which stays conceded and disclosed.
