# FINDING — DE-11's controls do not exist, and artifact retention is worker-supplied

**Raised by:** Lane A, during terrain for the retention-enforcement follow-up named in
[`DAT-009-slice-2-result.md`](./epics/E5-workspaces-secrets/tickets/DAT-009-slice-2-result.md) §7.2.
**Status:** FINDING. No code changed. **Every claim below was re-verified by hand.**

**Not an incident.** Nothing enforces retention today, and no production path uploads
`browser_cookie_state` / `browser_storage_state` (BRW-003 is unbuilt). There is no live
exploit. What is live and wrong *now* is the **documentation**, and what would be wrong
*immediately on building enforcement* is the **authority**.

---

> ## ★ REGISTER HOME AND STALENESS NOTICE — added by W20, 2026-09-08
>
> **This document now has a register entry: `E8-F011`** in
> [`epics/E8-browser-automation/findings.md`](./epics/E8-browser-automation/findings.md), declared
> `unowned` with a reason in `scripts/finding-ownership.json`.
>
> **Why it needed one, and why a register entry alone was not the fix.** This is a top-level
> `FINDING-*.md`. `scripts/check-finding-ownership.mjs` globs only
> `docs/replatform/epics/*/findings.md` (`findRegisters`, `:29-37`), so for as long as this
> document lived only here it sat in **no register, with no ownership declaration, and could
> never print as unowned** — the same invisibility `E11-F005`'s manifest entry already diagnosed
> for the sibling `FINDING-daemon-provenance-is-not-row-observable.md`. Meanwhile the DE-11
> register row said, in those words, *"no delivery audit has been performed for this crossing"*.
> **Two committed records of one crossing said opposite things and nothing could see it.**
>
> So W20 did **both**, and the second half is the one that matters: a register entry fixes this
> document, and `scripts/check-threat-control-audit-debt.mjs` fixes the **class** — it reds if any
> top-level `FINDING-*.md` is named by no epic register, and reds if a crossing a committed
> finding document is about is still marked `unaudited`. Deleting or inlining this document would
> have destroyed the measurement and left the class open; registering it without the guard would
> have fixed one instance and left the next one to repeat it.
>
> **★ §3 OF THIS DOCUMENT IS STALE — DO NOT RE-CITE IT.** The inverted retention authority
> ("the commit path takes the worker's word"; "the module that exists to deny this privilege has
> zero production callers") was **closed by DAT-010**. Retention is now derived control-plane-side
> by `resolveStoredRetention` (`server/src/services/artifact-retention-authority.ts:49-53`), called
> from `server/src/services/artifact-commit.ts:166` **before** the mutator and stored at `:202`,
> with the manifest's declaration explicitly ignored; `DAT-010-result.md:4` records the closure.
>
> **★ §1 DOES NOT HOLD IN FULL — amended 2026-09-09 (W22/W22B).** This banner said *"§1 — the
> four absent controls — was re-verified at tip `360d0b0ed` and still holds in full"*, and that
> sentence is now retracted. §1's table, and the §7 bullet *"Every factual observation in §1's
> table … still stands"*, are sound about **the application** and overreach about **the system**.
> Three sub-properties can be delivered entirely by artifact-bucket configuration a repository
> checkout cannot see, and are now recorded `UNKNOWN` pending inspection in
> `docs/architecture/distributed-execution-threat-controls.json`: **encryption at rest**
> (`get-bucket-encryption`), the **TTL** bound, and the **TTL-expiry half of purge**
> (`get-bucket-lifecycle-configuration`). Proving a control absent needs strictly more evidence
> than proving it present, and the S3-PUT grep is not that evidence.
>
> **What §1 still establishes, unchanged and measured:** the application implements none of the
> four; **purge on job completion is absent** whatever the bucket returns, because a lifecycle
> rule fires on object age plus prefix/tag and cannot observe job completion; and **nothing
> audits retention** — an application record no bucket setting can supply. `E8-F011` carries
> exactly that forward, and DE-11's `deliveryStatus` stays `partial` rather than `unaudited`.
> The body below is left unedited as the record of what was measured on the date it was
> measured; read it through this banner.

---

## ★ 1. The security-control register asserts four controls, none of which exist

`docs/architecture/distributed-execution-threat-controls.json` records **DE-11 — "Browser
cookie/trace leakage", severity `High`** — with:

| Field | Asserted | Reality |
|---|---|---|
| `trustedSide` | "a job-scoped sensitive-artifact store **with a TTL**" | No TTL exists. `ARTIFACT_RETENTION_CLASSES` (`policy.ts:200-203`) is four **names with no durations** — verified by exhaustive grep; every duration-bearing `retention` in the repo belongs to an unrelated subsystem (plugin logs, backups, memory settings) |
| `confidentiality` | "sensitive browser artifacts are **encrypted** and TTL-bounded" | **No encryption.** `server/src/storage/s3-provider.ts:157-165` builds `PutObjectCommand` with Bucket / Key / Body / ContentType / ContentLength and **no `ServerSideEncryption`** |
| `revocation` | "TTL expiry and job completion **purge** sensitive artifacts" | Nothing purges. `deleteObject` has two call sites in the whole repo, both task attachments; no S3 lifecycle rule exists; committed artifacts are never collected |
| `audit` | "sensitive-artifact access and **retention are audited**" | Nothing reads the retention column at all, so there is nothing to audit |

Its own `verification` field reads **"browser retention/authorization"** — pointing at the
mechanism that does not exist.

**A High-severity threat is recorded as controlled by four mechanisms, none of which are
built.** That is worse than an uncontrolled threat, because a reader of the register stops
looking.

## 2. The same claim is repeated in five more authoritative documents

- `distributed-execution-lifecycles.md:101,335,406` — "job-scoped sensitive artifacts with
  explicit retention", "written with explicit retention under the active fence".
- `program-design.md:133`; **`:410` — DAT-002's Acceptance clause** "sensitive browser
  artifacts have explicit retention". **DAT-002 is LANDED**, so that shipped acceptance is
  satisfied only if "explicit" means "a required string field".
- **`program-design.md:845` — BRW-001's Acceptance** "bounded TTL and artifact retention are
  mandatory", recorded satisfied in `BRW-001-result.md:43` **by the unit test of a map that
  has zero production callers.** An acceptance clause closed by a function nothing calls.
- `agent-execution-guide.md:72` — "restricted artifact … retention are explicit".

Only `distributed-execution-authority.md:27` is honest: *"Browser state and service
checkpoints have sensitivity and retention **metadata**"* — which is exactly all it is.

**No ticket in the 94-ticket programme owns deleting a committed artifact.** BRW-006 is given
a UI that displays "retention status" — a read surface over a column nothing enforces.

## ★★ 3. The authority is INVERTED, and this is the part that changes the plan

`server/src/services/browser-artifact-retention.ts:5-14` states the rule and its reason:

> retention is *"control-plane-owned, and never caller- or worker-supplied"* … *"A caller or
> worker choosing the retention of a `browser_cookie_state` or `browser_storage_state`
> artifact is a privilege the threat model must not grant — those artifacts carry live
> session credentials."*

**`server/src/services/artifact-commit.ts:144-145` does exactly what that forbids:**

```ts
sensitivity: manifest.sensitivity,
retention:   manifest.retention,     // ← straight from the WORKER'S manifest
```

The module that exists to deny this privilege has **zero production callers**; the commit
path takes the worker's word.

**Consequence for sequencing — this is the finding's real payload.** Building enforcement on
top of a worker-supplied value would **enforce the worker's choice**: a compromised or buggy
worker declares its `browser_cookie_state` as `audit` rather than `ephemeral`, and a
correctly-built TTL sweeper then dutifully preserves a live session credential for the long
class instead of deleting it.

> **Enforcement on an inverted authority is worse than no enforcement**, because it converts
> a dormant misclassification into an actively honoured one.

So the retention follow-up must be resequenced: **fix the authority first, enforce second.**

## ★★ 3b. REVISION 1 — §1 AND PART OF §2 ARE OVERSTATED. I misread the register.

Written before acting on §5 step 1, because acting on the original §1 would have DAMAGED a
correct document.

**The register is a REQUIREMENTS record, not an as-built attestation.** Two facts I did not
check before writing §1:

- The Markdown register's column header is **"Required control"**, not "Control" — pinned in
  code at `scripts/check-distributed-execution-foundation.mjs:189`
  (`THREAT_REGISTER_HEADER = ["ID","Threat","Severity","Required control","Verification","Owner"]`).
- The JSON's own `note` calls it an *"Authoritative machine-readable trust-crossing and
  **control-ownership** record"* whose *"`ownerTickets` reference defined **backlog** tickets"*.
  DE-11's owners are BRW-003/BRW-004/REL-001 — **unbuilt, by design**.

So DE-11 states the control that is REQUIRED and names who owes it. That is a requirements
register working correctly.

**What §1 got wrong:** "a High-severity threat is recorded as CONTROLLED by four mechanisms,
none of which are built", and "worse than an uncontrolled threat, because a reader stops
looking". A reader sees "Required control" and three owner tickets. **Withdrawn.**

**What §2 got wrong:** BRW-001's acceptance clause is *"Artifact retention is mandatory"*, and
`BRW-001-result.md:43` satisfies it with a suite proving the map is **total over every frozen
kind, credential-bearing kinds pinned to `ephemeral`, unknown kind fails safe**. That clause is
about the function being total and unavoidable — which it was. Calling it "an acceptance closed
by a function nothing calls" was unfair to it. **Withdrawn**, though "mandatory" reasonably
reads as "applied", and it was not applied until DAT-010.

**What still stands, unchanged:**

- **Every factual observation in §1's table.** There is no TTL duration anywhere, the S3 PUT
  carries no `ServerSideEncryption`, nothing purges, nothing reads the retention column. Those
  are true; what was wrong was calling the register's statement of them a false claim.
- **§3 in full — the authority inversion.** `artifact-commit.ts` stored the worker's declared
  retention while the module forbidding exactly that had zero callers. That was the actionable
  finding, and DAT-010 has fixed it.
- **The ordering conclusion.** Enforcement before the authority fix would have enforced the
  worker's choice.
- The narrow residual: the JSON's per-field prose is present-tense ("sensitive browser
  artifacts **are** encrypted and TTL-bounded") in a record whose rendered view says
  "Required". Someone reading the JSON alone could misread it. **Minor, and NOT worth
  rewriting a correct document over** — noted so a future reader is not re-alarmed.

**Consequence: §5 step 1 is WITHDRAWN.** Do not "correct" DE-11. There is nothing there to
correct; the mistake was mine.

## 4. `sensitivity` is decorative in v1, and that is fine

`artifactSensitivitySchema = z.literal("restricted")` (`artifacts.ts:279-283`) is
single-valued, so the field carries no discriminating information and cannot be downgraded by
relabeling. Nothing branches on it. Worth recording so nobody builds a policy on it believing
it means something today.

Also noted: the class `audit` is in the vocabulary and **no kind maps to it**.

## 5. Recommended sequence

1. **Correct the documents** (§1, §2). A false control claim is the cheapest thing here to fix
   and the most dangerous to leave. DE-11 should state the controls as *planned*, not present.
2. **Fix the authority** (§3): derive `retention` (and `sensitivity`) control-plane-side at
   commit from the frozen `kind`, using the map that already exists and is already tested —
   ignoring whatever the manifest claims. Small, and it gives the zero-caller module its
   caller.
3. **Then** build enforcement — durations per class, and a deletion path with the
   tenant-enumeration question from `DAT-009-slice-2-result.md` §6 answered.

Steps 1 and 2 are small and independent. Step 3 is the ticket that was originally named, and
it should not start before step 2.

## 6. What is NOT claimed here

No live exploit. Nothing uploads these artifact kinds yet, and no enforcement exists to be
subverted. The severity is in the **register being wrong** and in the **ordering trap** that
would otherwise be walked into.
