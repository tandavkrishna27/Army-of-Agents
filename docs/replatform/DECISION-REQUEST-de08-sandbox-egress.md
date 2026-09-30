# DECISION REQUEST — DE-08 sandbox egress: a Critical control with no provider-level enforcement layer, now measured

**Date:** 2026-09-11
**Decision:** **DE-08 / E8-F003** — *"What happens to a Critical egress control (`DE-08`) when the
enforcement question is no longer open but MEASURED, and no provider-level layer at this tier can
carry it."*
**Register under discussion:** `docs/architecture/distributed-execution-threat-controls.json`, crossing
`DE-08` (severity `Critical`, `deliveryStatus: not-delivered`, sole `ownerTickets: [DAT-005]`,
`releaseTest: REL-001`).
**Findings this paper reads and does NOT move:** `E8-F003` (the enforcement gap), `E8-F007` (the
refuted capability premise), `E8-F008` (the enforcement measurement).
**Status changes made by this document:** **NONE.** No finding is closed, struck, re-dispositioned or
re-owned; no `deliveryStatus` is moved; no clause text in the register is edited; no
`scripts/gate-clause-wiring.json` enrolment is added or changed; the threat-model exclusion list is
not edited. **Choosing among the options below IS the decision being requested**, so this paper does
not pre-empt it by making any of them. **Production code written:** none.

---

## 0. The settled fact, stated first

**The enforcement question DE-08 turns on is no longer open. It is measured, on real E2B, on both
constructions the provider exposes, and the answer is that provider-level egress control is
UNAVAILABLE at the tier AoA's key reaches.**

| provider construction | verdict | evidence |
|---|---|---|
| `metadata.egressAllowlist` (what production actually sends) | **INERT** | `E8-F003` §2, run `33857218680`. A host NOT on the allowlist was reached; `169.254.169.254` answered HTTP 401 from inside the guest. Positive + apparatus controls held. |
| `network.denyOut` DENY-ONLY (a `denyOut` CIDR list, no `allowOut`) | **ACCEPTED, VALIDATED, ECHOED, INERT** | `E8-F008`, run `34085130892`. The deny set was accepted, server-side-validated (a sibling IPv6 arm drew a `400`), echoed back by `getInfo()` **exactly**, and the denied `169.254.169.254` was reached anyway (401). `updateNetwork` on warm resume left it reachable. |
| `network` default-deny + `allowOut` allowlist (E2B's own documented fine-grained control) | **INERT — MEASURED 2026-09-11** | `E8-F008` §9, run `34528397309` (`c1dec3083`, PR #425). CIDR-only body `allowOut: ["8.8.8.0/24","1.1.1.1"]` PLACED; `getInfo()` echoed it exactly; `9.9.9.9` and `registry.npmjs.org` were `curl 35` = **post-connect = reached-then-broke = reached, not blocked** (a Codex P2 on PR #425 caught the opposite reading); `169.254.169.254` **LEAKED (401)**; `updateNetwork` warm-resume inert. Verdict **FULLY INERT**. |

The two facts a reader must carry out of the table: (1) **the provider `network` surface is now closed
on BOTH of its constructions by MEASUREMENT, not inference** — the census (`E8-F003` §8) has no
UNMEASURED row left; and (2) **the destination that leaks is exactly the one DE-08's `confidentiality`
clause names** — the internal metadata / control-plane range. `curl 35`/`curl 56` are post-connect and
prove no blocking; the only non-reach anywhere was the `.invalid` DNS apparatus control.

The other candidate layers were already refuted and are not re-litigated here: **in-guest** is not a
boundary (the login shell sources an agent-writable home — `sandbox-provider-runtime.ts:647-655`;
STRUCTURAL); **control-plane deny** (`classifyEgressDestination` / `createFenceAwareEgressProxy`)
inspects zero packets because its only non-test importer is a module no production path reaches
(STRUCTURAL, by caller count); **fail-closed-on-no-policy** dissolved because the read-back PASSES on
an unpoliced sandbox, so there is no observable to branch on (DERIVED). `E8-F003` §8 is the census; each
row is labelled by evidence class there and must not be collapsed into one word.

**What this settles for the decision.** `E8-F003` §8 closes with *"What to do about a `Critical`
control that cannot be enforced at any available layer is a founder decision that has not been
taken."* This paper is the input to that ruling. **It is not the ruling.** It moves no status and edits
no clause; it lays out the honest options and recommends one, and the choice is the founder's.

**The register still reads what the measurements support.** `DE-08.deliveryStatus` is `not-delivered`;
its six clauses read `REQUIRED (not delivered)`; its sole owner ticket `DAT-005` is `COMPLETE`; its
`releaseTest` `REL-001` has zero files. Nothing below changes any of that — the point of a decision
paper is that the amendment, the charter, or the exclusion is what the founder approves, not what this
unit applies.

---

## 1. The clause, verbatim, and what each conjunct now asserts against measurement

From `DE-08` in `distributed-execution-threat-controls.json`:

> `"confidentiality": "REQUIRED (not delivered): internal metadata and control-plane ranges must be unreachable"`
> `"authorization":  "REQUIRED (not delivered): default-deny; only allowlisted destinations may be permitted"`
> `"integrity":      "REQUIRED (not delivered): blocked IP/DNS ranges must not be reachable via rebinding"`
> `"revocation":     "REQUIRED (not delivered): policy changes must take effect per lease; deny must be the default"`
> `"audit":          "REQUIRED (not delivered): allowed and denied egress destinations must be audited"`
> `"control":        "default-deny egress and blocked ranges"`
> `"trustedSide":    "filtered egress and a credential-injecting proxy"`

**These are the honest form already** — every clause is explicitly marked `REQUIRED (not delivered)`,
so unlike the E0-F013 clause-halves this row does not misrepresent delivery. What it *does* assert is
that filtered, default-deny egress is the **control** and `filtered egress` the **trusted side** — i.e.
that egress denial is the mechanism carrying confidentiality. The measurement in §0 says that mechanism
is unavailable at this tier. So the question DE-08 poses is not "is the clause honest about delivery"
(it is) but **"is egress denial the right control to name at all, given it cannot be built here, and if
not, what carries confidentiality instead?"**

One scope note the measurement itself insists on (`E8-F003` §2, "Scope"): the `169.254.169.254` service
is the **provider's** infrastructure, and what a token-bearing caller would extract from it is
**unmeasured**. Reachability is measured; exploitability is not. This matters for weighing the options —
it is the difference between "a Critical breach is proven" (it is not) and "a Critical control's stated
mechanism is proven absent" (it is).

---

## 2. The options

Each option is stated with what it costs and what it leaves true, in the house framing of Decision 1:
**amend the wording, charter the machinery, or disclose the residual.** The unit of the ruling is the
crossing, not a single clause, because on DE-08 the confidentiality / authorization / integrity /
revocation clauses stand or fall together on the same missing mechanism.

### Option 1 — AMEND DE-08 to what is true: confidentiality is carried by a DIFFERENT control

Amend the clauses so they stop naming provider-level egress denial as the mechanism and instead name
the control that actually bounds the blast radius: **the sandbox holds no durable, cross-tenant, or
host secret worth exfiltrating.** This is not an invention — it is the deployed
`cloud_auth` posture, written down as a definitive credential taxonomy at
`docs/aoa/plans/2026-08-05-cloud-execution-isolation-e2b-spec.md:149-155` (§9):

- **NEVER enters the VM** (host/operator/infra secrets): `DATABASE_URL`/`DIRECT_DATABASE_URL`, the
  secrets **master key**, `GITHUB_PAT`, `BETTER_AUTH_SECRET`/`AOA_AGENT_JWT_SECRET`, `REDIS_URL`, the
  embeddings key, the operator `~/.claude` login and its env forms, and any host-ambient provider key
  that is not the tenant company's own (spec §9, first bullet; U5 allowlist + absence test).
- **MAY enter the VM** — only that one company's **own** runtime credentials: its model-provider API
  key, its connector tokens (`AOA_MCP_*_TOKEN`), the per-run run-JWT. Signing secrets that MINT these
  stay host-side; only the minted value crosses. For OAuth connectors only the short-lived ACCESS
  token crosses, re-minted host-side at every stage-in (spec §9, §7, `:132`).
- **Blast radius of a compromised VM = that one company's own data + own provider key** (spec §9,
  "Blast radius"). Intra-company defence-in-depth, not a tenant breach.

**Exact proposed wording** (original text retained verbatim ahead of the amendment, in the house style
of `DE-15.audit` and `DE-20.revocation`). The founder approves this; this paper does not apply it:

> `"confidentiality": "REQUIRED (not delivered): internal metadata and control-plane ranges must be unreachable. ★ AMENDED <date> by founder ruling (DE-08 sandbox-egress decision). MEASURED at this tier the provider offers NO egress-denial mechanism -- metadata.egressAllowlist is inert (E8-F003 run 33857218680), and BOTH network constructions (denyOut-only, run 34085130892; default-deny+allowOut, run 34528397309) are inert and leak 169.254.169.254. Reachability of the provider metadata range is therefore CONCEDED at the managed-shared tier. Confidentiality is instead carried by the CREDENTIAL TAXONOMY (2026-08-05-cloud-execution-isolation-e2b-spec.md:149-155, spec §9): host/operator/cross-tenant secrets NEVER enter the VM, only the company's own runtime credentials do, and the compromised-VM blast radius is that one company's own data and own provider key -- an intra-company boundary, not a tenant breach. WHAT IS STILL UNMEASURED, stated so it is not read away: what a token-bearing caller would extract from the provider's 169.254.169.254 is unmeasured (E8-F003 §2 scope); this amendment relies on the taxonomy holding, and its env-absence test (spec §10) is the load-bearing check."`
> `"authorization": "REQUIRED (not delivered): default-deny; only allowlisted destinations may be permitted. ★ AMENDED <date>: default-deny egress is UNAVAILABLE at the managed-shared tier (measured, both network constructions inert). This clause no longer asserts a destination allowlist at that tier; it is deferred to the self-hosted/tenant-hosted boundary where the operator controls the substrate (spec §12, 'enforcement is a self-hosted concern')."`
> `"integrity": "REQUIRED (not delivered): blocked IP/DNS ranges must not be reachable via rebinding. ★ AMENDED <date>: vacuous at this tier -- there is no block to rebind past, because no range is blocked (measured). Reinstated when an enforcing layer exists."`
> `"control": "default-deny egress and blocked ranges -- ★ AMENDED <date>: at the managed-shared tier the operative control is the credential taxonomy (no exfiltratable secret in the VM), NOT egress denial; egress denial is a self-hosted/tenant-hosted concern."`

- **Which clause words change:** `confidentiality`, `authorization`, `integrity` and `control` are
  appended-to (not overwritten); `revocation` and `audit` are left as-is (they are downstream of a
  mechanism that does not exist and become live only if Option 2 or 4 builds one).
- **What invariant this leaves.** DE-08 no longer claims the metadata range is unreachable at the
  managed-shared tier; it claims the VM holds nothing whose exfiltration crosses a tenant boundary. The
  Critical severity is **retained** — the residual (provider-metadata exploitability, unmeasured) is
  real — but the control named is the one that actually holds.
- **What is lost, and who is harmed.** If the credential taxonomy is ever wrong — a host secret leaks
  into VM env, or the provider metadata endpoint yields a cross-tenant credential — DE-08 no longer
  names a layer that would have caught it, because none exists. The harmed party is **a company whose
  own provider key sits in a VM that can reach the provider's metadata service**; the amendment makes
  the taxonomy's absence-test (spec §10) the single load-bearing control, and says so.

### Option 2 — CHARTER in-guest enforcement (BRW-004 slice (f) / D3 option (c))

Build the only enforcement point the agent cannot trivially edit around: an in-sandbox egress
constraint applied before the guest login shell runs. It is chartered as **BRW-004 slice (f)** (open,
`gate_review`) and named as design **D3 option (c)** in the E8 records.

- **Scope, honestly.** Slice (f) is scoped to **browser sessions**. The measurement in §0 is of **org
  heartbeat runs and crew runs**, and the metadata half is broader still — **every sandboxed workload
  shares the reachability** (`E8-F003` §7). So slice (f) as chartered would enforce egress for the
  browser path and leave the org/crew sandbox path — the one every workload shares — unenforced. To
  cover DE-08 it would have to be re-scoped to the shared sandbox path, which is inventing a new owner,
  not extending slice (f).
- **It is unbuilt**, and the in-guest layer is measured **not a boundary** for anything the login shell
  can reach (`E8-F003` §8 row 3): `buildE2bLoginShellScript` sources an agent-writable home before
  `exec env … claude`, so an in-guest control is agent-editable by construction. An in-guest constraint
  applied *before* the shell and *outside* the agent-writable surface is conceivable, but no such
  mechanism exists today and the measurement is a standing warning that in-guest is the wrong side of
  the trust boundary.
- **Is it worth building given the measurement?** For the browser path it may be — but not as DE-08's
  answer. DE-08's boundary is the shared sandbox egress path, and slice (f) does not reach it.

### Option 3 — ACCEPT as a documented release exclusion (the gVisor-bridge precedent)

Ratify DE-08 as a **known, disclosed residual** riding `REL-001`, exactly as the threat model already
does for the sibling *"Unvalidated gVisor bridge egress"* exclusion
(`distributed-execution-threat-model.md:296`).

- **★ This is PARTLY ALREADY RECORDED, and that is the strongest fact about this option.** DE-08 is
  **already listed** in the threat model's "Residual risks and release exclusions"
  (`distributed-execution-threat-model.md:300`, added 2026-09-06): *"Sandbox egress to cloud metadata
  and the control plane (DE-08) … a residual risk, not a mitigated control … a Critical control that
  was chartered, whose sole owner ticket (DAT-005) is complete, and that no layer enforces."* So the
  disclosure exists. **What does NOT exist is a founder RULING that this disclosure is the terminal
  disposition** — the register still reads `not-delivered` (correctly), `E8-F003` is still open, and
  `E8-F003` §8 still says the decision "has not been taken." Option 3 is therefore *"ratify the existing
  exclusion as the answer,"* not *"write a new one."*
- **What it costs.** DE-08 ships as a Critical control that no layer enforces, disclosed. `REL-001`
  gates on a control the register says is absent — so `REL-001` must be amended to treat DE-08 as an
  accepted exclusion rather than a blocking gate, or it blocks release forever. This option does the
  least engineering and the most disclosure.
- **What it leaves true.** The metadata range stays reachable from every managed-shared sandbox. The
  only thing bounding the blast radius is the credential taxonomy (Option 1's control) — which is why
  **Option 3 is honest only if Option 1's amendment is also made**: an exclusion that discloses "egress
  is not denied" while the register still names egress denial as the confidentiality control is
  internally contradictory, the same contradiction Decision 1.4 flagged on DE-20.

### Option 4 — SCOPE the exclusion to the managed-shared tier; require enforcement on self-hosted / tenant-hosted

The measurement is specifically about **the tier AoA's shared-pool key reaches**. The deployed spec
already says *"enforcement is a self-hosted concern"*
(`2026-08-06-e2b-plan-wave4-files.md:105`; §12). A `tenant_hosted` / self-hosted operator controls the
E2B server (or a different substrate) and can enforce egress there. So a fourth honest option: **amend
DE-08's `authorization`/`integrity` clauses to hold at the self-hosted/tenant-hosted boundary and be
excluded at the managed-shared tier** — a deployment-mode-scoped clause, in the shape of DE-27's
"two-replica only, active-active excluded" split (`threat-model.md:297`).

- **What it costs.** A per-deployment-mode clause is more machinery in the register and needs a
  self-hosted enforcement test that does not exist today (no owner ticket names it). It does not help
  the managed-shared tier at all — that tier still relies on Option 1's taxonomy.
- **What it leaves true.** It is the most precise statement of the measured fact: egress denial is not
  that AoA *can't* do it anywhere, but that it can't at the shared managed tier, which is a property of
  the tier and not of the control. It pairs naturally with Option 1 (taxonomy at shared) + Option 3
  (disclosed residual at shared).

---

## 3. Recommendation

**Recommended: Option 1 (amend to the credential-taxonomy control) + Option 3 (ratify the existing
threat-model exclusion as terminal), scoped by Option 4's deployment boundary.** Framed as the
founder's choice; the reasoning is below and the founder may weigh the residual differently.

**Why enforce-egress-at-the-provider is off the table.** The census (`E8-F003` §8) has no candidate
left. Provider `metadata`, provider `network` deny-only, and provider `network` default-deny+allowlist
are all MEASURED inert on real E2B; in-guest is structurally not a boundary; the control-plane
classifier inspects zero packets; fail-closed-on-no-policy has no observable to branch on. Continuing
to name default-deny egress as DE-08's control is naming a mechanism three measurements say does not
exist at this tier — which is precisely the misrepresentation `E8-F003` §1 filed the finding to end.
Option 2 does not rescue this: BRW-004 slice (f) is scoped to browser sessions and does not reach the
shared sandbox path DE-08 names, and the in-guest layer it lives in is measured agent-writable.

**Why 1 + 3 + 4 together and not one alone.** Option 3 alone is dishonest while the register still
names egress denial as the control (the DE-20 contradiction). Option 1 alone silently drops a Critical
control's disclosure. Option 4 alone helps only self-hosted. Together: Option 1 names the control that
actually holds (taxonomy), Option 4 says *where* egress denial is still owed (self-hosted), and Option 3
ratifies the already-written managed-shared exclusion so `REL-001` stops gating on an absent layer. **DE-08
stays Critical and stays `not-delivered` for the egress mechanism** — the amendment moves the *named
control*, it does not claim delivery.

**★ The strongest argument against the recommendation.** *A Critical SSRF control amended to "the VM
holds no secret worth stealing" is a control relocated onto an UNMEASURED premise.* `E8-F003` §2 is
explicit that the provider metadata endpoint's exploitability is unmeasured — nobody has shown that
`169.254.169.254` does NOT yield a cross-tenant credential to a token-bearing caller. Option 1 leans the
whole confidentiality guarantee on the credential taxonomy's env-absence test (spec §10) holding
perfectly, forever, for every workload — and the in-guest measurement already shows how much of the
guest is agent-writable. If the founder judges that residual too close to a live Critical exposure, the
correct move is **Option 2 re-scoped to the shared sandbox path and funded as a real epic** (accept that
egress denial must be built somewhere the agent cannot edit, even if not at the provider), or to hold
DE-08 open and un-ratified until the provider tier changes. **A relocated guarantee is only as good as
the control it is relocated onto**, and this paper cannot measure that the taxonomy is airtight — it can
only record that the taxonomy is the deployed design and that egress denial, measured, is not available.

---

## 4. What this paper is not

It changes **no** finding status, **no** `deliveryStatus`, **no** ownership, **no** clause text, **no**
threat-model exclusion entry and **no** gate-clause enrolment. It wires nothing and writes no production
code. It exists so the DE-08 egress ruling `E8-F003` §8 names as un-taken can be signed — with the
enforcement question treated as measured, not open, and with the option to move DE-08's named control
onto the taxonomy that actually bounds its blast radius rather than the egress denial that does not
exist at this tier.

---

## ▣ DECISION — DE-08 / E8-F003, sandbox egress

**★ RULED 2026-09-11 (founder): 1 + 3 + 4.** Options 1 (amend the clauses to name the
credential-taxonomy control at the managed-shared tier), 3 (ratify the existing threat-model
exclusion as the terminal, disclosed disposition; `REL-001` treats DE-08 as an accepted residual
rather than a blocking gate) and 4 (egress denial scoped OUT at managed-shared and REQUIRED at the
self-hosted/tenant-hosted boundary) are **ADOPTED**; **Option 2 and Hold open are NOT adopted.** This
ruling is APPLIED (register-amend unit, docs-only): `distributed-execution-threat-controls.json` DE-08
has its `confidentiality`/`authorization`/`integrity`/`control` clauses amended with the §2 Option 1
`★ AMENDED` blocks dated 2026-09-11 (`revocation`/`audit` left as-is; severity stays **Critical**;
`deliveryStatus` stays **not-delivered**); the DE-08 residual entry in
`distributed-execution-threat-model.md` is ratified as terminal; and `E8-F003` is narrowed (not
closed). The credential-taxonomy airtightness that now carries confidentiality is filed as follow-up
`E8-F012` (`scripts/finding-ownership.json`, unowned).

- ☑ **Option 1 ★ (RULED — part of RECOMMENDED)** — Amend `confidentiality`/`authorization`/`integrity`/`control`
  to name the credential taxonomy as the operative control at the managed-shared tier (exact text in
  §2, Option 1). Keep `revocation`/`audit` as-is. Retain Critical severity and `not-delivered`.
- ☒ **Option 2 (NOT adopted)** — Charter in-guest enforcement. *As chartered (BRW-004 slice (f)) it covers browser
  sessions only, not the shared sandbox path; re-scoping it to that path invents a new owner, and the
  in-guest layer is measured not-a-boundary. Choose only if provider-tier egress denial being off the
  table is unacceptable and a non-agent-writable in-guest point is judged buildable.*
- ☑ **Option 3 ★ (RULED — part of RECOMMENDED)** — Ratify the EXISTING threat-model exclusion
  (`threat-model.md:300`) as the terminal disposition; amend `REL-001` to treat DE-08 as an accepted,
  disclosed residual rather than a blocking gate. *Honest only if Option 1 is also taken, else the
  register names a control (egress denial) that the exclusion concedes absent.*
- ☑ **Option 4 ★ (RULED — scoping, part of RECOMMENDED)** — Scope the egress-denial obligation to the
  self-hosted/tenant-hosted boundary and exclude it at the managed-shared tier, in the shape of DE-27's
  deployment-mode split.
- ☒ **Hold open (NOT adopted)** — Take none of the above; leave `DE-08` `not-delivered`, `E8-F003` open, and the
  ruling un-taken until the provider tier changes. *The status quo the finding calls "a founder decision
  that has not been taken."*

**★ Record with whichever is chosen, because it is measured and a future reader will otherwise
re-open it:** provider-level egress denial is closed on **all three** provider constructions by
MEASUREMENT (`metadata` run `33857218680`; `network` deny-only run `34085130892`; `network`
default-deny+allowlist run `34528397309`), `curl 35`/`56` are post-connect = reached-not-blocked, and
the metadata range `169.254.169.254` leaks on every construction. Do not re-propose a provider egress
layer without a run id and a positive control. `E8-F003` §8 census, `E8-F008` §9,
`W10B-egress-enforcement-result.md` §15.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
