export function parseComposePs(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return trimmed
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
}

export const MARKETPLACE_RECOVERY_PREFLIGHT_REQUESTS = Object.freeze([
  Object.freeze({
    key: "health",
    endpoint: "/api/health",
    authenticated: false,
  }),
  Object.freeze({
    key: "catalog",
    endpoint: "/api/marketplace/catalog/status",
    authenticated: true,
  }),
  Object.freeze({
    key: "identity",
    endpoint: "/api/cli-auth/me",
    authenticated: true,
  }),
]);

const PREFLIGHT_SECRET_PATTERN =
  /(bearer\s+|token[=:]\s*|api[_-]?key[=:]\s*|password[=:]\s*)[^\s,;"']+/gi;
const PREFLIGHT_TOKEN_LIKE_PATTERN =
  /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g;
const PREFLIGHT_ABSOLUTE_PATH_PATTERN =
  /(?:[A-Za-z]:\\|\/(?:app|aoa|etc|home|opt|root|srv|tmp|Users|var|workspace)\/)[^\s,;"']+/g;
const PREFLIGHT_URL_PATTERN = /https?:\/\/[^\s,;"']+/g;

function sanitizePreflightUrl(raw) {
  try {
    const parsed = new URL(raw);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return "[redacted-url]";
  }
}

export function sanitizePreflightError(value) {
  return String(value)
    .replace(PREFLIGHT_SECRET_PATTERN, "$1[redacted]")
    .replace(PREFLIGHT_TOKEN_LIKE_PATTERN, "[redacted-token]")
    .replace(PREFLIGHT_URL_PATTERN, sanitizePreflightUrl)
    .replace(PREFLIGHT_ABSOLUTE_PATH_PATTERN, "[redacted-path]")
    .slice(0, 300);
}

export function composeEvidenceFromDocker(psRaw, inspectionRaw) {
  const servers = parseComposePs(psRaw).filter(
    (entry) =>
      String(entry.Service ?? "").toLowerCase() === "server" &&
      String(entry.State ?? "").toLowerCase() === "running",
  );
  if (servers.length !== 1) {
    throw new Error(
      `Expected exactly one running server replica; found ${servers.length}`,
    );
  }

  const parsedInspection = JSON.parse(inspectionRaw);
  const inspection = Array.isArray(parsedInspection)
    ? parsedInspection[0]
    : parsedInspection;
  const env = Object.fromEntries(
    (inspection?.Config?.Env ?? []).map((entry) => {
      const split = entry.indexOf("=");
      return [entry.slice(0, split), entry.slice(split + 1)];
    }),
  );
  const instanceId = env.AOA_INSTANCE_ID ?? "default";
  return {
    containerId: servers[0].ID || servers[0].Id || servers[0].Name,
    replicaCount: servers.length,
    hasAoaMount: (inspection?.Mounts ?? []).some(
      (mount) => mount.Destination === "/aoa" && mount.RW === true,
    ),
    selector: env.AOA_MARKETPLACE_SKILLS_WRITE_ROOT ?? "legacy",
    instanceId,
    persistentRoot: `/aoa/instances/${instanceId}/marketplace-skills`,
    imageRevision:
      inspection?.Config?.Labels?.["org.opencontainers.image.revision"] ??
      "unknown",
  };
}

export function evaluatePreflight({
  health,
  catalog,
  identity,
  compose,
  expectedSha,
  expectedSelector,
  expectedInstanceId,
}) {
  const checks = {
    health: health.status === "ok",
    deploymentSha:
      health.revision === expectedSha && compose.imageRevision === expectedSha,
    oneServerReplica: compose.replicaCount === 1,
    aoaVolume: compose.hasAoaMount,
    writeSelector: compose.selector === expectedSelector,
    instanceId: compose.instanceId === expectedInstanceId,
    persistentRoot:
      compose.persistentRoot ===
      `/aoa/instances/${expectedInstanceId}/marketplace-skills`,
    catalog:
      catalog.lastSyncStatus === "success" && catalog.source === "cdn",
    instanceAdmin: identity.isInstanceAdmin === true,
  };
  return { ok: Object.values(checks).every(Boolean), checks };
}
