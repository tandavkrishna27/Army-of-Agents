import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

function readCompose(relativePath: string): Record<string, any> {
  return parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

describe("local Docker trial Compose contract", () => {
  it("uses local-trusted single-user settings and an isolated persistent AoA volume", () => {
    const compose = readCompose("docker-compose.local.yml");
    const service = compose.services.aoa;
    const env = service.environment;

    expect(env).toMatchObject({
      HOST: "127.0.0.1",
      PORT: "3100",
      AOA_DEPLOYMENT_MODE: "local_trusted",
      AOA_DEPLOYMENT_EXPOSURE: "private",
      AOA_DEV_LOCAL_IDENTITY: "1",
      AOA_INSTALL_PROFILE: "local_single_user",
      AOA_NETWORK_LOCATION: "local",
      AOA_TRUST_BOUNDARY: "single_user",
      AOA_EXECUTION_OWNERSHIP: "user_hosted",
      AOA_HOME: "/aoa",
      AOA_MARKETPLACE_SKILLS_WRITE_ROOT: "persistent",
      AOA_CREW_INSTALL_DEADLINE_MS: "90000",
    });
    expect(service.volumes).toContain("aoa-local-trial-data:/aoa");
    expect(compose.volumes["aoa-local-trial-data"]).toBeDefined();
    expect(service.depends_on).toBeUndefined();
  });

  it("keeps the app listener on loopback and publishes only the relay on host loopback", () => {
    const service = readCompose("docker-compose.local.yml").services.aoa;
    const published = service.ports;

    expect(published).toEqual([
      expect.objectContaining({
        host_ip: "127.0.0.1",
        target: 3101,
        published: "${AOA_PORT:-3100}",
        protocol: "tcp",
      }),
    ]);
    expect(service.command.join(" ")).toContain("TCP-LISTEN:3101");
    expect(service.command.join(" ")).toContain("TCP:127.0.0.1:3100");
    expect(service.healthcheck.test.join(" ")).toContain("127.0.0.1");
    expect(service.healthcheck.test.join(" ")).toContain("3101");
  });

  it("does not require Google OAuth or DATABASE_URL", () => {
    const compose = readCompose("docker-compose.local.yml");
    const env = compose.services.aoa.environment as Record<string, unknown>;

    expect(Object.keys(env)).not.toEqual(
      expect.arrayContaining([
        "GOOGLE_CLIENT_ID",
        "GOOGLE_CLIENT_SECRET",
        "DATABASE_URL",
        "AOA_POSTGRES_PASSWORD",
      ]),
    );
    expect(compose.services.db).toBeUndefined();
  });

  it("leaves both existing Compose deployments authenticated", () => {
    for (const filename of [
      "docker-compose.yml",
      "docker-compose.quickstart.yml",
    ]) {
      const compose = readCompose(filename);
      const env =
        filename === "docker-compose.yml"
          ? compose["x-aoa-env"]
          : compose.services.aoa.environment;
      const mode = env.AOA_DEPLOYMENT_MODE;
      expect(String(mode)).toMatch(/authenticated/);
      expect(String(env.GOOGLE_CLIENT_ID)).toMatch(/GOOGLE_CLIENT_ID/);
      expect(String(env.GOOGLE_CLIENT_SECRET)).toMatch(/GOOGLE_CLIENT_SECRET/);
    }
  });
});
