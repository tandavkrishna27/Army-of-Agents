# W10B — the DE-08 egress-enforcement probe: operator runbook

**Status:** built, CI-green, **FIRED ONCE** — run [`34085130892`](https://github.com/MeteoriteLabs/AoA/actions/runs/34085130892), 2026-09-07, on `docs/replatform-program` at `ab23eabdc`, template `aoa-base`.
**Verdict: `measured` — `a=no b=yes c=no d=no e=no regression=no`; `DECISION: abandon (denyout-is-inert-at-this-tier)`.** §12 is the record; §7's block is that run's real report.
Firing it again is an operator action.
**★ A FIFTH ARM WAS ADDED 2026-09-09 (W10B-B), DISPATCHED TWICE, AND RETURNED `UNRUN` BOTH TIMES —
§13.7.** The `measured` verdict above is about a `denyOut` list with no `allowOut`; the
default-deny-plus-allowlist shape E2B documents as the control is **still UNMEASURED**. Runs
[`34328502574`](https://github.com/MeteoriteLabs/AoA/actions/runs/34328502574) and
[`34328780645`](https://github.com/MeteoriteLabs/AoA/actions/runs/34328780645) both failed to place
that arm's sandbox (`500: Failed to place sandbox … please retry`) while their sibling arms placed
seconds apart on the same template. **`UNRUN` is not `INERT`** — the sandbox never existed, so
nothing about enforcement was observed either way.
**Written:** 2026-09-07, against `73f3b00fd`.
**Read this instead of the source.** Everything you need to run the probe and read its answer is here.

---

## 1. What this measures, in one paragraph

DE-08 — *"Sandbox ↔ network egress"*, severity **Critical** — has enforcement at **no layer**. Finding
**E8-F003** (HIGH, open) measured that against real E2B in workflow run `33857218680`, with a positive
control and an apparatus control both holding, and traced the absence to all three candidate points:
the provider seam is inert, the in-sandbox point was never attempted, and the proxy classifier's only
route into production is a module nothing imports. This probe decides whether the **one candidate
layer outside the guest** is real, by measuring the E2B network seam AoA has **never called**. It
**builds nothing**, applies **no policy to any production code path**, changes no gate, counter or
register, spends **no model tokens**, and touches no database. It creates four short-TTL sandboxes,
runs read-only reachability probes inside them, records a verdict **durably** (§6), and tears them
down.
**★ It has now run, and the answer was the inert one. §12 carries the record, the verdicts and what
they closed; finding `E8-F008` carries the analysis. Read §12 before re-firing it.**

---

## 2. ★ THE STOP CONDITION — read this before you fire

**If question (c) comes back `YES`, the provider-network option is ABANDONED, and that is a
successful measurement.**

Question (c) asks whether the guest's **DNS resolver** is inside the deny set. If a nameserver's
address falls in a denied range, denying that range breaks **all** name resolution in the guest — and
**this API has no repair**:

* `denyOut` carries **no exclude list**. There is no way to say "deny 10.0.0.0/8 except 10.0.0.2".
* Adding an `allowOut` entry to carve the resolver out does not carve anything out: the SDK's own
  documentation says *"If `allowOut` is not specified, all outbound traffic is allowed"*, so
  specifying it flips the **whole** policy to default-deny — the opposite of a carve-out.

> ★★★ **AND THAT SECOND BULLET IS THE HINGE THIS UNIT TURNED, 2026-09-09 (W10B-B).** "Any `allowOut`
> entry flips the whole policy to default-deny" is a correct statement of the mechanism, and this
> section filed it as a **hazard to avoid** — rightly, for a probe whose deny set could not name the
> resolver. But default-deny-plus-allowlist is exactly the construction **E2B's own documentation
> presents as the fine-grained control**, and the flip is only fatal while the resolver is
> *unnameable*. It is nameable: this very run read `nameserver 8.8.8.8` from `/etc/resolv.conf` in
> **both** arms, a static public address, so an `allowOut` entry of `8.8.8.0/24` admits it. **The
> shape this section treats as the thing that would break the experiment is the shape a real control
> would have to take — and it was never tested.** §13. **It has since been attempted twice and is
> still untested: both dispatches failed to place the sandbox (§13.7), so the flip hazard this
> section describes was never even reached.**

So a `yes` on (c) closes the option outright, and the pack **says so itself**: `decideOption` computes
the consequence and prints it as `DECISION: abandon (resolver-or-resolution-is-inside-the-deny-set)`
at the bottom of the report and in the durable record. It does not leave five three-state lines for a
reader to synthesise.

**That outcome keeps the lane GREEN.** It is a complete and valuable result: it retires the last
candidate enforcement layer outside the guest, and DE-08 must then be recorded as having *no available
provider-level control* rather than an unbuilt one. Write that into E8-F003's successor and stop
costing the programme design time on an option that cannot exist.

> ★ **Why (c) is answerable even when (a) says the policy is inert.** The structural half is pure
> arithmetic — is the nameserver's address inside a declared CIDR — and needs no enforcement to be
> true. So the abandon question is answered even by a tier that ignores `denyOut` completely.

---

## 3. The premise this probe retires, and what is still open

Three records in this repository book the provider layer as unavailable on the strength of one
sentence — *"managed-E2B egress is not fully lockable"* (REFUTED as a capability claim;
finding **E8-F007** owns that premise, and `scripts/check-w10a-sdk-capability-premise.mjs`
is what stops it being restated without a marker beside it):

| Where | What it says |
|---|---|
| `server/src/services/sandbox-provider-runtime.ts`, the `acquireLease` metadata comment | **corrected by sibling unit W10A**, which landed first; the correction is pinned PER OCCURRENCE by W10A's guard in the required `policy` job, not by anything in this unit |
| the 2026-08-05 cloud-execution-isolation spec, §12 | **carries W10A's dated correction beside the original sentence**; the bullet itself is left standing as the thing being corrected |
| finding **E8-F003**'s own *"option (b) is unavailable"* | a clause was **added**, not removed — see §9 |

Against the installed, **lockfile-pinned** `e2b@2.30.5` that sentence is **false as a statement about
the seam**:

* `SandboxOpts.network?: SandboxNetworkOpts` with `allowOut` / `denyOut` (`dist/index.d.ts`);
* `buildNetworkBody` → the `POST /sandboxes` request body (`dist/index.js`, `createSandbox`) — it
  reaches the wire;
* `Sandbox.updateNetwork` → `PUT /sandboxes/{sandboxID}/network`;
* `getInfo()` mapping the server's answer back to `SandboxInfo.network`.

**AoA has never called any of it.** What was still unmeasured when this runbook was written is whether
the operator's tier **enforces** what the seam declares — and that is precisely what this run
answered. The honest correction is therefore *"the seam exists and was never called"*, **not**
*"the boundary works"*.
**★ MEASURED 2026-09-07 (run `34085130892`): the tier does NOT enforce the shape that was tested. It
accepts the deny set, validates it server-side, stores it, reads it back verbatim — and routes the
denied traffic anyway. `E8-F008`. §12.**
**★★ NARROWED 2026-09-09 (W10B-B). That run measured a `denyOut` CIDR list with NO `allowOut`. E2B
documents a DIFFERENT construction as the fine-grained control — default-deny plus an `allowOut`
allowlist — and it is UNMEASURED. §13 is the arm for it. ATTEMPTED TWICE on 2026-09-09 (runs
`34328502574`, `34328780645`) and `UNRUN` both times: `Sandbox.create` failed to place that body
(`500 … please retry`) while sibling arms placed seconds apart, so the shape is still unmeasured and
`UNRUN` must not be read as `INERT` — §13.7. `Unmeasured` is not `probably works`: `DE-08` stays
`not-delivered` and nothing in the product passes a `network` body.**

> ★★★ **And that is why the read-back, question (b), is a first-class question rather than a
> footnote.** **★ SUPERSEDED BY THE RUN, and this is the single most important correction in this
> document: question (b) came back `YES` on a sandbox that reached its own declared denied range. The
> read-back is REAL and it is NOT A SAFEGUARD. It was specified against the tolerant server described
> below; the measured tier is the opposite of that server, so the trigger never fires and the check
> certifies an unpoliced sandbox. A read-back verifies what was DECLARED, never what is ENFORCED.
> Do not carry the paragraph below forward as a design safeguard — read `E8-F008` §3.** `buildNetworkEgress` is a **pure passthrough** — the SDK validates nothing client-side,
> and the only error path is the HTTP status. The API target is per-company configurable
> (`resolveE2bDomain` = `config.domain ?? env.E2B_DOMAIN`, with a self-hosted branch). A **tolerant or
> self-hosted server that ignores an unknown field returns 200** and hands back an **unpoliced sandbox
> with identical code and identical logs**. Without a read-back there is no way to tell that sandbox
> from a policed one, so a `no` on (b) makes the approach unshippable **even if (a) is yes here**.

---

## 4. The trigger command

```bash
gh workflow run keyed-e2b-w10b-egress-enforcement-probe.yml --ref docs/replatform-program -f e2b_template=aoa-base
```

If that answers `HTTP 404: workflow ... not found on the default branch` — which happens to a lane
GitHub has not yet indexed, measured on `keyed-e2b-egress-constraint-probe.yml` on 2026-09-04 — use the
push route instead. It always works:

```bash
git switch docs/replatform-program && git pull
echo "W10B probe run #1 (2026-09-XX): why you are firing it" >> .github/keyed-e2b-w10b-egress-enforcement-trigger
git add .github/keyed-e2b-w10b-egress-enforcement-trigger
git commit -m "chore(w10b): fire the egress-enforcement probe"
git push
```

`.github/keyed-e2b-w10b-egress-enforcement-trigger` is the **only** path in the workflow's `push`
filter, and this probe's PR deliberately does **not** create it. So merging the probe fires nothing,
and editing the probe's own source later fires nothing either.

> ★ **Why this lane does not re-fire on a source change, when some of its siblings do.**
> `keyed-e2b-unit-d.yml` lists the module under test in `paths` on purpose. That is right for a lane
> that costs only sandbox seconds. **The founder authorises keyed E2B runs individually**, so an
> automatic re-fire would consume an authorisation nobody gave.

### 4a. Inputs

| Input | Default | What it does |
|---|---|---|
| `e2b_template` | empty → resolves to **`aoa-base`** | The image to measure in. **Empty does NOT mean bare `base` on this lane.** |
| `aoa_api_url` | `https://testing.armyofagents.org/` | The AoA control-plane **product-regression** row. Set it to your own control plane, or **empty** to skip that row — in which case the regression verdict reports itself **PARTIAL** and names the row it did not exercise. |

**Pass `aoa-base`.** It is the image AoA production runs (`e2b/README.md` threads it end to end as
`E2B_TEMPLATE=aoa-base`), so a reachability result about it is a result about the product; and
`e2b/e2b.Dockerfile` builds it `FROM node:22` with **`curl` and `python3`** installed, which question
(e) needs. The bare `base` template is recorded as *"coreutils only"*
(`.github/keyed-e2b-trigger` entry #4); on it, (e) reports `no-raw-socket-tool` and the lane reds as
inconclusive — a wasted authorisation. `resolveTemplate` therefore corrects **omission** and only
omission; an explicitly typed alias is honoured verbatim, and the resolved id is printed at the top of
the report and stored in the durable record.

The **push route is safe too**: a `push` event carries no inputs, so `E2B_TEMPLATE` arrives empty and
the same resolution applies. There is no way to fire a bare-`base` run by omission from either route.
(Note that the push route also leaves `aoa_api_url` empty, so that one product-regression row is
skipped and the verdict says so.)

---

## 5. What it costs, and what it needs

| | |
|---|---|
| Secrets | **`E2B_API_KEY` only** — it already exists as a repo secret. **No model-provider key**, and no model tokens are spent. |
| Sandboxes ATTEMPTED | **5** — the policy arm, the anti-vacuity arm, the reuse arm, the IPv6-deny arm, and (added W10B-B) the **allowlist arm** (§13). ★ **Two of the five have never been created on this tier:** the IPv6-deny arm is refused at create (`400: invalid denied CIDR`) and the allowlist arm failed to place on both 2026-09-09 dispatches (`500 … please retry`, §13.7). Budget for 5; expect 3. |
| Sandbox TTL (hard ceiling per sandbox) | 420 s for the two differential arms and the allowlist arm; 300 s for the reuse and IPv6 arms |
| Expected wall time | **~8–15 minutes**. Each HTTP target is one `curl --max-time 12`; each raw socket is one 8-second connect; the allowlist arm adds six HTTP rows, one 8-second DNS lookup and one local command. |
| Absolute worst case if everything stalls | 3 × 420 s + 2 × 300 s = 1,860 sandbox-seconds, and only if every teardown also fails — every sandbox is killed in a `finally`. |
| Job timeout | 45 minutes (the in-test budget is 38, so a kill names the job rather than an innocent step) |

Without `E2B_API_KEY` the pack **skips** and the workflow's own positive-control step fails the job
with a message saying so. A skip is never a pass. No key is written into the repository, printed, or
embedded in a fixture; every string the pack emits passes through its own redactor
(`redactSecrets`, unit-tested in the required `policy` job).

### 5a. The experiment, in one table

| Arm | `network` at create | What it is for |
|---|---|---|
| **P** policy | `denyOut: [169.254.0.0/16, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16]` | the measurement: (a), (b), (c), (e), and the product-regression rows |
| **N** anti-vacuity | `denyOut: [198.51.100.0/24]` (RFC 5737 TEST-NET-2) | **the control that makes a deny result attributable.** It differs from P in exactly one thing — *which* addresses are denied — not in whether a network config exists at all |
| **U** reuse | none at create, then `updateNetwork(denyOut: …)` | (d) |
| **P6** IPv6 | the P set **plus** `fe80::/10, fd00::/8, ::ffff:0:0/96` | an **observation**, not a verdict: does the API even accept IPv6 deny entries? |
| **A** allowlist *(W10B-B)* | `denyOut: ({ allTraffic }) => [allTraffic]` **plus** `allowOut: ["8.8.8.0/24", "1.1.1.1"]` — **CIDRs/IPs only, no domain** | **§13.** The shape E2B DOCUMENTS as the control, which arms P/N/U/P6 do not test. Its own vocabulary — ENFORCES / INERT / BROKEN — and **no vote in `DISPOSITION`**. ★ **The domain-bearing shape (`…, "example.com"`) failed to place its sandbox on BOTH 2026-09-09 dispatches (`500 … please retry`) and returned `UNRUN` — no verdict — while P and N placed seconds apart (§13.7). A hostname in `allowOut` forces `validateEgressRules` to require `0.0.0.0/0` in `denyOut` AND routes the sandbox through the tcpproxy L7 path, which 500s at create on this tier; dropping the domain routes down the plain iptables path so the arm can finally place and measure.** |

> ★★ **Loopback (`127.0.0.0/8`) and CGNAT (`100.64.0.0/10`) are deliberately NOT in the deny set.**
> A `systemd-resolved` stub listens on `127.0.0.53`, and cloud fabrics use CGNAT for infrastructure the
> sandbox may need to stay alive. Denying either could brick the command channel and report the
> bricking as the measurement — spending your authorised run on an apparatus failure. The deny set is
> the ranges a real DE-08 control must cover, **minus the two that could take the apparatus down with
> them**, and the durable record carries the set so no later reader mistakes it for the whole control.

### 5b. The mandatory control rows

No answer is admissible without all four, and none substitutes for another:

| Control | Must show | Without it |
|---|---|---|
| **POSITIVE** — an allowed public host, in the policy arm | **REACHED** | a total outage reads as "enforced" |
| **APPARATUS** — an RFC-2606 `.invalid` host, in **both** arms | **FAILS** | the probe might not be reading the network at all |
| **ANTI-VACUITY** — the question target in the arm whose deny set does *not* name it | **REACHED** | a deny result is unattributable: E2B might block that destination anyway |
| **COMPLETENESS** — every row parsed | no missing rows | a dropped row is invisible; it cost the sibling probe two runs |
| **PRODUCT-REGRESSION** — DNS, the package registry, the model API and the AoA control plane, under the deny set | **REACHED** | (separate verdict, §7) a control that breaks the product is unshippable whatever (a) says |

---

## 6. Where the answer goes

The verdict is written to **three** places, on a red run as well as a green one:

| Where | What is there |
|---|---|
| **Job summary** (the run page, nothing to download) | the whole human report, as a fenced block — the fastest read |
| **`w10b-egress-enforcement-record` artefact** (90-day retention) | `w10b-egress-enforcement-record.json`, schema `aoa.w10b.egress-enforcement-record/1`: the disposition, the **computed decision**, **every question's state AND reason**, the **resolved template**, the **declared deny set**, the observations (both arms' `/etc/resolv.conf`, the `getInfo()` network object, the reuse shape, the IPv6 arm) and the commit sha |
| **Step log** | the same report plus every per-row line, parsed or not |

> ★★★ **Why the pack is not allowed to answer only into a log.** E7-F025 measured this repo's own
> instance: a sibling keyed lane **already fired twice** and **no document records either outcome**, so
> the honest state of that measurement is *fired and unrecorded* and the next session re-asks the
> question. Both the fallback writer and the artefact upload are `if: always()` for the same reason:
> the **inconclusive** run is exactly the run whose detail somebody needs, and exactly the run a
> success-gated step throws away. `evaluateDurableRecord`
> (`scripts/lib/w10b-egress-enforcement-probe.mjs`) asserts both guards — plus the keyless
> positive-control step — against the real YAML in the required `policy` job, so removing any of them
> reds CI.

**After the run: copy the record into `W10B-egress-enforcement-result.md` next to this file, naming
the run id.** The artefact is retained for 90 days; the ticket record is not.

---

## 7. How to read each answer

Every question reports one of three states. **`no` is a result and the lane stays GREEN for it — and
so does (c)'s ABANDON `yes`.** `inconclusive` is the only state that reds, because it is the only one
that means *run me again*.

> ★★★ **Why that asymmetry is the point.** If the only green outcome were "the boundary works", then
> "the boundary does not work" would arrive as a red build — indistinguishable from a bad key, a
> template change or an outage — and your one authorised run would have bought an ambiguity instead of
> an answer. A probe that can only pass is worthless.

> ### ✅ THE REAL REPORT — run [`34085130892`](https://github.com/MeteoriteLabs/AoA/actions/runs/34085130892), 2026-09-07
>
> The illustrative placeholder block that stood here has been **replaced by the actual summary**, as
> this section's own instruction required. Every state below is a measurement at `ab23eabdc`, template
> `aoa-base`. The same text is in the run's job summary and in the
> `w10b-egress-enforcement-record` artefact (90-day retention); the durable copy that outlives the
> artefact is `W10B-egress-enforcement-result.md`, beside this file.

```
========== W10B DE-08 EGRESS-ENFORCEMENT PROBE — RESULT ==========
TEMPLATE: aoa-base   (default-product-image)
  no template was supplied, so the pack resolved to "aoa-base" — the image AoA production runs, built FROM node:22 with curl and python3 installed. It does NOT fall back to "base": that image has no raw-socket tool, so question (e) would be inconclusive for want of a tool rather than an answer.
DENY SET (policy arm): 169.254.0.0/16, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
ANTI-VACUITY SET     : 198.51.100.0/24
commit: ab23eabdc0504b05156829207940be80d3ec5bd4   run nonce: W10B-MTQRVDJP-2FEX4EOA

Questions:
  a  HONOURED?   is a target inside the declared deny set actually unreachable?
  b  VERIFIABLE? does getInfo() materialize the policy back?
  c  ★ ABANDON?  is the guest's DNS resolver inside the deny set?
  d  RE-ASSERT?  does updateNetwork work on a reused sandbox?
  e  WHERE?      packet path, or an L7 proxy the guest can route around?

PROBE a: NO — denied-target-still-reachable
    169.254.169.254 was REACHED (401) from inside the sandbox that declared 169.254.0.0/16 in denyOut, exactly as from the anti-vacuity arm. The declared deny set is INERT at this tier — the same result the metadata.egressAllowlist seam already produced (E8-F003), one API surface over. That closes the provider-network option and it is a RESULT, not a failure. IPv6 spellings of the SAME destination under the same policy: metadata_v4_mapped=reached/reached metadata_v4_mapped_hex=reached/reached metadata_v6=blocked/refused-or-unrouted. ★ 2 of them REACHED — an IPv4-only deny set has an open IPv6 flank, which is expected: the SDK's only sentinel is ALL_TRAFFIC = 0.0.0.0/0, with no ::/0.
PROBE b: YES — policy-materialized-exactly
    getInfo() returned denyOut = [10.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16], exactly the declared set. A run CAN verify what was applied instead of assuming it.
PROBE c: NO — resolver-outside-the-deny-set
    The approach SURVIVES this question. 8.8.8.8: no declared IPv4 deny entry contains it. nameservers: 8.8.8.8; deny set: 169.254.0.0/16, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16. Name resolution also worked under the policy, so the deny set does not sit between the guest and its resolver.
PROBE d: NO — update-did-not-take-effect
    updateNetwork returned successfully and the target was still REACHED afterwards (401). A reused lease CANNOT be re-policed through this call, so any design that re-asserts policy on reuse is unavailable. The sandbox was paused and resumed before the update, so this is the warm-resume shape.
PROBE e: NO — nothing-was-blocked-so-there-is-no-layer-to-locate
    question (a) measured the deny set INERT: the target was reached under the policy. There is no enforcement anywhere, so asking which layer holds it is dissolved rather than unanswered.
PROBE regression: NO — the-deny-set-does-not-break-the-product
    every exercised product-regression row was REACHED under the deny set: dns_dependent=reached/reached model_api=reached/reached. NOT EXERCISED: aoa_api_url — this check is PARTIAL.

OBSERVATIONS: {"aoaApiRow":"no AOA control-plane URL was supplied; that product-regression row was NOT exercised","denySetV4":["169.254.0.0/16","10.0.0.0/8","172.16.0.0/12","192.168.0.0/16"],"denySetV6":["fe80::/10","fd00::/8","::ffff:0:0/96"],"antiVacuitySet":["198.51.100.0/24"],"controls":{"ok":true,"problems":[]},"policySandboxId":"iqxqyb6z125jm2el8fw11","antiVacuitySandboxId":"ia4rtdajfwq487odec059","getInfoNetwork":{"denyOut":["169.254.0.0/16","10.0.0.0/8","172.16.0.0/12","192.168.0.0/16"],"allowPublicTraffic":true},"resolvConfPolicyArm":"nameserver 8.8.8.8","resolvConfControlArm":"nameserver 8.8.8.8","reuseShape":"warm-resume","reuseShapeDetail":"betaPause() then connect() — the sandbox came back from a pause","ipv6DenyArm":{"created":false,"detail":"SandboxError: 400: invalid denied CIDR ::ffff:0:0/96","readBack":"getInfo failed: not attempted","rows":{},"note":"Whether the API even ACCEPTS IPv6 deny entries is unknown territory: the SDK validates nothing client-side and its only sentinel is ALL_TRAFFIC = 0.0.0.0/0, with no ::/0. A create failure here is a RESULT."}}

DISPOSITION: measured — a=no b=yes c=no d=no e=no regression=no
DECISION   : abandon (denyout-is-inert-at-this-tier)
  The declared deny set had no effect: the target was reached under the policy exactly as without it. The provider-network option is unavailable at this tier for the same reason the metadata.egressAllowlist seam was (E8-F003), one API surface over.
A `no`, and (c)'s ABANDON `yes`, are RESULTS and this lane stays green for them. Only `inconclusive` reds.
=================================================================
```

### (a) HONOURED? — is a denied target actually unreachable?

| Verdict | What it means | What to do |
|---|---|---|
| `YES — denied-target-unreachable-under-policy` | The target was blocked in the arm that denied it and **reached in the anti-vacuity arm**. The tier honours `denyOut` at `Sandbox.create`. | Read (b) next; enforcement you cannot verify is not shippable. |
| `NO — denied-target-still-reachable` | The target was reached **under the policy**, exactly as without it. The declared deny set is **inert at this tier** — the same result the `metadata.egressAllowlist` seam produced (E8-F003), one API surface over. | **The option closes.** Record it against DE-08 and E8-F003; the in-guest point is then the only candidate, with the agent-writability problem in §8 unresolved. **★ THIS IS WHAT HAPPENED — §12. And the in-guest point is not a candidate either: §8's own measurement retires it, so the census is closed rather than reduced to one. `E8-F003` §8.** |
| `INCONCLUSIVE — controls-failed` | One of §5b's control rows did not hold; the detail names which. | Fix the apparatus and re-run. Nothing may be read. |
| `INCONCLUSIVE — question-row-missing` | The question target produced no result line. | Re-run; the log carries the raw channel for every row, parsed or not. |

★ **The IPv6 spellings are reported beside the verdict, never folded into it.** A deny set that closes
`169.254.169.254` and leaves `[::ffff:169.254.169.254]` open **is** enforced *and* is useless as a
control. Both are true, and collapsing them into one boolean loses whichever one you needed. The
SDK's only sentinel is `ALL_TRAFFIC = "0.0.0.0/0"` — there is **no `::/0`** and no IPv6 in its docs —
so an open IPv6 flank is the expected shape, not an anomaly.

### (b) VERIFIABLE? — does `getInfo()` materialize the policy back?

| Verdict | What it means |
|---|---|
| `YES — policy-materialized-exactly` | `getInfo().network.denyOut` came back as exactly the declared set (order does not matter; the **set** does). A run can verify what it got. |
| `NO — network-not-materialized` | `getInfo()` succeeded and carries no `denyOut`. A run would have to **assume**, and a tolerant or self-hosted API that ignores the field returns 200 with an unpoliced sandbox. **Unshippable even if (a) is yes.** |
| `NO — policy-materialized-but-differs` | The server accepted the request and stored **something else**. That is *worse* than storing nothing: a naive read-back check would pass on it. The detail names what is missing and what is unexpected. |
| `INCONCLUSIVE — getinfo-failed` | The call itself failed. |

### (c) ★ ABANDON? — is the resolver inside the deny set?

| Verdict | What it means | What to do |
|---|---|---|
| `YES — resolver-inside-the-deny-set` | A nameserver's address falls in a denied range. | **§2. Abandon the option.** A complete result. |
| `YES — resolution-broke-under-policy` / `…-despite-resolver-outside` | Name resolution measurably failed under the policy (curl exit 6) while the same name resolved in the anti-vacuity arm. The second spelling means no nameserver address was inside the set and it broke anyway — **something else in the resolution path is denied**, which is worth its own finding. | §2, and file the surprise. |
| `NO — resolver-outside-the-deny-set` | Every nameserver is decided and safe, and resolution worked under the policy. **The approach survives this question.** | Continue to (a)/(b)/(e). |
| `INCONCLUSIVE — resolv-conf-unreadable` | `/etc/resolv.conf` could not be read **and** resolution did not measurably fail, so neither trigger fired. | Re-run. **Do not read this as `safe`.** |
| `INCONCLUSIVE — resolver-unclassifiable` | A nameserver's containment could not be decided (an unparseable address, or an IPv6 nameserver against a deny set that also declares IPv6). | Re-run or extend the classifier. An undecided resolver may not be counted as outside. |
| `INCONCLUSIVE — no-nameserver-lines` | `/etc/resolv.conf` has no `nameserver` line: the guest resolves names some other way. | Investigate before designing anything. |

A DNS failure in **both** arms is **not** attributed to the policy — the verdict comes back `no`.

### (d) RE-ASSERT? — does `updateNetwork` re-police a reused sandbox?

`YES` = the target was **reached before** the update and blocked after it, on the same sandbox. The
**before** row is this arm's own positive control: without it, "unreachable after" would be satisfied
by a sandbox that could never reach the target at all, and the arm would confirm the update on the
strength of nothing.

★ **The reuse SHAPE is reported, not assumed.** `betaPause` is plan-dependent. When it works the
verdict says *"paused and resumed"*; when it does not, the update is applied to a still-**running**
reused sandbox and the verdict says so explicitly — that is AoA's `reuseLease` question but **not** the
resume half, and it must not be read as one.

### (e) WHERE? — packet path, or an L7 proxy?

| Verdict | What it means |
|---|---|
| `YES — enforcement-is-in-the-packet-path` | Every raw target that connected in the anti-vacuity arm was closed under the policy — on a **non-HTTP port**, and with **hand-written request bytes** that no HTTP client and no proxy variable touches. Enforcement is below L7. |
| `NO — enforcement-is-not-in-the-packet-path` | HTTP through curl was blocked, but a raw socket still connected. Enforcement is at L7 — **and an L7 layer is not a boundary against this workload** (§8). |
| `NO — nothing-was-blocked-so-there-is-no-layer-to-locate` | (a) measured the policy inert, so the question **dissolves**. This is deliberately not `inconclusive`: it would otherwise ask you to re-spend an authorised run on a question the run already answered. |
| `INCONCLUSIVE — raw-socket-rows-unusable` | Usually a template with no `python3`. Re-dispatch with `-f e2b_template=aoa-base`. |
| `INCONCLUSIVE — raw-targets-unreachable-in-the-control-arm` | No raw target connected even without a matching deny set, so their closure under the policy is unattributable. |

### PRODUCT REGRESSION — would the control break the product?

`NO` is the good answer: every exercised row was reached under the deny set. `YES` means the deny set
broke DNS, the package registry, the model API or the AoA control plane, and the control is
unshippable whatever (a) says. A row that was **not exercised** (typically `aoa_api_url` on the push
route) is **named** and the check reports itself **PARTIAL** — never a silent pass.

It is a **separate verdict, not a control gate**, and deliberately so: a regression does not make the
measurement unsound — (a), (b), (c) and (e) are all still readable — it makes the *control*
unshippable. Folding it into the gate would turn "this policy would break npm" into "this run measured
nothing", throwing away four answers to report one.

---

## 8. Why the provider layer is the only candidate outside the guest

Every in-guest mechanism is **agent-writable by construction**: `buildE2bLoginShellScript`
(`server/src/services/sandbox-provider-runtime.ts`) sources `/etc/profile`, `$HOME/.profile` and
`$HOME/.bashrc` from an **agent-writable home** before `exec env … claude`. An in-guest **proxy** is no
better: Node's global `fetch` **ignores every proxy environment variable** — measured, with the proxy
port never contacted and the request returning 200 — and the image is `node:22`, so the agent's own
WebFetch walks straight past it. (`isPrivateIP('::169.254.169.254')` returned `false` when this was
written; **W13 fixed that parser defect** — E8-F009 §8 — which changes nothing about this section's
argument, since the point is that an in-guest filter is routed around rather than that it was wrong.)
And
`one-shot-sandbox-cli.ts` composes its own env and calls `runtime.execute` directly, bypassing
`execution-target.ts` entirely.

That is the whole reason (e) exists as a question rather than an assumption: an L7 filter the guest can
route around is not a boundary against the very workload it is meant to contain.

---

## 9. What this probe is NOT

- It **does not build an enforcement layer.** It measures whether one is possible.
- It **applies no deny policy to any production code path.** Every `network` option it passes goes to
  a sandbox it created for the measurement and destroys afterwards.
- It **does not flip any capability, arm any rollout dial, write to any register, or change any count.**
- It **does not close DE-08 or E8-F003**, and its PR does not change either one's status or severity.
  The PR **adds** a clause to E8-F003 recording that the SDK seam exists and was never called, and
  **removes nothing** — a machine-readable entry must never become weaker than the prose beside it,
  and E8-F003's own record says so.
- It **claims nothing about the networked/container lane.** Like every other keyed lane here, it is
  E2B only (E7-F011).

---

## 10. Where the pieces live

| File | Role |
|---|---|
| `packages/sandbox-e2b-provider/src/__tests__/keyed-w10b-egress-enforcement-probe.test.ts` | the probe: the **five** arms (the fifth is §13's allowlist arm, added W10B-B), the raw-socket helper, the DNS and liveness helpers, the report. Skips cleanly without `E2B_API_KEY`. Its no-key blocks PIN the `e2b` SDK seam (`ALL_TRAFFIC`, `network`, `updateNetwork`, `getInfo`) so the premise cannot rot in the other direction either. |
| `scripts/lib/w10b-egress-enforcement-probe.mjs` | the pure core: template resolution, the deny sets, the CIDR engine behind the ABANDON question, the command builder and line parser, the four control rows, all five verdicts plus the regression verdict, the computed decision, the redactor, the durable-record builder, and `evaluateDurableRecord`. Zero imports; no network, no filesystem. |
| `scripts/lib/__tests__/w10b-egress-enforcement-probe.test.mjs` | proves every one of those decisions **without a key**, on every PR, in the required `policy` job. It does **not** pin the stale-premise correction: an earlier draft did, FILE-WIDE, which could not fail on the thing it named. Section 15 of that file records the deletion; W10A's per-occurrence guard is the enforcement. |
| `.github/workflows/keyed-e2b-w10b-egress-enforcement-probe.yml` | the lane: the probe step, the `always()` fallback record writer, the `always()` artefact upload, and the positive-control step that refuses to let a skip read as success. |
| `.github/keyed-e2b-w10b-egress-enforcement-trigger` | **NOW EXISTS** — created by `ab23eabdc` to fire run `34085130892`. It was not created by the probe's own PR. **★ APPENDING TO THIS FILE ON `docs/replatform-program` FIRES ANOTHER KEYED E2B RUN**, which spends an authorisation the founder gives individually — so do not edit it to record an outcome. Outcomes go in §12, §13.7 and in `W10B-egress-enforcement-result.md`. |

---

## 11. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Job fails at "Fail if the pack SKIPPED" | `E2B_API_KEY` was empty; the pack skipped and measured nothing. | Restore the secret. A skip is never a pass. |
| `INCONCLUSIVE — controls-failed: anti-vacuity-control-failed` | The question target was not reachable even from the arm that does not deny it. Whatever blocks it is not this policy. | Pick a reachable internal target and re-run. **Do not read this as enforcement.** |
| `INCONCLUSIVE — controls-failed: apparatus-control-violated` | The RFC-2606 `.invalid` host was **reached**. The probe is not reading the network. | Something is intercepting DNS or HTTP. Investigate before trusting any row. |
| `INCONCLUSIVE — raw-socket-rows-unusable` | The template has no `python3`, so (e) had no tool. The report's `TEMPLATE:` line says which image ran. | Re-dispatch with `-f e2b_template=aoa-base`. If `aoa-base` is not registered on the account behind `E2B_API_KEY`, build it: `cd e2b && e2b template create aoa-base -d e2b.Dockerfile` (the `e2b template build` form in older docs is a gutted no-op). |
| An arm reports `ARM FAILED` with an HTTP status | `Sandbox.create` rejected the `network` body. The SDK validates nothing client-side, so an unknown or unsupported field surfaces only here. | Read the status. For the **IPv6 arm** this is a *result*, recorded in `observations.ipv6DenyArm` — the API refuses IPv6 deny entries. |
| The run failed and there is **no** `w10b-egress-enforcement-record` artefact | Should be impossible: both the fallback writer and the upload are `if: always()`. | Treat the run as **unmeasured**, not as a result, and say so wherever you report it — that is the E7-F025 failure returning. |
| `gh workflow run` answers 404 | The lane has never run, so GitHub has not indexed it for dispatch. | Use the push route in §4. |

---

## 12. THE RUN — `34085130892`, 2026-09-07

**This lane has fired exactly once.** Recorded here rather than only in the run page, because a keyed lane
that fires and is not written down is the `E7-F025` failure this pack's own §6 exists to avoid.

| | |
|---|---|
| Run | [`34085130892`](https://github.com/MeteoriteLabs/AoA/actions/runs/34085130892), job `probe`, 1m33s |
| Fired by | the **push route** (§4) — commit `ab23eabdc` *"chore(w10b): fire the egress-enforcement probe"* on `docs/replatform-program` |
| Template | `aoa-base` (resolved from an empty input — `default-product-image`) |
| Inputs | `aoa_api_url` empty (push route carries no inputs), so the `aoa_api_url` regression row was **not exercised** |
| Run nonce | `W10B-MTQRVDJP-2FEX4EOA` |
| Artefact | `w10b-egress-enforcement-record` → `w10b-egress-enforcement-record.json`, schema `aoa.w10b.egress-enforcement-record/1` |
| Sandboxes | policy `iqxqyb6z125jm2el8fw11`, anti-vacuity `ia4rtdajfwq487odec059`, reuse `i7y52on39wdczxyhrm94v`, IPv6 arm **not created** |

### 12.1 The verdicts

| question | state | reason |
|---|---|---|
| **a** HONOURED? | **NO** | `denied-target-still-reachable` — `169.254.169.254` REACHED (401) from inside the sandbox declaring `169.254.0.0/16`, identically to the anti-vacuity arm |
| **b** VERIFIABLE? | **YES** | `policy-materialized-exactly` — `getInfo()` returned the declared `denyOut` exactly |
| **c** ★ ABANDON? | **NO** | `resolver-outside-the-deny-set` — `nameserver 8.8.8.8`, inside no declared range; resolution worked under the policy |
| **d** RE-ASSERT? | **NO** | `update-did-not-take-effect` — `updateNetwork` succeeded; target REACHED before and after, on a warm-resumed sandbox |
| **e** WHERE? | **NO** | `nothing-was-blocked-so-there-is-no-layer-to-locate` — the question dissolves |
| PRODUCT REGRESSION | **NO** (PARTIAL) | `dns_dependent` and `model_api` REACHED under the deny set; `aoa_api_url` **not exercised** |

`DISPOSITION: measured` · `DECISION: abandon (denyout-is-inert-at-this-tier)`.

### 12.2 ★★★ THE ABANDON CONDITION DID NOT FIRE — so this is inertness, not misconfiguration

This is the distinction that makes the run readable, and it is why §2's stop condition is a *separate*
question from §7's (a). **Question (c) came back `no`.** The guest's nameserver is `8.8.8.8` in **both**
arms, contained by none of the four declared ranges, and name resolution measurably **worked** under the
policy. So the deny set did not sit between the guest and its resolver, nothing in the policy arm was
starved of DNS, and the product-regression rows (`dns_dependent`, `model_api`) were **reached**.

> **The policy arm was a healthy sandbox that could reach everything it needed — and could also reach the
> destination it had declared denied.** Had (c) come back `yes`, the correct reading would have been *"we
> broke our own experiment and the option is unusable for that reason"*. It did not. The deny set is
> genuinely inert at this tier.

All four mandatory controls (§5b) held: positive `allowed_public` 200 in both arms, apparatus `.invalid`
curl exit 6 in both arms, anti-vacuity `metadata_v4` 401, and every row `parsed=yes`. The record's own
`observations.controls` is `{"ok":true,"problems":[]}`.

### 12.3 What the run added that no question asked for

- **The API validates server-side.** The IPv6 arm was **refused at create**: `SandboxError: 400: invalid denied CIDR ::ffff:0:0/96`. So the endpoint parses and range-checks the
  deny set — it is *not* a tolerant server discarding an unknown field. It stores a policy it does not
  apply, which is a different and worse shape than the one §3 anticipated.
- **Two of three IPv6 spellings of the same destination reached** under the policy (`[::ffff:169.254.169.254]`, `[::ffff:a9fe:a9fe]`); `[fd00:ec2::254]` failed in **both** arms and is
  therefore unattributable.
- **`rfc1918_10` timed out in both arms**, so the `10.0.0.0/8` row says nothing either way. The verdict
  rests entirely on `169.254.169.254`.
- **The raw-socket row identifies the answering service**: hand-written bytes to port 80 came back
  `HTTP/1.0 401 … Server: Firecracker API`, in **both** arms.

### 12.4 What it closed, and what it did NOT

**Closed.** The provider-network option **in the shape that was measured** — a `denyOut` CIDR list
with no `allowOut` — and with it that row of the candidate-layer census for `DE-08`; see
`E8-F003` §8, which labels each row *measurement*, *structural*, *derived* or *unmeasured*. Finding
**`E8-F008`** (HIGH, open, `unowned`) owns the result and the read-back lesson;
**`E8-F007`** §7 records the closure of its own open tier question, in both directions.

★ **NARROWED 2026-09-09 (W10B-B).** This paragraph said "the provider-network option" without
qualification, which read as *the surface*. One construction was measured. The default-deny +
`allowOut` construction E2B documents is **UNMEASURED** and is now census row **2b**. **That is a
narrowing of the CLAIM, not a softening of the CONCLUSION**: `DE-08` still reads `not-delivered`,
nothing in the product passes a `network` body, and the arm for the unmeasured shape (§13) was
dispatched twice on 2026-09-09 and returned `UNRUN` both times — **the shape remains unmeasured, and
`UNRUN` is not `INERT`** (§13.7).

**NOT closed, and deliberately.** `DE-08` keeps `deliveryStatus: not-delivered` and its clause text is
untouched; `E8-F003` and `E8-F007` keep their status, severity and ownership. **What to do about a
`Critical` control that cannot be enforced at any available layer is a founder decision that has not
been taken**, and nothing in this record pre-empts it. No enforcement was proposed or built.

### 12.5 Before firing it again

The founder authorises keyed E2B runs individually, so a re-fire spends an authorisation. Three things
are worth knowing first:

1. **A repeat on the same tier is expected to reproduce this**, and would add nothing. What would be new
   is a **different tier** (`resolveE2bDomain = config.domain ?? env.E2B_DOMAIN`, self-hosted branch),
   which this run says nothing about.
2. **Pass `-f aoa_api_url=…`** if you want the regression check to stop reporting PARTIAL.
3. **The IPv6 arm cannot be created as written** — `::ffff:0:0/96` is refused with a 400. That is a
   recorded result, not a bug to route around; changing the arm's CIDRs changes what the arm measures.
4. **There is a fifth arm, it has been dispatched twice, and it has never produced a verdict** —
   §13.7. Both dispatches failed to place its sandbox with the same `500`, while their sibling arms
   placed seconds apart. A third dispatch of the **identical** body is expected to reproduce that and
   would add nothing; §13.7's closing list says what would have to change first.

---

## 13. THE ALLOWLIST ARM — built 2026-09-09 (W10B-B), DISPATCHED TWICE, **UNRUN**

**Status: BUILT, CI-green without a key, DISPATCHED TWICE on 2026-09-09 with the founder's
authorisation — and it returned `UNRUN`, no verdict, both times.** `Sandbox.create` never placed the
allowlist body, so **the sandbox for this arm has never existed and enforcement is still
UNMEASURED**. §13.7 is the result. Firing it again is an operator action and it is **not** authorised
by this document.

### 13.1 Why it exists: the shape E2B documents as the control was never tested

Run `34085130892` measured **one** shape — a `denyOut` list of CIDRs with **no `allowOut`** — and it
came back inert. Several records then generalised that to *"the tier does not honour a `network`
body"*, a claim about **all** network bodies inferred from one. E2B's documentation
(`https://docs.e2b.dev/network/internet-access.md`, read 2026-09-09) presents the fine-grained control
as the **opposite** construction:

```js
denyOut: ({ allTraffic }) => [allTraffic],   // allTraffic === "0.0.0.0/0"
allowOut: ["1.1.1.1", "8.8.8.0/24"]
```

and states that **domains are not supported in deny lists** — so domain filtering *requires* this
form. It is the shape a real `DE-08` control would take, and it is unmeasured. **It is STILL
unmeasured after two dispatches** — see §13.7; the arm was never created, so nothing about
enforcement was observed either way.

★★★ **WHY THE ARM IS NOW CIDRs/IPs ONLY (the domain was dropped).** The two failed dispatches
(§13.7) both carried a third `allowOut` entry, `example.com` as an unmeasured hostname
observation. A **hostname** in `allowOut` forces E2B's `validateEgressRules` to require
`0.0.0.0/0` in `denyOut` **and** routes the sandbox through the **tcpproxy** (L7) path — which
reproducibly **500s at create ("failed to place")** on this tier. That is why both dispatches
returned `UNRUN`. The allow set above is now exactly `["8.8.8.0/24", "1.1.1.1"]` — CIDRs/IPs
only, no domain — which routes down the **plain iptables** path and should place. This is the
single change from the shape that would not place; the resolver rationale (§13.2), the
differential (§13.3) and the verdict vocabulary (§13.4) are otherwise unchanged. The
observation of *whether a hostname allow entry works* is deferred — it is not worth an
authorised run that cannot even be created.

★ **§2 already knew the mechanism and filed it as a hazard**, correctly: "any `allowOut` entry flips
the whole policy to default-deny", which for the deny-set probe would have starved the guest's
resolver and broken the experiment. The flip is only fatal while the resolver is **unnameable**.

### 13.2 How the resolver was determined — MEASURED, not assumed

**`8.8.8.8`.** Read from `/etc/resolv.conf` **inside the guest**, in **both** arms of run
`34085130892`: probe (c)'s detail line (*"nameservers: 8.8.8.8"*) and the durable record's
`observations.resolvConfPolicyArm` / `observations.resolvConfControlArm`, both literally
`"nameserver 8.8.8.8"` — reproduced verbatim in §7 above and in `W10B-egress-enforcement-result.md`.

It is a **static, public, globally-routed** address, so unlike a dynamic in-fabric resolver it **can**
be named in an `allowOut` entry. The arm allows `8.8.8.0/24`, which contains it — and which is also
the SDK's own documented example entry. **The documented shape is therefore usable for us**; had the
resolver been dynamic or internal-only, the honest finding would have been that the shape is unusable
and no arm would have been built.

★★ **The arm does not trust that constant.** It re-reads `/etc/resolv.conf` in its own guest and
reports what it finds, and it runs a resolution probe (`dns_lookup`) that is independent of any
connect. A template that moved the resolver produces a **named** `BROKEN` outcome, not a silent one
that reads as enforcement.

### 13.3 The design — why the result can mean anything

★★★ **An allowlist that blocks everything is indistinguishable from a broken sandbox.** In both, every
request fails. So the arm asks **both directions**, and adds a third probe that touches no network at
all:

| row | id | in `allowOut`? | what it must show |
|---|---|---|---|
| **LIVENESS** | `guest_alive` | n/a — a purely **local** command | the guest is alive. Without it, "the sandbox never started" is reported as a network result. |
| **POSITIVE CONTROL** | `allow_ip` → `https://1.1.1.1/` | **yes**, by IP literal (no DNS involved) | **REACHED.** If it is not, there is **no** enforcement verdict, however cleanly the denied rows failed. |
| **THE TEST** | `deny_metadata` → `http://169.254.169.254/…` | no | **REFUSED.** Measured reachable (401) under a deny set naming its own range and in the anti-vacuity arm, so a refusal here is attributable. |
| **THE TEST** | `deny_public_ip` → `https://9.9.9.9/` | no | **REFUSED.** Its partner is `allow_ip`: same sandbox, same instant, same kind of destination, differing only in whether the allowlist names it. A **within-arm** differential, which is tighter than any cross-sandbox one. |
| **RESOLVER** | `dns_lookup` | — | `resolved`. `resolve-failed` means the allowlist did **not** admit the resolver and the arm starved its own experiment. |
| observation | `deny_public_host` → `https://registry.npmjs.org/` | no | its curl exit separates *resolution failed* (6) from *resolved, connect denied* (7/28). |
| apparatus | RFC-2606 `.invalid` | no | **FAILS**, or the arm is not reading the network and nothing may be read. |

**What "refused" looks like, so it is never confused with a dead sandbox:** curl exit **7**
(`refused-or-unrouted` — an immediate RST or no route), exit **28** (`timed-out` — the shape a
silently-dropped packet takes), exit **6** (`dns-failure` — resolution, not reachability). Every row's
exit code is printed and stored; `guest_alive` is what says the sandbox existed at all.

### 13.4 The three outcomes, and the two that are NOT outcomes

| outcome | meaning |
|---|---|
| **ENFORCES** | the allowed destination was REACHED **and** every denied destination refused. The documented shape enforces at this tier. |
| **INERT** | denied destinations were REACHED. The shape declares a policy and routes the traffic anyway — the same answer the deny-only shape gave. |
| **BROKEN** | the guest was **alive** and reached **nothing**, including the destination the policy explicitly ALLOWS. **No verdict.** This is a legitimate outcome and is reported as itself; it must never be read as enforcement. |
| *MIXED* — **not a verdict** | the denied rows disagreed with each other. Neither ENFORCES nor INERT is true, and reporting either would be a claim the rows do not support. |
| *UNRUN* — **not a verdict** | the experiment never happened: the arm was not created (a create **refusal** is a result about the shape and its status is recorded), the guest never answered a local command, the apparatus control was violated, or a load-bearing row produced no line. |

★ **The arm takes no part in `DISPOSITION`.** A `BROKEN` result must not red a lane that answered
every question it was dispatched for. Its result carries an `outcome`, never a `state`, which is what
structurally keeps it out of `packDisposition` — asserted in the pure-core suite, not assumed.

### 13.5 How to dispatch it — the operator's exact steps

**It has been dispatched twice (§13.7) and this document does not authorise dispatching it again.**
Each dispatch spends an authorisation the founder gives individually. **Read §13.7 first: two runs
minutes apart both failed to place this arm's sandbox, so a third dispatch buys a third
`arm-was-never-created` unless something about the tier or the body has changed.**

* **Workflow:** `.github/workflows/keyed-e2b-w10b-egress-enforcement-probe.yml` — the **same** lane.
  The arm is part of the same keyed test, so there is no second workflow and no second secret.
* **Trigger (preferred):**
  `gh workflow run keyed-e2b-w10b-egress-enforcement-probe.yml --ref docs/replatform-program -f e2b_template=aoa-base`
* **Trigger (fallback, if that 404s):** the push route in §4 — append a line to the sentinel file
  `.github/keyed-e2b-w10b-egress-enforcement-trigger` on `docs/replatform-program` and push.
  **★ That file already exists**, and appending to it on that branch **fires a keyed E2B run**. It is
  the only path in the lane's `push` filter, so merging this unit's PR fires nothing.
* **Cost:** `E2B_API_KEY` only; **no model-provider key and no model tokens**. **5** sandboxes
  instead of 4 — one more 420 s-TTL sandbox running six bounded `curl --max-time 12` rows, one 8 s DNS
  lookup and one local command. Expected wall time ~8–15 min; absolute worst case 1,860
  sandbox-seconds if every teardown also failed, which it cannot (every sandbox is killed in a
  `finally`).
* **Where the answer lands:** the same three channels as §6 — job summary, step log, and the
  `w10b-egress-enforcement-record` artefact, where the arm rides
  `observations.allowlistArm` with its outcome, reason, every row's exit code and detail, the
  `getInfo()` read-back, and the guest's own `/etc/resolv.conf`.

### 13.6 What each outcome would mean — for `DE-08` and for the support ticket

| outcome | for `DE-08` | for the support ticket |
|---|---|---|
| **ENFORCES** | `DE-08` **stays `not-delivered`.** A capability that is not adopted delivers nothing, and the census row 2b would move from UNMEASURED to *available and unadopted* — a **build** question with its own design, product-regression and verification work, none of which exists. It would **not** revive the `getInfo()` read-back as a safeguard: `E8-F008` §3 measured that the read-back certifies an unpoliced sandbox, and an enforcing tier does not make a broken verification instrument sound. | The ticket's premise changes: the complaint is no longer "your network body does nothing" but "your **deny-only** body does nothing while your **allowlist** body works" — which is a documentation-and-consistency bug, still worth reporting, and much more precisely stated. |
| **INERT** | `DE-08` stays `not-delivered`; census row 2b becomes a **second measurement** rather than a gap, and the provider layer is closed on both of its constructions rather than on one plus an inference. | The ticket is **strengthened**: the tier accepts, validates, stores and echoes **both** documented constructions and applies neither. That is a much harder claim for a vendor to attribute to operator error. |
| **BROKEN** | **Nothing changes.** No verdict, no evidence, row 2b stays UNMEASURED, and the record must say the arm ran and did not answer — never that it "sort of" enforced. | Nothing to report; the ticket would be about our own apparatus. Read `dns_lookup` first: `resolve-failed` means the allowlist did not admit the resolver, which is ours to fix, not E2B's. |

**In every one of the three, `DE-08` keeps `deliveryStatus: not-delivered` and nothing in the product
passes a `network` body.** This arm measures a capability. It builds, proposes and adopts no
enforcement.

★ **A fourth thing happened instead: `UNRUN`.** The table above enumerates the three *verdicts*; the
arm also carries two states that are **not** verdicts (§13.4), and one of them is what both dispatches
returned. §13.7.

### 13.7 ★★★ THE RESULT — dispatched twice 2026-09-09, `UNRUN` both times

| | |
|---|---|
| **Runs** | [`34328502574`](https://github.com/MeteoriteLabs/AoA/actions/runs/34328502574) (08:19:42Z) and [`34328780645`](https://github.com/MeteoriteLabs/AoA/actions/runs/34328780645) (08:22:47Z) — **three minutes apart** |
| **Branch / commit** | `replatform/w10b-allowlist-arm` @ `899aceeec` (both) |
| **Template** | `aoa-base` (both) |
| **Authorisation** | the founder's, given individually per dispatch |
| **Body sent** | `denyOut: ["0.0.0.0/0"]` + `allowOut: ["8.8.8.0/24", "1.1.1.1", "example.com"]` |
| **Outcome** | `UNRUN — NO VERDICT — arm-was-never-created` (both) |
| **What `Sandbox.create` returned** | `SandboxError: 500: Failed to place sandbox: sandbox creation failed on 3 node(s), please retry; if the problem persists, contact us` (both, verbatim) |
| **Lane conclusion** | `success` both times — correctly: `UNRUN` carries an `outcome`, never a `state`, so it takes no part in `packDisposition` (§13.4). The design held. |

**Nothing about enforcement was measured.** The sandbox was never created, so no row ran: every one
of `allow_ip`, `allow_host`, `deny_metadata`, `deny_public_ip`, `deny_public_host` and the apparatus
control reads `no-result/unknown`, `dns` reads `unknown`, and the guest's `/etc/resolv.conf` was
`UNREADABLE: not attempted`.

#### ★ What makes this evidence rather than noise: the siblings placed

In the **same** run, **seconds** apart, on the **same** template and the same key, the other arms
created successfully:

| run | policy arm | anti-vacuity arm | allowlist arm |
|---|---|---|---|
| `34328502574` | `i531or2zgvmdlt18e2u2s` ✔ | `i13yih10trv4512eugjmz` ✔ | **failed to place** |
| `34328780645` | `im9ge2ldwohsitqrtx5rc` ✔ | `i0xsmm4fzyhr3ep736ge9` ✔ | **failed to place** |

A capacity or availability wobble that took the tier down would have taken the siblings with it. It
did not. **Only the default-deny + `allowOut` body fails to place, and it did so on both attempts.**

#### ★★ The claim, at the strength the evidence supports

> **The shape E2B documents as the fine-grained control reproducibly FAILS TO PLACE at this tier.
> The cause is unknown, and it is E2B's to explain.**

Three things that claim is **not**, each for a stated reason:

* **NOT "the tier refuses the shape."** A `500 … please retry; if the problem persists, contact us`
  is a server-side placement failure with a retry hint, not a validation rejection. **The contrast is
  in the same run:** the IPv6 deny arm was refused with `400: invalid denied CIDR ::ffff:0:0/96` —
  *that* is the tier refusing a body. This one is not shaped like that, and calling it a refusal
  reads a verdict into an error code that does not carry one.
* **NOT "transient."** It reproduced across two dispatches minutes apart, each with siblings that
  placed successfully seconds earlier. "Transient" is the reading the sibling evidence rules out.
* **NOT a measurement of enforcement, in either direction.** **`UNRUN` is not `INERT`.** The
  deny-only shape was measured inert (§12); this shape was never observed at all. Anything that reads
  as though the allowlist construction was tested and found not to enforce is false.

**Two attempts is the evidence, and the record says two attempts.** It is not a sample from which a
rate can be quoted.

#### What it changes, and what it does not

* Census row **2b** (`E8-F003` §8) stays **UNMEASURED**, with `ATTEMPTED TWICE, UNRUN` added — the
  gap is now *attempted and blocked*, not *never tried*.
* **`DE-08` keeps `deliveryStatus: not-delivered`.** Unchanged, and it could not have moved: even an
  `ENFORCES` result would have been evidence about a capability, not a delivered control.
* **No production path passes a `network` body.** `sandbox-provider-runtime.ts` still sends
  `metadata` only. Unchanged by this run.
* **The support ticket gains a second, sharper item.** Alongside *"your deny-only body is accepted,
  validated, echoed and inert"*, it can now say *"and your documented allowlist construction does not
  place on our tier — `500`, twice, while sibling sandboxes on the same template placed seconds
  apart"*, quoting the four sandbox ids above.

#### Before a third dispatch

A third run is only worth an authorisation if something has changed. In order:

1. **Ask E2B** what the placement failure is, quoting the four sandbox ids and both run ids. The
   error's own text says to.
2. **If a narrower body is worth trying**, change one thing at a time — e.g. drop the hostname entry
   `example.com` from `allowOut` (hostnames are the entry class E2B's docs treat differently from
   CIDRs), or drop to a single IP-literal allow entry. A run that changes two things answers nothing.
3. **Do not** re-fire the identical body expecting a different answer. Two attempts already say what
   that costs.

> ★ **Item 2 is now implemented** (branch `e2b-cidr-only-probe`): the probe's `ALLOWLIST_ALLOW_SET`
> and this runbook's §13 body were narrowed to `allowOut: ["8.8.8.0/24", "1.1.1.1"]` — the single
> change of dropping the `example.com` hostname entry (see §13.1). The `example.com` shape recorded
> above is retained as the record of the two UNRUN dispatches; the next dispatch, if authorised, is
> the CIDR-only body.

### 13.8 ★★★ THE RESULT OF THE CIDR-ONLY DISPATCH — 2026-09-10, PLACED, verdict INERT

**The CIDR-only body was dispatched and it placed.** This is the arm's first successful create on this
tier, and it supersedes §13.7's `UNRUN` status (which is kept above as the record of the two
domain-bearing dispatches).

| | |
|---|---|
| **Run** | [`34528397309`](https://github.com/MeteoriteLabs/AoA/actions/runs/34528397309) |
| **Date** | 2026-09-10 |
| **Ref / commit** | `e2b-cidr-only-probe` @ `8f2c2b7d8` |
| **Template** | `aoa-base` |
| **Body sent** | `denyOut: ({ allTraffic }) => [allTraffic]` + `allowOut: ["8.8.8.0/24", "1.1.1.1"]` |
| **Placement** | **PLACED** — sandbox `ipm63v4ubgmzbik13v653` |
| **Read-back** | `getInfo().network = {"allowOut":["8.8.8.0/24","1.1.1.1"],"denyOut":["0.0.0.0/0"],"allowPublicTraffic":true}` (probe **b** = `yes`) |
| **Verdict** | **INERT — denied-destinations-still-reachable** |
| **Disposition** | `measured — a=no b=yes c=no d=no e=no regression=no` · `abandon (denyout-is-inert-at-this-tier)` |

**Why it placed:** §13.1's prediction held. The hostname in the earlier body forced
`validateEgressRules` down the tcpproxy L7 path that `500`s at create; the CIDR-only body routes down
the plain iptables path and creates.

**The rows:** `allow_ip`(`1.1.1.1`)=REACHED 301 (positive control);
`deny_public_ip`(`9.9.9.9`)=REACHED-THEN-BROKE (`curl 35`, post-connect);
`deny_public_host`(`registry.npmjs.org`)=REACHED-THEN-BROKE (`curl 35`, post-connect);
`apparatus`(`.invalid`)=name-resolution failure (DNS; not an egress block);
**`deny_metadata`(`169.254.169.254`)=REACHED 401**; `updateNetwork` warm-resume left it
REACHED (d=`no`).

**Reading it against §13.6's outcome table — this is the INERT column, fully (corrected 2026-09-11
per a Codex P2 on PR #425).** An earlier draft called the shape "not wholly inert" because it read
`curl 35` on `9.9.9.9`/`registry.npmjs.org` as blocked egress. That is wrong: per the probe's own
`CURL_EXIT_MEANINGS`/`classifyReachEvidence`, `curl 35` is **post-connect** — the connection was MADE
and broke after — so both were **REACHED-THEN-BROKE (reached, not refused)**. The shape blocked no
real destination's egress; the only non-reach was the `.invalid` apparatus control (DNS
name-resolution). And `DE-08`'s confidentiality target — `169.254.169.254` — LEAKED, so the outcome
is **FULLY INERT**: `DE-08` stays `not-delivered`, census row 2b (`E8-F003` §8) becomes a **second
measurement** rather than a gap, and the provider layer is now closed on both constructions. The
support ticket is strengthened per §13.6's INERT row, with the added detail that the allowlist shape
places only CIDR-only and even then is fully inert (leaks the metadata endpoint, blocks nothing).

**No further dispatch of this body is worth an authorisation for enforcement purposes** — the
question it was built to answer (does the documented allowlist shape enforce the metadata deny at
this tier?) is answered: **no**. Record: `W10B-egress-enforcement-result.md` §15, finding `E8-F008`
§9, census `E8-F003` §8.
