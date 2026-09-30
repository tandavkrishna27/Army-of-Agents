import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_MAX_ARTIFACT_BYTES } from "../services/artifact-size-ceiling.js";

// BRW-003d-5 — the SERVER-SIDE half of the commit-vector claim.
//
// ★ WHY THIS FILE IS THE POINT OF THE TICKET.
// `check-artifact-commit-vectors.mjs` claims two independent implementations
// "pin to one fixture, neither can silently diverge". That was already FALSE: the
// fixture had exactly one reference in the tree — the script's own header comment.
// The word "two" counted one implementation and one comment. A false claim of
// enforcement is worse than a missing check, because it reads as coverage.
//
// This is the second consumer. It binds the fixture to the number the SERVER
// actually uses, so the reference and the server can no longer drift apart in
// silence.

// ★ Resolved from THIS FILE, never from process.cwd(). The first version used cwd
// and passed when vitest ran inside `server/` while failing under the root
// `pnpm test:run` that CI actually runs — a green local suite and a red lane, for
// a path assumption rather than a behaviour.
const FIXTURE = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../../../tests/fixtures/artifact-commit/v1/vectors.json", import.meta.url),
    ),
    "utf8",
  ),
) as {
  context: { maxArtifactBytes?: number };
  rejectVectors: Array<{ name: string; reason: string; actualSizeBytes: number }>;
};

describe("BRW-003d-5 — the fixture and the server share ONE ceiling", () => {
  it("★ pins the fixture's ceiling to the server's constant", () => {
    // The divergence this closes: the server owned its ceiling privately as a
    // `?? 5 * 1024 ** 3` default and the reference modelled none at all.
    expect(FIXTURE.context.maxArtifactBytes).toBe(DEFAULT_MAX_ARTIFACT_BYTES);
  });

  it("agrees with the server's rule on every ceiling vector", () => {
    const ceilingVectors = FIXTURE.rejectVectors.filter(
      (v) => v.reason === "size_ceiling_exceeded",
    );
    // Anti-vacuity: a filter that matches nothing would make the loop below pass
    // by having nothing to check.
    expect(ceilingVectors.length).toBeGreaterThan(0);
    for (const v of ceilingVectors) {
      // The server's literal rule (artifact-commit.ts): reject when the
      // STORE-OBSERVED size exceeds the ceiling.
      expect(v.actualSizeBytes > DEFAULT_MAX_ARTIFACT_BYTES, v.name).toBe(true);
    }
  });

  it("keeps the ceiling a positive, finite number of bytes", () => {
    expect(Number.isSafeInteger(DEFAULT_MAX_ARTIFACT_BYTES)).toBe(true);
    expect(DEFAULT_MAX_ARTIFACT_BYTES).toBeGreaterThan(0);
  });
});
