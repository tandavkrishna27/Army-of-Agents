# AoA cloud-execution-isolation sandbox template ("aoa-base").
#
# The default E2B `base` template is bare, so the CLIs AoA runs inside the
# sandbox (`claude`, `codex`) are not present — a run/probe fails with
# `env: 'claude': No such file or directory`. This template pre-installs them so
# every sandboxed run (org/crew agents, readiness probes, discussion/file-import
# extraction, Commander compaction) starts with the CLIs already on PATH — no
# per-run `npm install -g`, so sandboxes are fast.
#
# Build + register on your E2B account, then set E2B_TEMPLATE=aoa-base on the
# instance (see e2b/README.md). Debian-based (node:22) → E2B-compatible; E2B
# injects its own envd on top.
FROM node:22

# Tooling the agent CLIs + software-development workspaces need. ripgrep is used
# by claude-code; git/curl/ca-certificates for repo + network ops; python3 +
# build-essential for native deps and software-dev agents.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      curl \
      ca-certificates \
      ripgrep \
      python3 \
      python3-pip \
      build-essential \
    && rm -rf /var/lib/apt/lists/*

# The EXACT packages the AoA adapters install at spawn on the bare template
# (server/src/adapters/registry.ts → SANDBOX_INSTALL_COMMAND):
#   claude_local: npm install -g @anthropic-ai/claude-code   (command: claude)
#   codex_local:  npm install -g @openai/codex               (command: codex)
RUN npm install -g @anthropic-ai/claude-code @openai/codex

# Fail the build if either CLI is not resolvable — the whole point of the
# template. AoA's detectCommand is `command -v claude` / `command -v codex`.
RUN command -v claude && command -v codex && claude --version && codex --version
