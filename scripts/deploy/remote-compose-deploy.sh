#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

die() {
  printf 'deploy: %s\n' "$*" >&2
  exit 1
}

log() {
  printf 'deploy: %s\n' "$*" >&2
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "missing command: $1"
}

[[ $# -eq 4 ]] ||
  die "usage: remote-compose-deploy.sh <sha> <archive> <sha256> <env-file>"

readonly DEPLOY_SHA="$1"
readonly ARCHIVE_PATH="$2"
readonly EXPECTED_SHA256="$3"
readonly CANDIDATE_ENV_PATH="$4"

DEPLOY_ROOT="${AOA_DEPLOY_ROOT:-/opt/aoa}"
while [[ "$DEPLOY_ROOT" != "/" && "$DEPLOY_ROOT" == */ ]]; do
  DEPLOY_ROOT="${DEPLOY_ROOT%/}"
done
readonly DEPLOY_ROOT

PUBLIC_URL="${AOA_DEPLOY_PUBLIC_URL:-https://testing.armyofagents.org}"
readonly PUBLIC_URL_PATTERN='^https?://[^/?#[:space:][:cntrl:]]+(/[^?#[:space:][:cntrl:]]*)?$'
readonly RELEASES_DIR="$DEPLOY_ROOT/releases"
readonly INCOMING_DIR="$DEPLOY_ROOT/incoming"
readonly SHARED_DIR="$DEPLOY_ROOT/shared"
readonly SHARED_ENV="$SHARED_DIR/.env"
readonly CURRENT_LINK="$DEPLOY_ROOT/current"
readonly RELEASE_DIR="$RELEASES_DIR/$DEPLOY_SHA"
readonly RELEASE_TMP="$RELEASES_DIR/.$DEPLOY_SHA.tmp.$$"
readonly NEXT_LINK="$DEPLOY_ROOT/.current.$DEPLOY_SHA.$$"
readonly RESTORE_LINK="$DEPLOY_ROOT/.current.restore.$DEPLOY_SHA.$$"

ENV_SWAPPED=false
HAD_PREVIOUS_ENV=false
PROMOTED=false
MUTATION_STARTED=false
PREVIOUS_RELEASE=""
PREVIOUS_LINK_TARGET=""
DEPLOY_ROOT_REAL=""
INCOMING_REAL=""
STAGE_DIR=""
WORK_DIR=""
WORK_DIR_REAL=""
PRIVATE_ARCHIVE=""
PRIVATE_ENV=""
ENV_BACKUP=""
ARCHIVE_MEMBERS=""
ARCHIVE_TYPES=""
SCRIPT_REAL=""
SHARED_ENV_NEXT=""
SHARED_ENV_RESTORE=""

[[ "$DEPLOY_SHA" =~ ^[0-9a-f]{40}$ ]] ||
  die "deployment SHA must be 40 lowercase hex characters"
[[ "$EXPECTED_SHA256" =~ ^[0-9a-f]{64}$ ]] ||
  die "archive checksum must be 64 lowercase hex characters"
[[ -n "$DEPLOY_ROOT" && "$DEPLOY_ROOT" == /* && "$DEPLOY_ROOT" != "/" ]] ||
  die "deployment root must be a non-root absolute path"
case "$DEPLOY_ROOT/" in
  *"/../"* | *"/./"*)
    die "deployment root must be a non-root absolute path"
    ;;
esac
[[ "$PUBLIC_URL" =~ $PUBLIC_URL_PATTERN ]] ||
  die "public URL must be an HTTP(S) URL without controls, query, or fragment"
while [[ "$PUBLIC_URL" == */ ]]; do
  PUBLIC_URL="${PUBLIC_URL%/}"
done
readonly PUBLIC_URL

compose_release() {
  local release="$1"
  local image_sha="$2"
  shift 2
  AOA_IMAGE="aoa:$image_sha" \
    AOA_IMAGE_REVISION="$image_sha" \
    AOA_DEPLOY_SHA="$image_sha" \
    docker compose \
    --env-file "$SHARED_ENV" \
    --project-directory "$release" \
    -f "$release/docker-compose.yml" \
    "$@"
}

verify_release_health() {
  local release="$1"
  local image_sha="$2"
  local verification_mode="${3:-strict}"
  local expected_image_id
  local running_container_id
  local running_image_id
  local image_revision
  local local_health
  local public_health

  expected_image_id="$(
    docker image inspect --format '{{.Id}}' "aoa:$image_sha"
  )" || {
    log "could not inspect expected image aoa:$image_sha"
    return 1
  }
  running_container_id="$(
    compose_release "$release" "$image_sha" ps --quiet server
  )" || {
    log "could not identify the running server container"
    return 1
  }
  [[ -n "$running_container_id" ]] || {
    log "the release has no running server container"
    return 1
  }
  running_image_id="$(
    docker inspect --format '{{.Image}}' "$running_container_id"
  )" || {
    log "could not inspect the running server container"
    return 1
  }
  [[ "$running_image_id" == "$expected_image_id" ]] || {
    log "running server image does not match aoa:$image_sha"
    return 1
  }

  local_health="$(
    curl --fail --silent --show-error \
      --retry 12 --retry-all-errors --retry-delay 5 --max-time 15 \
      -- http://127.0.0.1:3100/api/health
  )" || {
    log "local release health check failed"
    return 1
  }
  public_health="$(
    curl --fail --silent --show-error \
      --retry 12 --retry-all-errors --retry-delay 5 --max-time 15 \
      -- "$PUBLIC_URL/api/health"
  )" || {
    log "public release health check failed"
    return 1
  }

  image_revision="$(
    docker image inspect \
      --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
      "aoa:$image_sha"
  )" || {
    log "could not inspect the image revision label"
    return 1
  }
  if [[ -z "$image_revision" ||
    "$image_revision" == "<no value>" ||
    "$image_revision" == "unknown" ]]; then
    if [[ "$verification_mode" != "legacy-rollback" ||
      -z "$PREVIOUS_RELEASE" ||
      "$release" != "$PREVIOUS_RELEASE" ||
      "$image_sha" != "$(basename -- "$PREVIOUS_RELEASE")" ]]; then
      log "image aoa:$image_sha does not provide revision evidence"
      return 1
    fi
    if grep -Fq -- '"revision":' <<<"$local_health" ||
      grep -Fq -- '"revision":' <<<"$public_health"; then
      log "legacy rollback has partial or conflicting revision evidence"
      return 1
    fi
    log "legacy rollback restored the selected previous image without certified revision evidence"
    return 0
  fi
  [[ "$image_revision" == "$image_sha" ]] || {
    log "image revision label does not match $image_sha"
    return 1
  }
  grep -Fq -- "\"revision\":\"$image_sha\"" <<<"$local_health" || {
    log "local health response does not report revision $image_sha"
    return 1
  }
  grep -Fq -- "\"revision\":\"$image_sha\"" <<<"$public_health" || {
    log "public health response does not report revision $image_sha"
    return 1
  }
}

ensure_fixed_directory() {
  local path="$1"
  local label="$2"
  local canonical

  if [[ -L "$path" || ( -e "$path" && ! -d "$path" ) ]]; then
    die "$label directory must be a real directory"
  fi
  if [[ ! -e "$path" ]]; then
    mkdir -m 700 -- "$path"
  fi
  [[ -d "$path" && ! -L "$path" ]] ||
    die "$label directory must be a real directory"
  canonical="$(realpath -e -- "$path")"
  [[ "$(dirname -- "$canonical")" == "$DEPLOY_ROOT_REAL" ]] ||
    die "$label directory escaped the deployment root"
  chmod 700 -- "$path"
}

validate_private_file() {
  local path="$1"
  local label="$2"
  local canonical

  [[ -f "$path" && ! -L "$path" ]] ||
    die "$label must be a private regular file"
  canonical="$(realpath -e -- "$path")"
  [[ "$canonical" == "$path" &&
    "$(dirname -- "$canonical")" == "$WORK_DIR_REAL" ]] ||
    die "$label escaped the private deployment work directory"
  chmod 600 -- "$path"
}

create_private_workdir() {
  WORK_DIR="$(mktemp -d "$DEPLOY_ROOT/.deploy-work.$DEPLOY_SHA.XXXXXX")"
  [[ -d "$WORK_DIR" && ! -L "$WORK_DIR" ]] ||
    die "could not create a private deployment work directory"
  chmod 700 -- "$WORK_DIR"
  WORK_DIR_REAL="$(realpath -e -- "$WORK_DIR")"
  [[ "$WORK_DIR_REAL" == "$WORK_DIR" &&
    "$(dirname -- "$WORK_DIR_REAL")" == "$DEPLOY_ROOT_REAL" ]] ||
    die "private deployment work directory escaped the deployment root"

  PRIVATE_ARCHIVE="$WORK_DIR/source.tar.gz"
  PRIVATE_ENV="$WORK_DIR/candidate.env"
  install -m 600 -- "$ARCHIVE_PATH" "$PRIVATE_ARCHIVE"
  install -m 600 -- "$CANDIDATE_ENV_PATH" "$PRIVATE_ENV"
  validate_private_file "$PRIVATE_ARCHIVE" "private archive snapshot"
  validate_private_file "$PRIVATE_ENV" "private environment snapshot"

  ENV_BACKUP="$WORK_DIR/previous.env"
  ARCHIVE_MEMBERS="$(mktemp "$WORK_DIR/archive-members.XXXXXX")"
  ARCHIVE_TYPES="$(mktemp "$WORK_DIR/archive-types.XXXXXX")"
  validate_private_file "$ARCHIVE_MEMBERS" "archive member metadata"
  validate_private_file "$ARCHIVE_TYPES" "archive type metadata"
}

validate_release_marker() {
  local release="$1"
  local label="$2"
  local required_checksum="${3:-}"
  local marker="$release/.aoa-release"
  local marker_text
  local marker_sha
  local marker_checksum
  local release_sha
  local marker_pattern='^([0-9a-f]{40}) ([0-9a-f]{64})$'
  local -a marker_lines=()

  [[ -f "$marker" && ! -L "$marker" ]] ||
    die "$label marker must be a regular file"
  mapfile -t marker_lines <"$marker"
  [[ ${#marker_lines[@]} -eq 1 ]] || die "$label marker is invalid"
  marker_text="${marker_lines[0]}"
  [[ "$marker_text" =~ $marker_pattern ]] ||
    die "$label marker is invalid"
  marker_sha="${BASH_REMATCH[1]}"
  marker_checksum="${BASH_REMATCH[2]}"
  release_sha="$(basename -- "$release")"
  [[ "$marker_sha" == "$release_sha" ]] ||
    die "$label marker is invalid"
  if [[ -n "$required_checksum" && "$marker_checksum" != "$required_checksum" ]]; then
    die "$label marker does not match the archive checksum"
  fi
}

validate_archive_members() {
  local member
  local normalized
  local details
  local entry_type
  local member_count
  local type_count

  LC_ALL=C tar --list --gzip --absolute-names --quoting-style=escape \
    --file "$PRIVATE_ARCHIVE" >"$ARCHIVE_MEMBERS"
  LC_ALL=C tar --list --verbose --gzip --absolute-names --quoting-style=escape \
    --file "$PRIVATE_ARCHIVE" >"$ARCHIVE_TYPES"
  validate_private_file "$ARCHIVE_MEMBERS" "archive member metadata"
  validate_private_file "$ARCHIVE_TYPES" "archive type metadata"

  member_count="$(awk 'END { print NR }' "$ARCHIVE_MEMBERS")"
  type_count="$(awk 'END { print NR }' "$ARCHIVE_TYPES")"
  [[ "$member_count" == "$type_count" ]] ||
    die "archive member listing is inconsistent"

  while IFS= read -r member || [[ -n "$member" ]]; do
    [[ "$member" != *\\* ]] || die "archive member path is unsafe"
    normalized="$member"
    while [[ "$normalized" == "./"* ]]; do
      normalized="${normalized#./}"
    done
    normalized="${normalized%/}"
    [[ -n "$normalized" ]] || continue
    [[ "$normalized" != /* ]] || die "archive member path is unsafe"
    case "/$normalized/" in
      *"/../"* | *"/./"* | *"//"*)
        die "archive member path is unsafe"
        ;;
    esac
    [[ "$normalized" != ".aoa-release" ]] ||
      die "archive must not contain .aoa-release"
  done <"$ARCHIVE_MEMBERS"

  while IFS= read -r details || [[ -n "$details" ]]; do
    entry_type="${details:0:1}"
    case "$entry_type" in
      - | d) ;;
      *) die "archive links and special files are not allowed" ;;
    esac
  done <"$ARCHIVE_TYPES"
}

restore_environment() {
  "$ENV_SWAPPED" || return 0

  if "$HAD_PREVIOUS_ENV"; then
    SHARED_ENV_RESTORE="$(mktemp "$SHARED_DIR/.env.restore.$DEPLOY_SHA.XXXXXX")"
    if ! install -m 600 -- "$ENV_BACKUP" "$SHARED_ENV_RESTORE"; then
      log "failed to prepare the previous environment for restoration"
      return 1
    fi
    if ! mv -f -- "$SHARED_ENV_RESTORE" "$SHARED_ENV"; then
      log "failed to restore the previous environment"
      return 1
    fi
    SHARED_ENV_RESTORE=""
  else
    if ! rm -f -- "$SHARED_ENV"; then
      log "failed to remove the first-deploy candidate environment"
      return 1
    fi
  fi
  [[ -z "$SHARED_ENV_NEXT" ]] || rm -f -- "$SHARED_ENV_NEXT"
  [[ -z "$SHARED_ENV_RESTORE" ]] || rm -f -- "$SHARED_ENV_RESTORE"
}

diagnostics() {
  [[ -f "$RELEASE_DIR/docker-compose.yml" && -f "$SHARED_ENV" ]] || return 0
  compose_release "$RELEASE_DIR" "$DEPLOY_SHA" ps || true
  compose_release "$RELEASE_DIR" "$DEPLOY_SHA" \
    logs --no-color --tail 200 server db || true
}

rollback_previous() {
  if [[ -z "$PREVIOUS_RELEASE" ]]; then
    log "no previous release is available"
    return 0
  fi

  case "$PREVIOUS_RELEASE/" in
    "$RELEASES_DIR/"?*) ;;
    *)
      log "refusing rollback outside $RELEASES_DIR"
      return 1
      ;;
  esac
  [[ "$(dirname -- "$PREVIOUS_RELEASE")" == "$RELEASES_DIR" ]] || {
    log "refusing rollback outside $RELEASES_DIR"
    return 1
  }

  local previous_sha
  previous_sha="$(basename -- "$PREVIOUS_RELEASE")"
  [[ "$previous_sha" =~ ^[0-9a-f]{40}$ ]] || {
    log "previous release name is invalid"
    return 1
  }
  [[ -f "$PREVIOUS_RELEASE/docker-compose.yml" ]] || {
    log "previous Compose file is missing"
    return 1
  }

  local rollback_status
  if compose_release "$PREVIOUS_RELEASE" "$previous_sha" \
    up --detach --remove-orphans --wait --wait-timeout 300; then
    :
  else
    rollback_status=$?
    log "rollback startup failed with status $rollback_status"
    return "$rollback_status"
  fi
  if verify_release_health "$PREVIOUS_RELEASE" "$previous_sha" legacy-rollback; then
    :
  else
    rollback_status=$?
    log "rollback release verification failed with status $rollback_status"
    return "$rollback_status"
  fi
  log "rollback restored $previous_sha"
}

restore_current_link() {
  local current_target=""
  if [[ -L "$CURRENT_LINK" ]]; then
    current_target="$(readlink -f -- "$CURRENT_LINK" 2>/dev/null || true)"
  fi
  [[ "$current_target" == "$RELEASE_DIR" ]] || return 0

  if [[ -n "$PREVIOUS_RELEASE" ]]; then
    if ! ln -s -- "$PREVIOUS_LINK_TARGET" "$RESTORE_LINK"; then
      log "failed to prepare the previous current link"
      return 1
    fi
    if ! mv -Tf -- "$RESTORE_LINK" "$CURRENT_LINK"; then
      log "failed to restore the previous current link"
      return 1
    fi
  else
    if ! rm -f -- "$CURRENT_LINK"; then
      log "failed to remove the first-deploy current link"
      return 1
    fi
  fi
}

cleanup_stage() {
  [[ -n "$STAGE_DIR" ]] || return 0
  rm -f -- "$ARCHIVE_PATH" "$CANDIDATE_ENV_PATH"
  [[ -z "$SHARED_ENV_NEXT" ]] || rm -f -- "$SHARED_ENV_NEXT"
  [[ -z "$SHARED_ENV_RESTORE" ]] || rm -f -- "$SHARED_ENV_RESTORE"
  case "$SCRIPT_REAL" in
    "$STAGE_DIR/"*) rm -f -- "$SCRIPT_REAL" ;;
  esac
  rmdir -- "$STAGE_DIR" 2>/dev/null || true
}

cleanup_workdir() {
  [[ -n "$WORK_DIR" ]] || return 0
  case "$WORK_DIR" in
    "$DEPLOY_ROOT_REAL"/.deploy-work."$DEPLOY_SHA".*) ;;
    *)
      log "refusing to clean an unexpected private work directory"
      return 1
      ;;
  esac
  [[ "$(dirname -- "$WORK_DIR")" == "$DEPLOY_ROOT_REAL" ]] || {
    log "refusing to clean a private work directory outside $DEPLOY_ROOT_REAL"
    return 1
  }
  rm -rf -- "$WORK_DIR"
}

on_exit() {
  local status=$?
  trap - EXIT
  set +e

  if [[ $status -ne 0 && "$PROMOTED" == false && "$MUTATION_STARTED" == true ]]; then
    diagnostics
    restore_environment || log "environment restoration was unsuccessful"
    rollback_previous || log "previous release rollback was unsuccessful"
    restore_current_link || log "current link restoration was unsuccessful"
  fi

  case "$RELEASE_TMP" in
    "$RELEASES_DIR/.$DEPLOY_SHA.tmp."*) rm -rf -- "$RELEASE_TMP" ;;
  esac
  rm -f -- "$NEXT_LINK" "$RESTORE_LINK"
  cleanup_stage
  cleanup_workdir
  exit "$status"
}

for command in \
  awk basename chmod curl dirname docker grep id install ln mkdir mktemp mv \
  readlink realpath rm rmdir sha256sum tar; do
  require_command "$command"
done
[[ "$(id -u)" == "0" ]] || die "remote deployment must run as root"
docker info >/dev/null
docker compose version >/dev/null
docker compose up --help | grep -q -- "--wait" ||
  die "Docker Compose does not support --wait"

DEPLOY_ROOT_PARENT="$(dirname -- "$DEPLOY_ROOT")"
[[ -d "$DEPLOY_ROOT_PARENT" && ! -L "$DEPLOY_ROOT_PARENT" ]] ||
  die "deployment root parent must be a real directory"
DEPLOY_ROOT_PARENT_REAL="$(realpath -e -- "$DEPLOY_ROOT_PARENT")"
[[ "$DEPLOY_ROOT_PARENT_REAL" == "$DEPLOY_ROOT_PARENT" ]] ||
  die "deployment root parent must resolve to its canonical path"
if [[ -L "$DEPLOY_ROOT" || ( -e "$DEPLOY_ROOT" && ! -d "$DEPLOY_ROOT" ) ]]; then
  die "deployment root must be a real directory"
fi
if [[ ! -e "$DEPLOY_ROOT" ]]; then
  mkdir -m 700 -- "$DEPLOY_ROOT"
fi
[[ -d "$DEPLOY_ROOT" && ! -L "$DEPLOY_ROOT" ]] ||
  die "deployment root must be a real directory"
DEPLOY_ROOT_REAL="$(realpath -e -- "$DEPLOY_ROOT")"
[[ "$DEPLOY_ROOT_REAL" == "$DEPLOY_ROOT" &&
  "$(dirname -- "$DEPLOY_ROOT_REAL")" == "$DEPLOY_ROOT_PARENT_REAL" ]] ||
  die "deployment root must resolve to its canonical path"
chmod 700 -- "$DEPLOY_ROOT"
ensure_fixed_directory "$INCOMING_DIR" "incoming"
ensure_fixed_directory "$RELEASES_DIR" "releases"
ensure_fixed_directory "$SHARED_DIR" "shared"
INCOMING_REAL="$(realpath -e -- "$INCOMING_DIR")"

archive_parent="$(dirname -- "$ARCHIVE_PATH")"
[[ -d "$archive_parent" && ! -L "$archive_parent" ]] ||
  die "staging directory must be a real directory"
STAGE_DIR="$(cd -- "$archive_parent" && pwd -P)"
case "$STAGE_DIR/" in
  "$INCOMING_REAL/"?*) ;;
  *) die "staging directory must be below $INCOMING_DIR" ;;
esac

SCRIPT_REAL="$(realpath -e -- "${BASH_SOURCE[0]}")"
[[ -f "$ARCHIVE_PATH" && ! -L "$ARCHIVE_PATH" ]] || die "archive is missing"
[[ -f "$CANDIDATE_ENV_PATH" && ! -L "$CANDIDATE_ENV_PATH" ]] ||
  die "candidate environment is missing"
ARCHIVE_REAL="$(realpath -e -- "$ARCHIVE_PATH")"
CANDIDATE_ENV_REAL="$(realpath -e -- "$CANDIDATE_ENV_PATH")"
[[ "$ARCHIVE_REAL" == "$STAGE_DIR/"* ]] ||
  die "archive escaped staging"
[[ "$CANDIDATE_ENV_REAL" == "$STAGE_DIR/"* ]] ||
  die "environment escaped staging"
[[ "$ARCHIVE_REAL" != "$CANDIDATE_ENV_REAL" &&
  "$ARCHIVE_REAL" != "$SCRIPT_REAL" &&
  "$CANDIDATE_ENV_REAL" != "$SCRIPT_REAL" ]] ||
  die "deployment inputs must not collide"

trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

create_private_workdir

ACTUAL_SHA256="$(sha256sum -- "$PRIVATE_ARCHIVE" | awk '{print $1}')"
readonly ACTUAL_SHA256
[[ "$ACTUAL_SHA256" == "$EXPECTED_SHA256" ]] || die "archive checksum mismatch"
validate_archive_members

if [[ -e "$CURRENT_LINK" && ! -L "$CURRENT_LINK" ]]; then
  die "current release is not a symbolic link"
fi
if [[ -L "$CURRENT_LINK" ]]; then
  PREVIOUS_LINK_TARGET="$(readlink -- "$CURRENT_LINK")"
  PREVIOUS_RELEASE="$(readlink -f -- "$CURRENT_LINK")" ||
    die "current release link is invalid"
  case "$PREVIOUS_RELEASE/" in
    "$RELEASES_DIR/"?*) ;;
    *) die "current release points outside $RELEASES_DIR" ;;
  esac
  [[ "$(dirname -- "$PREVIOUS_RELEASE")" == "$RELEASES_DIR" ]] ||
    die "current release points outside $RELEASES_DIR"
  [[ "$(basename -- "$PREVIOUS_RELEASE")" =~ ^[0-9a-f]{40}$ ]] ||
    die "current release name is invalid"
  [[ -d "$PREVIOUS_RELEASE" && ! -L "$PREVIOUS_RELEASE" ]] ||
    die "current release must be a real directory"
  validate_release_marker "$PREVIOUS_RELEASE" "current release"
  [[ -f "$PREVIOUS_RELEASE/docker-compose.yml" &&
    ! -L "$PREVIOUS_RELEASE/docker-compose.yml" ]] ||
    die "current release Compose file must be a regular file"
fi

if [[ -e "$RELEASE_DIR" || -L "$RELEASE_DIR" ]]; then
  [[ -d "$RELEASE_DIR" && ! -L "$RELEASE_DIR" ]] ||
    die "existing release is not a directory"
  [[ "$(realpath -e -- "$RELEASE_DIR")" == "$RELEASE_DIR" ]] ||
    die "existing release escaped the releases directory"
  validate_release_marker "$RELEASE_DIR" "existing release" "$EXPECTED_SHA256"
  [[ -f "$RELEASE_DIR/docker-compose.yml" &&
    ! -L "$RELEASE_DIR/docker-compose.yml" ]] ||
    die "existing release Compose file must be a regular file"
  [[ -f "$RELEASE_DIR/Dockerfile" && ! -L "$RELEASE_DIR/Dockerfile" ]] ||
    die "existing release Dockerfile must be a regular file"
else
  MUTATION_STARTED=true
  mkdir -- "$RELEASE_TMP"
  tar --extract --gzip --file "$PRIVATE_ARCHIVE" --directory "$RELEASE_TMP" \
    --no-same-owner --no-same-permissions
  [[ -f "$RELEASE_TMP/docker-compose.yml" &&
    ! -L "$RELEASE_TMP/docker-compose.yml" ]] ||
    die "archive has no regular docker-compose.yml"
  [[ -f "$RELEASE_TMP/Dockerfile" && ! -L "$RELEASE_TMP/Dockerfile" ]] ||
    die "archive has no regular Dockerfile"
  [[ ! -e "$RELEASE_TMP/.aoa-release" && ! -L "$RELEASE_TMP/.aoa-release" ]] ||
    die "archive must not contain .aoa-release"
  (
    set -o noclobber
    printf '%s %s\n' "$DEPLOY_SHA" "$EXPECTED_SHA256" >"$RELEASE_TMP/.aoa-release"
  ) || die "could not create the release marker"
  chmod -R a-w -- "$RELEASE_TMP"
  mv -T -- "$RELEASE_TMP" "$RELEASE_DIR"
fi

MUTATION_STARTED=true

if [[ -L "$SHARED_ENV" || ( -e "$SHARED_ENV" && ! -f "$SHARED_ENV" ) ]]; then
  die "shared environment must be a regular file"
fi
if [[ -f "$SHARED_ENV" ]]; then
  install -m 600 -- "$SHARED_ENV" "$ENV_BACKUP"
  HAD_PREVIOUS_ENV=true
fi
ENV_SWAPPED=true
SHARED_ENV_NEXT="$(mktemp "$SHARED_DIR/.env.next.$DEPLOY_SHA.XXXXXX")"
install -m 600 -- "$PRIVATE_ENV" "$SHARED_ENV_NEXT"
mv -f -- "$SHARED_ENV_NEXT" "$SHARED_ENV"
SHARED_ENV_NEXT=""

compose_release "$RELEASE_DIR" "$DEPLOY_SHA" config --quiet
compose_release "$RELEASE_DIR" "$DEPLOY_SHA" build --pull server
compose_release "$RELEASE_DIR" "$DEPLOY_SHA" \
  up --detach --remove-orphans --wait --wait-timeout 300

verify_release_health "$RELEASE_DIR" "$DEPLOY_SHA"

ln -s -- "$RELEASE_DIR" "$NEXT_LINK"
mv -Tf -- "$NEXT_LINK" "$CURRENT_LINK"
PROMOTED=true
rm -f -- "$ENV_BACKUP" || log "could not remove the environment backup"
log "deployed $DEPLOY_SHA to $PUBLIC_URL" || true
