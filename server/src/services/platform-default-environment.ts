import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { environments } from "@armyofagents/db";
import type { DeploymentMode, Environment } from "@armyofagents/shared";

// Cosmetic label for the pure in-memory template this module builds — never
// looked up via environments.get() directly. The PERSISTED row (see
// ensurePlatformDefaultEnvironmentRow below) gets a real, deterministic uuid
// id instead: `environment_leases.environment_id` is a NOT NULL FK to
// `environments.id` (a Postgres uuid PK), so a lease can only ever be
// acquired against a real row — this sentinel is never used as a lookup key.
const PLATFORM_DEFAULT_ENVIRONMENT_ID = "platform-default-e2b";

function read(env: Record<string, string | undefined>, key: string): string | null {
  const v = env[key]?.trim();
  return v && v.length > 0 ? v : null;
}

/**
 * Pure TEMPLATE builder for the PLATFORM layer of the environment precedence
 * stack: an AoA-Cloud-hosted E2B sandbox environment used when a
 * task/agent/company environment override is absent. Only active on
 * cloud_auth deployments and only when the operator has configured
 * E2B_API_KEY — otherwise null (host execution / environment_not_found stays
 * the caller's fallback).
 *
 * The operator API key itself is deliberately NOT placed in the returned
 * config — the E2B driver resolves it from env at acquire time (see
 * sandbox-provider-runtime.ts resolveE2bApiKey), keeping the secret out of
 * any persisted/serialized Environment.
 *
 * This function never touches the database and its returned `id` is the
 * cosmetic sentinel — callers that need a LEASABLE environment (i.e.
 * anything that will call acquireLease) must go through
 * ensurePlatformDefaultEnvironmentRow below instead, which persists a real
 * row keyed by a deterministic uuid derived from companyId.
 */
export function resolvePlatformDefaultEnvironment(input: {
  companyId: string;
  deploymentMode: DeploymentMode;
  env?: Record<string, string | undefined>;
}): Environment | null {
  if (input.deploymentMode !== "cloud_auth") return null;

  const env = input.env ?? process.env;
  if (!read(env, "E2B_API_KEY")) return null;

  const now = new Date(0).toISOString();
  const domain = read(env, "E2B_DOMAIN");
  const timeoutRaw = Number(read(env, "E2B_TIMEOUT_MS") ?? "");
  const timeoutMs = Number.isInteger(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 3_600_000;

  return {
    id: PLATFORM_DEFAULT_ENVIRONMENT_ID,
    companyId: input.companyId,
    name: "Platform default (E2B)",
    description: null,
    driver: "sandbox",
    status: "active",
    config: {
      provider: "e2b",
      template: read(env, "E2B_TEMPLATE") ?? "base",
      timeoutMs,
      reuseLease: false,
      ...(domain ? { domain } : {}),
    },
    metadata: { platformDefault: true },
    envVars: {},
    connectionTarget: null,
    target: null,
    executionTargetId: null,
    createdAt: now,
    updatedAt: now,
  };
}

// Fixed, never-rotate namespace UUID for deriving each company's
// platform-default environment row id (RFC 4122 UUIDv5). Generated once as a
// random UUID and hardcoded as a protocol constant — do NOT change it; doing
// so would remint every company's platform-default environment id and orphan
// the `environment_id` FK on any existing environment_leases rows.
//
// No `uuid` package is a direct dependency of server/ (it is only present
// transitively in the lockfile and is not resolvable under pnpm's strict
// node_modules linking without adding it as a declared dependency), so this
// is a small self-contained RFC 4122 v5 implementation rather than a new
// dependency.
const PLATFORM_DEFAULT_ENVIRONMENT_NAMESPACE = "1f6a1d0a-9d3f-4b7e-9f74-2ad0c9c6a9a2";

function uuidV5(name: string, namespaceUuid: string): string {
  const namespaceBytes = Buffer.from(namespaceUuid.replace(/-/g, ""), "hex");
  const nameBytes = Buffer.from(name, "utf8");
  const hash = createHash("sha1").update(Buffer.concat([namespaceBytes, nameBytes])).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Deterministic id for a company's materialized platform-default
 * `environments` row. Same companyId -> same id, every call, every process,
 * every replica — the row's PK is itself the idempotency key that
 * ensurePlatformDefaultEnvironmentRow's `onConflictDoNothing` relies on, so
 * no new unique constraint or migration is needed.
 */
export function derivePlatformDefaultEnvironmentId(companyId: string): string {
  return uuidV5(`platform-default-e2b:${companyId}`, PLATFORM_DEFAULT_ENVIRONMENT_NAMESPACE);
}

function toIsoString(value: unknown): string {
  return value instanceof Date ? value.toISOString() : typeof value === "string" ? value : new Date(0).toISOString();
}

function toPersistedEnvironment(row: {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  driver: string;
  status: string;
  config: Record<string, unknown>;
  metadata: Record<string, unknown> | null;
  envVars: Record<string, unknown>;
  connectionTarget: Record<string, unknown> | null;
  target: Record<string, unknown> | null;
  executionTargetId: string | null;
  createdAt: unknown;
  updatedAt: unknown;
}): Environment {
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    description: row.description,
    driver: row.driver as Environment["driver"],
    status: row.status as Environment["status"],
    config: row.config,
    metadata: row.metadata,
    envVars: row.envVars,
    connectionTarget: row.connectionTarget,
    target: row.target,
    executionTargetId: row.executionTargetId,
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  };
}

/**
 * Lazily MATERIALIZES the PLATFORM layer as a real, persisted `environments`
 * row instead of the purely synthetic object resolvePlatformDefaultEnvironment
 * returns. `environment_leases.environment_id` is a NOT NULL FK to
 * `environments.id` (a Postgres uuid PK) and environmentService(db)
 * .acquireLease() does a `select ... from environments where id = ... and
 * company_id = ...` that throws "Environment not found for company" when no
 * row exists — so a real cloud lease can never be acquired against the
 * synthetic sentinel id. This function closes that gap.
 *
 * The row id is DETERMINISTIC (derivePlatformDefaultEnvironmentId), so
 * concurrent materialization from two racing runs is a no-op via
 * `onConflictDoNothing` on the primary key — no new unique constraint, no
 * migration, no read-then-write race window that could double-insert.
 *
 * Returns null in exactly the cases resolvePlatformDefaultEnvironment
 * returns null (off-cloud, or on-cloud with no operator E2B_API_KEY) —
 * WITHOUT touching the database — preserving existing "no platform default"
 * / environment_not_found semantics on desktop and misconfigured cloud
 * deployments byte-for-byte.
 *
 * The operator's E2B_API_KEY is never written into the persisted row's
 * config — the template already keeps it out (see
 * resolvePlatformDefaultEnvironment); the sandbox driver resolves the key
 * from env at acquire time.
 */
export async function ensurePlatformDefaultEnvironmentRow(
  db: Db,
  companyId: string,
  deploymentMode: DeploymentMode,
  env?: Record<string, string | undefined>,
): Promise<Environment | null> {
  const template = resolvePlatformDefaultEnvironment({ companyId, deploymentMode, env });
  if (!template) return null;

  const id = derivePlatformDefaultEnvironmentId(companyId);

  await db
    .insert(environments)
    .values({
      id,
      companyId,
      name: template.name,
      description: template.description,
      driver: template.driver,
      status: template.status,
      config: template.config,
      metadata: template.metadata ?? {},
      envVars: template.envVars,
      connectionTarget: template.connectionTarget,
      target: template.target,
      executionTargetId: template.executionTargetId ?? null,
    })
    .onConflictDoNothing({ target: environments.id });

  const [row] = await db
    .select()
    .from(environments)
    .where(and(eq(environments.id, id), eq(environments.companyId, companyId)));

  if (!row) {
    throw new Error(`Failed to materialize platform-default environment for company ${companyId}`);
  }

  return toPersistedEnvironment(row);
}
