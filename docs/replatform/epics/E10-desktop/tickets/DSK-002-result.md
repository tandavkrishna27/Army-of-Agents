# DSK-002 — result

**Date:** 2026-08-21
**Branch:** `docs/replatform-program` (PR #323)
**Start SHA:** `a3b9f7dd5` (the DSK-002 design, committed before any code)
**Ticket tip:** `9fa726a53`
**Covers:** D1–D7, invariants I1, I3, I4, I5, I6, I7, I8, I10, I11; I9 by citation; I4b as a recorded residual

All four lanes are in. What is deliberately NOT built — and why building it now would
be guesswork rather than caution — is in §7.

---

## 1. What shipped

| Commit | Increment | Mutants |
|---|---|---|
| `e72f480ef` | the `.aoa/` keystore leak (pre-ticket defect, found during terrain) | 7/7 |
| `30896760e` | Lane A — the capture root is stat'ed (I4) | 5/5 |
| `4bb44050b` | D2 amendment — measurement retires the `nlink` guard | — |
| `1bd85461a` | Lane A — grant↔device binding (I1, I3) | 8/8 |
| `07738b79d` | Lane B — isolation capabilities (I5, I6) | 8/8 |
| `8b69ed96e` | Lane C — the fence deadline gate (I7, I8) | 8/8 |
| `9fa726a53` | Lane D — the activation policy (I10, I11) | 10/10 |

**46 mutants, 46 killed** — but two of them only after the mutant exposed a defect in
*my own test*, which is the number that actually matters (§5).

534 worker-daemon tests, 31 server unit tests, 8 folder-grant integration tests against
real embedded Postgres with RLS, `tsc` clean across both packages. The D1 Merge Train ran
green on `1bd85461a`, proving Lane A's `server/src` changes on the live two-replica
topology.

---

## 2. Three live defects, none of which the ticket asked about

The ticket's outcome sentence describes work to *add*. Terrain-mapping found three
things already broken, and all three were security defects in shipped code.

### 2.1 The `.aoa/` keystore was captured by content snapshots

`AOA_BUILTIN_IGNORE_RULES` exists, per its own docstring, as "the overlay that keeps the
`.aoa/` keystore dir out of a snapshot". It was applied on the **git** base only. The
`content_manifest` walk used `input.ignore.rules` — the caller's list — so a snapshot
taken with `rules: []` walked `.aoa/` and captured the device identity byte-for-byte,
into a manifest that then attested an ignore policy it had not enforced.

Fixed at one point: `resolveEffectiveExplicitRules` puts the built-ins underneath the
caller's rules and the SAME resolved value feeds the walk and the digest, so applied and
attested cannot diverge again — the invariant `git-base.ts` already stated in prose.

### 2.2 The capture root was never stat'ed

Every *child* is `lstat`ed as the walk descends. The root was not: `walkContentTree`
goes straight to `readdirSync`, and `captureGitBase` uses `root` only as a git cwd. A
root that was itself a link was followed and everything behind it captured — a TOCTOU
escape, because the agent writing into the granted folder is exactly the actor able to
replace the base between grant time and capture time.

### 2.3 A folder grant was usable by any desktop in the organization

`resolve()` filters on `folderGrantId` + `revokedAt IS NULL` inside the org's RLS scope.
It SELECTs `executionTargetId`, `deviceGeneration` and `ownerUserId`, returns all three,
and compared **none** of them. An organization's RLS scope is not a device scope: two
desktops in one org both pass it. So a grant issued for desktop A was usable by desktop
B, survived the re-enrolment of the device it was issued for, and survived its owner
losing membership.

The precedent for the right behaviour was already in the tree —
`execution-target-resolver.ts:137` fails closed on the identical mismatch. Folder grants
simply did not follow it.

---

## 3. The reframe: the parts were built, the binding was not

Reading the outcome sentence as a build list would have produced four
re-implementations. WRK-006 had already built the encrypted offline outbox, WRK-005 the
monotonic lease expiry and orphan quarantine, DAT-001 the symlink-rejecting walks, and
the frozen vocabulary already carried the three `sandbox.*` names.

What was missing was the **connection**: `admitCapturedPaths`,
`createFolderGrantService` and `buildWorkspaceManifest` had **zero production callers**
between them, so acceptance clause (3) was *vacuously true* — no ungranted path failed
closed because no path was ever checked.

---

## 4. Two prior invariants this could have broken

Both were found by asking what a change would cost, rather than by a test failing.

**The DSK-001 unmatchability guarantee.** `buildDesktopHello` reported
`reportedCapabilities: []` *as* the guarantee: "empty ∩ anything = empty". Lane B makes
that list non-empty, which retires the phrasing. The argument that actually holds was
read out of the frozen matcher rather than from the comment claiming it:

```ts
if (!effective.has(`workload.${requirements.workloadType}`)) return false;
```

Only `sandbox.*` names are reported, so no `workload.*` can be in the intersection under
any server ceiling. That is now an assertion, not a paragraph — a mutant that smuggles
`workload.batch` into the docker mapping is killed by it.

**The enrolment replay guarantee.** `buildDesktopHello` takes no clock, random or
`process` because I7 replays the same hello, and any per-call variation turns a replay
into a new submission. Probing Docker inside would be exactly that variation: a daemon
that stopped between attempt and retry yields different bytes. Detection therefore
happens once, outside, and the mechanism is passed in and reused.

---

## 5. Where mutation earned its keep

**36/36 killed** is the boring number. These two are the useful ones:

- **R1 (delete the capture-root symlink arm) SURVIVED**, because my assertion was
  `/symlink|link|root/i` and the *other* arm's message — "capture root is not a
  directory" — contains "root". The guard was gone and the test stayed green. Pinned to
  the exact message.
- **V3 (digest the raw rule list) SURVIVED**, and it was not a weak mutant: the build
  path already hands in a resolved list, so the resolve inside
  `computeExplicitIgnoreDigest` is load-bearing *only* for the package's other
  consumers — the one caller with no coverage at all. Four contract tests added.

Also worth recording because it is the same failure in a different costume: my first
draft of the fence-deadline test invented an `identity` stub and cast it `as never`. The
cast suppressed the type error, and four tests then failed inside the event
canonicalizer instead. `as never` in a test disables precisely the check that would have
caught the mistake.

---

## 6. Design corrections, recorded rather than taken quietly

**D2 was wrong and measurement retired it.** The design said hardlinks would get "an
explicit `nlink` check on POSIX". Sampling this repository's own `node_modules`:

```
files sampled: 4001
nlink>1:  3678   (92%)      e.g. …/@adobe/css-tools/package.json  nlink=41
```

pnpm hardlinks every package file into `node_modules`, on Windows as well as POSIX. The
guard would have refused 92% of the files in any pnpm project and been switched off on
first contact — and a guard that gets switched off is worse than none, because the
residual then goes unrecorded. **I4b: hardlink escape is an unclosed residual of
DSK-002, by decision and with evidence.** The defence that works is the principal
boundary, which is DSK-003's least-privilege host.

**I9 / clause (2) is closed by citation, not by a new test.** "Orphan patches require
review" is already satisfied more strongly than the wording asks: quarantine has no
apply/promote/select field at all (the CAV-004 non-promotion invariant), writes under a
distinct `quarantine/…` prefix, and its only disposition is `quarantined`. Proven by
`quarantine-routing-decision.test.ts`, `quarantine-grant-finalize.component.test.ts` and
`quarantine-requires-device-session.test.ts`. A fourth test asserting the same regex
would be theatre.

**`sandbox.filtered_egress` is claimed by no mechanism.** Neither Docker's default
bridge nor a bare OS sandbox filters egress. It becomes reportable when Lane D's
fence-aware egress path exists; claiming it now is the exact over-report D4 forbids.

---

## 7. What is NOT done

**Lane D shipped the POLICY, not the wiring, and that is a decision.**
`clampActivationExpiry` is the bound `device-local-broker.ts` said out loud that nothing
enforced — including the `NaN` case, where every comparison is false so an unchecked
deadline sails through the clamp. D7's ranking (`proxy_endpoint` > `env_name` >
`file_path`) is ours rather than the caller's list order.

What Lane D deliberately did not do is invent the wiring. No lease deadline reaches that
layer today; threading one is part of building a real device-side implementation — an OS
keystore read and a loopback listener — which needs the least-privilege host and belongs
with DSK-003. A decorator written now would be guessing at an interface DSK-003 defines.
`failClosedDeviceLocalBroker` still throws, which is correct rather than a gap: it means
no activation can be minted, so no unbounded activation can exist.

Still open, each for a stated reason:

- **Clause (4) remains PARTIAL**, exactly as §7 of the design predicted. A same-user
  child process can read the OS keychain by construction; real containment needs
  DSK-003's least-privilege host. What ships instead is an honest capability report so
  the control plane **refuses to place** work needing isolation the device lacks. That
  is a placement refusal, not a containment guarantee, and calling it clause (4) would
  be dishonest.
- **Clause (5) is PARTIAL by the same split.** Lane C's gate closes the *authority* half
  — a `secret_materialization` past the deadline is refused locally, on the clock,
  whether or not anything called `close()`. The *destruction* half is bounded by D7's
  ranking rather than closed by it: for `proxy_endpoint` process death is destruction,
  but a `file_path` activation orphaned by `kill -9` leaves bytes no timer will collect.
  Ranking `file_path` last is a mitigation, not a fix.
- **Per-OS native isolation probes** — DSK-003 owns the host. A desktop that cannot
  prove Docker reports `none`, the correct fail-closed answer rather than a placeholder.
- **Hardlink escape (I4b)** — unclosed by decision, retired by measurement (§6).
- **Backward clock jumps** defeat the Lane C deadline check. Recorded in the code: the
  server-side `guardActiveFence` is the authoritative gate and is unaffected, and a
  machine whose owner controls the clock is the machine whose owner controls the binary.

## 8. Behaviour changes worth a release note

1. **Explicit-policy ignore digests changed value.** The digest — and the
   `contentRevision` derived from it — now covers the effective rules including the
   built-ins. Nothing in the field holds a persisted revision (the distributed path is
   dormant behind the default-off `AOA_DISTRIBUTED_EXECUTION_ENABLED`), but a
   re-snapshot of an unchanged tree will not match a revision computed before this.
   Frozen vectors are unaffected: both independent verifiers replay `ignorePolicy.digest`
   as a stored opaque value.
2. **A capture whose root is a link now fails** instead of following it.
3. **`resolveCapturedPath` takes a required `presented` parameter.** Required rather
   than optional so no caller can silently fall back to org-only scoping. There were
   zero production callers, so the strictness cost nothing.
4. **None of Lane D is reachable in production.** The broker remains fail-closed, so the
   activation policy is inert until DSK-003 wires a device-side implementation.
