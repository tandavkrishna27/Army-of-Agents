import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("node:fs/promises");
  vi.resetModules();
});

async function loadWithFixture(
  entries: ReadonlyArray<{ idx: number; tag: string; when?: number }>,
  files: Readonly<Record<string, Buffer>>,
) {
  const journal = JSON.stringify({ version: "7", dialect: "postgresql", entries });
  const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.doMock("node:fs/promises", () => ({
    ...actualFs,
    readFile: vi.fn(async (path: string | URL, encoding?: BufferEncoding) => {
      const value = String(path).replaceAll("\\", "/");
      if (value.endsWith("/migrations/meta/_journal.json")) return journal;
      const fileName = value.split("/").at(-1);
      const bytes = fileName === undefined ? undefined : files[fileName];
      if (bytes) return encoding ? bytes.toString(encoding) : bytes;
      throw new Error(`unexpected fixture read: ${value}`);
    }),
  }));
  vi.resetModules();
  return (await import("../client.js")).loadRequiredMigrationIdentity;
}

describe("required migration identity", () => {
  it("uses literal Drizzle journal array order when idx, tag, and when values all disagree", async () => {
    // Mutations caught: sorting by idx, migration filename/tag, or timestamp silently changes the
    // order Drizzle consumes. The literal first entry sorts last under all three alternatives.
    const literalFirst = Buffer.from("literal-array-first\n", "utf8");
    const literalSecond = Buffer.from("literal-array-second\n", "utf8");
    const entries = [
      { idx: 91, tag: "z_literal_first", when: 9_100 },
      { idx: 2, tag: "a_literal_second", when: 200 },
    ] as const;
    const files = {
      "z_literal_first.sql": literalFirst,
      "a_literal_second.sql": literalSecond,
    } as const;
    const loadRequiredMigrationIdentity = await loadWithFixture(entries, files);
    const hashForTag = (tag: (typeof entries)[number]["tag"]) => createHash("sha256")
      .update(files[`${tag}.sql`])
      .digest("hex");
    const orderedHashes = entries.map(({ tag }) => hashForTag(tag));

    // Fail-first controls for the three tempting local mutations. Each produces the same wrong
    // order here, so the production-loader expectation below cannot false-green on any of them.
    for (const mutated of [
      [...entries].sort((left, right) => left.idx - right.idx),
      [...entries].sort((left, right) => left.tag.localeCompare(right.tag)),
      [...entries].sort((left, right) => left.when - right.when),
    ]) {
      expect(mutated.map(({ tag }) => hashForTag(tag))).toEqual([
        hashForTag("a_literal_second"),
        hashForTag("z_literal_first"),
      ]);
      expect(mutated.map(({ tag }) => hashForTag(tag))).not.toEqual(orderedHashes);
    }

    const identity = await loadRequiredMigrationIdentity();
    expect(identity).toEqual({
      orderedHashes,
      ledgerSha256: createHash("sha256").update(JSON.stringify(orderedHashes)).digest("hex"),
    });
    expect(Object.isFrozen(identity)).toBe(true);
    expect(Object.isFrozen(identity.orderedHashes)).toBe(true);
  });

  it("preserves duplicate migration-path rejection", async () => {
    const loadRequiredMigrationIdentity = await loadWithFixture([
      { idx: 1, tag: "duplicate" },
      { idx: 2, tag: "duplicate" },
    ], {
      "duplicate.sql": Buffer.from("one checked-in path\n", "utf8"),
    });

    await expect(loadRequiredMigrationIdentity()).rejects.toThrow(
      "The checked-in migration journal contains duplicate paths",
    );
  });

  it("preserves duplicate byte-hash rejection across distinct paths", async () => {
    const identicalBytes = Buffer.from("identical checked-in bytes\n", "utf8");
    const loadRequiredMigrationIdentity = await loadWithFixture([
      { idx: 1, tag: "first_path" },
      { idx: 2, tag: "second_path" },
    ], {
      "first_path.sql": identicalBytes,
      "second_path.sql": identicalBytes,
    });

    await expect(loadRequiredMigrationIdentity()).rejects.toThrow(
      "The checked-in migration journal contains duplicate migration hashes",
    );
  });
});
