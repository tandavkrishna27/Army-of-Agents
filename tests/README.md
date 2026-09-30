# AoA E2E Tests

Playwright harness for end-to-end smoke testing. Ported from Paperclip's
`tests/e2e/` and adapted for AoA's onboarding wizard.

## Layout

```
tests/
  README.md                       ← you are here
  e2e/
    playwright.config.ts          ← default local_trusted config
    onboarding.spec.ts            ← onboarding smoke spec (SKIP_LLM)
```

Variant configs (`playwright-multiuser.config.ts`,
`playwright-multiuser-authenticated.config.ts`) are deferred to Phase D
(multi-tenancy). The single-user default config is enough for the
current scaffold.

## Installing browsers

`@playwright/test` is declared in the repo root `package.json` but the
actual browser binaries are downloaded on demand. After `pnpm install`,
run:

```bash
pnpm exec playwright install chromium
```

Firefox and WebKit are not required for the smoke scaffold. CI should
install only Chromium unless a spec explicitly targets another engine.

## Running

```bash
# Headless (default)
pnpm test:e2e

# Headed (debugging)
pnpm test:e2e:headed

# List test cases without running
pnpm exec playwright test --config=tests/e2e/playwright.config.ts --list
```

## Environment variables

| Variable               | Default | Purpose                                                              |
| ---------------------- | ------- | -------------------------------------------------------------------- |
| `AOA_E2E_PORT`         | `3199`  | Dedicated port for the throwaway e2e server (avoids clobbering dev). |
| `AOA_E2E_SKIP_LLM`     | `true`  | Skip LLM-dependent assertions (onboarding only).                     |
| `DATABASE_URL`         | —       | Optional external Postgres URL. Required to run e2e on Windows.      |
| `ANTHROPIC_API_KEY`    | —       | Required only when `AOA_E2E_SKIP_LLM=false`.                         |

> Note: `tests/e2e/playwright.config.ts` reads `AOA_E2E_*` env vars
> directly — the runtime env-compat layer that mirrors `PAPERCLIP_*`
> for the server/cli does NOT cover the Playwright runner. If your
> shell exports `PAPERCLIP_E2E_PORT` or similar, rename them to
> `AOA_E2E_*` before running e2e.

## How the harness boots a server

The Playwright `webServer` directive runs `pnpm aoa onboard --yes
--run` in a temp `AOA_HOME`. That bootstraps a fresh instance with
Quickstart defaults and starts the server on `AOA_E2E_PORT`. The
spec talks to `http://127.0.0.1:${PORT}` — never to the developer's
active AoA home.

`reuseExistingServer: false` means each run starts a clean server. First
run downloads nothing extra but subsequent runs reuse the temp dir for
that test invocation only.

## Known gotchas

- **Database:** the throwaway home auto-runs migrations. If migrations
  are broken on `main`, e2e will fail at `webServer` start with a 120s
  timeout. Run `pnpm typecheck && pnpm test` locally first.
- **Windows:** embedded Postgres cannot start under the administrative
  `runneradmin` user used by Windows CI. Windows e2e is skipped unless
  `DATABASE_URL` points to an external Postgres instance. When skipped,
  Playwright exits cleanly instead of failing with "No tests found".
- **Adapter CLIs:** the onboarding spec stops at step 2 (workspace
  root) by default — the full flow requires `claude` (or a local
  adapter CLI) on PATH for the step-3 adapter environment check. A
  later session will add an adapter-stub mode for full-flow e2e.
- **Port collision:** if `:3199` is already in use, set
  `AOA_E2E_PORT` to any free port.
- **Flakiness:** the spec uses Playwright's locator auto-retry. No
  manual `waitFor` sleeps. If a spec flakes, increase timeouts on the
  specific assertion rather than retrying the whole test.

## CI considerations

- Install only Chromium (`pnpm exec playwright install chromium`).
- Run headless. Enable `trace: "on-first-retry"` (default) for
  failure diagnosis.
- `retries: 0` in the default config — make CI re-run the whole job on
  failure rather than retrying flaky specs silently.
- HTML report lands in `tests/e2e/playwright-report/` (gitignored).

## Porting new specs

One spec per major feature flow. Keep assertions focused:
1. Navigate to the entry point.
2. Assert the heading/title renders.
3. Interact with ≤ 3 UI elements.
4. Verify the side-effect via `page.request` against the API.

Full coverage lives in `server/src/__tests__/` (unit + integration).
Playwright is for catching layout/routing/flow regressions that unit
tests cannot see.
