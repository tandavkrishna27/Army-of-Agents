/**
 * T2.8 - the reviewed **skill** merge must re-materialize the bundle on disk.
 *
 * The materializer is NOT mocked. Every claim this task makes is about BYTES on
 * disk, and a `toHaveBeenCalled` on a stubbed materializer is true whether the
 * files are right or wrong. `materializeSkillBundle` runs for real against a
 * real two-commit local git repository; the only thing redirected is the remote
 * URL, via the test-env-guarded `unsafeTestRepoUrl` the materializer already
 * exposes (`isMarketplaceGitHubRepo` otherwise refuses a non-github remote).
 *
 * Only the database and the upstream SKILL.md fetch are stubbed.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileAsync = promisify(execFile);

/** Set per-test so the real materializer clones the fixture repo. */
const repoState = vi.hoisted(() => ({ url: "" }));
const upstreamFetchState = vi.hoisted(() => ({
  markdown: "",
  error: null as Error | null,
  fetchCatalogResource: vi.fn(),
}));

vi.mock("../services/marketplace-install/fetch-resource.js", () => ({
  fetchCatalogResource: upstreamFetchState.fetchCatalogResource,
}));

vi.mock("../services/marketplace-install/skill-bundle-materializer.js", async () => {
  const actual = await vi.importActual<
    typeof import("../services/marketplace-install/skill-bundle-materializer.js")
  >("../services/marketplace-install/skill-bundle-materializer.js");
  return {
    ...actual,
    // Delegates to the REAL implementation - real fetch, real copy, real
    // inventory, real bytes. Only the remote is redirected.
    materializeSkillBundle: (bundle: any, options: any) =>
      actual.materializeSkillBundle(bundle, { ...options, unsafeTestRepoUrl: repoState.url }),
  };
});
vi.mock("@armyofagents/db", () => {
  const table = (name: string) =>
    new Proxy(
      { __table: name },
      { get: (_t, prop) => (prop === "__table" ? name : Symbol(String(prop))) },
    );
  return {
    agents: table("agents"),
    companySkills: table("companySkills"),
    marketplacePendingUpdates: table("marketplacePendingUpdates"),
    plugins: table("plugins"),
  };
});
vi.mock("drizzle-orm", () => ({
  eq: () => Symbol("op:eq"),
  and: () => Symbol("op:and"),
  ne: () => Symbol("op:ne"),
  inArray: () => Symbol("op:inArray"),
}));
vi.mock("../routes/authz.js", () => ({
  assertBoard: vi.fn(),
  assertCompanyAccess: vi.fn(),
  assertCanManageInstanceSettings: vi.fn(),
}));
vi.mock("../services/marketplace-settings.js", () => ({
  marketplaceSettingsService: vi.fn(() => ({ get: vi.fn(), patch: vi.fn() })),
}));

import express from "express";
import request from "supertest";
import { createMarketplaceCompanyRouter } from "../routes/marketplace-company.js";
import {
  SkillMergeConflictError,
  SkillMergeUpstreamError,
  mergeSkillUpdate,
  skillMergeSnapshotToken,
  type MergeableSkillRow,
} from "../services/marketplace-install/skill-update-merge.js";
import { managedCatalogSkillDir } from "../services/marketplace-install/skill-bundle-materializer.js";

// -- fixtures ---------------------------------------------------------------

const COMPANY_ID = "c-t28";
const CATALOG_ITEM_ID = "skill:github-skills/example/repo/research";

/**
 * v1 -> v2 of a real bundle. v2 EDITS a reference, REMOVES a script, and ADDS a
 * new one - the three shapes a re-materialization has to get right.
 */
const V1_FILES = {
  "skills/research/SKILL.md": "# Research\n\n## Overview\n\nv1 overview.\n",
  "skills/research/references/guide.md": "v1 guide\n",
  "skills/research/scripts/legacy.js": "console.log('v1 legacy')\n",
};
const V2_FILES = {
  "skills/research/SKILL.md": "# Research\n\n## Overview\n\nv2 overview.\n",
  "skills/research/references/guide.md": "v2 guide\n",
  "skills/research/scripts/modern.js": "console.log('v2 modern')\n",
};

let cwdSpy: ReturnType<typeof vi.spyOn> | undefined;
let sandbox = "";

beforeEach(async () => {
  upstreamFetchState.error = null;
  upstreamFetchState.fetchCatalogResource.mockReset().mockImplementation(async () => {
    if (upstreamFetchState.error) throw upstreamFetchState.error;
    return upstreamFetchState.markdown;
  });
  // `managedCatalogSkillDir` roots at process.cwd(); keep every write inside a
  // temp sandbox rather than the repo checkout.
  sandbox = await mkdtemp(path.join(os.tmpdir(), "t28-cwd-"));
  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(sandbox);
});

afterEach(() => {
  cwdSpy?.mockRestore();
  vi.unstubAllGlobals();
});

describe("mergeSkillUpdate - bundle re-materialization (T2.8)", () => {
  it("writes the upstream commit's files to disk and points the row at them", async () => {
    const repo = await createRepoWithTwoCommits();
    repoState.url = repo.url;
    stubUpstreamMarkdown(V2_FILES["skills/research/SKILL.md"]);

    const v1Dir = await materializeV1(repo.v1Sha);
    const { db, capture } = createDb();

    await mergeSkillUpdate({
      db,
      companyId: COMPANY_ID,
      skill: skillRow({ v1Dir, v1Sha: repo.v1Sha }),
      catalogItem: catalogItem({ version: "2.0.0", commitSha: repo.v2Sha }),
      pendingUpdateId: "upd-1",
      expectedSnapshotToken: reviewedSnapshotToken(),
      decisions: { Overview: "theirs" },
    });

    // -- the discriminator: FILE BYTES, at the path the row now advertises --
    const bundlePath = activeBundlePath(capture, v1Dir)!;
    expect(bundlePath).toBe(managedCatalogSkillDir(COMPANY_ID, CATALOG_ITEM_ID, "2.0.0"));
    expect(bundlePath).not.toBe(v1Dir);
    expect(await readFile(path.join(bundlePath, "references", "guide.md"), "utf8")).toBe("v2 guide\n");
    expect(await readFile(path.join(bundlePath, "scripts", "modern.js"), "utf8")).toBe(
      "console.log('v2 modern')\n",
    );
    expect(await listBundleFiles(bundlePath)).toEqual([
      "SKILL.md",
      "references/guide.md",
      "scripts/modern.js",
    ]);
    // Accepting upstream everywhere writes the reviewed document byte-for-byte
    // and re-opens this row to the existing customized=false auto-apply path.
    expect(capture.skillSet.markdown).toBe(V2_FILES["skills/research/SKILL.md"]);
    expect(capture.skillSet.customized).toBe(false);
  });

  it("does not carry an upstream-removed script into the active bundle", async () => {
    const repo = await createRepoWithTwoCommits();
    repoState.url = repo.url;
    stubUpstreamMarkdown(V2_FILES["skills/research/SKILL.md"]);

    const v1Dir = await materializeV1(repo.v1Sha);
    // Proof the ablation has something to fail on: v1 really did ship it.
    expect(existsSync(path.join(v1Dir, "scripts", "legacy.js"))).toBe(true);

    const { db, capture } = createDb();
    await mergeSkillUpdate({
      db,
      companyId: COMPANY_ID,
      skill: skillRow({ v1Dir, v1Sha: repo.v1Sha }),
      catalogItem: catalogItem({ version: "2.0.0", commitSha: repo.v2Sha }),
      pendingUpdateId: "upd-1",
      expectedSnapshotToken: reviewedSnapshotToken(),
      decisions: { Overview: "theirs" },
    });

    const bundlePath = activeBundlePath(capture, v1Dir)!;
    // Gone from the tree the runtime reads...
    expect(existsSync(path.join(bundlePath, "scripts", "legacy.js"))).toBe(false);
    // ...and gone from the inventory, which is what the UI and trust level read.
    const inventoryPaths = (capture.skillSet.fileInventory ?? []).map((entry: any) => entry.path);
    expect(inventoryPaths).not.toContain("scripts/legacy.js");
    expect(inventoryPaths).toContain("scripts/modern.js");
    expect(capture.skillSet.trustLevel).toBe("scripts_executables");
  });

  it("preserves the founder's merged markdown - never the bundle's SKILL.md", async () => {
    const repo = await createRepoWithTwoCommits();
    repoState.url = repo.url;
    stubUpstreamMarkdown(V2_FILES["skills/research/SKILL.md"]);

    const v1Dir = await materializeV1(repo.v1Sha);
    const { db, capture } = createDb();

    await mergeSkillUpdate({
      db,
      companyId: COMPANY_ID,
      skill: skillRow({
        v1Dir,
        v1Sha: repo.v1Sha,
        markdown: "# Research\n\n## Overview\n\nFOUNDER EDIT.\n",
      }),
      catalogItem: catalogItem({ version: "2.0.0", commitSha: repo.v2Sha }),
      pendingUpdateId: "upd-1",
      expectedSnapshotToken: reviewedSnapshotToken({
        mine: "# Research\n\n## Overview\n\nFOUNDER EDIT.\n",
      }),
      // Keep mine: the entire reason a merge exists rather than an apply.
      decisions: { Overview: "mine" },
    });

    expect(capture.skillSet.markdown).toContain("FOUNDER EDIT.");
    expect(capture.skillSet.markdown).not.toContain("v2 overview.");
    // ...while the bundle still advanced. Markdown and files move independently.
    const bundlePath = activeBundlePath(capture, v1Dir)!;
    expect(await readFile(path.join(bundlePath, "references", "guide.md"), "utf8")).toBe("v2 guide\n");
    // The row stays `customized` - a merge exists because it diverged.
    expect(capture.skillSet.customized).toBe(true);
    expect(capture.pendingSet.status).toBe("applied");
  });

  it("leaves the previous version's directory untouched (nothing founder-side is deleted)", async () => {
    const repo = await createRepoWithTwoCommits();
    repoState.url = repo.url;
    stubUpstreamMarkdown(V2_FILES["skills/research/SKILL.md"]);

    const v1Dir = await materializeV1(repo.v1Sha);
    const { db } = createDb();

    await mergeSkillUpdate({
      db,
      companyId: COMPANY_ID,
      skill: skillRow({ v1Dir, v1Sha: repo.v1Sha }),
      catalogItem: catalogItem({ version: "2.0.0", commitSha: repo.v2Sha }),
      pendingUpdateId: "upd-1",
      expectedSnapshotToken: reviewedSnapshotToken(),
      decisions: { Overview: "theirs" },
    });

    // Version-scoped destination => the merge wrote a NEW directory and did not
    // recursively remove anything (Decision #115's hazard class).
    expect(await readFile(path.join(v1Dir, "scripts", "legacy.js"), "utf8")).toBe(
      "console.log('v1 legacy')\n",
    );
  });

  it("commits nothing when the checkout fails", async () => {
    const repo = await createRepoWithTwoCommits();
    repoState.url = repo.url;
    stubUpstreamMarkdown(V2_FILES["skills/research/SKILL.md"]);

    const v1Dir = await materializeV1(repo.v1Sha);
    const { db, capture } = createDb();

    await expect(
      mergeSkillUpdate({
        db,
        companyId: COMPANY_ID,
        skill: skillRow({ v1Dir, v1Sha: repo.v1Sha }),
        // A sha that is not in the repo - the fetch cannot resolve it.
        catalogItem: catalogItem({ version: "2.0.0", commitSha: "0".repeat(40) }),
        pendingUpdateId: "upd-1",
        expectedSnapshotToken: reviewedSnapshotToken(),
        decisions: { Overview: "theirs" },
      }),
    ).rejects.toThrow();

    // Disk-first ordering: the transaction never opened, so the pending update
    // survives and the founder can retry.
    expect(capture.transactionCount).toBe(0);
    expect(await readFile(path.join(v1Dir, "references", "guide.md"), "utf8")).toBe("v1 guide\n");
  });

  it("lands the exact newer catalog snapshot the founder reviewed", async () => {
    const repo = await createRepoWithTwoCommits();
    repoState.url = repo.url;
    stubUpstreamMarkdown(V2_FILES["skills/research/SKILL.md"]);

    const v1Dir = await materializeV1(repo.v1Sha);
    const { db, capture } = createDb();

    await mergeSkillUpdate({
      db,
      companyId: COMPANY_ID,
      skill: skillRow({ v1Dir, v1Sha: repo.v1Sha }),
      catalogItem: catalogItem({ version: "2.1.0", commitSha: repo.v2Sha }),
      pendingUpdateId: "upd-1",
      expectedSnapshotToken: reviewedSnapshotToken({ version: "2.1.0" }),
      decisions: { Overview: "theirs" },
    });

    expect(capture.skillSet.sourceRef).toBe("2.1.0");
    expect(capture.skillSet.metadata.catalogBundleInstallPath).toBe(
      managedCatalogSkillDir(COMPANY_ID, CATALOG_ITEM_ID, "2.1.0"),
    );
  });

  /**
   * C3. The whole-bundle analogue of a removed file. Latent against today's
   * catalog (498/498 published skills carry a bundle), but the row must never
   * keep naming a tree the item no longer has.
   */
  it("clears the bundle pointer when upstream drops the bundle entirely", async () => {
    const repo = await createRepoWithTwoCommits();
    repoState.url = repo.url;
    stubUpstreamMarkdown("# Research\n\n## Overview\n\nv2 overview.\n");

    const v1Dir = await materializeV1(repo.v1Sha);
    const { db, capture } = createDb();

    const result = await mergeSkillUpdate({
      db,
      companyId: COMPANY_ID,
      skill: skillRow({ v1Dir, v1Sha: repo.v1Sha }),
      catalogItem: { ...catalogItem({ version: "2.0.0", commitSha: repo.v2Sha }), skill: undefined },
      pendingUpdateId: "upd-1",
      expectedSnapshotToken: reviewedSnapshotToken(),
      decisions: { Overview: "theirs" },
    });

    expect(result.bundleMaterialized).toBe(false);
    // The effective pointer - what `listRuntimeSkillEntries` would resolve after
    // this merge - no longer names the old tree. Asserted through the same
    // fallback the other tests use, so leaving metadata untouched fails as
    // "the row still points at v1's scripts", not as a TypeError.
    expect(activeBundlePath(capture, v1Dir)).toBeUndefined();
    expect(capture.skillSet.metadata.catalogBundleInstallPath).toBeUndefined();
    expect(capture.skillSet.metadata.catalogSkillBundle).toBeUndefined();
    // …and the row stops claiming it ships scripts.
    expect(capture.skillSet.trustLevel).toBe("markdown_only");
    expect(capture.skillSet.fileInventory).toEqual([]);
    // Unrelated metadata survives - this is a patch, not a replacement.
    expect(capture.skillSet.metadata.catalogTrustTier).toBe("verified");
    // The old tree itself is still on disk; only the reference is dropped.
    expect(existsSync(path.join(v1Dir, "scripts", "legacy.js"))).toBe(true);
  });

  it("still merges a markdown-only catalog skill that has no bundle", async () => {
    stubUpstreamMarkdown("# Research\n\n## Overview\n\nv2 overview.\n");
    const { db, capture } = createDb();

    const result = await mergeSkillUpdate({
      db,
      companyId: COMPANY_ID,
      skill: {
        id: "skill-1",
        markdown: "# Research\n\n## Overview\n\nv1 overview.\n",
        metadata: {},
        customized: false,
      },
      catalogItem: { ...catalogItem({ version: "2.0.0", commitSha: "0".repeat(40) }), skill: undefined },
      pendingUpdateId: "upd-1",
      expectedSnapshotToken: reviewedSnapshotToken(),
      decisions: { Overview: "theirs" },
    });

    expect(result.bundleMaterialized).toBe(false);
    expect(capture.skillSet.markdown).toContain("v2 overview.");
    // No bundle => no inventory/trust rewrite. A markdown-only row must not be
    // stamped with an empty inventory it never had.
    expect(capture.skillSet.fileInventory).toBeUndefined();
    expect(capture.skillSet.trustLevel).toBeUndefined();
  });

  it("rejects a stale diff token before touching disk or the database", async () => {
    stubUpstreamMarkdown(V2_FILES["skills/research/SKILL.md"]);
    const { db, capture } = createDb();

    await expect(
      mergeSkillUpdate({
        db,
        companyId: COMPANY_ID,
        skill: {
          id: "skill-1",
          markdown: V1_FILES["skills/research/SKILL.md"],
          metadata: {},
          customized: true,
        },
        catalogItem: {
          ...catalogItem({ version: "2.0.0", commitSha: "0".repeat(40) }),
          skill: undefined,
        },
        pendingUpdateId: "upd-1",
        expectedSnapshotToken: reviewedSnapshotToken({ mine: "older founder bytes" }),
        decisions: { Overview: "theirs" },
      }),
    ).rejects.toBeInstanceOf(SkillMergeConflictError);

    expect(capture.transactionCount).toBe(0);
  });

  it("refuses a merge when another session already claimed the pending update", async () => {
    stubUpstreamMarkdown(V2_FILES["skills/research/SKILL.md"]);
    const { db, capture } = createDb({ claimSucceeded: false });

    await expect(
      mergeSkillUpdate({
        db,
        companyId: COMPANY_ID,
        skill: {
          id: "skill-1",
          markdown: V1_FILES["skills/research/SKILL.md"],
          metadata: {},
          customized: true,
        },
        catalogItem: {
          ...catalogItem({ version: "2.0.0", commitSha: "0".repeat(40) }),
          skill: undefined,
        },
        pendingUpdateId: "upd-1",
        expectedSnapshotToken: reviewedSnapshotToken(),
        decisions: { Overview: "theirs" },
      }),
    ).rejects.toBeInstanceOf(SkillMergeConflictError);

    expect(capture.skillSet).toBeNull();
  });

  it("refuses to overwrite a skill changed after the route loaded it", async () => {
    stubUpstreamMarkdown(V2_FILES["skills/research/SKILL.md"]);
    const { db } = createDb({ skillUpdateSucceeded: false });

    await expect(
      mergeSkillUpdate({
        db,
        companyId: COMPANY_ID,
        skill: {
          id: "skill-1",
          markdown: V1_FILES["skills/research/SKILL.md"],
          metadata: {},
          customized: true,
        },
        catalogItem: {
          ...catalogItem({ version: "2.0.0", commitSha: "0".repeat(40) }),
          skill: undefined,
        },
        pendingUpdateId: "upd-1",
        expectedSnapshotToken: reviewedSnapshotToken(),
        decisions: { Overview: "theirs" },
      }),
    ).rejects.toBeInstanceOf(SkillMergeConflictError);
  });

  it("raises a typed upstream error without touching disk or the database", async () => {
    const repo = await createRepoWithTwoCommits();
    repoState.url = repo.url;
    upstreamFetchState.error = new Error("upstream returned HTTP 503");

    const v1Dir = await materializeV1(repo.v1Sha);
    const { db, capture } = createDb();

    await expect(
      mergeSkillUpdate({
        db,
        companyId: COMPANY_ID,
        skill: skillRow({ v1Dir, v1Sha: repo.v1Sha }),
        catalogItem: catalogItem({ version: "2.0.0", commitSha: repo.v2Sha }),
        pendingUpdateId: "upd-1",
        expectedSnapshotToken: reviewedSnapshotToken(),
        decisions: { Overview: "theirs" },
      }),
    ).rejects.toBeInstanceOf(SkillMergeUpstreamError);

    expect(capture.transactionCount).toBe(0);
    expect(existsSync(managedCatalogSkillDir(COMPANY_ID, CATALOG_ITEM_ID, "2.0.0"))).toBe(false);
  });
});

/**
 * The route half. `mergeSkillUpdate` being correct is worth nothing if
 * `POST /updates/:id/merge` still doesn't call it, and a bundle-carrying
 * catalog item is the branch the service tests above cover but the pre-existing
 * route tests (markdown-only fixtures) never reach. Asserted on disk, through
 * the real router.
 */
describe("POST /updates/:id/merge - the route reaches disk", () => {
  it("re-materializes the bundle for a bundle-carrying skill", async () => {
    const repo = await createRepoWithTwoCommits();
    repoState.url = repo.url;
    stubUpstreamMarkdown(V2_FILES["skills/research/SKILL.md"]);

    const v1Dir = await materializeV1(repo.v1Sha);
    const { app, capture } = buildMergeApp({
      updateRow: pendingUpdateRow(),
      skill: skillRow({ v1Dir, v1Sha: repo.v1Sha }),
      catalogItem: catalogItem({ version: "2.0.0", commitSha: repo.v2Sha }),
    });

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/marketplace/updates/upd-1/merge`)
      .send({
        decisions: { Overview: "theirs" },
        snapshotToken: reviewedSnapshotToken(),
      });

    expect(res.status).toBe(200);
    expect(res.body.bundleMaterialized).toBe(true);

    const bundlePath = activeBundlePath(capture, v1Dir)!;
    expect(bundlePath).toBe(managedCatalogSkillDir(COMPANY_ID, CATALOG_ITEM_ID, "2.0.0"));
    expect(await readFile(path.join(bundlePath, "references", "guide.md"), "utf8")).toBe("v2 guide\n");
    expect(existsSync(path.join(bundlePath, "scripts", "legacy.js"))).toBe(false);
  });

  /**
   * C1. A merge is only reviewable while the update is open. Replaying one
   * against an `applied` row recomputes a destination equal to the row's LIVE
   * `catalogBundleInstallPath`, and asks the materializer to replace it.
   *
   * The modal makes this reachable: on a failed request it toasts and
   * re-enables the button without closing, so a commit whose response was lost
   * becomes a second click.
   */
  it.each(["applied", "dismissed"] as const)(
    "refuses to replay a merge against a %s update, leaving the live bundle intact",
    async (status) => {
      const repo = await createRepoWithTwoCommits();
      repoState.url = repo.url;
      stubUpstreamMarkdown(V2_FILES["skills/research/SKILL.md"]);

      // The state after a successful merge: files at v2, row pointing at them.
      const liveDir = await materializeAt(repo.v2Sha, "2.0.0");
      const { app, capture } = buildMergeApp({
        updateRow: { ...pendingUpdateRow(), status },
        skill: skillRow({ v1Dir: liveDir, v1Sha: repo.v2Sha }),
        catalogItem: catalogItem({ version: "2.0.0", commitSha: repo.v2Sha }),
      });

      const res = await request(app)
        .post(`/api/companies/${COMPANY_ID}/marketplace/updates/upd-1/merge`)
        .send({
          decisions: { Overview: "theirs" },
          snapshotToken: reviewedSnapshotToken(),
        });

      expect(res.status).toBe(409);
      expect(res.body.error).toContain(status);
      expect(capture.transactionCount).toBe(0);
      // The live bundle is untouched - the harm this whole task exists to fix.
      expect(await readFile(path.join(liveDir, "references", "guide.md"), "utf8")).toBe("v2 guide\n");
      expect(await readFile(path.join(liveDir, "SKILL.md"), "utf8")).toBe(
        V2_FILES["skills/research/SKILL.md"],
      );
    },
  );
});

// -- helpers ----------------------------------------------------------------

function stubUpstreamMarkdown(markdown: string) {
  upstreamFetchState.markdown = markdown;
  upstreamFetchState.error = null;
}

function reviewedSnapshotToken({
  mine = V1_FILES["skills/research/SKILL.md"],
  upstream = V2_FILES["skills/research/SKILL.md"],
  version = "2.0.0",
}: {
  mine?: string;
  upstream?: string;
  version?: string;
} = {}) {
  return skillMergeSnapshotToken(mine, upstream, version);
}

/**
 * The bundle directory the runtime reads AFTER the merge, or `undefined` when
 * the row no longer names one.
 *
 * Models `listRuntimeSkillEntries` exactly: it reads
 * `metadata.catalogBundleInstallPath` off the row, whatever that is. The row's
 * metadata after the merge is what the merge WROTE if it wrote metadata at all,
 * and otherwise the metadata it already had — so a merge that fails to patch
 * leaves the PREVIOUS pointer live, and the assertions read "the old files are
 * still live" rather than throwing a TypeError. That distinction is what makes
 * these ablations legible.
 */
function activeBundlePath(capture: any, previous: string): string | undefined {
  const set = capture.skillSet ?? {};
  const metadata = "metadata" in set ? set.metadata : { catalogBundleInstallPath: previous };
  const pointer = metadata?.catalogBundleInstallPath;
  return typeof pointer === "string" ? pointer : undefined;
}

/** Materialize v1 exactly as `installSkill` would, so the merge has a real predecessor. */
function materializeV1(commitSha: string): Promise<string> {
  return materializeAt(commitSha, "1.0.0");
}

async function materializeAt(commitSha: string, version: string): Promise<string> {
  const { materializeSkillBundle } = await import(
    "../services/marketplace-install/skill-bundle-materializer.js"
  );
  const destination = managedCatalogSkillDir(COMPANY_ID, CATALOG_ITEM_ID, version);
  await materializeSkillBundle(bundleAt(commitSha) as any, { destination, overwrite: true });
  return destination;
}

function pendingUpdateRow() {
  return {
    id: "upd-1",
    companyId: COMPANY_ID,
    catalogItemId: CATALOG_ITEM_ID,
    itemType: "skill",
    currentVersion: "1.0.0",
    latestVersion: "2.0.0",
    status: "pending",
  };
}

/** The real router over a mock Drizzle handle, for the route-level assertions. */
function buildMergeApp(opts: { updateRow: any; skill: MergeableSkillRow; catalogItem: any }) {
  const capture: any = { skillSet: null, transactionCount: 0 };
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.actor = { type: "board", source: "local_implicit", userId: "u1", companyId: COMPANY_ID };
    next();
  });

  let selectCall = 0;
  const db: any = {
    select: () => {
      selectCall++;
      const rows = selectCall === 1 ? [opts.updateRow] : [opts.skill];
      return { from: () => ({ where: () => Promise.resolve(rows) }) };
    },
    transaction: async (cb: (tx: any) => Promise<unknown>) => {
      capture.transactionCount++;
      let call = 0;
      return cb({
        update: () => ({
          set: (values: any) => ({
            where: () => ({
              returning: async () => {
                if (++call === 1) return [{ id: "upd-1" }];
                capture.skillSet = values;
                return [{ id: "skill-1" }];
              },
            }),
          }),
        }),
      });
    },
  };

  app.use(
    "/api/companies/:companyId/marketplace",
    createMarketplaceCompanyRouter({
      db,
      catalogService: {
        readCache: async () =>
          ({
            schemaVersion: "1.0.0",
            generatedAt: "2026-07-24T00:00:00Z",
            itemCount: 1,
            items: [opts.catalogItem],
          }) as any,
      },
    }),
  );
  return { app, capture };
}

function bundleAt(commitSha: string) {
  return {
    type: "github-directory",
    repo: "example/repo",
    commitSha,
    path: "skills/research",
    treeUrl: "https://github.com/example/repo/tree/x/skills/research",
  };
}

function skillRow(opts: { v1Dir: string; v1Sha: string; markdown?: string }): MergeableSkillRow {
  return {
    id: "skill-1",
    markdown: opts.markdown ?? V1_FILES["skills/research/SKILL.md"],
    customized: true,
    metadata: {
      catalogTrustTier: "verified",
      catalogBundleInstallPath: opts.v1Dir,
      catalogSkillBundle: bundleAt(opts.v1Sha),
    },
  };
}

function catalogItem(opts: { version: string; commitSha: string }): any {
  return {
    id: CATALOG_ITEM_ID,
    type: "skill",
    name: "Research",
    description: "Research skill",
    version: opts.version,
    resourceUrl: "https://raw.githubusercontent.com/example/repo/x/skills/research/SKILL.md",
    trust: { tier: "verified", source: "github-skills" },
    status: "active",
    skill: { bundle: bundleAt(opts.commitSha) },
  };
}

/** Mock Drizzle handle that records the two `.set()` payloads the merge writes. */
function createDb({
  claimSucceeded = true,
  skillUpdateSucceeded = true,
}: {
  claimSucceeded?: boolean;
  skillUpdateSucceeded?: boolean;
} = {}) {
  const capture: any = { skillSet: null, pendingSet: null, transactionCount: 0 };
  const db: any = {
    transaction: async (cb: (tx: any) => Promise<unknown>) => {
      capture.transactionCount++;
      let call = 0;
      const tx = {
        update: () => ({
          set: (values: any) => ({
            where: () => ({
              returning: async () => {
                call++;
                if (call === 1) {
                  capture.pendingSet = values;
                  return claimSucceeded ? [{ id: "upd-1" }] : [];
                }
                capture.skillSet = values;
                return skillUpdateSucceeded ? [{ id: "skill-1" }] : [];
              },
            }),
          }),
        }),
      };
      return cb(tx);
    },
  };
  return { db, capture };
}

/**
 * A repo whose HEAD~1 is bundle v1 and HEAD is bundle v2.
 *
 * `core.autocrlf=false` + `* -text` because this suite asserts exact bytes: on
 * Windows a global `autocrlf=true` rewrites LF to CRLF at checkout time inside
 * the materializer's clone, and every byte assertion would be comparing the
 * developer's git config rather than the bundle.
 */
async function createRepoWithTwoCommits() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "t28-repo-"));
  await git(dir, "init");
  await git(dir, "config", "user.email", "test@example.com");
  await git(dir, "config", "user.name", "Test User");
  await git(dir, "config", "core.autocrlf", "false");
  await writeFiles(dir, { ".gitattributes": "* -text\n" });

  await writeFiles(dir, V1_FILES);
  await git(dir, "add", ".");
  await git(dir, "commit", "-m", "v1");
  const v1Sha = (await git(dir, "rev-parse", "HEAD")).stdout.trim();

  // Remove the v1-only script so v2 genuinely drops a file.
  await git(dir, "rm", "-q", "skills/research/scripts/legacy.js");
  await writeFiles(dir, V2_FILES);
  await git(dir, "add", ".");
  await git(dir, "commit", "-m", "v2");
  const v2Sha = (await git(dir, "rev-parse", "HEAD")).stdout.trim();

  return { url: dir, v1Sha, v2Sha };
}

async function writeFiles(root: string, files: Record<string, string>) {
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
}

async function listBundleFiles(dir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(path.join(dir, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listBundleFiles(dir, relative)));
    else files.push(relative);
  }
  return files.sort();
}

function git(cwd: string, ...args: string[]) {
  return execFileAsync("git", args, { cwd });
}
