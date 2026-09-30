---
title: Secrets Management
summary: Master key, encryption, and strict mode
---

AoA encrypts local secrets at rest using a local master key. Agent environment variables that contain sensitive values (API keys, tokens) are stored as secret references.

AWS Secrets Manager is supported as a provider vault for managed values and external references. `gcp_secret_manager` and `vault` remain coming-soon providers that are visible in descriptors but reject use until implemented.

## Default Provider: `local_encrypted`

Secrets are encrypted with a local master key stored at:

```
~/.aoa/instances/default/secrets/master.key
```

> Note: existing installs that still have `~/.paperclip/` are read via the legacy fallback in `cli/src/config/home.ts`. On a fresh install, AoA writes only to `~/.aoa/`.

This key is auto-created during onboarding. The key never leaves your machine.

## AWS Secrets Manager Provider

Configure AWS vaults from the Secrets page or the provider-config API. AWS credentials are resolved from the deployment/runtime credential chain, not from AoA secrets. Use instance roles, workload identity, or environment credentials managed by your infrastructure.

Remote import links AWS secret names/ARNs as external references. Import does not read plaintext secret values. Runtime reads resolve through AWS Secrets Manager and write a `secret_access_events` audit row for every success and failure.

See `docs/deploy/secrets-aws-provider.md` for setup notes.

## Configuration

### CLI Setup

Onboarding writes default secrets config:

```sh
pnpm aoa onboard
```

Update secrets settings:

```sh
pnpm aoa configure --section secrets
```

Validate secrets config:

```sh
pnpm aoa doctor
```

### Environment Overrides

| Variable | Description |
|----------|-------------|
| `AOA_SECRETS_MASTER_KEY` | 32-byte key as base64, hex, or raw string |
| `AOA_SECRETS_MASTER_KEY_FILE` | Custom key file path |
| `AOA_SECRETS_STRICT_MODE` | Set to `true` to enforce secret refs |

## Strict Mode

When strict mode is enabled, sensitive env keys (matching `*_API_KEY`, `*_TOKEN`, `*_SECRET`) must use secret references instead of inline plain values.

```sh
AOA_SECRETS_STRICT_MODE=true
```

Recommended for any deployment beyond local trusted.

## Migrating Inline Secrets

If you have existing agents with inline API keys in their config, migrate them to encrypted secret refs:

```sh
pnpm secrets:migrate-inline-env         # dry run
pnpm secrets:migrate-inline-env --apply # apply migration
```

## Secret References in Agent Config

Agent environment variables use secret references:

```json
{
  "env": {
    "ANTHROPIC_API_KEY": {
      "type": "secret_ref",
      "secretId": "8f884973-c29b-44e4-8ea3-6413437f8081",
      "version": "latest"
    }
  }
}
```

The server resolves and decrypts these at runtime, injecting the real value into the agent process environment.
