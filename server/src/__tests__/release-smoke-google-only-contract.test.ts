import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function repoFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("release smoke Google-only auth contract", () => {
  it("boots the deterministic Docker harness through local_trusted identity", () => {
    const harness = repoFile("scripts/docker-onboard-smoke.sh");
    const dockerfile = repoFile("Dockerfile.onboard-smoke");

    expect(harness).toContain('AOA_DEPLOYMENT_MODE="${AOA_DEPLOYMENT_MODE:-local_trusted}"');
    expect(harness).toContain('AOA_DEV_LOCAL_IDENTITY="${AOA_DEV_LOCAL_IDENTITY:-1}"');
    expect(harness).toContain('-e AOA_DEV_LOCAL_IDENTITY="$AOA_DEV_LOCAL_IDENTITY"');
    expect(harness).toContain('-p "$HOST_PORT:3101"');
    expect(dockerfile).toContain("HOST=127.0.0.1");
    expect(dockerfile).toContain("socat TCP-LISTEN:3101");
    expect(harness).not.toContain("/api/auth/sign-up/email");
    expect(harness).not.toContain("/api/auth/sign-in/email");
    expect(harness).not.toContain("SMOKE_ADMIN_PASSWORD");
  });

  it("drives the current founder flow without retired email/password controls", () => {
    const spec = repoFile("tests/release-smoke/docker-auth-onboarding.spec.ts");

    expect(spec).toContain('name: "Your profile"');
    expect(spec).toContain('name: "Create your organization"');
    expect(spec).toContain('name: "Set up your environment"');
    expect(spec).not.toContain('input[type="email"]');
    expect(spec).not.toContain('input[type="password"]');
    expect(spec).not.toContain('name: "Sign In"');
  });

  it("does not pass retired email credentials through the release workflow", () => {
    const workflow = repoFile(".github/workflows/release-smoke.yml");

    expect(workflow).not.toContain("SMOKE_ADMIN_EMAIL");
    expect(workflow).not.toContain("SMOKE_ADMIN_PASSWORD");
    expect(workflow).not.toContain("AOA_RELEASE_SMOKE_EMAIL");
    expect(workflow).not.toContain("AOA_RELEASE_SMOKE_PASSWORD");
  });
});
