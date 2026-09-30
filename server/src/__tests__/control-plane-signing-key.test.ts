// DEP-012 Slice 4+5 (P2) — the control-plane mint-key load.
//
// Proves the [Mint-2] fail-closed contract: env unset ⇒ inert; a real ed25519 key mints a
// capability the adapter-manager verify ACCEPTS (true mint↔verify parity with a real
// keypair); a present-but-bad / non-ed25519 / ENCRYPTED key ⇒ a LOUD FATAL when distributed
// execution is ON (never a silent fall to undefined = the dead path), but ⇒ inert when OFF.

import { createPublicKey, generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { ResourceLabels } from "@armyofagents/worker-daemon";
import {
  OWNED_LABELS_CAPABILITY_AUDIENCE,
  OWNED_LABELS_CAPABILITY_VERSION,
  signOwnedLabelsCapability,
} from "@armyofagents/provider-capability";
import { verifyOwnedLabelsCapability } from "@armyofagents/adapter-manager/capability-verify";

import {
  UNWIRED_MINT_MESSAGE,
  loadControlPlaneSigningKey,
} from "../config/control-plane-signing-key.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const PRIVATE_PEM = privateKey.export({ type: "pkcs8", format: "pem" }) as string;

/** An fs seam that returns fixed bytes regardless of path. */
const reads = (bytes: string): ((path: string) => Buffer) => () => Buffer.from(bytes, "utf8");

const LABELS: ResourceLabels = {
  organizationId: "org-1",
  targetId: "tgt-1",
  workerId: "wkr-1",
  jobId: "job-1",
  attempt: 1,
  leaseId: "lease-1",
  deviceGeneration: 3,
};

describe("DEP-012 P2 — loadControlPlaneSigningKey", () => {
  it("absent / empty env ⇒ undefined (inert), regardless of the distributed flag", () => {
    const noop = () => {};
    expect(loadControlPlaneSigningKey(undefined, true, reads(PRIVATE_PEM), noop)).toBeUndefined();
    expect(loadControlPlaneSigningKey("", true, reads(PRIVATE_PEM), noop)).toBeUndefined();
    expect(loadControlPlaneSigningKey("   ", false, reads(PRIVATE_PEM), noop)).toBeUndefined();
  });

  it("★ a real ed25519 key loads AND mint↔verify parity holds (the AM verify accepts its cap)", () => {
    const key = loadControlPlaneSigningKey("/run/secrets/cp-key", true, reads(PRIVATE_PEM));
    expect(key).toBeDefined();
    expect(key!.asymmetricKeyType).toBe("ed25519");

    // Mint with the loaded PRIVATE key; the AM verify with the matching PUBLIC key accepts it
    // and returns the owned labels — the exact mint→gate path a real gated create takes.
    const cap = signOwnedLabelsCapability(
      {
        v: OWNED_LABELS_CAPABILITY_VERSION,
        audience: OWNED_LABELS_CAPABILITY_AUDIENCE,
        ownedLabels: LABELS,
        expiresAt: Date.now() + 60_000,
      },
      key!,
    );
    const verified = verifyOwnedLabelsCapability(cap, publicKey, Date.now());
    expect(verified).toEqual(LABELS);

    // A MISMATCHED public key (a different pair) is rejected — the dead-path scenario the C0
    // smoke tool catches at deploy (build-time each service only validates its OWN key).
    const other = generateKeyPairSync("ed25519").publicKey;
    expect(() => verifyOwnedLabelsCapability(cap, other, Date.now())).toThrow();
  });

  it("★ present-but-unparseable key + distributed ON ⇒ LOUD FATAL (never silent inert)", () => {
    expect(() => loadControlPlaneSigningKey("/x", true, reads("-----NOT A PEM-----"))).toThrow(
      /ed25519 PRIVATE key/,
    );
  });

  it("present-but-bad key + distributed OFF ⇒ inert (undefined, no crash)", () => {
    expect(loadControlPlaneSigningKey("/x", false, reads("-----NOT A PEM-----"))).toBeUndefined();
  });

  it("★ a NON-ed25519 (RSA) key + distributed ON ⇒ LOUD FATAL (the asymmetricKeyType assert)", () => {
    const rsaPem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
      type: "pkcs8",
      format: "pem",
    }) as string;
    expect(() => loadControlPlaneSigningKey("/x", true, reads(rsaPem))).toThrow(/ed25519/);
  });

  it("★ an ENCRYPTED PEM + distributed ON ⇒ LOUD FATAL (does NOT pass a naive PRIVATE-KEY guard)", () => {
    const encPem = privateKey.export({
      type: "pkcs8",
      format: "pem",
      cipher: "aes-256-cbc",
      passphrase: "pw",
    }) as string;
    expect(encPem).toContain("ENCRYPTED PRIVATE KEY");
    // createPrivateKey throws (no passphrase) INSIDE the try — a scoped refusal, not a crash.
    expect(() => loadControlPlaneSigningKey("/x", true, reads(encPem))).toThrow();
    // And with distributed OFF the same bad key is inert (no crash).
    expect(loadControlPlaneSigningKey("/x", false, reads(encPem))).toBeUndefined();
  });

  it("sanity: createPublicKey(privateKey) is the matching verify half", () => {
    // Documents the operator invariant the C0 smoke tool enforces: the mounted public key
    // MUST be the public half of the mounted private key.
    const derivedPub = createPublicKey(privateKey);
    const key = loadControlPlaneSigningKey("/x", true, reads(PRIVATE_PEM))!;
    const cap = signOwnedLabelsCapability(
      { v: OWNED_LABELS_CAPABILITY_VERSION, audience: OWNED_LABELS_CAPABILITY_AUDIENCE, ownedLabels: LABELS, expiresAt: Date.now() + 60_000 },
      key,
    );
    expect(verifyOwnedLabelsCapability(cap, derivedPub, Date.now())).toEqual(LABELS);
  });
});

// -- [H3] an ABSENT mint key must not be silent ---------------------------------
//
// The original [Mint-2] scoping made present-but-BAD loud and left ABSENT silent, even though
// absent produces the identical total outage: the `if (!keyPath)` short-circuit sits before any
// flag check, so a forgotten env var resolves "fine", nothing is ever minted, the
// adapter-manager (which refuses to boot ungated) rejects every create, and every run
// terminalizes `no_run_capability` before a sandbox exists — with one worker-side `warn` as the
// only signal anywhere.

describe("[H3] absent key + distributed ON is reported, not silent", () => {
  const collect = () => {
    const messages: string[] = [];
    return { messages, report: (m: string) => messages.push(m) };
  };

  it.each([
    ["undefined", undefined],
    ["empty", ""],
    ["whitespace-only", "   "],
  ])("reports the unwired mint for %s + distributed ON", (_label, keyFile) => {
    const { messages, report } = collect();
    expect(loadControlPlaneSigningKey(keyFile, true, reads(PRIVATE_PEM), report)).toBeUndefined();
    expect(messages).toEqual([UNWIRED_MINT_MESSAGE]);
  });

  it("says WHAT BREAKS, not just that a variable is missing", () => {
    // An operator reading this line must be able to act without opening the source. The
    // terminal code and the fix are both in it.
    expect(UNWIRED_MINT_MESSAGE).toContain("AOA_CONTROL_PLANE_SIGNING_KEY_FILE");
    expect(UNWIRED_MINT_MESSAGE).toContain("no_run_capability");
    expect(UNWIRED_MINT_MESSAGE).toContain("AOA_ADAPTER_MANAGER_CONTROL_PLANE_PUBLIC_KEY_FILE");
    expect(UNWIRED_MINT_MESSAGE).toContain("verify:cp-am-keypair");
  });

  it("stays SILENT when distributed execution is OFF (this is the inert shipping path)", () => {
    const { messages, report } = collect();
    expect(loadControlPlaneSigningKey(undefined, false, reads(PRIVATE_PEM), report)).toBeUndefined();
    expect(loadControlPlaneSigningKey("", false, reads(PRIVATE_PEM), report)).toBeUndefined();
    expect(messages).toEqual([]);
  });

  it("does NOT report when a key IS configured and loads", () => {
    const { messages, report } = collect();
    expect(loadControlPlaneSigningKey("/run/secrets/cp-key", true, reads(PRIVATE_PEM), report)).toBeDefined();
    expect(messages).toEqual([]);
  });

  it("★ REPORTS rather than THROWS — `flag on + no mint key` is a legitimate D1 shape", () => {
    // `docker-compose.d1.yml` runs BOTH control planes with
    // AOA_DISTRIBUTED_EXECUTION_ENABLED=true and no signing key, because its workers are
    // `mounted_secret` with no provider and never create a sandbox. Throwing here would
    // crash-loop them. A present-but-BAD key is still a hard refusal — that one is always an
    // operator error, never a valid shape.
    expect(() => loadControlPlaneSigningKey(undefined, true, reads(PRIVATE_PEM), () => {})).not.toThrow();
    expect(() => loadControlPlaneSigningKey("/x", true, reads("-----NOT A PEM-----"))).toThrow();
  });
});
