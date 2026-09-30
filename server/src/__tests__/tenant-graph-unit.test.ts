// TEN-005 (E2-D04) Windows-visible unit sibling for the deterministic tenant-graph
// generator, the hostile-identifier corpus, and the surface registry. This lane runs
// on every platform (no embedded-Postgres) so the seed-reproducibility + corpus/
// registry shape is covered in the always-on gate; the embedded-PG adversarial proofs
// live in tenant-adversarial.property.integration.test.ts (E2-D05 env-hatch).
//
// The load-bearing property proved here is DETERMINISM: the same seed reproduces a
// byte-identical graph (a seeded PRNG, no Math.random / no wall-clock), and different
// seeds produce different graphs — the precondition that makes the property suite
// reproducible from the fixed SEED set.
import { describe, expect, it } from "vitest";
import {
  FORBIDDEN_SENTINEL_ORG_ID,
  TENANT_ADVERSARIAL_OP_CLASSES,
  TENANT_ADVERSARIAL_SEEDS,
  TENANT_ADVERSARIAL_SURFACES,
  buildHostileCorpus,
  generateTenantGraph,
  type SurfaceKey,
  type TenantGraph,
} from "../testing/tenant-graph.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function allRowIds(g: TenantGraph): string[] {
  const ids: string[] = [];
  for (const node of g.organizations) {
    ids.push(node.org.id);
    for (const c of node.companies) ids.push(c.id);
    for (const j of node.jobs) ids.push(j.id);
    for (const a of node.attempts) ids.push(a.id);
    for (const l of node.leases) ids.push(l.id);
    for (const s of node.services) ids.push(s.id);
    for (const si of node.serviceInstances) ids.push(si.id);
    for (const ar of node.jobArtifacts) ids.push(ar.id);
    for (const sh of node.jobSecretHandles) ids.push(sh.id);
    for (const w of node.workers) ids.push(w.id);
  }
  for (const w of g.platformWorkers) ids.push(w.id);
  return ids;
}

describe("TEN-005 tenant-graph generator (deterministic, seed-reproducible)", () => {
  it("same seed reproduces a byte-identical graph (no Math.random / no wall-clock)", () => {
    for (const seed of [1, 42, 1337]) {
      const a = generateTenantGraph(seed);
      const b = generateTenantGraph(seed);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      expect(a.seed).toBe(seed);
    }
  });

  it("different seeds produce different graphs", () => {
    expect(JSON.stringify(generateTenantGraph(1))).not.toBe(JSON.stringify(generateTenantGraph(2)));
    expect(JSON.stringify(generateTenantGraph(7))).not.toBe(JSON.stringify(generateTenantGraph(13)));
  });

  it("options are honored deterministically (fixed org count)", () => {
    const g = generateTenantGraph(1, { minOrgs: 2, maxOrgs: 2 });
    expect(g.organizations.length).toBe(2);
    // still deterministic under the same options
    expect(JSON.stringify(g)).toBe(JSON.stringify(generateTenantGraph(1, { minOrgs: 2, maxOrgs: 2 })));
  });

  it("every fixed seed yields several Organizations, each fully populated + platform workers", () => {
    for (const seed of TENANT_ADVERSARIAL_SEEDS) {
      const g = generateTenantGraph(seed);
      expect(g.organizations.length).toBeGreaterThanOrEqual(4);
      expect(g.organizations.length).toBeLessThanOrEqual(6);
      for (const node of g.organizations) {
        expect(node.companies.length).toBeGreaterThan(0);
        expect(node.jobs.length).toBeGreaterThan(0);
        expect(node.attempts.length).toBeGreaterThan(0);
        expect(node.leases.length).toBeGreaterThan(0);
        expect(node.services.length).toBeGreaterThan(0);
        expect(node.serviceInstances.length).toBeGreaterThan(0);
        expect(node.jobArtifacts.length).toBeGreaterThan(0);
        expect(node.jobSecretHandles.length).toBeGreaterThan(0);
        expect(node.workers.length).toBeGreaterThan(0);
        // intra-tenant referential integrity: every child names its own org + a real parent.
        const companyIds = new Set(node.companies.map((c) => c.id));
        const jobIds = new Set(node.jobs.map((j) => j.id));
        const attemptIds = new Set(node.attempts.map((a) => a.id));
        const serviceIds = new Set(node.services.map((s) => s.id));
        for (const c of node.companies) expect(c.organizationId).toBe(node.org.id);
        for (const j of node.jobs) {
          expect(j.organizationId).toBe(node.org.id);
          expect(companyIds.has(j.companyId)).toBe(true);
        }
        for (const a of node.attempts) {
          expect(a.organizationId).toBe(node.org.id);
          expect(jobIds.has(a.jobId)).toBe(true);
        }
        for (const l of node.leases) {
          expect(l.organizationId).toBe(node.org.id);
          expect(attemptIds.has(l.attemptId)).toBe(true);
        }
        for (const s of node.services) {
          expect(s.organizationId).toBe(node.org.id);
          expect(companyIds.has(s.companyId)).toBe(true);
        }
        for (const si of node.serviceInstances) {
          expect(si.organizationId).toBe(node.org.id);
          expect(serviceIds.has(si.serviceId)).toBe(true);
        }
        for (const ar of node.jobArtifacts) {
          expect(ar.organizationId).toBe(node.org.id);
          expect(jobIds.has(ar.jobId)).toBe(true);
        }
        for (const sh of node.jobSecretHandles) {
          expect(sh.organizationId).toBe(node.org.id);
          expect(jobIds.has(sh.jobId)).toBe(true);
        }
        for (const w of node.workers) {
          expect(w.scope).toBe("organization");
          expect(w.organizationId).toBe(node.org.id);
        }
      }
      // platform (null-Org) workers exist and are correctly shaped.
      expect(g.platformWorkers.length).toBeGreaterThan(0);
      for (const w of g.platformWorkers) {
        expect(w.scope).toBe("platform");
        expect(w.organizationId).toBeNull();
      }
    }
  });

  it("all ids are valid v4-shaped uuids and globally unique; slugs + issue prefixes globally unique", () => {
    for (const seed of TENANT_ADVERSARIAL_SEEDS) {
      const g = generateTenantGraph(seed);
      const ids = allRowIds(g);
      for (const id of ids) expect(id).toMatch(UUID_RE);
      expect(new Set(ids).size).toBe(ids.length); // no id collisions within a graph
      const slugs = g.organizations.map((n) => n.org.slug);
      expect(new Set(slugs).size).toBe(slugs.length);
      const prefixes = g.organizations.flatMap((n) => n.companies.map((c) => c.issuePrefix));
      expect(new Set(prefixes).size).toBe(prefixes.length);
    }
  });

  it("slugs + issue prefixes are unique ACROSS seeds (safe to seed many graphs into one database)", () => {
    const slugs: string[] = [];
    const prefixes: string[] = [];
    for (const seed of TENANT_ADVERSARIAL_SEEDS) {
      const g = generateTenantGraph(seed);
      for (const n of g.organizations) {
        slugs.push(n.org.slug);
        for (const c of n.companies) prefixes.push(c.issuePrefix);
      }
    }
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it("the hostile corpus has the expected shape (cross-org ids, sentinel, null-Org worker, absent + malformed uuids)", () => {
    const g = generateTenantGraph(42);
    const actor = g.organizations[0]!;
    const corpus = buildHostileCorpus(g, actor.org.id);

    expect(corpus.actorOrgId).toBe(actor.org.id);

    // Cross-org ids are non-empty and exclude the actor's own tenant.
    expect(corpus.crossOrgIds.length).toBeGreaterThan(0);
    expect(corpus.crossOrgIds).not.toContain(actor.org.id);

    // Cross-tenant row ids exist for every accessor type and none belong to the actor.
    const actorJobIds = new Set(actor.jobs.map((j) => j.id));
    const actorCompanyIds = new Set(actor.companies.map((c) => c.id));
    expect(corpus.crossOrgJobIds.length).toBeGreaterThan(0);
    expect(corpus.crossOrgJobIds.some((id) => actorJobIds.has(id))).toBe(false);
    expect(corpus.crossOrgAttemptIds.length).toBeGreaterThan(0);
    expect(corpus.crossOrgLeaseIds.length).toBeGreaterThan(0);
    expect(corpus.crossOrgServiceIds.length).toBeGreaterThan(0);
    expect(corpus.crossOrgServiceInstanceIds.length).toBeGreaterThan(0);
    expect(corpus.crossOrgJobArtifactIds.length).toBeGreaterThan(0);
    expect(corpus.crossOrgJobSecretHandleIds.length).toBeGreaterThan(0);
    expect(corpus.crossOrgWorkerIds.length).toBeGreaterThan(0);
    expect(corpus.crossOrgCompanyIds.length).toBeGreaterThan(0);
    expect(corpus.crossOrgCompanyIds.some((id) => actorCompanyIds.has(id))).toBe(false);

    // The forbidden distributed-admission sentinel + a null-Org platform worker id.
    expect(corpus.forbiddenSentinelOrgId).toBe(FORBIDDEN_SENTINEL_ORG_ID);
    expect(corpus.nullOrgWorkerIds.length).toBeGreaterThan(0);
    const platformWorkerIds = new Set(g.platformWorkers.map((w) => w.id));
    expect(corpus.nullOrgWorkerIds.every((id) => platformWorkerIds.has(id))).toBe(true);

    // Malformed + absent uuids. Absent uuids are valid-format but own NO row in the graph.
    expect(corpus.absentUuids.length).toBeGreaterThan(0);
    for (const id of corpus.absentUuids) expect(id).toMatch(UUID_RE);
    const allIds = new Set(allRowIds(g));
    expect(corpus.absentUuids.some((id) => allIds.has(id))).toBe(false);
    expect(corpus.malformedIds.length).toBeGreaterThan(0);
    for (const id of corpus.malformedIds) expect(id).not.toMatch(UUID_RE);
  });

  it("the corpus is deterministic for a fixed (seed, actor)", () => {
    const g = generateTenantGraph(7);
    const actor = g.organizations[1]!.org.id;
    expect(JSON.stringify(buildHostileCorpus(g, actor))).toBe(
      JSON.stringify(buildHostileCorpus(generateTenantGraph(7), actor)),
    );
  });

  it("the surface registry marks repository + composite_sql implemented and the rest not (with owning-epic notes)", () => {
    expect(TENANT_ADVERSARIAL_SURFACES.length).toBe(8);
    const byKey = new Map<SurfaceKey, (typeof TENANT_ADVERSARIAL_SURFACES)[number]>(
      TENANT_ADVERSARIAL_SURFACES.map((s) => [s.key, s]),
    );
    expect(byKey.get("repository")?.implemented).toBe(true);
    expect(byKey.get("composite_sql")?.implemented).toBe(true);
    for (const key of ["http", "worker_events", "websocket", "object_key", "placement", "restore"] as const) {
      const entry = byKey.get(key);
      expect(entry, `surface ${key} registered`).toBeDefined();
      expect(entry!.implemented, `surface ${key} not implemented at E2`).toBe(false);
      expect(entry!.note.length, `surface ${key} owning-epic note`).toBeGreaterThan(0);
    }
  });

  it("exposes exactly 8 distinct integer seeds (the fixed reproducible set)", () => {
    expect(TENANT_ADVERSARIAL_SEEDS.length).toBe(8);
    expect(new Set(TENANT_ADVERSARIAL_SEEDS).size).toBe(8);
    expect(TENANT_ADVERSARIAL_SEEDS.every((s) => Number.isInteger(s))).toBe(true);
  });

  it("exposes the op-class set including the FK-oracle axis (E2-F013/E2-D09)", () => {
    expect(new Set(TENANT_ADVERSARIAL_OP_CLASSES).size).toBe(TENANT_ADVERSARIAL_OP_CLASSES.length);
    // The oracle axis must be a first-class counter so a vacuous run can't hide it.
    expect(TENANT_ADVERSARIAL_OP_CLASSES).toContain("crossParentVsAbsentUniform");
    // The read/write/null-Org/composite classes are all present too.
    for (const k of [
      "crossRead",
      "crossInsertReject",
      "crossUpdateZero",
      "nullOrgWriteReject",
      "compositeSqlReject",
    ] as const) {
      expect(TENANT_ADVERSARIAL_OP_CLASSES).toContain(k);
    }
  });
});
