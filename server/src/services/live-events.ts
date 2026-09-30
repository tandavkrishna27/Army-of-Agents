import { EventEmitter } from "node:events";
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

export function publishLiveEvent(input: {
  companyId: string;
  type: LiveEventType;
  payload?: LiveEventPayload;
}) {
  const event = toLiveEvent(input);
  emitter.emit(input.companyId, event);
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
