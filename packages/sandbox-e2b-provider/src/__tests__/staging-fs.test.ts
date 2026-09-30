import { describe, expect, it } from "vitest";

import { MockE2bTransport } from "../mock-transport.js";
import { DIRECTIVE_KEYS, METADATA_KEYS } from "../directives.js";
import { E2bTransportNotFoundError } from "../transport.js";

// -----------------------------------------------------------------------------
// CLI-002/D1 — the `writeFiles`/`readFile`/`listDir` staging primitives on the
// transport seam, proven WITHOUT a key against the fs-modeling MockE2bTransport.
//
// Before CLI-002 the seam had no file-put primitive and the mock modeled no
// filesystem, so the "fake CLI modifies a known file inside E2B" acceptance test
// was keyed-only. This suite proves: (1) staged bytes are readable back; (2)
// listDir enumerates a staged directory; (3) a deterministic fake CLI (runCommand
// carrying the reserved fs-write directive) MUTATES a KNOWN staged file — the
// no-key mirror of the keyed real-E2B case.
// -----------------------------------------------------------------------------

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

async function createSandbox(transport: MockE2bTransport): Promise<string> {
  const { sandboxId } = await transport.create({
    templateId: "base",
    timeoutMs: 60_000,
    metadata: { [METADATA_KEYS.env]: "{}" },
    envVars: {},
  });
  return sandboxId;
}

describe("CLI-002/D1 — staging fs primitives (mock transport, no key)", () => {
  it("writeFiles then readFile round-trips staged bytes deterministically", async () => {
    const transport = new MockE2bTransport();
    const sandboxId = await createSandbox(transport);

    await transport.writeFiles(sandboxId, [
      { path: "/home/user/.aoa/context.md", bytes: enc("## Context\nhello") },
      { path: "/home/user/work/main.ts", bytes: enc("export const x = 1;") },
    ]);

    expect(dec(await transport.readFile(sandboxId, "/home/user/.aoa/context.md"))).toBe("## Context\nhello");
    expect(dec(await transport.readFile(sandboxId, "/home/user/work/main.ts"))).toBe("export const x = 1;");
  });

  it("listDir enumerates the files staged under a directory prefix", async () => {
    const transport = new MockE2bTransport();
    const sandboxId = await createSandbox(transport);
    await transport.writeFiles(sandboxId, [
      { path: "/work/a.txt", bytes: enc("a") },
      { path: "/work/b.txt", bytes: enc("b") },
      { path: "/other/c.txt", bytes: enc("c") },
    ]);
    const listed = await transport.listDir(sandboxId, "/work");
    expect([...listed].sort()).toEqual(["/work/a.txt", "/work/b.txt"]);
  });

  it("readFile of a missing sandbox or file throws the transport not-found denial", async () => {
    const transport = new MockE2bTransport();
    const sandboxId = await createSandbox(transport);
    await expect(transport.readFile("sbx-nope", "/x")).rejects.toBeInstanceOf(E2bTransportNotFoundError);
    await expect(transport.readFile(sandboxId, "/missing")).rejects.toBeInstanceOf(E2bTransportNotFoundError);
  });

  it("a deterministic fake CLI (runCommand + fs-write directive) mutates a KNOWN staged file", async () => {
    const transport = new MockE2bTransport();
    const sandboxId = await createSandbox(transport);
    const target = "/work/output.txt";
    await transport.writeFiles(sandboxId, [{ path: target, bytes: enc("original") }]);
    expect(dec(await transport.readFile(sandboxId, target))).toBe("original");

    // The fake CLI: a runCommand whose env carries the reserved fs-write directive
    // the mock decodes into a real in-sandbox file mutation (a real transport
    // ignores it; the keyed lane runs a real shell command against real E2B).
    const result = await transport.runCommand({
      sandboxId,
      command: "fake-cli",
      args: [],
      envVars: {
        [DIRECTIVE_KEYS.fsWrite]: JSON.stringify([{ path: target, content: "MUTATED-BY-CLI" }]),
      },
      timeoutMs: 60_000,
    });
    expect(result.exitCode).toBe(0);
    expect(dec(await transport.readFile(sandboxId, target))).toBe("MUTATED-BY-CLI");
  });
});
