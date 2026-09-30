import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import type { Request } from "express";
import { and, eq, inArray, isNull, desc } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import {
  agentApiKeys,
  authUsers,
  companies,
  companyMemberships,
  invites,
  joinRequests
} from "@armyofagents/db";
import {
  acceptInviteSchema,
  claimJoinRequestApiKeySchema,
  createCompanyInviteSchema,
  listJoinRequestsQuerySchema,
  searchAdminUsersQuerySchema,
  updateMemberPermissionsSchema,
  updateUserCompanyAccessSchema
} from "@armyofagents/shared";
import type { DeploymentExposure, DeploymentMode, PermissionKey } from "@armyofagents/shared";
import {
  forbidden,
  conflict,
  notFound,
  unauthorized,
  badRequest
} from "../errors.js";
import { logger } from "../middleware/logger.js";
import { validate } from "../middleware/validate.js";
import {
  accessService,
  agentService,
  deduplicateAgentName,
  logActivity,
  notifyHireApproved,
  teamService,
} from "../services/index.js";
import { assertCompanyAccess } from "./authz.js";
import {
  companyInviteExpiresAt,
  requestBaseUrl,
  resolveInviteBaseUrl,
} from "./access-helpers.js";
import {
  claimBoardOwnership,
  inspectBoardClaimChallenge
} from "../board-claim.js";
import {
  validateAndResolveFetchUrl,
  executePinnedRequest,
  type ValidatedFetchTarget,
} from "../services/outbound-url-guard.js";
import { buildJoinRequestHubEmit, emitHubItem } from "../services/hub-source-producers.js";
import { hubItemsService } from "../services/hub-items.js";
import {
  approveHumanJoinRequestTx,
  buildHumanJoinApprovalServices,
  founderApprovalIdentity,
  grantsFromDefaults,
  inviteConfersPrivilegedAuthority,
} from "../services/join-approval.js";
import { instanceAdminBootstrapEnabled } from "../services/first-user-bootstrap.js";

/**
 * Task 7 (Phase 2 lockout cluster) — gate the `bootstrap_ceo` invite
 * promotion through the single chokepoint. `cloud_auth` mints zero runtime
 * instance_admins; self-hosted local_trusted/authenticated are unaffected.
 */
export function bootstrapCeoPromotionAllowed(mode: DeploymentMode): boolean {
  return instanceAdminBootstrapEnabled(mode);
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

const INVITE_TOKEN_PREFIX = "aoa_invite_";
const INVITE_TOKEN_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const INVITE_TOKEN_SUFFIX_LENGTH = 8;
const INVITE_TOKEN_MAX_RETRIES = 5;

function createInviteToken() {
  const bytes = randomBytes(INVITE_TOKEN_SUFFIX_LENGTH);
  let suffix = "";
  for (let idx = 0; idx < INVITE_TOKEN_SUFFIX_LENGTH; idx += 1) {
    suffix += INVITE_TOKEN_ALPHABET[bytes[idx]! % INVITE_TOKEN_ALPHABET.length];
  }
  return `${INVITE_TOKEN_PREFIX}${suffix}`;
}

function createClaimSecret() {
  return `aoa_claim_${randomBytes(24).toString("hex")}`;
}

function tokenHashesMatch(left: string, right: string) {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function readSkillMarkdown(skillName: string): string | null {
  const normalized = skillName.trim().toLowerCase();
  if (normalized !== "aoa" && normalized !== "aoa-create-agent")
    return null;
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDir, "../../skills", normalized, "SKILL.md"), // published: dist/routes/ -> <pkg>/skills/
    path.resolve(process.cwd(), "skills", normalized, "SKILL.md"), // cwd (e.g. monorepo root)
    path.resolve(moduleDir, "../../../skills", normalized, "SKILL.md") // dev: src/routes/ -> repo root/skills/
  ];
  for (const skillPath of candidates) {
    try {
      return fs.readFileSync(skillPath, "utf8");
    } catch {
      // Continue to next candidate.
    }
  }
  return null;
}

function toJoinRequestResponse(row: typeof joinRequests.$inferSelect) {
  const { claimSecretHash: _claimSecretHash, ...safe } = row;
  return safe;
}

type JoinDiagnostic = {
  code: string;
  level: "info" | "warn";
  message: string;
  hint?: string;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLoopbackHost(hostname: string): boolean {
  const value = hostname.trim().toLowerCase();
  return value === "localhost" || value === "127.0.0.1" || value === "::1";
}

function isWakePath(pathname: string): boolean {
  const value = pathname.trim().toLowerCase();
  return value === "/hooks/wake" || value.endsWith("/hooks/wake");
}

function normalizeOpenClawTransport(value: unknown): "sse" | "webhook" | null {
  if (typeof value !== "string") return "sse";
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "sse") return "sse";
  if (normalized === "webhook") return "webhook";
  return null;
}

function normalizeHostname(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end > 1
      ? trimmed.slice(1, end).toLowerCase()
      : trimmed.toLowerCase();
  }
  const firstColon = trimmed.indexOf(":");
  if (firstColon > -1) return trimmed.slice(0, firstColon).toLowerCase();
  return trimmed.toLowerCase();
}

function normalizeHeaderValue(
  value: unknown,
  depth: number = 0
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
    "string"
  ];
  for (const key of candidateKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const normalized = normalizeHeaderValue(
      (value as Record<string, unknown>)[key],
      depth + 1
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
      const explicitValue = Object.prototype.hasOwnProperty.call(
        mapped,
        "value"
      )
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

function normalizeHeaderMap(
  input: unknown
): Record<string, string> | undefined {
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

function nonEmptyTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function headerMapHasKeyIgnoreCase(
  headers: Record<string, string>,
  targetKey: string
): boolean {
  const normalizedTarget = targetKey.trim().toLowerCase();
  return Object.keys(headers).some(
    (key) => key.trim().toLowerCase() === normalizedTarget
  );
}

function headerMapGetIgnoreCase(
  headers: Record<string, string>,
  targetKey: string
): string | null {
  const normalizedTarget = targetKey.trim().toLowerCase();
  const key = Object.keys(headers).find(
    (candidate) => candidate.trim().toLowerCase() === normalizedTarget
  );
  if (!key) return null;
  const value = headers[key];
  return typeof value === "string" ? value : null;
}

function toAuthorizationHeaderValue(rawToken: string): string {
  const trimmed = rawToken.trim();
  if (!trimmed) return trimmed;
  return /^bearer\s+/i.test(trimmed) ? trimmed : `Bearer ${trimmed}`;
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
    const providedWebhookAuthHeader = nonEmptyTrimmedString(
      input.webhookAuthHeader
    );
    if (providedWebhookAuthHeader)
      merged.webhookAuthHeader = providedWebhookAuthHeader;
  }

  const mergedHeaders = normalizeHeaderMap(merged.headers) ?? {};
  const compatibilityHeaders = normalizeHeaderMap(
    input.responsesWebhookHeaders
  );
  if (compatibilityHeaders) {
    for (const [key, value] of Object.entries(compatibilityHeaders)) {
      if (!headerMapHasKeyIgnoreCase(mergedHeaders, key)) {
        mergedHeaders[key] = value;
      }
    }
  }

  const inboundOpenClawAuthHeader = nonEmptyTrimmedString(
    input.inboundOpenClawAuthHeader
  );
  const inboundOpenClawTokenHeader = nonEmptyTrimmedString(
    input.inboundOpenClawTokenHeader
  );
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

  const hasAuthorizationHeader = headerMapHasKeyIgnoreCase(
    mergedHeaders,
    "authorization"
  );
  const hasWebhookAuthHeader = Boolean(
    nonEmptyTrimmedString(merged.webhookAuthHeader)
  );
  if (!hasAuthorizationHeader && !hasWebhookAuthHeader) {
    const openClawAuthToken =
      headerMapGetIgnoreCase(mergedHeaders, "x-openclaw-token") ??
      headerMapGetIgnoreCase(
      mergedHeaders,
      "x-openclaw-auth"
    );
    if (openClawAuthToken) {
      merged.webhookAuthHeader = toAuthorizationHeaderValue(openClawAuthToken);
    }
  }

  return Object.keys(merged).length > 0 ? merged : null;
}

export function mergeJoinDefaultsPayloadForReplay(
  existingDefaultsPayload: unknown,
  nextDefaultsPayload: unknown
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
    ...(nextDefaultsPayload as Record<string, unknown>)
  };

  const existingHeaders = normalizeHeaderMap(
    (existingDefaultsPayload as Record<string, unknown>).headers
  );
  const nextHeaders = normalizeHeaderMap(
    (nextDefaultsPayload as Record<string, unknown>).headers
  );
  if (existingHeaders || nextHeaders) {
    merged.headers = {
      ...(existingHeaders ?? {}),
      ...(nextHeaders ?? {})
    };
  } else if (Object.prototype.hasOwnProperty.call(merged, "headers")) {
    delete merged.headers;
  }

  return merged;
}

export function canReplayOpenClawInviteAccept(input: {
  requestType: "human" | "agent";
  adapterType: string | null;
  existingJoinRequest: Pick<
    typeof joinRequests.$inferSelect,
    "requestType" | "adapterType" | "status"
  > | null;
}): boolean {
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

function summarizeSecretForLog(
  value: unknown
): { present: true; length: number; sha256Prefix: string } | null {
  const trimmed = nonEmptyTrimmedString(value);
  if (!trimmed) return null;
  return {
    present: true,
    length: trimmed.length,
    sha256Prefix: hashToken(trimmed).slice(0, 12)
  };
}

function summarizeOpenClawDefaultsForLog(defaultsPayload: unknown) {
  const defaults = isPlainObject(defaultsPayload)
    ? (defaultsPayload as Record<string, unknown>)
    : null;
  const headers = defaults ? normalizeHeaderMap(defaults.headers) : undefined;
  const openClawAuthHeaderValue = headers
    ? headerMapGetIgnoreCase(headers, "x-openclaw-token") ??
      headerMapGetIgnoreCase(headers, "x-openclaw-auth")
    : null;

  return {
    present: Boolean(defaults),
    keys: defaults ? Object.keys(defaults).sort() : [],
    url: defaults ? nonEmptyTrimmedString(defaults.url) : null,
    method: defaults ? nonEmptyTrimmedString(defaults.method) : null,
    paperclipApiUrl: defaults
      ? nonEmptyTrimmedString(defaults.paperclipApiUrl)
      : null,
    headerKeys: headers ? Object.keys(headers).sort() : [],
    webhookAuthHeader: defaults
      ? summarizeSecretForLog(defaults.webhookAuthHeader)
      : null,
    openClawAuthHeader: summarizeSecretForLog(openClawAuthHeaderValue)
  };
}

function buildJoinConnectivityDiagnostics(input: {
  deploymentMode: DeploymentMode;
  deploymentExposure: DeploymentExposure;
  bindHost: string;
  allowedHostnames: string[];
  callbackUrl: URL | null;
}): JoinDiagnostic[] {
  const diagnostics: JoinDiagnostic[] = [];
  const bindHost = normalizeHostname(input.bindHost);
  const callbackHost = input.callbackUrl
    ? normalizeHostname(input.callbackUrl.hostname)
    : null;
  const allowSet = new Set(
    input.allowedHostnames
      .map((entry) => normalizeHostname(entry))
      .filter((entry): entry is string => Boolean(entry))
  );

  diagnostics.push({
    code: "openclaw_deployment_context",
    level: "info",
    message: `Deployment context: mode=${input.deploymentMode}, exposure=${input.deploymentExposure}.`
  });

  if (
    input.deploymentMode === "authenticated" &&
    input.deploymentExposure === "private"
  ) {
    if (!bindHost || isLoopbackHost(bindHost)) {
      diagnostics.push({
        code: "openclaw_private_bind_loopback",
        level: "warn",
        message:
          "AoA is bound to loopback in authenticated/private mode.",
        hint: "Bind to a reachable private hostname/IP for remote OpenClaw callbacks."
      });
    }
    if (bindHost && !isLoopbackHost(bindHost) && !allowSet.has(bindHost)) {
      diagnostics.push({
        code: "openclaw_private_bind_not_allowed",
        level: "warn",
        message: `AoA bind host \"${bindHost}\" is not in allowed hostnames.`,
        hint: `Run pnpm aoa allowed-hostname ${bindHost}`
      });
    }
    if (callbackHost && !isLoopbackHost(callbackHost) && allowSet.size === 0) {
      diagnostics.push({
        code: "openclaw_private_allowed_hostnames_empty",
        level: "warn",
        message:
          "No explicit allowed hostnames are configured for authenticated/private mode.",
        hint: "Set one with pnpm aoa allowed-hostname <host> when OpenClaw runs off-host."
      });
    }
  }

  if (
    input.deploymentMode === "authenticated" &&
    input.deploymentExposure === "public" &&
    input.callbackUrl &&
    input.callbackUrl.protocol !== "https:"
  ) {
    diagnostics.push({
      code: "openclaw_public_http_callback",
      level: "warn",
      message: "OpenClaw callback URL uses HTTP in authenticated/public mode.",
      hint: "Prefer HTTPS for public deployments."
    });
  }

  return diagnostics;
}

function normalizeAgentDefaultsForJoin(input: {
  adapterType: string | null;
  defaultsPayload: unknown;
  deploymentMode: DeploymentMode;
  deploymentExposure: DeploymentExposure;
  bindHost: string;
  allowedHostnames: string[];
}) {
  const diagnostics: JoinDiagnostic[] = [];
  if (input.adapterType !== "openclaw") {
    const normalized = isPlainObject(input.defaultsPayload)
      ? (input.defaultsPayload as Record<string, unknown>)
      : null;
    return { normalized, diagnostics };
  }

  if (!isPlainObject(input.defaultsPayload)) {
    diagnostics.push({
      code: "openclaw_callback_config_missing",
      level: "warn",
      message:
        "No OpenClaw callback config was provided in agentDefaultsPayload.",
      hint: "Include agentDefaultsPayload.url so AoA can invoke the OpenClaw endpoint immediately after approval."
    });
    return { normalized: null as Record<string, unknown> | null, diagnostics };
  }

  const defaults = input.defaultsPayload as Record<string, unknown>;
  const streamTransportInput = defaults.streamTransport ?? defaults.transport;
  const streamTransport = normalizeOpenClawTransport(streamTransportInput);
  const normalized: Record<string, unknown> = { streamTransport: "sse" };
  if (!streamTransport) {
    diagnostics.push({
      code: "openclaw_stream_transport_unsupported",
      level: "warn",
      message: `Unsupported streamTransport: ${String(streamTransportInput)}`,
      hint: "Use streamTransport=sse or streamTransport=webhook."
    });
  } else {
    normalized.streamTransport = streamTransport;
  }

  let callbackUrl: URL | null = null;
  const rawUrl = typeof defaults.url === "string" ? defaults.url.trim() : "";
  if (!rawUrl) {
    diagnostics.push({
      code: "openclaw_callback_url_missing",
      level: "warn",
      message: "OpenClaw callback URL is missing.",
      hint: "Set agentDefaultsPayload.url to your OpenClaw endpoint."
    });
  } else {
    try {
      callbackUrl = new URL(rawUrl);
      if (
        callbackUrl.protocol !== "http:" &&
        callbackUrl.protocol !== "https:"
      ) {
        diagnostics.push({
          code: "openclaw_callback_url_protocol",
          level: "warn",
          message: `Unsupported callback protocol: ${callbackUrl.protocol}`,
          hint: "Use http:// or https://."
        });
      } else {
        normalized.url = callbackUrl.toString();
        diagnostics.push({
          code: "openclaw_callback_url_configured",
          level: "info",
          message: `Callback endpoint set to ${callbackUrl.toString()}`
        });
      }
      if ((streamTransport ?? "sse") === "sse" && isWakePath(callbackUrl.pathname)) {
        diagnostics.push({
          code: "openclaw_callback_wake_path_incompatible",
          level: "warn",
          message:
            "Configured callback path targets /hooks/wake, which is not stream-capable for SSE transport.",
          hint: "Use an endpoint that returns text/event-stream for the full run duration."
        });
      }
      if (isLoopbackHost(callbackUrl.hostname)) {
        diagnostics.push({
          code: "openclaw_callback_loopback",
          level: "warn",
          message: "OpenClaw callback endpoint uses loopback hostname.",
          hint: "Use a reachable hostname/IP when OpenClaw runs on another machine."
        });
      }
    } catch {
      diagnostics.push({
        code: "openclaw_callback_url_invalid",
        level: "warn",
        message: `Invalid callback URL: ${rawUrl}`
      });
    }
  }

  const rawMethod =
    typeof defaults.method === "string"
      ? defaults.method.trim().toUpperCase()
      : "";
  normalized.method = rawMethod || "POST";

  if (
    typeof defaults.timeoutSec === "number" &&
    Number.isFinite(defaults.timeoutSec)
  ) {
    normalized.timeoutSec = Math.max(
      0,
      Math.min(7200, Math.floor(defaults.timeoutSec))
    );
  }

  const headers = normalizeHeaderMap(defaults.headers);
  if (headers) normalized.headers = headers;

  if (
    typeof defaults.webhookAuthHeader === "string" &&
    defaults.webhookAuthHeader.trim()
  ) {
    normalized.webhookAuthHeader = defaults.webhookAuthHeader.trim();
  }

  const openClawAuthHeader = headers
    ? headerMapGetIgnoreCase(headers, "x-openclaw-token") ??
      headerMapGetIgnoreCase(headers, "x-openclaw-auth")
    : null;
  if (openClawAuthHeader) {
    diagnostics.push({
      code: "openclaw_auth_header_configured",
      level: "info",
      message:
        "Gateway auth token received via headers.x-openclaw-token (or legacy x-openclaw-auth)."
    });
  } else {
    diagnostics.push({
      code: "openclaw_auth_header_missing",
      level: "warn",
      message: "Gateway auth token is missing from agent defaults.",
      hint:
        "Set agentDefaultsPayload.headers.x-openclaw-token (or legacy x-openclaw-auth) to the token your OpenClaw endpoint requires."
    });
  }

  if (isPlainObject(defaults.payloadTemplate)) {
    normalized.payloadTemplate = defaults.payloadTemplate;
  }

  const rawAoaApiUrl =
    typeof defaults.paperclipApiUrl === "string"
      ? defaults.paperclipApiUrl.trim()
      : "";
  if (rawAoaApiUrl) {
    try {
      const parsedAoaApiUrl = new URL(rawAoaApiUrl);
      if (
        parsedAoaApiUrl.protocol !== "http:" &&
        parsedAoaApiUrl.protocol !== "https:"
      ) {
        diagnostics.push({
          code: "openclaw_paperclip_api_url_protocol",
          level: "warn",
          message: `paperclipApiUrl must use http:// or https:// (got ${parsedAoaApiUrl.protocol}).`
        });
      } else {
        normalized.paperclipApiUrl = parsedAoaApiUrl.toString();
        diagnostics.push({
          code: "openclaw_paperclip_api_url_configured",
          level: "info",
          message: `paperclipApiUrl set to ${parsedAoaApiUrl.toString()}`
        });
        if (isLoopbackHost(parsedAoaApiUrl.hostname)) {
          diagnostics.push({
            code: "openclaw_paperclip_api_url_loopback",
            level: "warn",
            message:
              "paperclipApiUrl uses loopback hostname. Remote OpenClaw workers cannot reach localhost on the AoA host.",
            hint: "Use a reachable hostname/IP and keep it in allowed hostnames for authenticated/private deployments."
          });
        }
      }
    } catch {
      diagnostics.push({
        code: "openclaw_paperclip_api_url_invalid",
        level: "warn",
        message: `Invalid paperclipApiUrl: ${rawAoaApiUrl}`
      });
    }
  }

  diagnostics.push(
    ...buildJoinConnectivityDiagnostics({
      deploymentMode: input.deploymentMode,
      deploymentExposure: input.deploymentExposure,
      bindHost: input.bindHost,
      allowedHostnames: input.allowedHostnames,
      callbackUrl
    })
  );

  return { normalized, diagnostics };
}

function toInviteSummaryResponse(
  req: Request,
  token: string,
  invite: typeof invites.$inferSelect,
  // Optional so agent-manifest/create call sites stay unchanged; the public
  // GET /invites/:token summary resolves it (joined in the invite lookup) so
  // the landing page can name the company being joined.
  companyName: string | null = null
) {
  const baseUrl = requestBaseUrl(req);
  const onboardingPath = `/api/invites/${token}/onboarding`;
  const onboardingTextPath = `/api/invites/${token}/onboarding.txt`;
  const inviteMessage = extractInviteMessage(invite);
  return {
    id: invite.id,
    companyId: invite.companyId,
    companyName,
    inviteType: invite.inviteType,
    allowedJoinTypes: invite.allowedJoinTypes,
    expiresAt: invite.expiresAt,
    onboardingPath,
    onboardingUrl: baseUrl ? `${baseUrl}${onboardingPath}` : onboardingPath,
    onboardingTextPath,
    onboardingTextUrl: baseUrl
      ? `${baseUrl}${onboardingTextPath}`
      : onboardingTextPath,
    skillIndexPath: "/api/skills/index",
    skillIndexUrl: baseUrl
      ? `${baseUrl}/api/skills/index`
      : "/api/skills/index",
    inviteMessage
  };
}

function buildOnboardingDiscoveryDiagnostics(input: {
  apiBaseUrl: string;
  deploymentMode: DeploymentMode;
  deploymentExposure: DeploymentExposure;
  bindHost: string;
  allowedHostnames: string[];
}): JoinDiagnostic[] {
  const diagnostics: JoinDiagnostic[] = [];
  let apiHost: string | null = null;
  if (input.apiBaseUrl) {
    try {
      apiHost = normalizeHostname(new URL(input.apiBaseUrl).hostname);
    } catch {
      apiHost = null;
    }
  }

  const bindHost = normalizeHostname(input.bindHost);
  const allowSet = new Set(
    input.allowedHostnames
      .map((entry) => normalizeHostname(entry))
      .filter((entry): entry is string => Boolean(entry))
  );

  if (apiHost && isLoopbackHost(apiHost)) {
    diagnostics.push({
      code: "openclaw_onboarding_api_loopback",
      level: "warn",
      message:
        "Onboarding URL resolves to loopback hostname. Remote OpenClaw agents cannot reach localhost on your AoA host.",
      hint: "Use a reachable hostname/IP (for example Tailscale hostname, Docker host alias, or public domain)."
    });
  }

  if (
    input.deploymentMode === "authenticated" &&
    input.deploymentExposure === "private" &&
    (!bindHost || isLoopbackHost(bindHost))
  ) {
    diagnostics.push({
      code: "openclaw_onboarding_private_loopback_bind",
      level: "warn",
      message: "AoA is bound to loopback in authenticated/private mode.",
      hint: "Run with a reachable bind host or use pnpm dev --tailscale-auth for private-network onboarding."
    });
  }

  if (
    input.deploymentMode === "authenticated" &&
    input.deploymentExposure === "private" &&
    apiHost &&
    !isLoopbackHost(apiHost) &&
    allowSet.size > 0 &&
    !allowSet.has(apiHost)
  ) {
    diagnostics.push({
      code: "openclaw_onboarding_private_host_not_allowed",
      level: "warn",
      message: `Onboarding host "${apiHost}" is not in allowed hostnames for authenticated/private mode.`,
      hint: `Run pnpm aoa allowed-hostname ${apiHost}`
    });
  }

  return diagnostics;
}

function buildOnboardingConnectionCandidates(input: {
  apiBaseUrl: string;
  bindHost: string;
  allowedHostnames: string[];
}): string[] {
  let base: URL | null = null;
  try {
    if (input.apiBaseUrl) {
      base = new URL(input.apiBaseUrl);
    }
  } catch {
    base = null;
  }

  const protocol = base?.protocol ?? "http:";
  const port = base?.port ? `:${base.port}` : "";
  const candidates = new Set<string>();

  if (base) {
    candidates.add(base.origin);
  }

  const bindHost = normalizeHostname(input.bindHost);
  if (bindHost && !isLoopbackHost(bindHost)) {
    candidates.add(`${protocol}//${bindHost}${port}`);
  }

  for (const rawHost of input.allowedHostnames) {
    const host = normalizeHostname(rawHost);
    if (!host) continue;
    candidates.add(`${protocol}//${host}${port}`);
  }

  if (base && isLoopbackHost(base.hostname)) {
    candidates.add(`${protocol}//host.docker.internal${port}`);
  }

  return Array.from(candidates);
}

function buildInviteOnboardingManifest(
  req: Request,
  token: string,
  invite: typeof invites.$inferSelect,
  opts: {
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
    bindHost: string;
    allowedHostnames: string[];
  }
) {
  const baseUrl = requestBaseUrl(req);
  const skillPath = "/api/skills/aoa";
  const skillUrl = baseUrl ? `${baseUrl}${skillPath}` : skillPath;
  const registrationEndpointPath = `/api/invites/${token}/accept`;
  const registrationEndpointUrl = baseUrl
    ? `${baseUrl}${registrationEndpointPath}`
    : registrationEndpointPath;
  const onboardingTextPath = `/api/invites/${token}/onboarding.txt`;
  const onboardingTextUrl = baseUrl
    ? `${baseUrl}${onboardingTextPath}`
    : onboardingTextPath;
  const testResolutionPath = `/api/invites/${token}/test-resolution`;
  const testResolutionUrl = baseUrl
    ? `${baseUrl}${testResolutionPath}`
    : testResolutionPath;
  const discoveryDiagnostics = buildOnboardingDiscoveryDiagnostics({
    apiBaseUrl: baseUrl,
    deploymentMode: opts.deploymentMode,
    deploymentExposure: opts.deploymentExposure,
    bindHost: opts.bindHost,
    allowedHostnames: opts.allowedHostnames
  });
  const connectionCandidates = buildOnboardingConnectionCandidates({
    apiBaseUrl: baseUrl,
    bindHost: opts.bindHost,
    allowedHostnames: opts.allowedHostnames
  });

  return {
    invite: toInviteSummaryResponse(req, token, invite),
    onboarding: {
      instructions:
        "Join as an OpenClaw agent, save your one-time claim secret, wait for board approval, then claim your API key. Save the claim response token to ~/.openclaw/workspace/paperclip-claimed-api-key.json (filename is wire-compat with existing OpenClaw clients) and load AOA_API_KEY from that file before starting heartbeat loops. You MUST include agentDefaultsPayload.headers.x-openclaw-auth in your join request so AoA can authenticate callback requests.",
      inviteMessage: extractInviteMessage(invite),
      recommendedAdapterType: "openclaw",
      requiredFields: {
        requestType: "agent",
        agentName: "Display name for this agent",
        adapterType: "Use 'openclaw' for OpenClaw agents",
        capabilities: "Optional capability summary",
        agentDefaultsPayload:
          "Adapter config for OpenClaw endpoint. MUST include headers.x-openclaw-auth; include streamTransport ('sse' or 'webhook') plus url/method/paperclipApiUrl (and optional webhookAuthHeader/timeoutSec/payloadTemplate)."
      },
      registrationEndpoint: {
        method: "POST",
        path: registrationEndpointPath,
        url: registrationEndpointUrl
      },
      claimEndpointTemplate: {
        method: "POST",
        path: "/api/join-requests/{requestId}/claim-api-key",
        body: {
          claimSecret:
            "one-time claim secret returned when the join request is created"
        }
      },
      connectivity: {
        deploymentMode: opts.deploymentMode,
        deploymentExposure: opts.deploymentExposure,
        bindHost: opts.bindHost,
        allowedHostnames: opts.allowedHostnames,
        connectionCandidates,
        testResolutionEndpoint: {
          method: "GET",
          path: testResolutionPath,
          url: testResolutionUrl,
          query: {
            url: "https://your-openclaw-agent.example/v1/responses",
            timeoutMs: 5000
          }
        },
        diagnostics: discoveryDiagnostics,
        guidance:
          opts.deploymentMode === "authenticated" &&
          opts.deploymentExposure === "private"
            ? "If OpenClaw runs on another machine, ensure the AoA hostname is reachable and allowed via `pnpm aoa allowed-hostname <host>`."
            : "Ensure OpenClaw can reach this AoA API base URL for callbacks and claims."
      },
      textInstructions: {
        path: onboardingTextPath,
        url: onboardingTextUrl,
        contentType: "text/plain"
      },
      skill: {
        name: "aoa",
        path: skillPath,
        url: skillUrl,
        installPath: "~/.openclaw/skills/aoa/SKILL.md"
      }
    }
  };
}

export function buildInviteOnboardingTextDocument(
  req: Request,
  token: string,
  invite: typeof invites.$inferSelect,
  opts: {
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
    bindHost: string;
    allowedHostnames: string[];
  }
) {
  const manifest = buildInviteOnboardingManifest(req, token, invite, opts);
  const onboarding = manifest.onboarding as {
    inviteMessage?: string | null;
    registrationEndpoint: { method: string; path: string; url: string };
    claimEndpointTemplate: { method: string; path: string };
    textInstructions: { path: string; url: string };
    skill: { path: string; url: string; installPath: string };
    connectivity: {
      diagnostics?: JoinDiagnostic[];
      guidance?: string;
      connectionCandidates?: string[];
      testResolutionEndpoint?: { method?: string; path?: string; url?: string };
    };
  };
  const diagnostics = Array.isArray(onboarding.connectivity?.diagnostics)
    ? onboarding.connectivity.diagnostics
    : [];

  const lines: string[] = [];
  const appendBlock = (block: string) => {
    const trimmed = block.replace(/^\n/, "").replace(/\n\s*$/, "");
    const lineIndentation = trimmed
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => line.match(/^(\s*)/)?.[0].length ?? 0);
    const minIndent =
      lineIndentation.length > 0 ? Math.min(...lineIndentation) : 0;
    for (const line of trimmed.split("\n")) {
      lines.push(line.slice(minIndent));
    }
  };

  appendBlock(`
    # AoA OpenClaw Onboarding

    This document is meant to be readable by both humans and agents.

    ## Invite
    - inviteType: ${invite.inviteType}
    - allowedJoinTypes: ${invite.allowedJoinTypes}
    - expiresAt: ${invite.expiresAt.toISOString()}
  `);

  if (onboarding.inviteMessage) {
    appendBlock(`
      ## Message from inviter
      ${onboarding.inviteMessage}
    `);
  }

  appendBlock(`
    ## Step 0

    Get the OpenClaw gateway auth token (THIS MUST BE SENT)
    Token lives in:

    ~/.openclaw/openclaw.json -> gateway.auth.token
    Extract:

    TOKEN="$(node -p 'require(process.env.HOME+\"/.openclaw/openclaw.json\").gateway.auth.token')"
    test -n "$TOKEN" || (echo "Missing TOKEN" && exit 1)

    3) IMPORTANT: Don't accidentally drop the token when generating JSON
    If you build JSON with Node, pass the token explicitly (argv), don't rely on an un-exported env var.

    Safe payload build looks sort of like this (substitute where necessary):

    BODY="$(node -e '
      const token = process.argv[1];
      if (!token) process.exit(2);
      const body = {
        requestType: "agent",
        agentName: "OpenClaw",
        adapterType: "openclaw",
        capabilities: "OpenClaw agent adapter",
        agentDefaultsPayload: {
          url: "http://127.0.0.1:18789/v1/responses",
          paperclipApiUrl: "http://host.docker.internal:3100",
          streamTransport: "sse",
          method: "POST",
          headers: { "x-openclaw-auth": token },
          timeoutSec: 0
        }
      };
      process.stdout.write(JSON.stringify(body));
    ' "$TOKEN")"

    ## Step 1: Submit agent join request
    ${onboarding.registrationEndpoint.method} ${
    onboarding.registrationEndpoint.url
  }

    IMPORTANT: You MUST include agentDefaultsPayload.headers.x-openclaw-auth with your gateway token.
    Without this token, AoA callback requests to your OpenClaw endpoint will fail with 401 Unauthorized.
    Set "streamTransport" to "sse" for streaming /v1/responses endpoints, or "webhook" for wake-style callbacks.

    Body (JSON):
    {
      "requestType": "agent",
      "agentName": "My OpenClaw Agent",
      "adapterType": "openclaw",
      "capabilities": "Optional summary",
      "agentDefaultsPayload": {
        "url": "https://your-openclaw-agent.example/v1/responses",
        "paperclipApiUrl": "https://aoa-hostname-your-agent-can-reach:3100",
        "streamTransport": "sse",
        "method": "POST",
        "headers": { "x-openclaw-auth": "replace-me" },
        "timeoutSec": 0
      }
    }

    Expected response includes:
    - request id
    - one-time claimSecret
    - claimApiKeyPath

    Verify the response diagnostics include:
    'openclaw_auth_header_configured'
    and do not include:
    'openclaw_auth_header_missing'

    ## Step 2: Wait for board approval
    The board approves the join request in AoA before key claim is allowed.

    ## Step 3: Claim API key (one-time)
    ${
      onboarding.claimEndpointTemplate.method
    } /api/join-requests/{requestId}/claim-api-key

    Body (JSON):
    {
      "claimSecret": "<one-time-claim-secret>"
    }

    On successful claim, save the full JSON response to:

    - ~/.openclaw/workspace/paperclip-claimed-api-key.json
    chmod 600 ~/.openclaw/workspace/paperclip-claimed-api-key.json

    And set the AOA_API_KEY and AOA_API_URL in your environment variables as specified here:
    https://docs.openclaw.ai/help/environment

    e.g. 

    {
      env: {
        AOA_API_KEY: "...",
        AOA_API_URL: "...",
      },
    }

    Then set AOA_API_KEY and AOA_API_URL from the saved token field for every heartbeat run.

    Important:
    - claim secrets expire
    - claim secrets are single-use
    - claim fails before board approval

    ## Step 4: Install AoA skill in OpenClaw
    GET ${onboarding.skill.url}
    Install path: ${onboarding.skill.installPath}

    Be sure to prepend your AOA_API_URL to the top of your skill and note the path to your AOA_API_URL

    ## Text onboarding URL
    ${onboarding.textInstructions.url}

    ## Connectivity guidance
    ${
      onboarding.connectivity?.guidance ??
      "Ensure AoA is reachable from your OpenClaw runtime."
    }
  `);

  if (onboarding.connectivity?.testResolutionEndpoint?.url) {
    appendBlock(`
      ## Optional: test callback resolution from AoA
      ${onboarding.connectivity.testResolutionEndpoint.method ?? "GET"} ${
      onboarding.connectivity.testResolutionEndpoint.url
    }?url=https%3A%2F%2Fyour-openclaw-agent.example%2Fv1%2Fresponses

      This endpoint checks whether AoA can reach your OpenClaw endpoint and reports reachable, timeout, or unreachable.
    `);
  }

  const connectionCandidates = Array.isArray(
    onboarding.connectivity?.connectionCandidates
  )
    ? onboarding.connectivity.connectionCandidates.filter(
        (entry): entry is string => Boolean(entry)
      )
    : [];

  if (connectionCandidates.length > 0) {
    lines.push("## Suggested AoA base URLs to try");
    for (const candidate of connectionCandidates) {
      lines.push(`- ${candidate}`);
    }
    appendBlock(`

      Test each candidate with:
      - GET <candidate>/api/health
      - set the first reachable candidate as agentDefaultsPayload.paperclipApiUrl when submitting your join request

      If none are reachable: ask your human operator for a reachable hostname/address and help them update network configuration.
      For authenticated/private mode, they may need:
      - pnpm aoa allowed-hostname <host>
      - then restart AoA and retry onboarding.
    `);
  }

  if (diagnostics.length > 0) {
    lines.push("## Connectivity diagnostics");
    for (const diag of diagnostics) {
      lines.push(`- [${diag.level}] ${diag.message}`);
      if (diag.hint) lines.push(`  hint: ${diag.hint}`);
    }
  }

  appendBlock(`

    ## Helpful endpoints
    ${onboarding.registrationEndpoint.path}
    ${onboarding.claimEndpointTemplate.path}
    ${onboarding.skill.path}
    ${manifest.invite.onboardingPath}
  `);
  if (onboarding.connectivity?.testResolutionEndpoint?.path) {
    lines.push(`${onboarding.connectivity.testResolutionEndpoint.path}`);
  }

  return `${lines.join("\n")}\n`;
}

function extractInviteMessage(
  invite: typeof invites.$inferSelect
): string | null {
  const rawDefaults = invite.defaultsPayload;
  if (
    !rawDefaults ||
    typeof rawDefaults !== "object" ||
    Array.isArray(rawDefaults)
  ) {
    return null;
  }
  const rawMessage = (rawDefaults as Record<string, unknown>).agentMessage;
  if (typeof rawMessage !== "string") {
    return null;
  }
  const trimmed = rawMessage.trim();
  return trimmed.length ? trimmed : null;
}

function mergeInviteDefaults(
  defaultsPayload: Record<string, unknown> | null | undefined,
  agentMessage: string | null
): Record<string, unknown> | null {
  const merged =
    defaultsPayload && typeof defaultsPayload === "object"
      ? { ...defaultsPayload }
      : {};
  if (agentMessage) {
    merged.agentMessage = agentMessage;
  }
  return Object.keys(merged).length ? merged : null;
}

function requestIp(req: Request) {
  const forwarded = req.header("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.ip || "unknown";
}

function inviteExpired(invite: typeof invites.$inferSelect) {
  return invite.expiresAt.getTime() <= Date.now();
}

function isLocalImplicit(req: Request) {
  return req.actor.type === "board" && req.actor.source === "local_implicit";
}

async function resolveActorEmail(db: Db, req: Request): Promise<string | null> {
  if (isLocalImplicit(req)) return "local@paperclip.local";
  const userId = req.actor.userId;
  if (!userId) return null;
  const user = await db
    .select({ email: authUsers.email })
    .from(authUsers)
    .where(eq(authUsers.id, userId))
    .then((rows) => rows[0] ?? null);
  return user?.email ?? null;
}

type JoinRequestManagerCandidate = {
  id: string;
  role: string;
  reportsTo: string | null;
  parentType?: string | null;
  parentId?: string | null;
};

export function resolveJoinRequestAgentManagerId(
  candidates: JoinRequestManagerCandidate[]
): string | null {
  // Route join requests to a CXO-tier agent (apex preferred, but any CXO is
  // acceptable as a manager candidate). Was historically `=== "ceo"` before
  // the role-enum cleanup.
  const cxoCandidates = candidates.filter(
    (candidate) => candidate.role === "cxo"
  );
  if (cxoCandidates.length === 0) return null;
  const apexCxo = cxoCandidates.find(
    (candidate) => !candidate.parentId && candidate.reportsTo === null
  );
  return (apexCxo ?? cxoCandidates[0] ?? null)?.id ?? null;
}

function isInviteTokenHashCollisionError(error: unknown) {
  const candidates = [
    error,
    (error as { cause?: unknown } | null)?.cause ?? null
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const code =
      "code" in candidate && typeof candidate.code === "string"
        ? candidate.code
        : null;
    const message =
      "message" in candidate && typeof candidate.message === "string"
        ? candidate.message
        : "";
    const constraint =
      "constraint" in candidate && typeof candidate.constraint === "string"
        ? candidate.constraint
        : null;
    if (code !== "23505") continue;
    if (constraint === "invites_token_hash_unique_idx") return true;
    if (message.includes("invites_token_hash_unique_idx")) return true;
  }
  return false;
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

type InviteResolutionProbe = {
  status: "reachable" | "timeout" | "unreachable";
  method: "HEAD";
  durationMs: number;
  httpStatus: number | null;
  message: string;
};

async function probeInviteResolutionTarget(
  target: ValidatedFetchTarget,
  timeoutMs: number
): Promise<InviteResolutionProbe> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // H7 (SSRF): pin the IP resolved by validateAndResolveFetchUrl and issue the
    // HEAD via executePinnedRequest (node http(s).request, which does not follow
    // redirects — same intent as the previous fetch's redirect:"manual"). This
    // closes the DNS-rebind window between validation and probe.
    const response = await executePinnedRequest(
      target,
      { method: "HEAD" },
      controller.signal
    );
    const durationMs = Date.now() - startedAt;
    const reachable =
      (response.status >= 200 && response.status < 300) ||
      response.status === 401 ||
      response.status === 403 ||
      response.status === 404 ||
      response.status === 405 ||
      response.status === 422 ||
      response.status === 500 ||
      response.status === 501;
    if (reachable) {
      return {
        status: "reachable",
        method: "HEAD",
        durationMs,
        httpStatus: response.status,
        message: `Webhook endpoint responded to HEAD with HTTP ${response.status}.`
      };
    }
    return {
      status: "unreachable",
      method: "HEAD",
      durationMs,
      httpStatus: response.status,
      message: `Webhook endpoint probe returned HTTP ${response.status}.`
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    if (isAbortError(error)) {
      return {
        status: "timeout",
        method: "HEAD",
        durationMs,
        httpStatus: null,
        message: `Webhook endpoint probe timed out after ${timeoutMs}ms.`
      };
    }
    return {
      status: "unreachable",
      method: "HEAD",
      durationMs,
      httpStatus: null,
      message:
        error instanceof Error
          ? error.message
          : "Webhook endpoint probe failed."
    };
  } finally {
    clearTimeout(timeout);
  }
}

function toUserProfile(
  user:
    | {
      id: string;
      email: string | null;
      name: string | null;
      image?: string | null;
    }
    | null
    | undefined,
) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email ?? null,
    name: user.name ?? null,
    image: user.image ?? null,
  };
}

async function loadUserCompanyAccessResponse(
  db: Db,
  access: ReturnType<typeof accessService>,
  userId: string,
) {
  const [memberships, user, isInstanceAdmin] = await Promise.all([
    access.listUserCompanyAccess(userId),
    db
      .select({
        id: authUsers.id,
        email: authUsers.email,
        name: authUsers.name,
        image: authUsers.image,
      })
      .from(authUsers)
      .where(eq(authUsers.id, userId))
      .then((rows) => rows[0] ?? null),
    access.isInstanceAdmin(userId),
  ]);
  const companyIds = [...new Set(memberships.map((membership) => membership.companyId))];
  const companyRows = companyIds.length
    ? await db
        .select({
          id: companies.id,
          name: companies.name,
          status: companies.status,
        })
        .from(companies)
        .where(inArray(companies.id, companyIds))
    : [];
  const companyMap = new Map(companyRows.map((company) => [company.id, company]));

  return {
    user: user
      ? {
          id: user.id,
          email: user.email ?? null,
          name: user.name ?? null,
          image: user.image ?? null,
          isInstanceAdmin,
        }
      : null,
    companyAccess: memberships.map((membership) => {
      const company = companyMap.get(membership.companyId) ?? null;
      return {
        ...membership,
        principalType: "user" as const,
        companyName: company?.name ?? null,
        companyStatus: company?.status ?? null,
      };
    }),
  };
}

export function accessRoutes(
  db: Db,
  opts: {
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
    bindHost: string;
    allowedHostnames: string[];
  }
) {
  const router = Router();
  const access = accessService(db);
  const team = teamService(db);
  const agents = agentService(db);

  async function assertInstanceAdmin(req: Request) {
    if (req.actor.type !== "board") throw unauthorized();
    if (isLocalImplicit(req)) return;
    const allowed = await access.isInstanceAdmin(req.actor.userId);
    if (!allowed) throw forbidden("Instance admin required");
  }

  function assertAdminUserManagementAvailable() {
    if (opts.deploymentMode === "cloud_auth") {
      throw forbidden("Instance-wide user administration is unavailable in cloud mode");
    }
  }

  router.get("/board-claim/:token", async (req, res) => {
    const token = (req.params.token as string).trim();
    const code =
      typeof req.query.code === "string" ? req.query.code.trim() : undefined;
    if (!token) throw notFound("Board claim challenge not found");
    const challenge = inspectBoardClaimChallenge(token, code);
    if (challenge.status === "invalid")
      throw notFound("Board claim challenge not found");
    res.json(challenge);
  });

  router.post("/board-claim/:token/claim", async (req, res) => {
    const token = (req.params.token as string).trim();
    const code =
      typeof req.body?.code === "string" ? req.body.code.trim() : undefined;
    if (!token) throw notFound("Board claim challenge not found");
    if (!code) throw badRequest("Claim code is required");
    if (
      req.actor.type !== "board" ||
      req.actor.source !== "session" ||
      !req.actor.userId
    ) {
      throw unauthorized("Sign in before claiming board ownership");
    }

    const claimed = await claimBoardOwnership(db, {
      token,
      code,
      userId: req.actor.userId,
      deploymentMode: opts.deploymentMode
    });

    if (claimed.status === "invalid")
      throw notFound("Board claim challenge not found");
    if (claimed.status === "expired")
      throw conflict(
        "Board claim challenge expired. Restart server to generate a new one."
      );
    if (claimed.status === "claimed") {
      res.json({
        claimed: true,
        userId: claimed.claimedByUserId ?? req.actor.userId
      });
      return;
    }

    throw conflict("Board claim challenge is no longer available");
  });

  async function assertCompanyPermission(
    req: Request,
    companyId: string,
    permissionKey: any
  ) {
    await assertCompanyAccess(db, req, companyId);
    if (req.actor.type === "agent") {
      if (!req.actor.agentId) throw forbidden();
      const allowed = await access.hasPermission(
        companyId,
        "agent",
        req.actor.agentId,
        permissionKey
      );
      if (!allowed) throw forbidden("Permission denied");
      return;
    }
    if (req.actor.type !== "board") throw unauthorized();
    if (isLocalImplicit(req)) return;
    const allowed = await access.canUser(
      companyId,
      req.actor.userId,
      permissionKey
    );
    if (!allowed) throw forbidden("Permission denied");
  }

  router.get("/skills/index", (_req, res) => {
    res.json({
      skills: [
        { name: "aoa", path: "/api/skills/aoa" },
        {
          name: "aoa-create-agent",
          path: "/api/skills/aoa-create-agent"
        }
      ]
    });
  });

  router.get("/skills/:skillName", (req, res) => {
    const skillName = (req.params.skillName as string).trim().toLowerCase();
    const markdown = readSkillMarkdown(skillName);
    if (!markdown) throw notFound("Skill not found");
    res.type("text/markdown").send(markdown);
  });

  router.post(
    "/companies/:companyId/invites",
    validate(createCompanyInviteSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCompanyPermission(req, companyId, "users:invite");

      // Parse the invite's defaultsPayload once — both the privileged gate (all
      // caller types) and the non-founder BOARD grants floor below read it.
      const rawDefaults =
        req.body.defaultsPayload &&
        typeof req.body.defaultsPayload === "object" &&
        !Array.isArray(req.body.defaultsPayload)
          ? (req.body.defaultsPayload as Record<string, unknown>)
          : null;

      // ── P1 privilege-escalation clamp (Codex round-5 + round-6, root seam) ──
      // `users:invite` is delegable to non-founders (and to agents), but the
      // invite's defaultsPayload (teamInvite.role + human/agent grants) is
      // applied VERBATIM at approval / auto-admit. A "privileged" payload — a
      // role above team_lead (founder), or a governance grant in
      // {users:manage_permissions, joins:approve, users:invite} in EITHER the
      // human OR the agent grant vector (the SHARED inviteConfersPrivilegedAuthority
      // predicate) — may be MINTED only by an authenticated FOUNDER or the
      // local_trusted synthetic human, on EVERY path, for EVERY caller type.
      //
      // The gate is "actor is a founder OR local_implicit", NOT "actor is board":
      // agents are NOT exempt. The old "agents are exempt; the auto-admit sink is
      // the backstop" reasoning was wrong: that sink only guards the unattended
      // email-match finalize path — NOT this creation route, and NOT the sibling
      // manual-approve route. An agent holding users:invite + joins:approve could
      // otherwise mint a role:"founder" invite (or one conferring a governance key
      // on a joining agent via the agent grant vector) here and self-apply it
      // there, escalating with no founder in the loop. An agent actor has NO
      // founder userId → it can never be a founder → refused. Founder status
      // resolves only for a board actor with a userId (team.getUserRole →
      // effective role, maps instance_admin → founder).
      if (rawDefaults && inviteConfersPrivilegedAuthority(rawDefaults) && !isLocalImplicit(req)) {
        const actorIsFounder =
          req.actor.type === "board" && req.actor.userId
            ? (await team.getUserRole(companyId, req.actor.userId)).role === "founder"
            : false; // agents (and any non-board / userId-less actor) are never founders
        if (!actorIsFounder) {
          throw forbidden(
            "Only founders can create an invite that confers founder role or privileged permissions",
          );
        }
      }

      // Non-privileged grants floor (round-5 → extended round-14): a NON-FOUNDER
      // creator — board user OR agent — must hold `users:manage_permissions` to
      // embed ANY permission grant, and can NEVER embed a key it does not itself
      // hold. Privileged payloads are already refused above regardless of caller
      // type, so this floor now only governs NON-privileged grants (agents:create,
      // tasks:assign, tasks:assign_scope, …).
      //
      // Round-14 P1: this floor previously ran ONLY for `req.actor.type === "board"`,
      // so an AGENT holding just `users:invite` was EXEMPT — it could embed a
      // non-privileged grant it did NOT hold in a HUMAN invite, and the
      // verified-email auto-admit sink (approveHumanJoinRequestTx) would apply it
      // VERBATIM with no founder review, conferring a capability the agent never
      // held (and, by inviting an email it controls, bootstrapping that capability
      // into a human sockpuppet). The floor now covers agents too. The creator's
      // held permissions are resolved the SAME way assertCompanyPermission
      // authorizes each actor: board users via access.canUser (which includes the
      // instance-admin bypass), agents via access.hasPermission on the "agent"
      // principal. Agents are never founders (no founder userId), matching the
      // privileged gate above; local_implicit (loopback-trusted board) keeps full
      // capability and is unaffected.
      //
      // users:manage_permissions prerequisite for agents: applied identically to
      // the board rule. Agents create AGENTS via /api/agents, never via invite
      // grant vectors, so no legitimate agent-invite flow embeds grants without
      // manage_permissions — an agent must hold manage_permissions to delegate at
      // all, AND hold each embedded key.
      if (rawDefaults && !isLocalImplicit(req)) {
        let creatorIsFounder = false;
        // Resolver mirroring assertCompanyPermission's per-actor authorization.
        let holdsKey: ((key: PermissionKey) => Promise<boolean>) | null = null;

        if (req.actor.type === "board" && req.actor.userId) {
          const creatorId = req.actor.userId;
          const { role: creatorRole } = await team.getUserRole(companyId, creatorId);
          creatorIsFounder = creatorRole === "founder"; // getUserRole maps instance_admin → founder
          holdsKey = (key) => access.canUser(companyId, creatorId, key);
        } else if (req.actor.type === "agent" && req.actor.agentId) {
          const creatorAgentId = req.actor.agentId;
          // Agents are never founders; resolve held grants exactly as
          // assertCompanyPermission does for an agent principal.
          holdsKey = (key) =>
            access.hasPermission(companyId, "agent", creatorAgentId, key);
        }

        if (holdsKey && !creatorIsFounder) {
          const embeddedGrants = [
            ...grantsFromDefaults(rawDefaults, "human"),
            ...grantsFromDefaults(rawDefaults, "agent"),
          ];
          if (embeddedGrants.length > 0) {
            const canDelegateGrants = await holdsKey("users:manage_permissions");
            if (!canDelegateGrants) {
              throw forbidden(
                "You need users:manage_permissions to embed permission grants in an invite",
              );
            }
            for (const grant of embeddedGrants) {
              const creatorHoldsKey = await holdsKey(grant.permissionKey);
              if (!creatorHoldsKey) {
                throw forbidden(
                  `You cannot grant a permission you do not hold: ${grant.permissionKey}`,
                );
              }
            }
          }
        }
      }
      // ────────────────────────────────────────────────────────────────────────

      const normalizedAgentMessage =
        typeof req.body.agentMessage === "string"
          ? req.body.agentMessage.trim() || null
          : null;
      const defaultsPayload = mergeInviteDefaults(
        req.body.defaultsPayload ?? null,
        normalizedAgentMessage
      );
      const insertValues = {
        companyId,
        inviteType: "company_join" as const,
        allowedJoinTypes: req.body.allowedJoinTypes,
        defaultsPayload,
        // Human-only email-bound team invites get the long TTL (see
        // access-helpers.ts): the verified-email match is the real gate,
        // link secrecy is secondary. Agent/both invites keep 10 minutes.
        expiresAt: companyInviteExpiresAt(
          defaultsPayload,
          req.body.allowedJoinTypes
        ),
        invitedByUserId: req.actor.userId ?? null
      };

      let token: string | null = null;
      let created: typeof invites.$inferSelect | null = null;
      for (let attempt = 0; attempt < INVITE_TOKEN_MAX_RETRIES; attempt += 1) {
        const candidateToken = createInviteToken();
        try {
          const row = await db
            .insert(invites)
            .values({
              ...insertValues,
              tokenHash: hashToken(candidateToken)
            })
            .returning()
            .then((rows) => rows[0]);
          token = candidateToken;
          created = row;
          break;
        } catch (error) {
          if (!isInviteTokenHashCollisionError(error)) {
            throw error;
          }
        }
      }
      if (!token || !created) {
        throw conflict(
          "Failed to generate a unique invite token. Please retry."
        );
      }

      await logActivity(db, {
        companyId,
        actorType: req.actor.type === "agent" ? "agent" : "user",
        actorId:
          req.actor.type === "agent"
            ? req.actor.agentId ?? "unknown-agent"
            : req.actor.userId ?? "board",
        action: "invite.created",
        entityType: "invite",
        entityId: created.id,
        details: {
          inviteType: created.inviteType,
          allowedJoinTypes: created.allowedJoinTypes,
          expiresAt: created.expiresAt.toISOString(),
          hasAgentMessage: Boolean(normalizedAgentMessage)
        }
      });

      const inviteSummary = toInviteSummaryResponse(req, token, created);
      // Build the auto-copied invite link from a TRUSTED origin: the configured
      // public URL first, then a trust-proxy-gated / Host-based fallback. Never
      // a spoofable X-Forwarded-Host (host-header injection into the copied
      // link would disclose the invite token to an attacker origin).
      const inviteBaseUrl = resolveInviteBaseUrl(req);
      const invitePath = `/invite/${token}`;
      res.status(201).json({
        ...created,
        token,
        // Absolute so copying the link verbatim works outside this browser.
        // Falls back to the path when no trusted origin is available (the
        // client then prefixes its own window.location.origin).
        inviteUrl: inviteBaseUrl ? `${inviteBaseUrl}${invitePath}` : invitePath,
        onboardingTextPath: inviteSummary.onboardingTextPath,
        onboardingTextUrl: inviteSummary.onboardingTextUrl,
        inviteMessage: inviteSummary.inviteMessage
      });
    }
  );

  router.get("/invites/:token", async (req, res) => {
    const token = (req.params.token as string).trim();
    if (!token) throw notFound("Invite not found");
    // Left join: resolve the company name in the same query so the landing
    // page can say "Join {name} on AoA" (bootstrap invites have no company).
    const row = await db
      .select({ invite: invites, companyName: companies.name })
      .from(invites)
      .leftJoin(companies, eq(invites.companyId, companies.id))
      .where(eq(invites.tokenHash, hashToken(token)))
      .then((rows) => rows[0] ?? null);
    const invite = row?.invite ?? null;
    if (
      !invite ||
      invite.revokedAt ||
      invite.acceptedAt ||
      inviteExpired(invite)
    ) {
      throw notFound("Invite not found");
    }

    res.json(toInviteSummaryResponse(req, token, invite, row?.companyName ?? null));
  });

  router.get("/invites/:token/onboarding", async (req, res) => {
    const token = (req.params.token as string).trim();
    if (!token) throw notFound("Invite not found");
    const invite = await db
      .select()
      .from(invites)
      .where(eq(invites.tokenHash, hashToken(token)))
      .then((rows) => rows[0] ?? null);
    if (!invite || invite.revokedAt || inviteExpired(invite)) {
      throw notFound("Invite not found");
    }

    res.json(buildInviteOnboardingManifest(req, token, invite, opts));
  });

  router.get("/invites/:token/onboarding.txt", async (req, res) => {
    const token = (req.params.token as string).trim();
    if (!token) throw notFound("Invite not found");
    const invite = await db
      .select()
      .from(invites)
      .where(eq(invites.tokenHash, hashToken(token)))
      .then((rows) => rows[0] ?? null);
    if (!invite || invite.revokedAt || inviteExpired(invite)) {
      throw notFound("Invite not found");
    }

    res
      .type("text/plain; charset=utf-8")
      .send(buildInviteOnboardingTextDocument(req, token, invite, opts));
  });

  router.get("/invites/:token/test-resolution", async (req, res) => {
    const token = (req.params.token as string).trim();
    if (!token) throw notFound("Invite not found");
    const invite = await db
      .select()
      .from(invites)
      .where(eq(invites.tokenHash, hashToken(token)))
      .then((rows) => rows[0] ?? null);
    if (!invite || invite.revokedAt || inviteExpired(invite)) {
      throw notFound("Invite not found");
    }

    const rawUrl =
      typeof req.query.url === "string" ? req.query.url.trim() : "";
    if (!rawUrl) throw badRequest("url query parameter is required");
    let target: URL;
    try {
      target = new URL(rawUrl);
    } catch {
      throw badRequest("url must be an absolute http(s) URL");
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      throw badRequest("url must use http or https");
    }

    // H7 (SSRF): this route is authorized solely by invite-token possession
    // (pre-auth — no board session, no RBAC, GET passes boardMutationGuard).
    // Without the central guard the user-supplied url is an unauthenticated
    // blind-SSRF / internal-port-scan oracle (cloud metadata 169.254.169.254,
    // RFC1918, loopback). Route the probe through validateAndResolveFetchUrl —
    // the same guard the http adapter / plugin host / skills-import use — which
    // rejects private/reserved IPs and disallowed protocols and returns a target
    // whose IP the probe below pins (DNS-rebind safe). A blocked URL becomes a
    // 400, never a probe.
    let validatedTarget: ValidatedFetchTarget;
    try {
      validatedTarget = await validateAndResolveFetchUrl(target.toString());
    } catch (err) {
      throw badRequest(
        err instanceof Error
          ? `url failed SSRF validation: ${err.message}`
          : "url failed SSRF validation"
      );
    }

    const parsedTimeoutMs =
      typeof req.query.timeoutMs === "string"
        ? Number(req.query.timeoutMs)
        : NaN;
    const timeoutMs = Number.isFinite(parsedTimeoutMs)
      ? Math.max(1000, Math.min(15000, Math.floor(parsedTimeoutMs)))
      : 5000;
    const probe = await probeInviteResolutionTarget(validatedTarget, timeoutMs);
    res.json({
      inviteId: invite.id,
      testResolutionPath: `/api/invites/${token}/test-resolution`,
      requestedUrl: validatedTarget.parsedUrl.toString(),
      timeoutMs,
      ...probe
    });
  });

  router.post(
    "/invites/:token/accept",
    validate(acceptInviteSchema),
    async (req, res) => {
      const token = (req.params.token as string).trim();
      if (!token) throw notFound("Invite not found");

      const invite = await db
        .select()
        .from(invites)
        .where(eq(invites.tokenHash, hashToken(token)))
        .then((rows) => rows[0] ?? null);
      if (!invite || invite.revokedAt || inviteExpired(invite)) {
        throw notFound("Invite not found");
      }
      const inviteAlreadyAccepted = Boolean(invite.acceptedAt);
      const existingJoinRequestForInvite = inviteAlreadyAccepted
        ? await db
            .select()
            .from(joinRequests)
            .where(eq(joinRequests.inviteId, invite.id))
            .then((rows) => rows[0] ?? null)
        : null;

      if (invite.inviteType === "bootstrap_ceo") {
        if (inviteAlreadyAccepted) throw notFound("Invite not found");
        if (req.body.requestType !== "human") {
          throw badRequest("Bootstrap invite requires human request type");
        }
        if (
          req.actor.type !== "board" ||
          (!req.actor.userId && !isLocalImplicit(req))
        ) {
          throw unauthorized(
            "Authenticated user required for bootstrap acceptance"
          );
        }
        const userId = req.actor.userId ?? "local-board";
        if (bootstrapCeoPromotionAllowed(opts.deploymentMode)) {
          const existingAdmin = await access.isInstanceAdmin(userId);
          if (!existingAdmin) {
            await access.promoteInstanceAdmin(userId);
          }
        } else {
          throw forbidden("Bootstrap CEO promotion is disabled in this deployment mode");
        }
        const updatedInvite = await db
          .update(invites)
          .set({ acceptedAt: new Date(), updatedAt: new Date() })
          .where(eq(invites.id, invite.id))
          .returning()
          .then((rows) => rows[0] ?? invite);
        res.status(202).json({
          inviteId: updatedInvite.id,
          inviteType: updatedInvite.inviteType,
          bootstrapAccepted: true,
          userId
        });
        return;
      }

      const requestType = req.body.requestType as "human" | "agent";
      const companyId = invite.companyId;
      if (!companyId) throw conflict("Invite is missing company scope");
      if (
        invite.allowedJoinTypes !== "both" &&
        invite.allowedJoinTypes !== requestType
      ) {
        throw badRequest(`Invite does not allow ${requestType} joins`);
      }

      if (requestType === "human" && req.actor.type !== "board") {
        throw unauthorized(
          "Human invite acceptance requires authenticated user"
        );
      }
      if (
        requestType === "human" &&
        !req.actor.userId &&
        !isLocalImplicit(req)
      ) {
        throw unauthorized("Authenticated user is required");
      }
      if (requestType === "agent" && !req.body.agentName) {
        if (
          !inviteAlreadyAccepted ||
          !existingJoinRequestForInvite?.agentName
        ) {
          throw badRequest("agentName is required for agent join requests");
        }
      }

      const adapterType = req.body.adapterType ?? null;
      if (
        inviteAlreadyAccepted &&
        !canReplayOpenClawInviteAccept({
          requestType,
          adapterType,
          existingJoinRequest: existingJoinRequestForInvite
        })
      ) {
        throw notFound("Invite not found");
      }
      const replayJoinRequestId = inviteAlreadyAccepted
        ? existingJoinRequestForInvite?.id ?? null
        : null;
      if (inviteAlreadyAccepted && !replayJoinRequestId) {
        throw conflict("Join request not found");
      }

      const replayMergedDefaults = inviteAlreadyAccepted
        ? mergeJoinDefaultsPayloadForReplay(
            existingJoinRequestForInvite?.agentDefaultsPayload ?? null,
            req.body.agentDefaultsPayload ?? null
          )
        : req.body.agentDefaultsPayload ?? null;

      const openClawDefaultsPayload =
        requestType === "agent"
          ? buildJoinDefaultsPayloadForAccept({
              adapterType,
              defaultsPayload: replayMergedDefaults,
              responsesWebhookUrl: req.body.responsesWebhookUrl ?? null,
              responsesWebhookMethod: req.body.responsesWebhookMethod ?? null,
              responsesWebhookHeaders: req.body.responsesWebhookHeaders ?? null,
              paperclipApiUrl: req.body.paperclipApiUrl ?? null,
              webhookAuthHeader: req.body.webhookAuthHeader ?? null,
              inboundOpenClawAuthHeader: req.header("x-openclaw-auth") ?? null,
              inboundOpenClawTokenHeader: req.header("x-openclaw-token") ?? null
            })
          : null;

      if (requestType === "agent" && adapterType === "openclaw") {
        logger.info(
          {
            inviteId: invite.id,
            requestType,
            adapterType,
            bodyKeys: isPlainObject(req.body)
              ? Object.keys(req.body).sort()
              : [],
            responsesWebhookUrl: nonEmptyTrimmedString(
              req.body.responsesWebhookUrl
            ),
            paperclipApiUrl: nonEmptyTrimmedString(req.body.paperclipApiUrl),
            webhookAuthHeader: summarizeSecretForLog(
              req.body.webhookAuthHeader
            ),
            inboundOpenClawAuthHeader: summarizeSecretForLog(
              req.header("x-openclaw-auth") ?? null
            ),
            inboundOpenClawTokenHeader: summarizeSecretForLog(
              req.header("x-openclaw-token") ?? null
            ),
            rawAgentDefaults: summarizeOpenClawDefaultsForLog(
              req.body.agentDefaultsPayload ?? null
            ),
            mergedAgentDefaults: summarizeOpenClawDefaultsForLog(
              openClawDefaultsPayload
            )
          },
          "invite accept received OpenClaw join payload"
        );
      }

      const joinDefaults =
        requestType === "agent"
          ? normalizeAgentDefaultsForJoin({
              adapterType,
              defaultsPayload: openClawDefaultsPayload,
              deploymentMode: opts.deploymentMode,
              deploymentExposure: opts.deploymentExposure,
              bindHost: opts.bindHost,
              allowedHostnames: opts.allowedHostnames
            })
          : {
              normalized: null as Record<string, unknown> | null,
              diagnostics: [] as JoinDiagnostic[]
            };

      if (requestType === "agent" && adapterType === "openclaw") {
        logger.info(
          {
            inviteId: invite.id,
            joinRequestDiagnostics: joinDefaults.diagnostics.map((diag) => ({
              code: diag.code,
              level: diag.level
            })),
            normalizedAgentDefaults: summarizeOpenClawDefaultsForLog(
              joinDefaults.normalized
            )
          },
          "invite accept normalized OpenClaw defaults"
        );
      }

      const claimSecret =
        requestType === "agent" && !inviteAlreadyAccepted
          ? createClaimSecret()
          : null;
      const claimSecretHash = claimSecret ? hashToken(claimSecret) : null;
      const claimSecretExpiresAt = claimSecret
        ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
        : null;

      const actorEmail =
        requestType === "human" ? await resolveActorEmail(db, req) : null;
      const created = !inviteAlreadyAccepted
        ? await db.transaction(async (tx) => {
            await tx
              .update(invites)
              .set({ acceptedAt: new Date(), updatedAt: new Date() })
              .where(
                and(
                  eq(invites.id, invite.id),
                  isNull(invites.acceptedAt),
                  isNull(invites.revokedAt)
                )
              );

            const row = await tx
              .insert(joinRequests)
              .values({
                inviteId: invite.id,
                companyId,
                requestType,
                status: "pending_approval",
                requestIp: requestIp(req),
                requestingUserId:
                  requestType === "human"
                    ? req.actor.userId ?? "local-board"
                    : null,
                requestEmailSnapshot:
                  requestType === "human" ? actorEmail : null,
                agentName: requestType === "agent" ? req.body.agentName : null,
                adapterType: requestType === "agent" ? adapterType : null,
                capabilities:
                  requestType === "agent"
                    ? req.body.capabilities ?? null
                    : null,
                agentDefaultsPayload:
                  requestType === "agent" ? joinDefaults.normalized : null,
                claimSecretHash,
                claimSecretExpiresAt
              })
              .returning()
              .then((rows) => rows[0]);
            if (row) {
              await emitHubItem(tx as unknown as Db, buildJoinRequestHubEmit(row));
            }
            return row;
          })
        : await db.transaction(async (tx) => {
            const row = await tx
              .update(joinRequests)
              .set({
                requestIp: requestIp(req),
                agentName:
                  requestType === "agent"
                    ? req.body.agentName ??
                      existingJoinRequestForInvite?.agentName ??
                      null
                    : null,
                capabilities:
                  requestType === "agent"
                    ? req.body.capabilities ??
                      existingJoinRequestForInvite?.capabilities ??
                      null
                    : null,
                adapterType: requestType === "agent" ? adapterType : null,
                agentDefaultsPayload:
                  requestType === "agent" ? joinDefaults.normalized : null,
                updatedAt: new Date()
              })
              .where(
                and(
                  eq(joinRequests.id, replayJoinRequestId as string),
                  eq(joinRequests.companyId, companyId)
                )
              )
              .returning()
              .then((rows) => rows[0]);
            if (row?.status === "pending_approval") {
              await emitHubItem(tx as unknown as Db, buildJoinRequestHubEmit(row));
            }
            return row;
          });

      if (!created) {
        throw conflict("Join request not found");
      }

      if (
        inviteAlreadyAccepted &&
        requestType === "agent" &&
        adapterType === "openclaw" &&
        created.status === "approved" &&
        created.createdAgentId
      ) {
        const existingAgent = await agents.getById(created.createdAgentId);
        if (!existingAgent) {
          throw conflict("Approved join request agent not found");
        }
        const existingAdapterConfig = isPlainObject(existingAgent.adapterConfig)
          ? (existingAgent.adapterConfig as Record<string, unknown>)
          : {};
        const nextAdapterConfig = {
          ...existingAdapterConfig,
          ...(joinDefaults.normalized ?? {})
        };
        const updatedAgent = await agents.update(created.createdAgentId, {
          adapterType,
          adapterConfig: nextAdapterConfig
        });
        if (!updatedAgent) {
          throw conflict("Approved join request agent not found");
        }
        await logActivity(db, {
          companyId,
          actorType: req.actor.type === "agent" ? "agent" : "user",
          actorId:
            req.actor.type === "agent"
              ? req.actor.agentId ?? "invite-agent"
              : req.actor.userId ?? "board",
          action: "agent.updated_from_join_replay",
          entityType: "agent",
          entityId: updatedAgent.id,
          details: { inviteId: invite.id, joinRequestId: created.id }
        });
      }

      if (requestType === "agent" && adapterType === "openclaw") {
        const expectedDefaults = summarizeOpenClawDefaultsForLog(
          joinDefaults.normalized
        );
        const persistedDefaults = summarizeOpenClawDefaultsForLog(
          created.agentDefaultsPayload
        );
        const missingPersistedFields: string[] = [];

        if (expectedDefaults.url && !persistedDefaults.url)
          missingPersistedFields.push("url");
        if (
          expectedDefaults.paperclipApiUrl &&
          !persistedDefaults.paperclipApiUrl
        ) {
          missingPersistedFields.push("paperclipApiUrl");
        }
        if (
          expectedDefaults.webhookAuthHeader &&
          !persistedDefaults.webhookAuthHeader
        ) {
          missingPersistedFields.push("webhookAuthHeader");
        }
        if (
          expectedDefaults.openClawAuthHeader &&
          !persistedDefaults.openClawAuthHeader
        ) {
          missingPersistedFields.push(
            "headers.x-openclaw-token|headers.x-openclaw-auth"
          );
        }
        if (
          expectedDefaults.headerKeys.length > 0 &&
          persistedDefaults.headerKeys.length === 0
        ) {
          missingPersistedFields.push("headers");
        }

        logger.info(
          {
            inviteId: invite.id,
            joinRequestId: created.id,
            joinRequestStatus: created.status,
            expectedDefaults,
            persistedDefaults,
            diagnostics: joinDefaults.diagnostics.map((diag) => ({
              code: diag.code,
              level: diag.level,
              message: diag.message,
              hint: diag.hint ?? null
            }))
          },
          "invite accept persisted OpenClaw join request"
        );

        if (missingPersistedFields.length > 0) {
          logger.warn(
            {
              inviteId: invite.id,
              joinRequestId: created.id,
              missingPersistedFields
            },
            "invite accept detected missing persisted OpenClaw defaults"
          );
        }
      }

      await logActivity(db, {
        companyId,
        actorType: req.actor.type === "agent" ? "agent" : "user",
        actorId:
          req.actor.type === "agent"
            ? req.actor.agentId ?? "invite-agent"
            : req.actor.userId ??
              (requestType === "agent" ? "invite-anon" : "board"),
        action: inviteAlreadyAccepted
          ? "join.request_replayed"
          : "join.requested",
        entityType: "join_request",
        entityId: created.id,
        details: {
          requestType,
          requestIp: created.requestIp,
          inviteReplay: inviteAlreadyAccepted
        }
      });

      const response = toJoinRequestResponse(created);
      if (claimSecret) {
        const onboardingManifest = buildInviteOnboardingManifest(
          req,
          token,
          invite,
          opts
        );
        res.status(202).json({
          ...response,
          claimSecret,
          claimApiKeyPath: `/api/join-requests/${created.id}/claim-api-key`,
          onboarding: onboardingManifest.onboarding,
          diagnostics: joinDefaults.diagnostics
        });
        return;
      }
      res.status(202).json({
        ...response,
        ...(joinDefaults.diagnostics.length > 0
          ? { diagnostics: joinDefaults.diagnostics }
          : {})
      });
    }
  );

  router.post("/invites/:inviteId/revoke", async (req, res) => {
    const id = req.params.inviteId as string;
    const invite = await db
      .select()
      .from(invites)
      .where(eq(invites.id, id))
      .then((rows) => rows[0] ?? null);
    if (!invite) throw notFound("Invite not found");
    if (invite.inviteType === "bootstrap_ceo") {
      await assertInstanceAdmin(req);
    } else {
      if (!invite.companyId) throw conflict("Invite is missing company scope");
      await assertCompanyPermission(req, invite.companyId, "users:invite");
    }
    if (invite.acceptedAt) throw conflict("Invite already consumed");
    if (invite.revokedAt) return res.json(invite);

    const revoked = await db
      .update(invites)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(eq(invites.id, id))
      .returning()
      .then((rows) => rows[0]);

    if (invite.companyId) {
      await logActivity(db, {
        companyId: invite.companyId,
        actorType: req.actor.type === "agent" ? "agent" : "user",
        actorId:
          req.actor.type === "agent"
            ? req.actor.agentId ?? "unknown-agent"
            : req.actor.userId ?? "board",
        action: "invite.revoked",
        entityType: "invite",
        entityId: id
      });
    }

    res.json(revoked);
  });

  router.get("/companies/:companyId/join-requests", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyPermission(req, companyId, "joins:approve");
    const query = listJoinRequestsQuerySchema.parse(req.query);
    const all = await db
      .select()
      .from(joinRequests)
      .where(eq(joinRequests.companyId, companyId))
      .orderBy(desc(joinRequests.createdAt));
    const filtered = all.filter((row) => {
      if (query.status && row.status !== query.status) return false;
      if (query.requestType && row.requestType !== query.requestType)
        return false;
      return true;
    });
    res.json(filtered.map(toJoinRequestResponse));
  });

  router.post(
    "/companies/:companyId/join-requests/:requestId/approve",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const requestId = req.params.requestId as string;
      await assertCompanyPermission(req, companyId, "joins:approve");

      const existing = await db
        .select()
        .from(joinRequests)
        .where(
          and(
            eq(joinRequests.companyId, companyId),
            eq(joinRequests.id, requestId)
          )
        )
        .then((rows) => rows[0] ?? null);
      if (!existing) throw notFound("Join request not found");
      if (existing.status !== "pending_approval")
        throw conflict("Join request is not pending");

      const invite = await db
        .select()
        .from(invites)
        .where(eq(invites.id, existing.inviteId))
        .then((rows) => rows[0] ?? null);
      if (!invite) throw notFound("Invite not found");

      // ── P1 privilege-escalation clamp — MANUAL approve seam ─────────────────
      // Symmetric with the invite-CREATION clamp (POST /invites) and the
      // AUTO-ADMIT sink (onboarding-join finalize). `joins:approve` is delegable
      // to non-founders (and to agents), and this route applies the invite's
      // defaultsPayload (role + grants) VERBATIM — human grants via
      // approveHumanJoinRequestTx on the human branch, AGENT grants via
      // grantsFromDefaults(payload, "agent") → setPrincipalGrants on the
      // agent-hire branch below. A "privileged" payload (role above team_lead, or
      // a governance grant in {users:manage_permissions, joins:approve,
      // users:invite} in EITHER the human OR the agent grant vector — the SHARED
      // inviteConfersPrivilegedAuthority predicate) may be APPLIED only by an
      // authenticated FOUNDER or the local_trusted synthetic human.
      //
      // Gate: "actor is a founder OR local_implicit", NOT "actor is board" —
      // agents are NOT exempt. It covers BOTH request branches (no requestType
      // filter): the auto-admit sink guards ONLY the unattended human finalize
      // path, so this manual route is the sole guard for agent-hire approvals.
      // Without it an agent holding joins:approve could approve an agent-minted
      // (or pre-existing) invite that confers a governance key on the joining
      // AGENT — or a role:"founder" / privileged-human-grant invite on the human
      // branch — with NO founder in the loop. An agent actor has NO founder
      // userId → it can never be a founder → refused. Founder status resolves
      // only for a board actor with a userId (team.getUserRole → effective role,
      // maps instance_admin → founder) — the SAME helper the creation clamp uses.
      if (
        inviteConfersPrivilegedAuthority(
          invite.defaultsPayload as Record<string, unknown> | null,
        ) &&
        !isLocalImplicit(req)
      ) {
        const approverIsFounder =
          req.actor.type === "board" && req.actor.userId
            ? (await team.getUserRole(companyId, req.actor.userId)).role === "founder"
            : false; // agents (and any non-board / userId-less actor) are never founders
        if (!approverIsFounder) {
          throw forbidden(
            "Only founders can approve a join request that confers founder role or privileged permissions",
          );
        }
      }
      // ────────────────────────────────────────────────────────────────────────

      let createdAgentId: string | null = existing.createdAgentId ?? null;
      const approved = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;

        if (existing.requestType === "human") {
          if (!existing.requestingUserId)
            throw conflict("Join request missing user identity");
          return approveHumanJoinRequestTx(txDb, buildHumanJoinApprovalServices(txDb), {
            companyId,
            requestId,
            requestingUserId: existing.requestingUserId,
            invite: {
              id: invite.id,
              defaultsPayload: invite.defaultsPayload as Record<string, unknown> | null,
            },
            ...founderApprovalIdentity({
              actorUserId: req.actor.userId ?? null,
              localImplicit: isLocalImplicit(req),
            }),
          });
        }

        // Agent branch: the original transaction code, with approvalSource added.
        const txAccess = accessService(txDb);
        const txAgents = agentService(txDb);
        const approvedAt = new Date();
        const row = await tx
          .update(joinRequests)
          .set({
            status: "approved",
            approvedByUserId:
              req.actor.userId ?? (isLocalImplicit(req) ? "local-board" : null),
            approvalSource: "founder",
            approvedAt,
            createdAgentId,
            updatedAt: approvedAt
          })
          .where(
            and(
              eq(joinRequests.companyId, companyId),
              eq(joinRequests.id, requestId),
              eq(joinRequests.status, "pending_approval")
            )
          )
          .returning()
          .then((rows) => rows[0]);
        if (!row) return null;

        {
          const existingAgents = await txAgents.list(companyId);
          const managerId = resolveJoinRequestAgentManagerId(existingAgents);
          if (!managerId) {
            throw conflict(
              "Join request cannot be approved because this company has no active CEO"
            );
          }

          const agentName = deduplicateAgentName(
            existing.agentName ?? "New Agent",
            existingAgents.map((a) => ({
              id: a.id,
              name: a.name,
              status: a.status
            }))
          );

          const created = await txAgents.create(companyId, {
            name: agentName,
            role: "general",
            title: null,
            status: "idle",
            reportsTo: managerId,
            parentType: managerId ? "agent" : null,
            parentId: managerId,
            capabilities: existing.capabilities ?? null,
            adapterType: existing.adapterType ?? "process",
            adapterConfig:
              existing.agentDefaultsPayload &&
              typeof existing.agentDefaultsPayload === "object"
                ? (existing.agentDefaultsPayload as Record<string, unknown>)
                : {},
            runtimeConfig: {},
            budgetMonthlyCents: 0,
            spentMonthlyCents: 0,
            permissions: {},
            lastHeartbeatAt: null,
            metadata: null
          });
          createdAgentId = created.id;
          await txAccess.ensureMembership(
            companyId,
            "agent",
            created.id,
            "member",
            "active"
          );
          const grants = grantsFromDefaults(
            invite.defaultsPayload as Record<string, unknown> | null,
            "agent"
          );
          await txAccess.setPrincipalGrants(
            companyId,
            "agent",
            created.id,
            grants,
            req.actor.userId ?? null
          );
        }

        const finalRow =
          createdAgentId && createdAgentId !== row.createdAgentId
            ? await tx
                .update(joinRequests)
                .set({ createdAgentId, updatedAt: new Date() })
                .where(
                  and(
                    eq(joinRequests.companyId, companyId),
                    eq(joinRequests.id, requestId),
                    eq(joinRequests.status, "approved")
                  )
                )
                .returning()
                .then((rows) => rows[0] ?? row)
            : row;

        await hubItemsService(txDb).reconcile(companyId, {
          sourceType: "join_request",
          sourceId: requestId
        });
        await logActivity(txDb, {
          companyId,
          actorType: "user",
          actorId: req.actor.userId ?? "board",
          action: "join.approved",
          entityType: "join_request",
          entityId: requestId,
          details: { requestType: existing.requestType, createdAgentId }
        });
        return finalRow;
      });
      if (!approved) {
        throw conflict("Join request is not pending");
      }

      if (createdAgentId) {
        void notifyHireApproved(db, {
          companyId,
          agentId: createdAgentId,
          source: "join_request",
          sourceId: requestId,
          approvedAt: new Date()
        }).catch(() => {});
      }

      res.json(toJoinRequestResponse(approved));
    }
  );

  router.post(
    "/companies/:companyId/join-requests/:requestId/reject",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const requestId = req.params.requestId as string;
      await assertCompanyPermission(req, companyId, "joins:approve");

      const existing = await db
        .select()
        .from(joinRequests)
        .where(
          and(
            eq(joinRequests.companyId, companyId),
            eq(joinRequests.id, requestId)
          )
        )
        .then((rows) => rows[0] ?? null);
      if (!existing) throw notFound("Join request not found");
      if (existing.status !== "pending_approval")
        throw conflict("Join request is not pending");

      const rejected = await db.transaction(async (tx) => {
        const row = await tx
          .update(joinRequests)
          .set({
            status: "rejected",
            rejectedByUserId:
              req.actor.userId ?? (isLocalImplicit(req) ? "local-board" : null),
            rejectedAt: new Date(),
            updatedAt: new Date()
          })
          .where(
            and(
              eq(joinRequests.companyId, companyId),
              eq(joinRequests.id, requestId),
              eq(joinRequests.status, "pending_approval")
            )
          )
          .returning()
          .then((rows) => rows[0]);
        if (row) {
          await hubItemsService(tx as unknown as Db).reconcile(companyId, {
            sourceType: "join_request",
            sourceId: requestId
          });
        }
        return row;
      });
      if (!rejected) {
        throw conflict("Join request is not pending");
      }

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "join.rejected",
        entityType: "join_request",
        entityId: requestId,
        details: { requestType: existing.requestType }
      });

      res.json(toJoinRequestResponse(rejected));
    }
  );

  router.post(
    "/join-requests/:requestId/claim-api-key",
    validate(claimJoinRequestApiKeySchema),
    async (req, res) => {
      const requestId = req.params.requestId as string;
      const presentedClaimSecretHash = hashToken(req.body.claimSecret);
      const joinRequest = await db
        .select()
        .from(joinRequests)
        .where(eq(joinRequests.id, requestId))
        .then((rows) => rows[0] ?? null);
      if (!joinRequest) throw notFound("Join request not found");
      if (joinRequest.requestType !== "agent")
        throw badRequest("Only agent join requests can claim API keys");
      if (joinRequest.status !== "approved")
        throw conflict("Join request must be approved before key claim");
      if (!joinRequest.createdAgentId)
        throw conflict("Join request has no created agent");
      if (!joinRequest.claimSecretHash)
        throw conflict("Join request is missing claim secret metadata");
      if (
        !tokenHashesMatch(joinRequest.claimSecretHash, presentedClaimSecretHash)
      ) {
        throw forbidden("Invalid claim secret");
      }
      if (
        joinRequest.claimSecretExpiresAt &&
        joinRequest.claimSecretExpiresAt.getTime() <= Date.now()
      ) {
        throw conflict("Claim secret expired");
      }
      if (joinRequest.claimSecretConsumedAt)
        throw conflict("Claim secret already used");

      const existingKey = await db
        .select({ id: agentApiKeys.id })
        .from(agentApiKeys)
        .where(eq(agentApiKeys.agentId, joinRequest.createdAgentId))
        .then((rows) => rows[0] ?? null);
      if (existingKey) throw conflict("API key already claimed");

      const consumed = await db
        .update(joinRequests)
        .set({ claimSecretConsumedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(joinRequests.id, requestId),
            isNull(joinRequests.claimSecretConsumedAt)
          )
        )
        .returning({ id: joinRequests.id })
        .then((rows) => rows[0] ?? null);
      if (!consumed) throw conflict("Claim secret already used");

      const created = await agents.createApiKey(
        joinRequest.createdAgentId,
        "initial-join-key"
      );

      await logActivity(db, {
        companyId: joinRequest.companyId,
        actorType: "system",
        actorId: "join-claim",
        action: "agent_api_key.claimed",
        entityType: "agent_api_key",
        entityId: created.id,
        details: {
          agentId: joinRequest.createdAgentId,
          joinRequestId: requestId
        }
      });

      res.status(201).json({
        keyId: created.id,
        token: created.token,
        agentId: joinRequest.createdAgentId,
        createdAt: created.createdAt
      });
    }
  );

  router.get("/companies/:companyId/members", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyPermission(req, companyId, "users:manage_permissions");
    const members = await access.listMembers(companyId);
    res.json(members);
  });

  router.patch(
    "/companies/:companyId/members/:memberId/permissions",
    validate(updateMemberPermissionsSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const memberId = req.params.memberId as string;
      await assertCompanyPermission(req, companyId, "users:manage_permissions");
      const updated = await access.setMemberPermissions(
        companyId,
        memberId,
        req.body.grants ?? [],
        req.actor.userId ?? null
      );
      if (!updated) throw notFound("Member not found");
      res.json(updated);
    }
  );

  router.post(
    "/admin/users/:userId/promote-instance-admin",
    async (req, res) => {
      assertAdminUserManagementAvailable();
      await assertInstanceAdmin(req);
      const userId = req.params.userId as string;
      const result = await access.promoteInstanceAdmin(userId);
      res.status(201).json(result);
    }
  );

  router.get("/admin/users", async (req, res) => {
    assertAdminUserManagementAvailable();
    await assertInstanceAdmin(req);
    const query = searchAdminUsersQuerySchema.parse(req.query);
    const needle = query.query.trim().toLowerCase();
    const users = await db
      .select({
        id: authUsers.id,
        email: authUsers.email,
        name: authUsers.name,
        image: authUsers.image,
      })
      .from(authUsers)
      .orderBy(desc(authUsers.updatedAt));
    const filteredUsers = needle
      ? users.filter((user) =>
          [user.name, user.email]
            .filter((value): value is string => Boolean(value))
            .some((value) => value.toLowerCase().includes(needle)),
        )
      : users;
    const userIds = filteredUsers.slice(0, 50).map((user) => user.id);
    const memberships = userIds.length
      ? await db
          .select({
            principalId: companyMemberships.principalId,
          })
          .from(companyMemberships)
          .where(
            and(
              eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.status, "active"),
              inArray(companyMemberships.principalId, userIds),
            ),
          )
      : [];
    const membershipCountByUserId = new Map<string, number>();
    for (const membership of memberships) {
      membershipCountByUserId.set(
        membership.principalId,
        (membershipCountByUserId.get(membership.principalId) ?? 0) + 1,
      );
    }
    const adminIds = new Set(
      await Promise.all(
        userIds.map(async (userId) =>
          (await access.isInstanceAdmin(userId)) ? userId : null,
        ),
      ).then((values) => values.filter((value): value is string => Boolean(value))),
    );

    res.json(
      filteredUsers.slice(0, 50).map((user) => ({
        ...toUserProfile(user)!,
        isInstanceAdmin: adminIds.has(user.id),
        activeCompanyMembershipCount:
          membershipCountByUserId.get(user.id) ?? 0,
      })),
    );
  });

  router.post(
    "/admin/users/:userId/demote-instance-admin",
    async (req, res) => {
      assertAdminUserManagementAvailable();
      await assertInstanceAdmin(req);
      const userId = req.params.userId as string;
      const removed = await access.demoteInstanceAdmin(userId);
      if (!removed) throw notFound("Instance admin role not found");
      res.json(removed);
    }
  );

  router.get("/admin/users/:userId/company-access", async (req, res) => {
    assertAdminUserManagementAvailable();
    await assertInstanceAdmin(req);
    const userId = req.params.userId as string;
    res.json(await loadUserCompanyAccessResponse(db, access, userId));
  });

  router.put(
    "/admin/users/:userId/company-access",
    validate(updateUserCompanyAccessSchema),
    async (req, res) => {
      assertAdminUserManagementAvailable();
      await assertInstanceAdmin(req);
      const userId = req.params.userId as string;
      await access.setUserCompanyAccess(
        userId,
        req.body.companyIds ?? []
      );
      res.json(await loadUserCompanyAccessResponse(db, access, userId));
    }
  );

  return router;
}
