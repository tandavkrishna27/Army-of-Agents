---
title: Environments
summary: Company-scoped execution environments, drivers, targets, and secret bindings
---

Environments describe where agent/runtime work can execute. They are company-scoped and board-controlled.

## Probe

```
POST /api/companies/{companyId}/environments/probe
```

Checks whether a proposed environment target/driver can be reached or configured.

## CRUD

```
GET /api/companies/{companyId}/environments
GET /api/companies/{companyId}/environments/{environmentId}
POST /api/companies/{companyId}/environments
PATCH /api/companies/{companyId}/environments/{environmentId}
DELETE /api/companies/{companyId}/environments/{environmentId}
```

Environment payloads are validated by the shared environment validators. Targets include local-style execution and sandbox targets such as `sandbox-docker`. Secret bindings reference company secrets rather than embedding secret material in the environment record.

An environment may carry a nullable `executionTargetId`. A UUID pins runs to one registered execution target; `null` leaves routing automatic and lets the server choose from the resolved credential kind. The runtime resolver rejects unavailable explicit pins rather than silently changing execution destinations.

For a gVisor-backed sandbox, set `driver` to `sandbox` and use a validated config such as:

```json
{
  "provider": "gvisor",
  "image": "aoa/agent-base:latest",
  "runtime": "runsc",
  "network": "none",
  "isolation": {
    "user": "1000:1000",
    "capDropAll": true,
    "noNewPrivileges": true,
    "readOnlyRootfs": true,
    "memory": "2g",
    "cpus": "2",
    "pidsLimit": 512
  }
}
```

Self-hosted execution may resolve this to the hardened local Docker profile. In `cloud_auth`, a gVisor config does not provision or prove a worker pool: local Docker execution fails closed until the separate worker plane and Gate-B validation exist. See [Execution Targets](execution-targets.md) and the deployment guide for the Gate-B worker requirements.

Use project-level `GET/PATCH /api/projects/{projectId}/environment` only for legacy project environment variables documented in Goals and Projects.
