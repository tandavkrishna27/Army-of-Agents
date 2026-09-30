// server/src/routes/internal-agent.ts
// Internal Agent HTTP endpoints — T13a
import { Router, type Request } from "express";
import { z } from "zod";
import { and, eq, asc, desc, gte, lte, isNull, inArray, sql, type SQL } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import {
  internalAgentConfig,
  internalAgentConversations,
  internalAgentMessages,
  internalAgentRuns,
  internalAgentReminders,
} from "@armyofagents/db";
import { validate } from "../middleware/index.js";
import { assertHumanRole } from "../middleware/rbac.js";
import { internalAgentChatLimiter } from "../middleware/rate-limit.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { HttpError, badRequest, notFound, forbidden } from "../errors.js";
import { agentLoopService, type RuntimeAttachmentStorage } from "../services/internal-agent/agent-loop.js";
import { detectCliTool } from "../services/internal-agent/cli-mode.js";
import { ensureCommanderAgent } from "../services/internal-agent/aoa-agents/ensure-commander.js";
import { ensureCrewAgents, ensureInfrastructureAgents, isCrewMarketplaceManaged } from "../services/internal-agent/aoa-agents/crew-seeding.js";
import { logger } from "../middleware/logger.js";
import { companySkillService } from "../services/company-skills.js";
import {
  createToolRegistry,
  executeTool,
} from "../services/internal-agent/tool-registry.js";
import { createServiceContainer } from "../services/internal-agent/service-container.js";
import { buildOutputRefs } from "../services/internal-agent/output-refs.js";
import { conversationService } from "../services/internal-agent/conversation.js";
import { loadOwnedConversation, resolveActorRole } from "./conversation-authz.js";
import { runtimeApprovalService } from "../services/internal-agent/runtime-approvals.js";
import type { CommanderRuntimeApprovalDecision, CommanderToolPermissions, UserRole } from "@armyofagents/shared";
import { AGENT_PROVIDERS, COMMANDER_TOOL_PERMISSION_DEFAULT, chatMessageSchema } from "@armyofagents/shared";
import {
  resolveRunCostCents,
  rateModelForCliTool,
  resolveRunDurationMs,
  resolveRunCostCentsFromSummary,
  resolvePersistedProvenance,
  resolveDonePayload,
} from "../services/internal-agent/run-cost.js";
import { humanToolSummary } from "../services/internal-agent/tool-summary.js";

// ── Schemas ──────────────────────────────────────────────────────────────────

const confirmActionSchema = z
  .object({
    confirmId: z.string().uuid(),
    decision: z.enum(["allow_once", "allow_always", "deny"]).optional(),
    approved: z.boolean().optional(),
  })
  .refine((value) => value.decision !== undefined || value.approved !== undefined, {
    message: "Either decision or approved is required",
  })
  .transform((value) => ({
    confirmId: value.confirmId,
    decision:
      value.decision ??
      (value.approved === true ? "allow_once" : "deny"),
  }));

const updateConfigSchema = z.object({
  executionMode: z.enum(["api", "cli"]).optional(),
  provider: z.enum(AGENT_PROVIDERS).optional(),
  // Nullable: the onboarding wizard + Settings send `model: commanderModel.trim() || null`
  // (the Commander model field is OPTIONAL — blank → null → CLI default). Without
  // `.nullable()` a blank model 400s and onboarding stalls (found by e2e).
  model: z.string().nullable().optional(),
  crewModel: z.string().nullable().optional(),
  cliTool: z.string().nullable().optional(),
  // D18 split: TWO dials.
  //   autonomyLevel      → Commander only (not read by any agent-execution path).
  //   crewAutonomyLevel  → crew task runs + org heartbeat + Adjutant/thread flows.
  // Both accept L0-L2 — the design ceiling for the crew (task + route + execute).
  // Goals and identity/domain memory remain founder-gated even at L2 (Decisions
  // #15/#16/#52). L3 is reserved for a future "master autonomy" surface.
  // See design doc § 4 — autonomy dial.
  autonomyLevel: z.number().int().min(0).max(2).optional(),
  crewAutonomyLevel: z.number().int().min(0).max(2).optional(),
  enabledCapabilities: z.array(z.string()).optional(),
  notificationPreference: z.enum(["silent", "digest", "realtime"]).optional(),
  contextTokenBudget: z.number().int().min(2000).max(32000).optional(),
  budgetMonthlyCents: z.number().int().min(0).nullable().optional(),
  proactiveIntervalMinutes: z.number().int().min(30).max(1440).optional(),
  cheapModel: z.string().nullable().optional(),
  crewPaused: z.boolean().optional(),
  runtimeApprovalsEnabled: z.boolean().optional(),
  runtimeAllowAlwaysEnabled: z.boolean().optional(),
  vendorCliBypassEnabled: z.boolean().optional(),
  // Task 0.7 (Inbound Dirty-Data Routing): per-company routing dial.
  // Derives allowed values from INBOUND_ROUTING_LEVELS to stay in sync.
  inboundRoutingLevel: z
    .enum(["off", "suggest", "auto_attach", "full_auto"])
    .optional(),
  // Viewer Upgrade Phase 5: per-company default viewer control level.
  viewerControlLevel: z.enum(["manual", "own_output", "full"]).optional(),
});

const cancelReminderSchema = z.object({
  status: z.literal("cancelled"),
});

const toolPermissionSchema = z.object({
  enabled: z.boolean(),
  requireConfirmation: z.boolean(),
  minimumRole: z.enum(["founder", "team_lead", "team_member"]),
});

const updateToolPermissionsSchema = z.record(z.string(), toolPermissionSchema);

// ── Agent re-ensure on config change ──────────────────────────────────────────

interface AgentAdapterFields {
  provider: string | null;
  crewModel: string | null;
  cliTool: string | null;
  model: string | null;
}

/**
 * Re-seed the AoA agents after a config PATCH iff any adapter-affecting field
 * changed. Crew rows follow provider/crewModel; the Commander row follows
 * cliTool/model (Task 5b). Running every ensure on any change is safe — each
 * ensure resolves from its own inputs and shouldRewriteCrewAdapter is a no-op
 * when the adapter already matches, so a crew-only change leaves Commander
 * untouched and vice-versa.
 *
 * P8d / Phase 4B: the marketplace gate suppresses the CREW half only.
 * Commander must still be re-ensured for a marketplace-managed company —
 * `shouldRewriteCrewAdapter` returns true whenever the resolved
 * adapterType or model differs (resolve-crew-adapter.ts:259-264), so this is
 * the call that migrates Commander onto the founder's newly-picked CLI/model.
 * Skipping it wholesale stranded Commander on the old provider.
 */
export async function maybeReensureAgentsOnConfigChange(
  db: Db,
  companyId: string,
  before: AgentAdapterFields,
  after: AgentAdapterFields,
): Promise<void> {
  const changed =
    before.provider !== after.provider ||
    before.crewModel !== after.crewModel ||
    before.cliTool !== after.cliTool ||
    before.model !== after.model;
  if (!changed) return;
  await ensureInfrastructureAgents(db, companyId);
  if (await isCrewMarketplaceManaged(db, companyId)) return;
  await ensureCrewAgents(db, companyId);
}

// ── Route factory ────────────────────────────────────────────────────────────

export function internalAgentRoutes(db: Db, storageService?: RuntimeAttachmentStorage) {
  const router = Router();

  // ── 2.1 Send Message (SSE Streaming) ─────────────────────────────────
  // Sprint 4 S4-F: rate-limit chat (LLM-billed). 60 requests per minute per
  // actor. The route is the chat endpoint and the SSE-streaming variant —
  // it's a single route, so one limiter covers both.
  router.post(
    "/companies/:companyId/internal-agent/chat",
    internalAgentChatLimiter,
    validate(chatMessageSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(db, req, companyId);
      const actor = getActorInfo(req);

      // Set SSE headers (gotchas 5.2 — POST-based, not EventSource)
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      // Create a run record for observability in /runs UI. The final summary
      // backfills token/cost/tool-call metadata once the turn completes.
      const [run] = await db
        .insert(internalAgentRuns)
        .values({
          companyId,
          triggerType: "conversation",
          triggerSource: "user_message",
          status: "running",
          userId: actor.actorId,
        })
        .returning();

      const runStartedAt = Date.now();

      // Signal "thinking" to the UI while we kick off the dispatch.
      res.write(
        `event: thinking\ndata: ${JSON.stringify({ status: "processing" })}\n\n`,
      );

      let finalSummary:
        | {
            runId: string;
            toolsCalled: string[];
            durationMs: number;
            costCents: number;
            tokenUsage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
            /** F1: adapter-reported model/provider for provenance (separate from cost-label). */
            model?: string | null;
            provider?: string | null;
          }
        | null = null;
      // round-8 #3: set when chat() signals an idempotent replay / in-progress
      // defer (no CLI run) so the pre-created run row is deleted, not finalized.
      let runSkipped = false;

      try {
        const svc = agentLoopService(db, storageService);
        // Board-gated role: founder-equivalence requires a type:"board" actor.
        // MCP/agent bearer tokens are always "team_member" regardless of the
        // userId they carry (a founder-created MCP key replays the founder's
        // userId, which must NOT grant founder tool-dispatch). See resolveActorRole.
        const userRole = await resolveActorRole(db, req, companyId);

        // Look up the company's enabled capabilities. Empty array if no
        // config row exists — chat will surface "not configured" further
        // down anyway.
        const cfgRows = await db
          .select({
            enabledCapabilities: internalAgentConfig.enabledCapabilities,
            model: internalAgentConfig.model,
            cliTool: internalAgentConfig.cliTool,
          })
          .from(internalAgentConfig)
          .where(eq(internalAgentConfig.companyId, companyId));
        const enabledCapabilities = (cfgRows[0]?.enabledCapabilities as string[] | null) ?? [];
        // REVIEW FIX (Lens C): price by the ACTIVE cli tool, not the dormant
        // config.model column (which defaults to sonnet for every company).
        const effectiveCliTool = cfgRows[0]?.cliTool ?? "claude_cli";
        const { provider: runProvider, model: runModel } = rateModelForCliTool(
          effectiveCliTool,
          cfgRows[0]?.model ?? null,
        );

        const stream = svc.chat({
          companyId,
          userId: actor.actorId,
          userRole,
          enabledCapabilities,
          // Thread the pre-created run id so emitted output refs carry
          // provenance.runId (set as AOA_RUN_ID in the MCP bridge env).
          runId: run.id,
          content: req.body.message,
          pageContext: req.body.pageContext ?? undefined,
          departmentContext: req.body.departmentContext ?? req.body.contextScope?.departmentId ?? undefined,
          conversationId: req.body.conversationId ?? undefined,
          contextScope: req.body.contextScope ?? undefined,
          clientSubmissionId: req.body.clientSubmissionId ?? undefined,
          attachmentAssetIds: req.body.attachmentAssetIds ?? undefined,
        });

        for await (const chunk of stream) {
          switch (chunk.type) {
            case "text":
              res.write(
                `event: content\ndata: ${JSON.stringify({ text: chunk.delta })}\n\n`,
              );
              break;
            case "tool_call":
              res.write(
                `event: tool_call\ndata: ${JSON.stringify({ name: chunk.name })}\n\n`,
              );
              break;
            case "tool_result":
              // refs are validated/screened + MCP-gated at the parser layer; the
              // persistence boundary re-validates independently. Forward as-is.
              // REVIEW FIX (Lens A/B/C): do NOT forward input — unbounded + unused by render.
              res.write(
                `event: tool_result\ndata: ${JSON.stringify({
                  name: chunk.name,
                  success: chunk.result?.success ?? true,
                  summary: humanToolSummary(chunk.name, chunk.result?.summary ?? chunk.result?.data),
                  ...(chunk.refs && chunk.refs.length > 0 ? { refs: chunk.refs } : {}),
                })}\n\n`,
              );
              break;
            case "action_confirmation": {
              const confirmId = chunk.runId;
              const paramsSummary =
                chunk.params &&
                typeof chunk.params === "object" &&
                Object.keys(chunk.params as object).length > 0
                  ? ` with ${Object.entries(chunk.params as Record<string, unknown>)
                      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
                      .join(", ")}`
                  : "";
              res.write(
                `event: action_confirm\ndata: ${JSON.stringify({
                  confirmId,
                  action: chunk.toolName,
                  description: `${chunk.toolName}${paramsSummary}`,
                })}\n\n`,
              );
              break;
            }
            case "options_prompt":
              res.write(
                `event: options_prompt\ndata: ${JSON.stringify({
                  promptId: chunk.promptId,
                  question: chunk.question,
                  options: chunk.options,
                })}\n\n`,
              );
              break;
            case "error":
              res.write(
                `event: error\ndata: ${JSON.stringify({ code: "INTERNAL", message: chunk.message })}\n\n`,
              );
              break;
            case "reasoning":
              res.write(
                `event: reasoning\ndata: ${JSON.stringify({ text: chunk.delta })}\n\n`,
              );
              break;
            case "run_skipped":
              // Idempotent replay / in-progress defer — no CLI ran. Suppress the
              // phantom run row (round-8 #3). Not forwarded to the client.
              runSkipped = true;
              break;
            case "done":
              finalSummary = chunk.summary;
              break;
          }
        }

        if (runSkipped) {
          // Delete the pre-created run row so a network retry after a successful
          // turn (or a concurrent duplicate) doesn't leave a zero-token completed
          // / spurious failed run inflating the run list + aggregate metrics. The
          // original request's run record is the source of truth (round-8 #3).
          await db
            .delete(internalAgentRuns)
            .where(and(eq(internalAgentRuns.id, run.id), eq(internalAgentRuns.companyId, companyId)))
            .catch(() => {});
          res.write(
            `event: done\ndata: ${JSON.stringify({ messageId: run.id, runId: run.id })}\n\n`,
          );
          res.end();
          return;
        }

        // Mark run completed
        const tokenUsage = finalSummary?.tokenUsage ?? null;
        const wallClockMs = Date.now() - runStartedAt;
        const durationMs = resolveRunDurationMs(finalSummary ?? null, wallClockMs);
        const costCents = resolveRunCostCentsFromSummary(
          finalSummary ?? null,
          runProvider,
          runModel,
        );

        // F1: prefer the adapter-reported model/provider (actual runtime provenance)
        // over the cost-label defaults (which are pricing inputs, not provenance).
        // Cost PRICING still uses runModel/runProvider via resolveRunCostCentsFromSummary above.
        const { model: persistedModel, provider: persistedProvider } = resolvePersistedProvenance(
          finalSummary ?? null,
          runModel,
          runProvider,
        );

        await db
          .update(internalAgentRuns)
          .set({
            status: "completed",
            completedAt: new Date(),
            durationMs,
            costCents,
            tokenUsage,
            toolsCalled: finalSummary?.toolsCalled ?? [],
            model: persistedModel,
            provider: persistedProvider,
          })
          // F6: also scope by companyId for defense-in-depth (id is server-created
          // so this is not an active hole, but matches the repo's company-scoping rule).
          .where(and(eq(internalAgentRuns.id, run.id), eq(internalAgentRuns.companyId, companyId)));

        // F2: send the LOCALLY-COMPUTED costCents (the value persisted to DB)
        // and a guaranteed-non-null tokenUsage so the wire matches the DB row.
        const donePayload = resolveDonePayload(finalSummary ?? null, costCents);
        res.write(
          `event: done\ndata: ${JSON.stringify({
            messageId: run.id,
            runId: run.id,
            durationMs,
            tokenUsage: donePayload.tokenUsage,
            costCents: donePayload.costCents,
          })}\n\n`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : "Internal error";
        res.write(
          `event: error\ndata: ${JSON.stringify({ code: "INTERNAL", message })}\n\n`,
        );

        // Mark run failed if it hasn't been completed already
        await db
          .update(internalAgentRuns)
          .set({
            status: "failed",
            completedAt: new Date(),
            errorMessage: message,
          })
          .where(eq(internalAgentRuns.id, run.id))
          .catch(() => {});
      }

      res.end();
    },
  );

  // ── 2.2 Confirm Agent Action ─────────────────────────────────────────
  router.post(
    "/companies/:companyId/internal-agent/confirm",
    validate(confirmActionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(db, req, companyId);

      const actor = getActorInfo(req);
      const { confirmId, decision } = req.body as {
        confirmId: string;
        decision: CommanderRuntimeApprovalDecision;
      };
      const approvals = runtimeApprovalService(db);

      if (decision === "deny") {
        const denied = await approvals.deny(confirmId, companyId, actor.actorId);
        if (!denied) throw notFound(`No pending confirmation for id: ${confirmId}`);
        res.json({
          confirmId,
          result: "denied",
          summary: null,
          error: null,
          entityType: null,
          entityId: null,
        });
        return;
      }

      const claimed = await approvals.claimForExecution(
        confirmId,
        companyId,
        actor.actorId,
        decision,
      );
      if (!claimed) {
        throw notFound(`No pending confirmation for id: ${confirmId}`);
      }


      // Permissions are re-fetched fresh here — do NOT use pending.userRole or
      // pending.enabledCapabilities. Those were snapshotted at prompt time and
      // may be stale if the user's role or company capabilities changed within
      // the TTL window. Using stale values would allow execution under
      // revoked permissions (privilege-retention gap). Board-gated: MCP/agent
      // tokens are always "team_member" (see resolveActorRole).
      const currentUserRole = await resolveActorRole(db, req, companyId);

      const [cfgForConfirm] = await db
        .select({
          enabledCapabilities: internalAgentConfig.enabledCapabilities,
          commanderToolPermissions: internalAgentConfig.commanderToolPermissions,
          runtimeApprovalsEnabled: internalAgentConfig.runtimeApprovalsEnabled,
          runtimeAllowAlwaysEnabled: internalAgentConfig.runtimeAllowAlwaysEnabled,
        })
        .from(internalAgentConfig)
        .where(eq(internalAgentConfig.companyId, companyId));
      const currentCapabilities =
        (cfgForConfirm?.enabledCapabilities as string[] | null) ?? [];

      const tools = createToolRegistry();
      const tool = tools.find((t) => t.name === claimed.toolName);
      if (!tool) {
        await approvals.markFailed(confirmId, companyId, "TOOL_NOT_FOUND");
        throw notFound(`Tool not found: ${claimed.toolName}`);
      }

      const services = createServiceContainer(db);
      const toolContext = {
        companyId: claimed.companyId,
        userId: claimed.userId,
        userRole: currentUserRole,           // fresh — not pending.userRole
        enabledCapabilities: currentCapabilities, // fresh — not pending.enabledCapabilities
        agentKind: undefined,
        toolAllowlist: [] as string[],
        actorType: "commander",
        commanderToolPermissions:
          (cfgForConfirm?.commanderToolPermissions as CommanderToolPermissions | null | undefined) ?? null,
        runtimeApprovalsEnabled: cfgForConfirm?.runtimeApprovalsEnabled ?? true,
        db,
        services,
      };

      const result = await executeTool(tool, claimed.params, toolContext);
      if (result.success) {
        if (
          decision === "allow_always" &&
          (cfgForConfirm?.runtimeAllowAlwaysEnabled ?? true)
        ) {
          await approvals.createTrustRule({
            companyId,
            userId: claimed.userId,
            toolName: claimed.toolName,
            params: claimed.params as Record<string, unknown>,
            createdByUserId: actor.actorId,
          });
        }
        await approvals.markExecuted(confirmId, companyId, {
          summary: result.summary ?? "",
          entityType: null,
          entityId: null,
        });

        // Emit viewer navigational refs for this approval-gated write. The
        // non-approval (auto-run) path builds these in mcp-bridge.ts
        // executeAndFormat; the approval path executes the tool here, so it must
        // build + persist them itself or the approved result never becomes a
        // message with outputRefs (no nav chip renders). Persisting a small
        // assistant message carrying the refs lets the UI's existing
        // OutputRefChips path render on the confirm handler's refetch.
        // Best-effort: ref emission / persistence must NEVER fail the approved
        // tool call or change the HTTP response (matches mcp-bridge.ts, which
        // swallows buildOutputRefs failures).
        try {
          if (claimed.conversationId) {
            let seq = 0;
            const outputRefs = buildOutputRefs(claimed.toolName, claimed.params, result, {
              provenanceBase: {
                surface: "commander" as const,
                entityId: claimed.conversationId,
                runId: claimed.runId ?? null,
                agentId: null,
                messageId: null,
                emittedAt: new Date().toISOString(),
              },
              nextSeq: () => seq++,
            });
            if (outputRefs.length > 0) {
              await conversationService(db).appendMessage(claimed.conversationId, {
                role: "assistant",
                content: result.summary ?? "",
                outputRefs,
              });
            }
          }
        } catch (err) {
          // Ref emission / persistence is best-effort — never fail the approved
          // tool call (matches how mcp-bridge.ts logs buildOutputRefs failures).
          logger.debug(
            { err, confirmId, toolName: claimed.toolName },
            "confirm: output-ref emission failed (approved tool call unaffected)",
          );
        }
      } else {
        await approvals.markFailed(
          confirmId,
          companyId,
          result.error ?? result.summary ?? "Tool execution failed",
        );
      }

      res.json({
        confirmId,
        result: result.success ? "executed" : "failed",
        summary: result.summary ?? null,
        error: result.error ?? null,
        entityType: null,
        entityId: null,
      });
    },
  );

  // ── Tool Permissions ──────────────────────────────────────────────────
  router.get(
    "/companies/:companyId/internal-agent/tool-permissions",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(db, req, companyId);

      const [config] = await db
        .select({ commanderToolPermissions: internalAgentConfig.commanderToolPermissions })
        .from(internalAgentConfig)
        .where(eq(internalAgentConfig.companyId, companyId));

      const stored = (config?.commanderToolPermissions as Record<string, unknown> | null) ?? {};
      res.json({ permissions: stored, default: COMMANDER_TOOL_PERMISSION_DEFAULT });
    },
  );

  router.patch(
    "/companies/:companyId/internal-agent/tool-permissions",
    validate(updateToolPermissionsSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(db, req, companyId);
      await assertHumanRole(db, req, companyId, "founder");

      await db
        .update(internalAgentConfig)
        .set({ commanderToolPermissions: req.body })
        .where(eq(internalAgentConfig.companyId, companyId));

      res.json({ success: true });
    },
  );

  // ── Test Connection (QA-BUG-010) ────────────────────────────────────
  // UI button at Settings → Commander → Execution & Model calls this to
  // validate the configured CLI tool is reachable. The route resolves
  // the company's `cliTool` (defaulting to `claude_cli` when unset —
  // matches the agent-loop default in agent-loop.ts:254) and runs the
  // `detectCliTool` helper that the chat path already uses. Reply shape
  // matches what `ui/src/api/internal-agent.ts:339` expects:
  //   { success: boolean, error?: string, detectedTool?: string, path?: string }
  // No side effects — purely a PATH/availability probe.
  router.post(
    "/companies/:companyId/internal-agent/test-connection",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(db, req, companyId);

      const [config] = await db
        .select({ cliTool: internalAgentConfig.cliTool })
        .from(internalAgentConfig)
        .where(eq(internalAgentConfig.companyId, companyId));

      const effectiveTool =
        (config?.cliTool as string | null | undefined) ?? "claude_cli";

      const detection = await detectCliTool(effectiveTool);

      if (!detection.available) {
        res.json({
          success: false,
          error: detection.error,
          detectedTool: effectiveTool,
        });
        return;
      }

      res.json({
        success: true,
        detectedTool: effectiveTool,
        path: detection.path,
      });
    },
  );

  // ── Runtime Settings ───────────────────────────────────────────────
  router.get(
    "/companies/:companyId/internal-agent/runtime-settings",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(db, req, companyId);

      const [config] = await db
        .select({
          runtimeApprovalsEnabled: internalAgentConfig.runtimeApprovalsEnabled,
          runtimeAllowAlwaysEnabled: internalAgentConfig.runtimeAllowAlwaysEnabled,
        })
        .from(internalAgentConfig)
        .where(eq(internalAgentConfig.companyId, companyId));

      res.json({
        runtimeApprovalsEnabled: config?.runtimeApprovalsEnabled ?? true,
        runtimeAllowAlwaysEnabled: config?.runtimeAllowAlwaysEnabled ?? true,
      });
    },
  );

  // ── 2.3 Get Conversation ─────────────────────────────────────────────
  router.get(
    "/companies/:companyId/internal-agent/tool-trust-rules",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(db, req, companyId);
      const actor = getActorInfo(req);

      const rules = await runtimeApprovalService(db).listTrustRules(
        companyId,
        actor.actorId,
      );

      res.json({
        rules: rules.map((rule) => ({
          id: rule.id,
          toolName: rule.toolName,
          scope: rule.scope,
          paramsHashPrefix: rule.paramsHash.slice(0, 8),
          paramsHashVersion: rule.paramsHashVersion,
          lastUsedAt: rule.lastUsedAt,
          expiresAt: rule.expiresAt,
          createdAt: rule.createdAt,
        })),
      });
    },
  );

  router.delete(
    "/companies/:companyId/internal-agent/tool-trust-rules/:ruleId",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const ruleId = req.params.ruleId as string;
      await assertCompanyAccess(db, req, companyId);
      const actor = getActorInfo(req);

      const revoked = await runtimeApprovalService(db).revokeTrustRule(
        ruleId,
        companyId,
        actor.actorId,
      );
      if (!revoked) throw notFound("Trust rule not found");

      res.json({ success: true });
    },
  );

  router.get(
    "/companies/:companyId/internal-agent/conversation",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(db, req, companyId);
      const actor = getActorInfo(req);

      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
      const offset = parseInt(req.query.offset as string) || 0;

      // Find active conversation
      const conversations = await db
        .select()
        .from(internalAgentConversations)
        .where(
          and(
            eq(internalAgentConversations.companyId, companyId),
            eq(internalAgentConversations.userId, actor.actorId),
            eq(internalAgentConversations.status, "active"),
          ),
        );

      if (conversations.length === 0) {
        res.json({
          conversation: null,
          messages: [],
          summarizedContext: null,
          total: 0,
          limit,
          offset,
        });
        return;
      }

      const conversation = conversations[0];

      // Fetch messages
      const messages = await db
        .select()
        .from(internalAgentMessages)
        .where(eq(internalAgentMessages.conversationId, conversation.id))
        .orderBy(asc(internalAgentMessages.createdAt))
        .limit(limit)
        .offset(offset);

      res.json({
        conversation: {
          id: conversation.id,
          status: conversation.status,
          messageCount: conversation.messageCount,
          createdAt: conversation.createdAt,
          updatedAt: conversation.updatedAt,
        },
        messages,
        summarizedContext: conversation.summarizedContext,
        total: conversation.messageCount,
        limit,
        offset,
      });
    },
  );

  // ── 2.4 Reset Conversation ───────────────────────────────────────────
  router.delete(
    "/companies/:companyId/internal-agent/conversation",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(db, req, companyId);
      const actor = getActorInfo(req);

      // Archive current conversation
      const conversations = await db
        .select()
        .from(internalAgentConversations)
        .where(
          and(
            eq(internalAgentConversations.companyId, companyId),
            eq(internalAgentConversations.userId, actor.actorId),
            eq(internalAgentConversations.status, "active"),
          ),
        );

      let archivedConversationId: string | null = null;
      if (conversations.length > 0) {
        archivedConversationId = conversations[0].id;
        await db
          .update(internalAgentConversations)
          .set({ status: "archived", updatedAt: new Date() })
          .where(eq(internalAgentConversations.id, archivedConversationId));
      }

      // Create new conversation
      const [newConv] = await db
        .insert(internalAgentConversations)
        .values({
          companyId,
          userId: actor.actorId,
          status: "active",
        })
        .returning();

      res.json({
        archivedConversationId,
        newConversationId: newConv.id,
      });
    },
  );

  // ── 2.4b Get Greeting ──────────────────────────────────────────────
  // No role restriction — the agent panel is available to all roles (DA-22).
  // Greeting only exposes high-level summaries, not raw data.
  router.get(
    "/companies/:companyId/internal-agent/greeting",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(db, req, companyId);

      // Fetch recent proactive runs (last 24 hours) to build a greeting
      const since = new Date();
      since.setHours(since.getHours() - 24);

      const recentRuns = await db
        .select({
          triggerSource: internalAgentRuns.triggerSource,
          summary: internalAgentRuns.summary,
          createdAt: internalAgentRuns.createdAt,
        })
        .from(internalAgentRuns)
        .where(
          and(
            eq(internalAgentRuns.companyId, companyId),
            eq(internalAgentRuns.triggerType, "proactive"),
            eq(internalAgentRuns.status, "completed"),
            gte(internalAgentRuns.createdAt, since),
          ),
        )
        .orderBy(desc(internalAgentRuns.createdAt))
        .limit(20);

      // Build greeting from actionable findings, deduped by triggerSource (keep most recent)
      const actionableKeywords = ["Found", "Budget alert", "Fired"];
      const seen = new Set<string>();
      const deduped: string[] = [];
      for (const run of recentRuns) {
        if (!seen.has(run.triggerSource) && run.summary && actionableKeywords.some((kw) => run.summary!.startsWith(kw))) {
          seen.add(run.triggerSource);
          deduped.push(run.summary);
        }
      }

      let greeting: string;
      if (deduped.length === 0) {
        greeting = "Everything looks good! No issues detected in the last 24 hours.";
      } else {
        greeting = `Here's what I found since your last visit:\n${deduped.map((f) => `• ${f}`).join("\n")}`;
      }

      res.json({
        greeting,
        findingCount: deduped.length,
        lastCheckedAt: recentRuns[0]?.createdAt ?? null,
      });
    },
  );

  // ── 2.5 Get Agent Config ─────────────────────────────────────────────
  router.get(
    "/companies/:companyId/internal-agent/config",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(db, req, companyId);
      await assertHumanRole(db, req, companyId, "founder");
      await ensureCommanderAgent(db, companyId);

      const configs = await db
        .select()
        .from(internalAgentConfig)
        .where(eq(internalAgentConfig.companyId, companyId));

      if (configs.length === 0) {
        res.json(null);
        return;
      }

      res.json(configs[0]);
    },
  );

  // ── 2.6 Update Agent Config ──────────────────────────────────────────
  router.patch(
    "/companies/:companyId/internal-agent/config",
    validate(updateConfigSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(db, req, companyId);
      await assertHumanRole(db, req, companyId, "founder");

      // Validate autonomy level. Threads crew (Discussions feature) opens
      // L0-L2 — the design ceiling per § 4 (task + route + execute). Goals
      // and identity/domain memory remain founder-gated even at L2
      // (Decisions #15/#16/#52). L3 is reserved for future "master autonomy"
      // surface and remains blocked.
      if (req.body.autonomyLevel != null && (req.body.autonomyLevel < 0 || req.body.autonomyLevel > 2)) {
        throw badRequest("autonomyLevel must be 0, 1, or 2 (L3 reserved for future master autonomy surface)");
      }
      // D18: the crew/agent-work dial is independently settable and independently
      // validated. It must never be derived from `autonomyLevel` here — aliasing
      // the two would re-couple the systems the split exists to separate.
      if (req.body.crewAutonomyLevel != null && (req.body.crewAutonomyLevel < 0 || req.body.crewAutonomyLevel > 2)) {
        throw badRequest("crewAutonomyLevel must be 0, 1, or 2 (L3 reserved for future master autonomy surface)");
      }

      // Read the adapter-affecting fields BEFORE the update so we can detect a change.
      const [prior] = await db
        .select({
          provider: internalAgentConfig.provider,
          crewModel: internalAgentConfig.crewModel,
          cliTool: internalAgentConfig.cliTool,
          model: internalAgentConfig.model,
        })
        .from(internalAgentConfig)
        .where(eq(internalAgentConfig.companyId, companyId))
        .limit(1);

      const [updated] = await db
        .update(internalAgentConfig)
        .set({ ...req.body, updatedAt: new Date() })
        .where(eq(internalAgentConfig.companyId, companyId))
        .returning();

      if (!updated) {
        throw notFound("Internal agent config not found");
      }

      // Migrate existing agent rows to the newly-resolved adapter when an
      // adapter-affecting field changed (crew: provider/crewModel; Commander:
      // cliTool/model). No-op otherwise. Best-effort: a re-seed failure must not
      // fail the settings save.
      try {
        await maybeReensureAgentsOnConfigChange(
          db,
          companyId,
          { provider: prior?.provider ?? null, crewModel: prior?.crewModel ?? null, cliTool: prior?.cliTool ?? null, model: prior?.model ?? null },
          { provider: updated.provider ?? null, crewModel: updated.crewModel ?? null, cliTool: updated.cliTool ?? null, model: updated.model ?? null },
        );
      } catch (err) {
        logger.warn({ err, companyId }, "agent re-ensure after config PATCH failed");
      }

      res.json(updated);
    },
  );

  // ── 2.7 Get Agent Runs ───────────────────────────────────────────────
  router.get(
    "/companies/:companyId/internal-agent/runs",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(db, req, companyId);
      await assertHumanRole(db, req, companyId, "founder");

      const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
      const offset = parseInt(req.query.offset as string) || 0;

      const conditions: SQL[] = [
        eq(internalAgentRuns.companyId, companyId),
      ];

      if (req.query.triggerType) {
        conditions.push(
          eq(internalAgentRuns.triggerType, req.query.triggerType as string),
        );
      }
      if (req.query.triggerSource) {
        conditions.push(
          eq(internalAgentRuns.triggerSource, req.query.triggerSource as string),
        );
      }
      if (req.query.status) {
        conditions.push(
          eq(internalAgentRuns.status, req.query.status as string),
        );
      }
      if (req.query.from) {
        conditions.push(
          gte(internalAgentRuns.createdAt, new Date(req.query.from as string)),
        );
      }
      if (req.query.to) {
        conditions.push(
          lte(internalAgentRuns.createdAt, new Date(req.query.to as string)),
        );
      }

      // Count + aggregates query (same conditions, no pagination)
      const [aggregateRow] = await db
        .select({
          totalRuns: sql<number>`count(*)::int`,
          totalCostCents: sql<number>`coalesce(sum(${internalAgentRuns.costCents}), 0)::int`,
          avgDurationMs: sql<number>`coalesce(avg(${internalAgentRuns.durationMs}), 0)::int`,
          failedCount: sql<number>`count(*) filter (where ${internalAgentRuns.status} = 'failed')::int`,
        })
        .from(internalAgentRuns)
        .where(and(...conditions));

      const totalRuns = aggregateRow?.totalRuns ?? 0;
      const failureRate = totalRuns > 0 ? (aggregateRow?.failedCount ?? 0) / totalRuns : 0;

      // Paginated results
      const runs = await db
        .select()
        .from(internalAgentRuns)
        .where(and(...conditions))
        .orderBy(desc(internalAgentRuns.createdAt))
        .limit(limit)
        .offset(offset);

      res.json({
        runs,
        total: totalRuns,
        limit,
        offset,
        aggregates: {
          totalCostCents: aggregateRow?.totalCostCents ?? 0,
          totalRuns,
          avgDurationMs: aggregateRow?.avgDurationMs ?? 0,
          failureRate: Math.round(failureRate * 100) / 100,
        },
      });
    },
  );

  // ── 2.8 Get Reminders ────────────────────────────────────────────────
  router.get(
    "/companies/:companyId/internal-agent/reminders",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(db, req, companyId);
      const actor = getActorInfo(req);

      const statusFilter = (req.query.status as string) || "pending";

      const conditions: SQL[] = [
        eq(internalAgentReminders.companyId, companyId),
        eq(internalAgentReminders.userId, actor.actorId),
      ];

      if (statusFilter !== "all") {
        conditions.push(
          eq(internalAgentReminders.status, statusFilter),
        );
      }

      const reminders = await db
        .select()
        .from(internalAgentReminders)
        .where(and(...conditions));

      res.json({ reminders });
    },
  );

  // ── 2.9 Cancel Reminder ──────────────────────────────────────────────
  router.patch(
    "/companies/:companyId/internal-agent/reminders/:reminderId",
    validate(cancelReminderSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const reminderId = req.params.reminderId as string;
      await assertCompanyAccess(db, req, companyId);
      const actor = getActorInfo(req);

      const [updated] = await db
        .update(internalAgentReminders)
        .set({ status: "cancelled" })
        .where(
          and(
            eq(internalAgentReminders.id, reminderId),
            eq(internalAgentReminders.companyId, companyId),
            eq(internalAgentReminders.userId, actor.actorId),
          ),
        )
        .returning();

      if (!updated) {
        throw notFound("Reminder not found");
      }

      res.json(updated);
    },
  );

  // ── Conversations: list ──────────────────────────────────────────────
  router.get(
    "/companies/:companyId/internal-agent/conversations",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(db, req, companyId);
      const actor = getActorInfo(req);

      // Board-gated: MCP/agent tokens are always "team_member" and see only
      // their own conversations (userId scoped). Board founders see all.
      // See resolveActorRole for the single-sourced rule.
      const isFounder = (await resolveActorRole(db, req, companyId)) === "founder";

      // Build conditions array — Drizzle's and() does not accept undefined.
      const conditions: SQL[] = [
        eq(internalAgentConversations.companyId, companyId),
        isNull(internalAgentConversations.archivedAt),
      ];
      if (!isFounder) {
        conditions.push(eq(internalAgentConversations.userId, actor.actorId));
      }

      const rows = await db
        .select()
        .from(internalAgentConversations)
        .where(and(...conditions))
        .orderBy(desc(internalAgentConversations.updatedAt));

      res.json({ conversations: rows });
    },
  );

  // ── Conversations: create new ────────────────────────────────────────
  router.post(
    "/companies/:companyId/internal-agent/conversations",
    validate(z.object({ title: z.string().max(200).optional() })),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(db, req, companyId);
      const actor = getActorInfo(req);

      const [conv] = await db
        .insert(internalAgentConversations)
        .values({
          companyId,
          userId: actor.actorId,
          // "pending" until conversation switching is wired (full multi-chat support).
          // "active" is reserved for the conversation the agentLoop is currently using;
          // creating a second "active" row would make chat routing non-deterministic.
          status: "pending",
          title: req.body.title ?? null,
        })
        .returning();

      res.status(201).json(conv);
    },
  );

  // ── Conversations: reorder (manual drag order) ───────────────────────
  // Registered BEFORE the `/:convId` routes so "reorder"/"order" are not
  // captured as a conversation id. Writes are always scoped to the actor's
  // OWN conversations (even for founders) — manual order is a personal
  // preference and must never clobber another user's arrangement.
  router.patch(
    "/companies/:companyId/internal-agent/conversations/reorder",
    validate(z.object({ orderedIds: z.array(z.string().uuid()).max(1000) })),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(db, req, companyId);
      const actor = getActorInfo(req);

      const scope: SQL[] = [
        eq(internalAgentConversations.companyId, companyId),
        eq(internalAgentConversations.userId, actor.actorId),
      ];

      const { orderedIds } = req.body as { orderedIds: string[] };

      // Only (re)order ids the actor owns and that are still active.
      const owned = await db
        .select({ id: internalAgentConversations.id })
        .from(internalAgentConversations)
        .where(and(...scope, isNull(internalAgentConversations.archivedAt)));
      const ownedSet = new Set(owned.map((r) => r.id));
      const finalIds = orderedIds.filter((id) => ownedSet.has(id));

      await db.transaction(async (tx) => {
        for (let i = 0; i < finalIds.length; i++) {
          await tx
            .update(internalAgentConversations)
            .set({ sortOrder: i })
            .where(and(eq(internalAgentConversations.id, finalIds[i]!), ...scope));
        }

        // Null out sortOrder for any owned active conversations NOT in this reorder.
        // Makes every reorder an atomic "replace full order" — omitted conversations
        // revert to recency order (sortOrder: null) instead of keeping stale indices.
        const finalSet = new Set(finalIds);
        const omittedIds = [...ownedSet].filter((id) => !finalSet.has(id));
        if (omittedIds.length > 0) {
          await tx
            .update(internalAgentConversations)
            .set({ sortOrder: null })
            .where(and(inArray(internalAgentConversations.id, omittedIds), ...scope));
        }
      });

      res.json({ ok: true });
    },
  );

  // ── Conversations: reset manual order ────────────────────────────────
  router.delete(
    "/companies/:companyId/internal-agent/conversations/order",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(db, req, companyId);
      const actor = getActorInfo(req);

      await db
        .update(internalAgentConversations)
        .set({ sortOrder: null })
        .where(
          and(
            eq(internalAgentConversations.companyId, companyId),
            eq(internalAgentConversations.userId, actor.actorId),
          ),
        );

      res.json({ ok: true });
    },
  );

  // ── Conversations: archive ───────────────────────────────────────────
  router.patch(
    "/companies/:companyId/internal-agent/conversations/:convId/archive",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const convId = req.params.convId as string;
      await assertCompanyAccess(db, req, companyId);

      await loadOwnedConversation(db, req, companyId, convId);

      const [updated] = await db
        .update(internalAgentConversations)
        .set({ archivedAt: new Date(), status: "archived" })
        .where(eq(internalAgentConversations.id, convId))
        .returning();

      res.json(updated);
    },
  );

  // ── Conversations: pin ───────────────────────────────────────────────
  router.patch(
    "/companies/:companyId/internal-agent/conversations/:convId/pin",
    validate(z.object({ pinned: z.boolean() })),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const convId = req.params.convId as string;
      await assertCompanyAccess(db, req, companyId);

      await loadOwnedConversation(db, req, companyId, convId);

      const [updated] = await db
        .update(internalAgentConversations)
        .set({ pinned: req.body.pinned })
        .where(eq(internalAgentConversations.id, convId))
        .returning();

      res.json(updated);
    },
  );

  // ── Conversations: rename ────────────────────────────────────────────
  router.patch(
    "/companies/:companyId/internal-agent/conversations/:convId/rename",
    validate(z.object({ title: z.string().min(1).max(200) })),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const convId = req.params.convId as string;
      await assertCompanyAccess(db, req, companyId);

      await loadOwnedConversation(db, req, companyId, convId);

      const [updated] = await db
        .update(internalAgentConversations)
        .set({ title: req.body.title })
        .where(eq(internalAgentConversations.id, convId))
        .returning();

      res.json(updated);
    },
  );

  // ── Conversations: delete (hard) ────────────────────────────────────
  // Permanently deletes a conversation and its messages (cascade). Distinct
  // from the legacy DELETE /conversation endpoint which archives+resets.
  router.delete(
    "/companies/:companyId/internal-agent/conversations/:convId",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const convId = req.params.convId as string;
      await assertCompanyAccess(db, req, companyId);

      await loadOwnedConversation(db, req, companyId, convId);

      await db
        .delete(internalAgentConversations)
        .where(eq(internalAgentConversations.id, convId));

      res.json({ ok: true });
    },
  );

  // ── Get Messages for a Specific Conversation ─────────────────────────
  router.get(
    "/companies/:companyId/internal-agent/conversations/:convId/messages",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const convId = req.params.convId as string;
      await assertCompanyAccess(db, req, companyId);

      // loadOwnedConversation applies the same founder bypass used by
      // archive/pin/rename/delete: founders can access any company conversation,
      // non-founders are scoped to their own userId. Throws 404 (not 403) on
      // mismatch to avoid leaking conversation existence.
      const conv = await loadOwnedConversation(db, req, companyId, convId);

      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
      const offset = parseInt(req.query.offset as string) || 0;

      const messages = await db
        .select()
        .from(internalAgentMessages)
        .where(eq(internalAgentMessages.conversationId, conv.id))
        .orderBy(asc(internalAgentMessages.createdAt))
        .limit(limit)
        .offset(offset);

      res.json({ messages, conversationId: convId });
    },
  );

  // ── Commander skills: the agent's curated selection (for the chat skill picker) ──
  router.get(
    "/companies/:companyId/internal-agent/skills",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(db, req, companyId);
      const agentId = await ensureCommanderAgent(db, companyId);
      const skills = await companySkillService(db).listSkillListItemsForAgent(
        companyId,
        agentId,
      );
      res.json(skills);
    },
  );

  return router;
}
