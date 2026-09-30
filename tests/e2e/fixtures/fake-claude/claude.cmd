@echo off
rem Windows shim: `where claude` / spawn("claude", { shell: true }) resolve to
rem this .cmd when the fixture dir is prepended to PATH. The repo's e2e suite
rem is config-skipped on Windows without DATABASE_URL; kept for parity.
node "%~dp0fake-claude.mjs" %*
