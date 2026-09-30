# E2B Provider Key Environment Flow QA

Date: 2026-06-01
Workspace: C:\Users\TK\OneDrive\Desktop\Claude Data\Paperclip-AoA\AoA-2.5\.worktrees\paperclip-runtime-cloud-plan-review
URL: http://127.0.0.1:5174
API: http://127.0.0.1:3110/api

## Environment

- Started the backend from this worktree on port `3110` with an isolated temp embedded Postgres config at `C:\Users\TK\AppData\Local\Temp\aoa-paperclip-runtime-cloud-plan-review\config.json`.
- Started Vite from this worktree on port `5174`, proxying to backend port `3110`.
- Verified `GET /api/health` returned `status: "ok"`, `deploymentMode: "local_trusted"`, and `bootstrapStatus: "ready"`.
- Browser console error check during the exercised screens returned no error-level logs.

## Flow Covered

1. Created QA company `E2B QA Company` through the local-trusted API.
2. Opened Settings -> Secrets.
3. Created active secret `E2B QA API Key` with placeholder value `e2b_test_secret_12345`.
4. Confirmed the saved secret inventory and preview did not render the raw placeholder value.
5. Opened Secrets -> Provider Keys.
6. Created default E2B provider key `Default E2B QA` backed by the saved secret.
7. Confirmed the Provider Keys tab shows provider, default/status, and linked secret name without secret material.
8. Opened Settings -> Environments.
9. Created E2B environment `E2B Cloud QA` using `Company default provider key`, template `base`, timeout `60000`, and no raw API key field.
10. Confirmed the saved environment row shows `E2B Sandbox: base`.
11. Confirmed API output stores environment config as:
    - `provider: "e2b"`
    - `credentialRef: "default"`
    - `template: "base"`
    - `timeoutMs: 60000`
    - `reuseLease: false`
12. Confirmed `GET /runtime-provider-keys` and `GET /environments` responses do not include raw secret material.
13. Submitted an E2B probe with the placeholder key. The API now returns `422` with a failed probe result instead of a `500`.
14. Rotated `E2B QA API Key` to a live E2B credential supplied by the operator. Confirmed secret metadata advanced to version `2` and did not expose the raw value.
15. Re-ran the E2B probe through `POST /environments/probe`. Result: `ok: true`, provider `e2b`, summary `E2B sandbox created and workspace directory prepared.`, remote cwd `/home/user/aoa-workspace`.
16. Ran a runtime command smoke using a real heartbeat run context, the default provider key, and the saved E2B environment:
    - acquired an E2B lease
    - executed `pwd`
    - received exit code `0` and stdout `/home/user/aoa-workspace`
    - released the lease with cleanup status `success`
17. Created an org agent `E2B Process Heartbeat Smoke ...` with `adapterType: "process"` and assigned `defaultEnvironmentId` to `E2B Cloud QA`.
18. Invoked the agent through `POST /agents/:id/heartbeat/invoke`.
19. Confirmed the product-level heartbeat path completed:
    - run status `succeeded`
    - exit code `0`
    - liveness `advanced` / `adapter_succeeded`
    - result stdout included `/home/user/aoa-workspace` and the real heartbeat run id
    - E2B lease status `released`
    - secret access audit rows were tied to the heartbeat run id

## Runtime Findings

- Runtime provider keys are correctly resolved only inside server-side runtime/probe paths. A standalone script must load the same local secrets master-key config as the running server; otherwise encrypted secret values cannot be decrypted.
- Secret access audit rows require valid referenced heartbeat runs when `heartbeatRunId` is provided. Direct low-level runtime smoke tests must create/use a real heartbeat run row, or call through the normal heartbeat path.
- The product-level process-adapter smoke emitted harmless stderr from the remote shell setup: `source: not found`. The E2B environment defaulted to `sh`; Codex/Claude-style adapter runs should use `bash` in the E2B environment config or the runtime wrapper should avoid `source` under `sh`.
- `process` is the right first E2B heartbeat smoke because it proves the AoA runtime plumbing without depending on AI CLI install/auth.
- Codex/Claude provider-sandbox readiness is now covered by focused adapter tests: provider-sandbox commands use runtime install wrapping, Codex receives sandbox-local `CODEX_HOME`, and Claude preserves API-key env through the remote wrapper.

## Bugs Found And Fixed

- Provider key dialog stayed open after a successful save. Fixed in `ProviderKeyDialog` and covered by `ProviderKeysTab.test.tsx`.
- E2B environments displayed as `local target` in the list row. Fixed summary formatting to show `E2B Sandbox: base` and covered by `EnvironmentsSection.test.tsx`.
- E2B probe with an invalid key format returned `500`. Fixed probe error handling to return a normal failed probe result and covered by `environment-probe.test.ts`.

## Not Covered

- Full live Codex/Claude agent execution inside E2B was not run in this pass. The adapter-runtime hardening is now implemented at the unit/integration-adapter level; the remaining live smoke needs an OpenAI or Anthropic runtime credential wired through AoA secrets/env bindings.
