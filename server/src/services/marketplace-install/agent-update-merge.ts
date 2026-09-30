/**
 * @fileoverview The I/O half of the agent diff/merge path (T2.7).
 *
 * `applyCrewAgentUpdate` (crew-updater.ts) is the *unreviewed* landing: it only
 * runs for a provably untouched bundle (`instructions_customized = false`) and
 * full-replaces. This module is the **reviewed** landing for the rows that gate
 * excludes — `true` (founder edited) and `null` (unknown provenance, every crew
 * agent installed before migration `0182`). Without it those pending updates
 * accumulate with nowhere to go: `/apply` answered 501 and `/merge` 404'd.
 *
 * ── What it deliberately does NOT do ────────────────────────────────────────
 *
 * It never calls `materializeManagedBundle`. That function's first act is
 * `fs.rm(root, { recursive: true, force: true })` on the directory holding the
 * founder's edits, outside any transaction — the precise hazard T2.3b's review
 * and T2.6 both landed on. A merge writes the files it computed, one at a time,
 * through the same `agentInstructionsService` surface the founder's own editor
 * uses, and deletes only the files the founder explicitly gave away. When every
 * decision is "accept upstream" the end state is identical to what a
 * replace-everything materialize would have produced, reached without the rm.
 *
 * **Seam left for T2.8:** T2.8 is "re-materialize bundled files on a reviewed
 * merge", and its subject is the *skill* bundle (`materializeSkillBundle`) —
 * `POST /updates/:id/merge` rewrites `company_skills.markdown` and leaves the
 * checked-out bundle files on disk stale. Nothing in this module writes skill
 * bundles, and {@link writeMergedAgentBundle} is the single named place an
 * agent merge touches disk, so T2.8 can add the skill-side materializer call
 * without reopening the agent path.
 *
 * ── Ordering, and the failure state it leaves ───────────────────────────────
 *
 * Files are written BEFORE the transaction, deliberately. The reverse order
 * (commit, then write) fails silently: the row would claim the new
 * `templateVersion` while disk still held the old content, and nothing would
 * ever converge it. Disk-first fails loudly instead — if the transaction
 * aborts, disk holds the merged bundle while the row keeps its old
 * `templateVersion` and its old customization state, so the pending update
 * survives and the next diff simply shows the merged content as "mine". Same
 * class of residue as `applyCrewAgentUpdate`'s documented post-materialize
 * failure, and recoverable for the same reason: no founder bytes were deleted.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { agents, aoaAgentTriggers, marketplacePendingUpdates } from "@armyofagents/db";
import type { CatalogItem } from "@armyofagents/shared";
import { fetchCatalogResource } from "./fetch-resource.js";
import { parseMarketplaceAgentTemplate, normalizeMarketplaceAgentTemplate } from "./agent-runtime.js";
import { loadMarketplaceInstructionFiles } from "./agent-create.js";
import type { NormalizedMarketplaceAgentTemplate } from "./types.js";
import { protectedAgentRole } from "../protected-agents.js";
import {
  LEGACY_PROMPT_VIRTUAL_FILES,
  applyAgentMergeDecisions,
  bundlesAreByteIdentical,
  computeAgentSectionDiff,
  isLegacyPromptVirtualFile,
  type AgentMergeResult,
  type AgentSectionDiff,
} from "../marketplace-agent-merge.js";
import { logger } from "../../middleware/logger.js";

/** The agent columns the merge path reads. */
export interface MergeableAgentRow {
  id: string;
  companyId: string;
  name: string;
  adapterType: string;
  adapterConfig: Record<string, unknown> | null;
  runtimeConfig: Record<string, unknown> | null;
  skillKeys?: string[] | null;
  templateOrigin: string | null;
  templateVersion: string | null;
  instructionsCustomized: boolean | null;
}

/** The subset of `agentInstructionsService()` this module uses. */
export interface AgentBundleServiceLike {
  getBundle(agent: BundleAgentLike): Promise<{
    entryFile: string;
    files: { path: string; virtual: boolean }[];
  }>;
  readFile(agent: BundleAgentLike, relativePath: string): Promise<{ content: string }>;
  writeFile(
    agent: BundleAgentLike,
    relativePath: string,
    content: string,
  ): Promise<{ adapterConfig: Record<string, unknown> }>;
  deleteFile(
    agent: BundleAgentLike,
    relativePath: string,
  ): Promise<{ adapterConfig: Record<string, unknown> }>;
  updateBundle(
    agent: BundleAgentLike,
    input: { entryFile?: string },
  ): Promise<{ adapterConfig: Record<string, unknown> }>;
}

export interface BundleAgentLike {
  id: string;
  companyId: string;
  name: string;
  adapterConfig: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.trim().length > 0 ? value : null;
}

/**
 * The agent's CURRENT instruction bundle, as a `path → content` map.
 *
 * Real files come off disk through `getBundle`/`readFile`. The two legacy
 * `adapterConfig` prompt fields are added as virtual paths — see
 * `marketplace-agent-merge.ts` for why they belong in the diff at all.
 *
 * `getBundle` already surfaces `promptTemplate` as a `virtual: true` entry, so
 * virtual entries are filtered out of the disk walk and re-derived from
 * `adapterConfig` here; that keeps one source of truth for their contents and
 * covers `bootstrapPromptTemplate`, which `getBundle` does not list at all.
 *
 * A REAL file whose name collides with one of those pseudo-paths is reported as
 * `shadowedPaths` and excluded from the snapshot entirely — see the comment at
 * the collision check for why "disk wins" is not implementable here.
 */
export async function readAgentInstructionSnapshot(
  instructions: AgentBundleServiceLike,
  agent: BundleAgentLike,
): Promise<AgentInstructionSnapshot> {
  const bundle = await instructions.getBundle(agent);
  const files: Record<string, string> = {};
  const shadowedPaths = new Set<string>();

  for (const file of bundle.files) {
    if (file.virtual) continue;
    // NAME COLLISION, fail closed. A founder may legitimately keep a real file
    // called `promptTemplate.legacy.md` in their bundle root — and it is not
    // readable through this service at all: `agentInstructionsService.readFile`
    // short-circuits on that exact path and returns `adapterConfig.promptTemplate`
    // instead of the file's bytes (pre-existing, and the same short-circuit is
    // what makes the pseudo-file work for the editor). Since the merge cannot
    // see the real content, it must not act on the path in EITHER direction: it
    // is left out of the diff, never written, never deleted, and the
    // `adapterConfig` value for that key is left out too. `shadowedPaths` is
    // then reported so the caller refuses to claim the bundle is pure upstream
    // while a local file it could not account for is sitting there.
    if (isLegacyPromptVirtualFile(file.path)) {
      shadowedPaths.add(file.path);
      continue;
    }
    const detail = await instructions.readFile(agent, file.path);
    files[file.path] = detail.content;
  }

  const config = asRecord(agent.adapterConfig);
  const virtualPaths = new Set<string>();
  for (const [virtualPath, configKey] of Object.entries(LEGACY_PROMPT_VIRTUAL_FILES)) {
    if (shadowedPaths.has(virtualPath)) continue;
    const value = asNonEmptyString(config[configKey]);
    if (value !== null) {
      files[virtualPath] = value;
      virtualPaths.add(virtualPath);
    }
  }

  if (shadowedPaths.size > 0) {
    logger.warn(
      { agentId: agent.id, shadowedPaths: [...shadowedPaths] },
      "marketplace: agent bundle contains real files whose names collide with the legacy prompt "
        + "pseudo-files; excluding them from the update review (they cannot be read through the "
        + "instructions service). Rename them to bring them under review.",
    );
  }

  return { files, entryFile: bundle.entryFile, virtualPaths, shadowedPaths };
}

export interface UpstreamAgentInstructions {
  files: Record<string, string>;
  entryFile: string;
  template: NormalizedMarketplaceAgentTemplate;
}

/** Fetch + parse the catalog side of the diff. */
export async function loadUpstreamAgentInstructions(
  catalogItem: CatalogItem,
): Promise<UpstreamAgentInstructions> {
  const bodyText = await fetchCatalogResource(catalogItem, "agent template for review");
  const parsed = parseMarketplaceAgentTemplate(bodyText, catalogItem);
  const template = normalizeMarketplaceAgentTemplate({ parsed, catalogItem, availableAdapterTypes: [] });
  const instructionFiles = await loadMarketplaceInstructionFiles(catalogItem, template);
  return {
    files: instructionFiles?.files ?? {},
    entryFile: instructionFiles?.entryFile ?? "AGENTS.md",
    template,
  };
}

export interface AgentInstructionSnapshot {
  /** The reviewable bundle, as `path → content`. */
  files: Record<string, string>;
  entryFile: string;
  /** Paths backed by `adapterConfig` rather than disk, for THIS agent. */
  virtualPaths: Set<string>;
  /**
   * Real on-disk files excluded from review because their name collides with a
   * legacy prompt pseudo-file. Non-empty means the bundle can never be reported
   * as pure upstream — there is local content the merge could not account for.
   */
  shadowedPaths: Set<string>;
}

export interface AgentUpdateDiff {
  diff: AgentSectionDiff[];
  upstream: UpstreamAgentInstructions;
  /** The agent's current bundle, as `path → content`. */
  local: AgentInstructionSnapshot;
  localEntryFile: string;
  /** True when the local bundle already equals upstream byte-for-byte. */
  identical: boolean;
}

/** Compute the reviewable diff between an agent's bundle and the catalog. */
export async function computeAgentUpdateDiff(opts: {
  instructions: AgentBundleServiceLike;
  agent: MergeableAgentRow;
  catalogItem: CatalogItem;
}): Promise<AgentUpdateDiff> {
  const upstream = await loadUpstreamAgentInstructions(opts.catalogItem);
  const local = await readAgentInstructionSnapshot(opts.instructions, opts.agent);
  const diff = computeAgentSectionDiff(local.files, upstream.files, local.virtualPaths);
  // BYTE equality, not "every section is `unchanged`". `computeSectionDiff`
  // classifies `unchanged` on `.trim()`, so a trailing-whitespace-only
  // divergence yields an all-`unchanged` diff — and the modal would then tell
  // the founder "no local changes found" about a bundle that merges to
  // `instructions_customized = true`. The claim has to match what the merge
  // will actually decide.
  const identical =
    bundlesAreByteIdentical(local.files, upstream.files)
    && local.entryFile === upstream.entryFile
    && local.shadowedPaths.size === 0;
  return { diff, upstream, local, localEntryFile: local.entryFile, identical };
}

/**
 * Write the merged bundle to disk / `adapterConfig` and return the config to
 * persist. **The only place an agent merge touches the filesystem.**
 *
 * Never removes the bundle root. Deletions are per-file and skip whichever file
 * is the entry file at the time — `deleteFile` refuses that anyway, and losing
 * it would leave the agent with no resolvable instructions. A skipped deletion
 * is reported back so the caller can refuse to claim the bundle is pure
 * upstream when it is not.
 */
export async function writeMergedAgentBundle(opts: {
  instructions: AgentBundleServiceLike;
  agent: MergeableAgentRow;
  merged: AgentMergeResult;
  upstreamEntryFile: string;
  localEntryFile: string;
  /** The bundle as it is on disk right now — used to skip no-op writes. */
  localFiles: Record<string, string>;
  /** Paths backed by `adapterConfig` rather than disk, for THIS agent. */
  virtualPaths: ReadonlySet<string>;
}): Promise<{ adapterConfig: Record<string, unknown>; keptUndeletableFiles: string[] }> {
  const { instructions, merged, upstreamEntryFile, localFiles, virtualPaths } = opts;
  let adapterConfig = asRecord(opts.agent.adapterConfig);
  const agentFor = (): BundleAgentLike => ({
    id: opts.agent.id,
    companyId: opts.agent.companyId,
    name: opts.agent.name,
    adapterConfig,
  });

  // 1. Virtual (adapterConfig-backed) files — set or clear, no disk involved.
  for (const [virtualPath, configKey] of Object.entries(LEGACY_PROMPT_VIRTUAL_FILES)) {
    if (!virtualPaths.has(virtualPath)) continue;
    if (virtualPath in merged.files) {
      adapterConfig = { ...adapterConfig, [configKey]: merged.files[virtualPath]! };
    } else if (merged.deletedFiles.includes(virtualPath)) {
      const next = { ...adapterConfig };
      delete next[configKey];
      adapterConfig = next;
    }
  }

  // 2. Real files. Files whose merged content already equals what is on disk
  //    are SKIPPED, not rewritten: `writeFile` round-trips through a UTF-8
  //    decode/encode, so rewriting an untouched file both churns its mtime and
  //    would mangle any non-UTF-8 file a founder keeps in the bundle root.
  for (const [relativePath, content] of Object.entries(merged.files)) {
    if (virtualPaths.has(relativePath)) continue;
    if (localFiles[relativePath] === content) continue;
    const written = await instructions.writeFile(agentFor(), relativePath, content);
    adapterConfig = written.adapterConfig;
  }

  // 3. Entry-file rename, before deletions so the old entry file becomes
  //    deletable. Only when upstream's entry file actually survived the merge.
  let entryFile = opts.localEntryFile;
  if (upstreamEntryFile !== entryFile && upstreamEntryFile in merged.files) {
    const updated = await instructions.updateBundle(agentFor(), { entryFile: upstreamEntryFile });
    adapterConfig = updated.adapterConfig;
    entryFile = upstreamEntryFile;
  }

  // 4. Deletions.
  const keptUndeletableFiles: string[] = [];
  for (const relativePath of merged.deletedFiles) {
    if (virtualPaths.has(relativePath)) continue;
    if (relativePath === entryFile) {
      keptUndeletableFiles.push(relativePath);
      continue;
    }
    const deleted = await instructions.deleteFile(agentFor(), relativePath);
    adapterConfig = deleted.adapterConfig;
  }

  return { adapterConfig, keptUndeletableFiles };
}

export class AgentMergeConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentMergeConflictError";
  }
}

export interface AgentMergeOutcome {
  /** Post-merge value of `agents.instructions_customized`. */
  instructionsCustomized: boolean;
  /** True when the bundle now holds catalog content byte-for-byte. */
  pureUpstream: boolean;
  /** Files the founder gave away that could not be deleted (entry file). */
  keptUndeletableFiles: string[];
}

/**
 * Land a reviewed agent update.
 *
 * ── What the customization flag becomes, and why ────────────────────────────
 *
 * `instructions_customized` is a statement about the CURRENT bundle, not about
 * the founder's history — `applyCrewAgentUpdate` already re-asserts `false`
 * after a successful full replacement for exactly that reason. So the merge
 * sets it from the bytes it just wrote:
 *
 * - every section accepted from upstream, same file set, same entry file →
 *   the bundle is indistinguishable from a fresh install → **`false`**, and the
 *   agent re-enters the auto-update path. This is the drain for the T2.6
 *   `null` backlog: an agent that was only ever "unknown provenance" can be
 *   reviewed once, found to have nothing of the founder's in it, and be made
 *   provably clean forever.
 * - anything of the founder's retained → **`true`**. Not `null`: after this
 *   commit the divergence is no longer unknown, it is known and deliberate.
 *
 * Getting this backwards in either direction is the expensive failure. Claiming
 * `false` while founder bytes remain re-opens them to a silent overwrite on the
 * next catalog bump; claiming `true` on a genuinely clean bundle freezes that
 * agent out of auto-update permanently. Hence `pureUpstream` is derived from
 * the resulting file set and bytes, never from "did they click accept on
 * everything" (see `applyAgentMergeDecisions`).
 *
 * ── What else lands ─────────────────────────────────────────────────────────
 *
 * The same catalog-owned, non-instruction fields `applyCrewAgentUpdate` writes:
 * `skillKeys`, `runtimeConfig.aoa.toolAllowlist`, `templateVersion`, and the
 * trigger set. They must move together with `templateVersion` — a row stamped
 * at the new version while still carrying the old skill set would silently
 * claim content it does not have, and `checkCrewUpdates` would never look at it
 * again. **D23 composes unchanged:** a protected AoA agent keeps its triggers
 * here exactly as it does on the auto path.
 */
export async function mergeAgentUpdate(opts: {
  db: Db;
  instructions: AgentBundleServiceLike;
  agent: MergeableAgentRow;
  catalogItem: CatalogItem;
  pendingUpdateId: string;
  decisions: Record<string, "mine" | "theirs">;
}): Promise<AgentMergeOutcome> {
  const { db, agent, catalogItem, pendingUpdateId } = opts;

  const { diff, upstream, local, localEntryFile } = await computeAgentUpdateDiff({
    instructions: opts.instructions,
    agent,
    catalogItem,
  });

  const merged = applyAgentMergeDecisions(diff, opts.decisions, {
    mine: local.files,
    upstream: upstream.files,
  });

  const { adapterConfig, keptUndeletableFiles } = await writeMergedAgentBundle({
    instructions: opts.instructions,
    agent,
    merged,
    upstreamEntryFile: upstream.entryFile,
    localEntryFile,
    localFiles: local.files,
    virtualPaths: local.virtualPaths,
  });

  const pureUpstream =
    merged.pureUpstream
    && keptUndeletableFiles.length === 0
    // A shadowed file is local content the merge could neither read nor
    // reconcile. Claiming pure catalog content over it would re-open the agent
    // to auto-update while an unaccounted local file sits in its bundle.
    && local.shadowedPaths.size === 0;
  const instructionsCustomized = !pureUpstream;

  const protectedRole = protectedAgentRole({
    name: agent.name,
    templateOrigin: agent.templateOrigin ?? catalogItem.id,
  });

  const existingRc = agent.runtimeConfig ?? {};
  const existingAoa = asRecord(existingRc.aoa);
  const newAoa = asRecord(upstream.template.runtimeConfig?.aoa);
  const updatedRc = {
    ...existingRc,
    aoa: {
      ...existingAoa,
      ...(newAoa.toolAllowlist !== undefined ? { toolAllowlist: newAoa.toolAllowlist } : {}),
    },
  };

  await db.transaction(async (tx) => {
    // Claim the pending row FIRST. The unique (companyId, catalogItemId) row is
    // the only thing serialising two founders (or one double-click) merging the
    // same update: whoever flips it out of pending/conflict wins, the loser
    // aborts before writing the agent row. It cannot un-write the files the
    // loser already put on disk — but those are the loser's own merged content,
    // and the winner's transaction wrote the row that describes it.
    const claimed = await tx
      .update(marketplacePendingUpdates)
      .set({ status: "applied", updatedAt: new Date() })
      .where(
        and(
          eq(marketplacePendingUpdates.id, pendingUpdateId),
          eq(marketplacePendingUpdates.companyId, agent.companyId),
          inArray(marketplacePendingUpdates.status, ["pending", "conflict"]),
        ),
      )
      .returning({ id: marketplacePendingUpdates.id });

    if (claimed.length === 0) {
      throw new AgentMergeConflictError(
        "This update was already applied or dismissed by another session.",
      );
    }

    const updatedRows = await tx
      .update(agents)
      .set({
        adapterConfig,
        skillKeys: upstream.template.skillKeys,
        runtimeConfig: updatedRc,
        templateVersion: catalogItem.version,
        instructionsCustomized,
        updatedAt: new Date(),
      })
      .where(and(eq(agents.id, agent.id), eq(agents.companyId, agent.companyId)))
      .returning({ id: agents.id });

    if (updatedRows.length === 0) {
      throw new AgentMergeConflictError("Agent no longer exists in this company.");
    }

    if (protectedRole) {
      logger.info(
        { agentId: agent.id, role: protectedRole.slug, catalogItemId: catalogItem.id },
        "marketplace: preserving protected AoA agent's triggers through a reviewed merge (D23)",
      );
    } else {
      await tx.delete(aoaAgentTriggers).where(eq(aoaAgentTriggers.agentId, agent.id));
      for (const trigger of upstream.template.triggers ?? []) {
        await tx.insert(aoaAgentTriggers).values({
          companyId: agent.companyId,
          agentId: agent.id,
          kind: trigger.kind,
          enabled: trigger.enabled,
          config: trigger.config,
        });
      }
    }
  });

  logger.info(
    {
      agentId: agent.id,
      catalogItemId: catalogItem.id,
      version: catalogItem.version,
      instructionsCustomized,
      keptUndeletableFiles,
    },
    "marketplace: reviewed agent merge applied",
  );

  return { instructionsCustomized, pureUpstream, keptUndeletableFiles };
}
