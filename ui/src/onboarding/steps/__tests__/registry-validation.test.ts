import { describe, expect, it } from "vitest";
import { ONBOARDING_REGISTRY_VALIDATION_ERRORS } from "../index";

describe("assembled onboarding registry", () => {
  it("passes the boot-time registry validation guard", () => {
    expect(ONBOARDING_REGISTRY_VALIDATION_ERRORS).toEqual([]);
  });
});
