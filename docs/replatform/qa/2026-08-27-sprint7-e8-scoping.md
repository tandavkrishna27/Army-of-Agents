# Sprint 7 (E8 browser agents) — terrain audit + next-unit scoping

**Date:** 2026-08-27 · **Worktree:** `C:\e3` · **Branch:** `docs/replatform-program` · **Tip:** `dab65f289`
**Mode:** read-only audit. No source edited, no skill run, no commit.
**Purpose:** map E8's CURRENT state at tip, judge the "host-side browser spawn" security item,
and identify the genuine next buildable unit NOT already owned by the parallel Lane B (`C:\e8`) effort.

---

## TL;DR (the three verdicts the orchestrator needs)

1. **The security item is LIVE, the clause is FALSE-in-fact, and it is UNCOVERED.**
   `server/src/services/internal-agent/cli-mode.ts:347-353` still adds a host-side
   `npx @playwright/mcp@0.0.75 --headless` stdio spawn to the MCP config whenever `browser_use`
   is enabled, and it is reachable from three non-brokered boot roots (heartbeat, crew, Commander).
   The E8 exit-gate condition *"no host-side browser spawn reachable from a boot root"* is therefore
   currently violated. Nothing lies about it (E8 is `backlog`, no result doc claims it) — but nothing
   **tests** it either: there is no gate-clause-wiring entry for the negative clause, and
   `check-browser-suite-executed.mjs` only proves a positive browser suite ran. It is green-by-absence.

2. **Almost all of "Sprint 7" as the go-book §4 framed it is NOT owned by Lane B — it is unbuilt.**
   Lane B shipped BRW-001, 002, 003a, 003b, 003d-1..5 (all with result docs). **BRW-003c is design-only
   (open, but Lane-A-blocked). BRW-004, 005, 006, 007, 008 have no design, no terrain, no result — they
   do not exist as tickets on disk.** BRW-008 is the ticket that nominally owns the security fix; it is
   the LAST node in a 4-deep dependency chain (`BRW-004 → BRW-006 → BRW-007 → BRW-008`), none of which
   is started.

3. **The clean, session-buildable, unowned first unit is the anti-vacuity guard, NOT the fix.**
   Closing the spawn (BRW-008's outcome) needs the whole governed browser path to work end-to-end on
   live E2B/Chromium — not session-buildable, and deliberately deferred by the scope-addendum ("retire
   once the governed path is proven, not before"). What IS session-buildable now, mutation-testable, and
   collides with nothing Lane B has touched: **the boot-root anti-orphan guard + a negative gate-clause
   register entry that makes the false clause catchable instead of green-by-absence** — shipped in the
   trackable-strict / owned-deferral form (the REL-FOUNDATION-GATE unit-1 precedent) so it is green-at-rest
   while the debt becomes machine-tracked and regression-proof.

---

## (a) E8 shipped-vs-open map

### Shipped by Lane B (`C:\e8`, merged onto this shared branch; all have result docs)

| Ticket | Headline (from result doc) | Kind |
|---|---|---|
| **BRW-001** | Browser-session job/policy fields already in frozen v1; real fix was `buildJobEnvelope` passing an untyped blob → no lease. `tickets/BRW-001-result.md` | shipped |
| **BRW-002** | `packages/browser-runtime` — the sandbox-local Playwright runtime leaf package (containment + teardown clauses, CI-green). `tickets/BRW-002-result.md` | shipped (but **zero importers** — see below) |
| **BRW-003a** | Split `findCommitted` into two predicates for artifact-transfer-grant's opposite callers. `tickets/BRW-003a-result.md` | shipped |
| **BRW-003b** | Capture producer half: video/trace; guards a hung worker (video drains only on context close). `tickets/BRW-003b-result.md` | shipped |
| **BRW-003d-1** | Payload bounding (request side): `express.json()` had no `limit` vs frozen 4 MiB descriptors. `tickets/BRW-003d-1-result.md` | shipped |
| **BRW-003d-2** | Redaction: fixed a live leak — a secret in an **array element** was never redacted. `tickets/BRW-003d-2-result.md` | shipped |
| **BRW-003d-3** | Stream metadata: the `extensions` channel was dead at both ends; wired producer + reader. `tickets/BRW-003d-3-result.md` | shipped |
| **BRW-003d-4** | Ordering tied to event sequence + response-side bounding; reframed to ordering the events read. `tickets/BRW-003d-4-result.md` | shipped |
| **BRW-003d-5** | Grant-time byte ceiling + closed a live false claim of enforcement (grant enforced nothing). `tickets/BRW-003d-5-result.md` | shipped |

### Open / not owned

| Ticket | State | Notes |
|---|---|---|
| **BRW-003c** (retention enforcement) | **design-only, no result** | `tickets/BRW-003c-design.md` records TWO hard blockers: (1) **Lane A's `isSweepEligible` edit must land first** — else every expiry becomes a permanent actionable false alarm (`artifact-orphan-sweep.ts:56-63`); (2) 003a must be merged with mutation tests killed (003a IS merged). Genuinely open but **cross-lane-coupled to Lane A**. |
| **BRW-004** (credential/approval path) | **nonexistent on disk** | go-book §4 calls it "dependency-ready". No design/terrain/result. |
| **BRW-005** | **nonexistent** | — |
| **BRW-006** | **nonexistent** | README:4 — additionally requires `E10-REALTIME-FOUNDATION` (durable evidence sequence). |
| **BRW-007** (agent-facing browser-request tool) | **scoped only** in `scope-addendum-agent-and-commander.md §46-65`; no design/result | Depends on BRW-002, BRW-004, BRW-006. |
| **BRW-008** (Commander→governed path; retire host spawn; anti-orphan check) | **scoped only** in scope-addendum §67-82; no design/result, **no dependency-graph node** (go-book §4 line 848) | Depends on BRW-007. This is the ticket that owns the security fix. |

### E8 findings.md and gate-clause register

- **No `findings.md` exists in the E8 epic dir.** (The programme's cross-cutting finding
  `docs/replatform/FINDING-retention-authority-and-DE-11.md` touches retention/BRW-003c but is not an
  E8 findings ledger.)
- **`scripts/gate-clause-wiring.json` has exactly ONE E8 entry:** `E8-1-sandbox-local-browser`,
  symbol `runBrowserSession`, status **`unwired`**, `expectedReferences: 1`, reason: *"packages/browser-runtime
  has zero importers and is in no dependency list … the capability is unreachable despite the non-zero count.
  Blocked on dispatch (Sprint 3) then BRW-004+ (Sprint 7)."* — This entry is HONEST and current.
- **There is NO register entry for the negative clause** "no host-side browser spawn reachable from a boot
  root." The register's contract (`$comment`) is positive-only ("a production path reaches the named symbol;
  fails on 0"). The negative clause has no home, so `check-gate-clause-wiring.mjs` cannot evaluate it.

---

## (b) Security-item verdict (live / clause / covered)

### LIVE — yes, verified from source at tip

`buildMcpConfig` (`cli-mode.ts:330`) adds, **unconditionally on `browser_use`** and **independent of the
`brokered` flag**:

```
cli-mode.ts:347   if (params.enabledCapabilities?.includes("browser_use")) {
cli-mode.ts:348     reserved.playwright = {
cli-mode.ts:349       command: "npx",
cli-mode.ts:350       args: [PLAYWRIGHT_MCP_PACKAGE, "--headless"],   // "@playwright/mcp@0.0.75"
cli-mode.ts:351       env: {},
cli-mode.ts:352     };
```

**Callers reachable from boot/heartbeat/crew/Commander roots** (all resolve `buildMcpConfig` and write the
config to a temp file the CLI reads):

- `server/src/services/heartbeat-mcp.ts:165` — **org-agent heartbeat root** (non-brokered by default).
- `server/src/services/internal-agent/aoa-agents/runner.ts:795` — **crew (`kind='aoa'`) root**
  (`runner.ts:736`: `mcpParams.brokered = acquired.sandbox?.environment.driver === "sandbox"` — brokered only
  when an E2B/sandbox environment is acquired; `E2bSandboxProvider` is `unwired` in every shipped boot per
  the register's `E7-1` entry, so in practice **non-brokered**).
- `server/src/services/internal-agent/cli-mode.ts:607` — Commander host path.
- `server/src/services/internal-agent/commander-sandbox.ts:444` (brokered:true, `cli-mode.ts:1113`).

**Why `brokered` does not save it:** brokered only switches the `aoa` entry between the stdio bridge and the
HTTP broker (`cli-mode.ts:339-345`). The `playwright` entry is emitted the same way in both cases and is
never routed to a governed `browser_session` job. So in the shipped default (non-brokered) the claude CLI
runs **on the host**, reads the config, and spawns Chromium **on the host** — an unsandboxed browser with no
tenant boundary, no evidence capture, no approval gate, no credential brokering, no cancellation. The
scope-addendum §26-34 names this exactly: *"two browser mechanisms coexist — one governed, one not — sharing
the reserved `playwright` MCP name, with the ungoverned one being the easier to reach by accident."*
`packages/browser-runtime` (BRW-002's governed runtime) still has **zero importers** (confirmed:
`grep runBrowserSession|browser-runtime` over `server/`+`packages/` outside the package = 0 hits), so the
governed path is not staged and cannot displace the host spawn.

*(Minor doc-drift found in passing: `cli-mode.ts:206` says the brokered flag has "no call site yet (S7/U4)";
`cli-mode.ts:1113`, `runner.ts:736`, and the heartbeat path all set it now. Not a defect — a stale comment.)*

### CLAUSE — false-in-fact, but not falsely claimed

- E8 `README.md:7` (exit gate) **requires** "…no host-side browser spawn reachable from a boot root." E8 is
  `Status: backlog`; no result doc asserts the condition holds. So the gate is **not** lying — the condition
  is simply a not-yet-met exit requirement that is **currently violated** by the spawn above.
- The go-book §4 (lines 762-772, **terrain-verified 2026-08-27**) states the same: *"That is false today …
  the 'no host-side spawn' clause has zero automated coverage … green-by-absence while false."*

### COVERED — no

- `scripts/check-browser-suite-executed.mjs` only proves the **positive** browser lane executed (the two
  files `browser-containment.browser.test.ts` + `browser-teardown.browser.test.ts` each contributed a passing
  test). It says nothing about the **absence** of a host-side spawn. Runs in `pr.yml` `policy` (line 352, its
  own test) — but it is the wrong guard for this clause.
- `server/src/__tests__/commander-browser-use.test.ts:21-29` asserts the **opposite** of what we want: it
  locks in that `browser_use` ⇒ a `playwright` entry with `command:"npx"`, args containing the package +
  `--headless`. It codifies the host spawn as intended behavior.
- **No anti-orphan / boot-root guard for the browser spawn exists.** (`scripts/check-boot-roots-provider-free.mjs`
  is the analogous guard, but for the *worker provider*, not the browser.)

**Net:** LIVE · clause FALSE-in-fact (violated, not mis-claimed) · UNCOVERED (no negative gate-clause entry,
no anti-orphan check; the one on-point test enforces the spawn's presence).

---

## (c) Ranked next-buildable-unowned units

### #1 — Anti-orphan guard + negative gate-clause entry for the host-side browser spawn  ★ RECOMMENDED

**Kind:** anti-vacuity guard (+ a docs/clause rewrite). **Session-buildable:** yes. **Live infra:** none.
**Owned by Lane B:** no — BRW-008 nominally owns it but has no node, no design, no result, and is chain-blocked
on BRW-004/006/007.

Build a `scripts/check-no-host-browser-spawn.mjs` that mirrors the established
`check-boot-roots-provider-free.mjs` pattern: enumerate the roots that reach `buildMcpConfig`
(heartbeat-mcp, aoa-agents/runner, cli-mode, commander-sandbox), and assert the declared property — that a
host-side `PLAYWRIGHT_MCP_PACKAGE`/`npx` stdio entry is either **absent** or declared as a **known, owned,
deferred exception** in an expectation JSON (owner: BRW-008; reason: scope-addendum §36-42, "retire once the
governed path is proven"). Because the spawn IS reachable today, ship it in the **trackable-strict /
owned-deferral form** — the exact REL-FOUNDATION-GATE unit-1 precedent (go-book §4 lines 806-819): 0-error at
rest (the one known spawn is a declared deferral), so `ci-required`/`policy` stays green, while any **new**
host-side browser spawn, or removal of the deferral's owner without removing the spawn, trips the guard. Pair
it with either a negative-clause entry in `gate-clause-wiring.json` (or a sibling register) so the
green-by-absence hole the go-book names is closed, and rewrite E8 `README.md:7` from an absolute to a
deferred-with-owner clause. **Fail-first + mutation:** fixture tree with a boot-root→buildMcpConfig→playwright
edge must be detected; remove the edge and the guard must stop flagging (proves it traces reachability, not
text); prove green-at-rest against the real tree with the BRW-008 deferral present. This discharges the
go-book's *"Either close it or rewrite the clause"* on the "rewrite + guard" branch — the only branch that is
session-buildable — and closes the "zero automated coverage" defect the go-book flags as *a live security item*.
It matches this programme's own highest-value work class (`checks-that-nothing-runs`; the REL-004 anti-orphan
directory-walk precedent).

### #2 — BRW-003c: retention enforcement (implementation)

**Kind:** feature/security (credential-bearing artifact TTL). **Session-buildable:** in principle yes (a pure
policy over `CREDENTIAL_BEARING_ARTIFACT_KINDS` + TTL in `browser-artifact-retention.ts`). **Live infra:** none.
**Owned by Lane B:** design authored by Lane B but **no result** — implementation is open. **Coordination risk:
HIGH** — `BRW-003c-design.md` records a hard blocker that **Lane A's `isSweepEligible` edit must land first**,
or every successful expiry becomes a permanent actionable false alarm (`artifact-orphan-sweep.ts:56-63`).
Verify that Lane A edit is at tip before starting; otherwise this unit is not cleanly independent and will
ship an alarm generator wearing retention's name. Rank below #1 purely on that coupling.

### #3 — BRW-004: browser credential/approval path

**Kind:** feature. **Session-buildable:** partially — the approval command/ACK semantics (via PRT-007),
fence-bound materialization, and redaction have a session-buildable core proven by planted-leak tests (the
DAT-008 / E5-5 precedent), with the live-sandbox authentication residual deferred. **Owned by Lane B:** this is
the **canonical next Lane B ticket** ("dependency-ready", go-book §4). **Coordination risk: HIGH** — building
it in `C:\e3` directly collides with Lane B's E8 track if that track resumes; its full acceptance also needs
the governed browser path live. Leave for Lane B.

### #4 — BRW-005 / 006 / 007 / 008 full features

**Kind:** feature + the security fix's true home (BRW-008). **Session-buildable:** no — acceptance requires a
working sandboxed browser session end-to-end on live E2B/Chromium (BRW-006 additionally needs
`E10-REALTIME-FOUNDATION`), which is exactly the live-infra class this programme defers (the §2.4 STOP trap
against absent workloads; E7-1 unwired). Not attemptable this session.

---

## (d) Recommendation + coordination risk

**Build unit #1 first: the boot-root anti-orphan guard + negative gate-clause entry + clause rewrite, in the
trackable-strict owned-deferral form.**

**Why it is the right first unit.** It is the single half of the flagged security item that is genuinely
session-buildable (pure static reachability analysis, fail-first + mutation-testable, no live browser/E2B).
It directly closes the specific defect the go-book calls *"a live security item"* with *"zero automated
coverage."* It is genuinely unowned: BRW-008 has no node, no design, no result, and sits behind
BRW-004→006→007, so the guard collides with **nothing** Lane B has on disk (Lane B never touched the
`cli-mode.ts` spawn, and the only related test enforces the spawn's presence rather than guarding it).
Crucially, building the guard does **not** require closing the spawn — the scope-addendum explicitly forbids
retiring the host path before the governed path is proven — so the guard makes the debt visible and
regression-proof **without** violating that decision and **without** reddening the green gate (owned-deferral,
green-at-rest). It converts the go-book's honest-but-uncaught note into a machine-tracked, catchable
invariant: the moment anyone claims E8 done, adds a second host-side browser spawn, or removes BRW-008's
deferral without removing the spawn, CI reddens.

**Explicitly rejected as first unit:** "close the host-side spawn" (BRW-008's outcome half) — not
session-buildable and forbidden-before-governed-path by scope-addendum §36-42; and BRW-004 — Lane B's owned
next ticket, high collision, needs live infra for acceptance.

**Coordination risk.**
- **Authorship is shared.** Both the E8/Lane-B commits and the tip rel-003 commits are authored by `TK` on
  the SAME branch `docs/replatform-program`; "Lane B (`C:\e8`)" is a worktree/effort label, not a separate
  committer. Two worktrees writing the same branch is the real collision surface.
- **Lane B's E8 track appears PAUSED at tip.** Last E8/BRW commit: `8c2cfc3ed` (2026-08-25, "fix(BRW): the
  teardown tests navigated to a fixture whose name lied"). Every commit from 2026-08-27 (up to tip
  `dab65f289`) is **rel-003 / Sprint-9 DR-rehearsal**, a different epic. So E8 is not being actively pushed
  right now — a low-collision window for unit #1.
- **What would collide if the orchestrator drafts a "real" Sprint-7 feature now:** BRW-004 and BRW-003c.
  BRW-004 is Lane B's declared next E8 ticket; BRW-003c is Lane B's open design and is additionally
  Lane-A-coupled. Unit #1 touches only `scripts/` + a new expectation JSON + `cli-mode.ts` comment/README
  wording — **no overlap** with any in-flight or scoped BRW file. If Lane B later writes BRW-008, the guard
  becomes its ready-made anti-orphan check (the addendum's acceptance already names exactly this guard), so
  #1 is an **enabler** for BRW-008, not a duplicate of it.

**Bottom line on the Sprint-7 framing:** the go-book §4 "Sprint 7 = BRW-004/5/6 (+007/008)" is NOT already
shipped by Lane B — those tickets are unbuilt — but its *feature* units are either Lane-B-owned-next (BRW-004),
Lane-A-coupled (BRW-003c), or live-infra-gated (BRW-005/6/7/8). The one clean, unowned, session-buildable unit
that advances Sprint 7 today is the anti-vacuity guard for the host-side browser spawn. That is a valid and
important scoping outcome: **do the guard, not the feature.**
