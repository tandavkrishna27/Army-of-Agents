import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach } from "vitest";
import { describe, expect, it } from "vitest";
import { buildRunInputBundle } from "../services/run-input-bundles.js";

type MockRow = Record<string, unknown>;

function createSequenceDb(selects: MockRow[][]) {
  let selectIdx = 0;
  function makeChain(getResult: () => MockRow[]) {
    const chain: Record<string, unknown> = {};
    for (const method of ["from", "where", "innerJoin"]) {
      chain[method] = () => chain;
    }
    chain.then = (resolve: (value: MockRow[]) => unknown) => Promise.resolve(resolve(getResult()));
    return chain;
  }
  return {
    select: (..._args: unknown[]) => makeChain(() => selects[selectIdx++] ?? []),
  };
}

const tempDirsToCleanup = new Set<string>();

afterEach(async () => {
  const dirs = Array.from(tempDirsToCleanup);
  tempDirsToCleanup.clear();
  await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("run input bundles", () => {
  it("includes selected context only and excludes unselected parent data", async () => {
    const db = createSequenceDb([
      [{ id: "bundle-1", brief: "Use only the logo reference.", sourceIssueId: "parent-1" }],
      [
        { id: "item-1", itemType: "comment", sourceId: "comment-1", label: null },
        { id: "item-2", itemType: "attachment", sourceId: "attachment-1", label: "logo.png" },
      ],
      [{ id: "comment-1", body: "Selected parent comment", issueId: "parent-1" }],
      [
        {
          id: "attachment-1",
          issueId: "parent-1",
          objectKey: "issues/parent/logo.png",
          originalFilename: "logo.png",
          contentType: "image/png",
          byteSize: 4,
        },
      ],
    ]);

    const bundle = await buildRunInputBundle({
      db: db as never,
      companyId: "company-1",
      issueId: "child-1",
      storage: {
        getObject: async () => ({
          stream: Readable.from(Buffer.from("fake")),
        }),
      } as never,
    });

    expect(bundle.inputs.map((input) => input.label)).toEqual([
      "Inherited brief",
      "Selected parent comment",
      "logo.png",
    ]);
    expect(bundle.markdown).toContain("## Run Inputs");
    expect(bundle.markdown).not.toContain("Unselected");
  });

  it("reports skipped inputs with reasons when a selected item cannot be read", async () => {
    const db = createSequenceDb([
      [{ id: "bundle-1", brief: null, sourceIssueId: "parent-1" }],
      [{ id: "item-1", itemType: "attachment", sourceId: "missing-attachment", label: null }],
      [],
    ]);

    const bundle = await buildRunInputBundle({
      db: db as never,
      companyId: "company-1",
      issueId: "child-1",
      storage: {
        getObject: async () => {
          throw new Error("not used");
        },
      } as never,
    });

    expect(bundle.skipped).toEqual([
      { id: "missing-attachment", type: "attachment", reason: "not_found" },
    ]);
    expect(bundle.markdown).toContain("Skipped attachment missing-attachment: not_found");
  });

  it("includes selected URL and discussion entry handoff rows in run input markdown", async () => {
    const db = createSequenceDb([
      [{ id: "bundle-1", brief: "Use scope handoff.", sourceIssueId: null, sourceDiscussionId: "thread-1" }],
      [
        {
          id: "item-url",
          itemType: "url",
          sourceId: null,
          label: "Reference URL",
          metadata: { url: "https://example.com/ref" },
        },
        {
          id: "item-entry",
          itemType: "discussion_entry",
          sourceId: "entry-1",
          label: "Founder message",
          metadata: { excerpt: "Build the handoff exactly like this." },
        },
      ],
      [{ id: "entry-1", rawContent: "Build the handoff exactly like this." }],
    ]);

    const bundle = await buildRunInputBundle({
      db: db as never,
      companyId: "company-1",
      issueId: "task-1",
    });

    expect(bundle.markdown).toContain("Reference URL");
    expect(bundle.markdown).toContain("https://example.com/ref");
    expect(bundle.markdown).toContain("Founder message");
    expect(bundle.markdown).toContain("Build the handoff exactly like this.");
    expect(bundle.skipped).toEqual([]);
  });

  it("materializes same-named selected attachments without overwriting one another", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-run-inputs-"));
    tempDirsToCleanup.add(cwd);
    const db = createSequenceDb([
      [{ id: "bundle-1", brief: null, sourceIssueId: "parent-1" }],
      [
        { id: "bundle-item-1", itemType: "attachment", sourceId: "attachment-1", label: null },
        { id: "bundle-item-2", itemType: "attachment", sourceId: "attachment-2", label: null },
      ],
      [
        {
          id: "attachment-1",
          issueId: "parent-1",
          objectKey: "issues/parent/a/spec.md",
          originalFilename: "spec.md",
          contentType: "text/markdown",
          byteSize: 5,
        },
      ],
      [
        {
          id: "attachment-2",
          issueId: "parent-1",
          objectKey: "issues/parent/b/spec.md",
          originalFilename: "spec.md",
          contentType: "text/markdown",
          byteSize: 6,
        },
      ],
    ]);

    const bundle = await buildRunInputBundle({
      db: db as never,
      companyId: "company-1",
      issueId: "child-1",
      cwd,
      storage: {
        getObject: async (_companyId: string, objectKey: string) => ({
          stream: Readable.from(Buffer.from(objectKey.includes("/a/") ? "first" : "second")),
        }),
      } as never,
    });

    const localPaths = bundle.inputs
      .filter((entry) => entry.type === "attachment")
      .map((entry) => entry.localPath);
    expect(localPaths).toHaveLength(2);
    expect(localPaths[0]).not.toBe(localPaths[1]);
    expect(await fs.readFile(path.join(cwd, localPaths[0]!), "utf8")).toBe("first");
    expect(await fs.readFile(path.join(cwd, localPaths[1]!), "utf8")).toBe("second");
  });
});
