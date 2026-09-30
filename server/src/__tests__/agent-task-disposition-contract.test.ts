import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("default agent task disposition contract", () => {
  it("is present in generated onboarding AGENTS.md files", async () => {
    // Use import.meta.dirname (= server/src/__tests__) to get a stable path
    // regardless of which directory vitest is invoked from.
    const root = path.resolve(import.meta.dirname, "../onboarding-assets");
    const files = [
      "cxo/AGENTS.md",
      "default/AGENTS.md",
      "lead/AGENTS.md",
    ];

    for (const file of files) {
      const body = await fs.readFile(path.join(root, file), "utf8");
      expect(body).toContain("Task Disposition Contract");
      expect(body).toContain("Move the task to `done`");
      expect(body).toContain("Move the task to `in_review`");
      expect(body).toContain("Leave the task `in_progress`");
      expect(body).toContain("X-Aoa-Run-Id");
      expect(body).toContain("PATCH");
      expect(body).toContain("/api/issues/$AOA_TASK_ID");
    }
  });
});
