---
title: Organizations
summary: Tenant creation, membership discovery, and organization-wide spend
---

An Organization is the tenant above one or more Companies. Organization endpoints require an authenticated board session and never expose another user's membership list.

## Create an organization

```
POST /api/organizations
```

Body:

```json
{ "name": "Acme" }
```

Creates the Organization and its owner membership atomically. The signed-in user becomes the owner. The endpoint trims names, normalizes them to Unicode NFC, limits them to 100 characters, and rejects control/format characters and hard Unicode line separators while permitting ZWNJ/ZWJ joiners within otherwise visible international-script names. The server generates and de-duplicates the slug. Returns `201` with the Organization row.

## List my organization memberships

```
GET /api/organizations
```

Returns the signed-in user's active membership rows. Every row includes `organizationName` and `organizationSlug` display fields in addition to its membership fields. This is a membership list, not an unscoped Organization catalog. A board actor without a user identity receives an empty array.

## Organization spend

```
GET /api/organizations/{organizationId}/spend
```

Available to Organization owners, admins, and billing members. Returns the last 30 days of cost events across the Organization's Companies:

```json
{
  "totalCents": 1250,
  "byProvider": [
    { "provider": "anthropic", "costCents": 1000 },
    { "provider": "openai", "costCents": 250 }
  ]
}
```

Providers are sorted by descending spend. An Organization with no Companies or no cost events returns a zero summary.
