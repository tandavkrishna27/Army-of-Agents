// server/src/config/control-plane-signing-key.ts
//
// DEP-012 Slice 4+5 (P2) — load the control-plane ed25519 PRIVATE key that MINTS the
// owned-labels capability (services/owned-labels-mint.ts), or return undefined (inert).
// Extracted from the composition root so the fail-closed behaviour is unit-testable
// (index.ts wires it and owns the single `process.env.AOA_CONTROL_PLANE_SIGNING_KEY_FILE`
// literal — documented for brand-check step 9).
//
// ★ [Mint-2] Mirrors the adapter-manager bin's try/catch → refuse STRUCTURE
// (packages/adapter-manager/src/bin/adapter-manager.ts): the read + parse + ed25519 assert
// are ALL wrapped, so an encrypted PEM ("BEGIN ENCRYPTED PRIVATE KEY", which passes a naive
// "PRIVATE KEY" string-guard then throws with no passphrase), a DER key, or an RSA key
// THROWS inside the try rather than crashing the composition root uncaught.
//
// Fail-closed ASYMMETRICALLY (the [Mint-2] scope):
//   - env unset/empty ⇒ undefined (inert — no keypair configured, pre-DEP-011 behaviour);
//   - env set but unparseable/non-ed25519 AND distributed execution ON ⇒ a LOUD FATAL throw
//     (never a silent fall to undefined = the dead path: the adapter-manager gates every
//     create with the matching PUBLIC key while the control plane mints nothing, so every
//     distributed create fails, indistinguishably from an ownership denial);
//   - env set but bad AND distributed execution OFF ⇒ undefined (a mint-key typo is not
//     worth crashing a non-distributed control plane at boot — disproportionate).
//
// ★ [H3] THE GAP IN THAT SCOPING WAS ITS OWN AUTHOR'S: present-but-bad was made loud and
// ABSENT was left silent, even though absent produces the IDENTICAL total outage. The
// `if (!keyPath)` short-circuit sits BEFORE any flag check, so forgetting the env var means the
// key resolves "fine", no capability is ever minted, the adapter-manager (which REFUSES to boot
// ungated, so its gate is always on) rejects every create, and every distributed run
// terminalizes `no_run_capability` BEFORE a sandbox exists. The only signal anywhere was one
// worker-side `warn`, on the far side of the deployment.
//
// H3 makes that case LOUD — but as an ERROR-LEVEL REPORT, not a throw, and the difference is
// deliberate. `docker-compose.d1.yml` runs BOTH control planes with
// `AOA_DISTRIBUTED_EXECUTION_ENABLED: "true"` and NO signing key, and that is a legitimate
// configuration rather than an oversight: D1's workers are `mounted_secret` with no provider,
// so they never create a sandbox and never need a minted capability. A hard refusal would
// crash-loop the D1 control planes and red the merge train over a config that is correct for
// its purpose. "Flag on + no mint key" is a real deployment shape; what it must not be is a
// SILENT one.

import { createPrivateKey, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * The [H3] report. Exported so the boot wiring and the tests assert the SAME string, and so an
 * operator can grep for it in a log aggregator.
 */
export const UNWIRED_MINT_MESSAGE =
  "AOA_CONTROL_PLANE_SIGNING_KEY_FILE is NOT SET while distributed execution is ENABLED. " +
  "No owned-labels capability can be minted, so the adapter-manager -- which refuses to boot " +
  "ungated and therefore always gates -- will reject EVERY sandbox create: no distributed run " +
  "can execute, and each one terminalizes `no_run_capability` before a sandbox exists. If this " +
  "deployment is not meant to create sandboxes (the D1 harness is not), this is expected. " +
  "Otherwise mount an ed25519 PRIVATE key (PEM PKCS8) at this path whose PUBLIC half is the " +
  "adapter-manager's AOA_ADAPTER_MANAGER_CONTROL_PLANE_PUBLIC_KEY_FILE, and verify the pair " +
  "with `pnpm verify:cp-am-keypair` before the canary.";

/**
 * @param keyFile the value of AOA_CONTROL_PLANE_SIGNING_KEY_FILE (a mounted PEM path).
 * @param distributedExecutionEnabled whether the distributed execution path is on — scopes
 *   the "present-but-bad ⇒ loud fatal" behaviour (off ⇒ a bad key stays inert, no crash).
 * @param readKeyFileBytes injectable fs seam (default readFileSync) — the REAL parser runs
 *   on the injected bytes, so tests exercise the unparseable / non-ed25519 refuse paths.
 * @param reportUnwiredMint [H3] sink for the ABSENT-key report (default `console.error`);
 *   the boot wiring passes the server logger so it lands in the structured stream.
 */
export function loadControlPlaneSigningKey(
  keyFile: string | undefined,
  distributedExecutionEnabled: boolean,
  readKeyFileBytes: (path: string) => Buffer = (path) => readFileSync(path),
  reportUnwiredMint: (message: string) => void = (message) => console.error(message),
): KeyObject | undefined {
  const keyPath = keyFile?.trim();
  if (!keyPath) {
    // [H3] ABSENT + distributed ON is a TOTAL, otherwise-silent outage of the distributed
    // path. Report it at error level with the consequence spelled out, so an operator reading
    // boot logs learns it HERE rather than from a fleet of `no_run_capability` terminals.
    if (distributedExecutionEnabled) reportUnwiredMint(UNWIRED_MINT_MESSAGE);
    return undefined;
  }
  try {
    // createPrivateKey MUST sit inside this try: an encrypted PEM or a DER/RSA key throws
    // HERE, and that throw must be a scoped refusal — a catch scoped only to the read, or a
    // naive "PRIVATE KEY" string-guard, would fail open (an encrypted PEM would pass the
    // string-guard then throw uncaught).
    const key = createPrivateKey(readKeyFileBytes(keyPath));
    if (key.asymmetricKeyType !== "ed25519") {
      throw new Error(`expected an ed25519 key, got ${String(key.asymmetricKeyType)}`);
    }
    return key;
  } catch (err) {
    if (distributedExecutionEnabled) {
      throw new Error(
        `AOA_CONTROL_PLANE_SIGNING_KEY_FILE is set but could not be loaded as an ed25519 PRIVATE key ` +
          `(${(err as Error).message}). Distributed execution is enabled, so refusing to boot with an ` +
          `unwired mint: the adapter-manager gates every create with the matching PUBLIC key while the ` +
          `control plane would mint nothing, silently killing the entire distributed create path.`,
      );
    }
    // Distributed execution OFF: a mint-key typo is not worth crashing the control plane.
    return undefined;
  }
}
