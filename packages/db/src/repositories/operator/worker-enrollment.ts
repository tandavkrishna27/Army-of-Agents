import type { Db } from "../../client.js";
import {
  createWorkerEnrollmentRepository,
  type WorkerEnrollmentRepository,
} from "../tenant/worker-enrollment.js";

/**
 * JOB-002 platform-only adapter. The supplied handle must be one verified
 * aoa_operator transaction; FORCE RLS limits every reused operation to null-Org
 * platform metadata even though the query shapes match tenant enrollment.
 */
export function operatorWorkerEnrollmentRepository(tx: Db): WorkerEnrollmentRepository {
  return createWorkerEnrollmentRepository(tx);
}
