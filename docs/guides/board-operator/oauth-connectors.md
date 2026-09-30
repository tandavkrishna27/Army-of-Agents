---
title: "OAuth connectors"
description: "Authorize, verify, refresh, and safely roll back broker-managed MCP connectors"
---

OAuth connectors let a founder authorize a verified marketplace MCP server
without copying provider tokens into AoA. AoA stores a context-bound encrypted
credential and refreshes it only while the connector's current server policy is
still valid.

## Prerequisites

- Use an authenticated board session. Agent API keys cannot start or complete
  OAuth. In `local_trusted`, the synthetic local operator is supported.
- Set one stable `BETTER_AUTH_SECRET` for authenticated deployments.
  `AOA_AGENT_JWT_SECRET` is the supported fallback, but multi-instance systems
  must use the same stable value on every replica. Rotating the effective key
  invalidates outstanding flows and stored OAuth bundles; disable and
  reauthorize affected connectors.
- Configure the public callback origin with `AOA_AUTH_PUBLIC_BASE_URL` (or the
  documented auth base URL fallback). The provider-registered redirect URI must
  match `<public-origin>/api/mcp-connectors/oauth/callback` exactly.
- When AoA is behind a reverse proxy, configure `AOA_TRUST_PROXY` to the known
  hop count or trusted CIDRs. Do not use unrestricted trust on a directly
  exposed server; OAuth rate limiting and request identity depend on correct
  client-IP resolution.
- Keep `AOA_SECRETS_MASTER_KEY_FILE` stable, backed up, and available to every
  replica that can read the same database. Losing or changing that key makes
  existing local-encrypted OAuth credentials undecryptable; restore the key or
  revoke and reauthorize the affected connectors.
- Keep `AOA_MCP_CONNECTORS_ENABLED=true`. `AOA_MCP_CONNECTOR_DENYLIST` can block
  individual server names immediately during an incident.

## Authorize and verify

1. Open **Marketplace → Connectors** and install a verified OAuth connector.
2. Select **Connect**. Complete provider sign-in in the provider window; never
   send the authorization URL or code to an agent.
3. Return to AoA. A successful callback shows the connector as active. A denied
   or failed callback is terminal and offers a retry; it must not remain on
   “Checking…” indefinitely.
4. In **Settings → Agents**, enable the connector for one test agent.
5. Run a read-only tool-list/search smoke test against disposable provider data.
   Confirm the activity log contains authorization and tool-use entries without
   tokens, codes, cookies, or authorization query strings.

Changing the public callback URI causes AoA to perform a new dynamic client
registration when the provider policy permits it. A catalog outage after
installation does not weaken the stored provider policy or prevent a valid
authorization start.

## Test refresh safely

The force-expiry command is dry-run by default and targets one company, connector,
and expected secret version. It resolves the active external or running embedded
database automatically.

```bash
pnpm oauth:force-expiry <connector-id> \
  --company-id=<company-id> \
  --expected-version=<current-version>

pnpm oauth:force-expiry <connector-id> \
  --company-id=<company-id> \
  --expected-version=<current-version> \
  --apply --confirm=FORCE-OAUTH-EXPIRY
```

```powershell
pnpm oauth:force-expiry <connector-id> `
  --company-id=<company-id> `
  --expected-version=<current-version>

pnpm oauth:force-expiry <connector-id> `
  --company-id=<company-id> `
  --expected-version=<current-version> `
  --apply --confirm=FORCE-OAUTH-EXPIRY
```

Add `--confirm-production` when `NODE_ENV=production`. After apply, make one new
read-only agent request. Exactly one new credential version and one redacted
refresh activity should appear.

## Incident rollback

Rollback is data-destructive and must precede starting an old binary that cannot
understand OAuth v2 bundles.

1. Set `AOA_MCP_CONNECTOR_DENYLIST=notion,sentry` for the affected bundled
   providers, or set `AOA_MCP_CONNECTORS_ENABLED=false`, and restart/reload the
   deployment so delivery fails closed.
2. Take and verify a database backup.
3. Run a company-scoped dry run. Review connector IDs and counts.
4. Apply with the same fail-closed environment present, then run `--verify`.
5. Revoke the provider grants before starting the old binary.

```bash
pnpm oauth:rollback-v2 --company-id=<company-id>
pnpm oauth:rollback-v2 --company-id=<company-id> --apply \
  --backup-confirmed --maintenance-confirmed --confirm=ROLLBACK-MCP-OAUTH-V2
pnpm oauth:rollback-v2 --company-id=<company-id> --verify
```

```powershell
pnpm oauth:rollback-v2 --company-id=<company-id>
pnpm oauth:rollback-v2 --company-id=<company-id> --apply `
  --backup-confirmed --maintenance-confirmed --confirm=ROLLBACK-MCP-OAUTH-V2
pnpm oauth:rollback-v2 --company-id=<company-id> --verify
```

Fleet scope requires `--all-companies --instance-id=<active-instance-id>` and
uses that instance ID as the `--confirm` value. `--maintenance-confirmed` means
every running server was actually drained or restarted with the fail-closed
policy; the CLI environment alone is not proof. Production apply also requires
`--confirm-production`. The command archives only exact AoA-managed,
local-encrypted secrets whose company, connector binding, catalog identity,
policy version, purpose, owner, and name all match. It leaves collisions and
transplanted metadata untouched. Verification exits `0` when safe and `2` when
matching active data remains.

## Troubleshooting

| Problem | Likely cause | Fix |
|---|---|---|
| OAuth start says authentication is required | No board session or an agent key was used | Sign in to the board and retry from Marketplace |
| Signing-secret/configuration error | The effective auth signing key is absent or changed | Restore the stable key on every replica; reauthorize after a deliberate rotation |
| Redirect URI rejected | Public base URL and provider registration differ | Correct the public URL/provider callback and start a new authorization |
| `policy_blocked` | Emergency switch, denylist, identity, or current pinned policy rejected the connector | Keep it blocked, correct policy/catalog deployment, then explicitly retry |
| `secret_collision` | The reserved credential name is owned by different metadata | Inspect **Settings → Secrets**; do not rename or overwrite the colliding secret |
| Temporary refresh failure | Provider/network returned a retryable result | Leave the connector enabled and retry after backoff |
| Reauthorization required | Refresh token was permanently rejected | Connect again through Marketplace; never paste a token manually |
| Operator command cannot connect | The selected AoA instance/embedded server is not running, or config points elsewhere | Start that instance and confirm `AOA_CONFIG`, database mode, and port before retrying |
| Credential cannot decrypt | The command reached a database created with a different signing/secrets key | Stop; correct the instance/key selection. Do not force rollback ownership |
| Rollback preflight refuses apply | Backup or fail-closed denylist/switch is missing | Complete the named preflight; never bypass it with direct SQL |

For evidence, record only connector/company IDs, version numbers, fixed reason
codes, counts, and timestamps. Scan logs and artifacts for access/refresh tokens,
authorization codes, cookies, signing keys, and authorization query strings before
sharing them.
