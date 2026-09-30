# Universe — engineering gate disposition

**Historical evidence note (independent review):** source revisions below identify the investigation when recorded. The current reviewed source pin is `183e46a9c65fc3105c7e3d125629276814df7dbb`; use symbols plus that base for implementation binding, and refresh changed files before coding. Historical checks are not new qualification runs. See [current bindings](implementation-bindings.md) and [review response](independent-review-response.md).

Latest follow-up: the [readiness review](readiness-review.md) checks replatform at `f09230f3e331c5156eacfe8396755e2911e2152b`. It retains Commander and Browser Use qualification gates and adds the newer cloud tier ruling, credential-boundary verification, browser approval/recovery and sensitive-profile evidence requirements. The September 11 policy ruling is not proof of egress enforcement; the source inspection below is an earlier snapshot, not the latest release verdict.

September 11, 2026. Source inspection at replatform `72479410be1e7a3ff4c55eaf5942c27f87144490`; no runtime deployment or provider qualification performed. This closes the investigation pass, not the implementation gates.

## Browser automation and streaming

**Finding:** Browser Use is not a drop-in attachment to the current replatform driver. Its documented browser connections use CDP URLs. Replatform `packages/browser-runtime/src/launch-guard.ts` rejects caller-supplied debugging ports and remote endpoint settings; the current driver uses a Playwright-managed pipe. Preserve that guard. An ungoverned browser launched by another library must not bypass it.

**Cloud recommendation:** qualify E2B Desktop's authenticated, window-scoped streaming in a dedicated headed browser environment. The official SDK documents one active stream at a time and whole-desktop capture when a window is not selected. Therefore require explicit browser-window selection and session isolation; do not assume one sandbox can supply multiple independent simultaneous window streams. The existing headless guest requires image/runtime work. Stream authentication does not by itself implement AoA controller fencing.

**Local recommendation:** implement a worker-owned browser capture/input adapter behind the shared session protocol. A pipe-connected Chromium session can be investigated for page capture/input without a public debugger port; this is an engineering candidate, not a verified Browser Use transport. Qualify tab content, browser chrome, native dialogs and audio separately. Outbound authorized media/input relay and session epochs remain required.

**Browser Use integration gate:** choose and prove an internal transport bridge or separately contained adapter compatible with the launch/isolation policy. First produce a minimal compatibility test that launches through approved containment, attaches automation, streams an authorized view, pauses and rejects stale input, then resumes after re-observation. If the selected library cannot satisfy this boundary, bring an explicit adapter redesign recommendation; do not silently switch providers or weaken guards. No evidence from this review proves a pipe bridge already exists.

Acceptance: both local and cloud tests demonstrate unauthorized attachment denial, no public debugging endpoint, acknowledged takeover, stale-command rejection, correct session on reconnect, downloadable artifacts and truthful capability declarations. Browser tasks cannot be marked integrated merely because a live URL renders.

Sources checked:
- [Browser Use CLI connection documentation](https://docs.browser-use.com/open-source/browser-use-cli)
- [Browser Use browser session implementation](https://github.com/browser-use/browser-use/blob/main/browser_use/browser/session.py)
- [E2B Desktop streaming SDK examples](https://github.com/e2b-dev/desktop)

## Commander routing

**Finding:** current `cli-mode.ts` imports the Commander sandbox adapter and records distributed shadow observations; shadow is not distributed ownership transfer. Replatform's current E10 findings still identify open non-task routing, per-user credential and interactive result-path dependencies for Commander. The mint runner's agent-binding interface also means ordinary agent credential handling cannot simply be assumed to cover Commander.

**Recommendation:** Universe binds to the existing Commander service and durable submission identity, with an explicit execution capability supplied by the accepted replatform revision. Typed and voice requests use the same service. Preserve current admitted execution paths during development; do not advertise unimplemented placement or route around missing authorization with a company key. Distributed acceptance is gated on replatform implementing its own routing, user credential and result-return seams.

**Ownership:** the upstream findings currently state no assigned owner for the shared prerequisite work. Record this as an unassigned replatform dependency, not an invented ticket or implied commitment. Universe owns selected context, the read-only request lookup, payload fingerprint validation, presentation and voice adaptation. Replatform owns canonical execution ownership, credential eligibility and result projection.

Acceptance: loss of acknowledgement produces one canonical execution; the interactive result reaches the originating conversation; cancellation follows canonical ownership; selected placement actually executes on that target; another user's credential is never substituted. Require production callers and integration evidence, not only types or shadow fixtures.

## Effect on planning

| Work | Disposition |
|---|---|
| Canvas UI design, layout/drafts, manual upload and reviewed blocks | Continue planning independently. UI implementation follows design review. |
| Voice context/service integration | Detailed plan can use existing authorized Commander boundary; distributed placement remains gated. |
| Cloud/local streaming and Browser Use attachment | Separate compatibility implementation deliverable before committing final transport-specific coding plans. |
| Distributed Commander release acceptance | Blocked on the explicit upstream routing/credential/result dependencies. |

Recommended release grouping remains staged integration milestones, with all requested providers and local/cloud browsing retained in scope. No public version allocation is finalized. There is no new product question from this inspection; engineering compatibility evidence and upstream ownership are the next prerequisites, not another library preference question.

## Verification limits

Read current branch source, the E10 findings, and official upstream documentation. No cloud resources were provisioned, no runtime code changed, and no compatibility test was executed. This report makes the remaining work concrete rather than claiming the gates are resolved by documentation.
