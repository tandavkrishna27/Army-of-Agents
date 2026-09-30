# Plugin Authoring Smoke Example

An AoA plugin

## Development

```bash
pnpm install
pnpm dev            # watch builds
pnpm dev:ui         # local dev server with hot-reload events
pnpm test
```

## Install Into AoA

```bash
pnpm aoa plugin install ./
```

## Build Options

- `pnpm build` uses esbuild presets from `@armyofagents/plugin-sdk/bundlers`.
- `pnpm build:rollup` uses rollup presets from the same SDK.
