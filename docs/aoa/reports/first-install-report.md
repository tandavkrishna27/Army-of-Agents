# AoA first-install report

Date: 30 September 2026 (Asia/Calcutta)

Source repository: [tandavkrishna27/AoA](https://github.com/tandavkrishna27/AoA)

Verified source commit: `64f403625cc0028c616b8fcf7936a601281759a2`

## Verification

- Frozen dependency installation passed with the repository's pinned pnpm version.
- Production build passed.
- Recursive typecheck passed.
- Full test suite passed: 1,976 files, 18,171 tests; 606 skipped; no failures.
- Database and migration checks passed.
- Nine setup doctor checks passed.
- API health returned `ok` and the UI returned HTTP 200.
- Commander completed a live verification response.

## Installation notes

The original installation used machine-specific paths and local launcher files; those are intentionally omitted here. Runtime state, credentials, databases, logs, `node_modules`, and build output are not part of the source export.

Default crew agents may require the Claude CLI to be installed, or their provider configuration changed. Commander was verified through Codex using the supported local launcher setup.

Nonblocking warnings included listener-count, dependency deprecation, Vite bundle-size, and duplicate dynamic/static import warnings. They did not affect installation, build, tests, API health, or Commander verification.
