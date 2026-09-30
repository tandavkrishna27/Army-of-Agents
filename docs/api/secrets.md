---
title: Secrets
summary: Secrets CRUD
---

Manage encrypted secrets that agents reference in their environment configuration.

## List Secret Providers

```
GET /api/companies/{companyId}/secret-providers
```

Returns the available secret provider backends for this instance (e.g. `local`, `aws_secrets_manager`). Board access required.

## List Provider Vault Configs

```
GET /api/companies/{companyId}/secret-provider-configs
```

Returns company-scoped vault configs. AWS Secrets Manager configs include non-secret metadata such as region and prefix.

## Create Provider Vault Config

```
POST /api/companies/{companyId}/secret-provider-configs
{
  "provider": "aws_secrets_manager",
  "displayName": "Production AWS",
  "isDefault": true,
  "config": {
    "region": "us-east-1",
    "secretNamePrefix": "aoa/prod"
  }
}
```

AWS credentials come from the AoA deployment/runtime credential chain. Do not store AWS access keys in AoA secrets.

## List Secrets

```
GET /api/companies/{companyId}/secrets
```

Returns secret metadata (not decrypted values).

## Create Secret

```
POST /api/companies/{companyId}/secrets
{
  "name": "anthropic-api-key",
  "value": "sk-ant-..."
}
```

The value is encrypted at rest. Only the secret ID and metadata are returned.

For AWS external references, pass `managedMode: "external_reference"`, `provider: "aws_secrets_manager"`, a `providerConfigId`, and an `externalRef`. The UI's import flow creates these rows without reading plaintext values.

## Update Secret Metadata

```
PATCH /api/secrets/{secretId}
{
  "name": "new-name",
  "description": "updated description",
  "externalRef": "arn:aws:secretsmanager:..."
}
```

Updates metadata only — `name`, `description`, and `externalRef`. Does **not** accept a `value` field and does not create a new secret version. To rotate the encrypted value, use the rotate route below.

## Rotate Secret Value

```
POST /api/secrets/{secretId}/rotate
{
  "value": "sk-ant-new-value...",
  "externalRef": "arn:aws:secretsmanager:..."
}
```

Replaces the encrypted value and increments the version number. `externalRef` is optional (used when the secret is stored in an external provider such as AWS Secrets Manager). Agents referencing `"version": "latest"` automatically get the new value on next heartbeat.

## Delete Secret

```
DELETE /api/secrets/{secretId}
```

Permanently deletes the secret and all its versions. Returns `{ "ok": true }` on success.

## Bind Secret to a Consumer

```
POST /api/secrets/{secretId}/bindings
{
  "targetType": "agent",
  "targetId": "{agentId}",
  "configPath": "env.OPENAI_API_KEY",
  "versionSelector": "latest",
  "required": true
}
```

Bindings authorize runtime resolution for a specific consumer and config path.

## List Access Events

```
GET /api/secrets/{secretId}/access-events
```

Returns newest-first read audit events. AoA writes an event for every successful read and every failed read after the secret row is identified.

## Remote Import Preview and Commit

```
POST /api/companies/{companyId}/secrets/remote-import/preview
POST /api/companies/{companyId}/secrets/remote-import
```

Preview lists AWS remote candidates by metadata. Commit stores external-reference rows and does not import secret plaintext.

## Using Secrets in Agent Config

Reference secrets in agent adapter config instead of inline values:

```json
{
  "env": {
    "ANTHROPIC_API_KEY": {
      "type": "secret_ref",
      "secretId": "{secretId}",
      "version": "latest"
    }
  }
}
```

The server resolves and decrypts secret references at runtime, injecting the real value into the agent process environment.
