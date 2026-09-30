import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

describe("AOA Docker data layout and CLI compatibility", () => {
  it("uses /aoa as the canonical home while retaining only a legacy symlink", () => {
    const dockerfile = read("Dockerfile");
    expect(dockerfile).toContain("HOME=/aoa");
    expect(dockerfile).toContain("AOA_HOME=/aoa");
    expect(dockerfile).toContain('VOLUME ["/aoa"]');
    expect(dockerfile).toContain("ln -s /aoa /paperclip");
    expect(dockerfile).not.toContain("HOME=/paperclip");
  });

  it("mounts the unchanged named volume at /aoa and exposes explicit auth policy flags", () => {
    const compose = read("docker-compose.yml");
    expect(compose).toContain("aoa-data:/aoa");
    expect(compose).not.toContain("aoa-data:/paperclip");
    expect(compose).toContain("AOA_INSTALL_PROFILE:");
    expect(compose).toContain("AOA_CODEX_DEVICE_AUTH:");
    expect(compose).toContain("AOA_CLAUDE_PASTE_AUTH:");
    expect(compose).toContain(
      "AOA_MARKETPLACE_SKILLS_WRITE_ROOT: ${AOA_MARKETPLACE_SKILLS_WRITE_ROOT:-legacy}",
    );
  });

  it("fails closed for an old Compose mount and records a data-layout sentinel", () => {
    const entrypoint = read("scripts/docker-entrypoint.sh");
    expect(entrypoint).toContain('[ ! -L /paperclip ]');
    expect(entrypoint).toContain(".aoa-data-layout-version");
    expect(entrypoint).toContain("unsupported AOA data-layout version");
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
            ...process.env,
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
        'AOA_MARKETPLACE_SKILLS_WRITE_ROOT="legacy"',
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
