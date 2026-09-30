import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseMcpConnectorCatalog } from "../mcp-connector-catalog.js";

interface ConformanceExpected {
  acceptedIds: string[];
  droppedIds: string[];
  malformed: boolean;
  displayNamesById?: Record<string, string>;
  trustTiersById?: Record<string, string>;
  absentKeysById?: Record<string, string[]>;
}

interface ConformanceCase {
  name: string;
  input: unknown;
  expected: ConformanceExpected;
}

const contractDirectory = fileURLToPath(
  new URL("../../../../docs/contracts/mcp-connectors/v1/", import.meta.url),
);

async function readContractFile(name: string): Promise<string> {
  return readFile(`${contractDirectory}/${name}`, "utf8");
}

describe("MCP connector producer/consumer contract", () => {
  it("matches every checked-in conformance vector", async () => {
    const document = JSON.parse(await readContractFile("conformance.json")) as {
      contractVersion: string;
      cases: ConformanceCase[];
    };
    expect(document.contractVersion).toBe("1.0.0");

    for (const testCase of document.cases) {
      const result = parseMcpConnectorCatalog(testCase.input);
      expect(result.entries.map((entry) => entry.id), testCase.name).toEqual(
        testCase.expected.acceptedIds,
      );
      expect(result.dropped, testCase.name).toEqual(testCase.expected.droppedIds);
      expect(result.malformed, testCase.name).toBe(testCase.expected.malformed);

      for (const [id, displayName] of Object.entries(
        testCase.expected.displayNamesById ?? {},
      )) {
        expect(
          result.entries.find((entry) => entry.id === id)?.displayName,
          testCase.name,
        ).toBe(displayName);
      }
      for (const [id, tier] of Object.entries(
        testCase.expected.trustTiersById ?? {},
      )) {
        expect(
          result.entries.find((entry) => entry.id === id)?.trust.tier,
          testCase.name,
        ).toBe(tier);
      }
      for (const [id, absentKeys] of Object.entries(
        testCase.expected.absentKeysById ?? {},
      )) {
        const entry = result.entries.find((candidate) => candidate.id === id);
        for (const key of absentKeys) {
          expect(entry, testCase.name).not.toHaveProperty(key);
        }
      }
    }
  });

  it("pins the exact schema and conformance bytes in the manifest", async () => {
    const manifest = await readContractFile("manifest.sha256");
    const expected = new Map(
      manifest
        .trim()
        .split(/\r?\n/)
        .map((line) => {
          const [digest, fileName] = line.trim().split(/\s+/, 2);
          return [fileName, digest] as const;
        }),
    );

    for (const fileName of ["schema.json", "conformance.json"]) {
      const bytes = await readFile(`${contractDirectory}/${fileName}`);
      const digest = createHash("sha256").update(bytes).digest("hex");
      expect(digest, fileName).toBe(expected.get(fileName));
    }
  });
});
