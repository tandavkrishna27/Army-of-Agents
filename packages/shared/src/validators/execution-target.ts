import { z } from "zod";
import { EXECUTION_TARGET_KINDS, EXECUTION_TARGET_TRUST_CLASSES, EXECUTION_TARGET_STATUSES } from "../constants.js";

export const dockerIsolationSchema = z.object({
  user: z.string().optional().nullable(),
  capDropAll: z.boolean().optional(),
  noNewPrivileges: z.boolean().optional(),
  seccompProfile: z.string().optional().nullable(),
  readOnlyRootfs: z.boolean().optional(),
  tmpfs: z.array(z.string()).optional(),
  memory: z.string().optional().nullable(),
  cpus: z.string().optional().nullable(),
  pidsLimit: z.number().int().positive().max(100000).optional().nullable(),
  ulimitNofile: z.number().int().positive().max(1048576).optional().nullable(),
  ipcPrivate: z.boolean().optional(),
}).strict();

export const gvisorEnvironmentConfigSchema = z.object({
  provider: z.literal("gvisor"),
  image: z.string().min(1),
  runtime: z.enum(["runc", "runsc"]).optional().default("runsc"),
  network: z.enum(["bridge", "host", "none"]).optional().default("none"),
  workdir: z.string().min(1).optional(),
  shell: z.enum(["sh", "bash"]).optional(),
  installCommand: z.string().optional().nullable(),
  allowHostGateway: z.boolean().optional().default(false),
  isolation: dockerIsolationSchema.optional(),
}).strict();

export const createExecutionTargetSchema = z.object({
  slug: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/),
  kind: z.enum(EXECUTION_TARGET_KINDS),
  trustClass: z.enum(EXECUTION_TARGET_TRUST_CLASSES),
  status: z.enum(EXECUTION_TARGET_STATUSES).optional().default("active"),
  ownerUserId: z.string().optional().nullable(),
  capabilities: z.record(z.unknown()).optional().default({}),
  config: z.record(z.unknown()).optional().default({}),
});
export type CreateExecutionTargetInput = z.infer<typeof createExecutionTargetSchema>;

export const workerExecutionTargetHeartbeatSchema = z.object({
  status: z.enum(["active", "draining", "offline"]).optional(),
  capabilities: z.record(z.unknown()).optional(),
}).strict();
export type WorkerExecutionTargetHeartbeatInput = z.infer<typeof workerExecutionTargetHeartbeatSchema>;
