import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { LiveEvent, LiveEventType, ThreadVisibility } from "@armyofagents/shared";
import { canViewThread, type ThreadViewer } from "./threads.js";

// Threads v1 Plan 7: the thread.* event types
//   thread.entry.created | thread.scope.changed | thread.phase.changed
//   thread.summary.updated | thread.participant.changed | thread.link.created
//   thread.presence
// are members of LiveEventType (see packages/shared/src/constants.ts
// LIVE_EVENT_TYPES). Each carries a `threadId` in its payload so the
// envelope-RBAC fan-out (filterThreadEventRecipients, below) can scope delivery.

type LiveEventPayload = Record<string, unknown>;
type LiveEventListener = (event: LiveEvent) => void;

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

let nextEventId = 0;

function toLiveEvent(input: {
  companyId: string;
  type: LiveEventType;
  payload?: LiveEventPayload;
}): LiveEvent {
  nextEventId += 1;
  return {
    id: nextEventId,
    companyId: input.companyId,
    type: input.type,
    createdAt: new Date().toISOString(),
    payload: input.payload ?? {},
  };
}

// ── MIG-003: durable broker at the single publish chokepoint ──────────────────
//
// realtime is a HINT, the DB is truth. `publishLiveEvent` stays SYNCHRONOUS and
// unchanged for the same-replica local-emit fast path (Commander, plugin host,
// and each WS socket's per-company subscriber). For durable-eligible events it
// ADDITIONALLY, best-effort + fire-and-forget, appends to `live_event_log`
// (assigning a per-company contiguous seq under tenant context) and, after
// commit, `pg_notify`s a DATA-FREE `{companyId, seq}` wake so peer replicas pull
// the tail. A failed append/notify degrades to single-replica realtime (the
// local emit already happened); it never throws into the caller and never
// corrupts state.

/**
 * Event families that are EPHEMERAL by design (D6): presence + working-agents.
 * They are NEVER written to the durable log and NEVER cross-replica-fanned — a
 * viewer's "who's here right now" is per-replica in-memory TTL state. Every other
 * family is an invalidation-bearing hint and is durable-eligible.
 */
export const EPHEMERAL_LIVE_EVENT_TYPES: ReadonlySet<LiveEventType> = new Set<LiveEventType>([
  "thread.presence",
]);

/** Whether a live event is appended to `live_event_log` (durable) vs. local-only. */
export function isDurableEligible(type: LiveEventType): boolean {
  return !EPHEMERAL_LIVE_EVENT_TYPES.has(type);
}

/**
 * The DATA-FREE cross-replica wake payload (D7 redaction): only `(companyId,
 * seq)` — never the event payload. Kept well under the ~8KB NOTIFY cap.
 */
export function buildDurableNotifyPayload(companyId: string, seq: number): string {
  return JSON.stringify({ companyId, seq });
}

/** Parse a `live_events` NOTIFY payload back to `{companyId, seq}` (fail-soft → null). */
export function parseDurableNotifyPayload(
  raw: string,
): { companyId: string; seq: number } | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" && parsed !== null &&
      typeof (parsed as { companyId?: unknown }).companyId === "string" &&
      Number.isFinite((parsed as { seq?: unknown }).seq)
    ) {
      return {
        companyId: (parsed as { companyId: string }).companyId,
        seq: (parsed as { seq: number }).seq,
      };
    }
  } catch {
    /* malformed wake — the safety poll covers the tail regardless */
  }
  return null;
}

/** A durable log row projected back to a LiveEvent (always carries `seq`). */
export interface DurableLiveEvent extends LiveEvent {
  seq: number;
  /**
   * The append idempotency key. Carried on the replay/fan-out path so the
   * per-replica drainer can SUPPRESS events that ORIGINATED on this replica (they
   * were already delivered seq-less by the synchronous local emit) and deliver
   * only peer-replica events + catch-up replays — no same-replica double, no
   * health-flag fragility. See {@link wasLocallyPublished}.
   */
  eventId?: string;
}

/** The record a durable append writes; `eventId` makes the append idempotent. */
export interface DurableAppendRecord {
  companyId: string;
  type: LiveEventType;
  payload: LiveEventPayload;
  eventId: string;
}

/**
 * The durable-log store seam. The DB-backed implementation lives in
 * `live-event-log-store.ts` and is injected at boot via {@link setLiveEventLogStore};
 * unit tests exercise the pure helpers above without a DB, and the broker no-ops
 * cleanly when no store is wired (single-node local emit still works).
 */
export interface LiveEventLogStore {
  /** Append under tenant context, assigning the next per-company seq. Returns the seq (or null if not persisted). */
  append(record: DurableAppendRecord): Promise<number | null>;
  /** After-commit data-free wake to peer replicas. */
  notify(companyId: string, seq: number): Promise<void>;
  /** Rows with `seq > sinceSeq`, ascending — the replay/catch-up read. */
  since(companyId: string, sinceSeq: number, limit?: number): Promise<DurableLiveEvent[]>;
  /**
   * The lowest still-retained seq for a company (0 when nothing has been
   * trimmed). A `sinceSeq` below this floor forces the bounded snapshot fallback.
   */
  retentionFloor(companyId: string): Promise<number>;
  /**
   * The highest assigned seq for a company (0 when none). Used to anchor the
   * per-replica drainer on first sight so it fans only new events, never full
   * history.
   */
  currentSeq(companyId: string): Promise<number>;
  /**
   * OPTIONAL bounded-retention trim (defect #8). Delete log rows below
   * `currentSeq(company) − retainWindow` for every retained company (the concrete
   * store also folds in `extraCompanies` — the replica's active set — so the trim
   * is correct under FORCE-RLS on the distributed serving role). Returns the row
   * count deleted. The in-memory test store omits it.
   */
  trimRetention?(retainWindow: number, extraCompanies?: Iterable<string>): Promise<number>;
}

let liveEventLogStore: LiveEventLogStore | null = null;

// ── Robust pipeline model (no health flag) ────────────────────────────────────
//
// The synchronous same-replica `emitter.emit` ALWAYS delivers (seq-less,
// immediate, never dropped, never gated) — so a durable append that later FAILS
// (pool exhaustion, timeout, deadlock, failover, a non-superuser owner blocked by
// FORCE RLS) can never silently drop the event on the emitting replica. To avoid
// a same-replica DOUBLE (emitter copy + the seq-carrying durable copy the drainer
// pulls back), the drainer SUPPRESSES events whose `eventId` this replica just
// published — tracked in a bounded FIFO set below. Peer replicas never see these
// ids, so they deliver the durable copy normally (cross-replica delivery intact).
// If an id is evicted before the drainer processes it (extreme burst), the worst
// case is the acceptable idempotent transition-double — never a drop, never a
// stuck flag.

const LOCAL_PUBLISH_TRACK_MAX = 8_192;
const locallyPublishedIds = new Set<string>();
const locallyPublishedOrder: string[] = [];

function recordLocalPublish(eventId: string): void {
  if (locallyPublishedIds.has(eventId)) return;
  locallyPublishedIds.add(eventId);
  locallyPublishedOrder.push(eventId);
  if (locallyPublishedOrder.length > LOCAL_PUBLISH_TRACK_MAX) {
    const evicted = locallyPublishedOrder.shift();
    if (evicted !== undefined) locallyPublishedIds.delete(evicted);
  }
}

/**
 * Whether `eventId` was published by THIS replica (and already delivered seq-less
 * by the local emit). The per-replica drainer uses this to suppress the durable
 * copy of same-replica events. Per-process, so it is naturally per-replica.
 */
export function wasLocallyPublished(eventId: string | undefined): boolean {
  return eventId !== undefined && locallyPublishedIds.has(eventId);
}

/** Test seam: clear the local-publish tracking set between cases. */
export function __resetLocalPublishTrackingForTests(): void {
  locallyPublishedIds.clear();
  locallyPublishedOrder.length = 0;
}

/** Wire the durable-log store (boot). Passing null detaches it (tests/shutdown). */
export function setLiveEventLogStore(store: LiveEventLogStore | null): void {
  liveEventLogStore = store;
}

export function getLiveEventLogStore(): LiveEventLogStore | null {
  return liveEventLogStore;
}

/** Best-effort durable append + data-free NOTIFY. Never throws into the caller. */
async function persistDurableEvent(record: DurableAppendRecord): Promise<void> {
  const store = liveEventLogStore;
  if (!store) return;
  try {
    const seq = await store.append(record);
    if (seq === null) return;
    await store.notify(record.companyId, seq);
  } catch {
    // Degrade to single-replica realtime — the local emit already fired and the
    // DB stays authoritative; the reconnect cursor + safety poll recover later.
    // The event was NOT dropped anywhere it should have been delivered: the
    // emitter already delivered it to this replica's sockets.
  }
}

export function publishLiveEvent(input: {
  companyId: string;
  type: LiveEventType;
  payload?: LiveEventPayload;
}) {
  const event = toLiveEvent(input);
  // Same-replica fast path — unchanged, synchronous, no seq, ALWAYS delivered.
  emitter.emit(input.companyId, event);
  // Durable, cross-replica pipeline — best-effort, fire-and-forget.
  if (isDurableEligible(input.type) && liveEventLogStore) {
    const eventId = randomUUID();
    // Track BEFORE the async append so the drainer suppresses the same-replica
    // durable copy the moment it is pulled back (no race window where the emitter
    // copy and the durable copy both reach the socket).
    recordLocalPublish(eventId);
    void persistDurableEvent({
      companyId: input.companyId,
      type: input.type,
      payload: event.payload,
      eventId,
    });
  }
  return event;
}

export function subscribeCompanyLiveEvents(companyId: string, listener: LiveEventListener) {
  emitter.on(companyId, listener);
  return () => emitter.off(companyId, listener);
}

// ── Threads v1 Plan 7: per-thread scoping + envelope-RBAC fan-out ─────────────

/**
 * Pure envelope-RBAC filter. Reuses the Plan 2 canViewThread predicate so a
 * subscriber only survives if they could actually view the thread the event is
 * about. A non-participant never receives even a poke about a private/Unclaimed
 * thread.
 *
 * Subscribers must carry their own RBAC inputs ({ role, hasScopeAccess,
 * isParticipant }). See the CRITICAL AMENDMENT in registerThreadSubscriber:
 * these inputs are recomputed per event at fan-out, never cached.
 */
export function filterThreadEventRecipients<T extends ThreadViewer>(
  thread: { ownerUserId: string | null; visibility: ThreadVisibility },
  subscribers: T[],
): T[] {
  return subscribers.filter((s) => canViewThread(thread, s));
}

/**
 * Per-thread subscription registry: Map<threadId, Set<connection>>.
 *
 * The WS handler (server/src/realtime/live-events-ws.ts) owns the actual socket
 * connections and registers/unregisters a connection token here when it receives
 * a `{ subscribe: threadId }` / `{ unsubscribe: threadId }` client message. On a
 * thread.* event, the handler looks up the subscriber set, recomputes each
 * connection's { role, hasScopeAccess, isParticipant } against the live thread
 * row (NOT a cache), runs filterThreadEventRecipients, and sends only to the
 * survivors.
 *
 * Generic over the connection token type so the registry is decoupled from `ws`
 * and unit-testable.
 */
export class ThreadSubscriptionRegistry<Conn> {
  private byThread = new Map<string, Set<Conn>>();
  private byConn = new Map<Conn, Set<string>>();

  /** Subscribe a connection to a thread's events. Idempotent. */
  subscribe(threadId: string, conn: Conn): void {
    let conns = this.byThread.get(threadId);
    if (!conns) {
      conns = new Set();
      this.byThread.set(threadId, conns);
    }
    conns.add(conn);

    let threads = this.byConn.get(conn);
    if (!threads) {
      threads = new Set();
      this.byConn.set(conn, threads);
    }
    threads.add(threadId);
  }

  /** Unsubscribe a connection from a single thread. */
  unsubscribe(threadId: string, conn: Conn): void {
    const conns = this.byThread.get(threadId);
    if (conns) {
      conns.delete(conn);
      if (conns.size === 0) this.byThread.delete(threadId);
    }
    const threads = this.byConn.get(conn);
    if (threads) {
      threads.delete(threadId);
      if (threads.size === 0) this.byConn.delete(conn);
    }
  }

  /** Remove a connection from every thread it was subscribed to (on close). */
  removeConnection(conn: Conn): void {
    const threads = this.byConn.get(conn);
    if (!threads) return;
    for (const threadId of threads) {
      const conns = this.byThread.get(threadId);
      if (conns) {
        conns.delete(conn);
        if (conns.size === 0) this.byThread.delete(threadId);
      }
    }
    this.byConn.delete(conn);
  }

  /** All connections currently subscribed to a thread (empty array if none). */
  subscribers(threadId: string): Conn[] {
    const conns = this.byThread.get(threadId);
    return conns ? Array.from(conns) : [];
  }

  /** Whether a connection is subscribed to a given thread. */
  isSubscribed(threadId: string, conn: Conn): boolean {
    return this.byThread.get(threadId)?.has(conn) ?? false;
  }
}

/** A live event that targets a specific thread (its payload carries threadId). */
export function threadIdOf(event: LiveEvent): string | null {
  const tid = event.payload?.threadId;
  return typeof tid === "string" && tid.length > 0 ? tid : null;
}

const THREAD_EVENT_PREFIX = "thread.";

/** Whether a live event is a per-thread event that needs envelope-RBAC fan-out. */
export function isThreadEvent(event: LiveEvent): boolean {
  return event.type.startsWith(THREAD_EVENT_PREFIX);
}

// ── Threads v1 Plan 7: ephemeral presence + typing ───────────────────────────

/** Default presence TTL — a member is "here" for this long after their last heartbeat. */
export const PRESENCE_TTL_MS = 15_000;

export interface PresenceEntry {
  userId: string;
  lastSeen: number;
  typing?: boolean;
}

/**
 * Pure presence prune: keep only entries seen within ttlMs of `now`. Entries
 * exactly at the boundary are kept. The typing flag rides along untouched.
 */
export function prunePresence(
  entries: PresenceEntry[],
  now: number,
  ttlMs: number,
): PresenceEntry[] {
  return entries.filter((e) => now - e.lastSeen <= ttlMs);
}

/**
 * Ephemeral, in-memory per-thread presence roster. NOT persisted (no DB) — it
 * evaporates on restart, which is correct for "who's looking right now".
 * Keyed by threadId. Updated on a client presence/typing heartbeat and swept by
 * prunePresence. Broadcast goes through the same envelope-RBAC fan-out as other
 * thread.* events (the WS handler owns that), so a viewer never sees presence
 * for a thread they can't see.
 */
export class ThreadPresenceStore {
  private byThread = new Map<string, Map<string, PresenceEntry>>();

  /** Record/refresh a member's presence (and optional typing state) on a thread. */
  touch(threadId: string, userId: string, now: number, typing = false): void {
    let members = this.byThread.get(threadId);
    if (!members) {
      members = new Map();
      this.byThread.set(threadId, members);
    }
    members.set(userId, { userId, lastSeen: now, typing });
  }

  /** Current (unpruned) roster for a thread. */
  list(threadId: string): PresenceEntry[] {
    const members = this.byThread.get(threadId);
    return members ? Array.from(members.values()) : [];
  }

  /**
   * Sweep one thread's roster against the TTL, dropping stale members.
   * Returns the surviving roster (also reflected in the store).
   */
  sweep(threadId: string, now: number, ttlMs = PRESENCE_TTL_MS): PresenceEntry[] {
    const members = this.byThread.get(threadId);
    if (!members) return [];
    const survivors = prunePresence(Array.from(members.values()), now, ttlMs);
    if (survivors.length === 0) {
      this.byThread.delete(threadId);
      return [];
    }
    const next = new Map<string, PresenceEntry>();
    for (const s of survivors) next.set(s.userId, s);
    this.byThread.set(threadId, next);
    return survivors;
  }

  /** All thread ids that currently have any presence (for the sweep interval). */
  threadIds(): string[] {
    return Array.from(this.byThread.keys());
  }

  /** Drop a member from a thread (e.g. on disconnect). Returns survivors. */
  remove(threadId: string, userId: string): PresenceEntry[] {
    const members = this.byThread.get(threadId);
    if (!members) return [];
    members.delete(userId);
    if (members.size === 0) {
      this.byThread.delete(threadId);
      return [];
    }
    return Array.from(members.values());
  }
}

/** Process-wide ephemeral presence store shared by the WS handler. */
export const threadPresence = new ThreadPresenceStore();

// ── P2-T1: thread-scoped agent "working" presence ────────────────────────────
//
// A PARALLEL channel to ThreadPresenceStore (which is humans-only by design —
// see live-events-ws.ts). Agents that are running a deliverable for a thread
// appear here so the chat can show "Engineer working" scoped to the right
// thread. NO TTL — entries are cleared explicitly when the run finishes/fails
// (the heartbeat run's finally block). Ephemeral in-memory; evaporates on
// restart, which is correct for "who's working right now".

export interface WorkingAgentEntry {
  agentId: string;
  name: string;
  /**
   * Phase 5 (Task 5.2): humanized activity string ("researching", "writing the
   * plan", "creating an artifact", …) derived from the agent's role so the chat
   * pill can read "<Agent> is <activity>…". Optional + back-compat: the
   * heartbeat caller (heartbeat.ts:2611) does not pass it, so the field is
   * simply absent for task-deliverable runs.
   */
  activity?: string;
}

export class ThreadWorkingAgentsStore {
  private byThread = new Map<string, Map<string, WorkingAgentEntry>>();

  /**
   * Mark an agent as working on a thread. Idempotent per (threadId, agentId).
   * `activity` (optional) carries the humanized status for the chat pill; when
   * omitted the entry has no activity (back-compat with the heartbeat caller).
   */
  add(threadId: string, agentId: string, name: string, activity?: string): void {
    let agents = this.byThread.get(threadId);
    if (!agents) {
      agents = new Map();
      this.byThread.set(threadId, agents);
    }
    agents.set(agentId, activity === undefined ? { agentId, name } : { agentId, name, activity });
  }

  /** Clear an agent from a thread (run finished/failed). Returns survivors. */
  remove(threadId: string, agentId: string): WorkingAgentEntry[] {
    const agents = this.byThread.get(threadId);
    if (!agents) return [];
    agents.delete(agentId);
    if (agents.size === 0) {
      this.byThread.delete(threadId);
      return [];
    }
    return Array.from(agents.values());
  }

  /** Current working-agent roster for a thread. */
  list(threadId: string): WorkingAgentEntry[] {
    const agents = this.byThread.get(threadId);
    return agents ? Array.from(agents.values()) : [];
  }
}

/** Process-wide ephemeral working-agents store shared by the WS handler + heartbeat. */
export const threadWorkingAgents = new ThreadWorkingAgentsStore();

/**
 * Shared thread.presence broadcaster. Reads BOTH rosters (human presence +
 * working agents) so neither clobbers the other on the client (the client
 * replaces the whole roster per event). Sweeps human presence against the TTL;
 * working agents have no TTL (explicit clear).
 *
 * `now` is passed in (callers stamp it) to keep this testable.
 */
export function broadcastThreadPresence(companyId: string, threadId: string, now: number): void {
  const members = threadPresence.sweep(threadId, now);
  const workingAgents = threadWorkingAgents.list(threadId);
  publishLiveEvent({
    companyId,
    type: "thread.presence",
    payload: { threadId, members, workingAgents },
  });
}

// ── Thread chat experience Phase 5 (Task 5.6): issue.status_changed ───────────
//
// A task's status changed. Unlike thread.* events, this is COMPANY-broadcast
// (NOT the per-thread envelope-RBAC fan-out) — the kanban / Crew Board are
// company-scoped surfaces, so the event rides the same company-broadcast path
// as heartbeat/agent events. The single chokepoint helper is called at EVERY
// crew status-move site (issueService.update's status path, checkout's
// →in_progress write, and the runner's silent-stuck →todo release) so the board
// can move the card live regardless of which path moved it. BEST-EFFORT at the
// call sites: a publish failure must never break the underlying write.
export function publishIssueStatusChanged(companyId: string, issueId: string, status: string): void {
  publishLiveEvent({
    companyId,
    type: "issue.status_changed",
    payload: { companyId, issueId, status },
  });
}
