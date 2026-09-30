import { eq, and, inArray } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { teams, teamMembers, companySkills, projects } from "@armyofagents/db";
import type { CascadeStepResult } from "@armyofagents/db";
import type { CatalogItem, MarketplaceCatalogFile } from "@armyofagents/shared";
import { fetchCatalogResource } from "./fetch-resource.js";
import type { NormalizedMarketplaceAgentTemplate } from "./types.js";
import { parseMarketplaceAgentTemplate, normalizeMarketplaceAgentTemplate } from "./agent-runtime.js";
import { createMarketplaceAgent } from "./agent-create.js";
import { installSkill } from "./skill-installer.js";
import {
  createBundleCheckoutCache,
  disposeBundleCheckoutCache,
} from "./skill-bundle-materializer.js";
import { resolveAgentNameConflict, resolveTeamSlugConflict } from "./conflict-resolver.js";
import {
  DEFAULT_CREW_TEAM_ITEM_ID,
  STEWARD_CATALOG_ITEM_ID,
} from "./crew-constants.js";

export interface InstallTeamOpts {
  catalogItem: CatalogItem;            // type='team'
  catalog: MarketplaceCatalogFile;     // for resolving requires
  companyId: string;
  /**
   * Department to parent the team under. `null`/absent = a company-wide team
   * (D21) — used by the internal crew bootstrap, which runs before any
   * department exists. The public install route still requires one for
   * founder-initiated team installs (marketplace-installs.ts).
   */
  targetDepartmentId?: string | null;
  db: Db;
  installPlugin: PluginInstallerFn;    // injected to break circular dep
  /**
   * Caller deadline for the whole install. Chained into every resource fetch
   * (team template, agent templates, skill bodies) and re-checked before each
   * phase and before each skill install, so an install cannot outrun the
   * caller's budget by more than one in-flight batch. Absent = unbounded (the
   * existing 202-accepted route path).
   *
   * It reaches the skill bundle materializer's `git` subprocesses too
   * (`installSkill` forwards it), so a stalled clone is killed rather than left
   * to git's own connect timeout.
   */
  signal?: AbortSignal;
  /**
   * How many resource fetches / skill installs to run at once. Defaults to 1
   * (sequential — the historical behaviour) so the public install route is
   * unchanged; the company-create bootstrap opts up, because it is the caller
   * that pays the latency synchronously.
   */
  fetchConcurrency?: number;
}

/**
 * Run `worker` over `items` with at most `limit` in flight. Rejects with the
 * first error (remaining in-flight requests are left to settle and ignored;
 * the caller's abort signal is what actually stops them).
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const width = Math.max(1, Math.min(limit, items.length));
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function run(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: width }, run));
  return results;
}

function assertNotAborted(signal: AbortSignal | undefined, phase: string): void {
  if (signal?.aborted) {
    throw new Error(`Team install exceeded its deadline before ${phase}`);
  }
}

export type PluginInstallerFn = (opts: {
  catalogItem: CatalogItem;
  companyId: string;
  db: Db;
}) => Promise<{ pluginId: string; alreadyInstalled: boolean }>;

export interface InstallTeamResult {
  teamId: string;
  cascadeResults: CascadeStepResult[];
}

interface TeamTemplateBody {
  slug: string;
  description?: string;
  manifest?: Record<string, unknown>;
  agents: Array<{ templateOrigin: string; name: string; overrides?: Record<string, unknown> }>;
}

/**
 * Install a team catalog item via Saga pattern (4 phases).
 *
 * **Phase 1 — Pre-flight (no writes):**
 *   - Validate target department exists and belongs to company (skipped when
 *     no department is supplied — that installs a company-wide team, D21)
 *   - Validate all required catalog items resolve in the catalog
 *   - Fetch + parse team.json + each required agent.json
 *
 * **Phase 2 — Plugin preconditions (writes, idempotent):**
 *   - For each required plugin, call installPlugin (no-op if already installed)
 *   - Plugins are NEVER auto-uninstalled if subsequent phases fail (M2.D7)
 *
 * **Phase 3 — Required skills (writes, idempotent, OUTSIDE the txn):**
 *   - Each missing skill goes through the real {@link installSkill}, so bundles
 *     are materialized and `trustLevel`/`fileInventory`/bundle metadata are
 *     derived rather than assumed. See the phase body for why it is outside the
 *     transaction and why an already-present key is skipped rather than upgraded.
 *
 * **Phase 4 — Atomic team body (single Postgres txn):**
 *   - Insert each agent row (one per agent in team.json)
 *   - Insert team row + team_members links (first agent = lead)
 *   - All-or-nothing — txn rollback on any error
 *
 * Marketplace skills use sourceType="catalog" and record the catalog tier in
 * metadata.catalogTrustTier; `trustLevel` reflects what the bundle actually
 * contains (markdown_only / assets / scripts_executables).
 *
 * @throws Error from any phase. Writes from earlier phases (plugins, skill rows)
 * are NOT rolled back on a later failure — both are additive and idempotent, and
 * a retry re-uses them.
 */
export async function installTeam(opts: InstallTeamOpts): Promise<InstallTeamResult> {
  const { catalogItem, catalog, companyId, targetDepartmentId, db, installPlugin, signal } = opts;
  const fetchConcurrency = opts.fetchConcurrency ?? 1;

  if (catalogItem.type !== "team") {
    throw new Error(`installTeam called with non-team item: ${catalogItem.id}`);
  }

  const cascadeResults: CascadeStepResult[] = [];
  const itemsById = new Map(catalog.items.map((i) => [i.id, i]));

  // ====== Phase 1: Pre-flight ======
  const phase1Start = Date.now();

  // 1a: Target department exists? Skipped entirely for a company-wide install
  // (D21) — there is nothing to validate. When an id IS supplied it is still
  // fully validated (exists + belongs to this company + is a department); a
  // bad id is an error, never a silent fallback to company-wide.
  const parentProjectId = targetDepartmentId ?? null;
  if (parentProjectId !== null) {
    const dept = await db
      .select()
      .from(projects)
      .where(and(eq(projects.id, parentProjectId), eq(projects.companyId, companyId)))
      .limit(1);
    if (dept.length === 0 || dept[0].type !== "department") {
      throw new Error(`Target department not found: ${parentProjectId}`);
    }
  }

  // 1b: Resolve requires
  const requires = catalogItem.requires ?? [];
  for (const req of requires) {
    if (!itemsById.has(req.id)) {
      throw new Error(`Required catalog item not found: ${req.id}`);
    }
  }

  // 1c: Fetch team.json
  assertNotAborted(signal, "the team template fetch");
  const teamBody = JSON.parse(
    await fetchCatalogResource(catalogItem, "team template", signal),
  ) as TeamTemplateBody;
  if (catalogItem.id === DEFAULT_CREW_TEAM_ITEM_ID) {
    const stewardMembers = teamBody.agents.filter(
      (member) => member.templateOrigin === STEWARD_CATALOG_ITEM_ID,
    );
    if (stewardMembers.length !== 1) {
      throw new Error(
        `AoA default crew must contain exactly one Steward (${STEWARD_CATALOG_ITEM_ID}); ` +
          `team.json contained ${stewardMembers.length}`,
      );
    }
  }

  // 1d: Pre-fetch + normalize all agent.json bodies (fail fast).
  // Uses parseMarketplaceAgentTemplate + normalizeMarketplaceAgentTemplate so
  // both legacy and agent.v1 formats are handled uniformly and createMarketplaceAgent
  // in Phase 3 receives fully-normalized templates instead of raw JSON.
  const requiredAgentItems = requires
    .filter((r) => r.type === "agent")
    .map((r) => itemsById.get(r.id)!)
    .filter(Boolean);
  const normalizedAgentTemplates = new Map<string, NormalizedMarketplaceAgentTemplate>();
  assertNotAborted(signal, "the agent template fetches");
  const normalizedPairs = await mapWithConcurrency(requiredAgentItems, fetchConcurrency, async (a) => {
    const text = await fetchCatalogResource(a, "agent template", signal);
    const parsed = parseMarketplaceAgentTemplate(text, a);
    // availableAdapterTypes=[] — team-installer has no adapter registry context;
    // the check is skipped when the list is empty (see normalizeMarketplaceAgentTemplate).
    const normalized = normalizeMarketplaceAgentTemplate({
      parsed,
      catalogItem: a,
      availableAdapterTypes: [],
    });
    return [a.id, normalized] as const;
  });
  for (const [id, normalized] of normalizedPairs) {
    normalizedAgentTemplates.set(id, normalized);
  }

  // 1e: Resolve the required skill items. Their BODIES are deliberately not
  // pre-fetched here: `installSkill` (phase 3) loads inline content, fetches
  // `resourceUrl`, or materializes the bundle — whichever is right for the item
  // — so pre-fetching would be a second, discarded network round-trip per skill
  // (17 of them for the live crew roster, none of which carry inline content).
  const requiredSkillItems = requires
    .filter((r) => r.type === "skill")
    .map((r) => itemsById.get(r.id)!)
    .filter(Boolean);

  cascadeResults.push({
    step: "preflight",
    itemId: catalogItem.id,
    status: "success",
    durationMs: Date.now() - phase1Start,
  });

  // ====== Phase 2: Plugin preconditions ======
  const requiredPluginItems = requires
    .filter((r) => r.type === "plugin")
    .map((r) => itemsById.get(r.id)!)
    .filter(Boolean);

  for (const p of requiredPluginItems) {
    const phase2Start = Date.now();
    try {
      const result = await installPlugin({ catalogItem: p, companyId, db });
      cascadeResults.push({
        step: "plugin-precondition",
        itemId: p.id,
        status: "success",
        resultEntityId: result.pluginId,
        durationMs: Date.now() - phase2Start,
      });
    } catch (err) {
      cascadeResults.push({
        step: "plugin-precondition",
        itemId: p.id,
        status: "failure",
        errorMessage: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - phase2Start,
      });
      throw err;
    }
  }

  // ====== Phase 3: Required skills ======
  //
  // Through the REAL `installSkill`, and deliberately OUTSIDE the phase-4
  // transaction. Both halves are load-bearing (T2.3c):
  //
  // *Real installer* — a hand-rolled insert cannot materialize
  // `catalogItem.skill.bundle`, cannot derive `trustLevel` from what the bundle
  // actually contains, and cannot record a real `fileInventory` or the
  // `catalogSkillBundle` / `catalogBundleInstallPath` metadata that
  // `company-skills.ts` reads to deliver a skill's ancillary files to an agent.
  // Worse, stamping `sourceRef` to the current version makes `installSkill`'s
  // own idempotency guard answer `alreadyInstalled` for that key from then on —
  // so the bundle would never be materialized for the company. Every skill the
  // published crew team requires carries a bundle.
  //
  // *Outside the transaction* — `installSkill` git-clones each bundle. Holding a
  // Postgres transaction open across N clones is not acceptable, and it is safe
  // in a way the agent writes are not: these are additive, idempotent,
  // version-scoped NEW-FILE writes, never a delete of founder data. If phase 4
  // then fails, the rows simply survive and the next attempt re-uses them.
  // Nothing depends on them rolling back with the team — `uninstallTeam` already
  // leaves company_skills in place ("they may be shared with other agents").
  assertNotAborted(signal, "the skill installs");
  const phase3Start = Date.now();
  if (requiredSkillItems.length > 0) {
    // Any key this company already has is SKIPPED, not upgraded — the historical
    // behaviour of the `onConflictDoNothing` this replaces. It also keeps
    // `installSkill`'s different-version throw ("use the update flow") out of the
    // team path: a founder installing a team must not fail because one required
    // skill is pinned at an older version. Upgrades belong to the update flow.
    const existingSkillRows = await db
      .select({ id: companySkills.id, key: companySkills.key })
      .from(companySkills)
      .where(
        and(
          eq(companySkills.companyId, companyId),
          inArray(
            companySkills.key,
            requiredSkillItems.map((item) => item.id),
          ),
        ),
      );
    const existingSkillIdByKey = new Map(existingSkillRows.map((row) => [row.key, row.id]));

    // One clone per (repo, commit) for the WHOLE install rather than one per
    // skill. A team's bundles cluster hard on a few repos — the published crew
    // team draws 17 bundles from 4 repos — and `git clone --no-checkout` still
    // downloads the entire object database, so without this most of the clones
    // are byte-for-byte redundant and several run concurrently against the same
    // repo. Per-install, never module-global: see BundleCheckoutCache.
    const checkoutCache = createBundleCheckoutCache();
    try {
      // Collected index-ordered and pushed afterwards so `cascadeResults` stays
      // deterministic regardless of `fetchConcurrency`.
      const skillSteps = await mapWithConcurrency(
        requiredSkillItems,
        fetchConcurrency,
        async (skillItem): Promise<CascadeStepResult> => {
          const startedAt = Date.now();
          const existingId = existingSkillIdByKey.get(skillItem.id);
          if (existingId) {
            return {
              step: "skill-install",
              itemId: skillItem.id,
              status: "skipped",
              resultEntityId: existingId,
              durationMs: Date.now() - startedAt,
            };
          }
          // Re-checked per item. The signal ALSO reaches the clone itself
          // (installSkill → materializeSkillBundle → execFile), so an abort kills
          // a running `git` rather than merely stopping the next install from
          // starting; what is unbounded is the abort's own latency, not the clone.
          assertNotAborted(signal, `the skill install for ${skillItem.id}`);
          const result = await installSkill({
            catalogItem: skillItem,
            companyId,
            db,
            signal,
            checkoutCache,
          });
          return {
            step: "skill-install",
            itemId: skillItem.id,
            status: result.alreadyInstalled ? "skipped" : "success",
            resultEntityId: result.skillId,
            durationMs: Date.now() - startedAt,
          };
        },
      );
      cascadeResults.push(...skillSteps);
    } finally {
      await disposeBundleCheckoutCache(checkoutCache);
    }
  }

  // ====== Phase 4: Atomic team body (single Postgres txn) ======
  // Last deadline check. Past this point the work is local DB writes inside one
  // transaction — fast, and aborting midway would only mean a rollback, so the
  // check belongs here rather than inside.
  assertNotAborted(signal, "the team-body transaction");
  const phase4Start = Date.now();
  const teamRow = await db.transaction(async (tx) => {
    // Insert agents (one per entry in team.json's agents array).
    // Routes through createMarketplaceAgent so kind, triggers, templateOrigin,
    // and templateVersion are set via the canonical install path.
    // Passing tx (cast to Db) creates a Drizzle savepoint inside the outer txn.
    const agentInsertResults: Array<{ id: string; templateOrigin: string }> = [];
    for (const teamAgent of teamBody.agents) {
      const normalized = normalizedAgentTemplates.get(teamAgent.templateOrigin);
      if (!normalized) {
        throw new Error(`team.json references unknown agent template: ${teamAgent.templateOrigin}`);
      }
      const agentItem = itemsById.get(teamAgent.templateOrigin);
      if (!agentItem) {
        throw new Error(`team.json references catalog agent not in catalog: ${teamAgent.templateOrigin}`);
      }
      const resolvedAgentName = await resolveAgentNameConflict({
        db: tx as unknown as Db,
        companyId,
        desiredName: teamAgent.name,
      });
      // No instructionsService passed: team-installer does not materialize
      // instruction bundles during install (they are materialized on first
      // agent run via the adapter's lazy-load path, or via a follow-up update).
      const { agentId } = await createMarketplaceAgent({
        catalogItem: agentItem,
        companyId,
        db: tx as unknown as Db,
        desiredName: resolvedAgentName,
        template: normalized,
        // Reuse the historical NULL-origin Steward during upgrades (and on an
        // idempotent retry) instead of minting Steward-2.
        adoptLegacySteward: catalogItem.id === DEFAULT_CREW_TEAM_ITEM_ID,
      });
      agentInsertResults.push({ id: agentId, templateOrigin: teamAgent.templateOrigin });
      cascadeResults.push({
        step: "agent-install",
        itemId: teamAgent.templateOrigin,
        status: "success",
        resultEntityId: agentId,
        durationMs: 0,
      });
    }

    // A team row with no agents is not a crew — and it is a permanent trap.
    // `TeamTemplateBody` is an unchecked JSON.parse cast, so a published
    // team.json shipping `"agents": []` (or the field renamed and defaulted)
    // would commit the `teams` row with zero members, return success, and make
    // `crewTeamIsInstalled` true forever: no crew agents, legacy seeders
    // permanently suppressed, repair permanently short-circuited.
    //
    // `undefined` is already safe (the for…of above throws and rolls back);
    // `[]` is the hole. This is a CROSS-REPO trigger — the catalog lives in
    // MeteoriteLabs/aoa-marketplace — so it must fail closed here.
    if (agentInsertResults.length === 0) {
      throw new Error(
        `team.json for ${catalogItem.id} declared no agents — refusing to install an empty team`,
      );
    }

    // Insert team row
    const resolvedSlug = await resolveTeamSlugConflict({
      db: tx as unknown as Db,
      companyId,
      desiredSlug: teamBody.slug,
    });
    const teamInserted = await tx
      .insert(teams)
      .values({
        companyId,
        parentProjectId,
        name: catalogItem.name,
        slug: resolvedSlug,
        description: teamBody.description ?? catalogItem.description,
        manifest: teamBody.manifest ?? {},
        templateOrigin: catalogItem.id,
        templateVersion: catalogItem.version,
      })
      .returning();

    // Link agents to team via team_members. First inserted agent is "lead",
    // remainder are "member". Satisfies team_members_one_lead_uq partial unique.
    for (let idx = 0; idx < agentInsertResults.length; idx++) {
      await tx
        .insert(teamMembers)
        .values({
          teamId: teamInserted[0].id,
          agentId: agentInsertResults[idx].id,
          role: idx === 0 ? "lead" : "member",
        });
    }

    cascadeResults.push({
      step: "team-body-txn",
      itemId: catalogItem.id,
      status: "success",
      resultEntityId: teamInserted[0].id,
      durationMs: Date.now() - phase4Start,
    });

    return teamInserted[0];
  });

  return { teamId: teamRow.id, cascadeResults };
}
