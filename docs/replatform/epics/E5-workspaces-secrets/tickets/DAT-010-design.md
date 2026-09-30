# DAT-010 — Design: artifact retention becomes control-plane-owned at commit

**Status:** DESIGN. **Start SHA:** the commit that adds this file.
**Motivated by:** [`FINDING-retention-authority-and-DE-11.md`](../../../FINDING-retention-authority-and-DE-11.md) §3, §5 step 2.
**Blocks:** any retention *enforcement* ticket. Enforcement before this would enforce the
worker's choice.

---

## 1. The defect, in two lines of source

`server/src/services/browser-artifact-retention.ts:5-14` states the rule and its reason:

> retention is *"control-plane-owned, and never caller- or worker-supplied"* … *"A caller or
> worker choosing the retention of a `browser_cookie_state` or `browser_storage_state`
> artifact is a privilege the threat model must not grant — those artifacts carry live
> session credentials."*

`server/src/services/artifact-commit.ts:144-145` grants exactly that privilege:

```ts
sensitivity: manifest.sensitivity,
retention:   manifest.retention,     // ← the WORKER'S declared value
```

`browserArtifactRetention()` — the total, fail-safe, already-tested function that exists to
own this decision — has **zero production callers**.

## 2. The fix

At commit, derive `retention` from the frozen `kind` and **ignore what the manifest claims**:

```ts
retention: browserArtifactRetention(manifest.kind),
```

That is the whole change. It gives the zero-caller module its caller, and it makes the
module's stated invariant true.

`browserArtifactRetention` is a **total function over a closed enum** with
`FAIL_SAFE_RETENTION = "ephemeral"` for anything unrecognised — so an unknown or hostile
`kind` yields the *shortest* class, not the longest. That fail-safe direction is why deriving
is strictly safer than trusting.

## ★ 3. Override, do NOT reject — and why

A worker whose manifest declares a different class could be rejected instead. **Deliberately
not chosen:**

- The security property is achieved by **ignoring** the value. Rejecting adds a failure mode
  for **zero additional security**.
- The field is REQUIRED by the frozen manifest schema (`artifacts.ts:305`), so every worker
  must send something. Rejecting on disagreement turns a benign difference of opinion into a
  failed commit, and the commit path is where real work is lost.

**But a disagreement is still information** — it means either a buggy worker or an attempted
downgrade. So the mismatch is **observed**, not silently swallowed.

## 4. `sensitivity` is deliberately NOT changed

`artifactSensitivitySchema = z.literal("restricted")` (`artifacts.ts:279-283`) is
**single-valued**, so the frozen schema already makes it unforgeable: a manifest cannot
declare anything weaker and parse. Deriving it server-side would add code that computes a
constant.

Recorded here so the next reader does not "fix" the asymmetry by adding a no-op — and so that
if `sensitivity` ever gains a second value, this note is the reminder that it must move to the
control plane on that day.

## 5. What this does NOT do, stated plainly

- **It does not enforce retention.** Nothing still reads the column to act. This makes the
  stored value *trustworthy*; it does not make it *effective*. That is the follow-up, and it
  now has a sound foundation.
- **The mismatch signal is a log line, not an audit record.** The finding notes DE-11 claims
  "retention are audited" and nothing audits. A log is honest and cheap; it is **not** the
  audit trail that claim describes, and this ticket does not pretend otherwise.
- **It does not correct DE-11 or the five other overclaiming documents** (finding §1, §2).
  That is a security-register change and belongs with its owner.

## 6. Tests

| Area | Test |
|---|---|
| ★ A worker-declared class is IGNORED | commit a manifest declaring `audit` for `browser_cookie_state` → stored `ephemeral` |
| Every kind derives its documented class | table-driven over all 12 frozen `ARTIFACT_KINDS` |
| ★ An unknown kind fails SAFE | an unrecognised kind derives `ephemeral`, not the longest class |
| A matching declaration is unchanged | no spurious mismatch signal on the common path |
| Mismatch is observed | a disagreeing manifest emits the signal exactly once |
| No behaviour change elsewhere | the artifact-commit integration suite still passes end to end |

## 7. Mutation targets

Removing the derivation (reverting to `manifest.retention`) must die. Replacing the fail-safe
with a long class must die. Dropping the mismatch signal must die.
