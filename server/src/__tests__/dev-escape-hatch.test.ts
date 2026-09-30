import { describe, it, expect, afterEach } from "vitest";
import {
  realUserExists,
  isEscapeHatchForced,
  assertEscapeHatchAllowed,
} from "../services/dev-escape-hatch.js";

const OLD = { ...process.env };
afterEach(() => {
  process.env = { ...OLD };
});

// Minimal chainable db stub: select().from().where().limit() → Promise<rows>.
const dbWith = (rows: unknown[]) =>
  ({
    select: () => ({ from: () => ({ where: () => ({ limit: async () => rows }) }) }),
  }) as any;

describe("dev escape hatch guard (RB4/R5)", () => {
  it("realUserExists true when a non-local-board user exists", async () => {
    expect(await realUserExists(dbWith([{ id: "u1" }]))).toBe(true);
  });

  it("realUserExists false when none", async () => {
    expect(await realUserExists(dbWith([]))).toBe(false);
  });

  it("isEscapeHatchForced reads AOA_DEV_LOCAL_IDENTITY_FORCE", () => {
    delete process.env.AOA_DEV_LOCAL_IDENTITY_FORCE;
    expect(isEscapeHatchForced()).toBe(false);
    process.env.AOA_DEV_LOCAL_IDENTITY_FORCE = "1";
    expect(isEscapeHatchForced()).toBe(true);
  });

  it("assertEscapeHatchAllowed throws on populated instance without force", async () => {
    delete process.env.AOA_DEV_LOCAL_IDENTITY_FORCE;
    await expect(assertEscapeHatchAllowed(dbWith([{ id: "u1" }]))).rejects.toThrow(/refused/i);
  });

  it("assertEscapeHatchAllowed passes on empty instance", async () => {
    delete process.env.AOA_DEV_LOCAL_IDENTITY_FORCE;
    await expect(assertEscapeHatchAllowed(dbWith([]))).resolves.toBeUndefined();
  });

  it("assertEscapeHatchAllowed passes when forced even if populated", async () => {
    process.env.AOA_DEV_LOCAL_IDENTITY_FORCE = "1";
    await expect(assertEscapeHatchAllowed(dbWith([{ id: "u1" }]))).resolves.toBeUndefined();
  });
});
