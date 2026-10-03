# AoA Wire Contracts

AoA uses AoA-owned names across runtime, plugin, CLI, browser, export, and integration surfaces. Preserve these names when changing adapters or integrations.

## Current contract

- Environment variables passed to agents use `AOA_*`, including `AOA_RUN_ID` and `AOA_API_KEY` for Hermes.
- OpenClaw execution payloads use `aoa_session_key` and `aoa_stream_transport`.
- The CLI is `aoa`; package scope is `@armyofagents`.
- Plugin manifests, bridge APIs, public SDK types, and scaffolding use AoA names.
- Browser storage, feedback schema versions, HTTP headers, company bundles, and workspace sentinels use AoA names.
- The CI brand check scans all tracked paths and file content without an allowlist.

The source defines exact field shapes and versions. See [the Hermes adapter](../adapters/hermes-local.md) and [environment variables](../deploy/environment-variables.md) before changing a wire contract.
