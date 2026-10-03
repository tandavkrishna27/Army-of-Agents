import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function workflow(relativePath: string): Record<string, any> {
  return parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

describe("local Docker trial workflow contract", () => {
  it("fetches bundled marketplace snapshots in the Docker build before compiling the app", () => {
    const dockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
    const prebuild = dockerfile.indexOf("RUN pnpm prebuild");
    const uiBuild = dockerfile.indexOf("RUN pnpm --filter @armyofagents/ui build");

    expect(prebuild).toBeGreaterThanOrEqual(0);
    expect(uiBuild).toBeGreaterThan(prebuild);
  });

  it("keeps Playwright reports and failure screenshots out of Docker images", () => {
    const dockerignore = fs.readFileSync(path.join(repoRoot, ".dockerignore"), "utf8");

    expect(dockerignore).toContain("tests/**/test-results");
    expect(dockerignore).toContain("tests/**/playwright-report");
  });

  it("runs the Docker trial as a required PR job and aggregates its result", () => {
    const pr = workflow(".github/workflows/pr.yml");
    const job = pr.jobs["docker-local-trial"];
    const required = pr.jobs["ci-required"];

    expect(job).toBeDefined();
    expect(job["runs-on"]).toBe("ubuntu-latest");
    expect(job.steps.some((step: { run?: string }) => step.run?.includes("docker:local-trial-smoke"))).toBe(true);
    expect(required.needs).toContain("docker-local-trial");
    expect(required.steps[0].env).toHaveProperty("R_DOCKER_LOCAL_TRIAL");
    expect(required.steps[0].run).toContain("docker-local-trial=$R_DOCKER_LOCAL_TRIAL");
    expect(required.steps[0].run).toContain('"docker-local-trial=$R_DOCKER_LOCAL_TRIAL"');
  });

  it("runs local Compose and provider contracts on both advisory desktop platforms", () => {
    const weekly = workflow(".github/workflows/cross-platform-weekly.yml");
    const job = weekly.jobs["verify-cross-platform"];

    expect(job.strategy.matrix.os).toEqual(expect.arrayContaining(["macos-latest", "windows-latest"]));
    expect(job["continue-on-error"]).toBe(true);
    expect(job.steps.some((step: { run?: string }) =>
      step.run?.includes("docker-local-compose.test.ts") && step.run.includes("cli-auth-topology.test.ts"),
    )).toBe(true);
  });
});
