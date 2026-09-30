---
title: Budget and Spend
summary: Budget caps, spend views, provider quotas, incidents, and hard stops
---

AoA tracks model spend and enforces budget policies so agents cannot quietly run past configured limits.

Budget is managed from **Settings -> Budget & caps**. The legacy `/budget`, `/costs`, and `/activity` routes redirect into Settings tabs.

## Spend Views

The Budget section supports date ranges:

- Month to date
- Last 7 days
- Last 30 days
- Year to date
- All time
- Custom

Summary cards show total spend, Commander monthly spend, budget limit or unlimited status, utilization, and progress color.

## Budget Policies

Policies can be company-scoped or agent-scoped. A policy defines:

- Monthly limit
- Warning threshold
- Whether hard stop is enabled

At the warning threshold, operators get visibility into rising spend. At the hard-stop threshold, governed runs are blocked or paused according to the policy.

## Incidents

Open budget incidents appear in the Budget section. Review them before raising limits so you know whether spend came from expected work or a runaway loop.

## Provider Quotas and Subscriptions

The Budget section also shows provider quota windows and subscription panels when data exists, including Claude/Codex subscription context and per-model spend breakdowns.

Use **Settings -> Providers**, **Settings -> Secrets**, and **Settings -> Environments** to fix missing credentials or execution target issues. Memory embeddings use the Memory OpenAI key; extraction is CLI-only and does not use a hosted extraction key.

## API Reference

Common cost and budget routes:

```http
GET /api/companies/{companyId}/costs/summary
GET /api/companies/{companyId}/costs/by-agent
GET /api/companies/{companyId}/costs/by-project
POST /api/companies/{companyId}/budgets/policies
GET /api/companies/{companyId}/quotas
POST /api/companies/{companyId}/quotas/refresh
```

See `docs/api/costs.md` for the full API contract.
