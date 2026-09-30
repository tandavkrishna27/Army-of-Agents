// CLI-007 (E7-F001) — the canary-aware credential path.
//
// Sprint 5 filed E7-F001: a composed canary placement mints NO execution-secret
// handle, so the canary sandbox gets no provider credential — the coding CLI cannot
// authenticate, on real E2B just as on the D1 fake provider. The block is a single
// guard: the canary binding presents `credentialKind: null`, which trips
// the DAT-008 mint's owner-authority gate (execution-secret-handle-mint.ts
// ownerAuthoritiesAgree) → `owner_authority_disagreement` → no handle.
//
// CLI-007 gives the canary a LEGITIMATE Company ownership authority
// ("company_api_key"), established by the MIG-008 preflight (which already verifies
// the Company holds provider-control authority) and threaded to the mint OUT OF BAND
// from the placement credential binding. The binding keeps all three credential
// fields (`credentialId`/`credentialKind`/`pinnedTargetId`) null, so:
//   * the placement REPLAY digest is byte-identical across attempts (the binding is
//     the only credential input the digest hashes; E11-F004's routing-only slug is a
//     stable constant, so it does not rotate the digest), and
//   * target routing stays off owner_desktop (E11-F004 routes the canary to an
//     `organization_dedicated` `dedicated_worker`, never `owner_desktop`), and
//   * the mint's owner-authority gate is UNCHANGED in strength (the canary now
//     presents a real Authority B; a genuine disagreement still refuses).
//
// This file covers the pure seam + the Decision #104 no-leak property. The
// establishment (preflight) is in cli-006-canary-preflight.test.ts, the threading in
// cli-006-run-execution-owner.test.ts, and the end-to-end mint+advertise+replay in the
// `[CLI-007]` cases of job-placement.integration.test.ts (embedded-PG).

import { describe, expect, it } from "vitest";
import {
  CANARY_CREDENTIAL_AUTHORITY,
  mintCredentialKindFor,
} from "../services/canary-mint-authority.js";
import {
  decideExecutionSecretHandle,
  type ExecutionSecretMintInput,
} from "../services/execution-secret-handle-mint.js";
import { toSecretHandleRefs } from "../services/execution-secret-handle-envelope.js";
import type { ProviderKeyTarget } from "../services/providers/provider-key.js";

describe("CLI-007 — mintCredentialKindFor (out-of-band canary mint authority)", () => {
  // The canary: the preflight-established Company authority OVERRIDES the binding's null
  // credentialKind AT THE MINT ONLY — never at the digest or routing, which read the
  // binding directly.
  it("uses the canary authority when present (the fix)", () => {
    expect(mintCredentialKindFor("company_api_key", null)).toBe("company_api_key");
  });

  // Fail-closed default: no canary authority + the binding's null credentialKind → null →
  // the mint refuses (owner_authority_disagreement) → no handle → the run degrades to legacy.
  it("falls back to the binding's null when no authority is supplied (fail-closed)", () => {
    expect(mintCredentialKindFor(undefined, null)).toBeNull();
    expect(mintCredentialKindFor(null, null)).toBeNull();
  });

  // Legacy / non-canary passthrough: with no out-of-band authority, the mint sources
  // exactly what the binding resolved — byte-identical to pre-CLI-007 behaviour.
  it("passes the binding's own credentialKind through untouched when no authority is supplied", () => {
    expect(mintCredentialKindFor(undefined, "company_api_key")).toBe("company_api_key");
    expect(mintCredentialKindFor(undefined, "personal_subscription")).toBe("personal_subscription");
  });

  it("the canary rides the COMPANY key, never a personal subscription", () => {
    expect(CANARY_CREDENTIAL_AUTHORITY).toBe("company_api_key");
    expect(CANARY_CREDENTIAL_AUTHORITY).not.toBe("personal_subscription");
  });
});

describe("CLI-007 — the canary mint delivers a REFERENCE, never a value (Decision #104)", () => {
  const CLAUDE_TARGET: ProviderKeyTarget = {
    ownerId: "anthropic",
    secretName: "provider:anthropic",
    envVar: "ANTHROPIC_API_KEY",
  };
  // The exact shape a REAL canary coding run presents at the mint once CLI-007 supplies the
  // authority: cloud sandbox, a `worker` executor (the real kind a task_run is stamped with,
  // NOT the phantom "agent" — Decision #121), a v1 adapter, an `organization_dedicated`
  // placement (E11-F004 routes the canary slug to an org `dedicated_worker`; the mint gate
  // reads owner-agreement, and `organization_dedicated` is not `owner_desktop`, so it mints
  // identically to the old managed_cloud shape), company_api_key authority, no per-agent override.
  const canaryMintInput: ExecutionSecretMintInput = {
    deploymentMode: "cloud_auth",
    adapterType: "claude_local",
    executorPrincipalKind: "worker",
    providerKeyTarget: CLAUDE_TARGET,
    providerBinding: null,
    placementOwner: "organization_dedicated",
    credentialKind: CANARY_CREDENTIAL_AUTHORITY,
    targetGeneration: 7,
  };

  it("mints a provider_key handle pointing at the Company key by NAME (a reference)", () => {
    const decision = decideExecutionSecretHandle(canaryMintInput);
    expect(decision).toEqual({
      mint: true,
      refKind: "provider_key",
      refId: "provider:anthropic", // the secret NAME, not its value
      envTarget: "ANTHROPIC_API_KEY", // the env var NAME the worker will set
      secretVersion: null,
      boundTargetGeneration: 7,
    });
  });

  it("carries no secret VALUE anywhere in the envelope ref (Decision #104)", () => {
    const decision = decideExecutionSecretHandle(canaryMintInput);
    if (!decision.mint) throw new Error("expected a mint");
    // A concrete (planted) secret value that must NEVER appear in the ref/envelope.
    const PLANTED = "sk-ant-PLANTED-canary-key-do-not-leak";
    const [ref] = toSecretHandleRefs([
      {
        handle: "11111111-1111-4111-8111-111111111111",
        materialization: "env",
        materializationTarget: decision.envTarget,
        usePolicy: "sandbox_local_only",
      },
    ]);
    expect(ref).toEqual({
      handleId: "11111111-1111-4111-8111-111111111111",
      materialization: { kind: "env", target: "ANTHROPIC_API_KEY" },
      usePolicy: "sandbox_local_only",
    });
    // The value is resolved ONLY inside the sandbox (usePolicy sandbox_local_only) by
    // the worker's synthesiseRunSecrets, seeded as a redaction canary (DAT-008 slice 5).
    // It never enters the mint decision or the wire ref.
    expect(JSON.stringify({ decision, ref })).not.toContain(PLANTED);
    expect(JSON.stringify({ decision, ref })).not.toContain("sk-ant");
  });
});
