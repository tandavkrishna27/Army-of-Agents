import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error The deployment helper is intentionally executable plain ESM.
import {
  composeEvidenceFromDocker,
  evaluatePreflight,
  MARKETPLACE_RECOVERY_PREFLIGHT_REQUESTS,
  sanitizePreflightError,
} from "../../../scripts/lib/marketplace-recovery-preflight.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const SCRIPT = resolve(
  REPO_ROOT,
  "scripts/verify-marketplace-recovery-preflight.mjs",
);
const SHA = "a".repeat(40);

function run(args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      AOA_API_KEY: "",
      AOA_API_URL: "",
      AOA_DEPLOY_SHA: "",
    },
  });
}

describe("marketplace recovery preflight input boundary", () => {
  it("authenticates every protected preflight endpoint while keeping health public", () => {
    expect(MARKETPLACE_RECOVERY_PREFLIGHT_REQUESTS).toEqual([
      {
        key: "health",
        endpoint: "/api/health",
        authenticated: false,
      },
      {
        key: "catalog",
        endpoint: "/api/marketplace/catalog/status",
        authenticated: true,
      },
      {
        key: "identity",
        endpoint: "/api/cli-auth/me",
        authenticated: true,
      },
    ]);
  });

  it.each([
    [
      [
        "--api-base",
        "https://testing.armyofagents.org",
        "--expected-sha",
        "main",
      ],
      "--expected-sha must be exactly 40 lowercase hexadecimal characters",
    ],
    [
      [
        "--api-base",
        "https://secret@example.test",
        "--expected-sha",
        SHA,
      ],
      "--api-base must be a credential-free HTTP(S) origin",
    ],
    [
      [
        "--api-base",
        "https://testing.armyofagents.org",
        "--expected-sha",
        SHA,
        "--instance-id",
        "../other",
      ],
      "--instance-id must contain only",
    ],
    [
      [
        "--api-base",
        "https://testing.armyofagents.org",
        "--expected-sha",
        SHA,
        "--write-root",
        "arbitrary",
      ],
      "--write-root must be legacy or persistent",
    ],
  ])("rejects unsafe input before reading credentials", (args, error) => {
    const result = run(args);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(error);
  });

  it("accepts matching health, catalog, identity, and Docker evidence", () => {
    const compose = composeEvidenceFromDocker(
      JSON.stringify([
        { Service: "server", State: "running", ID: "container-1" },
      ]),
      JSON.stringify([
        {
          Config: {
            Env: [
              "AOA_INSTANCE_ID=testing",
              "AOA_MARKETPLACE_SKILLS_WRITE_ROOT=persistent",
            ],
            Labels: { "org.opencontainers.image.revision": SHA },
          },
          Mounts: [{ Destination: "/aoa", RW: true }],
        },
      ]),
    );
    const result = evaluatePreflight({
      health: { status: "ok", revision: SHA },
      catalog: { lastSyncStatus: "success", source: "cdn" },
      identity: { isInstanceAdmin: true },
      compose,
      expectedSha: SHA,
      expectedSelector: "persistent",
      expectedInstanceId: "testing",
    });

    expect(result).toEqual({
      ok: true,
      checks: expect.objectContaining({
        deploymentSha: true,
        oneServerReplica: true,
        aoaVolume: true,
        catalog: true,
        instanceAdmin: true,
      }),
    });
    expect(compose).toMatchObject({
      containerId: "container-1",
      persistentRoot: "/aoa/instances/testing/marketplace-skills",
    });
  });

  it("reports exact mismatch checks without exposing credentials", () => {
    const compose = {
      replicaCount: 1,
      hasAoaMount: false,
      selector: "legacy",
      instanceId: "default",
      persistentRoot: "/aoa/instances/default/marketplace-skills",
      imageRevision: "b".repeat(40),
    };
    const result = evaluatePreflight({
      health: { status: "ok", revision: SHA },
      catalog: { lastSyncStatus: "failure", source: "bundled" },
      identity: { isInstanceAdmin: false },
      compose,
      expectedSha: SHA,
      expectedSelector: "persistent",
      expectedInstanceId: "testing",
    });

    expect(result.ok).toBe(false);
    expect(result.checks).toMatchObject({
      health: true,
      deploymentSha: false,
      oneServerReplica: true,
      aoaVolume: false,
      writeSelector: false,
      instanceId: false,
      persistentRoot: false,
      catalog: false,
      instanceAdmin: false,
    });
  });

  it("redacts credentials, signed URLs, and local paths from failure output", () => {
    const secret = `sk-ant-${"a".repeat(24)}`;
    const result = sanitizePreflightError(
      `Bearer ${secret} at C:\\Users\\operator\\auth.json from https://user:pass@example.test/catalog?token=hidden`,
    );

    expect(result).toContain("[redacted]");
    expect(result).toContain("[redacted-path]");
    expect(result).not.toContain(secret);
    expect(result).not.toContain("operator");
    expect(result).not.toContain("user:pass");
    expect(result).not.toContain("token=hidden");
  });

  it.each([
    [[]],
    [[
      { Service: "server", State: "running", ID: "one" },
      { Service: "server", State: "running", ID: "two" },
    ]],
  ])(
    "fails closed unless exactly one server replica is running",
    (servers) => {
      expect(() =>
        composeEvidenceFromDocker(
          JSON.stringify(servers),
          JSON.stringify([]),
        ),
      ).toThrow(/exactly one running server replica/);
    },
  );
});
