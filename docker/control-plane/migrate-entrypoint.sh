#!/bin/sh
# DEP-003 (E6 deployment harness): the PRIVILEGED migration-job container command,
# SEPARATE from application startup (which runs NO migrations). This runs as a
# dedicated `migrate` service and MUST complete before the control-plane serves
# (the readiness gate keeps the app 503 until the applied schema is compatible).
#
# `set -eu`: any non-zero step aborts the container FAIL-CLOSED, so a failed
# migration or a stopped 0188 cutover preflight halts the deploy rather than
# serving on an unmigrated schema.
set -eu

export AOA_HOME="${AOA_HOME:-/aoa}"
export TMPDIR="${TMPDIR:-$AOA_HOME/tmp}"
mkdir -p "$AOA_HOME" "$TMPDIR"

# 1. Apply schema migrations under the PRIVILEGED migration role (DATABASE_URL),
#    distinct from the aoa_app / aoa_operator non-owner serving roles. The job is
#    idempotent, non-destructive, bounded-retry, and fail-closed (see migrate-job.ts).
echo "migrate-job: applying schema migrations (privileged role)"
node --input-type=module -e "import('@armyofagents/db/migrate-job').then((m) => m.main())"

# 1b. D1 harness ONLY — grant the aoa_app / aoa_operator serving roles LOGIN so the
#     split control-plane image can open its app + operator pools. The migrations
#     create them NOLOGIN; a real cloud deploy provisions their credentials out-of-
#     band, so this is STRICTLY gated behind AOA_D1_PROVISION_SERVING_ROLES=1 (set
#     ONLY by docker-compose.d1.yml's migrate service) and is a no-op everywhere
#     else. Runs as the privileged owner role (DATABASE_URL), the only role that may
#     ALTER them. Fail-closed under `set -eu` like every other step.
if [ "${AOA_D1_PROVISION_SERVING_ROLES:-}" = "1" ]; then
  echo "migrate-job: [D1 harness] provisioning aoa_app / aoa_operator LOGIN"
  node /cp-app/provision-d1-serving-roles.mjs
fi

# 1c. D1 harness ONLY (WRK-017) — register ONE worker's execution target and authorize the
#     single-use enrolment code its committed ticket carries, so a real worker container can
#     ENROL during `docker compose up --wait`. It MUST run here and not from a
#     `docker compose exec` seed: a first-boot enrol failure is proc.exit(1) in the daemon,
#     the D1 workers declare no `restart:` policy, and a compose exec necessarily happens
#     after the stack is already up. STRICTLY gated behind AOA_D1_SEED_WORKER_ENROLMENT=1,
#     set ONLY by docker-compose.d1.yml's migrate service; a no-op everywhere else. Runs as
#     the privileged owner role like every other step, and fails closed under `set -eu`.
if [ "${AOA_D1_SEED_WORKER_ENROLMENT:-}" = "1" ]; then
  echo "migrate-job: [D1 harness] seeding the worker enrolment target + code"
  node /cp-app/seed-d1-worker-enrolment.mjs
fi

# 2. Operator-gated 0188 populated-cutover preflight — ONLY when the operator has
#    explicitly opted in. Dormant by default: a single-tenant / non-cutover deploy
#    never runs it. It requires the exact candidate SHA, takes + checksum-validates
#    a snapshot, restores it to an ISOLATED pre-cutover database, writes the durable
#    marker (aoa_operator), and verifies it by read-back — failing closed at every
#    step. Application startup can only READ that marker, never write it.
if [ "${AOA_0188_CUTOVER_OPT_IN:-}" = "1" ]; then
  echo "migrate-job: running operator-gated 0188 cutover preflight"
  node /cp-app/dist/services/cutover-0188-preflight.js
else
  echo "migrate-job: 0188 cutover preflight not opted in (dormant) — skipping"
fi

echo "migrate-job: complete"
