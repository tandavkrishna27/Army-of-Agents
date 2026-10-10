import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { managedCatalogSkillDir } from "../services/marketplace-install/skill-bundle-materializer.js";
import { managedMarketplaceSkillsRoot } from "../services/marketplace-install/managed-skills-root.js";

const root = path.resolve(import.meta.dirname, "../../..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

describe("AOA Docker data layout and CLI compatibility", () => {
  it("uses /aoa as the canonical home", () => {
    const dockerfile = read("Dockerfile");
    expect(dockerfile).toContain("HOME=/aoa");
    expect(dockerfile).toContain("AOA_HOME=/aoa");
    expect(dockerfile).toContain('VOLUME ["/aoa"]');
    expect(dockerfile).not.toContain("ln -s /aoa /aoa");
  });

  it("mounts the unchanged named volume at /aoa and exposes explicit auth policy flags", () => {
    const compose = read("docker-compose.yml");
    expect(compose).toContain("aoa-data:/aoa");
    expect(compose).toContain("AOA_INSTALL_PROFILE:");
    expect(compose).toContain("AOA_CODEX_DEVICE_AUTH:");
    expect(compose).toContain("AOA_CLAUDE_PASTE_AUTH:");
    expect(compose).toContain(
      "AOA_MARKETPLACE_SKILLS_WRITE_ROOT: ${AOA_MARKETPLACE_SKILLS_WRITE_ROOT:-persistent}",
    );
  });

  it("creates and reads a managed bundle under an isolated persistent data-volume root", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "aoa-marketplace-volume-"));
    const previousHome = process.env.AOA_HOME;
    const previousSelector = process.env.AOA_MARKETPLACE_SKILLS_WRITE_ROOT;

    try {
      process.env.AOA_HOME = tempHome;
      process.env.AOA_MARKETPLACE_SKILLS_WRITE_ROOT = "persistent";

      const bundleDir = managedCatalogSkillDir("company-1", "research", "1.0.0");
      const markdown = "# Persistent managed skill\n";
      fs.mkdirSync(bundleDir, { recursive: true });
      fs.writeFileSync(path.join(bundleDir, "SKILL.md"), markdown);

      expect(managedMarketplaceSkillsRoot()).toBe(
        path.join(tempHome, "instances", "default", "marketplace-skills"),
      );
      expect(path.relative(path.resolve(tempHome), path.resolve(bundleDir))).toBe(
        path.join("instances", "default", "marketplace-skills", "company-1", "research", "1.0.0"),
      );
      expect(fs.readFileSync(path.join(bundleDir, "SKILL.md"), "utf8")).toBe(markdown);
      expect(path.resolve(bundleDir)).not.toBe(
        path.join(process.cwd(), ".aoa", "marketplace-skills", "company-1", "research", "1.0.0"),
      );
    } finally {
      if (previousHome === undefined) delete process.env.AOA_HOME;
      else process.env.AOA_HOME = previousHome;
      if (previousSelector === undefined) delete process.env.AOA_MARKETPLACE_SKILLS_WRITE_ROOT;
      else process.env.AOA_MARKETPLACE_SKILLS_WRITE_ROOT = previousSelector;
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("records a data-layout sentinel", () => {
    const entrypoint = read("scripts/docker-entrypoint.sh");
    expect(entrypoint).toContain(".aoa-data-layout-version");
    expect(entrypoint).toContain("unsupported AOA data-layout version");
  });

  it("repairs canonical provider-home ownership for local single-user Docker", () => {
    const entrypoint = read("scripts/docker-entrypoint.sh");
    expect(entrypoint).toContain('if [ "${AOA_INSTALL_PROFILE:-}" = "local_single_user" ]; then');
    expect(entrypoint).toContain('"$AOA_HOME/.codex"');
    expect(entrypoint).toContain('"$AOA_HOME/.claude"');
  });

  it("pins the two authentication-critical CLI versions", () => {
    const dockerfile = read("Dockerfile");
    expect(dockerfile).toContain("ARG CODEX_CLI_VERSION=");
    expect(dockerfile).toContain("ARG CLAUDE_CODE_VERSION=");
    expect(dockerfile).toContain("@openai/codex@${CODEX_CLI_VERSION}");
    expect(dockerfile).toContain("@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}");
    expect(dockerfile).not.toContain("@openai/codex@latest");
    expect(dockerfile).not.toContain("@anthropic-ai/claude-code@latest");
  });

  it("deploys the dedicated Hetzner QA topology with both subscription flows enabled", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aoa-compose-env-"));
    const outputPath = path.join(tempDir, "testing.env");

    try {
      execFileSync(
        process.execPath,
        [path.join(root, "scripts/deploy/write-compose-env.mjs"), outputPath],
        {
          env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            TEMP: process.env.TEMP,
            TMP: process.env.TMP,
            AOA_POSTGRES_PASSWORD: "postgres-test-secret",
            BETTER_AUTH_SECRET: "better-auth-test-secret",
            AOA_AGENT_JWT_SECRET: "agent-jwt-test-secret",
            GOOGLE_CLIENT_ID: "google-client-test-id",
            GOOGLE_CLIENT_SECRET: "google-client-test-secret",
          },
        },
      );

      const generated = fs.readFileSync(outputPath, "utf8");
      expect(generated).toContain('AOA_INSTALL_PROFILE="remote_single_tenant"');
      expect(generated).toContain('AOA_CODEX_DEVICE_AUTH="true"');
      expect(generated).toContain('AOA_CLAUDE_PASTE_AUTH="true"');
      expect(generated).toContain('AOA_EXECUTION_TARGET_ID="hetzner-qa"');
      expect(generated).toContain('AOA_SCOPED_CLI_AUTH="true"');
      expect(generated).toContain(
        'AOA_MARKETPLACE_SKILLS_WRITE_ROOT="persistent"',
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
