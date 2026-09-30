# Independent codex review — 2026-08-25

> Verbatim final report from an independent `codex exec` review (codex-cli 0.144.1), run read-only
> over the go-book, the three Sprint 1-3 plans, the findings registers and the source they cite.
> It ran AFTER two in-house adversarial review rounds had already passed over the same documents.
>
> **Kept verbatim.** Every claim below was then re-verified against the code by opening the cited
> lines; the outcome of that verification is recorded in
> `2026-08-25-codex-review-verification.md`. Nothing here has been edited to match the result.

---

## CONFIRMED — C1–C10

- **C1 — VERIFIED.** WRK-010’s table at `WRK-010-design.md:273-297` matches the implementation: replay protection at `worker-session-auth.ts:147-155`; current authority, status, membership, generation, organization, scope and key checks at `:156-167`; shared-platform checks at `:186-197`. Identity is partial because `workerId` and `targetId` are query keys at `packages/db/src/repositories/tenant/worker-enrollment.ts:365-368`, not independently compared.

- **C2 — VERIFIED.** `worker-operation-proof.ts:50` explicitly denies `organizationId === null` or `scope === "platform"`. `worker-session-auth.ts:180-182` instead sends a null-organization claim through the operator repository and returns its principal. WRK-010 preserves the denial as R1 at `WRK-010-design.md:375-382`.

- **C3 — VERIFIED, for a successful normal desktop boot.** `desktop-host.ts:114-125` constructs both stores and `:254-260` passes both to bootstrap. `device-identity-store.ts:107-114` requires both under `os_keychain`; `:116-133` rejects either store under `mounted_secret`. Bootstrap performs this check before opening the socket at `worker-daemon.ts:203-217` and enters enrollment at `:267-284`.

- **C4 — FALSE.** The table at `WRK-008-slice-2b-design.md:205-212` lists six gates. Row 3 is satisfied only on desktop, so the table describes six outstanding conditions for container and five for desktop. The claimed four/three at `:214-216` comes from a separate four-item “changes somebody lands” subset that deliberately omits live session and self-model; it is not the arithmetic of the stated gate list.

- **C5 — VERIFIED; it is 100%, not merely “effectively all.”** `poll-loop.ts:533-540` invokes the self-check before ACK or handoff. The matcher requires `workload.<type>` at `worker-protocol/src/capabilities.ts:477-486`. The sole production builder call is `enroll-once.ts:255`; its builder emits only isolation `sandbox.*` capabilities at `desktop-hello.ts:128-144`, whose possible values are listed at `isolation-capabilities.ts:49-53`. Therefore no production hello can satisfy the workload-capability check.

- **C6 — VERIFIED.** `SessionStore.ensureFresh` returns every unexpired session and refreshes only when null/expired at `session.ts:92-106`. The authenticator rejects `exp <= now` at `worker-session-auth.ts:98-101`. Today’s route-backed thunk would fire after its bearer was unusable.

- **C7 — VERIFIED.** `Enroller.renew` calls the same `submit` with the retained idempotency key at `enroll.ts:228-234`; `submit` posts to `client.enroll` with the enrollment code at `:169-176`. The server rejects a lapsed code route at `worker-enrollment.ts:290-296`; TTLs are ten and fifteen minutes at `:22-23`.

- **C8 — VERIFIED for a `wired` entry.** After declaration/symbol validation, the wired branch reads only caller count at `gate-clause-wiring.mjs:75-88`. `reason` is consulted only for `unwired` at `:90-105`.

- **C9 — VERIFIED.** Missing declarations produce `undeclared_finding` at `finding-ownership.mjs:83-90`; declarations whose finding is no longer open produce `stale_declaration` at `:130-135`. Both focused test suites passed.

- **C10 — VERIFIED for workflow wiring.** `policy` has no `needs: changes` and is only draft-guarded at `pr.yml:124-126`. `ci-required` takes all lanes in `needs` at `:1294-1296`, imports their `needs.*.result` values at `:1301-1319`, and computes the verdict at `:1323-1362`. The repository states that only this job is branch-protected at `pr.yml:1192-1197` and `CLAUDE.md:320-329`; actual GitHub branch-protection settings are external and cannot be independently established from files.

## A. False claims against code

1. **WRK-008 cannot lazily bootstrap a session through the new renewal route.**

   - Document: `WRK-008-slice-2b-design.md:368-376` constructs `SessionStore(..., initial = null)` and says device-proof renewal over a live session produces the first session; `:460-461` claims, “The session is minted lazily, on first ensureFresh().”
   - Code: `enroll-once.ts:310` discards the enrollment session. A null store calls its zero-argument renewal dependency at `session.ts:103-106,125-131`. The proposed route’s authenticator requires an existing Bearer session at `worker-session-auth.ts:117-127`; transport requests likewise require `sessionToken` at `transport/client.ts:138-142`.
   - Consequence: the first `ensureFresh()` has no bearer with which to call the route. Self-model read and all Sprint 3 runtime composition remain unreachable unless Slice 2 adds a distinct initial-session acquisition or safely threads the enrollment response.

2. **“Sprint 3 — dispatch goes LIVE / first real job” is false.**

   - Document: `GO-BOOK.md:171-175`.
   - Code: the production hello can never satisfy the matcher, as shown by `desktop-hello.ts:128-144`, `capabilities.ts:477-486`, and `poll-loop.ts:533-540`.
   - Consequence: Sprint 3 composes dispatch machinery but executes zero jobs. The plan itself admits this later at `GO-BOOK.md:375-382`; the sprint headline and milestone remain false.

3. **GO-BOOK falsely says the authenticator performs “all ten.”**

   - Document: `GO-BOOK.md:283-285`.
   - Code: `findSessionAuthority` uses the claimed worker/target IDs as query predicates at `worker-enrollment.ts:365-368`; there is no independent comparison. WRK-010 correctly calls this nine full plus identity partial at `WRK-010-design.md:297-302`.
   - Consequence: the operator summary overstates enforcement, although the two missing identity arms are tautological under the current query shape.

4. **GO-BOOK falsely describes finding ownership as requiring an owner.**

   - Document: `GO-BOOK.md:509-513` says the guard fails when “an open finding has no owner.”
   - Code: `finding-ownership.mjs:127` accepts `status: "unowned"`; the current checker is green while printing `E4-F010` as unowned.
   - Consequence: an open HIGH finding can remain ownerless indefinitely while the claimed enforcement stays green.

5. **The four/three-gate statements are false as complete dispatch conditions.**

   - Documents: `WRK-008-slice-2b-design.md:214-231`, `GO-BOOK.md:229-238`, and `DEP-010-design.md:627-630`.
   - Code/plan table: the same WRK plan lists session and self-model as gates 5 and 6 at `WRK-008-slice-2b-design.md:211-212`; E4-F010 independently prevents every offer.
   - Consequence: operators are told desktops are only provider/flag/outbox configuration away from live leases when additional authority, placement, and matchability work remains.

## B. Acceptance clauses that can go green vacuously

1. **The Sprint 3 session positive control proves an impossible fake, not the production route.**

   - Document: `WRK-008-slice-2b-design.md:648-660` injects code-replay and device-proof fakes and asserts the first `get()` returns a live session.
   - Code: production starts with no session, while the route requires one, as above.
   - Consequence: all downstream self-model, runtime, and outbox acceptance tests can pass using a fake that ignores the production route’s live-bearer precondition.

2. **E4-2 “supervises only sandboxes” is vacuously promoted over zero production handoffs.**

   - Document: `WRK-008-slice-2b-design.md:1106-1110` and `:1202-1204` mark E4-2 `wired` and “true without qualification.”
   - Code: `poll-loop.ts:538-540` rejects every production offer before ACK/handoff; the supervisor is reached only after ACK at `:549-559`. The plan’s own runtime test explicitly expects `offerSatisfiesWorker === false` at `WRK-008-slice-2b-design.md:833-840`.
   - Consequence: the E4 exit clause turns green while production supervises zero sandboxes. Caller-count enforcement cannot catch this; its own implementation warns that a positive count is necessary but insufficient at `check-gate-clause-wiring.mjs:56-64`.

3. **The D1 “all four gates are attributable” checker misses its named provider transition.**

   - Document: Step 9a says the checker only parses `docker-compose.d1.yml` at `WRK-008-slice-2b-design.md:1011-1013`; it declares `AOA_WORKER_PROVIDER_URL` “present and dead” at `:1037-1045`, then acceptance claims any four-gate change is caught at `:1189`.
   - Source: the variable currently appears only at `docker-compose.d1.yml:304,343`.
   - Consequence: a conditional container resolver can begin reading that already-present value with no compose change. Step 9a still sees its expected bytes, while Step 9b’s weaker property—no unconditional provider and default resolving to none at `:1048-1056`—can also remain green.

## C. Cross-sprint seam defects

1. **Sprint 2.5 and Sprint 3 both claim ownership of the same production seam.**

   - WRK-010 assigns “wiring `SessionStoreDeps.renew`” to Slice 2 at `WRK-010-design.md:1024-1029`.
   - WRK-008 says the zero-argument seam is 2b’s work at `WRK-008-slice-2b-design.md:334-337`, and implements it in Step 2 at `:628-642`.
   - GO-BOOK nevertheless requires Slice 2.5 to have a production caller and a composed T0+15 test before Sprint 3 starts at `GO-BOOK.md:339-356`.
   - Current code has no production `new SessionStore`, `createSessionProvider`, `createPollLoop`, or `createSupervisor` caller.
   - Consequence: the stated order is cyclic. Slice 2.5 cannot meet its Done condition unless it takes production identity/store wiring away from Sprint 3; otherwise the route still has zero callers when Sprint 2.5 is declared green.

2. **The seam’s signature/initial state does not match route authentication.**

   - Consumer shape: `SessionStoreDeps.renew: () => Promise<WorkerSession>` at `session.ts:50-55`, invoked without the current session at `:125-131`.
   - Producer requirement: the route authenticator requires `authorization: Bearer <live session>` at `worker-session-auth.ts:117-127`.
   - Plan shape: direct handoff `renewSession` → `SessionStoreDeps.renew`, with `initial = null`, at `WRK-008-slice-2b-design.md:628-642`.
   - Consequence: Slice 2 must change the dependency contract or explicitly close over/expose the current session, and separately solve initial acquisition. “Swapping the body changes nothing else” is not true as written.

The DEP-010 → WRK-008 provider names and public-surface handoff were checked and are synchronized: WRK explicitly accounts for `AOA_WORKER_SANDBOX_PROVIDER`, `AOA_WORKER_E2B_TEMPLATE`, and the public dispatch test at `WRK-008-slice-2b-design.md:557-574`.

## D. Work assigned to nobody

- **E4-F010 remains explicitly unowned**, despite blocking every real job and Sprint 5: `GO-BOOK.md:247-257`; `scripts/finding-ownership.json:51-53`. No sprint before Sprint 5 owns either the profile-snapshot update channel or the matchable production hello.

- **E4-F008 and E4-F009 become zombie ownership claims.** The manifest assigns both to WRK-008 at `finding-ownership.json:9-13,45-49`; the plan says F008 survives and should be re-pointed at a future refresh ticket at `WRK-008-slice-2b-design.md:1335-1356`, while F009 waits for an unnamed durable lease-candidate source at `:1312`. No planned manifest edit transfers either. Because `finding-ownership.mjs:118-120` checks only that `ownerStillOpen` is non-empty for a completed ticket, both can remain falsely owned after WRK-008 ships.

- **E6-F003’s planned manifest edit does not implement its stated disposition.** DEP says it becomes `open/unowned` at `DEP-010-design.md:288-297`, but the file/step lists only rewrite its reason at `:709-712,773-788`. Its current manifest status is still `owned` by DEP-010 at `finding-ownership.json:15-19`. It will remain falsely owned after DEP-010 unless the status and ticket fields are also changed.

- **The desktop deployment-surface guard has no owner.** DEP identifies the missing installer/autostart/service assertion at `DEP-010-design.md:638-643` and assigns it to “whoever owns the desktop packaging surface at that point.” No ticket or sprint does.

## E. Sprint order

**Not correct as written.**

- Sprint 2.5 is required to have a production caller before Sprint 3, but Sprint 3 owns the specified production `SessionStore` seam.
- The seam cannot bootstrap its first session even after both land.
- Sprint 3 is not the “first real job.”
- E4-F010 must be scheduled before any milestone claims actual leasing—certainly before Sprint 5, and before Sprint 4’s “credentials reach the sandbox” is treated as production evidence.

A valid ordering requires first assigning the production store/bootstrap-session wiring to one ticket, then fixing E4-F010 before the real-job milestone. DEP-010’s provider handoff can remain before dispatch composition.

## SUSPECTED

None. All reported defects above were checked against opened source or against the plans’ explicit step/acceptance mechanics.

Read-only verification also ran the focused ownership/wiring unit tests and both live register checks; all passed. The branch remained `docs/replatform-program` with a clean worktree.
