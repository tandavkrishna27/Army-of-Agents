// D1 harness (DEP-002 / DEP-003) ONLY — grant the non-owner serving roles LOGIN
// + a password so the split control-plane image can open its app + operator
// database pools (server/src/db/distributed-execution-databases.ts eagerly opens
// BOTH createTenantAppDbConnection(aoa_app) and createOperatorDbConnection(aoa_operator)
// at startup when AOA_DISTRIBUTED_EXECUTION_ENABLED=true).
//
// The schema migrations create aoa_app / aoa_operator as NOLOGIN roles with no
// password (0211/0213). A real cloud deploy provisions their credentials
// OUT-OF-BAND via an operator / secret manager; the self-contained D1 test stack
// has no such operator, so the PRIVILEGED migrate job (running as the OWNER role,
// which is the only role that may ALTER them) provisions throwaway credentials
// here. STRICTLY gated behind AOA_D1_PROVISION_SERVING_ROLES=1 — set ONLY by
// docker-compose.d1.yml's migrate service — so this never runs on a non-D1 deploy
// path (the migrate-entrypoint skips it, and this file is otherwise never invoked).
//
// The passwords MUST match AOA_APP_DATABASE_URL / AOA_OPERATOR_DATABASE_URL in
// docker-compose.d1.yml. PASSWORD in ALTER ROLE takes a string literal, not a bind
// parameter, so the values are validated against a strict charset before being
// interpolated into the DDL — a value outside [A-Za-z0-9_] aborts fail-closed, so
// no quote/backslash can escape the literal and injection is impossible.
import postgres from "postgres";

const SAFE = /^[A-Za-z0-9_]+$/u;
const appPassword = process.env.AOA_D1_APP_ROLE_PASSWORD || "aoa_app";
const operatorPassword = process.env.AOA_D1_OPERATOR_ROLE_PASSWORD || "aoa_operator";
for (const [name, value] of [
  ["AOA_D1_APP_ROLE_PASSWORD", appPassword],
  ["AOA_D1_OPERATOR_ROLE_PASSWORD", operatorPassword],
]) {
  if (!SAFE.test(value)) {
    throw new Error(`${name} must match ${SAFE} for the D1 serving-role provisioner`);
  }
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL (owner role) is required to provision D1 serving roles");
}

const sql = postgres(databaseUrl, { max: 1 });
try {
  // aoa_app / aoa_operator are created NOLOGIN by the migrations; grant LOGIN +
  // the throwaway D1 password. Roles keep NOSUPERUSER NOBYPASSRLS (FORCE RLS
  // isolation is preserved — LOGIN does not weaken the tenant boundary).
  await sql.unsafe(`ALTER ROLE "aoa_app" WITH LOGIN PASSWORD '${appPassword}'`);
  await sql.unsafe(`ALTER ROLE "aoa_operator" WITH LOGIN PASSWORD '${operatorPassword}'`);
  console.log("provision-d1-serving-roles: granted LOGIN to aoa_app + aoa_operator");
} finally {
  await sql.end();
}
