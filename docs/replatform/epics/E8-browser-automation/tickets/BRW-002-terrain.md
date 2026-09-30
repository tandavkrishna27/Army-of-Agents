# BRW-002 — Sandbox-local Playwright runtime — TERRAIN

**Epic:** E8 · **Lane:** B (`C:\e8`) · **Mapped at:** `f7f6d56cc`
**Status:** terrain complete; design NOT yet written (one clause is design-blocked, see §6)

**Spec.** Outcome: launch Chromium/Playwright inside the sandbox without exposing CDP to
other tenants or the public network. Acceptance: (a) browser process shares only the job
sandbox; (b) downloads stay job scoped; (c) browser and child processes die on cancellation.
Test: deterministic local site navigation, download, popup, and kill.

> **Method note.** Five load-bearing terrain claims were written first, then attacked by
> independent reviewers instructed to refute them. **Two were REFUTED, three PARTIALLY
> REFUTED, none upheld.** Everything below is the post-refutation state. The claims that did
> not survive are recorded in §7 because the errors are instructive, not embarrassing.

---

## 1. MEASURED: E2B serves arbitrary in-sandbox ports to the public internet

**This is the single most important fact for BRW-002, and it is a measurement, not a read.**

Probe: `packages/sandbox-e2b-provider/scripts/probe-e2b-port-exposure.mjs`, run from a
**GitHub runner** (a genuinely external network location) by
`.github/workflows/keyed-e2b-cdp-probe.yml`. Run `32630219279`:

```
in-sandbox loopback: 8811=200 | 9222=200
port 8811: REACHABLE  http 200  servedOurMarker=true  [143ms]
port 9222: REACHABLE  http 200  servedOurMarker=true  [100ms]
```

An **unauthenticated** caller outside the sandbox retrieved our marker from **port 9222 —
the canonical Chromium remote-debugging port**. The loopback pre-check (both `200`) proves
the listeners were up, so the outside result is unambiguous.

**Why the original claim was wrong.** The claim was "AoA's `E2bTransport` has no
port-exposure operation, therefore CDP cannot be reached." The premise is true — the
interface has 13 members and none returns a host or URL. **The inference is invalid.** In
E2B there is no "expose" operation to omit: `getHost(port)` is pure string concatenation
(`${port}-${id}.${domain}`) with no API call and no side effect. Ports are routed on a public
wildcard domain **by construction**. Omitting the method removes a convenience, not the
reachability — and `create()` returns the `sandboxId`, which is the only input the URL needs.

### Consequences

1. **`public_cdp_endpoint` is NOT free.** It is a named forbidden effect in the frozen
   fixture (§2). A Chromium launched with `--remote-debugging-port=9222` inside a sandbox
   publishes a fully-privileged browser control endpoint to the internet: whoever reaches it
   can drive the browser, read cookies, and dump storage state. **BRW-002's design must
   ensure CDP never binds a reachable TCP port at all** — a pipe transport
   (`--remote-debugging-pipe`, which Playwright's own `chromium.launch()` uses) rather than a
   port. "Bind to 127.0.0.1" is NOT sufficient on its own and must be verified against this
   probe, because the edge terminates outside the guest.
2. **A concrete publishing path already exists.** `heartbeat.ts:5397-5412` scrapes ports out
   of the agent's own stdout (`extractLoopbackPreviewUrls`) and, for every port found, calls
   `emitSandboxPreviewTaskOutput` → `resolveSandboxPreviewUrl` → `getHost(port)`, persisting
   the result as a `preview_url` task output. There is **no debug/CDP port filter**.
   Chromium prints its DevTools URL on stderr by default. Boot root: `app.ts:476` →
   `issues.ts:99/1784` → `heartbeat.ts:2764` → `executeRun`.
3. **Scope beyond BRW-002.** Any sandbox service on any port is publicly reachable today.
   `preview-proxy.ts` authorizes its own path (`assertCompanyAccess`, `:116`), but the
   underlying `*.e2b.app` URL bypasses that proxy entirely — so a preview link that leaks
   (shared, logged, screenshotted) reaches the sandbox with no AoA authorization at all.
   Raised to the programme owner; not a BRW-002 deliverable.

## 2. The frozen golden-journey fixtures ARE this ticket's spec

`tests/fixtures/distributed-execution/browser-approval-download.json` and
`browser-denied-egress.json`, enumerated in `packages/sandbox-provider-contract/src/vectors.ts:16-26`.
Nobody had opened them. They carry the vocabulary BRW-002 is graded against:

- `browser-approval-download.json:222` — `"forbiddenEffects": ["public_cdp_endpoint", "cookie_in_event_payload"]`
- `:210-214` — `"cleanup": {"authority":"lease_holder", "scope":"browser_session:job_…", "idempotent":true, "deadlineMs":20000, "restoresEffectAuthority":false}` — **a frozen 20-second cleanup deadline**
- `:56-88` — step vocabulary: `launch_browser`, `request_approval`, `approve`, `download`, `complete`
- `browser-denied-egress.json` — `navigate` to `http://169.254.169.254/` must yield `network_denied`

**Trap inside the fixture.** `:154` declares `"prefix": "artifacts/job/download"`. That shape
is **rejected** by the frozen artifact protocol, which requires
`organizations/<org>/jobs/<job>/attempts/<n>/` (`artifacts.ts:76-78`, enforced at `:383-385`).
`grep -rn "artifacts/job"` finds **zero consumers**, so the fixture's key shape is decorative
and contradicts the enforced one. Designing clause (b) from the fixture emits keys the schema
refuses.

`cookie_in_event_payload` is enforced structurally by `events.ts:97-113` —
`browserObservationPayloadV1Schema` is `.strict()` with only `artifactIds | url | title`.

## 3. Cancellation: `signal()` asserts more than it delivers

`real-transport.ts:135-145` — `signal(sandboxId, _kind)` **ignores `_kind`** and returns
`{delivered:true}` on both branches, so `cancel` and `kill` are the same no-op against real
E2B. It is deliberate and commented ("E2B has no in-sandbox graceful-cancel primitive
distinct from teardown"), so the transport behaviour is a documented choice.

**The defect is at the contract seam, not in the transport.** That `delivered:true` maps to
`outcome:"stopped"` (`e2b-provider.ts:249`), and `provider.ts:57-59` defines `"stopped"` as
*"ends the process tree"*. The system therefore reports a tree-kill that provably did not
occur. Knock-on: `cleanup-authority.ts:284` enters its `kill` rung only on `ignored`, which
the real transport can never return, so that rung is **unreachable in production**.

**For BRW-002:** clause (c) must be built on `destroy`/`terminate`, never on `cancel`/`kill`,
and the kill test must be phrased "sandbox destroyed ⇒ browser + children gone", not "browser
killed". Trace/video finalisation must happen **during** the run, streamed — never on cancel.

Unverified and stated as such: that `Sandbox.kill` reaps a Chromium zygote/renderer tree is
credible by microVM construction but is proven by nothing in this worktree. Whether anything
honours the frozen `deadlineMs: 20000` is unchecked. Whether `browserSessionSlots` is
returned on cancel is unchecked (a slot leak here is the "fail-safe for execution is not
fail-safe for state" shape from prior programme work).

## 4. Nothing can run a browser job today — four independent reasons

1. **No browser in the template.** `e2b/e2b.Dockerfile` (read in full) installs
   git/curl/ripgrep/python3/build-essential + `claude`/`codex`. No Chromium, no Playwright, no
   fonts/X11/nss layer.
2. **No per-workload template selection anywhere.** `job-placement.ts:179-180` maps
   `browser.chromium` → capability `workload.browser_session`, never to a template or image.
   `resolveEnvironment` takes only companyId/environmentId. So even a perfect browser template
   would not cause a `browser_session` job to land on it. **This, not the missing browser
   layer, is BRW-002's first real problem.**
3. **No worker advertises browser capacity.** `desktop-hello.ts:146-153` sets
   `browserSessionSlots: 0`, and `job-leasing.ts:485` offers `browser_session` only when
   slots > 0.
4. **The workload never reaches the sandbox.** `supervisor.ts:196-199` (`createSpecFor`)
   probes `workload.command`/`workload.args`, which a browser workload does not have, so it
   degrades to `command: "browser_session", args: [], env: {}`. Even the seven configured
   browser fields are dropped today.

**Dormancy warning.** `createSupervisor`, `createPollLoop`, `E2bSandboxProvider`,
`createResultCommitter` and `quarantineCandidates` all have **zero production callers**.
Tests written directly against `CleanupAuthority` or the supervisor will pass and prove
nothing about a live browser. Every BRW-002 acceptance test needs a named injection point and
a stated reason it exercises the real path.

## 5. Downloads: nothing confines a sandbox file to a job by path

Two disjoint mechanisms exist and neither does what clause (b) needs. The artifact object-key
rules constrain the **destination** in object storage, not the **source** in the sandbox
filesystem. The live capture path confines by **enumeration** (`git diff` inside `remoteCwd`),
so a download written elsewhere is *invisible*, not *confined* — and it is stored under a
company+date key with no job/attempt segment.

The two path vocabularies are **incompatible with no adapter**: `isSafeWorkspacePath` rejects
any leading `/` (`artifacts.ts:53`), while every in-sandbox path is absolute. There is **no
download-directory concept anywhere in the repository**.

**Naming-collision trap:** `artifactDownloadGrantV1Schema` (`artifacts.ts:431`) is about the
worker *pulling an artifact out of object storage* — NOT about Chromium saving a file from a
website. Clause (b) means the latter. Anyone who greps "download", lands there, and declares
the clause satisfied will have secured the wrong direction. The relevant mechanism is
`artifactTransferGrantRequestV1Schema` (`:364-391`), plus `quarantine.ts:105-120`, whose
`QuarantineArtifact.kind` union already includes `"download"` for the orphan path.

## 6. DESIGN-BLOCKED: a browser cannot obey AoA's egress control

Not BRW-002's acceptance clause — BRW-004 owns "allowed domains … enforced" — but recorded
here because it may determine BRW-002's substrate, and `browser-denied-egress.json` grades a
browser journey on egress denial.

The only enforcement AoA has is the DAT-005 proxy, and three properties collide:

1. **Inert.** `egress-proxy.ts:3` — "inert-until-wired"; `:24-26` — the live request channel
   is a seam wired at **E4-D12**, default dispatcher fails closed.
2. **Wrong shape.** It is per-request, handle-bound and single-destination (`:15-17`, "a
   handle bound to destination X can never be used to reach host Y"). A browser emits raw DNS
   and TCP to hosts it discovers at runtime, with no handle and no pre-declared destination.
   A model mismatch, not a plumbing gap.
3. **Unreachable through the frozen schema.** `--proxy-server` needs launch args;
   `browserWorkloadV1Schema` has seven fields, no proxy and no args — and `createSpecFor`
   drops args anyway (§4.4).

**Decision (programme owner, 2026-08-23):** BRW-002 proceeds with its three sandbox-local
clauses. The egress mismatch is written up as a named blocker on **BRW-004** with the
substrate options costed. Recorded so BRW-002 does not silently assume a substrate BRW-004
later invalidates.

## 7. Claims that did not survive — recorded because the errors are instructive

| # | Claim | Verdict | What was actually wrong |
|---|---|---|---|
| 1 | No port-exposure op ⇒ CDP unreachable | **REFUTED** | Premise true, inference invalid. Measured false (§1). |
| 2 | Cancel kills the tree by construction | **REFUTED** | `signal` is a no-op that reports `stopped` (§3). |
| 3 | Task definition must come via configArtifactId/workspace/control_command | **PARTIAL** | Omitted a 4th channel — the bounded `extensions` container is on the browser envelope and a non-critical extension carries arbitrary JSON. All three named channels are inert in the only producer. |
| 4 | Template has no Chromium ⇒ add a layer | **PARTIAL** | Factually right; but the pinned `aoa-base` in `capability-matrix.ts:63` has **zero production constructors**, so a layer added there changes nothing that runs. The live template comes from the environments row. |
| 5 | Must build a test site into D1 | **PARTIAL** | Test site: yes. D1 topology: **no** — D1/D3 lane work is BRW-005's by three documents including BRW-001's own result doc. "Local" permits an in-sandbox HTTP server. |

**A methodological defect that invalidated grep-based absence claims.**
`packages/worker-daemon/src/supervisor/provider.ts` contains a **raw NUL byte** at line 126 —
`].join("<0x00>")`, a literal control byte where `"\0"` was meant. Verified directly: one NUL;
`file` reports the source as `data`; grep suppresses the entire file. Every negative grep over
`packages/worker-daemon/src` in this analysis was unsound. **Use `grep -a` for repo-wide
absence claims.** Three other tracked files share the defect
(`scripts/lib/__tests__/embedded-secret-scan.test.mjs:131`,
`server/src/services/asset-content-guard.ts:77`, `server/src/services/mcp-connectors.ts:563`).

## 8. What BRW-002's design must therefore settle

1. CDP over a **pipe**, never a TCP port — with a guard, and verified against the §1 probe.
2. A **template-selection mechanism** for browser workloads (§4.2) — the actual first problem.
3. Carry the seven browser config fields into the sandbox spec (§4.4 shows they are dropped).
4. A **per-job download root** that is the browser's only sink, plus the missing
   absolute↔relative sandbox-path adapter (§5).
5. Clause (c) on `destroy`, with the kill test phrased as sandbox teardown (§3).
6. A deterministic local site — in-sandbox server, **not** a D1 compose service (§7 row 5).
7. `/dev/shm` sizing: Chromium's default-64MB crash mode is unprovisioned anywhere.
