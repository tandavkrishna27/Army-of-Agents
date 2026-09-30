#!/usr/bin/env bash
set -euo pipefail

# rollback-latest.sh — Rollback the latest Changesets-based release.
#
# AoA uses @changesets/cli for releases (see scripts/release.sh), so this
# script deviates from Paperclip's rollback pattern:
#
#   - Paperclip (CalVer, 111 LOC): takes a version arg and repoints npm
#     dist-tag "latest" for each publishable package. Pure tag repointer.
#
#   - AoA (Changesets-adapted): deprecates the current published version
#     via `npm deprecate`, deletes the git tag locally + remotely, and
#     optionally reverts the release commit. No manual package.json /
#     CHANGELOG reversion — that's Changesets' job when the next release
#     bumps past the deprecated version.
#
# Default actions (in order):
#   1. `npm deprecate <pkg>@<package_version>` for each owned public package
#      so the registry surfaces a deprecation warning on install.
#   2. Delete the local git tag (v<current_version>).
#   3. Delete the remote git tag (v<current_version>).
#
# Optional actions (flag-gated):
#   --revert-commit          Additionally `git revert` the release commit
#                            on HEAD (subject: "chore: release vX.Y.Z").
#                            Creates a new commit — does NOT rewrite history.
#   --dry-run                Print all actions without executing.
#   --message <text>         Custom deprecation message. Default:
#                            "Reverted by rollback-latest.sh on <iso-date>".
#   --self-test              Run unit tests on internal helpers and exit.
#
# Usage:
#   ./scripts/rollback-latest.sh                         # deprecate + delete tags
#   ./scripts/rollback-latest.sh --revert-commit
#   ./scripts/rollback-latest.sh --dry-run
#   ./scripts/rollback-latest.sh --message "Broken build"
#   ./scripts/rollback-latest.sh --self-test
#
# Current version is read from cli/package.json (same source of truth
# release.sh uses for $NEW_VERSION after `changeset version`).
#
# Reuses helpers from scripts/release-lib.sh: release_info, release_warn,
# release_fail, git_local_tag_exists, git_remote_tag_exists,
# resolve_release_remote, require_clean_worktree, require_npm_publish_auth.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck source=./release-lib.sh
source "$REPO_ROOT/scripts/release-lib.sh"

# ---------- Helpers (unit-testable via --self-test) ----------

# Read version from cli/package.json (release.sh's source of truth).
# Pure shell — no node dependency, works consistently across MSYS/Linux/macOS.
get_current_version() {
  local pkg_file="${1:-$REPO_ROOT/cli/package.json}"
  [ -f "$pkg_file" ] || release_fail "cannot find $pkg_file"
  local version
  version="$(grep -E '"version"[[:space:]]*:' "$pkg_file" | head -1 \
    | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')"
  [ -n "$version" ] || release_fail "could not parse 'version' field from $pkg_file"
  printf '%s\n' "$version"
}

# Build the display form of an npm deprecate command (for dry-run logging).
# Actual execution uses direct argv, not eval of this string — safer.
build_deprecate_cmd() {
  local pkg="$1"
  local version="$2"
  local message="$3"
  printf "npm deprecate %s@%s '%s'" "$pkg" "$version" "$message"
}

# Build the display form of an npm dist-tag repoint command (for Paperclip-
# style rollback when someone wants to also repoint "latest" to a prior
# version). Not called by default; exposed for manual recovery flows.
build_dist_tag_cmd() {
  local pkg="$1"
  local version="$2"
  printf "npm dist-tag add %s@%s latest" "$pkg" "$version"
}

# ---------- Self-test ----------
run_self_tests() {
  local tmpdir; tmpdir="$(mktemp -d)"
  trap 'rm -rf "$tmpdir"' RETURN

  assert_eq() {
    if [[ "$1" != "$2" ]]; then
      printf 'FAIL: expected "%s", got "%s" (case: %s)\n' "$2" "$1" "$3" >&2
      exit 1
    fi
    printf '  ok  %-55s -> %s\n' "$3" "$1"
  }

  echo "get_current_version:"
  mkdir -p "$tmpdir/cli"
  cat > "$tmpdir/cli/package.json" <<'JSON'
{"name":"@armyofagents/cli","version":"0.2.7"}
JSON
  assert_eq "$(get_current_version "$tmpdir/cli/package.json")" "0.2.7" \
    "reads stable version from fixture"

  cat > "$tmpdir/cli/package.json" <<'JSON'
{"name":"@armyofagents/cli","version":"0.2.7-canary.3"}
JSON
  assert_eq "$(get_current_version "$tmpdir/cli/package.json")" "0.2.7-canary.3" \
    "reads canary version from fixture"

  echo ""
  echo "list_owned_public_packages:"
  local packages pkg_count
  packages="$(list_owned_public_packages)"
  pkg_count="$(printf '%s\n' "$packages" | wc -l | tr -d ' \t')"
  assert_eq "$pkg_count" "17" "discovers all 17 owned public packages"
  assert_eq "$(printf '%s\n' "$packages" | grep -c '^@armyofagents/')" "17" \
    "all packages are @armyofagents/ scoped"
  assert_eq "$(printf '%s\n' "$packages" | grep -c '^@armyofagents/cli$')" "1" \
    "1 CLI package (@armyofagents/cli)"
  assert_eq "$(printf '%s\n' "$packages" | grep -c '^@paperclipai/')" "0" \
    "no upstream-owned packages"
  local package_specs plugin_sdk_version cli_version
  package_specs="$(list_owned_public_packages specs)"
  plugin_sdk_version="$(cd "$REPO_ROOT" && node -p "require('./packages/plugins/sdk/package.json').version")"
  cli_version="$(get_current_version)"
  assert_eq "$(printf '%s\n' "$package_specs" | grep -Fxc "@armyofagents/plugin-sdk@$plugin_sdk_version")" "1" \
    "preserves plugin SDK version"
  assert_eq "$(printf '%s\n' "$package_specs" | grep -Fxc "@armyofagents/cli@$cli_version")" "1" \
    "preserves CLI version"

  echo ""
  echo "build_deprecate_cmd:"
  assert_eq "$(build_deprecate_cmd @armyofagents/server 0.2.7 'Reverted by rollback')" \
    "npm deprecate @armyofagents/server@0.2.7 'Reverted by rollback'" \
    "scoped package"
  assert_eq "$(build_deprecate_cmd @armyofagents/cli 0.2.7 'Reverted by rollback')" \
    "npm deprecate @armyofagents/cli@0.2.7 'Reverted by rollback'" \
    "unscoped CLI package"
  assert_eq "$(build_deprecate_cmd @armyofagents/db 0.2.7-canary.1 'Broken build')" \
    "npm deprecate @armyofagents/db@0.2.7-canary.1 'Broken build'" \
    "canary version"

  echo ""
  echo "build_dist_tag_cmd:"
  assert_eq "$(build_dist_tag_cmd @armyofagents/server 0.2.6)" \
    "npm dist-tag add @armyofagents/server@0.2.6 latest" \
    "dist-tag repoint for scoped pkg"
  assert_eq "$(build_dist_tag_cmd @armyofagents/cli 0.2.6)" \
    "npm dist-tag add @armyofagents/cli@0.2.6 latest" \
    "dist-tag repoint for CLI"

  echo ""
  echo "✓ All rollback-latest self-tests passed"
}

# ---------- Parse args ----------
dry_run=false
revert_commit=false
message=""
self_test=false

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=true ;;
    --revert-commit) revert_commit=true ;;
    --message)
      shift
      [ $# -gt 0 ] || release_fail "--message requires a value"
      message="$1"
      ;;
    --self-test) self_test=true ;;
    -h|--help)
      sed -n '/^# Usage:/,/^# Current/p' "$0"
      exit 0
      ;;
    *) release_fail "unknown argument: $1 (try --help)" ;;
  esac
  shift
done

if [ "$self_test" = true ]; then
  run_self_tests
  exit 0
fi

# ---------- Main flow ----------
release_info "==> AoA rollback-latest.sh (Changesets-adapted)"
release_info ""

current_version="$(get_current_version)"
release_info "  Current version (from cli/package.json): $current_version"

if [ -z "$message" ]; then
  message="Reverted by rollback-latest.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)"
fi
release_info "  Deprecation message: \"$message\""

if [ "$dry_run" = true ]; then
  release_info "  Mode: DRY RUN (no side effects)"
else
  release_info "  Mode: EXECUTE"
fi

# Sanity checks (non-dry-run only)
if [ "$dry_run" = false ]; then
  require_clean_worktree
  require_npm_publish_auth "$dry_run"
fi

# ---------- Step 1: Deprecate published packages ----------
release_info ""
release_info "==> Step 1/3: Deprecate published packages on npm"
while IFS= read -r package_spec; do
  [ -z "$package_spec" ] && continue
  pkg="${package_spec%@*}"
  package_version="${package_spec##*@}"
  display_cmd="$(build_deprecate_cmd "$pkg" "$package_version" "$message")"
  if [ "$dry_run" = true ]; then
    release_info "  [dry-run] $display_cmd"
  else
    release_info "  $display_cmd"
    if ! npm deprecate "$package_spec" "$message"; then
      release_warn "npm deprecate failed for $package_spec (may not be published)"
    fi
  fi
done <<< "$(list_owned_public_packages specs)"

# ---------- Step 2: Delete git tags ----------
release_info ""
release_info "==> Step 2/3: Delete git tags"
tag="v$current_version"

if git_local_tag_exists "$tag"; then
  if [ "$dry_run" = true ]; then
    release_info "  [dry-run] git tag -d $tag"
  else
    git -C "$REPO_ROOT" tag -d "$tag"
    release_info "  ✓ Deleted local tag $tag"
  fi
else
  release_info "  (local tag $tag does not exist — skipping)"
fi

remote="$(resolve_release_remote)"
if [ "$dry_run" = true ]; then
  release_info "  [dry-run] git push $remote :refs/tags/$tag"
else
  if git_remote_tag_exists "$tag" "$remote"; then
    if git -C "$REPO_ROOT" push "$remote" ":refs/tags/$tag"; then
      release_info "  ✓ Deleted remote tag $tag on $remote"
    else
      release_warn "failed to delete remote tag on $remote"
    fi
  else
    release_info "  (remote tag $tag does not exist on $remote — skipping)"
  fi
fi

# ---------- Step 3: Optional git revert ----------
release_info ""
if [ "$revert_commit" = true ]; then
  release_info "==> Step 3/3: Revert release commit"
  head_subj="$(git -C "$REPO_ROOT" log -1 --format=%s)"
  expected_subj="chore: release v$current_version"
  if [[ "$head_subj" == "$expected_subj" ]]; then
    if [ "$dry_run" = true ]; then
      release_info "  [dry-run] git revert --no-edit HEAD"
    else
      git -C "$REPO_ROOT" revert --no-edit HEAD
      release_info "  ✓ Reverted release commit (new commit created — history preserved)"
    fi
  else
    release_warn "HEAD subject is '$head_subj', expected '$expected_subj' — skipping revert."
    release_warn "If the release commit is elsewhere, run 'git revert <sha>' manually."
  fi
else
  release_info "==> Step 3/3: --revert-commit not specified — skipping git revert"
fi

# ---------- Done ----------
release_info ""
if [ "$dry_run" = true ]; then
  release_info "Dry run complete. Rerun without --dry-run to execute."
else
  release_info "✓ Rollback complete for v$current_version"
  release_info ""
  release_info "Next steps:"
  release_info "  - Verify deprecation: npm view @armyofagents/cli@$current_version deprecated"
  release_info "  - Investigate what went wrong before the next release"
  if [ "$revert_commit" = true ]; then
    release_info "  - Push the revert commit: git push $remote"
  fi
fi
