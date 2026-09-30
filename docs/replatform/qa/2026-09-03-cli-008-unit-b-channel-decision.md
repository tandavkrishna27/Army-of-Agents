# CLI-008 Unit B — the inbound channel: DECISION

> **Status: DECIDED end to end. §7's gap is closed by §8 — the byte path exists, and every piece of it
> is already built and orphaned. A build plan is writable.**
> Amended 2026-09-03 after tracing where the bytes would actually come from. Evidence: a 40-agent sweep, five lenses, every candidate attacked
> refute-by-default. **Both load-bearing claims in `CLI-008-design.md` §3 are false**, and §3 is
> corrected by this document.

**Decision: `stageFiles`, a method on the NON-FROZEN `SandboxProvider` port, paired with a local
`fileStagingMode` field — the exact shape DAT-009 already used to grow that port. The frozen wire
vocabulary is not touched.**

---

## 1. §3's first claim is false: the thing that must not grow is not the thing that would grow

§3 says *"The FROZEN `SandboxProvider` port has no file-staging operation… The port must not grow"*
and cites `worker-protocol/src/capabilities.ts:125-153`.

**That file does not define the port.** It defines `PROVIDER_OPERATIONS` — a wire/registry
**vocabulary**. The `SandboxProvider` port is `packages/worker-daemon/src/supervisor/provider.ts:339`,
in a package that is **not frozen**.

★ **And the port has already grown past eleven.** It declares **thirteen** methods plus a mode field:
the eight core ops, `checkpoint`/`restore`/`health`, and then `digestArtifact`, `exportArtifact` and
`readonly artifactExportMode` (`provider.ts:346-387`). *"The port must not grow"* is false at HEAD.

That growth was deliberate, reviewed and shipped — `d5885053f`, DAT-009 slice 1 — on exactly these
grounds, in its own commit message: *"all in packages/worker-daemon, which is NOT frozen.
`git diff packages/worker-protocol/src` is EMPTY… there is no frozen change, no custodian STOP."*

**The two-layer rule is stated in the port's own header.** `advertisedOperations` is typed
`ReadonlySet<ProviderOperation>`, so a non-frozen capability **cannot** appear there — and does not
need to, because support is declared by a separate **local** mode field (`provider.ts:341, :362-365,
:387`). That is not a workaround; it is the designed seam, and `artifactExportMode` is it working.

---

## 2. §3's second claim is false too: the argv bound is per-element, not per-job

§3 says *"argv is bounded… a task whose description exceeds ~7.4 KB cannot run distributed at all,"*
and concludes the channel *"must not be argv-shaped."* The premise is roughly right and **the
conclusion does not follow.**

Measured at HEAD:

- The cliff is **8,192 CHARACTERS**, not ~7.4 KB, and it is a **refusal, not a truncation** —
  `prompt_too_large` (`task-run-batch-workload.ts:80, :237-241`). `FROZEN_MAX_ARG_CHARS = 8192`
  mirrors the frozen schema `args: z.array(z.string().max(8192)).max(256)`.
- The ~7.4 KB is the *description budget after framing*: minimal framing accepts **7,736** chars and
  refuses 7,737; realistic framing plus one wake-comment section accepts **7,437**.
- ★ **The protocol bound is 8 KiB PER ELEMENT and ~64 KiB PER JOB.** A chunked shape
  (`sh -c '<script>' _ c1..c10`) carries **65,306 prompt characters across 11 args** at exactly the
  65,536-byte submission bound — **8.0× today's usable capacity** — and the `shellJoin`'d string is
  then 65,464 bytes, still **half** of Linux `MAX_ARG_STRLEN` (131,072).

**So the 8 KiB ceiling is a property of `buildArgsFor`'s one-positional shape, not of the protocol.**
Argv chunking is a legitimate 8× headroom available today. It is *not* the channel — it cannot carry
a repository — but §3's reasoning for excluding it was wrong and is withdrawn.

---

## 3. The decision, and why this shape

**`stageFiles(sandboxId, files)` on the non-frozen port, plus a local `fileStagingMode`.**

Three independent lenses converged on it from different starting points. It is the only candidate
that is *both* viable and free of frozen-surface change:

- **The transport already implements it.** `E2bStagedFile`, `writeFiles`, `readFile` and a directory
  enumerator are declared at `sandbox-e2b-provider/src/transport.ts:128-155` and implemented in
  **both** `mock-transport.ts:191` and `real-transport.ts:187` — added for CLI-002/D1 and with **no
  production caller on the distributed path**. The capability exists; what is missing is a port
  method asking for it, and a caller.
- **The precedent is exact.** `exportArtifact` + `artifactExportMode` is the same shape, shipped, with
  the frozen package untouched.
- **The programme has already tried the alternative and withdrawn it.** The byte-egress escalation's
  revision 1 declared an E4-D02 STOP citing `OPTIONAL_PROVIDER_OPERATIONS`; revision 2 withdrew it and
  the capability shipped as non-frozen port methods instead
  (`HANDOFF-lane-b-browser-service.md:294-299`, `DECISION-byte-egress-and-provider-topology.md:12-30`).
  **That is the programme's only data point on this question, and it says: do not grow the vocabulary;
  grow the port.**

### Rejected: growing the frozen vocabulary with a 12th operation

Measured, so the cost is on the record rather than asserted: adding `stage_files` to
`OPTIONAL_PROVIDER_OPERATIONS` reds **exactly 1 of 289** tests in `worker-protocol`; adding it to
`CORE_PROVIDER_OPERATIONS` reds **27**, because every constraint-profile fixture and digest changes.

★ **The cheap number is the misleading one.** The real cost is downstream: the conformance suite
iterates `OPTIONAL_PROVIDER_OPERATIONS` exhaustively and the fake driver **defaults its advertised
optional set to all of them** (`sandbox-provider-contract/src/contract.ts:146`,
`sandbox-fake-provider/src/fake-driver.ts:187-191`), so a fourth optional op is auto-advertised by a
driver that cannot serve it. One green test is not the price.

### Also rejected

- **`env` as a content channel.** Measured: env values can **never** be authored on the wire — the
  recursive key scan rejects `workload.env` and `extensions[].value.env` alike. Worse, every redeemed
  value joins the run's **redaction canary list**, so a prompt delivered through env would be redacted
  out of the very logs meant to show it. Secret-safe, and actively wrong for content.
- **Inline payload in `extensions[]`**, and **raising the argv ceiling** — both rejected across lenses.

---

## 4. Two hopes this sweep killed, both by measurement

**Unit F does NOT fall out of this decision.** `readFile` has the same orphaned shape as `writeFiles`,
which made "one seam, both directions" look free. It is not: `buildWorkspaceManifest` imports
`node:fs` **at module scope** and `assertCaptureRoot` hits disk before anything injectable runs; its
input accepts only `sha256` + `runGit`. Measured — running it with `root="/sbx/workspace"` and a
transport injected raises `WorkspaceSnapshotError: capture root is not readable (ENOENT)`. Making the
return path work needs that function refactored to accept an injected filesystem. **That is Unit F
work and it is not free.**

**The frozen envelope's `file` secret-materialization slot is not merely unused — it is actively
refused.** Measured: `admitSandboxLocalResolution` on `{kind:"file"}` returns
`{outcome:"denied", reason:"malformed"}`, while the same handle with `materialization:"env"` resolves.
"Unskip it" is not a small change.

---

## 5. What this unblocks, and what it does not

Units **C** (MCP config), **D** (instructions bundle) and **E** (workspace) all become "write the
files, then exec" once `stageFiles` exists. **F is untouched** by this decision.

★ **Nothing here makes an agent capable.** `capabilityProven` stays false on every run until F ships,
and this decision does not change that.

## 6. Follow-ups filed

- **The 8,192-character prompt cliff** deserves its own finding: it is a live refusal today, the code
  constant is 8192 rather than the doc's ~7.4 KB, and chunking gives 8× without any new channel.
- `CLI-008-design.md` §3 is corrected by this document; the ticket should cite it rather than restate
  the withdrawn bounds.

---

## 7. ★★★ AMENDMENT — the decision settled the PORT SHAPE, not the BYTE PATH

I wrote §3 as though `stageFiles(sandboxId, files)` were the whole answer. It is not. **Where do the
`files` come from?** Tracing that turns up a second, separate question this document had not asked,
and a build plan written now would be written over the hole.

### What is settled

- **The envelope carries only artifact IDs, never bytes.** `stdinArtifactId`,
  `workspace.manifestArtifactId` and `adapter.configArtifactId` are all references, and
  `batchWorkloadV1Schema` is `.strict()` — **no bytes field can be added to the workload without a
  contract change.** So the payload cannot ride the envelope, and §3's decision does not change that.
- **The pointer slots have zero producers AND zero consumers.** `workspace: null` is hard-coded at the
  single envelope builder; `manifestArtifactId` appears only in the schema and one test;
  `stdinArtifactId` is a literal `null` at all six production sites; and no read of `job.workspace`
  exists anywhere in `worker-daemon` or `sandbox-e2b-provider`.
- **★ The worker's fetch client is BUILT AND UNCALLED — the third orphan in this area.**
  `ControlPlaneClient.artifactTransferGrant` consumes the frozen `artifact_transfer_grant` op, its
  response union includes `download_granted` with a full schema, and the server can issue one. A grep
  for `.artifactTransferGrant(` finds **exactly one caller, a unit test**
  (`worker-daemon/src/__tests__/artifact-commit-client.test.ts:80`). Alongside `writeFiles` and
  `observeRun`, that is three built-and-orphaned components on this path.

### The shape that follows

Grant in, reference out, **never bytes through the daemon** — the exact inversion of DAT-009's export:

1. the control plane stores the bundle as an artifact;
2. the worker mints a short-lived, prefix-scoped **download grant** over the frozen op;
3. the grant — opaque, no bytes — rides into the provider;
4. **the provider** fetches and writes with `transport.writeFiles`.

★ This also **corrects §3**: `stageFiles` should take a **grant**, not bytes. A bytes-shaped signature
would route payloads through a daemon that is dependency-pinned precisely so it does not handle them.

### ★ The open question, which blocks the plan

**Step 1 has no established path.** `authorizeArtifactCommit`, `recordArtifactGrantIntent` and
`commitArtifactVersion` are all in `GUARDED_JOB_MUTATORS` and each begins with `guardActiveFence`
(`server/src/services/job-fencing.ts:44`). That machinery is built for the **outbound** direction — a
worker committing its own output under an active fence. Using it **inbound**, for a bundle the control
plane authors *before* the work starts, is the inverse, and I do not know whether it is the right
vehicle, a wrong one, or simply unbuilt.

Until that is answered, `stageFiles` has a signature and no supplier.

### And one thing Unit E does NOT wait on

A repository is 10²–10³ times the ~48 KB argv and extensions ceilings, `buildWorkspaceManifest`
cannot be pointed at a sandbox, and `git` + `curl` are already in the E2B template
(`e2b/e2b.Dockerfile:18-25`). **Unit E must be a PULL from inside the sandbox regardless of what
Unit B decides for C and D.** That is worth knowing now: the channel decision does not size E.

### What would close this

A focused trace of the inbound artifact path: can the control plane author an artifact for a job that
has not started, and if so by which write path and under what authority — or is that unbuilt, making
the real Unit B deliverable *"give the control plane a way to stage a bundle"* rather than
*"give the provider a way to write files"*.

---

## 8. ★★★ §7's gap, CLOSED — the byte path is four orphans in a row

A 29-agent trace answered it by **running embedded PostgreSQL against HEAD's migrations**, not by
reading. Both halves of the answer matter.

### The suspicion was right, and it is structural

**The fenced mutators are unusable inbound BY CONSTRUCTION.** `ActiveFenceRequest` demands
`leaseId`, `fence`, `workerId`, `targetGeneration`, `profileHash` and `providerConstraintHash` — none
of which exist before placement mints them. **The control plane cannot even construct the argument**,
let alone satisfy the guard.

And the no-fence window is wider than "before a lease row exists". Measured: with a `leases` row
correct in all thirteen identity fields but `status='offered'`, `lockActiveFence` still throws
`stale_fence`. A fence begins at worker **ACK**, so the whole span from admission through placement,
offer and ack-in-flight has none. Three lenses independently returned BLOCKED for every
reuse-the-guarded-path candidate.

### And the answer is still yes, by a path nobody was using

**`JobArtifactsRepository.insert` is a plain, UNGUARDED tenant-repo write.** It is not in
`GUARDED_JOB_MUTATORS`, never calls `guardActiveFence`, and a repo-wide grep finds **zero callers —
production or test**. That is a **fourth** built-and-orphaned component, after `writeFiles`,
`observeRun` and `artifactTransferGrant`.

**Measured, and this is the decisive result:** inside `runInTenant(ORG)` as `aoa_app`, with no lease
and no fence ever having existed, inserting a `job_artifacts` row with `status: 'committed'`
**succeeded** (`leaseId=null, fenceToken=null`), and `findCommitted` **found it** — which is exactly
the precondition the download branch checks.

**The download half of the frozen op is deliberately fence-INDEPENDENT and fully built.**
`artifact-transfer-grant.ts` locks a fence only on the *upload* branch; download proves tenant-scoped
object existence via `findCommitted` plus objectKey and prefix checks, then presigns a GET. The route
is wired, the service composed, and an existing integration test already proves a download grant is
issued **after the lease has expired**.

The other barriers are real but trivially satisfiable by the control plane: RLS is enforced
(a foreign `organization_id` fails `42501`) and the composite FK is enforced (a ghost job fails
`23503`) — both satisfied by writing inside `runInTenant(org)` for a job that exists. There is **no**
CHECK on `status`, and `attempt`, `lease_id`, `fence_token`, `object_key` and `sha256` are all
nullable.

### So the path is

```
control plane   putObject + jobArtifacts.insert(status:'committed')   ← unguarded, ZERO callers
worker          artifactTransferGrant → download_granted             ← built, ONE caller (a test)
provider        redeem the grant, transport.writeFiles                ← built, ZERO callers on this path
```

**Every component exists. Nothing composes them.** Unit B's build is wiring, not construction — which
is why it was invisible: nothing is missing, so nothing looked absent.

### One question the plan must settle first, not assume

The two sweeps disagree on whether the bundle should ride **object storage + a grant** or the
envelope's **`extensions[]`** (measured ceiling ~49 KB, which fits an MCP config and an instructions
bundle but not a repository). Sweep 1 rejected inline extensions; sweep 2 recommended it. **That is a
live conflict and the plan resolves it by measurement, not by preference** — and it does not block
the provider-side work, which is identical either way.

---

## 9. Correction — the Unit C+D byte figures above were the WINDOWS numbers

The measurement that produced them ran on a Windows checkout, where `core.autocrlf=true` expands the
LF blobs to CRLF. Linux CI measured **217 bytes less** for the `commander` bundle
(110 + 65 + 42 CRLF pairs across `AGENTS.md`, `HEARTBEAT.md`, `SOUL.md`), and reds `verify (1)`.

The figures in §8 and the Task 1 table are now the **LF** values — what CI checks out and what a Linux
sandbox actually receives:

| | was (Windows) | is (LF) |
|---|---|---|
| `commander` bundle | 26,568 | **26,351** |
| C + D | 26,814 | **26,597** |
| headroom under the 48,960 ceiling | 22,146 | **22,363** |

★ **The decision is unaffected**, and it is worth saying why rather than silently editing numbers:
C+D fits with ~46% of the container to spare either way, and the channel choice never rested on
capacity — it rested on `extensions[]` having no producer that submission can supply. A 217-byte
correction cannot move that.

**The real fix is not in the test.** `.gitattributes` now pins the bundle files `eol=lf`, because
these bytes are **delivered into a Linux sandbox as an agent's system prompt** — CRLF there is wrong
on its own terms. The precedent was one line away: `TOOLS.md` was already pinned for exactly this
reason, which is why it was the only bundle file the discrepancy did not touch.
