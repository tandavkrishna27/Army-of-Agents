import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { agents, aoaAgentTriggers, marketplacePendingUpdates } from "@armyofagents/db";
import type { CatalogItem, MarketplaceSettings } from "@armyofagents/shared";
import { fetchCatalogResource } from "./fetch-resource.js";
import { parseMarketplaceAgentTemplate, normalizeMarketplaceAgentTemplate } from "./agent-runtime.js";
import { loadMarketplaceInstructionFiles } from "./agent-create.js";
import type { AgentInstructionsServiceLike } from "./agent-create.js";
import { marketplaceNotifications } from "../marketplace-notifications.js";
import { compareVersions } from "../marketplace-update-checker.js";
import { isWithinUpdateWindow } from "./skill-auto-updater.js";
import { protectedAgentRole } from "../protected-agents.js";
import { logger } from "../../middleware/logger.js";
import { serializeSafeError } from "../safe-error.js";

export interface CrewAgentRow {
  id: string;
  companyId: string;
  name: string;
  adapterType: string;
  adapterConfig: Record<string, unknown> | null;
  runtimeConfig: Record<string, unknown> | null;
  skillKeys: string[];
  templateVersion: string | null;
  /**
   * D22 gate input. `false` = provably untouched → replaceable. `true` = edited.
   * `null`/absent = unknown → treated as edited. See `agents.instructionsCustomized`.
   */
  instructionsCustomized: boolean | null;
}

export interface CrewUpdateCheckFailure {
  companyId: string;
  agentId: string;
  catalogItemId: string;
  stage: "pending_update" | "notification";
  error: unknown;
}

/**
 * Thrown when the agent's instruction bundle is (or may be) founder-edited, so
 * a full replacement would destroy work. The caller falls back to notify.
 *
 * Mirrors `SkillCustomizedError` deliberately — the two are the same product
 * rule applied to the two customizable artifact kinds.
 */
export class AgentInstructionsCustomizedError extends Error {
  constructor(
    readonly agentId: string,
    readonly state: boolean | null | undefined,
  ) {
    super(
      `Agent ${agentId} instruction bundle is ${state === true ? "customized" : "of unknown provenance"}; ` +
        "skipping full-replacement update",
    );
    this.name = "AgentInstructionsCustomizedError";
  }
}

/**
 * Is this row safe to full-replace? Only a hard `false` qualifies.
 *
 * Fails closed on `null`/`undefined`: a row whose customization state was never
 * recorded is exactly the row whose edits we cannot see.
 */
function isReplaceable(state: boolean | null | undefined): boolean {
  return state === false;
}

/**
 * Apply a full-replacement update to a single crew agent.
 *
 * ── D22: instruction files are FOUNDER CONFIG, not app code ─────────────────
 *
 * This module previously asserted the opposite, verbatim:
 *
 * > "DESIGN DECISION: instruction files are app code, not user config.
 * >  replaceExisting: true → ALL files replaced (no preservation of edits)."
 *
 * That is **reversed** (Decision #114 / D22). Agent instruction bundles are
 * founder-editable through a first-class editor (`routes/agents.ts`
 * `/agents/:id/instructions-bundle*`), which is the whole reason that editor
 * exists — so treating what it writes as disposable app code made every catalog
 * bump a silent, unrecoverable data loss. Edits are now tracked exactly like
 * skill edits (`company_skills.customized`): a customized agent routes to
 * NOTIFY, never to replace.
 *
 * What is still fully replaced, for a row that is provably untouched:
 * instructions, `skillKeys`, `runtimeConfig.aoa.toolAllowlist`,
 * `templateVersion`, and triggers (DELETE + re-INSERT).
 *
 * Deliberately does NOT touch `name`, `role`, `title`, `icon`, `capabilities`,
 * `permissions`, `metadata` or `adapterType` — those are the founder's, not the
 * catalog's.
 *
 * **D23 exception:** for a protected AoA agent the trigger replacement is
 * skipped entirely (see the guard at the DELETE below). That carve-out is
 * unchanged by D22 and composes with it: D22 decides *whether* this function
 * runs at all, D23 narrows *what* it writes once it does.
 *
 * ── Ordering is load-bearing ────────────────────────────────────────────────
 *
 * The D22 gate runs FIRST, before any fetch and before
 * `materializeManagedBundle(..., { replaceExisting: true })` — whose first act
 * is `fs.rm(rootPath, { recursive: true, force: true })` on the directory
 * holding the founder's edits (`agent-instructions.ts`), outside any
 * transaction. A gate placed inside the transaction would throw *after* the
 * files were already gone, which is no gate at all.
 *
 * ⚠️ **Residual race, measured rather than hand-waved.** There are THREE checks,
 * and they bound progressively tighter windows:
 *
 * 1. The gate below reads `agentRow` — a snapshot from `checkCrewUpdates`' one
 *    batch SELECT of every crew agent, taken BEFORE its loop. For the k-th
 *    agent that snapshot is stale by every preceding agent's entire apply cycle.
 *    This gate is therefore about avoiding pointless work, not about safety.
 * 2. A single indexed re-read immediately before `materializeManagedBundle`.
 *    This is the real disk-safety gate; the window it leaves is the gap between
 *    that read and the `fs.rm`.
 * 3. The transactional `instructions_customized = false` predicate, which closes
 *    the DATABASE half completely.
 *
 * A founder edit committing inside window (2) is still lost on disk. Closing it
 * needs the edit routes and this path to share a lock; not done, not claimed.
 *
 * ⚠️ **Two different post-materialize failure states — do not conflate them:**
 *
 * - **Ordinary transaction failure** (DB error): the row keeps its old
 *   `templateVersion` while the bundle on disk already holds new catalog
 *   content. Catalog-vs-catalog inconsistency, no founder work lost, and the
 *   next pass converges it.
 * - **Lost optimistic lock** (a founder edit committed inside window (2), so the
 *   UPDATE's `= false` predicate matches nothing): the `fs.rm` has ALREADY run,
 *   so the edit is gone from disk. The resulting state is one no reader would
 *   guess: DB says `instructions_customized = true` with the OLD
 *   `templateVersion`, while disk holds pure catalog content and none of the
 *   founder's bytes. The founder sees a pending update rather than a silent
 *   success — which is the best available outcome, not a good one.
 *
 * Do NOT call this from a path that has not consulted `agentUpdatePolicy`.
 * (T2.3b's crew repair deliberately does not: it adopts the row POINTER and
 * leaves content to this policy-respecting path. See `services/crew-repair.ts`.
 * Its adopted rows carry `instructionsCustomized = null`, so they route to
 * notify here — correct, because repair genuinely cannot know whether the
 * legacy bundle it adopted was edited.)
 *
 * @throws {AgentInstructionsCustomizedError} when the bundle is, or may be,
 * founder-edited. Callers must catch and fall back to notify.
 */
export async function applyCrewAgentUpdate(opts: {
  db: Db;
  agentRow: CrewAgentRow;
  catalogItem: CatalogItem;
  instructionsService: AgentInstructionsServiceLike;
}): Promise<void> {
  const { db, agentRow, catalogItem, instructionsService } = opts;

  // D22 GATE — before the fetch, and above all before the fs.rm.
  if (!isReplaceable(agentRow.instructionsCustomized)) {
    throw new AgentInstructionsCustomizedError(agentRow.id, agentRow.instructionsCustomized);
  }

  // D23: is this row a protected AoA agent? `catalogItem.id` is the origin the
  // row is being updated against, which is the strongest identity signal
  // available here — `CrewAgentRow` does not carry `templateOrigin`, and a row
  // only reaches this function because `checkCrewUpdates` matched it to this
  // item. The name is checked too (`protectedAgentRole` falls through to it),
  // so a mis-pointed row is still recognised.
  const protectedRole = protectedAgentRole({ name: agentRow.name, templateOrigin: catalogItem.id });

  const bodyText = await fetchCatalogResource(catalogItem, "agent template for update");
  const parsed = parseMarketplaceAgentTemplate(bodyText, catalogItem);
  const template = normalizeMarketplaceAgentTemplate({ parsed, catalogItem, availableAdapterTypes: [] });
  const instructionFiles = await loadMarketplaceInstructionFiles(catalogItem, template);

  const agentForMaterialize = {
    id: agentRow.id,
    companyId: agentRow.companyId,
    name: agentRow.name,
    role: "general",
    adapterType: agentRow.adapterType,
    adapterConfig: agentRow.adapterConfig,
  };

  // D22/F2 — SECOND gate, as late as possible before the destructive write.
  //
  // The snapshot the first gate read came from `checkCrewUpdates`' single batch
  // SELECT of every crew agent, taken BEFORE the loop. For the k-th agent that
  // snapshot is stale by every preceding agent's full apply cycle (template
  // fetch + N instruction-file fetches + fs.rm + writes + transaction) PLUS this
  // agent's own two network fetches above — seconds to tens of seconds over a
  // CDN, not a tight window. One indexed PK read collapses it to the gap between
  // here and the `fs.rm` below.
  //
  // It does NOT close the window; only a lock shared with the edit routes would,
  // and that is deliberately out of scope. Fails closed on a vanished row.
  const [live] = await db
    .select({ instructionsCustomized: agents.instructionsCustomized })
    .from(agents)
    .where(eq(agents.id, agentRow.id))
    .limit(1);
  if (!live || !isReplaceable(live.instructionsCustomized)) {
    throw new AgentInstructionsCustomizedError(agentRow.id, live?.instructionsCustomized ?? null);
  }

  const materialized = instructionFiles
    ? await instructionsService.materializeManagedBundle(
        agentForMaterialize,
        instructionFiles.files,
        {
          entryFile: instructionFiles.entryFile,
          replaceExisting: true,
          clearLegacyPromptTemplate: true,
        },
      )
    : null;

  // Merge new toolAllowlist into runtimeConfig.aoa (replace, not merge)
  const existingRc = agentRow.runtimeConfig ?? {};
  const existingAoa = (existingRc.aoa as Record<string, unknown>) ?? {};
  const newAoa = (template.runtimeConfig?.aoa as Record<string, unknown>) ?? {};
  const updatedRc = {
    ...existingRc,
    aoa: {
      ...existingAoa,
      ...(newAoa.toolAllowlist !== undefined ? { toolAllowlist: newAoa.toolAllowlist } : {}),
    },
  };

  await db.transaction(async (tx) => {
    // D22 optimistic lock. `instructions_customized = false` in the WHERE means
    // a founder edit that committed since the gate above wins: RETURNING comes
    // back empty and we throw instead of stamping the row as updated. NULL rows
    // never satisfy `= false`, so an unknown-provenance row is excluded here too
    // (defence in depth behind the gate).
    //
    // `instructionsCustomized: false` is re-asserted in the SET so the column
    // stays a statement about the CURRENT bundle: after this commit the bundle
    // on disk is catalog content again. It is what makes the flag meaningful for
    // T2.7's merge path, which will set it back to `true`.
    const updatedRows = await tx
      .update(agents)
      .set({
        skillKeys: template.skillKeys,
        runtimeConfig: updatedRc,
        templateVersion: catalogItem.version,
        instructionsCustomized: false,
        ...(materialized ? { adapterConfig: materialized.adapterConfig } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(agents.id, agentRow.id), eq(agents.instructionsCustomized, false)))
      .returning({ id: agents.id });

    if (updatedRows.length === 0) {
      // Either a concurrent founder edit flipped the flag, or the row vanished.
      // Both must abort the transaction: triggers and the pending-update row
      // below must not be written against an agent we did not actually update.
      throw new AgentInstructionsCustomizedError(agentRow.id, true);
    }

    // Replace triggers: delete existing, re-insert from catalog.
    // `enabled` is taken from the catalog (T2.3d) — an update must not silently
    // re-enable a trigger the catalog disabled.
    //
    // D23: SKIPPED ENTIRELY for a protected AoA agent. A protected agent's
    // triggers are AoA-owned, not catalog-owned, and the wipe is unrecoverable:
    // `sweep-steward.ts` selects on kind='sweep' + enabled=true, and
    // `seedCrewAgent` only seeds triggers for a NEWLY INSERTED row — so a
    // catalog template that omits the sweep trigger would silently stop Steward
    // forever, which is verbatim the harm the protected set exists to prevent.
    // The cost is that a catalog-ADDED trigger never reaches these two roles;
    // that is the right trade for two agents, and install (`agent-create.ts`)
    // still honours the template's triggers on first install.
    if (protectedRole) {
      logger.info(
        { agentId: agentRow.id, role: protectedRole.slug, catalogItemId: catalogItem.id },
        "marketplace: preserving protected AoA agent's triggers through a catalog update",
      );
    } else {
      await tx.delete(aoaAgentTriggers).where(eq(aoaAgentTriggers.agentId, agentRow.id));
      for (const trigger of template.triggers ?? []) {
        await tx.insert(aoaAgentTriggers).values({
          companyId: agentRow.companyId,
          agentId: agentRow.id,
          kind: trigger.kind,
          enabled: trigger.enabled,
          config: trigger.config,
        });
      }
    }

    // Mark pending update as applied. `conflict` is accepted alongside
    // `pending` (T2.7): a row can be left in `conflict` by an earlier pass and
    // the agent subsequently become replaceable — a stale red badge must not
    // survive the apply that resolved it.
    await tx
      .update(marketplacePendingUpdates)
      .set({ status: "applied", updatedAt: new Date() })
      .where(
        and(
          eq(marketplacePendingUpdates.companyId, agentRow.companyId),
          eq(marketplacePendingUpdates.catalogItemId, catalogItem.id),
          inArray(marketplacePendingUpdates.status, ["pending", "conflict"]),
        ),
      );
  });

  logger.info(
    { agentId: agentRow.id, catalogItemId: catalogItem.id, version: catalogItem.version },
    "marketplace: crew agent update applied",
  );
}

/**
 * Check all installed crew agents against the catalog for new versions.
 *
 * - auto policy + within window + **provably untouched instructions** → apply
 *   immediately (silent, no notification).
 * - notify policy, outside window, or **customized/unknown instructions** →
 *   record pending_update + updateAvailable notification.
 *
 * D22: the customization test is deliberately routed through the SAME notify
 * machinery as the policy test rather than a parallel path, so a customized
 * agent produces the ordinary founder-visible pending-update row that T2.7's
 * diff/merge acts on.
 *
 * T2.7: the recorded row's status distinguishes the two reasons — `conflict`
 * when the local bundle is (or may be) divergent, `pending` when only policy or
 * the update window held it back. `pending` rows can be taken with one click via
 * `POST /updates/:id/apply`; `conflict` rows need the reviewed merge.
 */
export async function checkCrewUpdates(opts: {
  db: Db;
  companyId: string;
  catalogItems: CatalogItem[];
  settings: MarketplaceSettings;
  instructionsService: AgentInstructionsServiceLike;
  onFailure?: (failure: CrewUpdateCheckFailure) => void;
}): Promise<void> {
  const {
    db,
    companyId,
    catalogItems,
    settings,
    instructionsService,
    onFailure,
  } = opts;
  const catalogById = new Map(catalogItems.map((item) => [item.id, item]));

  const crewAgents = await db
    .select({
      id: agents.id,
      name: agents.name,
      adapterType: agents.adapterType,
      adapterConfig: agents.adapterConfig,
      runtimeConfig: agents.runtimeConfig,
      skillKeys: agents.skillKeys,
      templateOrigin: agents.templateOrigin,
      templateVersion: agents.templateVersion,
      instructionsCustomized: agents.instructionsCustomized,
    })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.kind, "aoa")));

  for (const agent of crewAgents) {
    if (!agent.templateOrigin || agent.templateOrigin.endsWith("@legacy")) continue;
    if (!agent.templateVersion) continue;

    const catalogItem = catalogById.get(agent.templateOrigin);
    if (!catalogItem) continue;
    if (catalogItem.version === agent.templateVersion) continue;

    // D22: a customized (or unknown-provenance) bundle is never auto-replaced,
    // whatever the policy says. `agentUpdatePolicy: "auto"` is consent to take
    // catalog content over CATALOG content — not consent to discard the
    // founder's own edits, which they would have no way to recover.
    // Hoisted so the diagnostic below can report it — and evaluated once, so a
    // window boundary crossed mid-loop cannot make the decision and the log
    // disagree.
    const withinWindow = isWithinUpdateWindow(settings.updateWindow);
    const autoApply =
      settings.agentUpdatePolicy === "auto" &&
      withinWindow &&
      isReplaceable(agent.instructionsCustomized);

    if (autoApply) {
      try {
        await applyCrewAgentUpdate({
          db,
          agentRow: { ...agent, companyId },
          catalogItem,
          instructionsService,
        });
        continue;
      } catch (err) {
        logger.error(
          { error: serializeSafeError(err), agentId: agent.id },
          "marketplace: crew auto-update failed — notifying",
        );
      }
    } else if (
      settings.agentUpdatePolicy === "auto" &&
      !isReplaceable(agent.instructionsCustomized)
    ) {
      // `withinWindow` is in the payload deliberately: D22 and the update window
      // can BOTH be suppressing an auto-apply, and a message naming only D22
      // would send whoever debugs "why didn't my auto-update apply" down the
      // wrong path.
      logger.info(
        {
          agentId: agent.id,
          catalogItemId: catalogItem.id,
          instructionsCustomized: agent.instructionsCustomized,
          withinWindow,
        },
        "marketplace: crew agent instructions are customized (or of unknown provenance) — " +
          "routing the update to notify instead of full replacement (D22)" +
          (withinWindow ? "" : " (the update window is also closed)"),
      );
    }

    // T2.7 — WRITE the `conflict` status.
    //
    // `conflict` was read in three places (the apply route's stale-status guard,
    // `UpdateCard`'s badge, `MarketplaceUpdatesPanel`'s filter) and written
    // nowhere: a dead enum behind a dead badge. It means exactly one thing —
    // **this update cannot be taken wholesale, because the local copy diverges
    // (or may diverge) from the catalog.** That is the D22 condition, and it is
    // strictly narrower than "pending": a plain `pending` agent update is one
    // held back only by policy or the update window, and clicking Apply on it
    // lands without a review.
    //
    // Surfacing it here rather than at review time is the point. Before this,
    // the founder learned an update was contested only after opening the modal;
    // now the Inbox/Settings list distinguishes "newer version available" from
    // "newer version available AND your edits are in the way" at a glance.
    const divergent = !isReplaceable(agent.instructionsCustomized);
    const nextStatus = divergent ? "conflict" : "pending";

    // Notify path: record the pending update, then emit its idempotent founder
    // hub item. Existing live rows also re-emit so a prior delivery failure is
    // repaired; hubItemsService deduplicates successful retries by source key.
    let shouldNotify = false;
    let shouldReopenNotification = false;
    try {
      const inserted = await db
        .insert(marketplacePendingUpdates)
        .values({
          companyId,
          catalogItemId: catalogItem.id,
          catalogItemName: catalogItem.name,
          itemType: "agent",
          currentVersion: agent.templateVersion ?? "0.0.0",
          latestVersion: catalogItem.version,
          status: nextStatus,
        })
        .onConflictDoNothing()
        .returning({ id: marketplacePendingUpdates.id });
      shouldNotify = inserted.length > 0;
      shouldReopenNotification = shouldNotify;

      if (!shouldNotify) {
        // A row already exists for this (companyId, catalogItemId) — the unique
        // index means `onConflictDoNothing` can never update it, so every
        // transition has to happen here.
        //
        // ⚠️ **The agent path is the ONLY writer of `itemType: "agent"` rows.**
        // `upsertPendingUpdate` (marketplace-update-checker.ts) — which owns the
        // equivalent logic for skills and plugins, including re-opening an
        // `applied`/`dismissed` row for a genuinely newer release — has no agent
        // caller; `checkCompany` still carries a `TODO: Add agent + team
        // template checks`. So there is no other path that will ever revive
        // these rows, and this block must handle all four states itself:
        //
        // - `pending` / `conflict` → reconcile status + versions. Bidirectional
        //   on purpose: an agent whose divergence a merge resolved is no longer
        //   in conflict, and a stale red badge is its own kind of lie.
        // - `applied` / `dismissed` → re-open ONLY for a version strictly newer
        //   than the one that was applied or dismissed. Without this, dismiss
        //   was permanent *per agent* rather than per version, and an agent that
        //   ever took an update never announced another one: the row sat
        //   `applied` with `latestVersion` frozen and invisible to the panel,
        //   the reconcile and the insert alike. Mirrors
        //   `upsertPendingUpdate`'s rule exactly so the two kinds behave the
        //   same.
        const [existing] = await db
          .select({
            status: marketplacePendingUpdates.status,
            latestVersion: marketplacePendingUpdates.latestVersion,
          })
          .from(marketplacePendingUpdates)
          .where(
            and(
              eq(marketplacePendingUpdates.companyId, companyId),
              eq(marketplacePendingUpdates.catalogItemId, catalogItem.id),
            ),
          )
          .limit(1);

        const isLive = existing?.status === "pending" || existing?.status === "conflict";
        const catalogAdvanced =
          existing !== undefined
          && compareVersions(catalogItem.version, existing.latestVersion) > 0;
        const isNewerRelease =
          existing !== undefined
          && !isLive
          && catalogAdvanced;

        if (existing && (isLive || isNewerRelease)) {
          await db
            .update(marketplacePendingUpdates)
            .set({
              status: nextStatus,
              // `currentVersion` is refreshed too: the agent's version can move
              // by another path (a merge, an adoption), and a row still showing
              // the version it was minted at renders a wrong "1 → 3".
              currentVersion: agent.templateVersion ?? "0.0.0",
              latestVersion: catalogItem.version,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(marketplacePendingUpdates.companyId, companyId),
                eq(marketplacePendingUpdates.catalogItemId, catalogItem.id),
                inArray(
                  marketplacePendingUpdates.status,
                  isLive ? ["pending", "conflict"] : ["applied", "dismissed"],
                ),
              ),
            );
          // Re-opened rows are news. Live rows re-emit too: the previous pass
          // may have persisted the row before its founder notification failed.
          shouldNotify = isLive || isNewerRelease;
          shouldReopenNotification = catalogAdvanced;
        }
      }
    } catch (err) {
      logger.error(
        { error: serializeSafeError(err) },
        "marketplace: failed to record pending update",
      );
      onFailure?.({
        companyId,
        agentId: agent.id,
        catalogItemId: catalogItem.id,
        stage: "pending_update",
        error: err,
      });
    }
    if (shouldNotify) {
      try {
        await marketplaceNotifications.updateAvailable(
          db,
          companyId,
          catalogItem.id,
          catalogItem.name,
          agent.templateVersion ?? "0.0.0",
          catalogItem.version,
          { reopenWhenArchived: shouldReopenNotification },
        );
      } catch (err) {
        logger.error(
          { error: serializeSafeError(err) },
          "marketplace: updateAvailable notification failed",
        );
        onFailure?.({
          companyId,
          agentId: agent.id,
          catalogItemId: catalogItem.id,
          stage: "notification",
          error: err,
        });
      }
    }
  }
}
