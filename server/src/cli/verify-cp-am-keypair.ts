#!/usr/bin/env tsx
// server/src/cli/verify-cp-am-keypair.ts
//
// DEP-012 Slice 4+5 (P5) — the C0 matched-pair smoke probe. Run by the OPERATOR at C0,
// against the REAL mounted key files, BEFORE the canary:
//
//   AOA_CONTROL_PLANE_SIGNING_KEY_FILE=/run/secrets/control-plane-signing-key \
//   AOA_ADAPTER_MANAGER_CONTROL_PLANE_PUBLIC_KEY_FILE=/run/secrets/adapter-manager-cp-pubkey \
//     pnpm verify:cp-am-keypair
//   # or pass the paths as argv: pnpm verify:cp-am-keypair <privateKeyFile> <publicKeyFile>
//
// ★ [Mint-1] WHY THIS EXISTS. Build-time tests prove the mint↔verify endpoints in
// ISOLATION with a self-generated keypair, but they CANNOT see the DEPLOYED combination:
// each service only validates its OWN key parses, and a MISMATCHED (or half-wired) pair
// boots CLEAN on both sides. At runtime a mismatch collapses to the UNIFORM
// ResourceNotAvailableError — byte-indistinguishable from a legitimate ownership denial —
// so a broken deploy is MAXIMALLY SILENT: every gated create just fails. This probe is the
// honest enforcement the build-time tests cannot provide: it MINTS a probe capability with
// the mounted CP PRIVATE key and VERIFIES it with the mounted AM PUBLIC key, exiting
// non-zero and LOUD on any mismatch. It gates the canary.
//
// SECURITY (Decision #104): the probe capability is signed over a DUMMY label tuple only.
// It touches NO tenant data, NO provider key, NO database — pure node:crypto over two
// mounted PEM files. It never prints key material.

import { createPublicKey, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  OWNED_LABELS_CAPABILITY_AUDIENCE,
  OWNED_LABELS_CAPABILITY_VERSION,
  signOwnedLabelsCapability,
} from "@armyofagents/provider-capability";
import { verifyOwnedLabelsCapability } from "@armyofagents/adapter-manager/capability-verify";
import type { ResourceLabels } from "@armyofagents/worker-daemon";

import { loadControlPlaneSigningKey } from "../config/control-plane-signing-key.js";

/** A fixed, non-sensitive probe tuple. Not a real run — never routed anywhere. */
const PROBE_LABELS: ResourceLabels = {
  organizationId: "00000000-0000-4000-8000-000000000000",
  targetId: "probe",
  workerId: "probe",
  jobId: "probe",
  attempt: 0,
  leaseId: "probe",
  deviceGeneration: 0,
};

function fail(message: string): never {
  console.error(`\n✗ CP↔AM keypair smoke: FAIL\n  ${message}\n`);
  console.error(
    "  The control-plane PRIVATE mint key and the adapter-manager PUBLIC verify key are NOT a\n" +
      "  matched pair (or one is unwired). Do NOT proceed to the canary: every gated create would\n" +
      "  fail with the uniform ResourceNotAvailableError, indistinguishable from an ownership denial.\n" +
      "  Regenerate ONE ed25519 keypair and mount private→CP, public→AM.\n",
  );
  process.exit(1);
}

function loadPublicKey(path: string): KeyObject {
  let key: KeyObject;
  try {
    const bytes = readFileSync(path);
    if (bytes.toString("utf8").includes("PRIVATE KEY")) {
      fail(`${path} points at a PRIVATE key — mount the ed25519 PUBLIC SPKI PEM only`);
    }
    key = createPublicKey(bytes);
  } catch (err) {
    fail(`could not load the AM public key at ${path}: ${(err as Error).message}`);
  }
  if (key.asymmetricKeyType !== "ed25519") {
    fail(`the AM public key at ${path} is ${String(key.asymmetricKeyType)}, expected ed25519`);
  }
  return key;
}

function main(): void {
  const [privateArg, publicArg] = process.argv.slice(2);
  const privatePath = privateArg ?? process.env.AOA_CONTROL_PLANE_SIGNING_KEY_FILE;
  const publicPath = publicArg ?? process.env.AOA_ADAPTER_MANAGER_CONTROL_PLANE_PUBLIC_KEY_FILE;

  if (!privatePath || !publicPath) {
    console.error(
      "usage: verify-cp-am-keypair <privateKeyFile> <publicKeyFile>\n" +
        "  or set AOA_CONTROL_PLANE_SIGNING_KEY_FILE + AOA_ADAPTER_MANAGER_CONTROL_PLANE_PUBLIC_KEY_FILE",
    );
    process.exit(2);
  }

  // Load the CP private (mint) key with distributed=true, so a missing/unparseable/non-ed25519
  // key is a LOUD throw here (caught below) rather than a silent inert.
  let privateKey: KeyObject | undefined;
  try {
    privateKey = loadControlPlaneSigningKey(privatePath, true);
  } catch (err) {
    fail((err as Error).message);
  }
  if (!privateKey) fail(`the CP private key at ${privatePath} did not load (empty/unreadable)`);

  const publicKey = loadPublicKey(publicPath);

  // Mint a probe capability with the PRIVATE key → verify with the PUBLIC key. A mismatched
  // pair (or a canonical/version/audience drift) throws CapabilityVerificationError here.
  const cap = signOwnedLabelsCapability(
    {
      v: OWNED_LABELS_CAPABILITY_VERSION,
      audience: OWNED_LABELS_CAPABILITY_AUDIENCE,
      ownedLabels: PROBE_LABELS,
      expiresAt: Date.now() + 60_000,
    },
    privateKey,
  );
  try {
    const verified = verifyOwnedLabelsCapability(cap, publicKey, Date.now());
    if (verified.organizationId !== PROBE_LABELS.organizationId) {
      fail("verify returned unexpected labels (canonical drift)");
    }
  } catch (err) {
    fail(`the mounted public key did NOT verify a capability minted by the mounted private key: ${(err as Error).message}`);
  }

  console.log("\n✓ CP↔AM keypair smoke: PASS");
  console.log("  The mounted CP private (mint) key and AM public (verify) key are a matched ed25519 pair.");
  console.log("  Gated create dispatch will verify. Safe to proceed to the canary.\n");
  process.exit(0);
}

main();
