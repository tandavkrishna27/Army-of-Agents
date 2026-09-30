// DSK-001 Lane B / D10 — the device-local credential broker PORT.
//
// The one invariant: an activation is a REFERENCE, never bytes. `device_local`
// exists because the credential's value stays in the OS keystore, so a broker that
// could return the value would defeat the entire ref_kind.
//
// WHY THESE ARE RUNTIME CHECKS AND NOT TYPE ASSERTIONS. `server/tsconfig.json`
// carries `"exclude": ["src/__tests__"]` and vitest does no typechecking, so a
// `type _Assert = ...` in this file would compile nowhere and prove nothing — a
// guard born dead. Everything below is either executed or read off the source.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  failClosedDeviceLocalBroker,
  DEVICE_LOCAL_ACTIVATION_REFERENCE_KINDS,
} from "../services/device-local-broker.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, "..", "services", "device-local-broker.ts"), "utf8");

const HANDOFF = {
  refKind: "device_local" as const,
  refId: "b3f1c2d4-5e6a-4b7c-8d9e-0f1a2b3c4d5e",
  ownerPrincipalKind: "user",
  ownerPrincipalId: "u1",
  materialization: "file" as const,
  usePolicy: "sandbox_local_only" as const,
  companyId: "company-1",
  handleId: "handle-1",
  boundTargetGeneration: null,
  destination: null,
};

describe("DSK-001/D10 — the default broker is FAIL-CLOSED", () => {
  it("refuses to activate", async () => {
    await expect(failClosedDeviceLocalBroker.activate({ handoff: HANDOFF })).rejects.toThrow();
  });

  it("refuses to deactivate", async () => {
    await expect(failClosedDeviceLocalBroker.deactivate("activation-1")).rejects.toThrow();
  });

  it("names DSK-002 in the refusal, so an operator knows it is unwired and not broken", async () => {
    // Mirrors failClosedSecretBrokers' "(DAT-005)" convention: the message says WHICH
    // ticket wires it, which is the difference between "not built yet" and "failing".
    await expect(failClosedDeviceLocalBroker.activate({ handoff: HANDOFF }))
      .rejects.toThrow(/DSK-002/);
  });

  it("exposes EXACTLY two methods", async () => {
    // A frozen method set, same discipline as the handoff's frozen key set. A third
    // method — say `resolve()` returning a value — could not appear unnoticed.
    expect(Object.keys(failClosedDeviceLocalBroker).sort()).toEqual(["activate", "deactivate"]);
  });
});

describe("DSK-001/D10 — no type reachable from the port can carry a value", () => {
  it("declares no field whose name resembles a credential", () => {
    // Read off the source because types are erased: the property is about what the
    // module DECLARES, and there is no runtime object to inspect for an interface.
    const declaredFields = [...SOURCE.matchAll(/^\s+(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)\??:/gm)]
      .map((m) => m[1]!);
    // Non-vacuity: name two fields the scan MUST have found. A regex that matched
    // nothing would otherwise make the loop below trivially pass.
    expect(declaredFields).toContain("expiresAt");
    expect(declaredFields).toContain("activationId");
    for (const field of declaredFields) {
      const normalized = field.toLowerCase().replace(/[^a-z0-9]/g, "");
      for (const forbidden of ["value", "token", "secret", "credentialvalue", "bytes", "password", "apikey", "der"]) {
        expect(normalized, `declared field "${field}"`).not.toContain(forbidden);
      }
    }
  });

  it("offers only reference-shaped materializations", () => {
    // Each arm names a PLACE the consumer reads from — a path, a variable name, an
    // endpoint. None of them is the thing itself.
    expect([...DEVICE_LOCAL_ACTIVATION_REFERENCE_KINDS].sort())
      .toEqual(["env_name", "file_path", "proxy_endpoint"]);
  });

  it("keeps the proxy_endpoint arm, which DSK-002 needs", () => {
    // F24 admits device_local + fence_proxy deliberately, and DSK-002's outcome is to
    // mediate device-local handles through the fence-aware egress path. Dropping this
    // arm would force DSK-002 to widen the type immediately.
    expect(DEVICE_LOCAL_ACTIVATION_REFERENCE_KINDS).toContain("proxy_endpoint");
  });
});

describe("DSK-001/D10 — the port is NOT the value-returning broker set", () => {
  it("neither imports nor extends SecretBrokerSet", () => {
    // `SecretBrokerSet`'s two methods return Promise<string>: the Promise<string> IS
    // the leak. Merging or extending would inherit it. Structural incompatibility
    // makes that hard today, but hard is not the same as stated.
    //
    // Matched at the CODE level, not as a substring: this module's header explains
    // at length WHY it is separate from SecretBrokerSet, and a raw scan would flag
    // exactly that explanation. (Third time this shape has bitten in DSK-001 — a
    // checker that makes you delete the rationale is a bad checker.)
    const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/import[^;]*SecretBrokerSet/);
    expect(code).not.toMatch(/extends\s+SecretBrokerSet/);
    expect(code).not.toMatch(/:\s*SecretBrokerSet/);
  });

  it("declares no method returning a bare string", () => {
    const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/\)\s*:\s*Promise<string>/);
  });
});
