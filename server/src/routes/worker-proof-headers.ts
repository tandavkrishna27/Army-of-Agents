import type { Request } from "express";
import { WORKER_CONTROL_HEADERS } from "@armyofagents/shared";
import type { DeviceProofHeaders } from "../services/worker-device-proof.js";

// Pure header reader shared by worker-control (flag-on job-control graph) and execution-targets
// (always-loaded routes). It lives in its own leaf module so the always-loaded execution-target
// routes can read a device proof WITHOUT importing worker-control.ts and thereby pulling the entire
// flag-on job-control graph (job-leasing, job-control-metrics, ...) into a flag-off startup.
export function deviceProofHeaders(req: Request): DeviceProofHeaders | null {
  const proof = {
    version: req.header(WORKER_CONTROL_HEADERS.proofVersion),
    publicKey: req.header(WORKER_CONTROL_HEADERS.publicKey),
    signature: req.header(WORKER_CONTROL_HEADERS.signature),
    issuedAt: req.header(WORKER_CONTROL_HEADERS.issuedAt),
    proofId: req.header(WORKER_CONTROL_HEADERS.proofId),
  };
  if (Object.values(proof).some((value) => typeof value !== "string" || value.length === 0)) return null;
  return proof as DeviceProofHeaders;
}
