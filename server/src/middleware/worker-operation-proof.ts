import { createHash } from "node:crypto";
import { verifyWorkerSessionToken } from "./worker-session-auth.js";
import { verifyDeviceProof, type DeviceProofHeaders } from "../services/worker-device-proof.js";

export interface VerifiedWorkerOperation {
  organizationId: string;
  workerId: string;
  targetId: string;
  targetGeneration: number;
  deviceThumbprint: string;
  profileHash: string;
  publicKey: string;
  proofId: string;
  proofIssuedAt: Date;
  sessionExpiresAt: Date;
}

export class WorkerOperationProofError extends Error {
  constructor() {
    super("Worker operation proof is unauthorized");
    this.name = "WorkerOperationProofError";
  }
}

function denied(): never {
  throw new WorkerOperationProofError();
}

/**
 * Verify only the transport-bound JWT and Ed25519 signature. Current worker,
 * target, generation, membership, and proof-replay authority are deliberately
 * checked later inside the operation's single runInTenant transaction.
 */
export function verifyWorkerOperationProof(input: {
  sessionSigningKey: string;
  authorization: string;
  rawBody: Buffer;
  proof: DeviceProofHeaders;
  method: string;
  path: string;
  correlationId: string;
  now?: Date;
}): VerifiedWorkerOperation {
  try {
    const match = /^Bearer\s+([^\s]+)$/i.exec(input.authorization.trim());
    if (!match) denied();
    const claims = verifyWorkerSessionToken(input.sessionSigningKey, match[1]!, input.now ?? new Date());
    // Platform physical profiles do not own tenant jobs. A platform target is
    // leased through its Organization-scoped logical worker profile instead.
    if (!claims.organizationId || claims.scope === "platform") denied();
    const proof = verifyDeviceProof({
      method: input.method,
      path: input.path,
      bodyDigest: createHash("sha256").update(input.rawBody).digest("hex"),
      correlationId: input.correlationId,
      proof: input.proof,
      now: input.now,
    });
    if (proof.deviceThumbprint !== claims.deviceThumbprint) denied();
    return {
      organizationId: claims.organizationId,
      workerId: claims.sub,
      targetId: claims.targetId,
      targetGeneration: claims.generation,
      deviceThumbprint: claims.deviceThumbprint,
      profileHash: claims.profileHash,
      publicKey: proof.publicKey,
      proofId: proof.proofId,
      proofIssuedAt: proof.issuedAt,
      sessionExpiresAt: new Date(claims.exp * 1_000),
    };
  } catch (error) {
    if (error instanceof WorkerOperationProofError) throw error;
    denied();
  }
}
