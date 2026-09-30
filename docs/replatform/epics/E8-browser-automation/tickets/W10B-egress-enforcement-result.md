# W10B — the DE-08 egress-enforcement probe: THE RESULT

**Run:** [`34085130892`](https://github.com/MeteoriteLabs/AoA/actions/runs/34085130892) · job `probe`, 1m33s
**Date:** 2026-09-07 · **Branch:** `docs/replatform-program` · **Commit:** `ab23eabdc`
**Template:** `aoa-base` (resolved from an empty input) · **Run nonce:** `W10B-MTQRVDJP-2FEX4EOA`
**Verdict:** `DISPOSITION: measured` · `DECISION: abandon (denyout-is-inert-at-this-tier)`

> **Why this file exists.** The `w10b-egress-enforcement-record` artefact is retained for **90 days**;
> this ticket record is not time-limited. `W10B-egress-enforcement-runbook.md` §6 requires the record to
> be copied here after a run, naming the run id, because a keyed lane that fires and is not written down
> is the `E7-F025` failure — *fired and unrecorded* — and the next session re-asks the question.
>
> **This is a record, not an analysis.** The analysis is finding **`E8-F008`**; the candidate-layer census
> it closes is **`E8-F003`** §8; the premise question it settles is **`E8-F007`** §7; the operator context
> is the runbook, §12. **Nothing here proposes or builds any enforcement.**

---

## The answer in one line

The E2B tier behind this repository's `E2B_API_KEY` **accepts** a `network.denyOut` set, **validates** it
server-side, **stores** it, **reads it back verbatim** through `getInfo()` — and **routes the denied
traffic anyway**, through both `Sandbox.create` and `updateNetwork`.

> ★★★ **SCOPE, ADDED 2026-09-09 (W10B-B): that is one SHAPE, and it is not the shape E2B documents as
> the control.** This run declared a `denyOut` list of CIDRs with **no `allowOut`**. E2B's docs present
> the fine-grained control as default-deny (`denyOut: ({allTraffic}) => [allTraffic]`) **plus** an
> `allowOut` allowlist, and say domains are unsupported in deny lists — so domain filtering *requires*
> that form. **It is UNMEASURED.** An arm for it is built (runbook §13).
> **Unmeasured is not "probably works":** `DE-08` stays `not-delivered`, no production path passes a
> `network` body, and nothing about this run's conclusion changes.
>
> ★★ **ATTEMPTED TWICE, 2026-09-09 — AND STILL UNMEASURED.** That arm was dispatched twice (runs
> [`34328502574`](https://github.com/MeteoriteLabs/AoA/actions/runs/34328502574) and
> [`34328780645`](https://github.com/MeteoriteLabs/AoA/actions/runs/34328780645), three minutes apart,
> branch `replatform/w10b-allowlist-arm` @ `899aceeec`, template `aoa-base`) and returned
> **`UNRUN — NO VERDICT — arm-was-never-created`** both times: `Sandbox.create` answered
> `SandboxError: 500: Failed to place sandbox: sandbox creation failed on 3 node(s), please retry; if
> the problem persists, contact us`. **§14 is the record.** The sandbox never existed, so no row ran.
> **`UNRUN` is not `INERT`:** nothing in this document may be read as the allowlist shape having been
> tested and found not to enforce.

**The ABANDON condition (question **c**) did NOT fire**, so this is genuine inertness and not a
misconfiguration that broke its own experiment: the guest's resolver (`8.8.8.8`) was outside every
declared range, name resolution worked under the policy, and the product-regression rows were reached.
All four mandatory controls held.

---

## The report, verbatim from the run

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

---

## The durable record, verbatim

`w10b-egress-enforcement-record.json`, schema `aoa.w10b.egress-enforcement-record/1`:

```json
{
  "schema": "aoa.w10b.egress-enforcement-record/1",
  "generatedAt": "2026-09-07T05:01:24.127Z",
  "commitSha": "ab23eabdc0504b05156829207940be80d3ec5bd4",
  "workflowRunUrl": "https://github.com/MeteoriteLabs/AoA/actions/runs/34085130892",
  "runNonce": "W10B-MTQRVDJP-2FEX4EOA",
  "template": {
    "resolved": "aoa-base",
    "source": "default-product-image",
    "note": "no template was supplied, so the pack resolved to \"aoa-base\" — the image AoA production runs, built FROM node:22 with curl and python3 installed. It does NOT fall back to \"base\": that image has no raw-socket tool, so question (e) would be inconclusive for want of a tool rather than an answer."
  },
  "denySet": [
    "169.254.0.0/16",
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16"
  ],
  "disposition": {
    "disposition": "measured",
    "exitCode": 0,
    "detail": "a=no b=yes c=no d=no e=no regression=no"
  },
  "decision": {
    "decision": "abandon",
    "because": "denyout-is-inert-at-this-tier",
    "detail": "The declared deny set had no effect: the target was reached under the policy exactly as without it. The provider-network option is unavailable at this tier for the same reason the metadata.egressAllowlist seam was (E8-F003), one API surface over."
  },
  "probes": [
    {
      "probe": "a",
      "state": "no",
      "reason": "denied-target-still-reachable",
      "detail": "169.254.169.254 was REACHED (401) from inside the sandbox that declared 169.254.0.0/16 in denyOut, exactly as from the anti-vacuity arm. The declared deny set is INERT at this tier — the same result the metadata.egressAllowlist seam already produced (E8-F003), one API surface over. That closes the provider-network option and it is a RESULT, not a failure. IPv6 spellings of the SAME destination under the same policy: metadata_v4_mapped=reached/reached metadata_v4_mapped_hex=reached/reached metadata_v6=blocked/refused-or-unrouted. ★ 2 of them REACHED — an IPv4-only deny set has an open IPv6 flank, which is expected: the SDK's only sentinel is ALL_TRAFFIC = 0.0.0.0/0, with no ::/0."
    },
    {
      "probe": "b",
      "state": "yes",
      "reason": "policy-materialized-exactly",
      "detail": "getInfo() returned denyOut = [10.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16], exactly the declared set. A run CAN verify what was applied instead of assuming it."
    },
    {
      "probe": "c",
      "state": "no",
      "reason": "resolver-outside-the-deny-set",
      "detail": "The approach SURVIVES this question. 8.8.8.8: no declared IPv4 deny entry contains it. nameservers: 8.8.8.8; deny set: 169.254.0.0/16, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16. Name resolution also worked under the policy, so the deny set does not sit between the guest and its resolver."
    },
    {
      "probe": "d",
      "state": "no",
      "reason": "update-did-not-take-effect",
      "detail": "updateNetwork returned successfully and the target was still REACHED afterwards (401). A reused lease CANNOT be re-policed through this call, so any design that re-asserts policy on reuse is unavailable. The sandbox was paused and resumed before the update, so this is the warm-resume shape."
    },
    {
      "probe": "e",
      "state": "no",
      "reason": "nothing-was-blocked-so-there-is-no-layer-to-locate",
      "detail": "question (a) measured the deny set INERT: the target was reached under the policy. There is no enforcement anywhere, so asking which layer holds it is dissolved rather than unanswered."
    },
    {
      "probe": "regression",
      "state": "no",
      "reason": "the-deny-set-does-not-break-the-product",
      "detail": "every exercised product-regression row was REACHED under the deny set: dns_dependent=reached/reached model_api=reached/reached. NOT EXERCISED: aoa_api_url — this check is PARTIAL."
    }
  ],
  "observations": {
    "aoaApiRow": "no AOA control-plane URL was supplied; that product-regression row was NOT exercised",
    "denySetV4": [
      "169.254.0.0/16",
      "10.0.0.0/8",
      "172.16.0.0/12",
      "192.168.0.0/16"
    ],
    "denySetV6": [
      "fe80::/10",
      "fd00::/8",
      "::ffff:0:0/96"
    ],
    "antiVacuitySet": [
      "198.51.100.0/24"
    ],
    "controls": {
      "ok": true,
      "problems": []
    },
    "policySandboxId": "iqxqyb6z125jm2el8fw11",
    "antiVacuitySandboxId": "ia4rtdajfwq487odec059",
    "getInfoNetwork": {
      "denyOut": [
        "169.254.0.0/16",
        "10.0.0.0/8",
        "172.16.0.0/12",
        "192.168.0.0/16"
      ],
      "allowPublicTraffic": true
    },
    "resolvConfPolicyArm": "nameserver 8.8.8.8",
    "resolvConfControlArm": "nameserver 8.8.8.8",
    "reuseShape": "warm-resume",
    "reuseShapeDetail": "betaPause() then connect() — the sandbox came back from a pause",
    "ipv6DenyArm": {
      "created": false,
      "detail": "SandboxError: 400: invalid denied CIDR ::ffff:0:0/96",
      "readBack": "getInfo failed: not attempted",
      "rows": {},
      "note": "Whether the API even ACCEPTS IPv6 deny entries is unknown territory: the SDK validates nothing client-side and its only sentinel is ALL_TRAFFIC = 0.0.0.0/0, with no ::/0. A create failure here is a RESULT."
    }
  }
}
```

---

## Raw rows worth keeping, read from the step log

These are not in the summary block and are the evidence behind three claims in `E8-F008`.

| arm | row | raw |
|---|---|---|
| policy | `allowed_public` | `exit 0 / 200` — the POSITIVE control |
| policy | `unresolvable` | `curl (6) Could not resolve host` — the APPARATUS control |
| policy | `metadata_v4` | `exit 0 / 401` — **the question target, REACHED under its own deny range** |
| policy | `metadata_v4_mapped` | `exit 0 / 401` |
| policy | `metadata_v4_mapped_hex` | `exit 0 / 401` |
| policy | `metadata_v6` | `curl (7)` — also failed in the control arm, **unattributable** |
| policy | `rfc1918_10` | `curl (28)` timeout — also timed out in the control arm, **unattributable** |
| policy | `raw_http_bytes` | `connected`, 226 bytes back: `HTTP/1.0 401 … Server: Firecracker API` |
| anti-vacuity | `metadata_v4` | `exit 0 / 401` — the ANTI-VACUITY control |
| anti-vacuity | `allowed_public` / `unresolvable` | `200` / `curl (6)` |
| reuse | `metadata_v4` before / after `updateNetwork` | `401` / `401`, across a `betaPause()` + `connect()` warm resume |
| IPv6 arm | `Sandbox.create` | **`SandboxError: 400: invalid denied CIDR ::ffff:0:0/96`** — the arm was never created |

**Sandbox ids:** policy `iqxqyb6z125jm2el8fw11` · anti-vacuity `ia4rtdajfwq487odec059` · reuse
`i7y52on39wdczxyhrm94v` · IPv6 arm not created.

---

## What was NOT exercised

- **`aoa_api_url`** — the push route carries no workflow inputs, so the AoA control-plane
  product-regression row was skipped and the regression verdict reports itself **PARTIAL**. The record
  names the row.
- **`allowOut`** and **`allowInternetAccess: false`** — this run measured `denyOut`. Reasoning from this
  result to those fields is an argument, not a measurement.
  **★ FOLLOWED UP 2026-09-09 (W10B-B).** `allowOut` is not a footnote: default-deny **plus** an
  `allowOut` allowlist is the construction **E2B's own documentation presents as the fine-grained
  control**, and the only one that supports domains. An arm for it — with a positive control (an
  allowlisted destination that must be REACHED), the metadata endpoint and an ordinary public IP that
  must both be REFUSED, a resolver probe, and a liveness probe that separates *blocked* from *dead* —
  is **built**: runbook §13. Records that generalised this run to
  *"the tier does not honour a `network` body"* have been narrowed to the deny-only shape.
  **★ It was dispatched twice on 2026-09-09 and returned `UNRUN` both times — the sandbox failed to
  place — so `allowOut` is STILL not exercised. §14.**
- **The guest's DNS resolver was the reason it could not be tested here, and it turns out to be
  nameable.** `/etc/resolv.conf` read `nameserver 8.8.8.8` in **both** arms — a static public address,
  so `allowOut: ["8.8.8.0/24"]` admits it and the documented shape is usable for us. The runbook's §2
  treated the default-deny flip as a stop condition to avoid, which was right for this probe and is
  what left the allowlist shape unmeasured.
- **Any tier other than the one this repository's `E2B_API_KEY` reaches.** `resolveE2bDomain` makes the
  API target per-company configurable.

---

## 14. THE ALLOWLIST ARM'S TWO DISPATCHES — 2026-09-09, `UNRUN` both times

**This section exists because the arm ran and did not answer, and that has to be written down as
precisely as an answer would have been.** The `E7-F025` failure — *fired and unrecorded* — does not
become acceptable when the firing produced no verdict.

| | run 1 | run 2 |
|---|---|---|
| id | [`34328502574`](https://github.com/MeteoriteLabs/AoA/actions/runs/34328502574) | [`34328780645`](https://github.com/MeteoriteLabs/AoA/actions/runs/34328780645) |
| started | 2026-09-09 08:19:42Z | 2026-09-09 08:22:47Z |
| branch / commit | `replatform/w10b-allowlist-arm` @ `899aceeec` | same |
| template | `aoa-base` | same |
| lane conclusion | `success` | `success` |
| **allowlist arm** | **`UNRUN — NO VERDICT — arm-was-never-created`** | **`UNRUN — NO VERDICT — arm-was-never-created`** |
| policy arm sandbox | `i531or2zgvmdlt18e2u2s` — **created** | `im9ge2ldwohsitqrtx5rc` — **created** |
| anti-vacuity arm sandbox | `i13yih10trv4512eugjmz` — **created** | `i0xsmm4fzyhr3ep736ge9` — **created** |
| IPv6-deny arm | `400: invalid denied CIDR ::ffff:0:0/96` — refused | same |

**The body sent** (both runs, logged verbatim by the pack before the call):

```
[w10b/A/allowlist] creating (template=aoa-base) network={"allowOut":["8.8.8.0/24","1.1.1.1","example.com"]}
```

— with `denyOut: ["0.0.0.0/0"]` via the SDK's `allTraffic` sentinel.

**What `Sandbox.create` returned** (both runs, verbatim):

```
SandboxError: 500: Failed to place sandbox: sandbox creation failed on 3 node(s), please retry; if the problem persists, contact us
```

**What the arm therefore recorded** (from `observations.allowlistArm` in both durable records):

```
outcome  : unrun          isVerdict: false        created: false
reason   : arm-was-never-created
rows     : allow_ip=no-result/unknown  allow_host=no-result/unknown
           deny_metadata=no-result/unknown  deny_public_ip=no-result/unknown
           deny_public_host=no-result/unknown  apparatus=no-result/unknown
dns      : unknown        resolver : expected 8.8.8.8, observed null
readBack : getInfo failed: not attempted
resolvConf: UNREADABLE: not attempted
```

Not one row ran. **Nothing about enforcement was observed, in either direction.**

### 14.1 ★ Why this is evidence and not noise: the siblings placed

Both runs created the policy arm and the anti-vacuity arm **successfully**, on the **same template**,
with the **same key**, **seconds** before the allowlist arm's create call. A capacity or availability
problem broad enough to fail a placement would have taken those with it. It did not, twice.

**Only the default-deny + `allowOut` body fails to place, and it did so on both attempts.**

### 14.2 ★★ The claim, at the strength the evidence supports

> **The shape E2B documents as the fine-grained control reproducibly FAILS TO PLACE at this tier.
> The cause is unknown, and it is E2B's to explain.**

Three readings that are **not** supported:

* **NOT "the tier refuses the shape."** A `500 … please retry; if the problem persists, contact us`
  is a server-side placement failure carrying a retry hint. It is not a validation rejection.
  **The contrast is in the same run:** the IPv6 deny arm was refused `400: invalid denied CIDR
  ::ffff:0:0/96` — *that* is a tier refusing a body, and it looks nothing like this.
* **NOT "transient."** It reproduced across two dispatches three minutes apart, each with siblings
  that placed successfully seconds earlier. Sibling success is precisely what rules that reading out.
* **NOT a measurement of enforcement.** **`UNRUN` is not `INERT`.** The deny-only shape is measured
  inert (this document's §"The answer in one line"); the allowlist shape has never been observed.

**Two attempts is the evidence, and this record says two attempts.** It is not a sample from which a
failure rate can be quoted.

### 14.3 What it changes

* Census row **2b** (`E8-F003` §8) stays **UNMEASURED**, now annotated `ATTEMPTED TWICE, UNRUN`.
* **`DE-08` keeps `deliveryStatus: not-delivered`** — unchanged, and it could not have moved.
* **No production path passes a `network` body** — `sandbox-provider-runtime.ts` still sends
  `metadata` only. Unchanged.
* **The support ticket gains a second item**, quoting the four sandbox ids and both run ids: the
  documented allowlist construction does not place on this tier while sibling sandboxes on the same
  template place seconds apart.
* **The arm's own design held.** `UNRUN` carries an `outcome` and never a `state`, so it took no part
  in `packDisposition` and both lanes concluded `success` — a non-verdict did not red a lane that
  answered every question it was dispatched for, and it also did not quietly read as enforcement.

Runbook **§13.7** carries the same record plus the operator guidance for what would have to change
before a third dispatch is worth an authorisation.

---

## 15. THE ALLOWLIST ARM'S FIRST SUCCESSFUL PLACEMENT — 2026-09-10, CIDR-only, verdict INERT

**This section supersedes §14's `UNRUN` status by measuring the arm, and keeps §14 as history.** §14's
two dispatches carried a hostname (`example.com`) in `allowOut` and reproducibly failed to place. The
one-thing-at-a-time fix prescribed in §14's closing list and runbook §13.7 item 2 — drop the hostname
— was implemented on branch `e2b-cidr-only-probe`, and this is its result.

| | |
|---|---|
| **Run** | [`34528397309`](https://github.com/MeteoriteLabs/AoA/actions/runs/34528397309) · job `probe` |
| **Date** | 2026-09-10 |
| **Workflow / ref / commit** | `keyed-e2b-w10b-egress-enforcement-probe.yml` · `e2b-cidr-only-probe` · `8f2c2b7d8` |
| **Template** | `aoa-base` |
| **Body sent** | `denyOut: ({ allTraffic }) => [allTraffic]` + `allowOut: ["8.8.8.0/24", "1.1.1.1"]` — CIDRs/IPs only, no domain |
| **Placement** | **PLACED** — sandbox `ipm63v4ubgmzbik13v653` (the arm's first successful create on this tier) |
| **Read-back** | `getInfo().network = {"allowOut":["8.8.8.0/24","1.1.1.1"],"denyOut":["0.0.0.0/0"],"allowPublicTraffic":true}` — policy materialized exactly (probe **b** = `yes`) |
| **Arm verdict** | **INERT — denied-destinations-still-reachable** |
| **Run disposition** | `measured — a=no b=yes c=no d=no e=no regression=no` · `DECISION: abandon (denyout-is-inert-at-this-tier)` |

### 15.1 Why it placed this time — §7's `validateEgressRules` insight, confirmed

A **hostname** in `allowOut` forces E2B's `validateEgressRules` to require `0.0.0.0/0` in `denyOut`
**and** routes the sandbox through the **tcpproxy** (L7) path — which `500`s at create on this tier
(that is what §14's two dispatches hit). Dropping the hostname routes the sandbox down the **plain
iptables** path, and it created. The prior `UNRUN` status is resolved: the shape does place; the
domain-bearing body simply took a path this tier cannot complete at create.

### 15.2 The rows, from the run's own record

| row | destination | result |
|---|---|---|
| `allow_ip` (positive control) | `1.1.1.1` | **REACHED 301** — control held |
| `deny_public_ip` | `9.9.9.9` | **REACHED-THEN-BROKE** (`curl (35)`, post-connect) |
| `deny_public_host` | `registry.npmjs.org` | **REACHED-THEN-BROKE** (`curl (35)`, post-connect) |
| `apparatus` | `…must-not-resolve.invalid` | **name-resolution failure** (DNS; not an egress block) |
| **`deny_metadata`** | **`169.254.169.254`** | **REACHED 401** |
| `updateNetwork` (warm resume) | `169.254.169.254` | returned success; target **still REACHED** (probe **d** = `no`) |

### 15.3 ★ The reading, corrected — the arm blocked NO real destination's egress

**It is wholly inert (corrected 2026-09-11 per a Codex P2 on PR #425).** An earlier draft read this
construction as blocking arbitrary public egress. It did not. Per the probe's own
`CURL_EXIT_MEANINGS` / `classifyReachEvidence` (`scripts/lib/w10b-egress-enforcement-probe.mjs`),
`curl 35` and `curl 56` are **post-connect**: the TCP connection was MADE and then broke at TLS, so
`9.9.9.9` and `registry.npmjs.org` were **REACHED-THEN-BROKE = reached, not refused** — the
classifier admits such rows *against* enforcement, never for it. The shape demonstrated **no egress
blocking at the connection layer**. The only non-reach was the `.invalid` apparatus control, and that
was a DNS **name-resolution** failure, not an egress block. There is **no** "real partial
capability" here.

**And the destination that matters for `DE-08` leaked.** `169.254.169.254` — the internal
metadata/control-plane endpoint the crossing's confidentiality clause names — was REACHED (401), and
`updateNetwork` did not re-police it. So the arm's verdict is **INERT —
denied-destinations-still-reachable**, and the honest reading is **FULLY INERT**: every denied
destination the arm could reach was reached. This is the same result as the `metadata.egressAllowlist`
seam (`E8-F003` row 1), one API surface over.

### 15.4 What it changes

* Census row **2b** (`E8-F003` §8) moves from **UNMEASURED** to **MEASURED — INERT**. The provider
  `network` surface is now closed on **both** its documented constructions, on measurement.
* **`DE-08` keeps `deliveryStatus: not-delivered`.** Unchanged — an INERT measurement is not a
  delivery, and the shape leaks the metadata range regardless.
* **No production path passes a `network` body.** `sandbox-provider-runtime.ts` still sends
  `metadata` only. Unchanged.
* **`E8-F008` stays open** (§9): the enforcement gap and the refuted-safeguard result are untouched;
  the `getInfo()` read-back PASSES on this metadata-leaking sandbox exactly as it did on the
  deny-only one.
* **The support ticket gains a third item:** the documented allowlist construction places only
  CIDR-only (a hostname `500`s at create), and even placed it is fully inert — it leaks
  `169.254.169.254` and blocks no real destination's egress (`9.9.9.9` and `registry.npmjs.org` were
  reached-then-broke, not refused).

The finding-side analysis is `E8-F008` §9; the census is `E8-F003` §8 and its 2026-09-11 note; the
premise sub-question is `E8-F007` §8; the operator context is runbook §13.8.
