/**
 * Durable event-outbox store (WRK-006, D1) — the swappable persistence port
 * plus its primary `node:sqlite` implementation.
 *
 * The store owns CIPHERTEXT CUSTODY + ORDERING + STATUS only; it never holds the
 * KEK and never decrypts. The durable sink encrypts a `WorkerEventV1` JSON blob
 * BEFORE `append`, and the drain decrypts AFTER a read — so a compromised store
 * file yields only sealed rows.
 *
 * The `DurableEventStore` interface is kept deliberately small and crypto-free so
 * an append-only encrypted file-log fallback (documented in the WRK-006 design)
 * can implement it later WITHOUT touching the sink, the drain, or the producers.
 *
 * `UNIQUE(stream_key, seq)` is the D2 fail-closed backstop: two producers minting
 * the same `(stream_key, seq)` for one lease collide LOUDLY at persistence time
 * ({@link SeqCollisionError}) instead of silently corrupting a batch.
 *
 * Runtime imports: `node:sqlite` + `node:fs` + `node:path` — the E4-D01 boundary
 * (a `node:` builtin is boundary-legal; no npm SQLite driver, no `require`).
 */

import { chmodSync } from "node:fs";
// TYPE-ONLY: erased at compile time, so it does NOT load `node:sqlite` (and thus
// never triggers the ExperimentalWarning). The runtime value is loaded via a
// DYNAMIC `import("node:sqlite")` AFTER the warning filter is installed — the only
// ordering that reliably suppresses the warning (a static value import links the
// builtin before the filter's side effect runs).
import type { DatabaseSync } from "node:sqlite";

import type { EncryptedEventRow } from "./event-row-codec.js";
import { installSqliteExperimentalWarningFilter } from "./sqlite-experimental-warning.js";

/** The 7-field delivery identity every event under a lease repeats verbatim. */
export interface EventStreamIdentity {
  readonly organizationId: string;
  readonly companyId: string;
  readonly workerId: string;
  readonly jobId: string;
  readonly attempt: number;
  readonly leaseId: string;
  readonly fenceToken: string;
}

/** Row status lifecycle: `pending → uploading → (pruned on ACK)`, terminal
 * `quarantined` (poison-row / decrypt-fail / hash_mismatch backstop). */
export type EventRowStatus = "pending" | "uploading" | "quarantined";

export interface StoredEventRow {
  readonly id: number;
  readonly streamKey: string;
  readonly seq: number;
  readonly eventId: string;
  readonly eventDigest: string;
  readonly eventType: string;
  readonly encrypted: EncryptedEventRow;
  readonly status: EventRowStatus;
  readonly attempts: number;
  readonly nextRetryAt: number | null;
}

export interface StreamCursor {
  readonly streamKey: string;
  readonly identity: EventStreamIdentity;
  readonly acceptedThroughSeq: number;
  readonly stopped: boolean;
  readonly stopReason: string | null;
  readonly pendingCount: number;
}

export interface AppendEventInput {
  readonly streamKey: string;
  readonly identity: EventStreamIdentity;
  readonly seq: number;
  readonly eventId: string;
  readonly eventDigest: string;
  readonly eventType: string;
  readonly encrypted: EncryptedEventRow;
  readonly nowMs: number;
}

/** The D2 backstop failure: a `(stream_key, seq)` already exists. */
export class SeqCollisionError extends Error {
  constructor(
    public readonly streamKey: string,
    public readonly seq: number,
  ) {
    super(`event outbox seq collision: stream already holds seq ${seq}`);
    this.name = "SeqCollisionError";
  }
}

/** The D4 fail-closed backpressure failure: the durable queue is at its limit. */
export class OutboxFullError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboxFullError";
  }
}

/** Backpressure limits (D4). Defaults are generous; the daemon may tighten them. */
export interface EventOutboxLimits {
  /** Hard cap on non-terminal (pending+uploading) rows before `append` fails closed. */
  readonly maxPendingRows: number;
  /** Hard cap on total stored ciphertext bytes before `append` fails closed. */
  readonly maxTotalBytes: number;
}

const DEFAULT_LIMITS: EventOutboxLimits = { maxPendingRows: 100_000, maxTotalBytes: 512 * 1024 * 1024 };

/**
 * The persistence port. The primary impl is {@link SqliteEventOutboxStore}; a
 * file-log fallback could implement the SAME surface.
 */
export interface DurableEventStore {
  /** Durably (fsync) persist a pending row. Throws {@link SeqCollisionError} on a
   * `(stream_key, seq)` collision and {@link OutboxFullError} at the backpressure
   * cap — both FAIL CLOSED (never drop, never overwrite). */
  append(input: AppendEventInput): void;
  /** On boot, revert any `uploading` row to `pending` WITHOUT bumping attempts
   * (a crash is not a logic failure). Returns the count reverted. */
  recoverStalledUploading(): number;
  /** Non-stopped streams that still hold at least one pending row. */
  listActiveStreams(): StreamCursor[];
  getStream(streamKey: string): StreamCursor | null;
  /** The smallest seq of a still-unacked (`pending`/`uploading`) row, or null if
   * none. A value STRICTLY GREATER than `acceptedThroughSeq + 1` means the next
   * expected seq is absent — the only way that arises is a `quarantined` poison row
   * (emission is contiguous + durable), i.e. a PERMANENT contiguity gap the drain
   * converts to a fail-closed stream stop rather than a silent zombie. */
  firstUnackedSeq(streamKey: string): number | null;
  /** Read-only: eligible CONTIGUOUS pending rows from `acceptedThroughSeq + 1`
   * (the head must be retry-eligible; a gap or an ineligible head truncates). */
  peekContiguous(streamKey: string, maxCount: number, nowMs: number): StoredEventRow[];
  /** Mark the ACTUAL flushed batch `uploading`. */
  markUploading(streamKey: string, seqs: readonly number[]): void;
  /** Advance the durable cursor: prune rows `seq <= acceptedThroughSeq` and revert
   * any still-`uploading` remainder to immediately-eligible `pending`. */
  advanceCursor(streamKey: string, acceptedThroughSeq: number): void;
  /** Revert the stream's `uploading` rows to `pending`, optionally bumping attempts
   * and setting a persisted `next_retry_at` (survives restart). */
  requeue(streamKey: string, nextRetryAt: number | null, bumpAttempts: boolean): void;
  /** Quarantine a single poison row by db id (undecryptable). */
  quarantineRow(id: number): void;
  /** Quarantine the conflicting event by id (server `hash_mismatch`). */
  quarantineEvent(streamKey: string, eventId: string): void;
  /** Mark a stream stopped (fail-closed convergence: stale_fence/target_revoked/
   * terminal/hash_mismatch/recovery-cap). */
  stopStream(streamKey: string, reason: string): void;
  countPending(): number;
  totalCiphertextBytes(): number;
  close(): void;
  // --- introspection (tests + observability) ---
  getRow(streamKey: string, seq: number): StoredEventRow | null;
  allRows(streamKey: string): StoredEventRow[];
}

/** Derive the stream key from the delivery identity. The 7 fields are UUIDs /
 * opaque tokens / a small integer — none contains the `|` delimiter. */
export function deriveStreamKey(identity: EventStreamIdentity): string {
  return [
    identity.organizationId,
    identity.companyId,
    identity.workerId,
    identity.jobId,
    String(identity.attempt),
    identity.leaseId,
    identity.fenceToken,
  ].join("|");
}

export interface SqliteEventOutboxStoreOptions {
  readonly path: string;
  readonly now?: () => number;
  readonly limits?: Partial<EventOutboxLimits>;
}

/** The `node:sqlite` `DatabaseSync` constructor, loaded via dynamic import so the
 * ExperimentalWarning filter is in place before the builtin links. */
type DatabaseSyncCtor = new (path: string) => DatabaseSync;

/**
 * Load the `node:sqlite` `DatabaseSync` constructor with the ExperimentalWarning
 * filtered. MUST be dynamic (not a static value import): a static import links the
 * builtin — capturing `process.emitWarning` — before the filter's side effect runs.
 */
export async function loadDatabaseSync(): Promise<DatabaseSyncCtor> {
  installSqliteExperimentalWarningFilter();
  const mod = (await import("node:sqlite")) as unknown as { DatabaseSync: DatabaseSyncCtor };
  return mod.DatabaseSync;
}

/**
 * Open the primary `node:sqlite`-backed durable event store. Async because it
 * dynamically loads the builtin (warning-suppression ordering); once open, all
 * methods — including the sink's `append` — are synchronous.
 */
export async function openEventOutboxStore(opts: SqliteEventOutboxStoreOptions): Promise<SqliteEventOutboxStore> {
  const ctor = await loadDatabaseSync();
  return new SqliteEventOutboxStore(ctor, opts);
}

interface RawOutboxRow {
  id: number;
  stream_key: string;
  seq: number;
  event_id: string;
  event_digest: string;
  event_type: string;
  salt: Uint8Array;
  iv: Uint8Array;
  auth_tag: Uint8Array;
  ciphertext: Uint8Array;
  status: string;
  attempts: number;
  next_retry_at: number | null;
}

interface RawStreamRow {
  stream_key: string;
  organization_id: string;
  company_id: string;
  worker_id: string;
  job_id: string;
  attempt: number;
  lease_id: string;
  fence_token: string;
  accepted_through_seq: number;
  stopped: number;
  stop_reason: string | null;
}

function isUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /UNIQUE constraint failed/i.test(err.message);
}

function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export class SqliteEventOutboxStore implements DurableEventStore {
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  readonly #limits: EventOutboxLimits;

  /** Prefer {@link openEventOutboxStore}. The `DatabaseSync` ctor is injected so the
   * warning-suppression + dynamic-load ordering lives in the factory, not here. */
  constructor(DatabaseSyncCtor: DatabaseSyncCtor, opts: SqliteEventOutboxStoreOptions) {
    this.#now = opts.now ?? (() => Date.now());
    this.#limits = { ...DEFAULT_LIMITS, ...opts.limits };
    this.#db = new DatabaseSyncCtor(opts.path);
    // A post-open PRAGMA/schema fault (SQLITE_NOTADB / disk-full / SQLITE_BUSY) must
    // not leak the just-opened handle + its file lock — a leaked lock can wedge the
    // outbox across restarts. Close-then-rethrow on any setup failure.
    try {
      // Durable single-writer settings: synchronous=FULL makes each auto-committed
      // INSERT fsync the journal before the call returns (the emit() durability
      // window the "crash between send/ACK" test guards).
      this.#db.exec("PRAGMA journal_mode = TRUNCATE;");
      this.#db.exec("PRAGMA synchronous = FULL;");
      this.#db.exec("PRAGMA foreign_keys = OFF;");
      this.#createSchema();
      this.#hardenPermissions(opts.path);
    } catch (err) {
      try {
        this.#db.close();
      } catch {
        // Best-effort: never mask the original setup failure with a close error.
      }
      throw err;
    }
  }

  #hardenPermissions(path: string): void {
    if (path === ":memory:") return;
    try {
      chmodSync(path, 0o600);
    } catch {
      // Windows chmod cannot clear group/other bits; the OS default ACL enforces
      // the perm invariant there, so a chmod failure is non-fatal (mirrors
      // MountedSecretKeyStore.save).
    }
  }

  #createSchema(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS event_stream (
        stream_key TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        company_id TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        lease_id TEXT NOT NULL,
        fence_token TEXT NOT NULL,
        accepted_through_seq INTEGER NOT NULL DEFAULT 0,
        stopped INTEGER NOT NULL DEFAULT 0,
        stop_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS event_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stream_key TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_id TEXT NOT NULL,
        event_digest TEXT NOT NULL,
        event_type TEXT NOT NULL,
        salt BLOB NOT NULL,
        iv BLOB NOT NULL,
        auth_tag BLOB NOT NULL,
        ciphertext BLOB NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_retry_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(stream_key, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_outbox_stream_seq ON event_outbox(stream_key, seq);
      CREATE INDEX IF NOT EXISTS idx_outbox_status ON event_outbox(status);
    `);
  }

  #upsertStream(input: AppendEventInput): void {
    const now = input.nowMs;
    this.#db
      .prepare(
        `INSERT INTO event_stream
           (stream_key, organization_id, company_id, worker_id, job_id, attempt, lease_id, fence_token,
            accepted_through_seq, stopped, stop_reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, ?, ?)
         ON CONFLICT(stream_key) DO UPDATE SET updated_at = excluded.updated_at`,
      )
      .run(
        input.streamKey,
        input.identity.organizationId,
        input.identity.companyId,
        input.identity.workerId,
        input.identity.jobId,
        input.identity.attempt,
        input.identity.leaseId,
        input.identity.fenceToken,
        now,
        now,
      );
  }

  append(input: AppendEventInput): void {
    // Backpressure (D4): fail CLOSED at the cap. Never drop, never drop-oldest —
    // a visible producer error beats a silent gap in the control-plane's view.
    const incoming = input.encrypted.ciphertext.byteLength;
    if (this.countPending() >= this.#limits.maxPendingRows) {
      throw new OutboxFullError("event outbox pending-row limit reached; failing closed");
    }
    if (this.totalCiphertextBytes() + incoming > this.#limits.maxTotalBytes) {
      throw new OutboxFullError("event outbox byte limit reached; failing closed");
    }
    this.#upsertStream(input);
    try {
      this.#db
        .prepare(
          `INSERT INTO event_outbox
             (stream_key, seq, event_id, event_digest, event_type, salt, iv, auth_tag, ciphertext,
              status, attempts, next_retry_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, ?, ?)`,
        )
        .run(
          input.streamKey,
          input.seq,
          input.eventId,
          input.eventDigest,
          input.eventType,
          input.encrypted.salt,
          input.encrypted.iv,
          input.encrypted.authTag,
          input.encrypted.ciphertext,
          input.nowMs,
          input.nowMs,
        );
    } catch (err) {
      if (isUniqueViolation(err)) throw new SeqCollisionError(input.streamKey, input.seq);
      throw err;
    }
  }

  recoverStalledUploading(): number {
    const info = this.#db
      .prepare(`UPDATE event_outbox SET status = 'pending', updated_at = ? WHERE status = 'uploading'`)
      .run(this.#now());
    return Number(info.changes);
  }

  listActiveStreams(): StreamCursor[] {
    const rows = this.#db
      .prepare(
        `SELECT s.* FROM event_stream s
          WHERE s.stopped = 0
            AND EXISTS (SELECT 1 FROM event_outbox e
                          WHERE e.stream_key = s.stream_key AND e.status IN ('pending','uploading'))`,
      )
      .all() as unknown as RawStreamRow[];
    return rows.map((r) => this.#toCursor(r));
  }

  getStream(streamKey: string): StreamCursor | null {
    const row = this.#db.prepare(`SELECT * FROM event_stream WHERE stream_key = ?`).get(streamKey) as
      | RawStreamRow
      | undefined;
    return row ? this.#toCursor(row) : null;
  }

  firstUnackedSeq(streamKey: string): number | null {
    const row = this.#db
      .prepare(`SELECT MIN(seq) AS s FROM event_outbox WHERE stream_key = ? AND status IN ('pending','uploading')`)
      .get(streamKey) as { s: number | null };
    return row.s === null ? null : Number(row.s);
  }

  #toCursor(row: RawStreamRow): StreamCursor {
    const pending = this.#db
      .prepare(`SELECT COUNT(*) AS c FROM event_outbox WHERE stream_key = ? AND status IN ('pending','uploading')`)
      .get(row.stream_key) as { c: number };
    return {
      streamKey: row.stream_key,
      identity: {
        organizationId: row.organization_id,
        companyId: row.company_id,
        workerId: row.worker_id,
        jobId: row.job_id,
        attempt: Number(row.attempt),
        leaseId: row.lease_id,
        fenceToken: row.fence_token,
      },
      acceptedThroughSeq: Number(row.accepted_through_seq),
      stopped: row.stopped !== 0,
      stopReason: row.stop_reason,
      pendingCount: Number(pending.c),
    };
  }

  peekContiguous(streamKey: string, maxCount: number, nowMs: number): StoredEventRow[] {
    const stream = this.getStream(streamKey);
    if (stream === null || stream.stopped) return [];
    const rows = this.#db
      .prepare(
        `SELECT * FROM event_outbox
          WHERE stream_key = ? AND status IN ('pending','uploading') AND seq > ?
          ORDER BY seq ASC
          LIMIT ?`,
      )
      .all(streamKey, stream.acceptedThroughSeq, Math.max(1, maxCount)) as unknown as RawOutboxRow[];
    const out: StoredEventRow[] = [];
    let expected = stream.acceptedThroughSeq + 1;
    for (const raw of rows) {
      if (Number(raw.seq) !== expected) break; // a gap breaks contiguity
      // The HEAD gates eligibility: if the first row is backed off, upload nothing
      // this tick (contiguity forbids skipping ahead).
      if (out.length === 0 && raw.next_retry_at !== null && Number(raw.next_retry_at) > nowMs) break;
      out.push(this.#toRow(raw));
      expected += 1;
    }
    return out;
  }

  markUploading(streamKey: string, seqs: readonly number[]): void {
    if (seqs.length === 0) return;
    const stmt = this.#db.prepare(
      `UPDATE event_outbox SET status = 'uploading', updated_at = ? WHERE stream_key = ? AND seq = ?`,
    );
    const now = this.#now();
    for (const seq of seqs) stmt.run(now, streamKey, seq);
  }

  advanceCursor(streamKey: string, acceptedThroughSeq: number): void {
    const now = this.#now();
    this.#db
      .prepare(`DELETE FROM event_outbox WHERE stream_key = ? AND seq <= ?`)
      .run(streamKey, acceptedThroughSeq);
    // Revert the un-accepted remainder to IMMEDIATELY-eligible pending so the next
    // tick resends from acceptedThroughSeq + 1 (used by both `accepted` partial and
    // `gap`). Attempts are NOT bumped — progress, not a failure.
    this.#db
      .prepare(
        `UPDATE event_outbox SET status = 'pending', next_retry_at = NULL, updated_at = ?
          WHERE stream_key = ? AND status = 'uploading'`,
      )
      .run(now, streamKey);
    this.#db
      .prepare(`UPDATE event_stream SET accepted_through_seq = ?, updated_at = ? WHERE stream_key = ?`)
      .run(acceptedThroughSeq, now, streamKey);
  }

  requeue(streamKey: string, nextRetryAt: number | null, bumpAttempts: boolean): void {
    const now = this.#now();
    const bump = bumpAttempts ? 1 : 0;
    this.#db
      .prepare(
        `UPDATE event_outbox
            SET status = 'pending', attempts = attempts + ?, next_retry_at = ?, updated_at = ?
          WHERE stream_key = ? AND status = 'uploading'`,
      )
      .run(bump, nextRetryAt, now, streamKey);
  }

  quarantineRow(id: number): void {
    this.#db
      .prepare(`UPDATE event_outbox SET status = 'quarantined', updated_at = ? WHERE id = ?`)
      .run(this.#now(), id);
  }

  quarantineEvent(streamKey: string, eventId: string): void {
    this.#db
      .prepare(`UPDATE event_outbox SET status = 'quarantined', updated_at = ? WHERE stream_key = ? AND event_id = ?`)
      .run(this.#now(), streamKey, eventId);
  }

  stopStream(streamKey: string, reason: string): void {
    this.#db
      .prepare(`UPDATE event_stream SET stopped = 1, stop_reason = ?, updated_at = ? WHERE stream_key = ?`)
      .run(reason, this.#now(), streamKey);
  }

  countPending(): number {
    const row = this.#db
      .prepare(`SELECT COUNT(*) AS c FROM event_outbox WHERE status IN ('pending','uploading')`)
      .get() as { c: number };
    return Number(row.c);
  }

  totalCiphertextBytes(): number {
    const row = this.#db
      .prepare(`SELECT COALESCE(SUM(LENGTH(ciphertext)), 0) AS b FROM event_outbox WHERE status IN ('pending','uploading')`)
      .get() as { b: number };
    return Number(row.b);
  }

  close(): void {
    this.#db.close();
  }

  getRow(streamKey: string, seq: number): StoredEventRow | null {
    const raw = this.#db
      .prepare(`SELECT * FROM event_outbox WHERE stream_key = ? AND seq = ?`)
      .get(streamKey, seq) as RawOutboxRow | undefined;
    return raw ? this.#toRow(raw) : null;
  }

  allRows(streamKey: string): StoredEventRow[] {
    const rows = this.#db
      .prepare(`SELECT * FROM event_outbox WHERE stream_key = ? ORDER BY seq ASC`)
      .all(streamKey) as unknown as RawOutboxRow[];
    return rows.map((r) => this.#toRow(r));
  }

  #toRow(raw: RawOutboxRow): StoredEventRow {
    return {
      id: Number(raw.id),
      streamKey: raw.stream_key,
      seq: Number(raw.seq),
      eventId: raw.event_id,
      eventDigest: raw.event_digest,
      eventType: raw.event_type,
      encrypted: {
        salt: toBuffer(raw.salt),
        iv: toBuffer(raw.iv),
        authTag: toBuffer(raw.auth_tag),
        ciphertext: toBuffer(raw.ciphertext),
      },
      status: raw.status as EventRowStatus,
      attempts: Number(raw.attempts),
      nextRetryAt: raw.next_retry_at === null ? null : Number(raw.next_retry_at),
    };
  }
}
