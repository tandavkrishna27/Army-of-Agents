import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

interface ContractCase {
  name: string;
  schemaValid: boolean;
  input: unknown;
}

const contractDirectory = fileURLToPath(
  new URL("../../../docs/contracts/mcp-connectors/v1/", import.meta.url),
);

describe("MCP connector JSON Schema", () => {
  it("agrees with every schema-validity expectation in the conformance corpus", async () => {
    const [schemaSource, conformanceSource] = await Promise.all([
      readFile(`${contractDirectory}/schema.json`, "utf8"),
      readFile(`${contractDirectory}/conformance.json`, "utf8"),
    ]);
    const schema = JSON.parse(schemaSource) as object;
    const conformance = JSON.parse(conformanceSource) as {
      cases: ContractCase[];
    };
    const ajv = new Ajv2020({
      allErrors: true,
      strict: true,
      strictRequired: false,
    });
    addFormats(ajv);
    const validate = ajv.compile(schema);

    for (const testCase of conformance.cases) {
      expect(
        validate(testCase.input),
        `${testCase.name}: ${JSON.stringify(validate.errors)}`,
      ).toBe(testCase.schemaValid);
    }
  });
});
