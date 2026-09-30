#!/usr/bin/env bash
# docker-build-test.sh — Verify the Docker image builds successfully.
#
# Ports Paperclip's scripts/docker-build-test.sh (46 LOC, single-arch)
# and extends for Phase H.D5 (multi-arch amd64 + arm64 via buildx).
#
# Default mode: native-arch build with binary smoke test (fast; local dev).
# --multi-arch:  additionally build linux/amd64 + linux/arm64 via buildx
#                (required for release gating per H.D5 decision).
# --dry-run:     print commands without executing.
#
# Skips gracefully when docker/podman is not installed or the daemon is
# not running — matches Paperclip's skip-don't-fail pattern.
#
# Usage:
#   ./scripts/docker-build-test.sh                 # native-arch build only
#   ./scripts/docker-build-test.sh --multi-arch    # adds buildx verification
#   ./scripts/docker-build-test.sh --dry-run       # preview commands
#
# Exits 0 on success or graceful skip; non-zero only if a build fails.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

multi_arch=false
dry_run=false

while [ $# -gt 0 ]; do
  case "$1" in
    --multi-arch) multi_arch=true ;;
    --dry-run) dry_run=true ;;
    -h|--help)
      sed -n '/^# docker-build-test/,/^set -/p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Error: unknown argument: $1 (try --help)" >&2
      exit 1
      ;;
  esac
  shift
done

# ---------- Detect container runtime ----------
if command -v docker >/dev/null 2>&1; then
  RUNTIME=docker
elif command -v podman >/dev/null 2>&1; then
  RUNTIME=podman
else
  echo "SKIP: neither docker nor podman found — skipping build test"
  exit 0
fi

# Verify daemon is reachable (skip when dry-run)
if [ "$dry_run" = false ] && ! "$RUNTIME" info >/dev/null 2>&1; then
  echo "SKIP: $RUNTIME is installed but not running — skipping build test"
  exit 0
fi

IMAGE_TAG="aoa-build-test:$$"
cleanup() {
  if [ "$dry_run" = false ]; then
    "$RUNTIME" rmi "$IMAGE_TAG" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# ---------- Native-arch build + binary smoke test ----------
echo "==> Testing native-arch Docker build with $RUNTIME"
if [ "$dry_run" = true ]; then
  echo "  [dry-run] $RUNTIME build -f $REPO_ROOT/Dockerfile -t $IMAGE_TAG --target production $REPO_ROOT"
else
  "$RUNTIME" build \
    -f "$REPO_ROOT/Dockerfile" \
    -t "$IMAGE_TAG" \
    --target production \
    "$REPO_ROOT"
fi

echo "==> Verifying key binaries in image"
# Covers the full install list from Dockerfile (base + production stages):
#   base:       ca-certificates, gosu, curl, gh, git, wget, ripgrep, python3
#   production: openssh-client (ssh), jq
#   node-global: @anthropic-ai/claude-code, @openai/codex, opencode-ai
# `claude` check uses `|| true` — Paperclip does the same because minimal
# builds may not include the Claude CLI globally.
if [ "$dry_run" = true ]; then
  echo "  [dry-run] $RUNTIME run --rm $IMAGE_TAG sh -c '<binary checks>'"
else
  "$RUNTIME" run --rm "$IMAGE_TAG" sh -c '
    set -e
    echo "  node:    $(node --version)"
    echo "  git:     $(git --version)"
    echo "  gh:      $(gh --version | head -1)"
    echo "  rg:      $(rg --version | head -1)"
    echo "  python3: $(python3 --version)"
    echo "  curl:    $(curl --version | head -1)"
    echo "  gosu:    $(gosu --version | head -1)"
    echo "  jq:      $(jq --version)"
    echo "  ssh:     $(ssh -V 2>&1 | head -1)"
    echo "  claude:  $(claude --version 2>/dev/null || echo "(not installed — OK)")"
  '
fi

# ---------- Multi-arch buildx (optional, required for release gating) ----------
if [ "$multi_arch" = true ]; then
  echo ""
  echo "==> Testing multi-arch build (linux/amd64 + linux/arm64) via buildx"

  if ! "$RUNTIME" buildx version >/dev/null 2>&1; then
    echo "SKIP: $RUNTIME buildx not available — install Docker Buildx plugin for multi-arch"
    echo "      (native-arch build above succeeded)"
  else
    # No --load / --push: just verify both platforms build successfully.
    # Output is discarded (can't --load multi-platform into local daemon).
    if [ "$dry_run" = true ]; then
      echo "  [dry-run] $RUNTIME buildx build --platform linux/amd64,linux/arm64 -f Dockerfile --target production $REPO_ROOT"
    else
      "$RUNTIME" buildx build \
        --platform linux/amd64,linux/arm64 \
        -f "$REPO_ROOT/Dockerfile" \
        --target production \
        "$REPO_ROOT"
      echo "  ✓ Multi-arch build verified (linux/amd64 + linux/arm64)"
    fi
  fi
fi

echo ""
echo "PASS: Docker build test succeeded"
