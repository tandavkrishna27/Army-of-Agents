import { describe, it, expect } from "vitest";
import {
  instanceAdminBootstrapEnabled,
  assertInstanceAdminBootstrapInvariant,
} from "../services/first-user-bootstrap.js";

describe("instanceAdminBootstrapEnabled", () => {
  it("is enabled for self-hosted modes", () => {
    expect(instanceAdminBootstrapEnabled("local_trusted")).toBe(true);
    expect(instanceAdminBootstrapEnabled("authenticated")).toBe(true);
  });
  it("is DISABLED for cloud_auth", () => {
    expect(instanceAdminBootstrapEnabled("cloud_auth")).toBe(false);
  });
});

describe("assertInstanceAdminBootstrapInvariant", () => {
  it("passes when cloud_auth bootstrap is disabled (the real resolver)", () => {
    expect(() => assertInstanceAdminBootstrapInvariant({ deploymentMode: "cloud_auth" })).not.toThrow();
  });
  it("throws if a tampered resolver would enable cloud_auth promotion", () => {
    expect(() =>
      assertInstanceAdminBootstrapInvariant({ deploymentMode: "cloud_auth" }, () => true),
    ).toThrow(/cloud_auth must not mint runtime instance_admin/i);
  });
});
