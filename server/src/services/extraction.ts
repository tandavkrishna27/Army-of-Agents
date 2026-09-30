import { eq, and, desc, gt, gte, sql, ne, isNull, asc, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Db } from "@armyofagents/db";
import { debriefs, briefs, briefItems, projects, discussions, discussionEntries, discussionExtractedItems, internalAgentConfig, threadScopeVersions } from "@armyofagents/db";
import { logger } from "../middleware/logger.js";
import { tenantIsolationEnforced } from "../config/deployment-mode.js";
import { publishLiveEvent } from "./live-events.js";
import { parseExtractedItems, type ExtractedItem, type ExtractedItemType } from "./extraction-parser.js";
import { resolveExtractionEngine, resolveCompanyCliTool } from "./extraction-engine.js";
import { extractViaCli, CliExtractionError } from "./extraction-cli.js";
import {
  resolveCompanyProviderCredential,
  type CompanyProviderCredential,
} from "./one-shot-provider-credential.js";
import type { OneShotSandboxHandle } from "./one-shot-sandbox-cli.js";
import { acquireExecutionContext } from "./acquire-execution-context.js";
import { resolveRuntimeProviderConfig, environmentRuntimeService } from "./environment-runtime.js";
import { runtimeProviderKeyService } from "./runtime-provider-keys.js";
import { preflightOneShotCliSpend, type OneShotBudgetPreflightResult } from "./one-shot-cli-budget.js";
import {
  buildDiscussionPendingHubEmit,
  buildExtractionFailedHubEmit,
  emitHubItem,
} from "./hub-source-producers.js";
import { hubItemsService } from "./hub-items.js";

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

// Re-export pure parser symbols so existing importers (`from "./extraction.js"`)
// continue to work unchanged after the move to extraction-parser.ts.
export { parseExtractedItems } from "./extraction-parser.js";
export type { ExtractedItem, ExtractedItemType } from "./extraction-parser.js";

// W2 (extract-then-scope) bounds for `extractThreadEntriesAwait`. Exported so
// the unit tests pin against the real values (no silent caps).
export const MAX_EXTRACT_ENTRIES_PER_SCOPE = 25;
export const EXTRACT_SCOPE_DEADLINE_MS = 180_000; // eng-review D2 — see W2 plan
/** The extractor's own "trivially short" threshold (Codex #270 P2, round 8): entries
 *  under this are PERMANENTLY non-extractable ("ok", "thanks") — extract-then-scope
 *  must neither attempt them nor let them cap the draft range, or a short greeting at
 *  the head of the unscoped range wedges scoping for the whole thread forever. */
export const MIN_EXTRACTABLE_CONTENT_LENGTH = 10;
/** Codex #270 P2 (round 11): a `processing` claim older than this is a crashed
 *  worker's leftovers — extract-then-scope may re-claim it. Far above the
 *  extractor's own per-entry CLI timeout, so a LIVE worker is never re-claimed;
 *  low enough that a zombie row cannot cap scoping for long. The atomic claim
 *  stamps sourceInfo.extractionClaimedAt (epoch ms) to make this measurable. */
export const EXTRACTION_PROCESSING_STALE_MS = 10 * 60_000;

const EXTRACTION_PROMPT_TEMPLATE = `You are extracting structured items from a founder's discussion entry — raw notes, meeting summaries, brainstorming, or pasted conversations.

Previous entries in this thread (if any) are provided for context. Extract ONLY from the new entry — do not re-extract items already covered in previous entries.

Available departments and projects:
{{DEPARTMENTS_AND_PROJECTS_LIST}}

Extract these item types:

1. DECISIONS — conclusions, choices, or commitments made
2. TASKS — concrete action items (single work items assignable to one person, not epics or vague goals)
3. INSIGHTS — notable observations, patterns, or learnings worth remembering
4. CONTEXT — background facts or data points worth storing
5. REFERENCES — durable links, contacts, docs, or resources worth retrieving later
6. PREFERENCES — founder/team preferences about style, tooling, process, or constraints

Skip: greetings, filler, small talk, emotional commentary, vague ideas without clear substance, and anything already captured in previous entries.

For each item return:
- type: 'decision' | 'task' | 'insight' | 'context' | 'reference' | 'preference'
- title: concise one-line title (under 80 chars)
- description: 1-3 sentence explanation with enough context to act on later
- priority: 'urgent' | 'high' | 'medium' | 'low' (tasks only, omit if unclear)
- department: most relevant name from the list above, or null
- layer: one of:
  - 'identity' — company-wide vision, values, enduring preferences
  - 'domain' — department standards, processes, guidelines
  - 'active_context' — goal/project-scoped, persists while work is active
  - 'working' — task-scoped notes, ephemeral execution details
  - default to 'domain' if unclear

Return [] if the entry contains no extractable items.
Do not infer or fabricate items. Do not force department matches — use null if uncertain.
Respond ONLY with a valid JSON array. No markdown, no explanation.

Example input: "Had a call with Acme Corp. They want the dashboard done by April 15. We decided to use Tailwind instead of custom CSS. Sarah should set up the CI pipeline this week."

Example output:
[
  {"type":"decision","title":"Use Tailwind CSS for dashboard","description":"Team decided to use Tailwind instead of custom CSS for the dashboard project.","department":"Engineering","layer":"domain"},
  {"type":"task","title":"Set up CI pipeline","description":"Sarah should configure the CI pipeline this week.","priority":"high","department":"Engineering","layer":"working"},
  {"type":"context","title":"Acme Corp dashboard deadline is April 15","description":"Client Acme Corp expects the dashboard completed by April 15.","department":null,"layer":"active_context"}
]

Example input: "Hey, just checking in. Nothing new really, will update tomorrow."

Example output:
[]`;

/**
 * Build the departments/projects list string for the extraction prompt.
 */
async function buildDepartmentsList(
  db: Db,
  companyId: string,
): Promise<{ text: string; lookup: Map<string, { id: string; type: string }> }> {
  const rows = await db
    .select({ id: projects.id, name: projects.name, type: projects.type })
    .from(projects)
    .where(eq(projects.companyId, companyId));

  const lookup = new Map<string, { id: string; type: string }>();

  if (rows.length === 0) {
    return { text: "(No departments or projects configured yet)", lookup };
  }

  const lines: string[] = [];
  for (const row of rows) {
    const label = row.type === "department" ? "Department" : "Project";
    lines.push(`- ${row.name} (${label})`);
    lookup.set(row.name.toLowerCase(), { id: row.id, type: row.type });
  }

  return { text: lines.join("\n"), lookup };
}

/**
 * U13.2: resolve the company's own model-provider credential (U13.0) when
 * running under tenant isolation (`cloud_auth`) — extraction there must route
 * through the ephemeral sandbox authenticated with the COMPANY's key, never
 * the ambient host CLI login (the operator-cred sink). Returns `null` on
 * desktop/self-hosted deployments, where extraction still uses the ambient
 * host CLI login and no company key is threaded.
 *
 * Factored out (rather than folded into `resolveCliExtractionContext`) so
 * `extractFromDiscussionEntry` — which resolves `cliTool` via its own
 * `agentConfig` read, not `resolveCliExtractionContext` — can share the same
 * one-line gate without re-querying `internal_agent_config` a second time.
 * `resolveCompanyProviderCredential` throws `ProviderUnavailableError`
 * UNCHANGED when no company key resolves (U13.0) — this helper does not
 * catch it; the caller's existing catch-all failure handling terminalizes
 * the entry the same way any other extraction-setup failure does.
 */
async function resolveCliCredentialIfCloud(
  db: Db,
  companyId: string,
  cliTool: string,
): Promise<CompanyProviderCredential | null> {
  return tenantIsolationEnforced()
    ? resolveCompanyProviderCredential(db, companyId, { cliTool })
    : null;
}

/**
 * Resolve the keyless-CLI extraction context for a company: the CLI tool to
 * spawn, the codex model hint to forward, and (on cloud) the company's own
 * resolved provider credential (U13.2 — threaded so the sandbox path never
 * needs the ambient host CLI login). Mirrors how the discussion path derives
 * `cliTool` + `codexModel` from `internal_agent_config`. Used by the
 * debrief-push, file-import, and memory-candidate extraction paths.
 */
async function resolveCliExtractionContext(
  db: Db,
  companyId: string,
): Promise<{ cliTool: string; codexModel: string | null; credential: CompanyProviderCredential | null }> {
  const cliTool = await resolveCompanyCliTool(db, companyId);
  const [config] = await db
    .select({ model: internalAgentConfig.model })
    .from(internalAgentConfig)
    .where(eq(internalAgentConfig.companyId, companyId));
  const credential = await resolveCliCredentialIfCloud(db, companyId, cliTool);
  return { cliTool, codexModel: config?.model ?? null, credential };
}

// Best-effort extraction_failed hub emit (Task 10, D3). Called at the two
// terminal-failure sites; NEVER throws — a failed emit must not mask the fact
// that we already marked the entry failed. Re-fetches the discussion for its
// title/owner so the catch-site (where `discussion` is out of scope) can still
// emit a well-formed item; a gone discussion just yields a generic title.
async function emitExtractionFailureItem(
  db: Db,
  args: {
    companyId: string;
    discussionId: string;
    entryId: string;
    failureKind: string | null;
    failureMessage: string | null;
  },
): Promise<void> {
  try {
    const [discussion] = await db
      .select({ title: discussions.title, ownerUserId: discussions.ownerUserId })
      .from(discussions)
      .where(eq(discussions.id, args.discussionId));
    await emitHubItem(
      db,
      buildExtractionFailedHubEmit({
        entryId: args.entryId,
        discussionId: args.discussionId,
        companyId: args.companyId,
        discussionTitle: discussion?.title ?? null,
        ownerUserId: discussion?.ownerUserId ?? null,
        failureKind: args.failureKind,
        failureMessage: args.failureMessage,
        updatedAt: new Date(),
      }),
    );
  } catch (emitErr) {
    logger.warn({ err: emitErr, entryId: args.entryId }, "extraction_failed hub emit failed");
  }
}

// Best-effort archive of the extraction_failed hub item once the entry recovers
// (reprocess reset to pending, or a successful extraction). Terminal is decided
// by the discussion_entry reconciler (extractionStatus !== 'failed'). NEVER
// throws — a stale failure item is not worth failing the recovery path.
export async function closeExtractionFailedItem(
  db: Db,
  companyId: string,
  entryId: string,
): Promise<void> {
  try {
    await hubItemsService(db).reconcile(companyId, {
      sourceType: "discussion_entry",
      sourceId: entryId,
    });
  } catch (err) {
    logger.warn({ err, entryId }, "closeExtractionFailedItem reconcile failed");
  }
}

export function extractionService(db: Db) {
  return {
    /**
     * Main extraction function. Fetches debrief content, calls LLM,
     * creates Brief + BriefItems, updates debrief status.
     */
    extractFromDebrief: async (companyId: string, debriefId: string) => {
      const log = logger.child({ service: "extraction", debriefId, companyId });

      try {
        // 1. Fetch the debrief
        const [debrief] = await db
          .select()
          .from(debriefs)
          .where(
            and(eq(debriefs.id, debriefId), eq(debriefs.companyId, companyId)),
          );

        if (!debrief) {
          log.error("Debrief not found");
          return;
        }

        // 2. Build prompt with departments list
        const { text: deptList, lookup: deptLookup } =
          await buildDepartmentsList(db, companyId);
        const prompt = EXTRACTION_PROMPT_TEMPLATE.replace(
          "{{DEPARTMENTS_AND_PROJECTS_LIST}}",
          deptList,
        );

        // 3. Extract via the keyless CLI (no hosted provider key) — on cloud,
        //    `credential` routes the spawn through the ephemeral sandbox (U13.2).
        const { cliTool, codexModel, credential } = await resolveCliExtractionContext(
          db,
          companyId,
        );
        log.info({ cliTool }, "Starting CLI extraction");
        const extractedItems = await extractViaCli(cliTool, prompt, debrief.rawContent, {
          codexModel,
          credential,
          companyId,
          db,
        });
        log.info({ itemCount: extractedItems.length }, "Extraction complete");

        // 4-6. Create Brief + BriefItems + update debrief atomically
        await db.transaction(async (tx) => {
          const [brief] = await tx
            .insert(briefs)
            .values({
              companyId,
              debriefId,
              status: "ready",
              departmentId: debrief.departmentId,
              projectId: debrief.projectId,
              goalId: debrief.goalId,
            })
            .returning();

          // 5. Create BriefItems
          if (extractedItems.length > 0) {
            const itemValues = extractedItems.map((item) => {
              // Resolve department name to ID
              let suggestedDepartmentId: string | null = null;
              let suggestedProjectId: string | null = null;

              if (item.department) {
                const match = deptLookup.get(item.department.toLowerCase());
                if (match) {
                  if (match.type === "department") {
                    suggestedDepartmentId = match.id;
                  } else {
                    suggestedProjectId = match.id;
                  }
                }
              }

              return {
                briefId: brief.id,
                type: item.type,
                title: item.title,
                description: item.description || null,
                suggestedPriority: item.priority || null,
                suggestedDepartmentId,
                suggestedProjectId,
                suggestedLayer: item.layer ?? "domain",
                layer: item.layer ?? "domain",
                status: "pending" as const,
              };
            });

            await tx.insert(briefItems).values(itemValues);
          }

          // 6. Update debrief status to 'ready'
          await tx
            .update(debriefs)
            .set({ status: "ready" })
            .where(eq(debriefs.id, debriefId));

          log.info(
            { briefId: brief.id, itemCount: extractedItems.length },
            "Brief created successfully",
          );
        });
      } catch (err) {
        const log = logger.child({
          service: "extraction",
          debriefId,
          companyId,
        });
        log.error({ err }, "Extraction failed");

        // Update debrief status to 'processing_failed'
        await db
          .update(debriefs)
          .set({ status: "processing_failed" })
          .where(eq(debriefs.id, debriefId))
          .catch((updateErr) => {
            log.error({ err: updateErr }, "Failed to update debrief status after extraction failure");
          });
      }
    },

    extractFromDiscussionEntry: async (
      companyId: string,
      entryId: string,
      /** U13.2/U13.3: pre-acquired batch sandbox lease — one sandbox reused
       *  across a whole extract-then-scope pass, supplied by
       *  `extractThreadEntriesAwait`'s batch acquire (U13.3). When omitted
       *  (direct call, e.g. reprocess-single-entry, or the batch acquire
       *  itself failed), the cloud path (via `extractViaCli` ->
       *  `runOneShotCliInSandbox`) self-acquires its own ephemeral sandbox
       *  for just this one entry. */
      sandboxHandle?: OneShotSandboxHandle,
    ) => {
      const log = logger.child({ service: "extraction", entryId, companyId });
      let discussionId = "";

      try {
        // 1. Fetch the entry
        const [entry] = await db
          .select()
          .from(discussionEntries)
          .where(and(eq(discussionEntries.id, entryId)));

        if (!entry) {
          log.error("Discussion entry not found");
          return;
        }

        discussionId = entry.discussionId;

        // P1-T7: scope_proposal entries are NOT prose for the extractor — their
        // rawContent is a structured proposal JSON and their lifecycle lives in
        // proposalStatus. Never claim/extract them: doing so would flip their
        // extractionStatus (pending -> processing -> completed) and corrupt the
        // Approve handler's idempotency read. Last line of defense behind the
        // dispatcher sweep filter + the "skipped" insert default.
        if (entry.inputType === "scope_proposal") {
          log.info("Entry is a scope_proposal — skipping extraction (not extractable prose)");
          return;
        }

        // Atomic claim: flip pending -> processing in a single statement.
        // Only the writer that gets a row back proceeds. This replaces the
        // prior non-atomic read-then-check, fixing a pre-existing race
        // (concurrent reprocess / reprocess-all) AND making the durable
        // sweeper (sub-agent #1) safe to run alongside the untouched
        // reprocess direct-call path.
        //
        // Codex #270 P2 (round 11): the claim also stamps
        // sourceInfo.extractionClaimedAt (epoch ms, merged — transcription/MCP
        // metadata preserved) so extract-then-scope can tell a LIVE in-flight
        // claim (cap the draft range before it) from a crashed worker's zombie
        // row (re-claimable after EXTRACTION_PROCESSING_STALE_MS).
        const claimed = await db
          .update(discussionEntries)
          .set({
            extractionStatus: "processing",
            sourceInfo: sql`COALESCE(${discussionEntries.sourceInfo}, '{}'::jsonb) || jsonb_build_object('extractionClaimedAt', ${Date.now()}::bigint)`,
          })
          .where(
            and(
              eq(discussionEntries.id, entryId),
              eq(discussionEntries.extractionStatus, "pending"),
            ),
          )
          .returning();
        if (claimed.length === 0) {
          log.info(
            { currentStatus: entry.extractionStatus },
            "Entry not claimable (already processing/terminal) — skipping",
          );
          return;
        }

        // 2. Fetch parent discussion for companyId verification
        const [discussion] = await db
          .select()
          .from(discussions)
          .where(eq(discussions.id, entry.discussionId));

        if (!discussion || discussion.companyId !== companyId) {
          log.error("Discussion not found or company mismatch");
          return;
        }

        // 3. Skip trivially short content
        if (!entry.rawContent || entry.rawContent.trim().length < MIN_EXTRACTABLE_CONTENT_LENGTH) {
          log.info("Content too short — skipping extraction");
          await db
            .update(discussionEntries)
            .set({
              extractionStatus: "skipped",
              sourceInfo: sql`jsonb_set(COALESCE(${discussionEntries.sourceInfo}, '{}'::jsonb), '{extractionError}', '"Content too short to extract from."'::jsonb)`,
            })
            .where(eq(discussionEntries.id, entryId));
          return;
        }

        // 4. Resolve the extraction ENGINE. Extraction is CLI-only (keyless) —
        //    `resolveExtractionEngine` returns "cli" or throws. The `skipped`
        //    outcome happens when no supported CLI is available; a hosted
        //    provider key is NEVER consulted (keys are embeddings-only).
        try {
          await resolveExtractionEngine(db, companyId);
        } catch (engineErr) {
          const msg =
            engineErr instanceof Error
              ? engineErr.message
              : "No extraction engine available. Install a CLI (e.g. the Claude Code CLI) and run its login flow (`claude auth login`).";
          log.warn(msg);
          await db
            .update(discussionEntries)
            .set({
              extractionStatus: "skipped",
              sourceInfo: sql`jsonb_set(COALESCE(${discussionEntries.sourceInfo}, '{}'::jsonb), '{extractionError}', ${JSON.stringify(msg)}::jsonb)`,
            })
            .where(eq(discussionEntries.id, entryId));
          return;
        }

        // (status was already set to 'processing' by the atomic claim above)

        // 5. Fetch agent config (CLI tool hint + codex model for the keyless
        //    extractor). Cheap single read.
        const [agentConfig] = await db
          .select()
          .from(internalAgentConfig)
          .where(eq(internalAgentConfig.companyId, companyId));

        // 6. Get thread context (most recent 10 entries, excluding current).
        const previousEntries = await db
          .select()
          .from(discussionEntries)
          .where(eq(discussionEntries.discussionId, entry.discussionId))
          .orderBy(desc(discussionEntries.createdAt))
          .limit(11);

        const threadContext = previousEntries
          .filter((e: any) => e.id !== entryId)
          .slice(0, 10)
          .reverse()
          .map((e: any) => e.rawContent)
          .join("\n---\n");

        // 7. Build extraction prompt. Shared by BOTH engines — there is no
        //    second extraction prompt to maintain.
        const { text: deptList, lookup: deptLookup } =
          await buildDepartmentsList(db, companyId);
        const prompt = EXTRACTION_PROMPT_TEMPLATE.replace(
          "{{DEPARTMENTS_AND_PROJECTS_LIST}}",
          deptList,
        );

        const userContent = threadContext
          ? `Previous context:\n${threadContext}\n\n---\n\nNew entry to extract from:\n${entry.rawContent}`
          : entry.rawContent;

        let extractedItems: ExtractedItem[] = [];

        // ── Keyless CLI extraction ──────────────────────────────────────
        // Extraction is CLI-only — no hosted provider key is ever consulted.
        // extractViaCli returns already-parsed ExtractedItem[] (no
        // parseExtractedItems step).
        const cliTool = agentConfig?.cliTool ?? (await resolveCompanyCliTool(db, companyId));
        log.info({ cliTool }, "Using CLI engine for extraction (keyless)");

        // U13.2: on cloud, resolve the COMPANY's own provider credential so
        // extractViaCli routes this spawn through the ephemeral sandbox
        // instead of the ambient host CLI login (the operator-cred sink).
        // `null` on desktop/self-hosted — extraction there is unchanged.
        const credential = await resolveCliCredentialIfCloud(db, companyId, cliTool);

        // Bounded retry for transient timeout failures (up to 3 attempts total).
        // Only `timeout` errors are retried — structural errors (not_installed,
        // not_authed, nonzero_exit, unparseable, sandbox_unavailable) terminalize
        // immediately (U13.3: a missing/unavailable sandbox is a structural
        // condition, not a transient one — retrying would just re-fail the
        // same way and burn the per-entry timeout budget three times over).
        const MAX_CLI_ATTEMPTS = 3;
        const CLI_RETRY_DELAY_MS = 500;
        let lastCliErr: CliExtractionError | undefined;

        for (let attempt = 1; attempt <= MAX_CLI_ATTEMPTS; attempt++) {
          try {
            extractedItems = await extractViaCli(cliTool, prompt, userContent, {
              codexModel: agentConfig?.model ?? null,
              credential,
              companyId,
              db,
              sandboxHandle,
            });
            lastCliErr = undefined; // success — clear any prior transient error
            break; // exit retry loop
          } catch (cliErr) {
            if (!(cliErr instanceof CliExtractionError)) {
              // Non-CLI error (e.g. DB, network): rethrow into the outer catch.
              throw cliErr;
            }

            if (cliErr.kind !== "timeout") {
              // Structural failure (not_installed, not_authed, nonzero_exit,
              // unparseable, sandbox_unavailable) — no point retrying,
              // terminalize immediately.
              lastCliErr = cliErr;
              break;
            }

            // Transient timeout — retry if we have attempts left.
            lastCliErr = cliErr;
            if (attempt < MAX_CLI_ATTEMPTS) {
              log.warn(
                { attempt, maxAttempts: MAX_CLI_ATTEMPTS, kind: cliErr.kind },
                "CLI extraction timed out — retrying",
              );
              await new Promise<void>((resolve) => setTimeout(resolve, CLI_RETRY_DELAY_MS));
            }
          }
        }

        if (lastCliErr !== undefined) {
          // All attempts exhausted (or non-retryable error) — terminalize failed.
          // There is NO hosted-API fallback: extraction is CLI-only. Record kind
          // + message so the failure UX can surface actionable CLI guidance.
          const failPayload = JSON.stringify({
            kind: lastCliErr.kind,
            message: lastCliErr.message,
          });
          log.error(
            { kind: lastCliErr.kind, err: lastCliErr },
            "CLI extraction failed (all attempts exhausted)",
          );
          await db
            .update(discussionEntries)
            .set({
              extractionStatus: "failed",
              sourceInfo: sql`jsonb_set(COALESCE(${discussionEntries.sourceInfo}, '{}'::jsonb), '{extractionError}', ${failPayload}::jsonb)`,
            })
            .where(eq(discussionEntries.id, entryId));

          publishLiveEvent({
            companyId,
            type: "discussion.extraction.failed",
            payload: { discussionId, entryId, error: lastCliErr.message },
          });
          // Inbox signal (Task 10, D3): the transient SSE above is not enough —
          // a founder who walks away must learn extraction stalled.
          await emitExtractionFailureItem(db, {
            companyId,
            discussionId,
            entryId,
            failureKind: lastCliErr.kind,
            failureMessage: lastCliErr.message,
          });
          return;
        }

        log.info({ itemCount: extractedItems.length }, "Extraction complete");

        await db.transaction(async (tx) => {
          // 7. Create extracted items
          if (extractedItems.length > 0) {
            const itemValues = extractedItems.map((item) => {
              let suggestedDepartmentId: string | null = null;
              let suggestedProjectId: string | null = null;

              if (item.department) {
                const match = deptLookup.get(item.department.toLowerCase());
                if (match) {
                  if (match.type === "department") {
                    suggestedDepartmentId = match.id;
                  } else {
                    suggestedProjectId = match.id;
                  }
                }
              }

              return {
                discussionEntryId: entryId,
                type: item.type,
                title: item.title,
                description: item.description || null,
                suggestedPriority: item.priority || null,
                suggestedDepartmentId,
                suggestedProjectId,
                suggestedLayer: item.layer ?? "domain",
                layer: item.layer ?? "domain",
                status: "pending" as const,
              };
            });

            await tx.insert(discussionExtractedItems).values(itemValues);

            // Increment discussion's pendingItemCount
            await tx
              .update(discussions)
              .set({
                pendingItemCount: sql`${discussions.pendingItemCount} + ${itemValues.length}`,
                updatedAt: new Date(),
              })
              .where(eq(discussions.id, entry.discussionId));
            const [discussion] = await tx
              .select()
              .from(discussions)
              .where(eq(discussions.id, entry.discussionId));
            if (discussion) {
              await emitHubItem(tx as unknown as Db, buildDiscussionPendingHubEmit(discussion));
            }
          }

          // 9. Mark completed
          await tx
            .update(discussionEntries)
            .set({ extractionStatus: "completed" })
            .where(eq(discussionEntries.id, entryId));
        });

        // 9. Publish completion event
        publishLiveEvent({
          companyId,
          type: "discussion.extraction.completed",
          payload: {
            discussionId: entry.discussionId,
            entryId,
            itemCount: extractedItems.length,
          },
        });

        // A successful (re)extraction auto-archives any prior extraction_failed
        // inbox item for this entry (Task 10, D3 — matches reconcile philosophy).
        await closeExtractionFailedItem(db, companyId, entryId);
      } catch (err) {
        log.error({ err }, "Discussion entry extraction failed");

        const errMessage = err instanceof Error ? err.message : String(err);
        await db
          .update(discussionEntries)
          .set({
            extractionStatus: "failed",
            sourceInfo: sql`jsonb_set(COALESCE(${discussionEntries.sourceInfo}, '{}'::jsonb), '{extractionError}', ${JSON.stringify(errMessage)}::jsonb)`,
          })
          .where(eq(discussionEntries.id, entryId))
          .catch((updateErr: any) => {
            log.error({ err: updateErr }, "Failed to update entry status after extraction failure");
          });

        publishLiveEvent({
          companyId,
          type: "discussion.extraction.failed",
          payload: { discussionId, entryId, error: err instanceof Error ? err.message : String(err) },
        });
        // Inbox signal (Task 10, D3) — same rationale as the CLI-exhausted site.
        await emitExtractionFailureItem(db, {
          companyId,
          discussionId,
          entryId,
          failureKind: null,
          failureMessage: errMessage,
        });
      }
    },

    /** W2 (D6 extract-then-scope): extract the thread's never-extracted entries and WAIT.
     *  Selection is conservative — entries with any existing extracted items are left
     *  alone (a founder may be mid-review; reprocess semantics stay in reprocessAllEntries).
     *  Serial (one CLI at a time), best-effort per entry, capped by COUNT
     *  (MAX_EXTRACT_ENTRIES_PER_SCOPE) and by WALL-CLOCK (eng-review D2:
     *  EXTRACT_SCOPE_DEADLINE_MS — a hung CLI must not stall the controller pipeline
     *  for ~50 min; give an honest answer within minutes). Never throws. */
    extractThreadEntriesAwait: async (
      companyId: string,
      discussionId: string,
      opts?: {
        /** Injectable extractor (tests). Defaults to the sibling
         *  extractFromDiscussionEntry. The third param is the U13.2/U13.3
         *  pre-acquired batch sandbox handle — on cloud (`tenantIsolationEnforced()`),
         *  this method acquires ONE sandbox for the whole pass (before the
         *  deadline clock starts) and passes it to every extractOne call
         *  (U13.3); on desktop, or if the batch acquire fails, it stays
         *  `undefined` and each entry self-acquires via `extractFromDiscussionEntry`
         *  -> `extractViaCli` -> `runOneShotCliInSandbox`. */
        extractOne?: (
          companyId: string,
          entryId: string,
          sandboxHandle?: OneShotSandboxHandle,
        ) => Promise<unknown>;
        /** Injectable clock for the deadline unit test. Defaults to Date.now. */
        now?: () => number;
      },
    ): Promise<{
      attempted: number;
      failed: number;
      truncated: boolean;
      deadlineHit: boolean;
      /** Highest entry seq actually attempted (null when none). */
      lastAttemptedSeq: number | null;
      /** Codex #270 P2 (round 6): the seq the DRAFT RANGE must end at, or null for no
       *  cap. Folds three signals: count-cap / deadline truncation (cap at the last
       *  attempted entry) AND the first attempted entry whose extraction did NOT end
       *  'completed' (cap just BEFORE it — a failed entry must stay in the NEXT scope's
       *  range and be retried; an accepted draft over it would silently omit its work).
       *  All-failed passes cap below the range start -> the compile yields no_entries ->
       *  no draft is minted and every entry stays retryable. */
      rangeEndCap: number | null;
    }> => {
      const log = logger.child({ service: "extraction", discussionId, companyId, mode: "scope-await" });
      const extractOne =
        opts?.extractOne ??
        ((c: string, e: string, h?: OneShotSandboxHandle) =>
          extractionService(db).extractFromDiscussionEntry(c, e, h));
      const now = opts?.now ?? Date.now;

      // U13.3: acquire ONE sandbox for the WHOLE batch, BEFORE the deadline
      // clock (`startedAt`) starts — acquire latency must never eat into the
      // per-entry EXTRACT_SCOPE_DEADLINE_MS budget. Cloud-only
      // (`tenantIsolationEnforced()`); desktop/self-hosted extraction never
      // needs a sandbox. Best-effort: an acquire failure is swallowed here
      // (logged) rather than aborting the pass — `sandboxHandle` stays
      // `undefined`, and every entry's own `extractFromDiscussionEntry` ->
      // `extractViaCli` -> `runOneShotCliInSandbox` self-acquires (U13.1/
      // U13.2 self-acquire fallback), hitting the SAME unavailability and
      // surfacing its own `sandbox_unavailable` failure per entry — the
      // `rangeEndCap` invariant still holds because a failed entry caps the
      // draft range before it (round-6 P2).
      let sandboxHandle: OneShotSandboxHandle | undefined;
      let releaseSandboxHandle: (() => Promise<unknown>) | undefined;
      if (tenantIsolationEnforced()) {
        // Wave 3 review (FIX 2, MEDIUM — budget bypass): gate the batch
        // acquire on the SAME budget preflight runOneShotCliInSandbox runs
        // per-entry (one-shot-cli-budget.ts) BEFORE any sandbox is booted —
        // an over-budget company must never boot (and be billed for) the
        // batch VM. Skipping the acquire here is safe: every entry falls
        // through to its own self-acquire attempt
        // (extractFromDiscussionEntry -> extractViaCli ->
        // runOneShotCliInSandbox), which re-runs this SAME gate and throws
        // sandbox_unavailable before spending anything — so no VM boots
        // either way, and the existing rangeEndCap/best-effort semantics (a
        // failed entry caps the draft range before it) are unchanged.
        const budgetPreflight: OneShotBudgetPreflightResult = await preflightOneShotCliSpend(db, { companyId }).catch(
          (err) => {
            log.warn(
              { err },
              "extract-then-scope: batch budget preflight failed (best-effort) — proceeding to acquire",
            );
            return { allowed: true };
          },
        );
        if (!budgetPreflight.allowed) {
          log.warn(
            { reason: budgetPreflight.reason },
            "extract-then-scope: company over budget — skipping batch sandbox acquire; entries will self-acquire and surface sandbox_unavailable",
          );
        } else {
          try {
            const cliTool = await resolveCompanyCliTool(db, companyId);
            const acquisition = await acquireExecutionContext(db, {
              runIdentity: {
                companyId,
                agentId: null,
                runId: randomUUID(),
                adapterType: cliTool === "codex" ? "codex_local" : "claude_local",
              },
              functionType: null, // one-shot batch CLI extraction has no functionType — always ephemeral
              warmPreference: false, // batch extraction is never warm (U7.5)
              worktree: null,
              environmentId: null, // no pin -> platform-default resolution (U1)
              issueId: null,
              heartbeatRunId: null,
            });
            const lease = acquisition.lease;
            if (acquisition.sandbox?.environment.driver === "sandbox" && lease) {
              const environment = acquisition.sandbox.environment;
              // Wave 3 review (FIX 1, orphan-safety, findings 1/2/3/7): wire
              // the release closure to the lease IMMEDIATELY — before
              // resolving provider config below — so a resolve-fault
              // between here and the sandboxHandle assignment can never
              // leak the batch VM (previously, a missing `provider` or a
              // resolveRuntimeProviderConfig throw left the just-acquired
              // lease with NO release closure at all). Routes through
              // environmentRuntimeService(...).releaseRunLease (mirrors the
              // crew fix at runner.ts:1677 and the one-shot self-acquire
              // fix in one-shot-sandbox-cli.ts) so the DB row actually
              // flips to 'released' — the raw provider release this
              // replaced only killed the VM and left an orphaned 'active'
              // environment_leases row (unreachable by the heartbeat-scoped
              // reaper, since this lease's heartbeatRunId is always null).
              releaseSandboxHandle = () =>
                environmentRuntimeService(db).releaseRunLease({ environment, lease, status: "released" });

              const provider = readString(lease.provider);
              if (provider) {
                const providerConfig = await resolveRuntimeProviderConfig({
                  companyId,
                  provider,
                  config: readObject(environment.config),
                  runtimeProviderKeys: runtimeProviderKeyService(db),
                  issueId: null,
                  heartbeatRunId: null,
                });
                sandboxHandle = { environment, lease, providerConfig };
              } else {
                log.warn(
                  { leaseId: lease.id },
                  "extract-then-scope: batch sandbox lease missing provider — entries will self-acquire",
                );
              }
            } else {
              log.warn(
                "extract-then-scope: no sandbox environment resolved for batch — entries will self-acquire",
              );
            }
          } catch (err) {
            log.warn(
              { err },
              "extract-then-scope: batch sandbox acquire failed — entries will self-acquire and surface sandbox_unavailable",
            );
          }
        }
      }

      const startedAt = now();
      try {
        // Codex #270 P1 (round 4): bound the selection to the UNSCOPED source range.
        // Entries already covered by an accepted/completed scope version can legally
        // still be skipped-with-no-items (human-created scopes, pre-W2 drafts, and the
        // proposedTasks path which skips extraction). Without this lower bound the
        // 25-entry/deadline budget burns on that old prefix, and worse: a truncated
        // pass could report lastAttemptedSeq <= latest.sourceEndSeq, capping the new
        // draft's range BELOW its sourceStartSeq -> no_entries -> the action commits
        // with no draft covering the new tail. Mirrors createDraftFromThread's
        // "next range starts after the last accepted/completed sourceEndSeq".
        const [scopedThrough] = (await db
          .select({ sourceEndSeq: threadScopeVersions.sourceEndSeq })
          .from(threadScopeVersions)
          .where(and(
            eq(threadScopeVersions.threadId, discussionId),
            inArray(threadScopeVersions.status, ["accepted", "completed"]),
          ))
          .orderBy(desc(threadScopeVersions.sourceEndSeq))
          .limit(1)) as Array<{ sourceEndSeq: number }>;
        const minSeq = (scopedThrough?.sourceEndSeq ?? 0) + 1;

        // Eligible: HUMAN prose entries never extracted — status pending/skipped/failed
        // AND no existing extracted items. Entries with items are a founder-review
        // surface; deleting/re-extracting them is reprocess-only semantics
        // (discussions.ts). Codex #270 P2: agent/system entries are excluded too —
        // scoping must derive work from the founder's instructions, not crew chatter
        // (same human discriminator as crew-task-service: authorAgentId IS NULL +
        // inputType not agent/system/scope_proposal). LEFT JOIN + isNull keeps only
        // zero-item entries, so join duplication is moot.
        const rows = (await db
          .select({
            id: discussionEntries.id,
            seq: discussionEntries.seq,
            extractionStatus: discussionEntries.extractionStatus,
            // Codex #270 P2 (round 11): the atomic claim stamps this (epoch ms) so a
            // LIVE in-flight claim is distinguishable from a crashed worker's zombie row.
            claimedAtMs: sql<string | null>`${discussionEntries.sourceInfo}->>'extractionClaimedAt'`,
          })
          .from(discussionEntries)
          .leftJoin(
            discussionExtractedItems,
            eq(discussionExtractedItems.discussionEntryId, discussionEntries.id),
          )
          .where(and(
            eq(discussionEntries.discussionId, discussionId),
            gte(discussionEntries.seq, minSeq),
            isNull(discussionEntries.authorAgentId),
            ne(discussionEntries.inputType, "agent"),
            ne(discussionEntries.inputType, "system"),
            ne(discussionEntries.inputType, "scope_proposal"),
            // 'processing' is selected too (round 11) — partitioned below into
            // in-flight (cap signal, never attempted) vs stale (re-claimed).
            inArray(discussionEntries.extractionStatus, ["pending", "skipped", "failed", "processing"]),
            isNull(discussionExtractedItems.id),
            // Codex #270 P2 (round 8): trivially-short entries are PERMANENTLY
            // non-extractable (the extractor skips them by design) — exclude them here
            // so they are never attempted and can never trip the first-failure range
            // cap. They sit inside the draft range harmlessly (no work to lose).
            sql`LENGTH(TRIM(COALESCE(${discussionEntries.rawContent}, ''))) >= ${MIN_EXTRACTABLE_CONTENT_LENGTH}`,
          ))
          .orderBy(asc(discussionEntries.seq))) as Array<{
            id: string; seq: number; extractionStatus: string; claimedAtMs: string | null;
          }>;

        // Codex #270 P2 (round 11): a FRESH `processing` row is in-flight — another
        // worker (background drain / reprocess) owns it. Never attempt it (double
        // extraction), but its content is not captured yet either, so the draft range
        // must stop BEFORE it — otherwise the items it produces seconds later land
        // below the next sourceStartSeq and are orphaned from every future scope
        // draft. A claim past EXTRACTION_PROCESSING_STALE_MS — or with no stamp at
        // all (pre-stamp deploys; all live claims stamp) — is a crashed worker's
        // zombie row: re-claim and attempt it like a failed entry, so a stranded row
        // can never cap scoping forever.
        const nowMs = now();
        const isInFlight = (r: { extractionStatus: string; claimedAtMs: string | null }) =>
          r.extractionStatus === "processing" &&
          r.claimedAtMs != null &&
          nowMs - Number(r.claimedAtMs) < EXTRACTION_PROCESSING_STALE_MS;
        const firstInFlightSeq = rows.find(isInFlight)?.seq ?? null;
        const attemptable = rows.filter((r) => !isInFlight(r));

        const truncated = attemptable.length > MAX_EXTRACT_ENTRIES_PER_SCOPE;
        const selected = attemptable.slice(0, MAX_EXTRACT_ENTRIES_PER_SCOPE);
        if (truncated) {
          log.warn(
            { eligible: attemptable.length, cap: MAX_EXTRACT_ENTRIES_PER_SCOPE },
            "extract-then-scope truncated eligible entries at cap",
          );
        }

        let failed = 0;
        let attempted = 0;
        let deadlineHit = false;
        // Codex #270 P1: track the highest seq actually attempted so a truncated pass
        // (cap or deadline) can cap the draft's sourceEndSeq — entries past this seq
        // were never extracted and MUST stay in the NEXT scope's range, not be silently
        // consumed by this draft's range accounting.
        let lastAttemptedSeq: number | null = null;
        let firstFailedSeq: number | null = null;
        for (const row of selected) {
          // Eng-review D2: wall-clock deadline — a hung-but-installed CLI must never turn
          // one scoping pass into a ~50-minute controller-pipeline stall. Compile with
          // whatever was extracted so far; the founder gets an honest answer in minutes.
          // The FIRST entry always runs (attempted > 0 guard): it keeps the invariant
          // "truncated/deadlineHit ⇒ lastAttemptedSeq != null" that the sourceEndSeq
          // capping relies on, and one entry is bounded by the extractor's own timeout.
          if (attempted > 0 && now() - startedAt > EXTRACT_SCOPE_DEADLINE_MS) {
            deadlineHit = true;
            log.warn(
              { attempted, remaining: selected.length - attempted, deadlineMs: EXTRACT_SCOPE_DEADLINE_MS },
              "extract-then-scope deadline hit — compiling with items extracted so far",
            );
            break;
          }
          try {
            if (row.extractionStatus !== "pending") {
              // extractFromDiscussionEntry only claims 'pending' rows. Guarded on the
              // status we SELECTED (round 11): a re-claimed stale-`processing` row's
              // zombie worker may land its terminal write between our select and this
              // flip — the guard makes that a 0-row update instead of clobbering it
              // (extractOne then finds nothing claimable, and the post-read below
              // handles whatever status the zombie wrote: completed → its items
              // compile normally; failed → caps the range like any failure).
              await db.update(discussionEntries)
                .set({ extractionStatus: "pending", extractionRunId: null })
                .where(and(
                  eq(discussionEntries.id, row.id),
                  eq(discussionEntries.extractionStatus, row.extractionStatus),
                ));
            }
            attempted += 1;
            lastAttemptedSeq = row.seq;
            // Call 2-arg when there is no batch handle (desktop, or the batch
            // acquire failed) — keeps call-shape byte-identical to pre-U13.3
            // for every existing 2-arg extractOne test double; 3-arg only
            // when a real batch sandboxHandle was acquired.
            if (sandboxHandle) {
              await extractOne(companyId, row.id, sandboxHandle);
            } else {
              await extractOne(companyId, row.id);
            }
            // Codex #270 P2 (round 6): extractFromDiscussionEntry handles its own
            // errors internally (marks the entry failed/skipped and RESOLVES), so a
            // clean await is not success. Re-read the outcome: anything other than
            // 'completed' means this entry's content was NOT captured — record the
            // first such seq so the draft range is capped just before it.
            if (firstFailedSeq == null) {
              const [after] = (await db
                .select({ extractionStatus: discussionEntries.extractionStatus })
                .from(discussionEntries)
                .where(eq(discussionEntries.id, row.id))
                .limit(1)) as Array<{ extractionStatus: string }>;
              if (after && after.extractionStatus !== "completed") {
                firstFailedSeq = row.seq;
                failed += 1;
                log.warn(
                  { entryId: row.id, seq: row.seq, status: after.extractionStatus },
                  "extract-then-scope entry did not complete — capping draft range before it",
                );
              }
            }
          } catch (err) {
            failed += 1;
            if (firstFailedSeq == null) firstFailedSeq = row.seq;
            log.warn({ err, entryId: row.id }, "extract-then-scope entry failed (best-effort)");
          }
        }
        // Fold the cap signals: truncation/deadline cap at the last attempted entry;
        // a mid-pass failure caps just BEFORE the first non-completed entry; an
        // in-flight (fresh `processing`) row caps just BEFORE it (round 11 — its
        // items land after this pass and must stay in the NEXT scope's range).
        // Min wins.
        const caps: number[] = [];
        if ((truncated || deadlineHit) && lastAttemptedSeq != null) caps.push(lastAttemptedSeq);
        if (firstFailedSeq != null) caps.push(firstFailedSeq - 1);
        if (firstInFlightSeq != null) {
          caps.push(firstInFlightSeq - 1);
          log.info(
            { firstInFlightSeq },
            "extract-then-scope: in-flight extraction ahead — capping draft range before it",
          );
        }
        const rangeEndCap = caps.length > 0 ? Math.min(...caps) : null;
        return { attempted, failed, truncated, deadlineHit, lastAttemptedSeq, rangeEndCap };
      } catch (err) {
        log.warn({ err }, "extract-then-scope selection failed (best-effort) — compiling without");
        return { attempted: 0, failed: 0, truncated: false, deadlineHit: false, lastAttemptedSeq: null, rangeEndCap: null };
      } finally {
        // U13.3: release the BATCH lease exactly ONCE, after the whole pass
        // (loop + selection), win or lose — ephemeral teardown (kill, never
        // pause). A `finally` on the outer try/catch runs after either return
        // path above, so this fires exactly once per extractThreadEntriesAwait
        // call regardless of how many entries were attempted.
        if (releaseSandboxHandle) {
          await releaseSandboxHandle().catch((err) => {
            log.warn({ err }, "extract-then-scope: batch sandbox release failed (best-effort)");
          });
        }
      }
    },

    /**
     * Extract structured memory items from raw text (e.g. imported file content).
     * Returns ExtractedItem[] — does NOT persist anything. Caller handles DB writes.
     * Falls back gracefully: if LLM is unavailable, returns [].
     * Caller should fall back to paragraph chunking when this returns [].
     */
    extractFromRawText: async (
      companyId: string,
      rawText: string,
    ): Promise<ExtractedItem[]> => {
      if (!rawText || rawText.trim().length < 10) return [];

      try {
        const { text: deptList } = await buildDepartmentsList(db, companyId);
        const systemPrompt = EXTRACTION_PROMPT_TEMPLATE.replace(
          "{{DEPARTMENTS_AND_PROJECTS_LIST}}",
          deptList,
        );
        const { cliTool, codexModel, credential } = await resolveCliExtractionContext(
          db,
          companyId,
        );
        // U13.5 — on cloud, stage the uploaded file's content into the
        // sandbox VM as a named file (extractViaCli's sandbox branch,
        // extraction-cli.ts) instead of concatenating it into stdinContent.
        // Desktop/self-hosted is unaffected — extractViaCli's local spawn
        // never reads `stagedFile`.
        const stagedFile = tenantIsolationEnforced()
          ? { remotePath: `/tmp/aoa-file-import-${randomUUID()}.txt`, content: rawText }
          : undefined;
        return await extractViaCli(cliTool, systemPrompt, rawText, {
          codexModel,
          credential,
          companyId,
          db,
          stagedFile,
        });
      } catch (err) {
        // CLI unavailable/unauth or timeout — caller falls back to paragraph chunking
        logger.warn({ err, companyId }, "extractFromRawText: CLI extraction failed, falling back to chunking");
        return [];
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 (Task C1) — Tool-callable extraction surface.
//
// The Phase 1 design eliminates Scribe as an *autonomous* agent. Extraction is
// instead exposed as a small set of named functions that other crew agents
// (Memory Keeper at phase=done, Adjutant optionally mid-discussion) invoke
// through their tool wrappers (built in Task C2 batch 3).
//
// Implementation notes:
//   • These exports REUSE every internal helper above — same prompt template,
//     same departments lookup, same JSON parser. There is no second extraction
//     prompt to maintain. The only divergence from `extractFromDiscussionEntry`
//     is that NOTHING is written to the database here: the caller (tool wrapper)
//     decides what to persist (e.g. `submit_extracted_items`-style inserts).
//   • `extractDecisions`, `extractInsights`, `extractReferences` are thin
//     filters over `extractMemoryCandidates` — DRY win. If a future tool
//     needs `extractTasks` or `extractPreferences` add another one-liner.
//   • The `ExtractionLlm` interface is a test/eval-only injection seam. In
//     production callers pass `null` and extraction runs through the keyless
//     CLI (`extractViaCli`). No hosted provider key is ever consulted.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal LLM surface the tool-callable extractors depend on — a single
 * `generate(prompt, content)` method. This is a TEST/EVAL-ONLY injection seam
 * (e.g. the memory-keeper eval injects a real OpenAI client for deterministic
 * quality measurement).
 *
 * In production callers pass `null`: extraction then runs through the keyless
 * CLI (`extractViaCli`). No hosted provider key is consulted.
 */
export interface ExtractionLlm {
  /**
   * Generate a completion. Implementations must return the raw text response;
   * `parseExtractedItems` will strip any markdown fences and parse the JSON.
   */
  generate(prompt: string, content: string): Promise<string>;
}

/**
 * Structured extraction candidate returned by the tool-callable extractors.
 *
 * Mirrors the writable columns on `discussion_extracted_items`, but the
 * extractor does NOT persist — the tool wrapper decides what to insert. The
 * shape is a superset of the legacy `ExtractedItem` (which has `priority` /
 * `department` / `layer`), renamed to match the schema column names that
 * actually land downstream:
 *   • `suggestedPriority`   ← legacy `priority`
 *   • `suggestedDepartment` ← legacy `department` (still a NAME, not an ID;
 *                              the caller resolves to `suggestedDepartmentId`
 *                              when persisting)
 *   • `suggestedLayer`      ← legacy `layer`
 *
 * Fields default to `null` rather than `undefined` so the candidate is a flat
 * shape suitable for JSON-RPC tool responses.
 */
export interface MemoryCandidate {
  type: ExtractedItemType;
  title: string;
  description: string | null;
  suggestedLayer: "identity" | "domain" | "active_context" | "working" | null;
  suggestedPriority: "urgent" | "high" | "medium" | "low" | null;
  suggestedDepartment: string | null;
}

/**
 * Translate a parsed `ExtractedItem` (legacy shape) into a `MemoryCandidate`
 * (tool-call shape). Pure function — same input always yields the same shape.
 */
function toMemoryCandidate(item: ExtractedItem): MemoryCandidate {
  return {
    // ExtractedItem.type is the six-tuple legacy enum; widen to
    // ExtractedItemType (an eight-tuple superset) by direct assignment. The
    // legacy types are a strict subset so this is type-safe.
    type: item.type as ExtractedItemType,
    title: item.title,
    description: item.description && item.description.length > 0 ? item.description : null,
    suggestedLayer: item.layer ?? null,
    suggestedPriority: item.priority ?? null,
    suggestedDepartment: item.department ?? null,
  };
}

/**
 * Run an LLM extraction over a thread's entries and return structured
 * candidates. Does NOT persist — the caller decides what to do with the
 * results (typically: queue them in `discussion_extracted_items` for founder
 * approval, or surface them inline in an Adjutant response).
 *
 * If `sinceEntryId` is provided, only entries created strictly after that
 * entry are considered (cursor-based incremental extraction). When omitted
 * the entire thread's entries are used as input.
 *
 * If `llm` is `null` (production) the function runs the keyless CLI extractor
 * (`extractViaCli`), which returns already-parsed items. If `llm` is supplied
 * (tests/evals only) it is called with the prompt + concatenated entry content
 * and the raw response is fed through `parseExtractedItems`.
 *
 * Errors are surfaced (the function rejects) so the tool wrapper can return
 * a structured `{ ok: false }` to the calling agent. An empty thread returns
 * `{ candidates: [] }` without invoking the LLM at all.
 */
export async function extractMemoryCandidates(
  db: Db,
  llm: ExtractionLlm | null,
  params: { companyId: string; threadId: string; sinceEntryId?: string },
): Promise<{ candidates: MemoryCandidate[] }> {
  const log = logger.child({
    service: "extraction.extractMemoryCandidates",
    companyId: params.companyId,
    threadId: params.threadId,
  });

  // ── 0. Per-thread privacy gate (G4 wiring-gap fix, G3 contract).
  //       Threads with allowMemoryExtraction=false MUST short-circuit at
  //       the top of the chain: we don't even fetch entries, much less
  //       burn LLM tokens. The propose_memory_from_thread tool also
  //       enforces this downstream, but extracting candidates that will
  //       immediately be rejected wastes time and budget.
  const threadRows = await db
    .select({ allowMemoryExtraction: discussions.allowMemoryExtraction })
    .from(discussions)
    .where(eq(discussions.id, params.threadId));
  const allowExtraction = threadRows[0]?.allowMemoryExtraction;
  if (allowExtraction === false) {
    log.info(
      "thread has allowMemoryExtraction=false — returning empty candidate set",
    );
    return { candidates: [] };
  }

  // ── 1. Resolve the cursor: when sinceEntryId is given, look up its
  //       createdAt so we can express "strictly after this entry" with a
  //       single index-friendly `createdAt > cursor` predicate. Falling back
  //       to the discussionId-only filter when no cursor is given.
  let cursorCreatedAt: Date | null = null;
  if (params.sinceEntryId) {
    const cursorRows = await db
      .select({ createdAt: discussionEntries.createdAt })
      .from(discussionEntries)
      .where(eq(discussionEntries.id, params.sinceEntryId));
    const cursorRow = cursorRows[0];
    if (cursorRow?.createdAt) {
      cursorCreatedAt = cursorRow.createdAt as Date;
    } else {
      // Cursor referenced an entry that does not exist — treat as "no
      // cursor" rather than an error so a stale tool argument can't break
      // an otherwise valid sweep. The agent likely picked an old/deleted
      // entry id; better to extract from the full thread than fail.
      log.info({ sinceEntryId: params.sinceEntryId }, "sinceEntryId not found — falling back to full thread");
    }
  }

  // ── 2. Fetch entries (ordered ascending so the LLM reads the thread
  //       chronologically). Cursor-aware predicate when applicable.
  const entryPredicate = cursorCreatedAt
    ? and(
        eq(discussionEntries.discussionId, params.threadId),
        gt(discussionEntries.createdAt, cursorCreatedAt),
      )
    : eq(discussionEntries.discussionId, params.threadId);

  const entries = await db
    .select({ id: discussionEntries.id, rawContent: discussionEntries.rawContent, createdAt: discussionEntries.createdAt })
    .from(discussionEntries)
    .where(entryPredicate)
    .orderBy(discussionEntries.createdAt);

  if (entries.length === 0) {
    log.info("no entries to extract from — returning empty candidate set");
    return { candidates: [] };
  }

  // Concatenate entry content using the same `---` separator the legacy
  // discussion-entry path uses for thread context. Skip empty entries
  // (defensive; should not happen in practice).
  const userContent = entries
    .map((e) => (e.rawContent ?? "").trim())
    .filter((s) => s.length > 0)
    .join("\n---\n");

  if (userContent.length < 10) {
    log.info({ length: userContent.length }, "thread content too short — returning empty candidate set");
    return { candidates: [] };
  }

  // ── 3. Build the same prompt the autonomous path uses.
  const { text: deptList } = await buildDepartmentsList(db, params.companyId);
  const systemPrompt = EXTRACTION_PROMPT_TEMPLATE.replace(
    "{{DEPARTMENTS_AND_PROJECTS_LIST}}",
    deptList,
  );

  // ── 4. Run extraction. A caller-supplied `llm` (tests/evals only) takes
  //       precedence; otherwise extraction runs through the keyless CLI.
  //       extractViaCli already returns parsed ExtractedItem[], so there is
  //       no parseExtractedItems step on the CLI branch.
  let items: ExtractedItem[];
  if (llm) {
    const raw = await llm.generate(systemPrompt, userContent);
    items = parseExtractedItems(raw);
  } else {
    const { cliTool, codexModel, credential } = await resolveCliExtractionContext(
      db,
      params.companyId,
    );
    items = await extractViaCli(cliTool, systemPrompt, userContent, {
      codexModel,
      credential,
      companyId: params.companyId,
      db,
    });
  }

  log.info({ candidateCount: items.length, entries: entries.length }, "extraction complete");
  return { candidates: items.map(toMemoryCandidate) };
}

/**
 * Extract candidates and filter to type='decision'. Thin convenience wrapper
 * around `extractMemoryCandidates` — same arguments minus `companyId`, which
 * the tool wrapper resolves from the thread.
 *
 * NOTE: these three filtered helpers (`extractDecisions`, `extractInsights`,
 * `extractReferences`) require the `companyId` to resolve via the thread.
 * The tool wrapper layer that calls these always has the thread in hand and
 * can look it up; for unit tests, callers pass it via the `companyId`
 * parameter on the underlying `extractMemoryCandidates` call.
 */
export async function extractDecisions(
  db: Db,
  llm: ExtractionLlm | null,
  params: { companyId: string; threadId: string; sinceEntryId?: string },
): Promise<MemoryCandidate[]> {
  const { candidates } = await extractMemoryCandidates(db, llm, params);
  return candidates.filter((c) => c.type === "decision");
}

/**
 * Extract candidates and filter to type='insight'. See `extractDecisions`.
 */
export async function extractInsights(
  db: Db,
  llm: ExtractionLlm | null,
  params: { companyId: string; threadId: string; sinceEntryId?: string },
): Promise<MemoryCandidate[]> {
  const { candidates } = await extractMemoryCandidates(db, llm, params);
  return candidates.filter((c) => c.type === "insight");
}

/**
 * Extract candidates and filter to type='reference'. See `extractDecisions`.
 */
export async function extractReferences(
  db: Db,
  llm: ExtractionLlm | null,
  params: { companyId: string; threadId: string; sinceEntryId?: string },
): Promise<MemoryCandidate[]> {
  const { candidates } = await extractMemoryCandidates(db, llm, params);
  return candidates.filter((c) => c.type === "reference");
}
