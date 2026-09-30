import { createHash } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { createRequire } from "node:module";
import type { Duplex } from "node:stream";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import {
  agentApiKeys,
  agents,
  companyMemberships,
  instanceUserRoles,
} from "@armyofagents/db";
import type { DeploymentMode, LiveEvent } from "@armyofagents/shared";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";
import { logger } from "../middleware/logger.js";
import {
  subscribeCompanyLiveEvents,
  publishLiveEvent,
  ThreadSubscriptionRegistry,
  filterThreadEventRecipients,
  isThreadEvent,
  threadIdOf,
  threadPresence,
  PRESENCE_TTL_MS,
  broadcastThreadPresence,
} from "../services/live-events.js";
import { threadService } from "../services/threads.js";
import { permissionService } from "../services/permissions.js";
import { hubItemsService } from "../services/hub-items.js";
import {
  hasActiveAgentSocketAuthorization,
  hasActiveCloudMembership,
  type UpgradeSocketActorContext,
} from "../services/upgrade-socket-authorization.js";

export { hasActiveCloudMembership } from "../services/upgrade-socket-authorization.js";

interface WsSocket {
  readyState: number;
  ping(): void;
  send(data: string): void;
  terminate(): void;
  close(code?: number, reason?: string): void;
  on(event: "pong", listener: () => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  on(event: "message", listener: (data: unknown) => void): void;
}

interface WsServer {
  clients: Set<WsSocket>;
  on(
    event: "connection",
    listener: (socket: WsSocket, req: IncomingMessage) => void
  ): void;
  on(event: "close", listener: () => void): void;
  handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    callback: (ws: WsSocket) => void
  ): void;
  emit(event: "connection", ws: WsSocket, req: IncomingMessage): boolean;
}

const require = createRequire(import.meta.url);
const { WebSocket, WebSocketServer } = require("ws") as {
  WebSocket: { OPEN: number };
  WebSocketServer: new (opts: { noServer: boolean }) => WsServer;
};

export type UpgradeContext = UpgradeSocketActorContext;

interface IncomingMessageWithContext extends IncomingMessage {
  aoaUpgradeContext?: UpgradeContext;
}

function isHubEvent(event: LiveEvent): boolean {
  return event.type.startsWith("hub.");
}

function hubItemIdOf(event: LiveEvent): string | null {
  const itemId = event.payload?.itemId;
  return typeof itemId === "string" && itemId.length > 0 ? itemId : null;
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function rejectUpgrade(socket: Duplex, statusLine: string, message: string) {
  const safe = message.replace(/[\r\n]+/g, " ").trim();
  socket.write(
    `HTTP/1.1 ${statusLine}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${safe}`
  );
  socket.destroy();
}

function parseCompanyId(pathname: string) {
  const match = pathname.match(/^\/api\/companies\/([^/]+)\/events\/ws$/);
  if (!match) return null;

  try {
    return decodeURIComponent(match[1] ?? "");
  } catch {
    return null;
  }
}

function parseBearerToken(rawAuth: string | string[] | undefined) {
  const auth = Array.isArray(rawAuth) ? rawAuth[0] : rawAuth;
  if (!auth) return null;
  if (!auth.toLowerCase().startsWith("bearer ")) return null;
  const token = auth.slice("bearer ".length).trim();
  return token.length > 0 ? token : null;
}

function headersFromIncomingMessage(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, raw] of Object.entries(req.headers)) {
    if (!raw) continue;
    if (Array.isArray(raw)) {
      for (const value of raw) headers.append(key, value);
      continue;
    }
    headers.set(key, raw);
  }
  return headers;
}

/**
 * The `cloud_auth` tenant-isolation predicate: a user may access a company iff
 * they hold BOTH an active organization membership for the company's owning
 * organization AND an active company membership. A company membership WITHOUT an
 * org membership is DENIED (the deliberate tenant invariant), and a company with
 * no owning organization is DENIED. This is the SAME predicate the cloud_auth
 * WebSocket handshake enforces, extracted so the connection membership-sweep can
 * re-run it against already-open sockets (bounded-staleness re-validation).
 *
 * ONLY valid for `cloud_auth`. The `authenticated` handshake admits users via
 * instance_admin OR company membership with NO org requirement — do NOT call
 * this helper outside cloud_auth.
 */
export async function enforceLiveEventSocketAuthorization(
  db: Db,
  socket: Pick<WsSocket, "readyState" | "close">,
  context: UpgradeContext,
  deploymentMode: DeploymentMode,
  onError?: (error: unknown) => void
): Promise<boolean> {
  try {
    const authorized =
      context.actorType === "agent"
        ? await hasActiveAgentSocketAuthorization(db, context)
        : deploymentMode === "cloud_auth"
        ? await hasActiveCloudMembership(db, context.companyId, context.actorId)
        : true;
    if (!authorized && socket.readyState === WebSocket.OPEN) {
      socket.close(1008, "authorization revoked");
    }
    return authorized;
  } catch (error) {
    try {
      onError?.(error);
    } catch {
      // Reporting must not defeat the fail-closed authorization boundary.
    }
    if (socket.readyState === WebSocket.OPEN) {
      socket.close(1011, "authorization re-validation failed");
    }
    return false;
  }
}

/** Start at most one authorization recheck per socket until it settles. */
export function startSocketAuthorizationCheck<Socket>(
  socket: Socket,
  inFlight: Set<Socket>,
  check: () => Promise<unknown>
): boolean {
  if (inFlight.has(socket)) return false;
  inFlight.add(socket);
  void check().finally(() => {
    inFlight.delete(socket);
  });
  return true;
}

export async function subscribeToAuthorizedThread<Conn>(input: {
  registry: ThreadSubscriptionRegistry<Conn>;
  connection: Conn;
  threadId: string;
  authorize: () => Promise<boolean>;
  canCommit?: () => boolean;
}): Promise<boolean> {
  if (!(await input.authorize())) return false;
  if (input.canCommit && !input.canCommit()) return false;
  input.registry.subscribe(input.threadId, input.connection);
  return true;
}

export async function touchAuthorizedThreadPresence<Conn>(input: {
  registry: ThreadSubscriptionRegistry<Conn>;
  connection: Conn;
  threadId: string;
  actorId: string;
  companyId: string;
  typing: boolean;
  now: number;
  authorize: () => Promise<boolean>;
  canCommit?: () => boolean;
  threadCompany: Map<string, string>;
  touch: (
    threadId: string,
    actorId: string,
    now: number,
    typing: boolean
  ) => void;
  broadcast: (companyId: string, threadId: string, now: number) => void;
}): Promise<boolean> {
  if (!input.registry.isSubscribed(input.threadId, input.connection))
    return false;
  if (!(await input.authorize())) return false;
  if (input.canCommit && !input.canCommit()) return false;
  if (!input.registry.isSubscribed(input.threadId, input.connection))
    return false;
  const knownCompanyId = input.threadCompany.get(input.threadId);
  if (knownCompanyId && knownCompanyId !== input.companyId) return false;

  input.threadCompany.set(input.threadId, input.companyId);
  input.touch(input.threadId, input.actorId, input.now, input.typing);
  input.broadcast(input.companyId, input.threadId, input.now);
  return true;
}

export async function authorizeUpgrade(
  db: Db,
  req: IncomingMessage,
  companyId: string,
  url: URL,
  opts: {
    deploymentMode: DeploymentMode;
    resolveSessionFromHeaders?: (
      headers: Headers
    ) => Promise<BetterAuthSessionResult | null>;
    /**
     * Exact trusted origins (scheme://host[:port], no wildcards) — the same
     * allowlist better-auth uses. Consulted ONLY on the cookie/session branch
     * for the CSWSH Origin check below.
     */
    trustedOrigins?: string[];
  }
): Promise<UpgradeContext | null> {
  const queryToken = url.searchParams.get("token")?.trim() ?? "";
  const authToken = parseBearerToken(req.headers.authorization);
  const token = authToken ?? (queryToken.length > 0 ? queryToken : null);

  // Browser board context has no bearer token in local_trusted and authenticated modes.
  if (!token) {
    if (opts.deploymentMode === "local_trusted") {
      return {
        companyId,
        actorType: "board",
        actorId: "board",
      };
    }

    // Cookie/session (board) path for the two multi-user modes. `cloud_auth`
    // was previously excluded here (only `authenticated` was allowed through),
    // so a legitimate cloud board user opening the live-events WebSocket with a
    // session cookie fell through to `return null` → 403 and lost all
    // realtime/presence/run updates.
    if (
      (opts.deploymentMode !== "authenticated" &&
        opts.deploymentMode !== "cloud_auth") ||
      !opts.resolveSessionFromHeaders
    ) {
      return null;
    }

    // CSWSH defense-in-depth: cookie-authenticated WebSocket upgrades must carry
    // a trusted Origin. Browsers always send Origin on WS handshakes, so a
    // missing/empty Origin here is untrusted (agents authenticate with a
    // bearer/query token, which skips this branch). `trustedOrigins` is the
    // exact allowlist better-auth uses, so any deploy where sign-in works
    // already trusts the board origin.
    const origin = req.headers.origin;
    if (!origin || !(opts.trustedOrigins ?? []).includes(origin)) {
      return null;
    }

    const session = await opts.resolveSessionFromHeaders(
      headersFromIncomingMessage(req)
    );
    const userId = session?.user?.id;
    if (!userId) return null;

    if (opts.deploymentMode === "cloud_auth") {
      // Mirror authorizeCompanyUpgrade (services/upgrade-auth.ts) tenant-isolation
      // semantics: allow iff the actor holds BOTH an active organization
      // membership for the company's owning organization AND an active company
      // membership. A company membership WITHOUT an org membership is DENIED (the
      // deliberate tenant invariant). No instance_admin bypass here — the
      // authenticated branch below keeps its own instance_admin rule. Extracted
      // into hasActiveCloudMembership so the connection membership-sweep can
      // re-run the exact same predicate against already-open sockets.
      if (!(await hasActiveCloudMembership(db, companyId, userId))) return null;

      return {
        companyId,
        actorType: "board",
        actorId: userId,
      };
    }

    // authenticated: instance_admin OR an active company membership (unchanged).
    const [roleRow, memberships] = await Promise.all([
      db
        .select({ id: instanceUserRoles.id })
        .from(instanceUserRoles)
        .where(
          and(
            eq(instanceUserRoles.userId, userId),
            eq(instanceUserRoles.role, "instance_admin")
          )
        )
        .then((rows) => rows[0] ?? null),
      db
        .select({ companyId: companyMemberships.companyId })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, userId),
            eq(companyMemberships.status, "active")
          )
        ),
    ]);

    const hasCompanyMembership = memberships.some(
      (row) => row.companyId === companyId
    );
    if (!roleRow && !hasCompanyMembership) return null;

    return {
      companyId,
      actorType: "board",
      actorId: userId,
    };
  }

  const tokenHash = hashToken(token);
  const key = await db
    .select()
    .from(agentApiKeys)
    .where(
      and(eq(agentApiKeys.keyHash, tokenHash), isNull(agentApiKeys.revokedAt))
    )
    .then((rows) => rows[0] ?? null);

  if (!key || key.companyId !== companyId) {
    return null;
  }

  // Mirror services/upgrade-auth.ts:182-195: a valid key is not enough — a
  // terminated (key-revocation desync) or pending_approval (D6 board-approval
  // gate) agent must not open the realtime bus.
  const agent = await db
    .select()
    .from(agents)
    .where(eq(agents.id, key.agentId))
    .then((rows) => rows[0] ?? null);

  if (
    !agent ||
    agent.companyId !== key.companyId ||
    agent.status === "terminated" ||
    agent.status === "pending_approval"
  ) {
    return null;
  }

  await db
    .update(agentApiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(agentApiKeys.id, key.id));

  return {
    companyId,
    actorType: "agent",
    actorId: key.agentId,
    keyId: key.id,
  };
}

/**
 * WS board-role decision. Mirrors the REST data-plane clamp in
 * middleware/auth.ts (`isInstanceAdmin: cloud ? false : isOperator`): an
 * `instance_admin` is a founder for tenant fan-out ONLY in local_trusted and
 * authenticated — in cloud_auth the real per-company role is used, so an
 * operator who is only a team_member does not receive private/unclaimed threads
 * or non-owned hub items over the event bus.
 */
export function resolveBoardRoleForMode(
  mode: DeploymentMode,
  hasInstanceAdminRow: boolean,
  effectiveRole: "founder" | "team_lead" | "team_member"
): "founder" | "team_lead" | "team_member" {
  if (mode === "local_trusted") return "founder";
  if (mode !== "cloud_auth" && hasInstanceAdminRow) return "founder";
  return effectiveRole;
}

export function setupLiveEventsWebSocketServer(
  server: HttpServer,
  db: Db,
  opts: {
    deploymentMode: DeploymentMode;
    resolveSessionFromHeaders?: (
      headers: Headers
    ) => Promise<BetterAuthSessionResult | null>;
    trustedOrigins?: string[];
  }
) {
  const wss = new WebSocketServer({ noServer: true });
  const cleanupByClient = new Map<WsSocket, () => void>();
  const aliveByClient = new Map<WsSocket, boolean>();
  // Per-open-socket upgrade context, so the cloud_auth membership sweep can
  // re-validate each board socket's tenant membership after the handshake.
  const contextByClient = new Map<WsSocket, UpgradeContext>();
  const authorizationCheckInFlight = new Set<WsSocket>();

  // Plan 7: per-thread subscription registry. A connection only receives
  // thread.* events for threads it has explicitly subscribed to (via a
  // { subscribe: threadId } client message) AND that pass envelope RBAC.
  const threadRegistry = new ThreadSubscriptionRegistry<WsSocket>();
  const tSvc = threadService(db);
  const perms = permissionService(db);
  const hubSvc = hubItemsService(db);

  // Plan 7 presence: remember which company a thread belongs to (learned from
  // the heartbeating connection's context) so the sweep can re-broadcast to the
  // right company bus. Also track which (thread,user) each connection owns so we
  // can clear presence on disconnect.
  const threadCompany = new Map<string, string>();
  const presenceByConn = new Map<WsSocket, Set<string>>(); // socket -> "threadId userId"

  /** Broadcast a thread's current presence roster (humans + working agents). */
  function broadcastPresence(companyId: string, threadId: string, now: number) {
    broadcastThreadPresence(companyId, threadId, now);
  }

  /**
   * Resolve a board connection's effective role for envelope-RBAC checks.
   * In local_trusted mode the synthetic "board" actor is implicitly trusted
   * (loopback boundary) → treat as founder, matching buildActor's
   * local_implicit → founder rule. Instance admins are also founders EXCEPT in
   * cloud_auth, where the real per-company role is used (see
   * resolveBoardRoleForMode for the data-plane parity rationale).
   */
  async function resolveBoardRole(
    actorId: string,
    companyId: string
  ): Promise<"founder" | "team_lead" | "team_member"> {
    if (opts.deploymentMode === "local_trusted") return "founder";
    if (opts.deploymentMode !== "cloud_auth") {
      const adminRow = await db
        .select({ id: instanceUserRoles.id })
        .from(instanceUserRoles)
        .where(
          and(
            eq(instanceUserRoles.userId, actorId),
            eq(instanceUserRoles.role, "instance_admin")
          )
        )
        .then((rows) => rows[0] ?? null);
      if (adminRow)
        return resolveBoardRoleForMode(
          opts.deploymentMode,
          true,
          "team_member"
        );
    }
    const effectiveRole = await perms.getEffectiveRole(companyId, actorId);
    return resolveBoardRoleForMode(opts.deploymentMode, false, effectiveRole);
  }

  /**
   * Canonical live thread visibility decision, recomputed at subscription and
   * again per event. Agent visibility uses agent participant rows, matching the
   * REST contract, so a stale subscription cannot outlive participation.
   */
  async function mayContextAccessThread(
    context: UpgradeContext,
    threadId: string
  ): Promise<boolean> {
    const role =
      context.actorType === "agent"
        ? "team_member"
        : await resolveBoardRole(context.actorId, context.companyId);
    const resolved = await tSvc.resolveViewerForThread(
      context.companyId,
      threadId,
      {
        userId: context.actorId,
        role,
        principalType: context.actorType === "agent" ? "agent" : "user",
      }
    );
    if (!resolved) return false;
    return (
      filterThreadEventRecipients(resolved.thread, [resolved.viewer]).length > 0
    );
  }

  async function mayReceiveThreadEvent(
    socket: WsSocket,
    context: UpgradeContext,
    event: LiveEvent
  ): Promise<boolean> {
    const threadId = threadIdOf(event);
    if (!threadId) return false; // malformed thread event — fail closed
    if (!threadRegistry.isSubscribed(threadId, socket)) return false;
    return mayContextAccessThread(context, threadId);
  }

  /**
   * Validate client-supplied subscription/presence thread ids before they can
   * enter any process-global registry. Board viewers must pass the same live
   * envelope RBAC as event fan-out. Agents resolve participation using
   * principalType=agent, matching the canonical REST thread decision.
   */
  async function maySubscribeToThread(
    context: UpgradeContext,
    threadId: string
  ): Promise<boolean> {
    return mayContextAccessThread(context, threadId);
  }

  async function mayReceiveHubEvent(
    context: UpgradeContext,
    event: LiveEvent
  ): Promise<boolean> {
    if (context.actorType !== "board") return false;

    const itemId = hubItemIdOf(event);
    if (!itemId) {
      return (
        event.type === "hub.counts.changed" ||
        event.type === "hub.digest.changed"
      );
    }

    const role = await resolveBoardRole(context.actorId, context.companyId);
    const item = await hubSvc.getVisible(context.companyId, {
      hubItemId: itemId,
      actorUserId: context.actorId,
      role,
      status: "any",
    });
    return Boolean(item);
  }

  const pingInterval = setInterval(() => {
    for (const socket of wss.clients) {
      if (!aliveByClient.get(socket)) {
        socket.terminate();
        continue;
      }
      aliveByClient.set(socket, false);
      socket.ping();
    }
  }, 30000);

  // Plan 7: sweep stale presence on a short interval. When a thread's roster
  // shrinks (a member went silent past the TTL), re-broadcast so viewers see
  // them disappear. We only emit when the swept roster actually changed to
  // avoid chatty no-op pokes.
  const presenceSweepInterval = setInterval(() => {
    const now = Date.now();
    for (const threadId of threadPresence.threadIds()) {
      const before = threadPresence.list(threadId).length;
      const after = threadPresence.sweep(threadId, now);
      if (after.length !== before) {
        const companyId = threadCompany.get(threadId);
        if (companyId) {
          publishLiveEvent({
            companyId,
            type: "thread.presence",
            payload: { threadId, members: after },
          });
        }
        if (after.length === 0) threadCompany.delete(threadId);
      }
    }
  }, Math.max(1000, Math.floor(PRESENCE_TTL_MS / 3)));

  // Bounded-staleness authorization re-validation. Cloud board sockets re-run
  // the active Organization + Company membership predicate. Agent sockets in
  // every mode re-check the exact key used at handshake plus the agent's live
  // company and status. Non-cloud board sockets remain unchanged. The socket's
  // own close handler owns subscription and map teardown.
  const membershipSweepInterval = setInterval(() => {
    for (const [socket, ctx] of contextByClient) {
      startSocketAuthorizationCheck(socket, authorizationCheckInFlight, () =>
        enforceLiveEventSocketAuthorization(
          db,
          socket,
          ctx,
          opts.deploymentMode,
          (err) => {
            logger.warn(
              { err, companyId: ctx.companyId },
              "live-events authorization re-validation failed for a socket"
            );
          }
        )
      );
    }
  }, 30000);

  wss.on("connection", (socket: WsSocket, req: IncomingMessage) => {
    const context = (req as IncomingMessageWithContext).aoaUpgradeContext;
    if (!context) {
      socket.close(1008, "missing context");
      return;
    }

    const unsubscribe = subscribeCompanyLiveEvents(
      context.companyId,
      (event) => {
        if (socket.readyState !== WebSocket.OPEN) return;
        if (isHubEvent(event)) {
          void mayReceiveHubEvent(context, event)
            .then((ok) => {
              if (ok && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify(event));
              }
            })
            .catch((err) => {
              logger.warn(
                { err, companyId: context.companyId },
                "hub event fan-out failed"
              );
            });
          return;
        }
        // Non-thread, non-hub events stay company-wide (unchanged behavior).
        if (!isThreadEvent(event)) {
          socket.send(JSON.stringify(event));
          return;
        }
        // Thread events: envelope-RBAC scoped to per-thread subscribers.
        void mayReceiveThreadEvent(socket, context, event)
          .then((ok) => {
            if (ok && socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify(event));
            }
          })
          .catch((err) => {
            logger.warn(
              { err, companyId: context.companyId },
              "thread event fan-out failed"
            );
          });
      }
    );

    cleanupByClient.set(socket, unsubscribe);
    aliveByClient.set(socket, true);
    contextByClient.set(socket, context);

    socket.on("pong", () => {
      aliveByClient.set(socket, true);
    });

    let messageQueue = Promise.resolve();
    socket.on("message", (data: unknown) => {
      messageQueue = messageQueue
        .then(async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(typeof data === "string" ? data : String(data));
          } catch {
            return; // ignore non-JSON client frames
          }
          if (typeof parsed !== "object" || parsed === null) return;
          const msg = parsed as Record<string, unknown>;

          if (typeof msg.subscribe === "string" && msg.subscribe.length > 0) {
            const subscribed = await subscribeToAuthorizedThread({
              registry: threadRegistry,
              connection: socket,
              threadId: msg.subscribe,
              authorize: () =>
                maySubscribeToThread(context, msg.subscribe as string),
              canCommit: () => socket.readyState === WebSocket.OPEN,
            });
            if (!subscribed) return;
            if (socket.readyState !== WebSocket.OPEN) return;
            return;
          }
          if (
            typeof msg.unsubscribe === "string" &&
            msg.unsubscribe.length > 0
          ) {
            threadRegistry.unsubscribe(msg.unsubscribe, socket);
            return;
          }

          // Plan 7 presence/typing heartbeat. Only humans (board) appear in the
          // presence roster — agents have their own "working" indicator
          // (agent.status). We require an active subscription so a client can't poke
          // presence for a thread it isn't viewing (the broadcast itself is also
          // envelope-RBAC filtered at fan-out).
          if (typeof msg.presence === "string" && msg.presence.length > 0) {
            const threadId = msg.presence;
            if (context.actorType !== "board") return;
            const now = Date.now();
            const touched = await touchAuthorizedThreadPresence({
              registry: threadRegistry,
              connection: socket,
              threadId,
              actorId: context.actorId,
              companyId: context.companyId,
              typing: msg.typing === true,
              now,
              authorize: () => maySubscribeToThread(context, threadId),
              canCommit: () => socket.readyState === WebSocket.OPEN,
              threadCompany,
              touch: (id, actorId, touchedAt, typing) =>
                threadPresence.touch(id, actorId, touchedAt, typing),
              broadcast: broadcastPresence,
            });
            if (!touched || socket.readyState !== WebSocket.OPEN) return;
            let owned = presenceByConn.get(socket);
            if (!owned) {
              owned = new Set();
              presenceByConn.set(socket, owned);
            }
            owned.add(`${threadId} ${context.actorId}`);
            return;
          }
        })
        .catch((err) => {
          logger.warn(
            { err, companyId: context.companyId },
            "live websocket client message authorization failed"
          );
        });
    });

    socket.on("close", () => {
      const cleanup = cleanupByClient.get(socket);
      if (cleanup) cleanup();
      cleanupByClient.delete(socket);
      aliveByClient.delete(socket);
      contextByClient.delete(socket);
      authorizationCheckInFlight.delete(socket);
      threadRegistry.removeConnection(socket);

      // Plan 7: drop this connection's presence and notify the affected threads
      // so other viewers see them leave promptly (rather than waiting for TTL).
      const owned = presenceByConn.get(socket);
      if (owned) {
        const now = Date.now();
        for (const key of owned) {
          const sep = key.indexOf(" ");
          const threadId = key.slice(0, sep);
          const userId = key.slice(sep + 1);
          threadPresence.remove(threadId, userId);
          const companyId = threadCompany.get(threadId);
          if (companyId) broadcastPresence(companyId, threadId, now);
        }
        presenceByConn.delete(socket);
      }
    });

    socket.on("error", (err: Error) => {
      logger.warn(
        { err, companyId: context.companyId },
        "live websocket client error"
      );
    });
  });

  wss.on("close", () => {
    clearInterval(pingInterval);
    clearInterval(presenceSweepInterval);
    clearInterval(membershipSweepInterval);
  });

  server.on("upgrade", (req, socket, head) => {
    if (!req.url) {
      rejectUpgrade(socket, "400 Bad Request", "missing url");
      return;
    }

    const url = new URL(req.url, "http://localhost");
    const companyId = parseCompanyId(url.pathname);
    if (!companyId) {
      socket.destroy();
      return;
    }

    void authorizeUpgrade(db, req, companyId, url, {
      deploymentMode: opts.deploymentMode,
      resolveSessionFromHeaders: opts.resolveSessionFromHeaders,
      trustedOrigins: opts.trustedOrigins,
    })
      .then((context) => {
        if (!context) {
          rejectUpgrade(socket, "403 Forbidden", "forbidden");
          return;
        }

        const reqWithContext = req as IncomingMessageWithContext;
        reqWithContext.aoaUpgradeContext = context;

        wss.handleUpgrade(req, socket, head, (ws: WsSocket) => {
          wss.emit("connection", ws, reqWithContext);
        });
      })
      .catch((err) => {
        logger.error(
          { err, path: req.url },
          "failed websocket upgrade authorization"
        );
        rejectUpgrade(socket, "500 Internal Server Error", "upgrade failed");
      });
  });

  return wss;
}
