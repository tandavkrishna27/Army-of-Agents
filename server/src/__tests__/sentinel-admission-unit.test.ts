// server/src/__tests__/sentinel-admission-unit.test.ts
//
// TEN-006b — Windows-visible plain unit proof for the sentinel/unmapped
// admission-denial helper (server/src/services/tenant-admission.ts).
//
// This is the cross-platform sibling to the embedded-PG
// sentinel-org-removal.integration.test.ts (E2-D05): no database, no env-hatch —
// it runs in the always-on gate on every platform. It proves the helper mirrors
// FND-007's forbiddenOrganizationSentinels exactly and denies BOTH sentinel forms
// while admitting a normal Organization uuid.
//
// At E2 the helper is DORMANT (no runtime caller); it enforces the SENTINEL
// rejection only. The UNMAPPED (Organization-does-not-exist) check and the
// submit/place/lease wiring are E3 (JOB-001/JOB-010) — see E2-D07.
//
// RED (before server/src/services/tenant-admission.ts exists): the import fails to
// resolve, so the whole suite fails to collect. GREEN (after the helper lands):
// every assertion below passes.
import { describe, it, expect } from "vitest";
import {
  FORBIDDEN_ORGANIZATION_SENTINELS,
  ForbiddenOrganizationSentinelError,
  isForbiddenOrganizationSentinel,
  assertAdmissibleOrganization,
} from "../services/tenant-admission.js";

// The two values are the authority in
// docs/architecture/distributed-execution-legacy-parity.json:15-19 (FND-007,
// locked by Decision #121). If FND-007 changes, this list changes with it.
const SENTINEL_UUID = "00000000-0000-0000-0000-000000000001";
const SENTINEL_NIL_ULID = "org_00000000000000000000000000";
// A perfectly ordinary Organization uuid (NOT a sentinel).
const REAL_ORG = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

describe("tenant-admission — forbidden sentinel set mirrors FND-007", () => {
  it("exports exactly the two FND-007 forbidden sentinels", () => {
    expect([...FORBIDDEN_ORGANIZATION_SENTINELS].sort()).toEqual(
      [SENTINEL_NIL_ULID, SENTINEL_UUID].sort(),
    );
    expect(FORBIDDEN_ORGANIZATION_SENTINELS).toHaveLength(2);
  });

  it("the exported set is frozen (readonly authority mirror)", () => {
    expect(Object.isFrozen(FORBIDDEN_ORGANIZATION_SENTINELS)).toBe(true);
  });
});

describe("isForbiddenOrganizationSentinel", () => {
  it("returns true for BOTH FND-007 sentinel forms", () => {
    expect(isForbiddenOrganizationSentinel(SENTINEL_UUID)).toBe(true);
    expect(isForbiddenOrganizationSentinel(SENTINEL_NIL_ULID)).toBe(true);
  });

  it("returns false for a normal Organization uuid", () => {
    expect(isForbiddenOrganizationSentinel(REAL_ORG)).toBe(false);
  });

  it("matches case-insensitively and ignores surrounding whitespace", () => {
    expect(isForbiddenOrganizationSentinel(`  ${SENTINEL_UUID}  `)).toBe(true);
    expect(isForbiddenOrganizationSentinel("ORG_00000000000000000000000000")).toBe(true);
    expect(isForbiddenOrganizationSentinel(`\t${SENTINEL_NIL_ULID}\n`)).toBe(true);
  });

  it("does not treat the empty string or a benign value as a sentinel", () => {
    expect(isForbiddenOrganizationSentinel("")).toBe(false);
    expect(isForbiddenOrganizationSentinel("default")).toBe(false);
  });
});

describe("assertAdmissibleOrganization", () => {
  it("throws a typed error for BOTH sentinel forms", () => {
    expect(() => assertAdmissibleOrganization(SENTINEL_UUID)).toThrow(
      ForbiddenOrganizationSentinelError,
    );
    expect(() => assertAdmissibleOrganization(SENTINEL_NIL_ULID)).toThrow(
      ForbiddenOrganizationSentinelError,
    );
  });

  it("throws for a whitespace/case-padded sentinel too", () => {
    expect(() => assertAdmissibleOrganization(`  ${SENTINEL_UUID}  `)).toThrow(
      ForbiddenOrganizationSentinelError,
    );
    expect(() =>
      assertAdmissibleOrganization("ORG_00000000000000000000000000"),
    ).toThrow(ForbiddenOrganizationSentinelError);
  });

  it("does NOT throw for a real Organization id", () => {
    expect(() => assertAdmissibleOrganization(REAL_ORG)).not.toThrow();
  });

  it("the typed error names the offending Organization for auditability", () => {
    let caught: unknown;
    try {
      assertAdmissibleOrganization(SENTINEL_UUID);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ForbiddenOrganizationSentinelError);
    expect((caught as ForbiddenOrganizationSentinelError).organizationId).toBe(SENTINEL_UUID);
    expect((caught as Error).message).toContain(SENTINEL_UUID);
  });
});
