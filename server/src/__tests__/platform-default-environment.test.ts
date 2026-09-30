import { describe, expect, it } from "vitest";
import {
  resolvePlatformDefaultEnvironment,
  derivePlatformDefaultEnvironmentId,
  ensurePlatformDefaultEnvironmentRow,
} from "../services/platform-default-environment.js";

const COMPANY = "00000000-0000-0000-0000-000000000001";
const COMPANY_2 = "00000000-0000-0000-0000-000000000002";

describe("resolvePlatformDefaultEnvironment", () => {
  it("synthesizes a cloud e2b platform environment when E2B_API_KEY is set", () => {
    const env = resolvePlatformDefaultEnvironment({
      companyId: COMPANY,
      deploymentMode: "cloud_auth",
      env: { E2B_API_KEY: "op-key", E2B_TEMPLATE: "aoa-base", E2B_DOMAIN: "e2b.aoa.internal" },
    });
    expect(env).not.toBeNull();
    expect(env!.driver).toBe("sandbox");
    expect(env!.companyId).toBe(COMPANY);
    expect(env!.config).toMatchObject({ provider: "e2b", template: "aoa-base", domain: "e2b.aoa.internal" });
    expect(env!.target).toBeNull();
    expect(env!.executionTargetId).toBeNull();
  });

  it("returns null off-cloud (desktop/local_trusted keeps host execution)", () => {
    expect(
      resolvePlatformDefaultEnvironment({
        companyId: COMPANY,
        deploymentMode: "local_trusted",
        env: { E2B_API_KEY: "op-key" },
      }),
    ).toBeNull();
  });

  it("returns null on cloud when no operator E2B_API_KEY is configured", () => {
    expect(
      resolvePlatformDefaultEnvironment({
        companyId: COMPANY,
        deploymentMode: "cloud_auth",
        env: {},
      }),
    ).toBeNull();
  });

  it("does NOT leak operator secrets into the synthesized config", () => {
    const env = resolvePlatformDefaultEnvironment({
      companyId: COMPANY,
      deploymentMode: "cloud_auth",
      env: { E2B_API_KEY: "op-key" },
    });
    expect(JSON.stringify(env!.config)).not.toContain("op-key");
  });
});

describe("derivePlatformDefaultEnvironmentId", () => {
  it("is deterministic: same companyId always derives the same id", () => {
    const a = derivePlatformDefaultEnvironmentId(COMPANY);
    const b = derivePlatformDefaultEnvironmentId(COMPANY);
    expect(a).toBe(b);
  });

  it("derives a different id per company", () => {
    expect(derivePlatformDefaultEnvironmentId(COMPANY)).not.toBe(
      derivePlatformDefaultEnvironmentId(COMPANY_2),
    );
  });

  it("is never the synthetic cosmetic id", () => {
    expect(derivePlatformDefaultEnvironmentId(COMPANY)).not.toBe("platform-default-e2b");
  });

  it("is a well-formed RFC 4122 UUIDv5 (version + variant bits set)", () => {
    const id = derivePlatformDefaultEnvironmentId(COMPANY);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("ensurePlatformDefaultEnvironmentRow", () => {
  it("returns null off-cloud WITHOUT touching the database", async () => {
    const dbThatMustNotBeTouched = {
      insert: () => {
        throw new Error("must not touch the db when there is no platform default to materialize");
      },
      select: () => {
        throw new Error("must not touch the db when there is no platform default to materialize");
      },
    } as never;
    const result = await ensurePlatformDefaultEnvironmentRow(
      dbThatMustNotBeTouched,
      COMPANY,
      "local_trusted",
      { E2B_API_KEY: "op-key" },
    );
    expect(result).toBeNull();
  });

  it("returns null on cloud with no operator E2B_API_KEY, WITHOUT touching the database", async () => {
    const dbThatMustNotBeTouched = {
      insert: () => {
        throw new Error("must not touch the db when there is no platform default to materialize");
      },
      select: () => {
        throw new Error("must not touch the db when there is no platform default to materialize");
      },
    } as never;
    const result = await ensurePlatformDefaultEnvironmentRow(
      dbThatMustNotBeTouched,
      COMPANY,
      "cloud_auth",
      {},
    );
    expect(result).toBeNull();
  });
});
