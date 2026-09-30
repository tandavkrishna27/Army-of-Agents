/**
 * DAT-001 adversarial-review regression test — Finding A.
 *
 * A file larger than the per-file ceiling was fully `readFileSync`'d INTO MEMORY
 * before the ceiling was checked (memory-amplification; a >2 GiB file threw a raw
 * RangeError instead of a fail-closed WorkspaceSnapshotError). The producer now
 * pre-checks the file size from the already-obtained `lstat` stats BEFORE reading,
 * so an over-ceiling file is never read.
 *
 * `node:fs` is partially mocked so we can prove `readFileSync` is NOT invoked for
 * the oversize path (lstat/readdir stay real for the temp-dir walk).
 */

import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

// Imported AFTER the mock is registered so build-manifest binds the spy.
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildWorkspaceManifest, type BuildWorkspaceManifestInput } from "../build-manifest.js";
import { DEFAULT_SNAPSHOT_LIMITS } from "../limits.js";

const sha256 = (bytes: Buffer | Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const readSpy = readFileSync as unknown as Mock;

let dir: string;
beforeEach(() => {
  readSpy.mockClear();
  dir = mkdtempSync(path.join(tmpdir(), "aoa-snap-oversize-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function contentInput(over: Partial<BuildWorkspaceManifestInput> = {}): BuildWorkspaceManifestInput {
  return {
    root: dir,
    base: "content_manifest",
    caseMode: "sensitive",
    organizationId: "11111111-1111-4111-8111-111111111111",
    companyId: "22222222-2222-4222-8222-222222222222",
    artifactId: "33333333-3333-4333-8333-333333333333",
    sourceTargetId: "44444444-4444-4444-8444-444444444444",
    folderGrantId: null,
    captureToolVersion: "aoa-worker-daemon/test",
    capturedAt: "2026-08-14T00:00:00.000Z",
    untracked: "include",
    ignore: { kind: "explicit", rules: [] },
    sha256,
    ...over,
  };
}

describe("DAT-001 review — oversize file is not read before the ceiling check (Finding A)", () => {
  it("rejects an over-ceiling file WITHOUT reading it into memory", async () => {
    const bigAbs = path.join(dir, "big.bin");
    writeFileSync(bigAbs, Buffer.alloc(64, 0x41)); // 64 bytes
    const limits = { ...DEFAULT_SNAPSHOT_LIMITS, maxFileBytes: 8 }; // ceiling below the file

    await expect(buildWorkspaceManifest(contentInput({ limits }))).rejects.toThrow(/per-file ceiling/i);

    const readBig = readSpy.mock.calls.some((call) => String(call[0]) === bigAbs);
    expect(readBig).toBe(false); // FAIL-FIRST: before the fix, the file is read before the ceiling check
  });

  it("still reads an in-budget file (sanity: the pre-check does not block normal files)", async () => {
    const okAbs = path.join(dir, "ok.txt");
    writeFileSync(okAbs, "hello\n");

    const result = await buildWorkspaceManifest(contentInput());
    expect(result.manifest.entries.map((e) => e.path)).toContain("ok.txt");
    expect(readSpy.mock.calls.some((call) => String(call[0]) === okAbs)).toBe(true);
  });
});
