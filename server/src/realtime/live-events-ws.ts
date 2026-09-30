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
  getLiveEventLogStore,
} from "../services/live-events.js";
import {
  SocketSeqCursor,
  filterAuthorizedReplay,
  needsSnapshotFallback,
  resolveBackpressure,
  orderReplayBuffer,
  replayTruncatedBeyondPage,
  parseSinceSeq,
  buildSnapshotResumeFrame,
  DEFAULT_REPLAY_LIMIT,
  DEFAULT_REPLAY_BUFFER_CAP,
} from "./live-event-catchup.js";
import { threadService } from "../services/threads.js";
import {
  recordUpgradeDenial,
  type LiveEventsUpgradeDenialReason,
} from "./live-events-denial-audit.js";
import {
  recordTenantlessUpgradeDenial,
  type LiveEventsUpgradeUnattributedReason,
} from "./live-events-tenantless-denial-audit.js";
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
  /** ws-native outbound buffer depth (bytes) — MIG-003 backpressure high-water-mark. */
  bufferedAmount?: number;
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
// proxy-addr is the exact resolver Express uses for `req.ip`. The WS upgrade
// handler runs on the raw Node `req` (it never passes through the Express
// request pipeline, so there is no `req.ip`), so we resolve the client IP here
// with the SAME library + the SAME `trust proxy` setting the REST paths use.
const proxyAddr = require("proxy-addr") as {
  (
    req: IncomingMessage,
    trust: (addr: string, i: number) => boolean,
  ): string | undefined;
  compile(val: string | string[]): (addr: string, i: number) => boolean;
};

/**
 * AoA's `trust proxy` setting (`config.trustProxy`: boolean | number | CIDR
 * list) is the value `app.set("trust proxy", …)` installs in app.ts. This
 * mirrors Express's own `compileTrust` (express/lib/utils.js) EXACTLY so the
 * client IP derived on the WS upgrade equals the `req.ip` the REST denial paths
 * use:
 *   - a function → used as-is
 *   - `true`            → trust every hop (the forwarded chain's original client)
 *   - a hop count `N`   → trust the first N hops from the socket
 *   - a string / CIDR[] → proxy-addr subnet trust
 *   - anything falsy (`false` / `0` / `[]` / unset) → trust NOTHING, i.e. the
 *     socket address with X-Forwarded-For IGNORED. This is the security-critical
 *     default: with no configured trusted proxy an attacker MUST NOT be able to
 *     forge the source key via a spoofed X-Forwarded-For.
 */
function compileTrustProxy(
  trustProxy: unknown,
): (addr: string, i: number) => boolean {
  if (typeof trustProxy === "function") {
    return trustProxy as (addr: string, i: number) => boolean;
  }
  if (trustProxy === true) return () => true;
  if (typeof trustProxy === "number") {
    const hops = trustProxy;
    return (_addr, i) => i < hops;
  }
  const list =
    typeof trustProxy === "string"
      ? trustProxy.split(/ *, */)
      : Array.isArray(trustProxy)
        ? (trustProxy as string[])
        : [];
  return proxyAddr.compile(list);
}

/**
 * Resolve a request's client IP under the configured trust-proxy policy, exactly
 * as Express `req.ip` does. Compiled trust functions are memoized per setting
 * value (the process's `config.trustProxy` is stable) so a denial flood does not
 * re-parse the CIDR list on every hit.
 */
let cachedTrust: {
  key: unknown;
  fn: (addr: string, i: number) => boolean;
} | null = null;
function resolveClientIp(
  req: IncomingMessage,
  trustProxy: unknown,
): string | null {
  try {
    if (!cachedTrust || cachedTrust.key !== trustProxy) {
      cachedTrust = { key: trustProxy, fn: compileTrustProxy(trustProxy) };
    }
    const addr = proxyAddr(req, cachedTrust.fn);
    if (typeof addr === "string" && addr.length > 0) return addr;
  } catch {
    // A malformed X-Forwarded-For (or any resolver hiccup) must not defeat the
    // deny path or its bound — fall back to the raw socket address.
  }
  const raw = req.socket?.remoteAddress;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

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

/**
 * The COARSE source key for the tenant-less upgrade denial bound: the refused
 * upgrade's CLIENT IP, resolved under the configured trust-proxy policy exactly
 * as Express `req.ip` does. Behind Cloudflare/ALB/nginx the socket's
 * `remoteAddress` is the PROXY's address — so keying on it would collapse every
 * WS denial (from every client) into ONE per-surface bucket, letting a single
 * caller consume the whole per-source allowance for everyone. We therefore
 * resolve the trusted-proxy client IP (`X-Forwarded-For`) — but ONLY when a
 * trusted proxy is configured; with none, we key on the socket address and
 * IGNORE `X-Forwarded-For` so an attacker cannot forge the source key to evade
 * the per-source cap. It remains the one identifier on a refused upgrade an
 * attacker cannot cheaply rotate (unlike the caller-supplied company path
 * segment). `null` when the transport exposes nothing — those hits share a
 * single bucket per surface, the strongest bound.
 */
export function upgradeSourceKey(
  req: IncomingMessage,
  trustProxy: unknown,
): string | null {
  return resolveClientIp(req, trustProxy);
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
    /**
     * The app's `trust proxy` setting (`config.trustProxy`), used to resolve the
     * client IP for the tenant-less denial source key exactly as Express
     * `req.ip` does. Absent/falsy ⇒ trust nothing ⇒ the socket address.
     */
    trustProxy?: boolean | number | string[];
  }
): Promise<UpgradeContext | null> {
  const queryToken = url.searchParams.get("token")?.trim() ?? "";
  const authToken = parseBearerToken(req.headers.authorization);
  const token = authToken ?? (queryToken.length > 0 ? queryToken : null);

  // ★ DE-21 / E0-F013 Decision 3.2 — the operator-only sink for the SIX branches
  // below that resolve no actor tenant. `companyId` is the caller-supplied path
  // segment (evidence in `entity_id`, never attribution — the row is `company_id
  // NULL`). Bounded per (surface, remote-address) so a flood cannot grow the
  // operator's evidence table; never throws. The agent-key branches further down
  // are Class 1 and keep `recordUpgradeDenial` — do NOT route them here.
  const denyTenantless = (
    reason: LiveEventsUpgradeUnattributedReason,
    actorType: "user" | "agent",
    actorId: string,
    details?: Record<string, unknown>,
  ): Promise<void> =>
    recordTenantlessUpgradeDenial(db, {
      reason,
      requestedCompanyId: companyId,
      actorType,
      actorId,
      sourceKey: upgradeSourceKey(req, opts.trustProxy),
      control: "server/src/realtime/live-events-ws.ts:authorizeUpgrade",
      details,
    });

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
      await denyTenantless("board_no_session_resolver", "user", "anonymous", {
        deploymentMode: opts.deploymentMode,
        hasSessionResolver: Boolean(opts.resolveSessionFromHeaders),
      });
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
      await denyTenantless("board_untrusted_origin", "user", "anonymous", {
        origin: origin ?? null,
      });
      return null;
    }

    const session = await opts.resolveSessionFromHeaders(
      headersFromIncomingMessage(req)
    );
    const userId = session?.user?.id;
    if (!userId) {
      await denyTenantless("board_no_user", "user", "anonymous");
      return null;
    }

    if (opts.deploymentMode === "cloud_auth") {
      // Mirror authorizeCompanyUpgrade (services/upgrade-auth.ts) tenant-isolation
      // semantics: allow iff the actor holds BOTH an active organization
      // membership for the company's owning organization AND an active company
      // membership. A company membership WITHOUT an org membership is DENIED (the
      // deliberate tenant invariant). No instance_admin bypass here — the
      // authenticated branch below keeps its own instance_admin rule. Extracted
      // into hasActiveCloudMembership so the connection membership-sweep can
      // re-run the exact same predicate against already-open sockets.
      if (!(await hasActiveCloudMembership(db, companyId, userId))) {
        await denyTenantless("board_no_cloud_membership", "user", userId);
        return null;
      }

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
    // ★ DE-21 — MEASURED FOR THE DENIAL-AUDIT UNIT AND DELIBERATELY NOT RECORDED.
    // `memberships` holds FK-valid company ids (the actor's own active
    // memberships, SELECTed just above for the authorization decision itself), so
    // this branch LOOKS attributable. It is not, for two independent reasons:
    // (a) the array is EMPTY in the shape a probe actually takes — a session
    // holder with no memberships at all — so there is often no FK-valid company
    // here whatsoever; and (b) when it is non-empty the ids are the actor's OTHER
    // tenants, none of which was asked for anything or refused anything, so
    // picking one is an attribution rule, not a wiring gap. E0-F013's Decision 3.2
    // (slice 2) closes it by recording to the OPERATOR-ONLY sink (`company_id
    // NULL`) instead of attributing to one of the actor's other memberships. See
    // `live-events-tenantless-denial-audit.ts`.
    if (!roleRow && !hasCompanyMembership) {
      await denyTenantless("board_no_membership", "user", userId, {
        membershipCount: memberships.length,
      });
      return null;
    }

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

  // ★ DE-21 — THE UNIT OF CORRECTION IS THE DISJUNCT, NOT THE BRANCH. This was
  // one two-arm `||`; the arms differ on exactly the axis the audit turns on and
  // are now separate. Behaviour on the wire is unchanged: both still `return
  // null` and the caller still answers an opaque `403 Forbidden`.
  if (!key) {
    // NO DB-RESOLVED COMPANY EXISTS HERE. An unknown, revoked or malformed token
    // matched no `agent_api_keys` row, so the only company in hand is the
    // caller-supplied path segment — the dominant probe case. E0-F013's Decision
    // 3.2 (slice 2) records it to the OPERATOR-ONLY sink (`company_id NULL`,
    // requested company in `entity_id`), bounded so an unknown-token flood cannot
    // grow the operator's evidence table. The raw token is NEVER stored.
    await denyTenantless("agent_key_unknown", "agent", "unknown", {
      tokenPresented: true,
    });
    return null;
  }
  if (key.companyId !== companyId) {
    // A LIVE key, aimed at a company it does not own. `agent_api_keys.company_id`
    // is NOT NULL with an FK to `companies`, so the refusal is attributable — to
    // the KEY's own tenant, never to the one it reached for.
    await recordUpgradeDenial(db, {
      companyId: key.companyId,
      reason: "agent_key_tenant_mismatch",
      agentId: key.agentId,
      keyId: key.id,
      requestedCompanyId: companyId,
      control: "server/src/realtime/live-events-ws.ts:authorizeUpgrade",
    });
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

  // ★ DE-21 — four disjuncts, four machine codes, ONE unchanged 403. Control only
  // reaches here when `key` is non-null, so `key.companyId` is DB-resolved and
  // FK-valid on every one of them; that is what makes this whole branch
  // recordable while the `!key` arm above is not.
  const agentRefusal: LiveEventsUpgradeDenialReason | null = !agent
    ? "agent_missing"
    : agent.companyId !== key.companyId
      ? "agent_key_company_drift"
      : agent.status === "terminated"
        ? "agent_terminated"
        : agent.status === "pending_approval"
          ? "agent_pending_approval"
          : null;
  if (agentRefusal) {
    await recordUpgradeDenial(db, {
      companyId: key.companyId,
      reason: agentRefusal,
      agentId: key.agentId,
      keyId: key.id,
      requestedCompanyId: companyId,
      control: "server/src/realtime/live-events-ws.ts:authorizeUpgrade",
      details: {
        // Present only when there IS an agent row; both are inside the key's own
        // tenant on every arm but `agent_key_company_drift`, where naming the
        // drift is the whole evidence.
        agentCompanyId: agent?.companyId ?? null,
        agentStatus: agent?.status ?? null,
      },
    });
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
    /**
     * The app's `trust proxy` setting (`config.trustProxy`). Threaded to
     * `authorizeUpgrade` so the tenant-less denial source key is the
     * trusted-proxy-resolved client IP (Express `req.ip` parity), not the proxy
     * socket address.
     */
    trustProxy?: boolean | number | string[];
  }
) {
  const wss = new WebSocketServer({ noServer: true });
  const cleanupByClient = new Map<WsSocket, () => void>();
  const aliveByClient = new Map<WsSocket, boolean>();
  // Per-open-socket upgrade context, so the cloud_auth membership sweep can
  // re-validate each board socket's tenant membership after the handshake.
  const contextByClient = new Map<WsSocket, UpgradeContext>();
  const authorizationCheckInFlight = new Set<WsSocket>();

  // MIG-003: per-company socket index + per-socket monotonic delivery cursor, so
  // the durable-log reader (cross-replica NOTIFY/poll fan-out + `?sinceSeq=N`
  // catch-up) can reach this replica's sockets and suppress duplicate seqs.
  const companySockets = new Map<string, Set<WsSocket>>();
  const cursorByClient = new Map<WsSocket, SocketSeqCursor>();
  // Defect #2: while a `?sinceSeq=N` replay is in flight for a socket, live
  // durable events are BUFFERED here instead of sent inline (so they cannot
  // advance the client cursor past the replayed range and hide lower-seq replay
  // events). Drained in ascending seq after the replay completes. Overflow →
  // bounded snapshot fallback.
  const replayBufferByClient = new Map<WsSocket, { buffer: LiveEvent[]; overflow: boolean }>();
  // Defect #6: per-socket backpressure hysteresis latch — true while the socket's
  // outbound buffer is congested, so we emit exactly ONE `__resume` (not one per
  // dropped event) until it drains below the low-water mark.
  const backpressureLatched = new Set<WsSocket>();

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

  // ── MIG-003: durable cross-replica fan-out + sinceSeq catch-up ───────────────
  //
  // A durable event (carrying a per-company `seq`) reaches a socket through this
  // path — NOT the raw emitter — whenever a log store is wired, so delivery is
  // uniform (one seq-carrying, deduped, RBAC-re-run path) and gap/dup-free across
  // replicas. Per-event RBAC is the SAME live company/thread/hub visibility as
  // the emitter path (hide-don't-403); thread events are visibility-gated (a
  // viewer who can SEE the thread gets the hint — the client drops pokes it isn't
  // rendering). Without a store, durable events fall back to the emitter path
  // (today's single-node behavior).

  async function authorizeDurableEvent(
    context: UpgradeContext,
    event: LiveEvent
  ): Promise<boolean> {
    if (isHubEvent(event)) return mayReceiveHubEvent(context, event);
    if (isThreadEvent(event)) {
      const threadId = threadIdOf(event);
      if (!threadId) return false; // malformed thread event — fail closed
      return mayContextAccessThread(context, threadId);
    }
    return true; // company-wide invalidation hint
  }

  /**
   * Deliver ONE durable event to ONE socket. Order of concerns:
   *  1. Replay latch (defect #2): while a `?sinceSeq=N` replay is in flight for
   *     this socket, BUFFER the event (do NOT advance the cursor) — the buffer is
   *     drained in ascending seq once the replay finishes, so a live event can't
   *     hide the replayed range.
   *  2. Dedup: suppress duplicate seqs via the per-socket cursor (this ADVANCES
   *     the cursor, keeping catch-up consistent even when a payload is skipped).
   *  3. Backpressure (defect #6): a hysteresis latch bounds a slow socket — emit
   *     ONE `__resume` on the latching edge, then skip payloads (cursor already
   *     advanced) until the buffer drains below the low-water mark.
   *  4. Re-run per-event RBAC (hide-don't-403) before sending.
   */
  async function deliverDurableEventToSocket(
    socket: WsSocket,
    context: UpgradeContext,
    event: LiveEvent
  ): Promise<void> {
    if (socket.readyState !== WebSocket.OPEN) return;

    // (1) Replay latch — buffer live events until the replay drains (defect #2).
    const replay = replayBufferByClient.get(socket);
    if (replay) {
      if (replay.overflow) return; // already destined for snapshot fallback
      if (replay.buffer.length >= DEFAULT_REPLAY_BUFFER_CAP) {
        replay.overflow = true;
        replay.buffer.length = 0;
        return;
      }
      replay.buffer.push(event);
      return;
    }

    // (2) Dedup — advances the cursor even when the send is later skipped.
    const cursor = cursorByClient.get(socket);
    if (cursor && !cursor.accept(event.seq)) return;

    // (3) Backpressure hysteresis latch (defect #6).
    const decision = resolveBackpressure(
      backpressureLatched.has(socket),
      socket.bufferedAmount ?? 0
    );
    if (decision.latched) backpressureLatched.add(socket);
    else backpressureLatched.delete(socket);
    if (decision.signalResume) {
      try {
        socket.send(buildSnapshotResumeFrame());
      } catch {
        /* socket is going away */
      }
    }
    if (!decision.deliver) return;

    // (4) Per-event RBAC.
    const authorized = await authorizeDurableEvent(context, event);
    if (authorized && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(event));
    }
  }

  /**
   * Cross-replica + same-replica durable fan-out entry point. The per-replica
   * broker listener calls this for each row it pulls on NOTIFY/safety-poll.
   */
  function deliverDurableEvent(companyId: string, event: LiveEvent): void {
    const sockets = companySockets.get(companyId);
    if (!sockets) return;
    for (const socket of sockets) {
      const context = contextByClient.get(socket);
      if (!context) continue;
      void deliverDurableEventToSocket(socket, context, event).catch((err) => {
        logger.warn(
          { err, companyId },
          "durable live event fan-out failed"
        );
      });
    }
  }

  /**
   * On (re)connect with `?sinceSeq=N`, replay `seq > N` (re-running per-event
   * RBAC, hide-don't-403) then hand off to live keyed on the same cursor. A cursor
   * older than the retained window floor → a bounded snapshot-refetch signal.
   */
  function sendResume(socket: WsSocket): void {
    if (socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(buildSnapshotResumeFrame());
      } catch {
        /* socket going away */
      }
    }
  }

  /**
   * Finish a replay: tear down the latch and either fall back to a bounded
   * snapshot (on overflow) or drain the buffered live events in ascending seq
   * (dropping any `seq <= replayMaxSeq` already covered by the replay). Draining
   * runs each event back through deliverDurableEventToSocket (now un-latched), so
   * the per-socket cursor dedups the overlap.
   */
  async function finishReplay(
    socket: WsSocket,
    context: UpgradeContext,
    replayMaxSeq: number,
    snapshot: boolean
  ): Promise<void> {
    const replay = replayBufferByClient.get(socket);
    replayBufferByClient.delete(socket);
    if (snapshot || replay?.overflow) {
      // The client will blanket-refetch; buffered live events are covered by it.
      sendResume(socket);
      return;
    }
    if (!replay || replay.buffer.length === 0) return;
    const ordered = orderReplayBuffer(replay.buffer, replayMaxSeq);
    for (const event of ordered) {
      if (socket.readyState !== WebSocket.OPEN) break;
      await deliverDurableEventToSocket(socket, context, event);
    }
  }

  async function replaySinceSeq(
    socket: WsSocket,
    context: UpgradeContext,
    sinceSeq: number
  ): Promise<void> {
    const store = getLiveEventLogStore();
    if (!store) return;
    const cursor = cursorByClient.get(socket);
    // Latch the socket into replay mode so live durable events are buffered, not
    // sent inline, for the whole async replay window (defect #2).
    replayBufferByClient.set(socket, { buffer: [], overflow: false });
    let replayMaxSeq = sinceSeq;
    let snapshot = false;
    try {
      const floor = await store.retentionFloor(context.companyId);
      if (needsSnapshotFallback(sinceSeq, floor)) {
        snapshot = true;
        return;
      }
      const tail = await store.since(context.companyId, sinceSeq, DEFAULT_REPLAY_LIMIT);
      // Defect #3: a full page whose last seq is still behind the company's
      // high-water means events past the page were never replayed. Do NOT advance
      // the cursor past the hole — fall back to a bounded snapshot refetch.
      if (tail.length > 0) {
        const pageMaxSeq = tail[tail.length - 1]!.seq;
        const currentSeq = await store.currentSeq(context.companyId);
        if (replayTruncatedBeyondPage(tail.length, pageMaxSeq, currentSeq, DEFAULT_REPLAY_LIMIT)) {
          snapshot = true;
          return;
        }
      }
      const authorized = await filterAuthorizedReplay(tail, (event) =>
        authorizeDurableEvent(context, event)
      );
      for (const event of authorized) {
        if (socket.readyState !== WebSocket.OPEN) break;
        socket.send(JSON.stringify(event));
      }
      // Advance the cursor past the whole replayed window (authorized or not) so
      // an overlapping live redelivery of any replayed seq is suppressed.
      replayMaxSeq = tail.length > 0 ? tail[tail.length - 1]!.seq : sinceSeq;
      cursor?.advanceTo(replayMaxSeq);
    } catch (err) {
      logger.warn(
        { err, companyId: context.companyId },
        "live event sinceSeq replay failed"
      );
    } finally {
      await finishReplay(socket, context, replayMaxSeq, snapshot);
    }
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

    // MIG-003: index this socket for durable cross-replica fan-out + give it a
    // per-socket dedup cursor seeded at the client's `?sinceSeq=N` (0 = fresh).
    const sinceSeq = parseSinceSeq(req.url);
    let companyBucket = companySockets.get(context.companyId);
    if (!companyBucket) {
      companyBucket = new Set();
      companySockets.set(context.companyId, companyBucket);
    }
    companyBucket.add(socket);
    cursorByClient.set(socket, new SocketSeqCursor(sinceSeq ?? 0));

    const unsubscribe = subscribeCompanyLiveEvents(
      context.companyId,
      (event) => {
        if (socket.readyState !== WebSocket.OPEN) return;
        // ROBUST MODEL: the same-replica emitter ALWAYS delivers this copy —
        // seq-less, immediate, never dropped, never gated on a health flag. The
        // seq-carrying durable copy the drainer pulls back for THIS event is
        // suppressed cross-path by the drainer (it skips eventIds this replica
        // published), so there is no same-replica double and an append that later
        // fails cannot silently drop an already-delivered event. Peer-replica
        // events never reach this emitter — they arrive only via the durable
        // reader (deliverDurableEvent).
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

    // MIG-003: the socket is now subscribed (emitter) AND indexed (durable) BEFORE
    // the replay read, so a durable event that lands during catch-up is delivered
    // live through the cursor (no gap) and the replay's advanceTo won't re-send it.
    if (sinceSeq !== null) {
      void replaySinceSeq(socket, context, sinceSeq);
    }

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
      // MIG-003: drop this socket from the durable fan-out index + cursor map +
      // the replay/backpressure per-socket state.
      cursorByClient.delete(socket);
      replayBufferByClient.delete(socket);
      backpressureLatched.delete(socket);
      const bucket = companySockets.get(context.companyId);
      if (bucket) {
        bucket.delete(socket);
        if (bucket.size === 0) companySockets.delete(context.companyId);
      }

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
      trustProxy: opts.trustProxy,
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

  // MIG-003: expose the durable fan-out entry point + the active-company set so
  // the per-replica broker listener (index.ts) can push NOTIFY/poll-pulled log
  // rows into this replica's sockets through the same per-event RBAC + dedup +
  // backpressure path, and safety-poll every company this replica serves.
  const durableFanoutApi = wss as WsServer & {
    deliverDurableEvent?: typeof deliverDurableEvent;
    activeCompanies?: () => Iterable<string>;
  };
  durableFanoutApi.deliverDurableEvent = deliverDurableEvent;
  durableFanoutApi.activeCompanies = () => companySockets.keys();

  return wss;
}
