# AoA Wire Contracts

AoA uses its own names across runtime, plugin, CLI, browser, export, and integration surfaces. The earlier compatibility inventory documented identifiers inherited from the upstream project. Decision #92 was superseded on 2026-09-30 for the clean break, and its exceptions no longer apply.

## Current contract

- Environment variables passed to agents use `AOA_*`, including `AOA_RUN_ID` and `AOA_API_KEY` for Hermes.
- OpenClaw execution payloads use `aoa_session_key` and `aoa_stream_transport`.
- The CLI is `aoa`; package scope is `@armyofagents`.
- Plugin manifests, bridge APIs, public SDK types, and scaffolding use AoA names.
- Browser storage, feedback schema versions, HTTP headers, company bundles, and workspace sentinels use AoA names.
- The CI brand check scans all tracked paths and file content without an allowlist.

The source defines exact field shapes and versions. See [the Hermes adapter](../adapters/hermes-local.md), [environment variables](../deploy/environment-variables.md), and [Decision #92](decisions.md) before changing a wire contract.
