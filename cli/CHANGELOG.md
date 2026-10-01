# @armyofagents/cli

## 1.0.1

### Patch Changes

- 40688fc: Add the July 2026 Docker deployment and runtime research consolidation: a pgvector-backed Compose deployment stack with first-run config/secret bootstrap, Google-OAuth `authenticated` mode (first sign-in becomes instance admin) with an opt-in CEO invite helper to pre-designate that admin when the URL is exposed before you sign in, and a disposable Docker research harness with deterministic e2e and opt-in real-provider lanes for Claude, Codex, and Gemini.
- 40688fc: fix(security): close cross-tenant IDOR on /approvals/:id/approve|reject|request-revision (C3) and remove the spoofable `decidedByUserId` body field (C4). Decider is now derived from `req.actor.userId` server-side; CLI no longer accepts `--decided-by-user-id`.
- Updated dependencies [40688fc]
- Updated dependencies [40688fc]
- Updated dependencies [40688fc]
- Updated dependencies [40688fc]
- Updated dependencies [40688fc]
- Updated dependencies [40688fc]
- Updated dependencies [40688fc]
- Updated dependencies [40688fc]
- Updated dependencies [40688fc]
- Updated dependencies [40688fc]
- Updated dependencies [40688fc]
- Updated dependencies [40688fc]
- Updated dependencies [40688fc]
- Updated dependencies [40688fc]
- Updated dependencies [40688fc]
- Updated dependencies [40688fc]
- Updated dependencies [40688fc]
- Updated dependencies [40688fc]
- Updated dependencies [40688fc]
- Updated dependencies [40688fc]
- Updated dependencies [40688fc]
- Updated dependencies [40688fc]
- Updated dependencies [40688fc]
- Updated dependencies [40688fc]
- Updated dependencies [40688fc]
- Updated dependencies [40688fc]
- Updated dependencies [40688fc]
- Updated dependencies [40688fc]
  - @armyofagents/db@1.0.1
  - @armyofagents/server@1.0.1
  - @armyofagents/shared@1.0.1
  - @armyofagents/adapter-utils@1.0.1
  - @armyofagents/adapter-claude-local@1.0.1
  - @armyofagents/adapter-codex-local@1.0.1
  - @armyofagents/adapter-cursor-local@1.0.1
  - @armyofagents/adapter-gemini-local@1.0.1
  - @armyofagents/adapter-openclaw@1.0.1
  - @armyofagents/adapter-opencode-local@1.0.1

> Historical release entries retain their dates and versions; inherited package labels have been normalized to the AoA scope for the clean export.

## 0.2.7

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @armyofagents/shared@0.2.7
  - @armyofagents/adapter-utils@0.2.7
  - @armyofagents/db@0.2.7
  - @armyofagents/adapter-claude-local@0.2.7
  - @armyofagents/adapter-codex-local@0.2.7
  - @armyofagents/adapter-openclaw@0.2.7
  - @armyofagents/server@0.2.7

## 0.2.6

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @armyofagents/shared@0.2.6
  - @armyofagents/adapter-utils@0.2.6
  - @armyofagents/db@0.2.6
  - @armyofagents/adapter-claude-local@0.2.6
  - @armyofagents/adapter-codex-local@0.2.6
  - @armyofagents/adapter-openclaw@0.2.6
  - @armyofagents/server@0.2.6

## 0.2.5

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @armyofagents/shared@0.2.5
  - @armyofagents/adapter-utils@0.2.5
  - @armyofagents/db@0.2.5
  - @armyofagents/adapter-claude-local@0.2.5
  - @armyofagents/adapter-codex-local@0.2.5
  - @armyofagents/adapter-openclaw@0.2.5
  - @armyofagents/server@0.2.5

## 0.2.4

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @armyofagents/shared@0.2.4
  - @armyofagents/adapter-utils@0.2.4
  - @armyofagents/db@0.2.4
  - @armyofagents/adapter-claude-local@0.2.4
  - @armyofagents/adapter-codex-local@0.2.4
  - @armyofagents/adapter-openclaw@0.2.4
  - @armyofagents/server@0.2.4

## 0.2.3

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @armyofagents/shared@0.2.3
  - @armyofagents/adapter-utils@0.2.3
  - @armyofagents/db@0.2.3
  - @armyofagents/adapter-claude-local@0.2.3
  - @armyofagents/adapter-codex-local@0.2.3
  - @armyofagents/adapter-openclaw@0.2.3
  - @armyofagents/server@0.2.3

## 0.2.2

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @armyofagents/shared@0.2.2
  - @armyofagents/adapter-utils@0.2.2
  - @armyofagents/db@0.2.2
  - @armyofagents/adapter-claude-local@0.2.2
  - @armyofagents/adapter-codex-local@0.2.2
  - @armyofagents/adapter-openclaw@0.2.2
  - @armyofagents/server@0.2.2

## 0.2.1

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @armyofagents/shared@0.2.1
  - @armyofagents/adapter-utils@0.2.1
  - @armyofagents/db@0.2.1
  - @armyofagents/adapter-claude-local@0.2.1
  - @armyofagents/adapter-codex-local@0.2.1
  - @armyofagents/adapter-openclaw@0.2.1
  - @armyofagents/server@0.2.1
