# AoA E2B sandbox template (`aoa-base`)

On `cloud_auth`, AoA runs each agent (and the readiness probe / extraction /
Commander compaction) inside a per-run E2B microVM. The E2B **`base`** template
is bare, so the CLIs AoA runs — `claude`, `codex` — are not present and a run
fails with `env: 'claude': No such file or directory`. This directory defines a
custom template, **`aoa-base`**, that pre-installs them so sandboxes start ready
(no per-run `npm install -g`).

## 1. Prerequisites

- An E2B account and its API key (the **same** value set as `E2B_API_KEY` on the
  instance) — the template is built on, and consumed from, that account.
- The E2B CLI:

  ```bash
  npm install -g @e2b/cli
  ```

## 2. Build + register the template (on your E2B account)

From **this** directory (it contains `e2b.Dockerfile`):

```bash
e2b auth login          # or: export E2B_ACCESS_TOKEN=e2b_...
e2b template build --name aoa-base --dockerfile e2b.Dockerfile
```

This builds the image and registers it on your E2B account under the alias
`aoa-base`, printing a template ID. The final Dockerfile step (`command -v claude
&& command -v codex`) makes the build **fail** if either CLI is missing, so a
successful build guarantees the template is correct. (Exact CLI flags can vary by
`@e2b/cli` version — see https://e2b.dev/docs if `--name`/`--dockerfile` differ.)

## 3. Point AoA at it

Set **`E2B_TEMPLATE=aoa-base`** on the instance. On the deployed testing stack
this is threaded end to end: the `Deploy testing` workflow's `e2b_template` input
→ `E2B_TEMPLATE` env → `write-compose-env.mjs` → `docker-compose.yml` →
`resolvePlatformDefaultEnvironment` (`platform-default-environment.ts`, which reads
`E2B_TEMPLATE` and otherwise defaults to `base`). Redeploy with the input set:

```
Deploy testing → deploy_sha=<green main sha> deployment_mode=cloud_auth e2b_template=aoa-base
```

## 4. Verify

**Settings → Providers → Test** (Claude and Codex). With `aoa-base` live the probe
spawns a VM that already has the CLIs, so the result becomes
`{claude,codex}_hello_probe_passed` ("hello probe succeeded in the sandbox"), and
real agent runs execute in the sandbox with no install latency.

> The bare-`base` fallback still works for **agent runs** — the adapter exec
> wrapper runs `npm install -g @anthropic-ai/claude-code` at spawn
> (`server/src/adapters/registry.ts`). `aoa-base` just makes every sandboxed
> path (including the probe/extraction/compaction one-shots, which do NOT install)
> work and start instantly.
