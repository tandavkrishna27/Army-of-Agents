#!/usr/bin/env bash
set -Eeuo pipefail

[[ $# -eq 1 ]] || {
  echo "::error::usage: verify-testing-revision.sh <deploy-sha>" >&2
  exit 2
}

readonly DEPLOY_SHA="$1"

[[ "$DEPLOY_SHA" =~ ^[0-9a-f]{40}$ ]] || {
  echo "::error::Deployment SHA is not 40 lowercase hex characters" >&2
  exit 1
}

resolved_sha="$(
  gh api "repos/$GITHUB_REPOSITORY/commits/$DEPLOY_SHA" --jq '.sha'
)" || {
  echo "::error::Deployment SHA does not identify a repository commit" >&2
  exit 1
}
[[ "$resolved_sha" == "$DEPLOY_SHA" ]] || {
  echo "::error::Repository resolved a different deployment SHA" >&2
  exit 1
}

relationship="$(
  gh api \
    "repos/$GITHUB_REPOSITORY/compare/$DEPLOY_SHA...main" \
    --jq '.status'
)" || {
  echo "::error::Could not compare the deployment SHA with main" >&2
  exit 1
}
[[ "$relationship" == "ahead" || "$relationship" == "identical" ]] || {
  echo "::error::Deployment SHA is not an ancestor of origin/main" >&2
  exit 1
}

conclusion="$(
  gh api \
    "repos/$GITHUB_REPOSITORY/commits/$DEPLOY_SHA/check-runs?filter=latest&per_page=100" \
    --jq '[.check_runs[]
      | select(.name == "ci-required" and .app.slug == "github-actions")]
      | sort_by(.id)
      | last
      | .conclusion // ""'
)"
[[ "$conclusion" == "success" ]] || {
  echo "::error::Required ci-required check is not successful for $DEPLOY_SHA (found: ${conclusion:-missing})" >&2
  exit 1
}
