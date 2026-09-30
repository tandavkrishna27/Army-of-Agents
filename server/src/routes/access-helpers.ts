import { loadConfig } from "../config.js";

type JoinReplayInput = {
  requestType: "human" | "agent";
  adapterType: string | null;
  existingJoinRequest: {
    requestType: "human" | "agent";
    adapterType: string | null;
    status: string;
  } | null;
};

type JoinRequestManagerCandidate = {
  id: string;
  role: string;
  reportsTo: string | null;
  parentType?: string | null;
  parentId?: string | null;
};

const COMPANY_INVITE_TTL_MS = 10 * 60 * 1000;
// Email-bound team invites live for 7 days: the verified-email match at
// accept time is the real gate for these invites — link secrecy is secondary.
// Open/agent invites keep the short COMPANY_INVITE_TTL_MS window because the
// link itself is the only gate.
const EMAIL_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeHeaderValue(
  value: unknown,
  depth: number = 0,
): string | null {
  const direct = nonEmptyTrimmedString(value);
  if (direct) return direct;
  if (!isPlainObject(value) || depth >= 3) return null;

  const candidateKeys = [
    "value",
    "token",
    "secret",
    "apiKey",
    "api_key",
    "auth",
    "authToken",
    "auth_token",
    "accessToken",
    "access_token",
    "authorization",
    "bearer",
    "header",
    "raw",
    "text",
    "string",
  ];
  for (const key of candidateKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const normalized = normalizeHeaderValue(
      (value as Record<string, unknown>)[key],
      depth + 1,
    );
    if (normalized) return normalized;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 1) {
    const [singleKey, singleValue] = entries[0];
    const normalizedKey = singleKey.trim().toLowerCase();
    if (
      normalizedKey !== "type" &&
      normalizedKey !== "version" &&
      normalizedKey !== "secretid" &&
      normalizedKey !== "secret_id"
    ) {
      const normalized = normalizeHeaderValue(singleValue, depth + 1);
      if (normalized) return normalized;
    }
  }

  return null;
}

function extractHeaderEntries(input: unknown): Array<[string, unknown]> {
  if (isPlainObject(input)) {
    return Object.entries(input);
  }
  if (!Array.isArray(input)) {
    return [];
  }

  const entries: Array<[string, unknown]> = [];
  for (const item of input) {
    if (Array.isArray(item)) {
      const key = nonEmptyTrimmedString(item[0]);
      if (!key) continue;
      entries.push([key, item[1]]);
      continue;
    }
    if (!isPlainObject(item)) continue;

    const mapped = item as Record<string, unknown>;
    const explicitKey =
      nonEmptyTrimmedString(mapped.key) ??
      nonEmptyTrimmedString(mapped.name) ??
      nonEmptyTrimmedString(mapped.header);
    if (explicitKey) {
      const explicitValue = Object.prototype.hasOwnProperty.call(mapped, "value")
        ? mapped.value
        : Object.prototype.hasOwnProperty.call(mapped, "token")
          ? mapped.token
          : Object.prototype.hasOwnProperty.call(mapped, "secret")
            ? mapped.secret
            : mapped;
      entries.push([explicitKey, explicitValue]);
      continue;
    }

    const singleEntry = Object.entries(mapped);
    if (singleEntry.length === 1) {
      entries.push(singleEntry[0] as [string, unknown]);
    }
  }

  return entries;
}

function normalizeHeaderMap(input: unknown): Record<string, string> | undefined {
  const entries = extractHeaderEntries(input);
  if (entries.length === 0) return undefined;

  const out: Record<string, string> = {};
  for (const [key, value] of entries) {
    const normalizedValue = normalizeHeaderValue(value);
    if (!normalizedValue) continue;
    const trimmedKey = key.trim();
    const trimmedValue = normalizedValue.trim();
    if (!trimmedKey || !trimmedValue) continue;
    out[trimmedKey] = trimmedValue;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function headerMapHasKeyIgnoreCase(
  headers: Record<string, string>,
  targetKey: string,
): boolean {
  const normalizedTarget = targetKey.trim().toLowerCase();
  return Object.keys(headers).some(
    (key) => key.trim().toLowerCase() === normalizedTarget,
  );
}

function headerMapGetIgnoreCase(
  headers: Record<string, string>,
  targetKey: string,
): string | null {
  const normalizedTarget = targetKey.trim().toLowerCase();
  const key = Object.keys(headers).find(
    (candidate) => candidate.trim().toLowerCase() === normalizedTarget,
  );
  if (!key) return null;
  return typeof headers[key] === "string" ? headers[key] : null;
}

function toAuthorizationHeaderValue(rawToken: string): string {
  const trimmed = rawToken.trim();
  if (!trimmed) return trimmed;
  return /^bearer\s+/i.test(trimmed) ? trimmed : `Bearer ${trimmed}`;
}

/**
 * True when the invite's defaults payload binds it to a specific email
 * (a team invite created for one person). These invites are gated by the
 * verified-email match at accept time, so they get the long TTL.
 */
export function inviteDefaultsHaveBoundEmail(defaultsPayload: unknown): boolean {
  if (!isPlainObject(defaultsPayload)) return false;
  const teamInvite = (defaultsPayload as Record<string, unknown>).teamInvite;
  if (!isPlainObject(teamInvite)) return false;
  return Boolean(nonEmptyTrimmedString((teamInvite as Record<string, unknown>).email));
}

export function companyInviteExpiresAt(
  defaultsPayload: unknown = null,
  allowedJoinTypes: string | null = null,
  nowMs: number = Date.now(),
) {
  // The 7-day TTL requires the invite to be human-ONLY as well as
  // email-bound: an "agent"/"both" invite's agent-join half is gated by
  // link secrecy alone (no email verification), so it keeps the short TTL.
  const ttlMs =
    allowedJoinTypes === "human" && inviteDefaultsHaveBoundEmail(defaultsPayload)
      ? EMAIL_INVITE_TTL_MS
      : COMPANY_INVITE_TTL_MS;
  return new Date(nowMs + ttlMs);
}

export function buildJoinDefaultsPayloadForAccept(input: {
  adapterType: string | null;
  defaultsPayload: unknown;
  responsesWebhookUrl?: unknown;
  responsesWebhookMethod?: unknown;
  responsesWebhookHeaders?: unknown;
  paperclipApiUrl?: unknown;
  webhookAuthHeader?: unknown;
  inboundOpenClawAuthHeader?: string | null;
  inboundOpenClawTokenHeader?: string | null;
}): unknown {
  if (input.adapterType !== "openclaw") {
    return input.defaultsPayload;
  }

  const merged = isPlainObject(input.defaultsPayload)
    ? { ...(input.defaultsPayload as Record<string, unknown>) }
    : ({} as Record<string, unknown>);

  if (!nonEmptyTrimmedString(merged.url)) {
    const legacyUrl = nonEmptyTrimmedString(input.responsesWebhookUrl);
    if (legacyUrl) merged.url = legacyUrl;
  }

  if (!nonEmptyTrimmedString(merged.method)) {
    const legacyMethod = nonEmptyTrimmedString(input.responsesWebhookMethod);
    if (legacyMethod) merged.method = legacyMethod.toUpperCase();
  }

  if (!nonEmptyTrimmedString(merged.paperclipApiUrl)) {
    const legacyAoaApiUrl = nonEmptyTrimmedString(input.paperclipApiUrl);
    if (legacyAoaApiUrl) merged.paperclipApiUrl = legacyAoaApiUrl;
  }

  if (!nonEmptyTrimmedString(merged.webhookAuthHeader)) {
    const providedWebhookAuthHeader = nonEmptyTrimmedString(input.webhookAuthHeader);
    if (providedWebhookAuthHeader) {
      merged.webhookAuthHeader = providedWebhookAuthHeader;
    }
  }

  const mergedHeaders = normalizeHeaderMap(merged.headers) ?? {};
  const compatibilityHeaders = normalizeHeaderMap(input.responsesWebhookHeaders);
  if (compatibilityHeaders) {
    for (const [key, value] of Object.entries(compatibilityHeaders)) {
      if (!headerMapHasKeyIgnoreCase(mergedHeaders, key)) {
        mergedHeaders[key] = value;
      }
    }
  }

  const inboundOpenClawAuthHeader = nonEmptyTrimmedString(input.inboundOpenClawAuthHeader);
  const inboundOpenClawTokenHeader = nonEmptyTrimmedString(input.inboundOpenClawTokenHeader);
  if (
    inboundOpenClawTokenHeader &&
    !headerMapHasKeyIgnoreCase(mergedHeaders, "x-openclaw-token")
  ) {
    mergedHeaders["x-openclaw-token"] = inboundOpenClawTokenHeader;
  }
  if (
    inboundOpenClawAuthHeader &&
    !headerMapHasKeyIgnoreCase(mergedHeaders, "x-openclaw-auth")
  ) {
    mergedHeaders["x-openclaw-auth"] = inboundOpenClawAuthHeader;
  }

  if (Object.keys(mergedHeaders).length > 0) {
    merged.headers = mergedHeaders;
  } else {
    delete merged.headers;
  }

  const hasAuthorizationHeader = headerMapHasKeyIgnoreCase(mergedHeaders, "authorization");
  const hasWebhookAuthHeader = Boolean(nonEmptyTrimmedString(merged.webhookAuthHeader));
  if (!hasAuthorizationHeader && !hasWebhookAuthHeader) {
    const openClawAuthToken =
      headerMapGetIgnoreCase(mergedHeaders, "x-openclaw-token") ??
      headerMapGetIgnoreCase(mergedHeaders, "x-openclaw-auth");
    if (openClawAuthToken) {
      merged.webhookAuthHeader = toAuthorizationHeaderValue(openClawAuthToken);
    }
  }

  return Object.keys(merged).length > 0 ? merged : null;
}

export function mergeJoinDefaultsPayloadForReplay(
  existingDefaultsPayload: unknown,
  nextDefaultsPayload: unknown,
): unknown {
  if (
    !isPlainObject(existingDefaultsPayload) &&
    !isPlainObject(nextDefaultsPayload)
  ) {
    return nextDefaultsPayload ?? existingDefaultsPayload;
  }
  if (!isPlainObject(existingDefaultsPayload)) {
    return nextDefaultsPayload;
  }
  if (!isPlainObject(nextDefaultsPayload)) {
    return existingDefaultsPayload;
  }

  const merged: Record<string, unknown> = {
    ...(existingDefaultsPayload as Record<string, unknown>),
    ...(nextDefaultsPayload as Record<string, unknown>),
  };

  const existingHeaders = normalizeHeaderMap(
    (existingDefaultsPayload as Record<string, unknown>).headers,
  );
  const nextHeaders = normalizeHeaderMap(
    (nextDefaultsPayload as Record<string, unknown>).headers,
  );
  if (existingHeaders || nextHeaders) {
    merged.headers = {
      ...(existingHeaders ?? {}),
      ...(nextHeaders ?? {}),
    };
  } else if (Object.prototype.hasOwnProperty.call(merged, "headers")) {
    delete merged.headers;
  }

  return merged;
}

export function canReplayOpenClawInviteAccept(input: JoinReplayInput): boolean {
  if (input.requestType !== "agent" || input.adapterType !== "openclaw") {
    return false;
  }
  if (!input.existingJoinRequest) {
    return false;
  }
  if (
    input.existingJoinRequest.requestType !== "agent" ||
    input.existingJoinRequest.adapterType !== "openclaw"
  ) {
    return false;
  }
  return (
    input.existingJoinRequest.status === "pending_approval" ||
    input.existingJoinRequest.status === "approved"
  );
}

export function resolveJoinRequestAgentManagerId(
  candidates: JoinRequestManagerCandidate[],
): string | null {
  // Route join requests to a CXO-tier agent (apex preferred, but any CXO is
  // acceptable as a manager candidate). Was historically `=== "ceo"` before
  // the role-enum cleanup.
  const cxoCandidates = candidates.filter((candidate) => candidate.role === "cxo");
  if (cxoCandidates.length === 0) return null;
  const apexCxo = cxoCandidates.find(
    (candidate) => !candidate.parentId && candidate.reportsTo === null,
  );
  return (apexCxo ?? cxoCandidates[0] ?? null)?.id ?? null;
}

type BaseUrlRequest = {
  protocol?: string;
  header(name: string): string | undefined;
  // Express request: `app.get("trust proxy")` returns the value installed via
  // `app.set("trust proxy", config.trustProxy)` in app.ts. Optional so the
  // pure helpers stay unit-testable with a minimal request stub.
  app?: { get(name: string): unknown };
};

/**
 * True only when Express `trust proxy` is genuinely enabled — i.e. AoA sits
 * behind a real reverse proxy whose `X-Forwarded-*` headers can be believed.
 * Mirrors Express' own coercion of the setting:
 * - `true` / a positive hop count / a non-empty CIDR list → trusted
 * - `false` / `0` / `[]` / unset → NOT trusted (a client could spoof the headers)
 */
export function isTrustProxyEnabled(trustProxy: unknown): boolean {
  if (typeof trustProxy === "boolean") return trustProxy;
  if (typeof trustProxy === "number") return trustProxy > 0;
  if (Array.isArray(trustProxy)) return trustProxy.length > 0;
  if (typeof trustProxy === "string") {
    const value = trustProxy.trim().toLowerCase();
    return value.length > 0 && value !== "false";
  }
  return false;
}

/**
 * Derive the request's base origin from data we can trust.
 *
 * SECURITY: `X-Forwarded-Proto` / `X-Forwarded-Host` are client-controllable
 * unless a trusted reverse proxy overwrites them. We therefore honor them ONLY
 * when Express `trust proxy` is enabled (read from `req.app.get("trust proxy")`,
 * overridable via `opts.trustProxy` for tests). Otherwise we fall back to the
 * real connection `Host` header — never the forwarded host — so a spoofed
 * `X-Forwarded-Host: evil.com` cannot poison generated URLs. No host at all →
 * empty string, letting the client resolve relative to its own origin.
 */
export function requestBaseUrl(
  req: BaseUrlRequest,
  opts?: { trustProxy?: unknown },
) {
  const hostHeader = req.header("host")?.trim() || undefined;
  const trustProxySetting =
    opts && "trustProxy" in opts ? opts.trustProxy : req.app?.get("trust proxy");

  if (isTrustProxyEnabled(trustProxySetting)) {
    const forwardedProto = req.header("x-forwarded-proto")?.split(",")[0]?.trim();
    const forwardedHost = req.header("x-forwarded-host")?.split(",")[0]?.trim();
    const proto = forwardedProto || req.protocol || "http";
    const host = forwardedHost || hostHeader;
    if (!host) return "";
    return `${proto}://${host}`;
  }

  if (!hostHeader) return "";
  const proto = req.protocol || "http";
  return `${proto}://${hostHeader}`;
}

let cachedInviteConfig: { authPublicBaseUrl: string | undefined } | null = null;
function configuredPublicBaseUrl(): string | undefined {
  if (!cachedInviteConfig) {
    // Loaded lazily + memoized so importing this module (and its many
    // unit-tested pure helpers) never eagerly evaluates process config.
    // Deployment config is fixed for the process lifetime.
    cachedInviteConfig = { authPublicBaseUrl: loadConfig().authPublicBaseUrl };
  }
  return cachedInviteConfig.authPublicBaseUrl;
}

/**
 * Origin used to build auto-copied invite links (create + resend). Priority:
 *   1. The configured canonical public origin (`config.authPublicBaseUrl`) —
 *      operator-set and the same origin better-auth trusts. Used verbatim
 *      (normalized to its origin), so headers can never override it. This is
 *      mandatory for `authenticated`/public exposure (see index.ts), which
 *      makes the untrusted-header path unreachable there.
 *   2. Otherwise, the trust-proxy-gated / Host-based derivation from
 *      `requestBaseUrl` (honors `X-Forwarded-*` only behind a trusted proxy).
 *   3. Otherwise, an empty string so the client prefixes its own
 *      `window.location.origin` via `toAbsoluteInviteUrl` — the origin the
 *      founder is actually browsing, which is always safe.
 *
 * `opts.publicBaseUrl` (when the key is present, even as `null`) overrides the
 * configured lookup for tests.
 */
export function resolveInviteBaseUrl(
  req: BaseUrlRequest,
  opts?: { publicBaseUrl?: string | null; trustProxy?: unknown },
) {
  const configuredRaw =
    opts && "publicBaseUrl" in opts ? opts.publicBaseUrl : configuredPublicBaseUrl();
  const configured =
    typeof configuredRaw === "string" ? configuredRaw.trim() : "";
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // Misconfigured public URL — fall through to secure header derivation
      // rather than emitting a broken link.
    }
  }
  return requestBaseUrl(req, opts);
}

function extractInviteMessage(invite: { defaultsPayload?: unknown }) {
  if (!isPlainObject(invite.defaultsPayload)) return null;
  const rawMessage = invite.defaultsPayload.agentMessage;
  if (typeof rawMessage !== "string") return null;
  const trimmed = rawMessage.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildConnectionCandidates(input: {
  apiBaseUrl: string;
  bindHost: string;
  allowedHostnames: string[];
}) {
  let base: URL | null = null;
  try {
    if (input.apiBaseUrl) base = new URL(input.apiBaseUrl);
  } catch {
    base = null;
  }

  const protocol = base?.protocol ?? "http:";
  const port = base?.port ? `:${base.port}` : "";
  const candidates = new Set<string>();
  if (base) candidates.add(base.origin);

  const bindHost = nonEmptyTrimmedString(input.bindHost);
  if (bindHost && !["localhost", "127.0.0.1", "::1"].includes(bindHost)) {
    candidates.add(`${protocol}//${bindHost}${port}`);
  }

  for (const rawHost of input.allowedHostnames) {
    const host = nonEmptyTrimmedString(rawHost);
    if (host) candidates.add(`${protocol}//${host}${port}`);
  }

  if (base && ["localhost", "127.0.0.1", "::1"].includes(base.hostname)) {
    candidates.add(`${protocol}//host.docker.internal${port}`);
  }

  return Array.from(candidates);
}

export function buildInviteOnboardingTextDocument(
  req: {
    protocol?: string;
    header(name: string): string | undefined;
  },
  token: string,
  invite: {
    inviteType: string;
    allowedJoinTypes: string;
    expiresAt: Date;
    defaultsPayload?: unknown;
  },
  opts: {
    deploymentMode: string;
    deploymentExposure: string;
    bindHost: string;
    allowedHostnames: string[];
  },
) {
  const baseUrl = requestBaseUrl(req);
  const registrationPath = `/api/invites/${token}/accept`;
  const onboardingTextPath = `/api/invites/${token}/onboarding.txt`;
  const testResolutionPath = `/api/invites/${token}/test-resolution`;
  const candidates = buildConnectionCandidates({
    apiBaseUrl: baseUrl,
    bindHost: opts.bindHost,
    allowedHostnames: opts.allowedHostnames,
  });
  const inviteMessage = extractInviteMessage(invite);

  const lines = [
    "# AoA OpenClaw Onboarding",
    "",
    "This document is meant to be readable by both humans and agents.",
    "",
    "## Invite",
    `- inviteType: ${invite.inviteType}`,
    `- allowedJoinTypes: ${invite.allowedJoinTypes}`,
    `- expiresAt: ${invite.expiresAt.toISOString()}`,
    "",
  ];

  if (inviteMessage) {
    lines.push("## Message from inviter", inviteMessage, "");
  }

  lines.push(
    "## Step 1: Submit agent join request",
    registrationPath,
    "",
    "IMPORTANT: You MUST include agentDefaultsPayload.headers.x-openclaw-auth with your gateway token.",
    "Without this token, AoA callback requests to your OpenClaw endpoint will fail with 401 Unauthorized.",
    "",
    "## Step 2: Wait for approval, then claim API key",
    "/api/join-requests/{requestId}/claim-api-key",
    "~/.openclaw/workspace/paperclip-claimed-api-key.json",
    "AOA_API_KEY",
    "saved token field",
    "",
    "## Discovery",
    onboardingTextPath,
    testResolutionPath,
    "Suggested AoA base URLs to try",
    ...candidates,
    "",
    "set the first reachable candidate as agentDefaultsPayload.paperclipApiUrl",
    "paperclipApiUrl",
    "If none are reachable, stop and fix AoA hostname exposure before retrying.",
  );

  if (opts.deploymentMode === "authenticated" && opts.deploymentExposure === "private") {
    lines.push("", "Connectivity diagnostics", "loopback hostname");
  }

  return lines.join("\n");
}
