// Pure marketplace catalog dependency auditor, shared by:
//   - the required contract test (server/src/__tests__/marketplace-dependency-audit.test.ts),
//     which audits a committed fixture projection, and
//   - the standalone live-CDN advisory (scripts/audit-catalog-dependencies.ts),
//     which audits the catalog actually published, catching upstream drift
//     between fixture refreshes.
// It asserts every agent's and the crew team's `requires` edge resolves to a
// matching-type, ACTIVE catalog item.

export type CatalogAuditItem = {
  id: string;
  type: string;
  status: string;
  requires?: { type: string; id: string; versionRange?: string }[];
};

export type CatalogAuditInput = { items: CatalogAuditItem[] };

export type CatalogDependencyOrphan = {
  owner: string;
  requiredType: string;
  requiredId: string;
  reason: "missing" | "type-mismatch" | "not-active";
};

/**
 * Returns every agent/team `requires` edge that does NOT resolve to a
 * matching-type, active item in the catalog. Empty result = all edges resolve.
 */
export function auditCatalogDependencies(catalog: CatalogAuditInput): CatalogDependencyOrphan[] {
  const byId = new Map(catalog.items.map((i) => [i.id, i]));
  const out: CatalogDependencyOrphan[] = [];
  for (const owner of catalog.items) {
    if (owner.type !== "agent" && owner.type !== "team") continue;
    for (const edge of owner.requires ?? []) {
      const target = byId.get(edge.id);
      if (!target) {
        out.push({ owner: owner.id, requiredType: edge.type, requiredId: edge.id, reason: "missing" });
      } else if (target.type !== edge.type) {
        out.push({ owner: owner.id, requiredType: edge.type, requiredId: edge.id, reason: "type-mismatch" });
      } else if (target.status !== "active") {
        out.push({ owner: owner.id, requiredType: edge.type, requiredId: edge.id, reason: "not-active" });
      }
    }
  }
  return out;
}
