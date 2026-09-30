# WRK-006 Design — Durable, encrypted event outbox + `event_upload` wiring

**Status:** `design` (reviewable artifact; implementation follows via per-slice TDD + distinct adversarial review)
**Epic:** `E4-worker-daemon`
**Authoritative source:** `docs/replatform/program-design.md:608-613` (the E4 `implementation-plan.md` covers only CORE WRK-001..004 and names WRK-006 a non-goal throughout — this doc is the owed E4-style ticket expansion).
**Upstreams (verified):** WRK-004 (`8b8fc013b` lineage, event sink + sequencer + frozen event schemas), WRK-005 (`eabfc3c72`, fence-close proxy is a producer), **JOB-005 (`pass`) — the server-side idempotent event/terminal ingestion this outbox uploads into**. Frozen worker-protocol v1 source SHA `b7a842870ce7509d8baa75409e0ab19da375c88a`.
**Grounded by:** the WRK-006 terrain-map (5 parallel readers + synthesis); every load-bearing claim below re-verified directly against source.

---

## 1. One-line framing

WRK-006 is a **pure consumer of the FROZEN, already-complete `event_upload` wire op**. It replaces the currently-inert `WorkerEventSink` seam with a **durable, encrypted outbox** that persists digest/seq-stamped `WorkerEventV1` events **verbatim**, drains them **in strict `seq` order** through a new **`ControlPlaneClient.eventUpload`** method modeled on `renewLeaseOnce`, and advances a **durable cumulative `acceptedThroughSeq` cursor** — stopping at "events survive and replay." All sandbox/lease reconciliation is **WRK-007**.

**Frozen-surface rule:** WRK-006 adds/alters **zero** types in `packages/worker-protocol/`. Any wire change is a violation. The op already exists:
- `eventUploadOperationRequestV1Schema` — `transport.ts:304`
- `eventUploadOperationResponseV1Schema` (flat `ack:` field, NOT a discriminated `outcome` union) — `transport.ts:315`
- descriptor `event_upload` (`audience: worker_run`, `idempotent: true`, `retry: idempotent_retry`, `maxRequestBytes: 4*MiB`, `timeoutMs: 30_000`) — `transport.ts:844`
- `workerEventBatchV1Schema` — `events.ts:427`; `workerEventAckV1Schema` (invariant `expectedNextSeq === acceptedThroughSeq + 1`) — `events.ts:478`

---

## 2. The seam WRK-006 replaces

`WorkerEventSink` (`supervisor/events.ts:44-46`):
```ts
export interface WorkerEventSink { emit(event: WorkerEventV1): Promise<void> | void; }
```
Today satisfied only by `NOOP_SINK` (`lease-renewal.ts:342`) + test collectors. WRK-006 supplies a durable implementation whose `emit()` **fsync-commits the row before returning**, plus a background drain loop.

### The seq/digest contract — preserve VERBATIM (load-bearing)

- `EventSequencer` assigns `seq` starting at 1 (`#seq` starts 0, pre-incremented), **one sequencer == one lease/attempt stream**; contiguity is per-sequencer.
- `eventDigest = sha256Hex(canonicalEventDigestInputV1(withoutDigest))` — a **self-contained per-event content hash** over RFC-8785-canonical bytes with the `eventDigest` key omitted. **There is NO hash chain / prev-digest linkage**; the only inter-event linkage is contiguous `seq`.
- The event is `workerEventV1Schema.parse(...)`-validated **in the producer before** `sink.emit(event)`.
- **INVARIANT:** the outbox persists and replays each already-stamped `WorkerEventV1` **byte-for-byte**; it **never recomputes or re-stamps `seq` or `eventDigest`** (re-canonicalizing + re-hashing risks a divergent digest → server `event_hash_mismatch`).

### Producers that flow through the sink

| Producer | File | Kinds |
|---|---|---|
| Supervisor | `supervisor/supervisor.ts:227` (its `EventSequencer`) | `attempt_started`, `terminal` |
| FenceCloseProxy | `lease/fence-close-proxy.ts:119` (its **own** `EventSequencer`) | `network_denied` |

The other 16 protocol kinds have no producer yet (E5/DAT) — **but the outbox must accept the full 19-kind `WorkerEventV1` union** (it persists whatever `emit()` receives).

---

## 3. Durable-store decision (D1) — `node:sqlite`, encrypted file-log fallback

**Chosen: `node:sqlite`** (primary). Evidence:
- **Boundary-legal:** `scripts/lib/worker-daemon-boundary.mjs` `isNodeBuiltin` (line 71) short-circuits on the `node:` prefix before consulting `builtinModules`, so `node:sqlite` is allowed exactly like the daemon's existing `node:crypto`/`node:fs`. Any **npm** SQLite driver (`better-sqlite3`, `sqlite3`) is **illegal twice** — fails the manifest allow-list (runtime deps must equal exactly `["@armyofagents/worker-protocol","pino"]`) and the runtime-source-import scan; root `package.json` already nulls `sqlite3` via `overrides`. `require`/`node:module`/`createRequire` are separately banned, so the store must use ESM `import "node:sqlite"`.
- **Available at target Node:** CI `pr.yml` pins `node-version: 24` (all jobs); `Dockerfile` is Node-24. `node:sqlite` loads **flag-free** on Node 24.
- **Caveat (honest):** `node:sqlite` still emits `ExperimentalWarning` on Node 24 — flag-free but not Stability-2. Risk is Node binding-API churn, not data corruption (the SQLite storage engine is solid). **Decision:** use it, suppress the warning narrowly, and record the effective **Node-24 floor** (root `engines.node` currently says `>=20.3`, which is wrong for `node:sqlite` consumers — documented, not silently relied upon).

**Why not hand-roll a file log by default:** WRK-006's acceptance set — *"Crash between send/ACK, duplicate send, corrupt row quarantine, full disk, and sequence recovery"* (`program-design.md:613`) — is precisely the atomic-commit / crash-consistency machinery SQLite provides for free. A hand-rolled append-only encrypted log reintroduces framing/compaction/crash-consistency as bespoke code.

**Documented fallback:** if design review rejects an experimental API for durability-critical code, fall back to an **append-only encrypted file log** (`node:fs`/`node:crypto`) — also boundary-legal, zero new deps, no Node-floor lift, at the cost of hand-rolled durability primitives. The outbox is defined behind a `DurableEventStore` interface so the store is swappable without touching producers or the drain loop.

---

## 4. Encryption (D3) — first symmetric cipher in the daemon

The daemon has no AES/KDF surface yet (`node:crypto` is used only for Ed25519 sign + SHA-256 + `randomBytes`/`randomUUID`). WRK-006 introduces it, all from `node:crypto`:
- **Per-row `aes-256-gcm`**: `createCipheriv("aes-256-gcm", dek, iv)`, `iv = randomBytes(12)`, store the GCM auth tag alongside the ciphertext. Wrong key / tampered row → `decipher.final()` throws → **quarantine that row, fail closed** (never surface plaintext).
- **DEK** via `hkdfSync`/`scryptSync`; **KEK** from the device key material / a mounted secret.
- **File custody** mirrors `identity/key-store.ts` `MountedSecretKeyStore`: `mode 0600`, fail-closed, Windows-ACL-aware, for the DB (or log) file and any key file.
- **Encrypt inline (D5):** CORE payloads are small/bounded (`network_denied.reason ≤1000`, `terminal.errorMessage ≤4000`). Blob-by-reference is deferred until large-payload producers (`artifact_prepared`, E5/DAT) land.

---

## 5. Outbox mechanics

### Durable per-event record

| Field | Role |
|---|---|
| `stream_key` | the `(org,company,worker,job,attempt,lease,fence)` delivery identity — the batch identity every event repeats (`events.ts`) |
| `seq` | monotonic cursor **within a stream**; `UNIQUE(stream_key, seq)` |
| `event_id` | dedupe key (unique within a batch) |
| `event_digest` | frozen per-event content hash — stored verbatim, never recomputed |
| `ciphertext` + `iv` + `auth_tag` | aes-256-gcm of the full `WorkerEventV1` JSON |
| `status` | `pending → uploading → acked`, terminal `quarantined` (mirrors the Postgres outbox lifecycle: `embedding_queue`, `mention-outbox`) |
| `attempts` | retry counter; cap → `quarantined` (poison-row backstop) |
| `next_retry_at` | nullable; `null` = eligible now; persisted **capped full-jitter** backoff (survives restart) |
| `created_at`/`updated_at` | reaper + observability |

Plus a durable **`acceptedThroughSeq` watermark per stream** — the thing "restart resumes from the last ACK" reads.

**`UNIQUE(stream_key, seq)` is the D2 fail-closed backstop (see §7):** two producers minting the same `(stream_key, seq)` collide loudly at the store instead of silently corrupting a batch.

### Batch construction constraints (the flusher MUST obey)

1–500 events; **strictly contiguous `seq`** (each = prev+1, `events.ts:455`); unique `eventId`; every event repeats the stream's `org/company/worker/job/attempt/lease/fence`; each pre-stamped with a valid `eventDigest`; whole request ≤ 4 MiB. **Consequence:** the outbox uploads **in `seq` order** (no out-of-order `SKIP LOCKED` drain) and advances the durable cursor only on a matching `acceptedThroughSeq`.

### Drain loop

Non-blocking tick loop mirroring `embeddings-worker.ts` / `mention-outbox-worker.ts`: deferred first tick, per-tick errors swallowed, `.unref()` timers, cooperative `stop()`, registered into WRK-001's shutdown ordering (**stop drain → final flush attempt → close store**). Each tick, per active stream: gather `pending` rows in contiguous `seq` order from `watermark+1`, cap at 500 / 4 MiB → decrypt → build `workerEventBatchV1` → wrap in the request envelope (fresh `correlationId`/`nonce`, retry-stable `idempotencyKey`) → sign a device proof over `eventUploadPath` + exact bytes → `client.eventUpload` → classify (§6) → on `accepted`, advance the durable `acceptedThroughSeq` + prune rows `seq <= acceptedThroughSeq`.

### Crash recovery on restart

On boot, any `uploading` row reverts to `pending` **without bumping `attempts`** (crash ≠ logic failure — mirrors `resetStaleProcessing`); the loop resumes at durable `acceptedThroughSeq + 1` and re-uploads anything unacked. `emit()` must **durably commit (fsync) before returning** — the "Crash between send/ACK" test guards exactly that window. At-least-once from the worker, deduped to effectively-once at the server by the cumulative `seq` ACK (`implementation-plan.md:272`: "Worker events are observations until cumulatively ACKed").

---

## 6. Upload path — new daemon surface only

### Client method (mirror `leaseRenew`/`quarantineGrant`)

In `transport/client.ts` (all net-new, no `postOperation` body change):
1. `export const EVENT_UPLOAD_PATH = "/api/worker-control/events";` (fixed path → a `readonly eventUploadPath` field, not a `…Path(id)` fn).
2. Widen the internal `postOperation` `operation` union with `"event_upload"` (one token).
3. `eventUploadTimeoutMs` option → `OPERATION_DESCRIPTORS.event_upload.timeoutMs` (30_000).
4. Interface `readonly eventUploadPath` + `eventUpload(request): Promise<WorkerOperationHttpResponse>` delegating to `postOperation("event_upload", EVENT_UPLOAD_PATH, eventUploadTimeoutMs, 4*MiB, request)`.
5. Auth unchanged: session Bearer + five `aoa-device-*` proof headers signed over the plain `/api/...` path + exact bytes.

The build→sign→classify **op-caller is a NEW module** (`src/events/event-upload.ts`, alongside `lease-renewal.ts`/`quarantine.ts`) binding the frozen request/response schemas.

### Failure classification (mirror `renewLeaseOnce` / `classifyRenewResponse`)

`ControlPlaneTransportError` kinds: `timeout` → transient (retry, same key); `network` → transient; `request_too_large` → **terminal** (batch that can't shrink never fits); non-transport throw → **fail-closed** (declare stream stopped, like the renewal fail-closed wrapper). Response:
- `200` → `safeParse`; parse failure = terminal. Then switch `ack.status`:
  - `accepted` → advance durable cursor + prune ≤ watermark.
  - `gap` → resend from `expectedNextSeq`.
  - `hash_mismatch` → quarantine `rejectedEventId`, fail closed.
  - `stale_fence` / `target_revoked` / `terminal` → **stop uploads for this stream** (converge like renew's lease-loss).
- `401` → `session.recover()` under `maxConsecutiveRecoveries` (default 3, **per-stream** — reusing WRK-005's fix lesson), retry same key; cap → stop stream.
- `throttled`/`429`, `internal_unavailable`/`503` → transient, honor `retryAfterMs`.
- else → terminal.

**idempotencyKey discipline:** one fresh key per real flush; the **same** key on a transient retry (cumulative ACK makes replay safe). Not persisted across restart (D6) — the server dedups by `seq`.

---

## 7. The D2 two-sequencer hazard (HIGH VALUE — latent correctness defect)

A single contiguous `seq` stream per `(attempt, lease)` is required (`events.ts:455`), but **two independent `EventSequencer` instances** feed one lease today — the supervisor's (`supervisor.ts:227`) and the fence-close-proxy's own (`fence-close-proxy.ts:119`). Each starts `#seq` at 0, so both would mint `seq: 1` for the same delivery identity → collision / non-contiguous batch → server `sequence_gap`/`hash_mismatch`. Dormant only because the composition root wires nothing (E4-D12).

**WRK-006's two-part response:**
1. **Fail-closed store backstop (in scope):** `UNIQUE(stream_key, seq)` makes a collision a loud, tested error at persistence time — never silent corruption. WRK-006 owns this.
2. **Producer unification (flagged to E4-D12, out of WRK-006 impl scope):** when live dispatch is wired, one `EventSequencer` per lease/attempt must feed both the supervisor and the fence-close proxy. Recorded here as an E4-D12 blocker; WRK-006 does not rewire the inert composition root.

---

## 8. Backpressure / disk policy (D4)

`program-design.md:612`: "queue size and disk limits are enforced." Silently dropping events from a durability-critical outbox is unacceptable — **especially `terminal`/`network_denied`**. **Decision (default, revisitable):** a hard cap makes `emit()` **fail closed** (surfaces an error to the producer) rather than drop; a failed, visible run beats an unbounded supervisor block or a silent gap in the control plane's view. **Never** drop-oldest for terminal-class events. This is the one genuinely policy-flavored decision; it lives in an inert subsystem (not wired until E4-D12), so it ships with the conservative fail-closed default and is explicitly marked for product/eng revisit before live dispatch.

---

## 9. WRK-006 vs WRK-007 boundary

`program-design.md:1060`: `WRK-005 + JOB-005 → WRK-006; WRK-004 + WRK-006 + JOB-006 → WRK-007`.
- **WRK-006 owns "events survive and replay":** durable local persistence until cumulatively ACKed, resume-from-ACK, queue/disk limits, encryption, corrupt-row quarantine.
- **WRK-007 owns "on boot, reconcile survivors against server truth":** sandbox inventory diffing, lease/fence authority reconciliation, "resume live-owned work only if policy permits," stale-sandbox kill, unknown-artifact quarantine.
- **Explicitly OUT of WRK-006:** sandbox reconciliation, lease-authority diffing, deciding whether the *work* resumes. WRK-006 stops at replaying its own rows.

---

## 10. Decisions

- **D1 store:** `node:sqlite` primary (boundary-legal, Node-24 flag-free), warning suppressed + Node-24 floor documented; encrypted file-log fallback behind a `DurableEventStore` interface.
- **D2 seq authority:** `UNIQUE(stream_key, seq)` fail-closed backstop in WRK-006; producer unification flagged to E4-D12.
- **D3 crypto:** per-row aes-256-gcm (`node:crypto`), DEK via hkdf/scrypt, KEK from device/mounted secret, `0600` custody.
- **D4 limits:** hard cap → `emit()` fails closed; never drop terminal-class events (revisitable before live dispatch).
- **D5 payload:** encrypt inline; blob-by-reference deferred.
- **D6 idempotency:** fresh key per flush, same key on transient retry, not persisted across restart (seq-cursor dedup).
- **D7 protocol:** zero worker-protocol changes — pure consumer of the frozen `event_upload` op.

---

## 11. Slice plan (TDD, dependency order)

Every slice: fail-first; keep `policy`/`check:worker-daemon-boundary` green (`node:sqlite`/`node:fs`/`node:crypto` only, no npm driver, no `require`); **zero** `packages/worker-protocol/` source changes; frozen-protocol + distributed-foundation gates unchanged.

1. **Durable store + encrypted row codec.** `node:sqlite` schema (behind `DurableEventStore`) + aes-256-gcm encode/decode + key custody. *Fail-first:* event round-trips encrypt→persist→read→decrypt **byte-identical**; wrong key fails closed → quarantine; DB/key file `0600`; `UNIQUE(stream_key, seq)` rejects a collision.
2. **Durable `WorkerEventSink.emit()`.** *Fail-first:* `emit()` fsync-commits **before returning**; `seq`/`eventDigest` persisted **verbatim** (asserted never re-stamped); crash between commit and return leaves a recoverable `pending` row; accepts the full 19-kind union.
3. **Transport `eventUpload` method.** `EVENT_UPLOAD_PATH` + `postOperation` union widen + timeout option + method. *Fail-first:* POSTs the path with the 4 MiB ceiling + 30 s timeout; oversize pre-check → `request_too_large`; `timeout`/`network` map correctly; proof signs the exact path+bytes; frozen request/response schemas parse.
4. **Drain loop + ack-cursor + classification.** *Fail-first:* batch valid (contiguous `seq`, ≤500, ≤4 MiB, identity repeated, unique `eventId`); `accepted` advances cursor + prunes; `gap` resends from `expectedNextSeq`; `hash_mismatch` quarantines `rejectedEventId`; `stale_fence`/`target_revoked`/`terminal` stop the stream; transient retries reuse the same key; classification mirrors `renewLeaseOnce`.
5. **Restart recovery + limits + corrupt-row quarantine (the acceptance set).** *Fail-first (from `program-design.md:612-613`):* restart resumes from durable `acceptedThroughSeq + 1`; `uploading` → `pending` **without** bumping `attempts`; corrupt/undecryptable row quarantined (non-fatal, cursor not stalled); "crash between send/ACK", "duplicate send", "full disk", "sequence recovery" pass; backpressure (D4) enforced, no silent terminal-event drop. Stays inside WRK-006 (no sandbox/lease reconciliation).

---

## 12. Non-goals

Live E5/DAT producers for the other 16 event kinds; WRK-007 restart/orphan reconciliation against server truth; rewiring the inert composition root / E4-D12 live dispatch (incl. the D2 producer unification); any worker-protocol change; blob-by-reference large payloads. WRK-006 is additive and inert-until-wired.

## 13. Residual risks

- **`node:sqlite` experimental (D1):** binding-API churn across Node minors; mitigated by the `DurableEventStore` seam (file-log fallback) + a pinned Node-24 CI/runtime.
- **D2 producer unification (E4-D12):** the store backstop prevents silent corruption, but a wired-live daemon with two sequencers would hit the `UNIQUE` error until E4-D12 unifies them — a wiring-time blocker, recorded.
- **D4 backpressure policy:** ships fail-closed by default; the block-vs-fail-run choice is owed a product/eng confirmation before live dispatch.
- **Distinct review pending:** an independent adversarial reviewer reruns the full acceptance matrix (byte-verbatim seq/digest, crash-between-send/ACK, corrupt-row quarantine, the `UNIQUE(stream_key,seq)` collision proof, classification parity with `renewLeaseOnce`) and alone marks the ticket `complete`.
