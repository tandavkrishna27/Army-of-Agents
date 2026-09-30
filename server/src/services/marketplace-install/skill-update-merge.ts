/**
 * @fileoverview The I/O half of the reviewed **skill** merge (T2.8).
 *
 * `POST /updates/:id/merge` used to rewrite `company_skills.markdown` and stop
 * there. For a bundle-carrying skill that is only half the item: the ancillary
 * files (`references/`, `scripts/`, `assets/`) live on disk under
 * `managedCatalogSkillDir(...)`, `metadata.catalogBundleInstallPath` points at
 * them, and `listRuntimeSkillEntries` (`company-skills.ts`) hands exactly those
 * bytes to an agent at run time. Advancing the markdown without re-materializing
 * shipped agents a new SKILL.md next to the OLD scripts — silently, with
 * `sourceRef` already stamped so no later pass would ever repair it.
 *
 * Both other landing paths already materialize (`skill-installer`,
 * `skill-auto-updater`); this one is the gap.
 *
 * ── What it deliberately does NOT do ────────────────────────────────────────
 *
 * **It never overwrites `markdown` with the bundle's SKILL.md.** That is the
 * whole reason a merge exists: `merged` carries the founder's "mine" sections.
 * `applySkillUpdate` writes `payload.markdown` straight from the materializer
 * because it only ever runs on a provably un-customized row; copying that line
 * into here would be the skill-side of the D22 harm this phase spent three
 * tasks removing from the agent side.
 *
 * The divergence that leaves — DB `markdown` is merged, the SKILL.md on disk is
 * upstream's — is not observable at run time: `readAncillarySkillFiles` skips
 * `SKILL.md` by name (`company-skills.ts:798`) and the runtime entry takes
 * `markdown` from the row. The bundle directory supplies ancillary files only.
 *
 * **It is not the agent merge.** Decision #115: the agent path writes its
 * merged bundle file-by-file via `writeMergedAgentBundle` and must NOT be
 * routed through a materializer, because `materializeManagedBundle`'s first act
 * is a recursive `fs.rm` on the founder-editable instruction root. Nothing here
 * touches agent bundles, and nothing here should be "unified" with them. The
 * two are safe to keep separate precisely because a catalog skill's bundle
 * directory is NOT founder-editable — see below.
 *
 * ── Why re-materializing does not destroy founder edits ─────────────────────
 *
 * Through the skill surface, a founder editing THIS skill edits the `markdown`
 * column, not the bundle directory: `companySkillsService.updateFile` writes to
 * disk only when the row's `sourceType === "local_path"`
 * (`company-skills.ts:1591`), and `readFile` returns `null` for every
 * non-`SKILL.md` path on a catalog row. The merge preserves that column — it
 * writes `merged` on every branch.
 *
 * **The guarantee was historically on the row's `sourceType`, not on the
 * path.** The bundle directory itself was not jailed, and a founder could get a
 * differently-typed row to name it — `POST /skills/import` with `source` set to
 * the bundle directory produced a `local_path` row whose `sourceLocator` was
 * that directory, after which `PATCH /skills/:id/files` wrote into it; `PATCH
 * /agents/:id/instructions-bundle` with `mode: "external"` accepted any absolute
 * `rootPath` and both wrote and removed inside it. Neither happens during a
 * normal merge, but "nothing can ever write there" would have been false. Both
 * chains now reject a path inside the managed root via
 * {@link isInsideManagedMarketplaceSkillsRoot} (plan task T2.8c(b)), so the
 * guarantee no longer rests on `sourceType` alone.
 *
 * The destination is additionally **version-scoped**
 * (`.aoa/marketplace-skills/<company>/<item>/<version>`), so a merge to a new
 * version writes a directory that did not exist. Replacing an existing tree is
 * now non-destructive regardless: `materializeSkillBundle` stages the
 * replacement in a sibling and renames it into place, so a failed fetch can no
 * longer leave the caller with no bundle at all.
 *
 * ── Stale files, and why the pointer is the fix ─────────────────────────────
 *
 * A file removed upstream must not survive locally. It does not: the new
 * version directory is a fresh copy of the upstream tree, `fileInventory` is
 * recomputed from it, and `catalogBundleInstallPath` is moved onto it in the
 * same transaction — so the consumer reads a tree the removed file was never
 * copied into. When upstream drops the bundle ENTIRELY the pointer is cleared
 * instead; see {@link resolveBundleColumns}.
 *
 * The previous version's directory is left on disk, deliberately and
 * consistently with `installSkill` / `applySkillUpdate`: it is unreferenced once
 * the pointer moves, and an `fs.rm` of a path derived from a *stale* row is the
 * exact hazard class Decision #115 refused. Moving the pointer is the
 * correctness fix; reclaiming old version directories is disk hygiene and
 * belongs to a sweeper, not to a founder-facing request.
 *
 * ── Ordering, and the failure state each direction leaves ───────────────────
 *
 * The clone runs BEFORE the transaction, matching `applySkillUpdate`.
 *
 * - **Clone fails:** nothing is committed. The pending row stays `pending`, the
 *   skill row keeps its old markdown, `sourceRef` and bundle pointer, and the
 *   founder retries. The failure is loud and total.
 * - **Transaction fails after the clone:** a directory exists at the new
 *   version, referenced by nothing. The row still points at the old version's
 *   files, which still match its old markdown — self-consistent, just not
 *   advanced. A retry re-materializes the same version over itself and commits.
 *   The residue is dead disk, not corruption.
 *
 * The reverse order is the bug this module fixed, now with a stamped `sourceRef`
 * hiding it. Disk-first fails loudly; DB-first fails silently.
 *
 * **"Dead disk, not corruption" is only true because the destination is not the
 * live tree.** When the two coincide — a merge replayed against an already
 * `applied` row — the pre-swap materializer deleted the live bundle before
 * fetching its replacement. Two independent changes close that: the route
 * refuses a non-`pending`/`conflict` update (409), and the materializer stages
 * and renames instead of deleting up front.
 */
import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { companySkills, marketplacePendingUpdates } from "@armyofagents/db";
import type { CatalogItem } from "@armyofagents/shared";
import { fetchCatalogResource } from "./fetch-resource.js";
import { computeSectionDiff, mergeSkillDocument } from "../marketplace-merge.js";
import {
  managedCatalogSkillDir,
  materializeSkillBundle,
} from "./skill-bundle-materializer.js";
import { resolveBundleColumns } from "./skill-bundle-columns.js";

/**
 * Ceiling on the bundle checkout for ONE reviewed merge.
 *
 * A merge touches a single bundle, and a depth-1 fetch of one pinned commit was
 * measured at well under a second per repo (T2.3c: 2.6s for the four repos the
 * crew roster draws from). This is not a performance budget — it exists so a
 * stalled `git` subprocess cannot pin an interactive founder request open for
 * git's own network timeout, which is minutes.
 *
 * No `BundleCheckoutCache` is created: the cache exists to deduplicate
 * repos ACROSS the bundles of one install (17 bundles → 4 repos on the crew
 * bootstrap). One merge is one bundle is one repo, so a cache here would hold
 * exactly one entry and save nothing.
 */
export const SKILL_MERGE_CHECKOUT_TIMEOUT_MS = 60_000;

/** Thrown when the upstream SKILL.md could not be fetched. Route maps to 502. */
export class SkillMergeUpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillMergeUpstreamError";
  }
}

/** Thrown when the reviewed skill/catalog snapshot is no longer current. */
export class SkillMergeConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillMergeConflictError";
  }
}

export function skillMergeSnapshotToken(
  mineContent: string,
  upstreamContent: string,
  catalogVersion: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify([catalogVersion, mineContent, upstreamContent]), "utf8")
    .digest("hex");
}

/** The `company_skills` columns the skill merge reads. */
export interface MergeableSkillRow {
  id: string;
  markdown: string | null;
  metadata: unknown;
  customized: boolean;
}

export interface MergeSkillUpdateArgs {
  db: Db;
  companyId: string;
  skill: MergeableSkillRow;
  catalogItem: CatalogItem;
  pendingUpdateId: string;
  /** Opaque digest returned by GET /updates/:id/diff for this exact review. */
  expectedSnapshotToken: string;
  decisions: Record<string, "mine" | "theirs">;
}

export interface MergeSkillUpdateResult {
  /** False for a markdown-only catalog skill — there is no bundle to write. */
  bundleMaterialized: boolean;
  /** Where the bundle was written, i.e. the new `catalogBundleInstallPath`. */
  bundlePath?: string;
  fileCount?: number;
}

/**
 * Land a reviewed skill merge: merged markdown into the row, upstream bundle
 * files onto disk, pending update closed.
 *
 * @throws SkillMergeUpstreamError when the upstream SKILL.md fetch fails.
 * @throws Error from {@link materializeSkillBundle} (clone, sha mismatch,
 *   timeout) — in every case before anything is committed.
 */
export async function mergeSkillUpdate(
  args: MergeSkillUpdateArgs,
): Promise<MergeSkillUpdateResult> {
  const {
    db,
    companyId,
    skill,
    catalogItem,
    pendingUpdateId,
    expectedSnapshotToken,
    decisions,
  } = args;

  const upstreamContent = await fetchUpstreamSkillMarkdown(catalogItem);
  const mineContent = skill.markdown ?? "";
  if (
    skillMergeSnapshotToken(mineContent, upstreamContent, catalogItem.version)
    !== expectedSnapshotToken
  ) {
    throw new SkillMergeConflictError(
      "The skill or upstream catalog content changed after this diff was reviewed.",
    );
  }
  const diff = computeSectionDiff(mineContent, upstreamContent);
  const merged = mergeSkillDocument(diff, decisions, upstreamContent, mineContent);

  // The bundle is keyed by `catalogItem.version`, NOT by the pending row's
  // `latestVersion`: the bytes come from `catalogItem.skill.bundle`, and the
  // catalog cache can have advanced past the pending row between checker runs
  // (`marketplace-update-checker.ts:206` only bumps `latestVersion` when the
  // checker next runs). Keying the directory off anything but the item that
  // produced it would make `catalogBundleInstallPath` name a tree that was
  // never written there.
  // `sourceRef` is stamped from that same catalog item below, keeping the row's
  // version and bundle pointer aligned even if the pending row is stale.
  const bundle = catalogItem.skill?.bundle;
  const bundleDir = bundle
    ? managedCatalogSkillDir(companyId, catalogItem.id, catalogItem.version)
    : null;
  const materialized = bundle && bundleDir
    ? await materializeSkillBundle(bundle, {
        destination: bundleDir,
        overwrite: true,
        signal: AbortSignal.timeout(SKILL_MERGE_CHECKOUT_TIMEOUT_MS),
      })
    : null;

  await db.transaction(async (tx) => {
    const claimed = await tx
      .update(marketplacePendingUpdates)
      .set({ status: "applied", updatedAt: new Date() })
      .where(
        and(
          eq(marketplacePendingUpdates.id, pendingUpdateId),
          eq(marketplacePendingUpdates.companyId, companyId),
          inArray(marketplacePendingUpdates.status, ["pending", "conflict"]),
        ),
      )
      .returning({ id: marketplacePendingUpdates.id });

    if (claimed.length === 0) {
      throw new SkillMergeConflictError(
        "This update was already applied or dismissed by another session.",
      );
    }

    const updated = await tx
      .update(companySkills)
      .set({
        // `merged.content`, never `materialized.markdown` — see the file docblock.
        markdown: merged.content,
        // `catalogItem.version`, not the pending row's `latestVersion`: both the
        // merged markdown and the bundle now come from `catalogItem`, so this is
        // the only stamp the row's own contents justify.
        sourceRef: catalogItem.version,
        customized: !merged.pureUpstream,
        ...resolveBundleColumns(skill.metadata, bundle, materialized),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(companySkills.id, skill.id),
          eq(companySkills.companyId, companyId),
          eq(companySkills.markdown, mineContent),
          eq(companySkills.customized, skill.customized),
        ),
      )
      .returning({ id: companySkills.id });

    if (updated.length === 0) {
      throw new SkillMergeConflictError(
        "The installed skill changed after this diff was reviewed.",
      );
    }
  });

  return materialized
    ? {
        bundleMaterialized: true,
        bundlePath: materialized.destination,
        fileCount: materialized.fileCount,
      }
    : { bundleMaterialized: false };
}

/**
 * The upstream side of the diff.
 *
 * Deliberately the same source `GET /updates/:id/diff` uses — `resourceUrl`, not
 * the bundle's SKILL.md. The founder decides against the sections the diff
 * showed them; taking the merge's upstream from a different document than the
 * review did would let a decision land content that was never on screen.
 */
async function fetchUpstreamSkillMarkdown(catalogItem: CatalogItem): Promise<string> {
  try {
    return await fetchCatalogResource(catalogItem, "skill update merge");
  } catch (err) {
    throw new SkillMergeUpstreamError(
      `Failed to fetch upstream content: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
