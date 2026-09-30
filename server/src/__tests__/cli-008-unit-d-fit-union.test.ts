// cli-008-unit-d-fit-union.test.ts — E7-F009, closed.
//
// `pointerFitsExtension` decides whether an attempt's staged-input POINTER will still be
// wire-legal after this stage. It used to project `input.files` ALONE — but the offer is built
// from ALL committed rows for the attempt (`job-leasing.ts:628` `listForJob` → `:638`
// `stagedInputPointersFromRows` → `:399` `stagedInputExtension`). So repeated stages against
// one attempt inflated the REAL extension past `valueMaxCanonicalBytes` while every individual
// call reported "fits"; then `buildJobEnvelope` `safeParse`d to null, the poll raised
// `internal_unavailable`, and the job was PERMANENTLY UNLEASEABLE with nothing naming the
// cause — verbatim the cliff the refusal was added to prevent.
//
// ★ The route is NOT the duplicate-row defect that was closed beside it. Same-digest restages
// replay and add nothing; different-digest restages now throw `conflicting_restage`; but a
// second stage adding a DIFFERENT PATH still appends committed rows. That is why the fix is
// the UNION and not a dedupe at the reader: a dedupe would make this unreachable by accident
// and leave the projection measuring the wrong set for the next multi-stage caller.
//
// Unit D is the first thing that stages more than nothing (a prompt, and an instructions
// bundle), which is why the fix ships with it.

import { describe, expect, it } from "vitest";
import { WIRE_EXTENSION_LIMITS } from "@armyofagents/worker-protocol";
import {
  pointerFitsExtension,
  stagedInputExtension,
  type StagedInputFile,
  type StagedInputPointer,
} from "../services/job-input-staging.js";

const PREFIX = "organizations/org-1/jobs/job-1/attempts/1/";

function pointer(index: number): StagedInputPointer {
  return {
    artifactId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    // ★ SAME LENGTH as `file()`'s path, deliberately: the cliff is measured with one and
    // asserted against unions of both, so a longer prefix here would silently shift it.
    path: `/home/user/.aoa-run-old-${index}.md`,
    objectKey: `${PREFIX}00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    sha256: "a".repeat(64),
    sizeBytes: 1024,
  };
}

function file(index: number): StagedInputFile {
  return {
    path: `/home/user/.aoa-run-new-${index}.md`,
    bytes: new Uint8Array(1024),
  };
}

/** The count at which a single-stage bundle stops fitting — measured, not assumed. */
function firstRefusedCount(): number {
  for (let n = 1; n < 1000; n += 1) {
    if (!pointerFitsExtension([], Array.from({ length: n }, (_, i) => file(i)), PREFIX)) return n;
  }
  throw new Error("no refusal below 1000 files — the fixture no longer approaches the budget");
}

describe("E7-F009 — the fit check measures the ATTEMPT's set, not one call's", () => {
  const CLIFF = firstRefusedCount();

  it("the fixture actually approaches the budget (anti-vacuity)", () => {
    // If a fixture change made the pointer tiny, every assertion below would pass for the
    // wrong reason. Pin that the cliff exists and is somewhere sane.
    expect(CLIFF).toBeGreaterThan(10);
    expect(CLIFF).toBeLessThan(500);
  });

  it("★★★ REFUSES when the UNION exceeds the budget, though each half fits alone", () => {
    const half = Math.ceil(CLIFF / 2);
    const existing = Array.from({ length: half }, (_, i) => pointer(i));
    const incoming = Array.from({ length: CLIFF - half + 2 }, (_, i) => file(i));

    // Each half, measured on its own, is comfortably inside the budget — which is exactly
    // why the old projection said "fits" on every call.
    expect(pointerFitsExtension([], incoming, PREFIX)).toBe(true);
    expect(pointerFitsExtension([], existing.map((p) => ({ path: p.path, bytes: new Uint8Array(p.sizeBytes) })), PREFIX)).toBe(true);

    // The union does not.
    expect(pointerFitsExtension(existing, incoming, PREFIX)).toBe(false);
  });

  it("★ the projection tracks what the OFFER will actually carry", () => {
    // The point of the union is not arithmetic tidiness — it is that the number being
    // measured is the number the wire will see. Build the real extension for the union and
    // check the two verdicts agree.
    const existing = Array.from({ length: 20 }, (_, i) => pointer(i));
    const incoming = Array.from({ length: 20 }, (_, i) => file(i));
    const unionPointers: StagedInputPointer[] = [
      ...existing,
      ...incoming.map((f, i) => ({
        artifactId: `00000000-0000-4000-8000-${String(500 + i).padStart(12, "0")}`,
        path: f.path,
        objectKey: `${PREFIX}00000000-0000-4000-8000-${String(500 + i).padStart(12, "0")}`,
        sha256: "b".repeat(64),
        sizeBytes: f.bytes.byteLength,
      })),
    ];
    const realBytes = new TextEncoder().encode(
      JSON.stringify(stagedInputExtension(unionPointers).value),
    ).byteLength;
    expect(pointerFitsExtension(existing, incoming, PREFIX)).toBe(
      realBytes <= WIRE_EXTENSION_LIMITS.valueMaxCanonicalBytes,
    );
  });

  it("does NOT double-count a path that is already committed", () => {
    // A file already committed at the same path either replays (adding no row) or throws
    // `conflicting_restage`. Counting it twice would refuse a bundle that fits — a refusal
    // for a wire state that can never exist.
    //
    // ★ MEASURED AT THE CLIFF, ON PURPOSE. A first draft asserted `fits(existing,[dup]) ===
    // fits(existing,[])` with one existing file — and both were `true`, so the assertion held
    // for a mutant that counted the duplicate. Mutation testing caught it. The set below is
    // sized so the duplicate is EXACTLY what would tip the verdict: the union is one under the
    // cliff, and counting it twice reaches it.
    const existing = Array.from({ length: CLIFF - 1 }, (_, i) => pointer(i));
    const duplicate: StagedInputFile = { path: existing[0]!.path, bytes: new Uint8Array(1024) };
    expect(pointerFitsExtension(existing, [], PREFIX)).toBe(true);
    expect(pointerFitsExtension(existing, [duplicate], PREFIX)).toBe(true);
    // …and the positive control: one genuinely NEW path at the same point does not fit.
    expect(pointerFitsExtension(existing, [file(999)], PREFIX)).toBe(false);
  });

  it("an empty attempt still measures the incoming bundle (the front door still closes)", () => {
    expect(pointerFitsExtension([], Array.from({ length: CLIFF }, (_, i) => file(i)), PREFIX)).toBe(false);
    expect(pointerFitsExtension([], [file(0)], PREFIX)).toBe(true);
  });
});
