# DSK-002 — Folder grants, local sandbox capability, and offline policy

**Date:** 2026-08-21
**Branch:** `docs/replatform-program` (PR #323)
**Terrain SHA:** `e72f480ef`
**Depends on:** DSK-001 ✅, DAT-005 ✅, DAT-006 ✅, WRK-005 ✅

This document is committed **before any DSK-002 code**. Its commit SHA is the ticket's
Start SHA.

---

## 1. What the ticket asks

**Outcome.** Require explicit local folder grants; report none/Docker/OS isolation
capabilities; implement encrypted offline event buffering; mediate device-local handles
through the DAT-004 broker plus a fence-aware egress path.

**Acceptance**, numbered here so every later section can map to a clause:

1. Expired offline work cannot auto-commit or use a local credential for governed remote
   effects.
2. Orphan patches require review.
3. Ungranted paths and symlink escapes fail closed.
4. The sandbox cannot read OS credential storage or bypass the broker/proxy.
5. Local activation is destroyed at lease/session deadline even while the public Internet
   remains reachable.

Two of these — (4) and (5) — cannot be closed in full by this ticket. §7 says so plainly
rather than declaring a partial mechanism a pass.

---

## 2. The terrain finding that reframes the ticket

**Most of what DSK-002's *outcome* sentence names is already built.** Reading the outcome
as a build list would produce four re-implementations of working code.

| Outcome clause | Status | Where |
|---|---|---|
| encrypted offline event buffering | **built** (WRK-006) | `worker-daemon/src/events/` — KEK custody, per-row HKDF DEK, ordered drain, `stale_fence` stop, poison-row quarantine |
| symlink rejection at capture | **built** (DAT-001) | `build-manifest.ts:104`, `git-base.ts:165` — both walks `lstat` and reject |
| folder-grant record + admission | **built but INERT** (DAT-006) | `folder_grants` table, `folder-grant.ts`, `folder-grant-path.ts` |
| isolation capability vocabulary | **already frozen** | `worker-protocol/src/capabilities.ts:57-59` |
| device-local broker port | **built, fail-closed** (DSK-001 B) | `device-local-broker.ts:114` throws, naming DSK-002 |
| monotonic lease expiry | **built** (WRK-005) | `lease-renewal.ts:474-476` — a late timer never trusts wall time |
| orphan-output quarantine | **built** (WRK-005) | `lease/quarantine.ts` |

**And the part that is NOT built is the part that matters:**

```
admitCapturedPaths        → 0 production callers
createFolderGrantService  → 0 production callers
buildWorkspaceManifest    → 0 production callers (re-exported only)
```

Grep-verified at `e72f480ef`. Both ends of the folder-grant chain exist, fully unit-tested,
and **nothing connects them to anything**. Acceptance clause (3) is therefore *vacuously
true today* — no ungranted path fails closed, because no path is ever checked.

**So DSK-002's real work is the BINDING, not the parts.** That is the design decision this
whole document turns on, and it is why the lane split in §8 does not follow the outcome
sentence's four nouns.

---

## 3. The threat model inverts here

DSK-001 could assume the device was the user's and the control plane was the thing to
protect. DSK-002 is the first ticket where **the adversary may own the machine**, and —
more usefully — where an adversary who owns *neither* still wins if we are careless:

> **The agent is the adversary, and the granted folder is its writable surface.**

A job runs on the user's desktop with a grant on `~/work/project`. Untrusted model output
can create files in that folder. If it plants `~/work/project/notes` as a symlink to
`~/.ssh/id_rsa` and the capture follows it, the private key lands in a snapshot the job can
read back. That is a sandbox→host credential escalation using nothing but a grant the user
deliberately gave.

This makes clauses (3) and (4) the *same attack from two directions*, and it fixes where
the defence must live.

### 3.1 The server cannot be the symlink authority

`folder-grant-path.ts:86` reads:

```ts
const { path, kind } = entry;
if (kind === "symlink") { rejected.push({ path, reason: "symlink_unrepresentable" }); … }
```

`kind` is **device-supplied**. A compromised or buggy daemon reports `kind: "file"` for a
followed symlink and the server admits it: the path (`project/notes`) is safe, in-base, not
secret-looking, and the reported kind is representable. The content is the private key.

`admitCapturedPaths` is therefore **not** the symlink defence and must stop being described
as one. It is a *declaration check*: it validates what the device SAID. The symlink defence
is `lstat` on the device, and it already works. Both are needed; neither substitutes.

**D1. Name the two layers separately and test them separately.** The device-side walk is
the containment; the server-side admission is the declaration check. A test that proves one
must not be cited as evidence for the other.

### 3.2 What `lstat` does not catch

The walks reject symlinks correctly, including a symlinked *directory* mid-path (each node
is `lstat`ed as the walk descends). Three residuals, recorded rather than assumed away:

- **Hardlinks.** A hardlink to `~/.ssh/id_rsa` inside the granted base is indistinguishable
  from a regular file by `lstat`. `nlink > 1` is the only local signal — see the D2
  amendment below, which retires it on measurement.
- **The root is never `lstat`ed.** `walkContentTree(input.root, input.root, …)` calls
  `readdirSync` on the root directly. A root that is itself a symlink is followed. Between
  grant time and capture time this is a TOCTOU escape.
- **Ignore is checked AFTER representability.** `walkContentTree` runs
  `assertRepresentable(stats, relPath)` before the ignore test, so a node that is itself a
  symlink throws the whole capture even when a rule would have skipped it. Availability,
  not security — a user whose `.aoa` is a symlink can never snapshot — but it belongs in
  Lane A's blast radius since Lane A touches this ordering.
- **Windows reparse points.** libuv maps both `IO_REPARSE_TAG_SYMLINK` and
  `IO_REPARSE_TAG_MOUNT_POINT` (junctions) to `isSymbolicLink()`, so junctions *should* be
  caught — but "should" is not evidence, and the ticket demands platform-capability tests on
  every advertised OS.

**D2.** Lane A closes the root `lstat` gap and adds the junction proof.

**D2 — AMENDED 2026-08-21, before implementation.** The original D2 said hardlinks would
get "an explicit `nlink` check on POSIX". **Measurement retires that guard.** Sampling this
repository's own `node_modules`:

```
files sampled: 4001
nlink>1:  3678   (92%)      e.g. …/@adobe/css-tools/package.json  nlink=41
nlink==1:  323
```

pnpm's content-addressable store hardlinks every package file into `node_modules`, on
Windows as well as POSIX. An `nlink > 1` rejection would refuse **92% of the files in any
pnpm project** — it would be switched off on first contact, and a guard that gets switched
off is worse than none, because the residual then goes unrecorded.

There is also no portable way to ask the useful question. The threat is a hardlink whose
*other* name is outside the granted base, and POSIX offers no enumeration of the links to
an inode. Linux's `protected_hardlinks` does not help either: it permits linking files you
own, and the user owns `~/.ssh/id_rsa`.

**So hardlinks are an UNCLOSED residual of DSK-002, by decision and with evidence.** The
defence that actually works is the principal boundary — a capture that runs as a principal
which cannot read `~/.ssh` in the first place — and that is DSK-003's least-privilege host,
the same boundary clause (4) turns on in §7. Shipping a noisy `nlink` check would have
bought the appearance of a mitigation and none of the substance.

---

## 4. Capabilities need no frozen-protocol change

The ticket's "nono/Docker/OS isolation" (read: *none* / Docker / OS-native) maps onto the
already-frozen vocabulary:

```
sandbox.filesystem_isolated
sandbox.process_isolated
sandbox.filtered_egress
```

**D3. Report the three frozen booleans; do NOT introduce an isolation-tier enum.** Three
independent capabilities express the real matrix better than a tier ladder: a Docker-backed
desktop reports filesystem+process isolation but not necessarily filtered egress, and a bare
desktop reports none of the three. A tier enum would force a false ordering and would need a
frozen-file edit, which is prohibited.

The placement side already fails closed on this: `effective = capabilityCeiling ∩
reportedCapabilities`, and an empty intersection means a job requiring `sandbox.*` simply
never matches a desktop that lacks it. **So the whole of DSK-002's capability outcome is
detection + honest reporting** — the enforcement exists.

**D4. Detection must fail toward "no capability".** An undetectable or erroring probe
reports the capability as ABSENT. Over-reporting places jobs on a device that cannot contain
them; under-reporting only costs placement opportunities.

---

## 5. Offline policy — the deadline is local, and the Internet is not the signal

Clause (5)'s phrase "even while the public Internet remains reachable" is the entire point:
**reachability is not authority.** A device that can still reach the Internet, but whose
lease has expired or whose fence has been superseded, must behave exactly like a
disconnected one.

WRK-005 already has the correct primitive at `lease-renewal.ts:474`:

```ts
// Pre-POST monotonic expiry check: a late timer (sleep/resume) never trusts a
if (schedule.now() >= state.expiresAtMs) { … }
```

**D5. Every governed local effect gets the same pre-effect monotonic check**, not just lease
renewal. "Governed" means: committing a patch, activating a device-local credential, or
performing an egress through the broker. The check is on the same clock discipline — a
suspend/resume must not buy extra validity.

**D6. Expired work does not fail loudly into a retry; it converts to an orphan.** WRK-005
already routes orphan output to `lease/quarantine.ts`, and clause (2) ("orphan patches
require review") is that path. Reusing it means expired offline work lands in review rather
than inventing a second terminal state.

---

## 6. The device-local broker

DSK-001 Lane B shipped `failClosedDeviceLocalBroker`, which throws and names this ticket,
and deliberately kept the `proxy_endpoint` reference kind alive
(`DEVICE_LOCAL_ACTIVATION_REFERENCE_KINDS = ["file_path", "env_name", "proxy_endpoint"]`).

That third arm is now load-bearing, and §7 explains why.

**D7. Prefer a non-materializing activation.** Ranked, most to least safe:

| Kind | What exists after activation | Destroyable? |
|---|---|---|
| `proxy_endpoint` | a loopback endpoint the broker owns | **yes** — closing it is destruction |
| `env_name` | a value in a child's environment | only by killing the child |
| `file_path` | **bytes on disk** | only by unlinking, and a `kill -9` orphans them |

**Activation SHOULD be `proxy_endpoint` wherever the consuming tool can use one.** This is
the difference between a deadline that is *enforced* and a deadline that is *requested*.

---

## 7. What this ticket CANNOT close — stated, not fudged

### Clause (4): "the sandbox cannot read OS credential storage"

**Not closable by DSK-002 on a desktop with no isolation mechanism.** If the "sandbox" is a
child process running as the same OS user as the daemon, then by construction it can read
whatever that user can read — including the OS keychain entries DSK-001 Lane A stored, since
the OS grants keychain access per-user, not per-process.

Real containment needs a lower boundary than this ticket owns: a separate OS user, a
Docker/OS-native jail, or an entitlement-restricted host — all of which are **DSK-003's**
installer and least-privilege-host story.

**What DSK-002 delivers instead, and it is not nothing:** the device reports its isolation
capabilities honestly (D3/D4), so the control plane *refuses to place* a job that requires
isolation the device cannot provide. That is a **placement refusal, not a containment
guarantee**, and the result doc will say exactly that. Declaring the placement gate as
satisfying clause (4) would be the dishonest move here.

### Clause (5): "local activation is destroyed at deadline"

Destruction is enforceable **in-process**: a monotonic timer plus D5's pre-effect check. It
is *not* enforceable across a `kill -9` between activation and deadline — a killed daemon
runs no destructor.

D7 is the structural answer: choose an activation kind with nothing to leave behind. For
`proxy_endpoint`, process death **is** destruction (the listener dies with the owner). The
residual is confined to `file_path` activations, which the design pushes to last resort and
which the result doc will list as a named residual with its blast radius.

---

## 8. Lane split

Four lanes, ordered so each lands independently CI-green. The split follows the *work*, not
the outcome sentence's four nouns (§2).

| Lane | Scope | Clauses |
|---|---|---|
| **A** | Bind grant→capture. Device-side confinement: `lstat` the root, junction proof, `nlink` residual. The declaration-check/containment split (D1/D2). | 3 |
| **B** | Capability detection → the three frozen names, failing toward absent (D3/D4). Platform tests per advertised OS. | — (outcome) |
| **C** | Offline policy: the pre-effect monotonic check on every governed local effect; expired work → orphan review (D5/D6). | 1, 2 |
| **D** | Device-local broker activation + deadline destruction, `proxy_endpoint`-first (D7). | 4 (partial), 5 (partial) |

Lane A first: it is the clause that is vacuously true today, so it is the one currently
carrying a real, exploitable gap.

---

## 9. Invariants

| # | Invariant | Lane | How it is proven |
|---|---|---|---|
| I1 | A capture outside the declared base fails closed | A | admission unit + a wired end-to-end case |
| I4b | A hardlink escape is NOT closed; the residual is recorded, not silently dropped | A | D2 amendment + result-doc residual |
| I2 | A symlink is rejected by the DEVICE walk, not by the server's declaration check | A | device-side test with a real symlink on disk |
| I3 | A device that LIES about `kind` still cannot widen the base | A | server-side test feeding `kind:"file"` for an out-of-base path |
| I4 | The capture root is `lstat`ed; a symlinked root fails closed | A | new test — currently RED |
| I5 | Undetectable isolation reports ABSENT, never present | B | probe-throws test |
| I6 | Reported capabilities are a subset of the frozen vocabulary | B | enum-membership test |
| I7 | A governed local effect past the deadline is refused on the monotonic clock | C | injected-clock test incl. suspend/resume |
| I8 | Internet reachability never extends authority | C | reachable-but-expired test |
| I9 | Expired offline work converts to orphan review, not retry | C | quarantine-routing test |
| I10 | Activation is destroyed at deadline | D | timer test |
| I11 | `proxy_endpoint` is preferred; a `file_path` activation is recorded as a residual | D | selection test + written residual |

Every guard listed here is mutation-tested before its lane lands. A guard that no mutant can
kill is not a guard.

---

## 10. Out of scope

- **The installer, the least-privilege host, and any real OS jail** — DSK-003.
- **Signed update / drain / rollback** — DSK-004.
- **Widening `KNOWN_WORKER_CAPABILITIES`** — frozen, and D3 shows it is unnecessary.
- **A second scheduler or placement path.** Capability reporting feeds the existing
  intersection; nothing new decides placement.
