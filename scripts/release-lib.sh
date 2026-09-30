#!/usr/bin/env bash

# release-lib.sh — shared utilities for AoA release scripts.
#
# Ported from Paperclip scripts/release-lib.sh (306 LOC, CalVer) with the
# following AoA-specific adaptations for SemVer (Phase H decision D2):
#
#   - compute_next_version() replaces Paperclip's next_stable_version() +
#     next_canary_version() (both CalVer, both shelled to node + npm view).
#     AoA's implementation is shell-only and deterministic from inputs —
#     no registry round-trip needed because SemVer increments are algorithmic.
#
#   - stable_version_slot_for_date() + utc_date_iso() removed entirely
#     (CalVer-only: derived today's date into "YYYY.MDD" slot).
#
#   - canary_tag_name() rewritten: Paperclip tags canaries as
#     "canary/v{base}" because CalVer canaries share the stable base string.
#     AoA embeds "-canary.N" directly in the SemVer pre-release suffix, so
#     both channels use the same "v{version}" tag form (v0.1.0-canary.1).
#
#   - require_on_master_branch() renamed to require_on_release_branch()
#     and parameterized. AoA currently releases off Porting1.1; will be
#     main post-Phase H merge.
#
#   - get_last_stable_tag() filters out canary tags (Paperclip's CalVer
#     canary tags live under refs/tags/canary/* so they were naturally
#     excluded by the "v*" glob — AoA's canary tags match "v*" too).
#
#   - list_public_package_info() + set_public_package_version() NOT PORTED
#     in this session — they depend on scripts/release-package-map.mjs
#     which does not yet exist in AoA. Session 66 (release.sh port) will
#     decide whether to port that map or inline equivalent logic.
#
# Run `./scripts/release-lib.sh --self-test` to verify compute_next_version.

if [ -z "${REPO_ROOT:-}" ]; then
  REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

# ---------- logging ----------
release_info() {
  echo "$@"
}

release_warn() {
  echo "Warning: $*" >&2
}

release_fail() {
  echo "Error: $*" >&2
  exit 1
}

# ---------- git remote helpers ----------
git_remote_exists() {
  git -C "$REPO_ROOT" remote get-url "$1" >/dev/null 2>&1
}

github_repo_from_remote() {
  local remote_url

  remote_url="$(git -C "$REPO_ROOT" remote get-url "$1" 2>/dev/null || true)"
  [ -n "$remote_url" ] || return 1

  remote_url="${remote_url%.git}"
  remote_url="${remote_url#ssh://}"

  node - "$remote_url" <<'NODE'
const remoteUrl = process.argv[2];

const patterns = [
  /^https?:\/\/github\.com\/([^/]+\/[^/]+)$/,
  /^git@github\.com:([^/]+\/[^/]+)$/,
  /^[^:]+:([^/]+\/[^/]+)$/
];

for (const pattern of patterns) {
  const match = remoteUrl.match(pattern);
  if (!match) continue;
  process.stdout.write(match[1]);
  process.exit(0);
}

process.exit(1);
NODE
}

resolve_release_remote() {
  local remote="${RELEASE_REMOTE:-${PUBLISH_REMOTE:-}}"

  if [ -n "$remote" ]; then
    git_remote_exists "$remote" || release_fail "git remote '$remote' does not exist."
    printf '%s\n' "$remote"
    return
  fi

  if git_remote_exists public-gh; then
    printf 'public-gh\n'
    return
  fi

  if git_remote_exists public; then
    printf 'public\n'
    return
  fi

  if git_remote_exists origin; then
    printf 'origin\n'
    return
  fi

  release_fail "no git remote found. Configure RELEASE_REMOTE or PUBLISH_REMOTE."
}

fetch_release_remote() {
  git -C "$REPO_ROOT" fetch "$1" --prune --tags
}

# ---------- git branch/tag helpers ----------
git_current_branch() {
  git -C "$REPO_ROOT" symbolic-ref --quiet --short HEAD 2>/dev/null || true
}

git_local_tag_exists() {
  git -C "$REPO_ROOT" show-ref --verify --quiet "refs/tags/$1"
}

git_remote_tag_exists() {
  git -C "$REPO_ROOT" ls-remote --exit-code --tags "$2" "refs/tags/$1" >/dev/null 2>&1
}

# AoA deviation: filter out "-canary." pre-releases. Paperclip's CalVer canaries
# lived under canary/v* (a separate ref namespace), so "v*" implicitly excluded
# them. AoA canary tags match the "v*" glob, so we filter explicitly here.
get_last_stable_tag() {
  git -C "$REPO_ROOT" tag --list 'v*' --sort=-version:refname \
    | grep -v -- '-canary\.' \
    | head -1
}

get_current_stable_version() {
  local tag
  tag="$(get_last_stable_tag)"
  if [ -z "$tag" ]; then
    printf '0.0.0\n'
  else
    printf '%s\n' "${tag#v}"
  fi
}

# ---------- SemVer version computation (AoA rewrite) ----------
#
# compute_next_version <current> <bump> <channel>
#
#   current: current version string — "0.1.0" or "0.1.0-canary.3"
#   bump:    patch | minor | major
#   channel: stable | canary
#
# Replaces Paperclip's next_stable_version() + next_canary_version(), both of
# which were CalVer (date-slot) and queried npm for the max existing suffix.
# SemVer is deterministic, so we can compute everything from the current
# version string.
#
# Rules:
#   1. If current is a canary AND channel is canary, keep the base and
#      increment the pre-release counter. This is the "iterate on an
#      in-flight canary" case.
#        0.1.1-canary.1 + <any-bump> + canary  ->  0.1.1-canary.2
#
#   2. Otherwise, strip any canary suffix, apply the bump to the base, and
#      attach the channel suffix. This handles:
#        - Starting a fresh canary off stable:
#            0.1.0 + patch + canary  ->  0.1.1-canary.1
#        - Promoting a canary to stable with (or without) a bump:
#            0.1.0-canary.3 + patch + stable  ->  0.1.1
#            0.1.1-canary.2 + minor + stable  ->  0.2.0
#        - Stable-to-stable bumps:
#            0.1.0 + major + stable  ->  1.0.0
#
# Self-test cases live at the bottom of this file.
compute_next_version() {
  local current="$1"
  local bump="$2"
  local channel="$3"

  local base canary_n is_canary
  if [[ "$current" =~ ^([0-9]+\.[0-9]+\.[0-9]+)-canary\.([0-9]+)$ ]]; then
    base="${BASH_REMATCH[1]}"
    canary_n="${BASH_REMATCH[2]}"
    is_canary=true
  elif [[ "$current" =~ ^([0-9]+\.[0-9]+\.[0-9]+)$ ]]; then
    base="${BASH_REMATCH[1]}"
    canary_n=0
    is_canary=false
  else
    release_fail "invalid SemVer version '$current' (expected MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-canary.N)"
  fi

  # Rule 1: iterate in-flight canary.
  if [[ "$is_canary" == true && "$channel" == "canary" ]]; then
    printf '%s-canary.%d\n' "$base" "$((canary_n + 1))"
    return
  fi

  # Rule 2: apply bump to base, then apply channel.
  local major minor patch
  IFS='.' read -r major minor patch <<< "$base"
  case "$bump" in
    patch) patch=$((patch + 1)) ;;
    minor) minor=$((minor + 1)); patch=0 ;;
    major) major=$((major + 1)); minor=0; patch=0 ;;
    *) release_fail "invalid bump mode '$bump' (expected patch | minor | major)" ;;
  esac
  local next_base="${major}.${minor}.${patch}"

  case "$channel" in
    stable) printf '%s\n' "$next_base" ;;
    canary) printf '%s-canary.1\n' "$next_base" ;;
    *) release_fail "invalid channel '$channel' (expected stable | canary)" ;;
  esac
}

# ---------- release notes + tag naming ----------
release_notes_file() {
  printf '%s/releases/v%s.md\n' "$REPO_ROOT" "$1"
}

stable_tag_name() {
  printf 'v%s\n' "$1"
}

# AoA deviation: Paperclip used "canary/v{base}" so CalVer canaries wouldn't
# collide with the stable tag sharing the same base string. SemVer embeds
# "-canary.N" in the version itself, so both channels use "v{version}".
canary_tag_name() {
  printf 'v%s\n' "$1"
}

# ---------- npm helpers ----------
list_owned_public_packages() {
  local output="${1:-names}"

  (
    cd "$REPO_ROOT"
    pnpm -r list --depth -1 --json | node -e "
const { readFileSync } = require('fs');
const { join, relative, sep } = require('path');
const output = process.argv[1];
const packages = JSON.parse(readFileSync(0, 'utf8'))
  .filter((pkg) => pkg.private === false && pkg.name.startsWith('@armyofagents/'));

if (output === 'specs') {
  console.log(packages.map((pkg) => pkg.name + '@' + pkg.version).join('\n'));
} else if (output === 'names') {
  console.log(packages.map((pkg) => pkg.name).join('\n'));
} else if (output === 'skill-paths') {
  console.log(packages
    .filter((pkg) => {
      const manifest = JSON.parse(readFileSync(join(pkg.path, 'package.json'), 'utf8'));
      return Array.isArray(manifest.files) && manifest.files.includes('skills');
    })
    .map((pkg) => relative(process.cwd(), pkg.path).split(sep).join('/'))
    .join('\n'));
} else {
  throw new Error('unknown package-list output: ' + output);
}
" "$output"
  )
}

npm_package_version_exists() {
  local package_name="$1"
  local version="$2"
  local resolved

  resolved="$(npm view "${package_name}@${version}" version 2>/dev/null || true)"
  [ "$resolved" = "$version" ]
}

wait_for_npm_package_version() {
  local package_name="$1"
  local version="$2"
  local attempts="${3:-12}"
  local delay_seconds="${4:-5}"
  local attempt=1

  while [ "$attempt" -le "$attempts" ]; do
    if npm_package_version_exists "$package_name" "$version"; then
      return 0
    fi

    if [ "$attempt" -lt "$attempts" ]; then
      sleep "$delay_seconds"
    fi
    attempt=$((attempt + 1))
  done

  return 1
}

# ---------- validators ----------
require_clean_worktree() {
  if [ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]; then
    release_fail "working tree is not clean. Commit, stash, or remove changes before releasing."
  fi
}

# AoA deviation: Paperclip hardcoded "master". AoA releases from Porting1.1
# during the port; main post-Phase H merge. Caller specifies the expected
# branch (defaults to "main").
require_on_release_branch() {
  local expected_branch="${1:-main}"
  local current_branch
  current_branch="$(git_current_branch)"
  if [ "$current_branch" != "$expected_branch" ]; then
    release_fail "this release step must run from branch '${expected_branch}', but current branch is ${current_branch:-<detached>}."
  fi
}

require_npm_publish_auth() {
  local dry_run="$1"

  if [ "$dry_run" = true ]; then
    return
  fi

  if npm whoami >/dev/null 2>&1; then
    release_info "  ✓ Logged in to npm as $(npm whoami)"
    return
  fi

  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    release_info "  ✓ npm publish auth will be provided by GitHub Actions trusted publishing"
    return
  fi

  release_fail "npm publish auth is not available. Use 'npm login' locally or run from GitHub Actions with trusted publishing."
}

# ---------- self-test ----------
# Run with: ./scripts/release-lib.sh --self-test
# Only triggers when invoked directly; does nothing when sourced as a library.
# BASH_SOURCE[0] == $0 when invoked directly; they differ when sourced.
if [[ "${BASH_SOURCE[0]}" == "${0}" && "${1:-}" == "--self-test" ]]; then
  set -e

  assert_eq() {
    if [[ "$1" != "$2" ]]; then
      printf 'FAIL: expected "%s", got "%s" (case: %s)\n' "$2" "$1" "$3" >&2
      exit 1
    fi
    printf '  ok  %-48s -> %s\n' "$3" "$1"
  }

  echo "compute_next_version (SemVer):"
  assert_eq "$(compute_next_version 0.1.0 patch stable)"            "0.1.1"            "0.1.0 + patch + stable"
  assert_eq "$(compute_next_version 0.1.0 patch canary)"            "0.1.1-canary.1"   "0.1.0 + patch + canary"
  assert_eq "$(compute_next_version 0.1.1-canary.1 patch canary)"   "0.1.1-canary.2"   "0.1.1-canary.1 + patch + canary"
  assert_eq "$(compute_next_version 0.1.1-canary.2 minor stable)"   "0.2.0"            "0.1.1-canary.2 + minor + stable"
  assert_eq "$(compute_next_version 0.1.0 major stable)"            "1.0.0"            "0.1.0 + major + stable"
  assert_eq "$(compute_next_version 0.1.0-canary.3 patch stable)"   "0.1.1"            "0.1.0-canary.3 + patch + stable (promote w/ bump)"
  assert_eq "$(compute_next_version 0.2.0 minor canary)"            "0.3.0-canary.1"   "0.2.0 + minor + canary (fresh canary)"
  assert_eq "$(compute_next_version 1.2.3-canary.9 patch canary)"   "1.2.3-canary.10"  "1.2.3-canary.9 + patch + canary (two-digit N)"
  assert_eq "$(compute_next_version 0.0.0 patch stable)"            "0.0.1"            "0.0.0 + patch + stable (bootstrap)"
  assert_eq "$(compute_next_version 9.9.9 major stable)"            "10.0.0"           "9.9.9 + major + stable (major carry)"

  echo ""
  echo "tag naming:"
  assert_eq "$(stable_tag_name 0.1.0)"                 "v0.1.0"           "stable_tag_name 0.1.0"
  assert_eq "$(canary_tag_name 0.1.0-canary.1)"        "v0.1.0-canary.1"  "canary_tag_name 0.1.0-canary.1"

  echo ""
  echo "✓ All self-tests passed"
  exit 0
fi
