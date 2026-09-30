#!/bin/sh
# DEP-002 — MinIO bucket bootstrap helper (harness only; not a compose service).
#
# Invoked by the D1 bring-up (Linux/CI) or an operator BEFORE the smoke job to
# create the object-store buckets the control-plane/worker artifact + snapshot
# paths expect. It uses the MinIO client `mc` and is idempotent (mb --ignore-existing).
#
# Usage (from a host with `mc`, or `docker run` the minio/mc image on control-net):
#   MINIO_ENDPOINT=http://minio:9000 \
#   MINIO_ROOT_USER=aoa-d1 MINIO_ROOT_PASSWORD=aoa-d1-secret \
#   sh docker/d1/minio-init.sh
set -eu

ENDPOINT="${MINIO_ENDPOINT:-http://minio:9000}"
USER="${MINIO_ROOT_USER:-aoa-d1}"
PASS="${MINIO_ROOT_PASSWORD:-aoa-d1-secret}"

# Buckets used by the harness (artifacts, snapshots for the 0188 preflight).
BUCKETS="aoa-artifacts aoa-snapshots"

mc alias set d1 "$ENDPOINT" "$USER" "$PASS"
for bucket in $BUCKETS; do
  mc mb --ignore-existing "d1/$bucket"
done
mc ls d1
echo "minio-init: buckets ready: $BUCKETS"
