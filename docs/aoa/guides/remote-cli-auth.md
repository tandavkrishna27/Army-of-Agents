# Remote CLI authentication

AOA runs Codex and Claude inside the AOA runtime. Installing either CLI only on
the Hetzner host does not make it available inside the container.

## Hosted profiles

Set one explicit profile:

```env
# Shared hosted control plane: subscription sessions are disabled.
AOA_INSTALL_PROFILE=hosted_multi_tenant
```

```env
# Company-dedicated QA server/worker:
AOA_INSTALL_PROFILE=remote_single_tenant
AOA_CODEX_DEVICE_AUTH=true
AOA_CLAUDE_PASTE_AUTH=true
AOA_EXECUTION_TARGET_ID=hetzner-qa
AOA_SCOPED_CLI_AUTH=true
```

Do not enable the dedicated profile on a runtime that executes work for multiple
untrusted companies. Scoped directories route credentials to the correct
company/user, but processes running under the same Linux identity are not a
security boundary.

Run exactly one AOA server/login-worker replica for this R1 flow. Challenge
process ownership is local to that replica; do not use rolling overlap or
horizontal server replicas until runtime-instance ownership and routing are
implemented.

After changing the environment, rebuild and recreate the server container. The
onboarding Verify screen displays the detected profile and only offers flows
allowed by the server:

- Codex subscription: `codex login --device-auth`, then enter the displayed
  one-time code on the OpenAI page.
- Claude subscription: `claude auth login --claudeai`, then paste the returned
  one-time code into AOA.
- API key: AOA performs a bounded provider check before replacing the encrypted
  active key. API usage is billed separately from a ChatGPT or Claude subscription.

Each subscription credential is stored beneath an opaque scoped path:

```text
/aoa/execution-targets/<target>/auth/<company>/<user>/openai
/aoa/execution-targets/<target>/auth/<company>/<user>/anthropic
```

Authorization URLs and device/paste codes are not stored in the challenge row.
A server restart expires the actionable login material; start the flow again.

`AOA_SCOPED_CLI_AUTH=true` also makes CLI execution fail closed unless the agent
has exactly one active, approved provider-credential binding for its execution
target. A successful onboarding Verify probe now verifies the founder's scoped
credential and atomically approves it for the configured Commander. Existing
agents still require an explicit founder-approved binding before enabling the
flag.
Revoking a local subscription credential requires founder access and an exact
credential-ID confirmation. AOA revokes all of its agent bindings before deleting
that credential's validated scoped provider directory.

For machine-readable deployment diagnostics, run:

```sh
aoa doctor --json
aoa doctor --json --offline
```

The offline form checks local configuration and filesystem prerequisites without
probing the database, provider APIs, or listening ports.

## `/aoa` data migration

The `aoa-data` volume name is unchanged; current Compose mounts it at `/aoa`.
The image exposes `/paperclip` only as a compatibility symlink. A new image
started with an old Compose file fails closed if the old file mounts a separate
volume over `/paperclip`.

Before upgrading:

1. Snapshot the `aoa-data` and database volumes.
2. Pull both the new image and Compose file.
3. Confirm `aoa-data` is mounted at `/aoa`.
4. Start the server and check `/api/health`.

For image rollback, explicitly mount the unchanged `aoa-data` volume at the old
image's expected target. Do not initialize a new empty volume as a workaround.

## QA checklist

For each enabled provider:

1. Open onboarding and confirm the detected profile is correct.
2. Complete subscription sign-in with a disposable QA user.
3. Run Verify and require a live hello probe.
4. Run one bounded Commander turn.
5. Cancel and restart a challenge.
6. Restart the server during a pending challenge and confirm the UI asks to
   start again.
7. Confirm logs, activity entries, HTTP errors, and browser console contain no
   API key, pasted code, device code, token, or authorization query string.
