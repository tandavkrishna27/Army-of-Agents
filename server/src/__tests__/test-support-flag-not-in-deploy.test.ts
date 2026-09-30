import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const TOKENS = ["AOA_E2E_TEST_SUPPORT", "AOA_E2E_TEST_SUPPORT_TOKEN"];

function walk(dir: string, files: string[] = []): string[] {
  if (!existsSync(dir)) return files;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, files);
    else files.push(path);
  }
  return files;
}

describe("AOA_E2E_TEST_SUPPORT deployment leak gate", () => {
  it("is absent from production deployment inputs", () => {
    const rootDeploymentFiles = readdirSync(REPO)
      .filter((name) =>
        name === "Dockerfile" ||
        name.startsWith("Dockerfile.") ||
        name.startsWith("docker-compose") ||
        name === ".env.example" ||
        name === ".env.production",
      )
      .map((name) => join(REPO, name))
      .filter((path) => statSync(path).isFile());
    const candidates = [
      ...walk(join(REPO, ".github", "workflows")),
      ...walk(join(REPO, "docs", "deploy")),
      ...walk(join(REPO, "scripts", "deploy")),
      ...walk(join(REPO, "docker")),
      ...walk(join(REPO, "releases")),
      ...rootDeploymentFiles,
    ];
    for (const token of TOKENS) {
      const offenders = candidates.filter((path) => {
        try {
          return readFileSync(path, "utf8").includes(token);
        } catch {
          return false;
        }
      });
      expect(offenders, `${token} leaked into deploy paths`).toEqual([]);
    }
  });
});
