import { describe, expect, it } from "vitest";
import {
  extractSecretRefPathsFromConfig,
  extractSecretRefsFromConfig,
} from "../services/plugin-secrets-handler.js";

const SECRET_ID = "123e4567-e89b-42d3-a456-426614174000";

describe("plugin secret config extraction", () => {
  it("returns schema-approved secret refs with their config paths", () => {
    const schema = {
      type: "object",
      properties: {
        apiKey: { type: "string", format: "secret-ref" },
        nested: {
          type: "object",
          properties: {
            ignored: { type: "string" },
          },
        },
      },
    };

    const paths = extractSecretRefPathsFromConfig(
      {
        apiKey: SECRET_ID,
        nested: { ignored: "00000000-0000-4000-8000-000000000000" },
      },
      schema,
    );

    expect(paths.get(SECRET_ID)).toBe("apiKey");
    expect([...extractSecretRefsFromConfig({ apiKey: SECRET_ID }, schema)]).toEqual([SECRET_ID]);
  });
});
