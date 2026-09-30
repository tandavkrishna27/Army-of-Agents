import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  APP_ENROLLMENT_TARGET_SELECT_COLUMNS,
  APP_ENROLLMENT_TARGET_UPDATE_COLUMNS,
  OPERATOR_ENROLLMENT_TARGET_SELECT_COLUMNS,
  OPERATOR_ENROLLMENT_TARGET_UPDATE_COLUMNS,
  WORKER_ENROLLMENT_APP_GRANTS,
  WORKER_ENROLLMENT_OPERATOR_GRANTS,
} from "../db/job-control-legacy-grants.js";
import { buildWorkerEnrollmentRlsMigrationSql } from "../db/rls-tenant.js";

const migrationUrl = new URL(
  "../../../packages/db/src/migrations/0221_worker_enrollment_rls.sql",
  import.meta.url,
);

describe("JOB-002 worker-enrollment bounded-role contract", () => {
  it("keeps the Decision #122 builder byte-aligned with the committed custom migration", () => {
    const migration = readFileSync(fileURLToPath(migrationUrl), "utf8").replace(/\r\n/g, "\n").trim();
    expect(migration).toBe(buildWorkerEnrollmentRlsMigrationSql().trim());
  });

  it("grants only the versioned enrollment tables and exact target columns", () => {
    expect(WORKER_ENROLLMENT_APP_GRANTS).toEqual({
      worker_enrollment_code_routes: ["SELECT", "INSERT", "DELETE"],
      worker_enrollment_codes: ["SELECT", "INSERT", "UPDATE", "DELETE"],
      worker_proof_replays: ["SELECT", "INSERT", "DELETE"],
    });
    expect(WORKER_ENROLLMENT_OPERATOR_GRANTS).toEqual({
      workers: ["SELECT", "INSERT", "UPDATE", "DELETE"],
      worker_enrollment_code_routes: ["SELECT", "INSERT", "DELETE"],
      worker_enrollment_codes: ["SELECT", "INSERT", "UPDATE", "DELETE"],
      worker_proof_replays: ["SELECT", "INSERT", "DELETE"],
    });
    expect(APP_ENROLLMENT_TARGET_SELECT_COLUMNS).not.toContain("worker_token_hash");
    expect(OPERATOR_ENROLLMENT_TARGET_SELECT_COLUMNS).not.toContain("worker_token_hash");
    expect(APP_ENROLLMENT_TARGET_UPDATE_COLUMNS).toContain("worker_token_hash");
    expect(OPERATOR_ENROLLMENT_TARGET_UPDATE_COLUMNS).toContain("worker_token_hash");
    const sql = buildWorkerEnrollmentRlsMigrationSql();
    for (const forbidden of ["jobs", "job_attempts", "leases", "job_artifacts", "job_secret_handles"]) {
      expect(sql).not.toContain(`ON \"${forbidden}\" TO \"aoa_operator\"`);
    }
  });
});
