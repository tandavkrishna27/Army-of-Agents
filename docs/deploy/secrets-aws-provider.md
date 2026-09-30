---
title: AWS Secrets Provider
summary: Configure AWS Secrets Manager vaults
---

AoA supports AWS Secrets Manager as a company-scoped provider vault. Use it when deployment infrastructure already owns the AWS credential chain and you want agent/runtime secrets stored in AWS rather than only in local encrypted storage.

## Credential Model

AoA does not store AWS access keys for this provider. The server resolves credentials through the AWS SDK runtime chain: instance profile, container role, workload identity, or deployment-managed environment credentials.

Use least-privilege IAM permissions for the secret namespace you configure. A typical policy grants `secretsmanager:CreateSecret`, `PutSecretValue`, `GetSecretValue`, `DescribeSecret`, and `ListSecrets` for the chosen prefix.

## Configure a Vault

In the UI, open **Secrets**, create an AWS vault, and set:

| Field | Notes |
|-------|-------|
| Region | AWS Secrets Manager region, such as `us-east-1` |
| Prefix | Optional namespace guardrail, such as `aoa/prod` |
| KMS key id | Optional customer-managed KMS key |
| Tags | Optional owner/environment metadata |

GCP Secret Manager and HashiCorp Vault remain coming-soon providers in this release.

## Remote Import

Remote import previews AWS secret metadata and stores selected items as external references. It does not read or copy plaintext values during import.

At runtime, secret resolution reads the provider and writes a `secret_access_events` audit row for every success or failure.
