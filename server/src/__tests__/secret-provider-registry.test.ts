import { describe, expect, it } from "vitest";
import { checkSecretProviders, getSecretProvider, listSecretProviders } from "../secrets/provider-registry.js";

describe("secret provider registry", () => {
  it("lists local ready, AWS configurable, and future providers as coming soon", async () => {
    expect(getSecretProvider("local_encrypted").descriptor.configured).toBe(true);
    expect(listSecretProviders().map((provider) => provider.id)).toContain("aws_secrets_manager");

    const checked = await checkSecretProviders([
      {
        id: "cfg-1",
        provider: "aws_secrets_manager",
        status: "ready",
        config: { region: "us-east-1", secretNamePrefix: "aoa/prod" },
      },
    ]);

    expect(checked.find((provider) => provider.id === "local_encrypted")?.status).toBe("ready");
    expect(checked.find((provider) => provider.id === "aws_secrets_manager")?.configured).toBe(true);
    expect(checked.find((provider) => provider.id === "gcp_secret_manager")?.status).toBe("coming_soon");
    expect(checked.find((provider) => provider.id === "vault")?.status).toBe("coming_soon");
  });
});
