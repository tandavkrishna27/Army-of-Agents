// TEN-005 (E2-D04) — deterministic, seed-reproducible tenant-graph generator +
// hostile-identifier corpus + surface registry for the H-01 adversarial property
// suite (tenant-adversarial.property.integration.test.ts).
//
// DETERMINISM CONTRACT: every value here is derived from a seeded PRNG (mulberry32)
// plus the seed integer — there is NO `Math.random`, `Date.now`, or any other
// nondeterministic source. The same seed therefore reproduces a BYTE-IDENTICAL graph
// (proved in tenant-graph-unit.test.ts), which is what lets the property suite be
// replayed exactly from the fixed SEED set (TENANT_ADVERSARIAL_SEEDS).
//
// The generator emits typed ROW DESCRIPTORS (ids + org/company/parent linkage) — not
// live DB rows — so the property suite can (a) seed them as the superuser with
// EXPLICIT ids and (b) cross-reference which id belongs to which tenant when building
// the hostile corpus. Slugs and issue-prefixes embed the seed so many graphs can be
// seeded into ONE database without colliding on the global unique indexes
// (organizations_slug_uq, companies_issue_prefix_idx).
//
// Surface registry (E2-D04, no silent cap): the E2-available adversarial surfaces are
// `repository` (tenant repositories via runInTenant over the non-owner pool + forced
// RLS) and `composite_sql` (direct-SQL mixed-tenant construction rejected by the
// TEN-004 composite FKs). `http` / `worker_events` / `websocket` / `object_key` /
// `placement` / `restore` are registered as NOT-implemented with their owning epic so
// later epics extend the SAME harness; the full D1 floor is owned by the D1 gate.

/** The forbidden distributed-admission sentinel Organization (FND-007 / E2-D07). */
export const FORBIDDEN_SENTINEL_ORG_ID = "00000000-0000-0000-0000-000000000001";

// ---------------------------------------------------------------------------------
// Seeded PRNG (mulberry32) — a tiny, well-distributed 32-bit generator. Seeded from an
// integer so the same seed reproduces the same stream; no global/shared state.
// ---------------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministically draw a v4-shaped uuid from the PRNG (16 bytes → canonical form). */
function nextUuid(rand: () => number): string {
  const b: number[] = new Array(16);
  for (let i = 0; i < 16; i += 1) b[i] = Math.floor(rand() * 256) & 0xff;
  b[6] = (b[6]! & 0x0f) | 0x40; // version 4
  b[8] = (b[8]! & 0x3f) | 0x80; // variant 10xx
  const hex = b.map((x) => x.toString(16).padStart(2, "0"));
  return (
    `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-` +
    `${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`
  );
}

/** Deterministic integer in [0, n) from the PRNG. */
function nextInt(rand: () => number, n: number): number {
  return Math.floor(rand() * n);
}

// ---------------------------------------------------------------------------------
// Row descriptors + graph shape.
// ---------------------------------------------------------------------------------
export interface OrgDescriptor {
  id: string;
  slug: string;
  name: string;
}
export interface CompanyDescriptor {
  id: string;
  organizationId: string;
  name: string;
  issuePrefix: string;
}
export interface JobDescriptor {
  id: string;
  organizationId: string;
  companyId: string;
}
export interface AttemptDescriptor {
  id: string;
  organizationId: string;
  jobId: string;
}
export interface LeaseDescriptor {
  id: string;
  organizationId: string;
  attemptId: string;
  fence: string;
}
export interface ServiceDescriptor {
  id: string;
  organizationId: string;
  companyId: string;
}
export interface ServiceInstanceDescriptor {
  id: string;
  organizationId: string;
  // SVC-002 added `service_instances.company_id` NOT NULL, bound to the service's own
  // company by the triple composite FK. It must therefore be the SERVICE's company, not a
  // freely chosen one, or the seed fails the FK rather than the RLS property under test.
  companyId: string;
  serviceId: string;
}
export interface JobArtifactDescriptor {
  id: string;
  organizationId: string;
  jobId: string;
  identifier: string;
}
export interface JobSecretHandleDescriptor {
  id: string;
  organizationId: string;
  jobId: string;
  handle: string;
}
export interface WorkerDescriptor {
  id: string;
  scope: "platform" | "organization";
  organizationId: string | null;
  label: string;
}

/** One tenant (Organization) and everything it owns. */
export interface TenantNode {
  org: OrgDescriptor;
  companies: CompanyDescriptor[];
  jobs: JobDescriptor[];
  attempts: AttemptDescriptor[];
  leases: LeaseDescriptor[];
  services: ServiceDescriptor[];
  serviceInstances: ServiceInstanceDescriptor[];
  jobArtifacts: JobArtifactDescriptor[];
  jobSecretHandles: JobSecretHandleDescriptor[];
  workers: WorkerDescriptor[]; // org-scoped workers (organization_id = org.id)
}

export interface TenantGraph {
  seed: number;
  organizations: TenantNode[];
  /** platform (null-Org) workers — operator-only under forced RLS, never tenant-visible. */
  platformWorkers: WorkerDescriptor[];
}

export interface GenerateTenantGraphOptions {
  /** Inclusive lower bound on the number of Organizations. Default 4. */
  minOrgs?: number;
  /** Inclusive upper bound on the number of Organizations. Default 6. */
  maxOrgs?: number;
  /** Companies per Organization. Default 2. */
  companiesPerOrg?: number;
  /** Jobs per Organization (round-robin across the org's companies). Default 3. */
  jobsPerOrg?: number;
  /** Services per Organization (round-robin across the org's companies). Default 2. */
  servicesPerOrg?: number;
  /** Org-scoped workers per Organization. Default 2. */
  workersPerOrg?: number;
  /** Platform (null-Org) workers for the whole graph. Default 3. */
  platformWorkers?: number;
}

const DEFAULTS: Required<GenerateTenantGraphOptions> = {
  minOrgs: 4,
  maxOrgs: 6,
  companiesPerOrg: 2,
  jobsPerOrg: 3,
  servicesPerOrg: 2,
  workersPerOrg: 2,
  platformWorkers: 3,
};

/**
 * Build a deterministic multi-Organization tenant graph from `seed`. The same
 * (seed, opts) reproduces a byte-identical graph. Every id is a distinct v4-shaped
 * uuid; slugs + issue-prefixes embed the seed so the graph is safe to seed alongside
 * other seeds' graphs in one database (global unique indexes).
 */
export function generateTenantGraph(seed: number, opts?: GenerateTenantGraphOptions): TenantGraph {
  const cfg = { ...DEFAULTS, ...opts };
  const rand = mulberry32(seed);

  const orgCount = cfg.minOrgs + nextInt(rand, cfg.maxOrgs - cfg.minOrgs + 1);
  const organizations: TenantNode[] = [];

  for (let o = 0; o < orgCount; o += 1) {
    const org: OrgDescriptor = {
      id: nextUuid(rand),
      slug: `s${seed}-org${o}`,
      name: `Org ${seed}.${o}`,
    };

    const companies: CompanyDescriptor[] = [];
    for (let c = 0; c < cfg.companiesPerOrg; c += 1) {
      companies.push({
        id: nextUuid(rand),
        organizationId: org.id,
        name: `Co ${seed}.${o}.${c}`,
        // Globally unique across seeds + orgs + companies (companies_issue_prefix_idx).
        issuePrefix: `T${seed}O${o}C${c}`,
      });
    }

    const jobs: JobDescriptor[] = [];
    for (let j = 0; j < cfg.jobsPerOrg; j += 1) {
      jobs.push({
        id: nextUuid(rand),
        organizationId: org.id,
        companyId: companies[j % companies.length]!.id,
      });
    }

    // one attempt per job (denormalized org must match the job's org — TEN-004).
    const attempts: AttemptDescriptor[] = jobs.map((job) => ({
      id: nextUuid(rand),
      organizationId: org.id,
      jobId: job.id,
    }));

    // one (active) lease per attempt.
    const leases: LeaseDescriptor[] = attempts.map((attempt, i) => ({
      id: nextUuid(rand),
      organizationId: org.id,
      attemptId: attempt.id,
      fence: `fence-${seed}-${o}-${i}`,
    }));

    const services: ServiceDescriptor[] = [];
    for (let s = 0; s < cfg.servicesPerOrg; s += 1) {
      services.push({
        id: nextUuid(rand),
        organizationId: org.id,
        companyId: companies[s % companies.length]!.id,
      });
    }

    // one instance per service.
    const serviceInstances: ServiceInstanceDescriptor[] = services.map((service) => ({
      id: nextUuid(rand),
      organizationId: org.id,
      companyId: service.companyId,
      serviceId: service.id,
    }));

    // one artifact + one secret-handle per job.
    const jobArtifacts: JobArtifactDescriptor[] = jobs.map((job, i) => ({
      id: nextUuid(rand),
      organizationId: org.id,
      jobId: job.id,
      identifier: `artifact-${seed}-${o}-${i}`,
    }));
    const jobSecretHandles: JobSecretHandleDescriptor[] = jobs.map((job, i) => ({
      id: nextUuid(rand),
      organizationId: org.id,
      jobId: job.id,
      handle: `handle-${seed}-${o}-${i}`,
    }));

    const workers: WorkerDescriptor[] = [];
    for (let w = 0; w < cfg.workersPerOrg; w += 1) {
      workers.push({
        id: nextUuid(rand),
        scope: "organization",
        organizationId: org.id,
        label: `worker-${seed}-${o}-${w}`,
      });
    }

    organizations.push({
      org,
      companies,
      jobs,
      attempts,
      leases,
      services,
      serviceInstances,
      jobArtifacts,
      jobSecretHandles,
      workers,
    });
  }

  const platformWorkers: WorkerDescriptor[] = [];
  for (let p = 0; p < cfg.platformWorkers; p += 1) {
    platformWorkers.push({
      id: nextUuid(rand),
      scope: "platform",
      organizationId: null,
      label: `platform-worker-${seed}-${p}`,
    });
  }

  return { seed, organizations, platformWorkers };
}

// ---------------------------------------------------------------------------------
// Hostile-identifier corpus for a given actor tenant.
// ---------------------------------------------------------------------------------
export interface HostileCorpus {
  actorOrgId: string;
  /** Other Organizations' ids (for cross-tenant writes / list-by-org). */
  crossOrgIds: string[];
  /** Companies owned by OTHER organizations (list-by-company / FK targets). */
  crossOrgCompanyIds: string[];
  crossOrgJobIds: string[];
  crossOrgAttemptIds: string[];
  crossOrgLeaseIds: string[];
  crossOrgServiceIds: string[];
  crossOrgServiceInstanceIds: string[];
  crossOrgJobArtifactIds: string[];
  crossOrgJobSecretHandleIds: string[];
  crossOrgWorkerIds: string[];
  /** The forbidden distributed-admission sentinel Organization (FND-007 / E2-D07). */
  forbiddenSentinelOrgId: string;
  /** Platform (null-Org) worker ids — must never be tenant-visible. */
  nullOrgWorkerIds: string[];
  /** Valid-format uuids that own NO row in the graph (the absent baseline). */
  absentUuids: string[];
  /** Strings that are NOT valid uuids (input-validation, not existence). */
  malformedIds: string[];
}

// Fixed valid-format-but-absent uuids (version 4 / variant 8). The `ab5e57e0`
// prefix (all-hex, reads as "absent0") makes them recognizable in logs; the graph
// draws its ids from the PRNG so a collision is astronomically improbable and is
// additionally asserted-against in the unit test.
const ABSENT_UUIDS: readonly string[] = Object.freeze([
  "ab5e57e0-0000-4000-8000-000000000001",
  "ab5e57e0-0000-4000-8000-000000000002",
  "ab5e57e0-0000-4000-8000-000000000003",
]);

const MALFORMED_IDS: readonly string[] = Object.freeze([
  "not-a-uuid",
  "00000000-0000-0000-0000", // too short
  "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz", // non-hex
]);

/**
 * Build the set of hostile identifiers an `actorOrgId` tenant should be denied on:
 * every OTHER tenant's row ids (per accessor type), the forbidden sentinel org, the
 * platform null-Org worker ids, plus valid-format-but-absent and malformed uuids.
 * Deterministic for a fixed (graph, actorOrgId).
 */
export function buildHostileCorpus(graph: TenantGraph, actorOrgId: string): HostileCorpus {
  const others = graph.organizations.filter((n) => n.org.id !== actorOrgId);
  return {
    actorOrgId,
    crossOrgIds: others.map((n) => n.org.id),
    crossOrgCompanyIds: others.flatMap((n) => n.companies.map((c) => c.id)),
    crossOrgJobIds: others.flatMap((n) => n.jobs.map((j) => j.id)),
    crossOrgAttemptIds: others.flatMap((n) => n.attempts.map((a) => a.id)),
    crossOrgLeaseIds: others.flatMap((n) => n.leases.map((l) => l.id)),
    crossOrgServiceIds: others.flatMap((n) => n.services.map((s) => s.id)),
    crossOrgServiceInstanceIds: others.flatMap((n) => n.serviceInstances.map((si) => si.id)),
    crossOrgJobArtifactIds: others.flatMap((n) => n.jobArtifacts.map((ar) => ar.id)),
    crossOrgJobSecretHandleIds: others.flatMap((n) => n.jobSecretHandles.map((sh) => sh.id)),
    crossOrgWorkerIds: others.flatMap((n) => n.workers.map((w) => w.id)),
    forbiddenSentinelOrgId: FORBIDDEN_SENTINEL_ORG_ID,
    nullOrgWorkerIds: graph.platformWorkers.map((w) => w.id),
    absentUuids: [...ABSENT_UUIDS],
    malformedIds: [...MALFORMED_IDS],
  };
}

// ---------------------------------------------------------------------------------
// Surface registry (E2-D04). Later epics flip `implemented` and register drivers.
// ---------------------------------------------------------------------------------
export type SurfaceKey =
  | "repository"
  | "composite_sql"
  | "http"
  | "worker_events"
  | "websocket"
  | "object_key"
  | "placement"
  | "restore";

export interface SurfaceRegistryEntry {
  key: SurfaceKey;
  implemented: boolean;
  note: string;
}

/**
 * The adversarial-surface registry. `repository` + `composite_sql` are the surfaces
 * that EXIST at E2 and are exercised by the property suite; the rest are registered
 * as NOT-implemented with their owning epic so later epics extend the same harness
 * (E2-D04 — no silent cap). The full D1 floor (20 seeds × 10 000 ops × ≥10 orgs) is
 * owned by the D1 gate, not E2.
 */
export const TENANT_ADVERSARIAL_SURFACES: readonly SurfaceRegistryEntry[] = Object.freeze([
  {
    key: "repository",
    implemented: true,
    note: "Tenant repositories via runInTenant over the non-owner aoa_app pool + forced RLS (TEN-002/TEN-003). E2-covered.",
  },
  {
    key: "composite_sql",
    implemented: true,
    note: "Direct-SQL mixed-tenant construction rejected by the TEN-004 composite FKs (23503). E2-covered.",
  },
  {
    key: "http",
    implemented: false,
    note: "No HTTP endpoint reads/writes a new-path table at E2 (E2-D04); entry-point adoption rides E3 (JOB-*).",
  },
  {
    key: "worker_events",
    implemented: false,
    note: "Worker event stream is E3 (JOB-002).",
  },
  {
    key: "websocket",
    implemented: false,
    note: "WebSocket subscriptions are E4.",
  },
  {
    key: "object_key",
    implemented: false,
    note: "Object-key format/derivation lands with artifact/object storage in E5.",
  },
  {
    key: "placement",
    implemented: false,
    note: "Placement/scheduling is E4.",
  },
  {
    key: "restore",
    implemented: false,
    note: "Restore/backup data path is E6.",
  },
]);

/**
 * The fixed, reproducible seed set the property suite iterates. Eight distinct
 * integers spanning small, mid, and 31-bit-max values so the PRNG is exercised across
 * its range. Recorded in TEN-005-result.md as the H-01 reproduction key.
 */
export const TENANT_ADVERSARIAL_SEEDS: readonly number[] = Object.freeze([
  1, 7, 13, 42, 101, 1337, 20260809, 2147483647,
]);

/**
 * The op classes the adversarial suite drives — the counter keys it tallies to prove
 * the run is NON-vacuous (every class > 0). Kept here (not in the test) so the counter
 * set is a single exported artifact later epics extend alongside the surface registry.
 *
 * `crossParentVsAbsentUniform` (E2-F013 / E2-D09) is the FK-oracle axis: an own-org
 * insert whose composite PARENT id is (i) a cross-tenant row vs (ii) truly absent must
 * fail with the SAME composite-FK constraint + byte-identical DB message — proving the
 * redundant single-column parent FKs (the oracle) are gone.
 */
export const TENANT_ADVERSARIAL_OP_CLASSES = [
  "crossRead",
  "absentRead",
  "crossList",
  "crossInsertReject",
  "crossUpdateZero",
  "crossDeleteZero",
  "updateToOtherOrgReject",
  "nullOrgReadZero",
  "nullOrgWriteReject",
  "compositeSqlReject",
  "crossParentVsAbsentUniform",
] as const;
export type TenantAdversarialOpClass = (typeof TENANT_ADVERSARIAL_OP_CLASSES)[number];
