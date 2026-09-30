---
title: Provider Connections
summary: Founder-controlled provider connection inspection, verification, and revocation
---

Provider connections model credential metadata and assignment policy without returning secret material. Every endpoint below requires company access and the Company `founder` role.

## List connections

```
GET /api/companies/{companyId}/provider-connections
```

Returns only connections belonging to the requested Company. The response includes connection identity, provider, authentication method, state, sharing policy, owner, execution target, and verification time. Secret references and configuration are not returned by this route.

## Verify a connection

```
POST /api/companies/{companyId}/provider-connections/{connectionId}/verify
```

Verifies a Company-scoped connection after provider terms have been attested. Returns `204`. Hosted multi-tenant deployments reject personal-subscription connections.

## Revoke a connection

```
DELETE /api/companies/{companyId}/provider-connections/{connectionId}
```

Revokes the connection and disables its dependent assignments in one transaction. A personal-subscription connection also removes its scoped on-disk credential home when applicable. Returns the connection id, `revoked` state, and whether files were removed; returns `404` when the connection is not in the requested Company.

## Current beta limitation

The REST surface currently lists, verifies, and revokes existing/backfilled connections. It does not yet create connections or upsert `org_default`, `company_default`, or agent assignments. Those write APIs and their UI are deferred to the provider-runtime follow-up; callers must not infer their availability from the shared validation schemas.
