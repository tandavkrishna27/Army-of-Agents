# MIG-003 Design — Durable realtime fan-out + sequence-based reconnect/catch-up (E10-REALTIME-FOUNDATION)

**Status:** `design` (reviewable artifact; fail-first TDD + distinct adversarial review). **Medium ticket — the E10-REALTIME-FOUNDATION gate. Postgres-only substrate (no new infra): a durable company-scoped event log is the source of truth; `LISTEN/NOTIFY` is the cross-replica wake.**
**Epic:** `E10 — desktop-migration-realtime` (second executed ticket; the named realtime partial gate). **Authoritative source:** `program-design.md:936-945`.
**Depends on (landed + verified):** JOB-005 (durable sequenced `job_events` — the durability model) + DEP-009 (two-replica capacity). Frozen `worker-protocol` v1 + the worker-daemon `SandboxProvider` port + `DE-*` — never edited.
**Grounded by:** the MIG-003 terrain-map (4 readers + synth) with load-bearing claims **independently re-verified** in `C:\e3` (see §2). **Substrate chosen by the operator: Postgres-only (durable log + LISTEN/NOTIFY + safety poll).**

---

## 1. Scope + framing

**Outcome (program-design.md:938):** project durable events to WebSockets through a cross-replica broker + support sequence-based reconnect/catch-up.

**Acceptance (program-design.md:939):** two control-plane replicas deliver CONSISTENT invalidation; broker loss delays realtime but NOT correctness; presence remains explicitly EPHEMERAL. The gate's immutable QA record must prove: durable event sequence/cursor AUTHORIZATION, two-replica delivery, disconnect/reconnect gap recovery, duplicate suppression, broker outage + recovery, redaction, backpressure, bounded snapshot fallback.

**The gap.** The company realtime bus is today a single **in-process `EventEmitter`** (`live-events.ts:16`): `publishLiveEvent` → `emitter.emit(companyId)` → per-socket fan-out. There is **no durable log, no cross-replica propagation, no cursor** — `LiveEvent.id` is a process-local counter never read as a cursor. Two DEP-009 replicas share Postgres but each has its own emitter, so a poke on replica A never reaches a socket on replica B → inconsistent invalidation. (Grep-verified: zero broker deps, no `pg_notify`/`LISTEN`.)

**The thesis — realtime is a HINT, the DB is truth.** Every `LiveEvent` payload is a minimal invalidation hint (`{issueId, status}`, `{itemId}`) that the client turns into a React-Query refetch against REST/DB. So the correctness property is free by construction: the durable log + DB are authoritative, and `NOTIFY` merely *wakes* replicas to pull the tail — a dropped `NOTIFY` delays realtime but never corrupts state.

**Substrate (operator-selected):** a new company-scoped durable **`live_event_log`** (the sequence + replay source of truth, mirroring JOB-005's durability model) + Postgres `LISTEN/NOTIFY` (a data-free `(companyId, seq)` wake) + a bounded safety poll (recovers a missed `NOTIFY`). No Redis, no new runtime dependency — consistent with the pg-centric, self-hostable re-platform.

| Workstream | Kind | Responsibility |
|---|---|---|
| `live_event_log` table + per-company sequence | new schema (`db:generate` + C14 + FORCE-RLS) | durable, per-company **contiguous monotonic** `seq`, org-unique `eventId` (idempotent), minimal-payload; the replay + cursor source of truth |
| Broker at the publish chokepoint | new | `publishLiveEvent` → append-to-log (assign seq) + `pg_notify(company, seq)` + local in-process emit (same-replica fast path) |
| Per-replica LISTEN + tail fan-out | new | each replica LISTENs; on `NOTIFY` (or safety-poll) pulls `seq > lastDelivered` from the log and fans out **re-running the existing per-event RBAC** (`live-events-ws.ts` company/thread/hub gates) |
| Cursor catch-up on (re)connect | new | WS handshake `?sinceSeq=N`; replay `seq > sinceSeq` with per-event RBAC (hide-don't-403, generalizing `threads.entriesSince`); duplicate suppression by `seq`; bounded snapshot fallback beyond the retained window |
| Backpressure | new | per-socket `bufferedAmount` high-water-mark → drop-to-snapshot (never an unbounded kernel buffer) |
| Reuse | reuse | the WS handshake auth + per-event envelope RBAC + `ThreadSubscriptionRegistry` + ephemeral presence stores — only the event *source* changes |

**Additive.** No frozen-contract edit; presence stays per-replica ephemeral (already satisfies the gate); an additive `LiveEvent.seq` field (not a tracked wire contract).

---

## 2. Load-bearing facts (re-verified in `C:\e3`)

1. **The whole company bus is one in-process emitter.** `live-events.ts:16` `new EventEmitter()`, `emit(companyId, event)` `:42`, `on(companyId, listener)` `:46`. Three same-process sinks: the WS handler (`live-events-ws.ts:629`), Commander (`internal-agent/event-listener.ts:134`), plugin host (`plugin-host-services.ts:1088`). **No broker, no `pg_notify`/`LISTEN`** (grep-verified zero).
2. **`LiveEvent.id` is a process-local counter, never a cursor.** `live-events.ts:19,26-28`; `types/live.ts:5`. Resets per process, collides across replicas; used only as a React list key. Safe to leave; add an additive durable `seq`.
3. **JOB-005 is the durability MODEL to mirror.** `schema/job_events.ts:49-71`: `sequence` (contiguous per-scope ordering), `eventId` org-unique (`job_events_org_event_uq` → idempotent redelivery), FORCE-RLS + composite tenant FKs. Not the same *scope* (per-attempt vs per-company) — mirror the shape, not the table.
4. **The cursor-authorization pattern already exists** (per-discussion): `GET …/entries?sinceSeq=N` (`discussions.ts:1986`) → `threads.entriesSince(companyId, threadId, sinceSeq, actor)` (`threads.ts:689`) routes RBAC through `getById` (hide-don't-403). Generalize this to the company bus.
5. **Per-event RBAC is recomputed live, never cached at subscribe.** `live-events-ws.ts:516-562` (thread `mayContextAccessThread` + `filterThreadEventRecipients`; hub `mayReceiveHubEvent` → `getVisible`); company-wide events → all authorized sockets. A replayed range MUST re-run these per event.
6. **No backpressure.** Bare `socket.send()` guarded only by `readyState===OPEN` (`live-events-ws.ts:637,651,658`); `setMaxListeners(0)`. A slow client's buffer grows unbounded.
7. **Presence is in-memory/TTL/restart-evaporating** (`live-events.ts:161,181-188,189,269`; sweep `live-events-ws.ts:579`) — already "explicitly ephemeral."
8. **DEP-009 replicas share Postgres, each its own emitter** (`docker-compose.d1.yml:220-249`) — the shared DB is the natural broker substrate + the two-replica correctness authority.

---

## 3. Invariants (each gets a test)

1. **Two-replica consistent invalidation.** An accepted durable event reaches an authorized socket on EVERY replica (via the log + `NOTIFY`/poll), not just the publishing replica.
2. **Broker loss delays, never corrupts.** With `NOTIFY` dropped/disabled, sockets still converge via the safety poll + the reconnect cursor; no event is lost from the durable log; the DB stays authoritative.
3. **Sequence-based catch-up.** A reconnect with `?sinceSeq=N` replays exactly the events with `seq > N` (in order), then switches to live with no gap and no duplicate.
4. **Duplicate suppression.** Overlapping replay+live (and at-least-once `NOTIFY`/poll redelivery) delivers each `seq` at most once to a client (idempotent by monotonic `seq`); the log's org-unique `eventId` makes append idempotent.
5. **Cursor authorization.** A replayed range re-runs company/thread/hub RBAC per event (hide-don't-403); a cross-tenant or unauthorized `sinceSeq` read returns nothing it may not see and never leaks existence via gaps.
6. **Bounded snapshot fallback.** A `sinceSeq` older than the retained window → the server signals a bounded full-refetch (not an unbounded replay).
7. **Backpressure.** A slow socket is bounded (high-water-mark) and dropped-to-snapshot rather than buffering unboundedly.
8. **Presence stays ephemeral.** Presence is neither persisted to the log nor cross-replica-fanned; per-replica TTL behavior is unchanged.
9. **Redaction.** The log stores only minimal-payload hints (no secrets); `NOTIFY` carries only `(companyId, seq)` — never a payload.

---

## 4. Decisions

### D1 — `live_event_log` durable table + per-company contiguous sequence
`db:generate` a new company-scoped table: `{id, companyId, organizationId, seq (bigint), eventId (uuid, unique per org — idempotent), type, payload (jsonb, minimal), createdAt}` with unique `(companyId, seq)` + unique `(organizationId, eventId)` + index `(companyId, seq)`; FORCE-RLS + composite tenant FKs, **no single-column FK** (E2-F013). The per-company `seq` is assigned **contiguously** in the same tenant tx as the insert via an atomic per-company counter (a `live_event_sequences(companyId, nextSeq)` row bumped `UPDATE … RETURNING`, mirroring the discussions `entrySeq` pattern — not a global sequence). Migration follows the MIG-008 lesson: **C14 idempotency on the generated DDL too** (`CREATE TABLE/INDEX IF NOT EXISTS`, FKs in `DO $$ … EXCEPTION WHEN duplicate_object`), plus the RLS/grant custom block + both grant surfaces. **Durable-eligible = the invalidation-bearing families** (hub/thread/issue/agent/heartbeat/discussion/memory/budget); high-churn ephemeral (presence, working-agents) are NOT logged (D6).

### D2 — Broker at the single publish chokepoint (ROBUST emitter-always model)
`publishLiveEvent` (`live-events.ts:36`) becomes: (1) the local in-process `emitter.emit` runs FIRST — synchronous, seq-less, and **ALWAYS delivered** to this replica's sockets (never gated on a health flag, never suppressed); (2) if the event is durable-eligible, record its `eventId` in a bounded per-replica FIFO set and, best-effort/fire-and-forget, append to `live_event_log` assigning the next per-company `seq` (tenant tx); (3) after commit, `pg_notify('live_events', json{companyId, seq})` — a **data-free wake** (only ids). Non-durable events (presence) skip (2)+(3) and only local-emit. Because the emitter delivers before and independently of the async append, an append that later FAILS (pool exhaustion, timeout, deadlock, failover, a non-superuser owner blocked by FORCE-RLS) can **never silently drop** an already-delivered event on the emitting replica (Invariant 2) — the earlier fragile `isDurablePipelineHealthy` flag + suppress-on-emit design is removed. This one chokepoint covers all 82 producers + all 3 sinks + the four JOB-005 projection bridges → **cross-replica for free** (D8).

### D3 — Per-replica LISTEN + tail fan-out + safety poll (eventId same-replica dedup)
Each replica runs one `LISTEN live_events` connection. On `NOTIFY (companyId, seq)` (or the safety poll): read `live_event_log` rows for that company with `seq > lastDrained[company]`, and fan them to that replica's sockets through the **existing** `live-events-ws` authz path (company/thread/hub RBAC re-run per event). The drainer **SUPPRESSES rows whose `eventId` this replica itself published** (they were already delivered seq-less by the local emit in D2) — so on the emitting replica the drainer delivers nothing for a local event (no same-replica double), while **peer** replicas (which never published that `eventId`) deliver the durable copy normally → cross-replica delivery intact with no health-flag fragility. First-sight anchoring: a NOTIFY-driven drain anchors at `triggerSeq-1`; a **poll-driven first sight anchors at the retention floor** (not `currentSeq`), so a tail already appended but whose `NOTIFY` was lost under LISTEN loss is still recovered — the per-socket `seq` cursor absorbs any re-fan (Invariant 4). A bounded **safety poll** (low frequency per active company) pulls any tail a dropped `NOTIFY` missed — this is what makes broker loss a *delay* (Invariant 2). If an `eventId` is evicted from the bounded FIFO before its own drain (extreme burst), the worst case is the acceptable idempotent transition-double (seq-carrying re-delivery of an already-seen event → an idempotent client refetch), never a drop.

### D4 — Cursor catch-up on (re)connect
The WS handshake accepts `?sinceSeq=N`. On connect, before live delivery, replay `live_event_log` `seq > N` for the company, re-running per-event RBAC (hide-don't-403, generalizing `threads.entriesSince`), then atomically switch to live keyed on the same `lastDeliveredSeq` (no gap, no dup). The client (`LiveUpdatesProvider`) tracks the max `seq` seen and sends it on reconnect; it ignores any `seq ≤ max` (duplicate suppression). **Bounded snapshot fallback:** if `N` < the retained window floor (the log is trimmed to a bounded retention), the server replies `resume=snapshot` and the client does its existing blanket refetch (bounded, not an unbounded replay).

### D5 — Backpressure
Per-socket: track `ws.bufferedAmount`; above a high-water-mark, stop live delivery for that socket and signal `resume=snapshot` (close/hint to reconnect + catch-up), rather than growing the kernel buffer. Bounded queue depth per socket.

### D6 — Presence stays per-replica ephemeral (non-goal)
Presence + working-agents are NOT logged, NOT cross-replica-fanned. The gate asserts two-replica *delivery* + *ephemeral presence*, not two-replica presence; per-replica ephemeral presence already satisfies "presence remains explicitly ephemeral." Cross-replica presence is a documented follow-up.

### D7 — Redaction + wire
The log stores the same minimal-payload hints (no secrets — by construction + PRT-004 for job-derived); `NOTIFY` carries only `(companyId, seq)`. Add an additive `LiveEvent.seq: number` (durable company sequence) to `packages/shared/src/types/live.ts`; keep `id` for back-compat. `LiveEvent` is not a tracked `wire-compat.md` contract (verified).

---

## 5. Non-goals / scope honesty
1. **Cross-replica presence** — out of scope (D6); per-replica ephemeral presence satisfies the gate.
2. **No new infra** — Postgres-only; no Redis/queue. (Redis was the operator-rejected alternative.)
3. **Not every event family is made durable** — only invalidation-bearing families; ephemeral/high-churn stay non-durable (D1).
4. **No frozen `worker-protocol`/port/`DE-*` edit; no hosted-API call.** Migration via `db:generate` + C14.
5. **Retention/trim of `live_event_log`** ships bounded — a low-frequency background sweeper (`index.ts`, `store.trimRetention`) deletes rows below `currentSeq(company) − retainWindow` (default `5000`, tunable) inside `withTenantTx`. On an owner/superuser deployment the sweeper's `live_event_sequences` self-read enumerates every retained company (GLOBAL trim); on the distributed aoa_app role (FORCE-RLS, no org GUC on the enumerate read) it trims the replica's **active-company set** each cycle (bounded for the companies actually generating events + reconnect load). Fully-idle-company trimming on the distributed role is the documented residual. The `aoa_app` DELETE grant already exists (no schema change).

---

## 6. CI + acceptance mapping
| Acceptance clause (L939 + gate L943) | Where satisfied | Gate |
|---|---|---|
| two-replica consistent invalidation | D1 log + D2 NOTIFY/poll fan-out | d1 lane `tests/d1/e6f-13-realtime-fanout.test.mjs` (real store + cross-process LISTEN/NOTIFY) |
| broker loss delays not corrupts | D2 safety poll + durable log truth | d1 lane `e6f-13` (NOTIFY-dropped → safety-poll recovery) |
| reconnect gap recovery + dup suppression | D4 `sinceSeq` replay + `seq` dedup | `verify` |
| cursor/replay authorization | D4 per-event RBAC hide-don't-403 | `verify` |
| presence ephemeral | D6 unchanged ephemeral stores | `verify` |
| redaction | D7 minimal payloads + data-free NOTIFY | `verify` |
| backpressure + bounded snapshot fallback | D5 + D4 | `verify` |

**Gate recommendation:** fail-first — write the sequence-append/idempotency + `sinceSeq` replay-with-RBAC + dedup + broker-loss-safety-poll + backpressure assertions RED before the broker/log wiring, then GREEN; the two-replica + broker-outage integration proofs run on the Linux CI DB lane; distinct adversarial review before the result doc. Disposition = scope-honest `pass` on in-process/mocked + single-node evidence, with the two-replica/outage integration on the CI DB lane.

---

## 7. Risks / open questions (resolved or deferred)
- **Cursor shape (single per-company seq vs per-visibility-class):** resolved — a single per-company monotonic `seq` (matches the emitter keying + one durable log); the **gap-existence-oracle risk** is neutralized because replay re-runs per-event RBAC and simply omits events the actor may not see (the client never infers existence from a gap — payloads are hints, and a missing `seq` is indistinguishable from an unauthorized one).
- **Retention window** (replay vs snapshot fallback boundary): a bounded default (tunable); beyond it → D4 snapshot fallback.
- **`NOTIFY` payload cap (~8KB):** non-issue — it carries only `(companyId, seq)`.
- **Contiguity under concurrency:** the per-company counter is bumped in-tx (atomic `UPDATE … RETURNING`), so seq is contiguous per company even under concurrent publishers (serialized on the counter row).
- **Non-durable families never get catch-up:** by design (they are transient); their invalidation still fires live + the reconnect blanket-refetch covers them.
