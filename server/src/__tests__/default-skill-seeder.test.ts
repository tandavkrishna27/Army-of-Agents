/**
 * Tests for seedDefaultCommanderSkills (T3.6 stub — no-op since v1.1).
 *
 * The function is dead code for v1.1: skills are installed via marketplace
 * team packages. These tests verify the stub resolves without throwing and
 * never touches the DB or installSkill.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@armyofagents/db", () => ({}));
vi.mock("drizzle-orm", () => ({}));

import { seedDefaultCommanderSkills } from "../services/marketplace-install/default-skill-seeder.js";

describe("seedDefaultCommanderSkills (no-op stub)", () => {
  it("resolves without throwing", async () => {
    await expect(
      seedDefaultCommanderSkills({ db: {} as any, companyId: "c1" }),
    ).resolves.toBeUndefined();
  });

  it("resolves without throwing for any companyId", async () => {
    await expect(
      seedDefaultCommanderSkills({ db: {} as any, companyId: "any-id" }),
    ).resolves.toBeUndefined();
  });
});
