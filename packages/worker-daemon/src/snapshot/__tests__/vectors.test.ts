/**
 * Slice 6 (producer side) — the frozen hash vectors, verified by the PRODUCER's
 * own canonicalizer (`@armyofagents/worker-protocol` canonicalizeJsonV1). This is
 * the SECOND independent implementation that must reproduce every stored digest;
 * the from-scratch reference in `scripts/check-workspace-snapshot-vectors.mjs` is
 * the third. If the producer's canonicalization ever drifts, this test fails.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { computeContentRevision, computeManifestHash } from "../hashing.js";
import { parseManifestFailClosed } from "../build-manifest.js";

const sha256 = (bytes: Buffer | Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(here, "../../../../../tests/fixtures/workspace-snapshot/v1/vectors.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  positiveVectors: Array<{ name: string; contentRevision: string; manifestHash: string; manifest: any }>;
  rejectInputs: Array<{ name: string; manifest: unknown; schemaRejects: boolean }>;
};

describe("frozen workspace-snapshot vectors (producer canonicalizer)", () => {
  for (const vector of fixture.positiveVectors) {
    it(`reproduces manifestHash for ${vector.name}`, () => {
      expect(computeManifestHash(vector.manifest, sha256)).toBe(vector.manifestHash);
    });

    it(`reproduces contentRevision for ${vector.name}`, () => {
      const base = vector.manifest.base;
      if (base.kind === "content_manifest") {
        const derived = computeContentRevision(
          { caseMode: base.caseMode, ignorePolicy: base.ignorePolicy, inclusion: base.inclusion, entries: vector.manifest.entries },
          sha256,
        );
        expect(derived).toBe(vector.contentRevision);
        expect(base.revision).toBe(vector.contentRevision);
      } else {
        // git base: contentRevision IS the git HEAD sha.
        expect(base.revision).toBe(vector.contentRevision);
      }
    });

    it(`the frozen schema accepts ${vector.name}`, () => {
      expect(() => parseManifestFailClosed(vector.manifest)).not.toThrow();
    });
  }

  // The frozen schema rejects structural defects, but entry SORT ORDER is a
  // producer/reference invariant the schema does not encode — those rejects
  // (schemaRejects:false) are proven only by the independent .mjs reference
  // checker's `validateManifestStructure`, not by `.parse()`.
  for (const reject of fixture.rejectInputs.filter((r) => r.schemaRejects)) {
    it(`the frozen schema rejects ${reject.name}`, () => {
      expect(() => parseManifestFailClosed(reject.manifest)).toThrow();
    });
  }
});
