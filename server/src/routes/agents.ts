import { Router, type Request } from "express";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Db } from "@armyofagents/db";
import { agents as agentsTable, aoaAgentTriggers, companies, internalAgentRuns } from "@armyofagents/db";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  createAgentKeySchema,
  createAgentHireSchema,
  createAgentSchema,
  deriveAgentUrlKey,
  isUuidLike,
  resetAgentSessionSchema,
  testAdapterEnvironmentSchema,
  updateAgentPermissionsSchema,
  updateAgentInstructionsPathSchema,
  updateAgentInstructionsBundleSchema,
  upsertAgentInstructionsFileSchema,
  wakeAgentSchema,
  updateAgentSchema,
  adapterModelFamilyMismatch,
  isShellSafeModelId,
  type AdapterEnvironmentTestResult,
  type InstanceSchedulerHeartbeatAgent,
  type WakeAgent,
} from "@armyofagents/shared";
import { validate } from "../middleware/validate.js";
import {
  agentService,
  agentInstructionsService,
  accessService,
  approvalService,
  companySkillService,
  heartbeatService,
  issueApprovalService,
  issueService,
  logActivity,
  secretService,
} from "../services/index.js";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import {
  accessibleCompanyIdsForActor,
  assertBoard,
  assertCanManageInstanceSettings,
  assertCompanyAccess,
  getActorInfo,
} from "./authz.js";
import { assertHumanRole, assertRole } from "../middleware/rbac.js";
import { findActiveServerAdapter, findServerAdapter, listAdapterModels } from "../adapters/index.js";
import { redactEventPayload, redactSecretsInString } from "../redaction.js";
import { runClaudeLogin } from "@armyofagents/adapter-claude-local/server";
import {
  DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX,
} from "@armyofagents/adapter-codex-local";
import { DEFAULT_CODEX_CHAT_MODEL } from "../services/internal-agent/codex-model.js";
import { DEFAULT_CURSOR_LOCAL_MODEL } from "@armyofagents/adapter-cursor-local";
import { ensureOpenCodeModelConfiguredAndAvailable } from "@armyofagents/adapter-opencode-local/server";
import {
  loadDefaultAgentInstructionsBundle,
  resolveDefaultAgentInstructionsBundleRole,
} from "../services/default-agent-instructions.js";
import { environmentRunOrchestrator } from "../services/environment-run-orchestrator.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { assertUnsandboxedMultitenantAllowed } from "../services/unsandboxed-multitenant-guard.js";
import { tenantIsolationEnforced } from "../config/deployment-mode.js";
import {
  cliToolForSandboxReadinessProbe,
  probeReadinessInSandbox,
} from "../services/sandbox-readiness-probe.js";
import { mapCloudProviderKeyError } from "../services/internal-agent/require-cloud-provider-key.js";
import { buildApprovalHubEmit, emitHubItem } from "../services/hub-source-producers.js";
import { logger } from "../middleware/logger.js";
import { liveRunsForCompany, liveRunsForIssue } from "./agents-live-runs.js";
import { protectedAgentRefusal, protectedAgentRole } from "../services/protected-agents.js";
import { getProviderStatus } from "../adapters/provider-status.js";
import { realProviderStatusDeps } from "../adapters/provider-status-deps.js";
import { resolveModel, ShellUnsafeModelError } from "../services/internal-agent/model-resolution.js";
import {
  ADAPTER_PROBE_BUSY_ERROR,
  ADAPTER_PROBE_RETRY_AFTER_SECONDS,
  tryAcquireAdapterProbeSlot,
} from "../services/adapter-probe-concurrency.js";

// Adapter types that go through the assertAdapterConfigConstraints validation
// path (provider-status + model-resolution checks). Allocated once at module
// scope rather than per-request inside the PATCH handler.
const ADAPTER_CONSTRAINT_TYPES = new Set([
  "opencode_local",
  "codex_local",
  "claude_local",
  "gemini_local",
]);

// Adapter types that pass adapterConfig.model through to a CLI as `--model`
// (each has `--model` in its execute.ts). A model-only PATCH on any of these
// must be shell-safety validated even when the type is OUTSIDE
// ADAPTER_CONSTRAINT_TYPES (cursor/grok/pi) — without an adapterType in the body
// the schema's refine early-returns, so the route is the only gate (Codex P2).
const MODEL_AWARE_ADAPTER_TYPES = new Set([
  "claude_local",
  "codex_local",
  "cursor",
  "gemini_local",
  "grok_local",
  "opencode_local",
  "pi_local",
]);

// Unit D: per-company concurrency cap for the adapter test-connection probe.
// The probe spawns a real CLI; cap concurrent probes per company to prevent abuse.
// (Hard timeout ceiling is already enforced per-adapter: e.g. codex test.ts uses
// timeoutSec 45 + graceSec 5 — see packages/adapters/*/server/test.ts.)
// NOTE: in-process only — a multi-instance deployment would need a distributed
// lock to share this counter. Acceptable for the Phase 1 single-process target.
export function agentRoutes(db: Db) {
  const DEFAULT_INSTRUCTIONS_PATH_KEYS: Record<string, string> = {
    claude_local: "instructionsFilePath",
    codex_local: "instructionsFilePath",
    opencode_local: "instructionsFilePath",
    cursor: "instructionsFilePath",
  };
  const DEFAULT_MANAGED_INSTRUCTIONS_ADAPTER_TYPES = new Set(Object.keys(DEFAULT_INSTRUCTIONS_PATH_KEYS));
  const KNOWN_INSTRUCTIONS_PATH_KEYS = new Set(["instructionsFilePath", "agentsMdPath"]);

  /**
   * D22 (Decision #114) — adapterConfig keys whose change means "the founder
   * altered what this agent's instructions are".
   *
   * **Derived from what a catalog update actually annihilates**, not from what
   * merely sounds instruction-shaped. `applyCrewAgentUpdate` calls
   * `materializeManagedBundle(..., { clearLegacyPromptTemplate: true })`, and
   * `applyBundleConfig` (`agent-instructions.ts`) then:
   * - OVERWRITES `instructionsBundleMode` / `instructionsRootPath` /
   *   `instructionsEntryFile` / `instructionsFilePath`, and
   * - **DELETES** `promptTemplate` and `bootstrapPromptTemplate`.
   *
   * `agent-instructions-service.test.ts` pins that destruction set; if it
   * changes, this list changes with it.
   *
   * `promptTemplate` and `bootstrapPromptTemplate` are the dangerous pair: both
   * are founder-editable in the shipped Config tab, both are read at runtime
   * (`readLegacyInstructions`; acpx-local/cursor-cloud render the bootstrap
   * one), and deletion leaves no revision row to recover from — for the same
   * reason no `instructions_customized` backfill was possible.
   *
   * `agentsMdPath` is included even though materialize does not destroy it: the
   * route already treats it as an instruction change for authz
   * (`KNOWN_INSTRUCTIONS_PATH_KEYS`), and a founder setting it is saying "read
   * instructions from here". Over-stamping costs a notification.
   *
   * **Deliberately EXCLUDED:**
   * - `cwd` — it resolves a *relative* `instructionsFilePath`, so it can change
   *   which file is read; but it is overwhelmingly a workspace setting, and
   *   stamping every `cwd` edit would freeze agents out of catalog updates for
   *   a change that is not an instruction edit. Materialize writes an absolute
   *   path anyway, so the relative-resolution hazard does not survive an update.
   * - `instructions` — appears in `resolve-crew-adapter.ts`'s neutral-key list,
   *   but no adapter and no bundle code reads it. Verified by grep across every
   *   adapter package's `src` tree and `server/src`.
   */
  const INSTRUCTION_BEARING_ADAPTER_CONFIG_KEYS = new Set([
    "promptTemplate",
    "bootstrapPromptTemplate",
    "instructionsFilePath",
    "agentsMdPath",
    "instructionsRootPath",
    "instructionsEntryFile",
    "instructionsBundleMode",
  ]);

  /**
   * Stamp `instructions_customized` BEFORE founder content reaches disk.
   *
   * The bundle routes below learn the adapterConfig to persist *from* the disk
   * operation, so the main write cannot be moved ahead of it. This is a second,
   * cheap write that runs first, closing the window in which an edited bundle
   * exists on disk while the row still reads `false` — a window the updater
   * would resolve by full-replacing the edit. Failing the subsequent write
   * costs one spurious "update available" notification; the reverse costs the
   * founder's work.
   *
   * @returns false when the row vanished between `getById` and here (→ 404).
   */
  async function stampInstructionsCustomized(agentId: string): Promise<boolean> {
    return Boolean(await svc.update(agentId, { instructionsCustomized: true }));
  }

  function adapterSupportsInstructionsBundle(adapterType: string): boolean {
    const adapter = findActiveServerAdapter(adapterType);
    if (adapter?.supportsInstructionsBundle !== undefined) return adapter.supportsInstructionsBundle;
    return DEFAULT_MANAGED_INSTRUCTIONS_ADAPTER_TYPES.has(adapterType);
  }

  const router = Router();
  const svc = agentService(db);
  const access = accessService(db);
  const approvalsSvc = approvalService(db);
  const heartbeat = heartbeatService(db);
  const issueApprovalsSvc = issueApprovalService(db);
  const secretsSvc = secretService(db);
  const skillSvc = companySkillService(db);
  const instructions = agentInstructionsService();
  const environmentRuntime = environmentRuntimeService(db);
  const environmentRuns = environmentRunOrchestrator(db, {
    environmentRuntime,
  });
  const strictSecretsMode = process.env.AOA_SECRETS_STRICT_MODE === "true";

  function canCreateAgents(agent: { role: string; permissions: Record<string, unknown> | null | undefined }) {
    if (!agent.permissions || typeof agent.permissions !== "object") return false;
    return Boolean((agent.permissions as Record<string, unknown>).canCreateAgents);
  }

  async function assertCanCreateAgentsForCompany(req: Request, companyId: string) {
    await assertCompanyAccess(db, req, companyId);
    if (req.actor.type === "board") {
      if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return null;
      const allowed = await access.canUser(companyId, req.actor.userId, "agents:create");
      if (!allowed) {
        throw forbidden("Missing permission: agents:create");
      }
      return null;
    }
    if (!req.actor.agentId) throw forbidden("Agent authentication required");
    const actorAgent = await svc.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) {
      throw forbidden("Agent key cannot access another company");
    }
    const allowedByGrant = await access.hasPermission(companyId, "agent", actorAgent.id, "agents:create");
    if (!allowedByGrant && !canCreateAgents(actorAgent)) {
      throw forbidden("Missing permission: can create agents");
    }
    return actorAgent;
  }

  async function assertCanReadConfigurations(req: Request, companyId: string) {
    return assertCanCreateAgentsForCompany(req, companyId);
  }

  async function actorCanReadConfigurationsForCompany(req: Request, companyId: string) {
    await assertCompanyAccess(db, req, companyId);
    if (req.actor.type === "board") {
      if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return true;
      return access.canUser(companyId, req.actor.userId, "agents:create");
    }
    if (!req.actor.agentId) return false;
    const actorAgent = await svc.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) return false;
    const allowedByGrant = await access.hasPermission(companyId, "agent", actorAgent.id, "agents:create");
    return allowedByGrant || canCreateAgents(actorAgent);
  }

  async function assertCanUpdateAgent(
    req: Request,
    targetAgent: { id: string; companyId: string; kind?: string | null },
  ) {
    await assertCompanyAccess(db, req, targetAgent.companyId);
    // Spec §10 governance: only founders may edit AoA agents (Commander +
    // sub-agents). assertRole is a NO-OP for agent actors (rbac.ts), so an
    // agent actor MUST be rejected explicitly here — calling assertRole alone
    // would let a cxo/creator agent escalate by rewriting an AoA agent's
    // runtimeConfig.aoa.toolAllowlist (the D2 least-privilege boundary),
    // adapterType/adapterConfig, or status. kind!=='aoa' path is unchanged.
    if (targetAgent.kind === "aoa") {
      if (req.actor.type !== "board") {
        throw forbidden("Only a founder may modify AoA agents");
      }
      await assertRole(db, req, targetAgent.companyId, "founder");
      return;
    }
    if (req.actor.type === "board") {
      await assertRole(db, req, targetAgent.companyId, "founder");
      return;
    }
    if (!req.actor.agentId) throw forbidden("Agent authentication required");

    const actorAgent = await svc.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== targetAgent.companyId) {
      throw forbidden("Agent key cannot access another company");
    }

    if (actorAgent.id === targetAgent.id) return;
    // CXO-tier agents (apex Chief of Staff or any executive) can manage
    // any agent in their company.
    if (actorAgent.role === "cxo") return;
    const allowedByGrant = await access.hasPermission(
      targetAgent.companyId,
      "agent",
      actorAgent.id,
      "agents:create",
    );
    if (allowedByGrant || canCreateAgents(actorAgent)) return;
    throw forbidden("Only CXO or agent creators can modify other agents");
  }

  async function resolveCompanyIdForAgentReference(req: Request): Promise<string | null> {
    const companyIdQuery = req.query.companyId;
    const requestedCompanyId =
      typeof companyIdQuery === "string" && companyIdQuery.trim().length > 0
        ? companyIdQuery.trim()
        : null;
    if (requestedCompanyId) {
      await assertCompanyAccess(db, req, requestedCompanyId);
      return requestedCompanyId;
    }
    if (req.actor.type === "agent" && req.actor.companyId) {
      return req.actor.companyId;
    }
    return null;
  }

  async function normalizeAgentReference(req: Request, rawId: string): Promise<string> {
    const raw = rawId.trim();
    if (isUuidLike(raw)) return raw;

    const companyId = await resolveCompanyIdForAgentReference(req);
    if (!companyId) {
      throw unprocessable("Agent shortname lookup requires companyId query parameter");
    }

    const resolved = await svc.resolveByReference(companyId, raw);
    if (resolved.ambiguous) {
      throw conflict("Agent shortname is ambiguous in this company. Use the agent ID.");
    }
    if (!resolved.agent) {
      throw notFound("Agent not found");
    }
    return resolved.agent.id;
  }

  function parseSourceIssueIds(input: {
    sourceIssueId?: string | null;
    sourceIssueIds?: string[];
  }): string[] {
    const values: string[] = [];
    if (Array.isArray(input.sourceIssueIds)) values.push(...input.sourceIssueIds);
    if (typeof input.sourceIssueId === "string" && input.sourceIssueId.length > 0) {
      values.push(input.sourceIssueId);
    }
    return Array.from(new Set(values));
  }

  function asRecord(value: unknown): Record<string, unknown> | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  }

  function asNonEmptyString(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  function parseBooleanLike(value: unknown): boolean | null {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const trimmed = value.trim().toLowerCase();
      if (trimmed === "true" || trimmed === "1") return true;
      if (trimmed === "false" || trimmed === "0") return false;
    }
    if (typeof value === "number") {
      if (value === 1) return true;
      if (value === 0) return false;
    }
    return null;
  }

  function parseNumberLike(value: unknown): number | null {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "string") {
      const parsed = Number(value.trim());
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  function parseSchedulerHeartbeatPolicy(runtimeConfig: unknown) {
    const heartbeat = asRecord(asRecord(runtimeConfig)?.heartbeat) ?? {};
    return {
      enabled: parseBooleanLike(heartbeat.enabled) ?? false,
      intervalSec: Math.max(0, parseNumberLike(heartbeat.intervalSec) ?? 0),
    };
  }

  function applyCreateDefaultsByAdapterType(
    adapterType: string | null | undefined,
    adapterConfig: Record<string, unknown>,
  ): Record<string, unknown> {
    const next = { ...adapterConfig };
    if (adapterType === "codex_local") {
      if (!asNonEmptyString(next.model)) {
        next.model = DEFAULT_CODEX_CHAT_MODEL;
      }
      const hasBypassFlag =
        typeof next.dangerouslyBypassApprovalsAndSandbox === "boolean" ||
        typeof next.dangerouslyBypassSandbox === "boolean";
      if (!hasBypassFlag) {
        next.dangerouslyBypassApprovalsAndSandbox = DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX;
      }
      return next;
    }
    // OpenCode requires explicit model selection — no default
    if (adapterType === "cursor" && !asNonEmptyString(next.model)) {
      next.model = DEFAULT_CURSOR_LOCAL_MODEL;
    }
    return next;
  }

  async function assertAdapterConfigConstraints(
    companyId: string,
    adapterType: string | null | undefined,
    adapterConfig: Record<string, unknown>,
  ): Promise<string[]> {
    const warnings: string[] = [];

    if (adapterType === "opencode_local") {
      const runtimeConfig = await secretsSvc.resolveAdapterConfigForRuntime(companyId, adapterType, adapterConfig, {
        consumerType: "system",
        consumerId: `adapter-check:${adapterType ?? "unknown"}`,
        actorType: "system",
      });
      const runtimeEnv = asRecord(runtimeConfig.env) ?? {};
      try {
        await ensureOpenCodeModelConfiguredAndAvailable({
          model: runtimeConfig.model,
          command: runtimeConfig.command,
          cwd: runtimeConfig.cwd,
          env: runtimeEnv,
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw unprocessable(`Invalid opencode_local adapterConfig: ${reason}`);
      }
      return warnings; // opencode has no soft-warn tier
    }

    // Auth-mode soft-warn (Unit C): if the configured model would be runtime-
    // corrected for the detected provider auth mode, surface a non-blocking
    // warning. Best-effort — detection/resolution failures must NOT block a save.
    if (adapterType === "codex_local" || adapterType === "claude_local" || adapterType === "gemini_local") {
      const model = adapterConfig.model;
      if (typeof model === "string" && model.length > 0) {
        try {
          const status = await getProviderStatus(adapterType, { companyId, adapterConfig }, realProviderStatusDeps);
          const resolved = resolveModel(adapterType, model, status);
          if (resolved.note) warnings.push(resolved.note);
        } catch (warnErr) {
          // Shell-safety is a mandatory hard-block (defense-in-depth behind the
          // shared schema's 400). Never let a shell-unsafe model slip through the
          // soft-warn path as a silent success.
          if (warnErr instanceof ShellUnsafeModelError) {
            throw unprocessable(`Unsafe model identifier: ${String(adapterConfig.model)}`);
          }
          logger.warn({ err: warnErr }, "agents: auth-mismatch soft-warn check failed (best-effort, ignored)");
        }
      }
    }

    return warnings;
  }

  function resolveInstructionsFilePath(candidatePath: string, adapterConfig: Record<string, unknown>) {
    const trimmed = candidatePath.trim();
    if (path.isAbsolute(trimmed)) return trimmed;

    const cwd = asNonEmptyString(adapterConfig.cwd);
    if (!cwd) {
      throw unprocessable(
        "Relative instructions path requires adapterConfig.cwd to be set to an absolute path",
      );
    }
    if (!path.isAbsolute(cwd)) {
      throw unprocessable("adapterConfig.cwd must be an absolute path to resolve relative instructions path");
    }
    return path.resolve(cwd, trimmed);
  }

  async function assertCanManageInstructionsPath(
    req: Request,
    targetAgent: { id: string; companyId: string; kind?: string | null },
  ) {
    await assertCompanyAccess(db, req, targetAgent.companyId);
    // Spec §10 governance: only founders may edit AoA agents (Commander +
    // sub-agents). This is the single chokepoint for instructions path/bundle/
    // file mutations, so the kind='aoa' gate lives here (mirrors the FX2
    // assertCanUpdateAgent pattern). assertRole is a NO-OP for agent actors
    // (rbac.ts), so an agent actor — and the unauthenticated board fall-through
    // below — MUST be rejected explicitly here: without this, an ancestor
    // manager agent or any non-founder board user could rewrite an AoA agent's
    // instructions bundle. kind!=='aoa' path is byte-unchanged.
    if (targetAgent.kind === "aoa") {
      if (req.actor.type !== "board") {
        throw forbidden("Only a founder may modify AoA agents");
      }
      await assertRole(db, req, targetAgent.companyId, "founder");
      return;
    }
    if (req.actor.type === "board") return;
    if (!req.actor.agentId) throw forbidden("Agent authentication required");

    const actorAgent = await svc.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== targetAgent.companyId) {
      throw forbidden("Agent key cannot access another company");
    }
    if (actorAgent.id === targetAgent.id) return;

    const chainOfCommand = await svc.getChainOfCommand(targetAgent.id, targetAgent.companyId);
    if (chainOfCommand.some((manager) => manager.id === actorAgent.id)) return;

    throw forbidden("Only the target agent or an ancestor manager can update instructions path");
  }

  function summarizeAgentUpdateDetails(patch: Record<string, unknown>) {
    const changedTopLevelKeys = Object.keys(patch).sort();
    const details: Record<string, unknown> = { changedTopLevelKeys };

    const adapterConfigPatch = asRecord(patch.adapterConfig);
    if (adapterConfigPatch) {
      details.changedAdapterConfigKeys = Object.keys(adapterConfigPatch).sort();
    }

    const runtimeConfigPatch = asRecord(patch.runtimeConfig);
    if (runtimeConfigPatch) {
      details.changedRuntimeConfigKeys = Object.keys(runtimeConfigPatch).sort();
    }

    return details;
  }

  function redactForRestrictedAgentView(agent: Awaited<ReturnType<typeof svc.getById>>) {
    if (!agent) return null;
    return {
      ...agent,
      adapterConfig: {},
      runtimeConfig: {},
    };
  }

  function redactAgentConfiguration(agent: Awaited<ReturnType<typeof svc.getById>>) {
    if (!agent) return null;
    return {
      id: agent.id,
      companyId: agent.companyId,
      name: agent.name,
      role: agent.role,
      title: agent.title,
      status: agent.status,
      reportsTo: agent.reportsTo,
      parentType: agent.parentType ?? null,
      parentId: agent.parentId ?? null,
      adapterType: agent.adapterType,
      adapterConfig: redactEventPayload(agent.adapterConfig),
      runtimeConfig: redactEventPayload(agent.runtimeConfig),
      permissions: agent.permissions,
      updatedAt: agent.updatedAt,
    };
  }

  function redactRevisionSnapshot(snapshot: unknown): Record<string, unknown> {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return {};
    const record = snapshot as Record<string, unknown>;
    return {
      ...record,
      adapterConfig: redactEventPayload(
        typeof record.adapterConfig === "object" && record.adapterConfig !== null
          ? (record.adapterConfig as Record<string, unknown>)
          : {},
      ),
      runtimeConfig: redactEventPayload(
        typeof record.runtimeConfig === "object" && record.runtimeConfig !== null
          ? (record.runtimeConfig as Record<string, unknown>)
          : {},
      ),
      metadata:
        typeof record.metadata === "object" && record.metadata !== null
          ? redactEventPayload(record.metadata as Record<string, unknown>)
          : record.metadata ?? null,
    };
  }

  function redactConfigRevision(
    revision: Record<string, unknown> & { beforeConfig: unknown; afterConfig: unknown },
  ) {
    return {
      ...revision,
      beforeConfig: redactRevisionSnapshot(revision.beforeConfig),
      afterConfig: redactRevisionSnapshot(revision.afterConfig),
    };
  }

  router.param("id", async (req, _res, next, rawId) => {
    try {
      req.params.id = await normalizeAgentReference(req, String(rawId));
      next();
    } catch (err) {
      next(err);
    }
  });

  router.get("/companies/:companyId/adapters/:type/models", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const type = req.params.type as string;
    const models = await listAdapterModels(type);
    res.json(models);
  });

  router.post(
    "/companies/:companyId/adapters/:type/test-environment",
    validate(testAdapterEnvironmentSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const type = req.params.type as string;

      // RBAC and adapter checks happen before acquiring the shared probe slot.
      await assertCanReadConfigurations(req, companyId);

      const adapter = findServerAdapter(type);
      if (!adapter) {
        res.status(404).json({ error: `Unknown adapter type: ${type}` });
        return;
      }

      // Unit D: per-company concurrency cap — reject if a probe is already running.
      const releaseProbeSlot = tryAcquireAdapterProbeSlot(companyId);
      if (!releaseProbeSlot) {
        res
          .status(429)
          .set("Retry-After", String(ADAPTER_PROBE_RETRY_AFTER_SECONDS))
          .json({ error: ADAPTER_PROBE_BUSY_ERROR });
        return;
      }

      try {
        const inputAdapterConfig =
          (req.body?.adapterConfig ?? {}) as Record<string, unknown>;
        const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
          companyId,
          inputAdapterConfig,
          { strictMode: strictSecretsMode },
        );
        const runtimeAdapterConfig = await secretsSvc.resolveAdapterConfigForRuntime(
          companyId,
          type,
          normalizedAdapterConfig,
          {
            consumerType: "system",
            consumerId: `adapter-test:${type}`,
            actorType: "system",
          },
        );

        // Unit D (Part B): resolve the model the SAME way a real run would, so
        // the probe tests reality. Best-effort detection; shell-unsafe is a hard 422.
        let probeAdapterConfig: Record<string, unknown> = runtimeAdapterConfig;
        if (ADAPTER_CONSTRAINT_TYPES.has(type)) {
          // Codex finding P2-1: resolve the model even when it's EMPTY (the UI
          // default-model path). resolveModel maps an empty codex model to the
          // gpt-5.5 default, omits the flag for gemini/claude/opencode — exactly
          // what a real run does. Skipping the empty case made codex probes run
          // with the CLI default instead of gpt-5.5, falsely failing on a ChatGPT
          // login even though the saved run would be corrected.
          const reqModel = typeof runtimeAdapterConfig.model === "string" ? runtimeAdapterConfig.model : "";
          try {
            const status = await getProviderStatus(type, { companyId, adapterConfig: runtimeAdapterConfig }, realProviderStatusDeps);
            const resolved = resolveModel(type, reqModel, status);
            probeAdapterConfig = { ...runtimeAdapterConfig };
            if (resolved.omitModelFlag) delete probeAdapterConfig.model;
            else probeAdapterConfig.model = resolved.model;
          } catch (resolveErr) {
            if (resolveErr instanceof ShellUnsafeModelError) {
              throw unprocessable(`Unsafe model identifier: ${String(reqModel)}`);
            }
            logger.warn({ err: resolveErr }, "adapter-test: model resolution failed (best-effort, using requested model)");
          }
        }

        const environmentId =
          typeof req.body?.environmentId === "string" && req.body.environmentId.trim().length > 0
            ? req.body.environmentId.trim()
            : null;
        const acquiredEnvironment = environmentId
          ? await environmentRuns.acquireForRun({
              companyId,
              environmentId,
              adapterType: type,
              issueId: null,
              heartbeatRunId: null,
              persistedExecutionWorkspace: null,
            })
          : null;

        // Unit D (Part C): redact any secrets that leaked into check messages
        // before returning a probe result to the client. Shared by both the
        // real local/remote-target probe below and the U13.7 sandboxed probe.
        const respondWithRedactedResult = (result: AdapterEnvironmentTestResult) => {
          res.json({
            ...result,
            checks: result.checks.map((c) => ({
              ...c,
              message: typeof c.message === "string" ? redactSecretsInString(c.message) : c.message,
              ...(typeof c.detail === "string" ? { detail: redactSecretsInString(c.detail) } : {}),
              ...(typeof c.hint === "string" ? { hint: redactSecretsInString(c.hint) } : {}),
            })),
          });
        };

        try {
          // D1 (cloud isolation): the probe spawns a REAL `claude --print` /
          // `codex exec` generation. For a local/null target on `cloud_auth` it
          // would run under the OPERATOR's login on the shared control-plane host.
          // Refuse (no-op self-hosted AND on genuinely-isolated targets). Placed
          // INSIDE the inner try so the refusal still hits the lease-release
          // finally below AND the outer releaseProbeSlot finally.
          try {
            assertUnsandboxedMultitenantAllowed(
              acquiredEnvironment?.configPatch.executionTarget ?? null,
              { tenantIsolationEnforced: tenantIsolationEnforced(), sink: "adapter readiness probe" },
            );
          } catch {
            // U13.7: the guard refused the direct on-host probe (cloud_auth,
            // local/null target, no AOA_ALLOW_UNSANDBOXED_MULTITENANT opt-in).
            // Restore BYO-key verify for the two adapter types with a
            // company-key mapping (`resolveCompanyProviderCredential`:
            // codex_local -> openai, claude_local -> anthropic) by routing the
            // hello-probe through an ephemeral sandbox instead of failing
            // closed outright. Every other adapter type (gemini_local, cursor,
            // opencode_local, grok_local, pi_local, process, …) has no
            // sandboxed company-key equivalent yet and keeps the unconditional
            // blocking result below.
            const cliTool = cliToolForSandboxReadinessProbe(type);
            if (cliTool) {
              try {
                const sandboxResult = await probeReadinessInSandbox({
                  db,
                  companyId,
                  cliTool,
                  adapterType: type,
                });
                respondWithRedactedResult(sandboxResult);
                return;
              } catch (err) {
                const mapped = mapCloudProviderKeyError(err, {
                  tenantIsolationEnforced: true,
                  provider: cliTool === "codex" ? "openai" : "anthropic",
                  sink: "adapter readiness probe",
                });
                if (!mapped) throw err;
                res.json({
                  adapterType: type,
                  status: "fail" as const,
                  checks: [
                    { code: "readiness_unavailable_on_cloud", level: "error" as const, message: mapped.message },
                  ],
                  testedAt: new Date().toISOString(),
                });
                return;
              }
            }
            res.json({
              adapterType: type,
              status: "fail" as const,
              checks: [
                {
                  code: "readiness_unavailable_on_cloud",
                  level: "error" as const,
                  message:
                    "Adapter readiness testing is unavailable on AoA Cloud (a local probe would run on the shared host). Configure a sandboxed execution environment or test self-hosted.",
                },
              ],
              testedAt: new Date().toISOString(),
            });
            return;
          }
          const result = await adapter.testEnvironment({
            companyId,
            adapterType: type,
            config: probeAdapterConfig,
            executionTarget: acquiredEnvironment?.configPatch.executionTarget,
            environmentName: acquiredEnvironment?.environment.name ?? null,
          });

          respondWithRedactedResult(result);
        } finally {
          if (acquiredEnvironment) {
            await environmentRuntime.releaseRunLease({
              environment: acquiredEnvironment.environment,
              lease: acquiredEnvironment.lease,
              status: "released",
            }).catch((err) => {
              logger.warn(
                {
                  err,
                  companyId,
                  environmentId,
                  adapterType: type,
                  leaseId: acquiredEnvironment.lease.id,
                },
                "Failed to release adapter environment test lease",
              );
            });
          }
        }
      } finally {
        releaseProbeSlot();
      }
    },
  );

  router.get("/companies/:companyId/agents", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const kind = req.query.kind === "aoa" ? "aoa" as const : undefined;
    const result = await svc.list(companyId, kind ? { kind } : undefined);
    const canReadConfigs = await actorCanReadConfigurationsForCompany(req, companyId);
    if (canReadConfigs || req.actor.type === "board") {
      res.json(result);
      return;
    }
    res.json(result.map((agent) => redactForRestrictedAgentView(agent)));
  });

  router.get("/companies/:companyId/agents/:id/aoa-runs", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const agentId = req.params.id as string;
    const limit = Math.min(parseInt(String(req.query.limit ?? 50)), 200);
    const where = and(
      eq(internalAgentRuns.companyId, companyId),
      eq(internalAgentRuns.agentId, agentId),
    );
    // True total (count(*)::int) — index-backed by ia_runs_agent_idx on
    // (companyId, agentId), so it stays cheap. Returned alongside the capped
    // page so the UI shows a real "Total runs" count, not the page length.
    // Use sql`count(*)::int` (the internal-agent.ts:864 idiom), NOT drizzle's
    // count() helper — the agentRoutes route tests mock drizzle-orm with `sql`
    // but no `count` export, so `count()` would break them.
    const [{ total } = { total: 0 }] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(internalAgentRuns)
      .where(where);
    const runs = await db
      .select()
      .from(internalAgentRuns)
      .where(where)
      .orderBy(desc(internalAgentRuns.createdAt))
      .limit(limit);
    res.json({ runs, total, limit });
  });

  router.get("/companies/:companyId/agents/:id/triggers", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const agentId = req.params.id as string;
    const triggers = await db
      .select()
      .from(aoaAgentTriggers)
      .where(and(eq(aoaAgentTriggers.companyId, companyId), eq(aoaAgentTriggers.agentId, agentId)));
    res.json(triggers);
  });

  router.post("/companies/:companyId/agents/:id/triggers", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    await assertHumanRole(db, req, companyId, "founder");
    const agentId = req.params.id as string;
    const { kind, config, enabled } = req.body as { kind: string; config?: Record<string, unknown>; enabled?: boolean };
    const created = await db
      .insert(aoaAgentTriggers)
      .values({ companyId, agentId, kind, config: config ?? {}, enabled: enabled ?? true })
      .returning()
      .then((rows) => rows[0]);
    res.status(201).json(created);
  });

  router.patch("/companies/:companyId/agents/:id/triggers/:triggerId", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    await assertHumanRole(db, req, companyId, "founder");
    const agentId = req.params.id as string;
    const triggerId = req.params.triggerId as string;
    const { enabled, config } = req.body as { enabled?: boolean; config?: Record<string, unknown> };
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (enabled !== undefined) updates.enabled = enabled;
    if (config !== undefined) updates.config = config;
    const updated = await db
      .update(aoaAgentTriggers)
      .set(updates)
      .where(and(eq(aoaAgentTriggers.id, triggerId), eq(aoaAgentTriggers.companyId, companyId)))
      .returning()
      .then((rows) => rows[0]);
    if (!updated) throw notFound("Trigger not found");

    // D3: Audit trigger config changes.
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "aoa_agent.trigger_changed",
      entityType: "aoa_agent_trigger",
      entityId: triggerId,
      agentId,
      details: { enabled: updated.enabled, kind: updated.kind },
    });

    res.json(updated);
  });

  router.get("/instance/scheduler-heartbeats", async (req, res) => {
    // This endpoint is an instance-wide tenant-data scan. The cloud operator
    // plane must never inherit ambient access to every tenant, so reject from
    // the static deployment mode before touching the database.
    if (tenantIsolationEnforced()) {
      throw forbidden("Scheduler heartbeat overview is unavailable in cloud mode");
    }
    if (req.actor.type !== "board" || !req.actor.isInstanceAdmin) {
      throw forbidden("Instance admin required");
    }

    const rows = await db
      .select({
        id: agentsTable.id,
        companyId: agentsTable.companyId,
        agentName: agentsTable.name,
        role: agentsTable.role,
        title: agentsTable.title,
        status: agentsTable.status,
        adapterType: agentsTable.adapterType,
        runtimeConfig: agentsTable.runtimeConfig,
        lastHeartbeatAt: agentsTable.lastHeartbeatAt,
        companyName: companies.name,
        companyIssuePrefix: companies.issuePrefix,
      })
      .from(agentsTable)
      .innerJoin(companies, eq(agentsTable.companyId, companies.id))
      .orderBy(companies.name, agentsTable.name);

    const items: InstanceSchedulerHeartbeatAgent[] = rows
      .map((row) => {
        const policy = parseSchedulerHeartbeatPolicy(row.runtimeConfig);
        const statusEligible =
          row.status !== "paused" &&
          row.status !== "terminated" &&
          row.status !== "pending_approval";

        return {
          id: row.id,
          companyId: row.companyId,
          companyName: row.companyName,
          companyIssuePrefix: row.companyIssuePrefix,
          agentName: row.agentName,
          agentUrlKey: deriveAgentUrlKey(row.agentName, row.id),
          role: row.role as InstanceSchedulerHeartbeatAgent["role"],
          title: row.title,
          status: row.status as InstanceSchedulerHeartbeatAgent["status"],
          adapterType: row.adapterType,
          intervalSec: policy.intervalSec,
          heartbeatEnabled: policy.enabled,
          schedulerActive: statusEligible && policy.enabled && policy.intervalSec > 0,
          lastHeartbeatAt: row.lastHeartbeatAt,
        };
      })
      .filter((item) =>
        item.status !== "paused" &&
        item.status !== "terminated" &&
        item.status !== "pending_approval",
      )
      .sort((left, right) => {
        if (left.schedulerActive !== right.schedulerActive) {
          return left.schedulerActive ? -1 : 1;
        }
        const companyOrder = left.companyName.localeCompare(right.companyName);
        if (companyOrder !== 0) return companyOrder;
        return left.agentName.localeCompare(right.agentName);
      });

    res.json(items);
  });

  router.get("/companies/:companyId/org", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const tree = await svc.orgForCompany(companyId);
    res.json(tree);
  });

  router.get("/companies/:companyId/agent-configurations", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanReadConfigurations(req, companyId);
    const rows = await svc.list(companyId);
    res.json(rows.map((row) => redactAgentConfiguration(row)));
  });

  router.get("/agents/me", async (req, res) => {
    if (req.actor.type !== "agent" || !req.actor.agentId) {
      res.status(401).json({ error: "Agent authentication required" });
      return;
    }
    const agent = await svc.getById(req.actor.agentId);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    const chainOfCommand = await svc.getChainOfCommand(agent.id, agent.companyId);
    res.json({ ...agent, chainOfCommand });
  });

  router.get("/agents/:id", async (req, res) => {
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCompanyAccess(db, req, agent.companyId);
    if (req.actor.type === "agent" && req.actor.agentId !== id) {
      const canRead = await actorCanReadConfigurationsForCompany(req, agent.companyId);
      if (!canRead) {
        const chainOfCommand = await svc.getChainOfCommand(agent.id, agent.companyId);
        res.json({ ...redactForRestrictedAgentView(agent), chainOfCommand });
        return;
      }
    }
    const chainOfCommand = await svc.getChainOfCommand(agent.id, agent.companyId);
    res.json({ ...agent, chainOfCommand });
  });

  router.get("/agents/:id/configuration", async (req, res) => {
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanReadConfigurations(req, agent.companyId);
    res.json(redactAgentConfiguration(agent));
  });

  router.get("/agents/:id/config-revisions", async (req, res) => {
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanReadConfigurations(req, agent.companyId);
    const revisions = await svc.listConfigRevisions(id);
    res.json(revisions.map((revision) => redactConfigRevision(revision)));
  });

  router.get("/agents/:id/config-revisions/:revisionId", async (req, res) => {
    const id = req.params.id as string;
    const revisionId = req.params.revisionId as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanReadConfigurations(req, agent.companyId);
    const revision = await svc.getConfigRevision(id, revisionId);
    if (!revision) {
      res.status(404).json({ error: "Revision not found" });
      return;
    }
    res.json(redactConfigRevision(revision));
  });

  router.post("/agents/:id/config-revisions/:revisionId/rollback", async (req, res) => {
    const id = req.params.id as string;
    const revisionId = req.params.revisionId as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanUpdateAgent(req, existing);

    const actor = getActorInfo(req);
    const updated = await svc.rollbackConfigRevision(id, revisionId, {
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });
    if (!updated) {
      res.status(404).json({ error: "Revision not found" });
      return;
    }

    await logActivity(db, {
      companyId: updated.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.config_rolled_back",
      entityType: "agent",
      entityId: updated.id,
      details: { revisionId },
    });

    res.json(updated);
  });

  router.get("/agents/:id/runtime-state", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCompanyAccess(db, req, agent.companyId);

    const state = await heartbeat.getRuntimeState(id);
    res.json(state);
  });

  router.get("/agents/:id/task-sessions", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCompanyAccess(db, req, agent.companyId);

    const sessions = await heartbeat.listTaskSessions(id);
    res.json(
      sessions.map((session) => ({
        ...session,
        sessionParamsJson: redactEventPayload(session.sessionParamsJson ?? null),
      })),
    );
  });

  router.post("/agents/:id/runtime-state/reset-session", validate(resetAgentSessionSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCompanyAccess(db, req, agent.companyId);

    const taskKey =
      typeof req.body.taskKey === "string" && req.body.taskKey.trim().length > 0
        ? req.body.taskKey.trim()
        : null;
    const state = await heartbeat.resetRuntimeSession(id, { taskKey });

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "agent.runtime_session_reset",
      entityType: "agent",
      entityId: id,
      details: { taskKey: taskKey ?? null },
    });

    res.json(state);
  });

  async function materializeDefaultInstructionsBundleForNewAgent<T extends {
    id: string;
    companyId: string;
    name: string;
    role: string;
    adapterType: string;
    adapterConfig: unknown;
  }>(agent: T): Promise<T> {
    if (!adapterSupportsInstructionsBundle(agent.adapterType)) {
      return agent;
    }

    const adapterConfig = asRecord(agent.adapterConfig) ?? {};
    const hasExplicitInstructionsBundle =
      Boolean(asNonEmptyString(adapterConfig.instructionsBundleMode))
      || Boolean(asNonEmptyString(adapterConfig.instructionsRootPath))
      || Boolean(asNonEmptyString(adapterConfig.instructionsEntryFile))
      || Boolean(asNonEmptyString(adapterConfig.instructionsFilePath))
      || Boolean(asNonEmptyString(adapterConfig.agentsMdPath));
    if (hasExplicitInstructionsBundle) {
      return agent;
    }

    const promptTemplate = typeof adapterConfig.promptTemplate === "string"
      ? adapterConfig.promptTemplate
      : "";
    const files = promptTemplate.trim().length === 0
      ? await loadDefaultAgentInstructionsBundle(resolveDefaultAgentInstructionsBundleRole(agent.role))
      : { "AGENTS.md": promptTemplate };
    const materialized = await instructions.materializeManagedBundle(
      agent,
      files,
      { entryFile: "AGENTS.md", replaceExisting: false },
    );
    const nextAdapterConfig = { ...materialized.adapterConfig };
    delete nextAdapterConfig.promptTemplate;

    const updated = await svc.update(agent.id, { adapterConfig: nextAdapterConfig });
    return (updated as T | null) ?? { ...agent, adapterConfig: nextAdapterConfig };
  }

  router.post("/companies/:companyId/agent-hires", validate(createAgentHireSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanCreateAgentsForCompany(req, companyId);
    const sourceIssueIds = parseSourceIssueIds(req.body);
    const { sourceIssueId: _sourceIssueId, sourceIssueIds: _sourceIssueIds, ...hireInput } = req.body;
    const requestedAdapterConfig = applyCreateDefaultsByAdapterType(
      hireInput.adapterType,
      ((hireInput.adapterConfig ?? {}) as Record<string, unknown>),
    );
    const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
      companyId,
      requestedAdapterConfig,
      { strictMode: strictSecretsMode },
    );
    // Unconditional call — function self-dispatches by adapterType and returns []
    // cheaply for non-constraint types; create always sets adapterConfig.
    const adapterWarnings = await assertAdapterConfigConstraints(
      companyId,
      hireInput.adapterType,
      normalizedAdapterConfig,
    );
    const normalizedHireInput = {
      ...hireInput,
      adapterConfig: normalizedAdapterConfig,
    };

    const company = await db
      .select()
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }

    const requiresApproval = company.requireBoardApprovalForNewAgents;
    const status = requiresApproval ? "pending_approval" : "idle";
    const createdAgent = await svc.create(companyId, {
      ...normalizedHireInput,
      status,
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
    await secretsSvc.syncEnvBindingsForTarget(companyId, {
      targetType: "agent",
      targetId: createdAgent.id,
      pathPrefix: "env",
    }, normalizedAdapterConfig.env);
    const agent = await materializeDefaultInstructionsBundleForNewAgent(createdAgent);

    let approval: Awaited<ReturnType<typeof approvalsSvc.getById>> | null = null;
    const actor = getActorInfo(req);

    if (requiresApproval) {
      const requestedAdapterType = normalizedHireInput.adapterType ?? agent.adapterType;
      const requestedAdapterConfig =
        redactEventPayload(
          (normalizedHireInput.adapterConfig ?? agent.adapterConfig) as Record<string, unknown>,
        ) ?? {};
      const requestedRuntimeConfig =
        redactEventPayload(
          (normalizedHireInput.runtimeConfig ?? agent.runtimeConfig) as Record<string, unknown>,
        ) ?? {};
      const requestedMetadata =
        redactEventPayload(
          ((normalizedHireInput.metadata ?? agent.metadata ?? {}) as Record<string, unknown>),
        ) ?? {};
      approval = await approvalsSvc.create(companyId, {
        type: "hire_agent",
        requestedByAgentId: actor.actorType === "agent" ? actor.actorId : null,
        requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
        status: "pending",
        payload: {
          name: normalizedHireInput.name,
          role: normalizedHireInput.role,
          title: normalizedHireInput.title ?? null,
          icon: normalizedHireInput.icon ?? null,
          reportsTo: normalizedHireInput.reportsTo ?? null,
          capabilities: normalizedHireInput.capabilities ?? null,
          adapterType: requestedAdapterType,
          adapterConfig: requestedAdapterConfig,
          runtimeConfig: requestedRuntimeConfig,
          budgetMonthlyCents:
            typeof normalizedHireInput.budgetMonthlyCents === "number"
              ? normalizedHireInput.budgetMonthlyCents
              : agent.budgetMonthlyCents,
          metadata: requestedMetadata,
          agentId: agent.id,
          requestedByAgentId: actor.actorType === "agent" ? actor.actorId : null,
          requestedConfigurationSnapshot: {
            adapterType: requestedAdapterType,
            adapterConfig: requestedAdapterConfig,
            runtimeConfig: requestedRuntimeConfig,
          },
        },
        decisionNote: null,
        decidedByUserId: null,
        decidedAt: null,
        updatedAt: new Date(),
      });

      if (sourceIssueIds.length > 0) {
        await issueApprovalsSvc.linkManyForApproval(approval.id, sourceIssueIds, {
          agentId: actor.actorType === "agent" ? actor.actorId : null,
          userId: actor.actorType === "user" ? actor.actorId : null,
        });
      }

      // Materialize the hire approval as a hub item immediately (H2). The hire
      // route has no surrounding tx, so this matches the approval-create's
      // atomicity — the item appears on the very next hub read instead of
      // waiting for the scan-on-read backstop. Best-effort: a hub failure must
      // never fail the hire (the scan-on-read still fills the gap).
      try {
        await emitHubItem(db, buildApprovalHubEmit(approval));
      } catch (err) {
        logger.error(
          { err, companyId, approvalId: approval.id },
          "hire approval hub emit failed (scan-on-read backstop will fill it)",
        );
      }
    }

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.hire_created",
      entityType: "agent",
      entityId: agent.id,
      details: {
        name: agent.name,
        role: agent.role,
        requiresApproval,
        approvalId: approval?.id ?? null,
        issueIds: sourceIssueIds,
      },
    });

    if (approval) {
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "approval.created",
        entityType: "approval",
        entityId: approval.id,
        details: { type: approval.type, linkedAgentId: agent.id },
      });
    }

    res.status(201).json({ agent, approval, ...(adapterWarnings.length ? { warnings: adapterWarnings } : {}) });
  });

  router.post("/companies/:companyId/agents", validate(createAgentSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    await assertRole(db, req, companyId, "founder");

    if (req.actor.type === "agent") {
      // rbac: instance-admin-not-required — assertCompanyAccess + assertRole above already enforce scope; this assertBoard rejects agent actors from creating agents.
      assertBoard(req);
    }

    const requestedAdapterConfig = applyCreateDefaultsByAdapterType(
      req.body.adapterType,
      ((req.body.adapterConfig ?? {}) as Record<string, unknown>),
    );
    const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
      companyId,
      requestedAdapterConfig,
      { strictMode: strictSecretsMode },
    );
    const adapterWarnings = await assertAdapterConfigConstraints(
      companyId,
      req.body.adapterType,
      normalizedAdapterConfig,
    );

    const createdAgent = await svc.create(companyId, {
      ...req.body,
      adapterConfig: normalizedAdapterConfig,
      status: "idle",
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
    await secretsSvc.syncEnvBindingsForTarget(companyId, {
      targetType: "agent",
      targetId: createdAgent.id,
      pathPrefix: "env",
    }, normalizedAdapterConfig.env);
    const agent = await materializeDefaultInstructionsBundleForNewAgent(createdAgent);

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.created",
      entityType: "agent",
      entityId: agent.id,
      details: { name: agent.name, role: agent.role },
    });

    // D3: AoA-specific audit entry so governance queries can filter by kind.
    if (agent.kind === "aoa") {
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "aoa_agent.created",
        entityType: "agent",
        entityId: agent.id,
        details: { name: agent.name, role: agent.role },
      });
    }

    res.status(201).json({ ...agent, ...(adapterWarnings.length ? { warnings: adapterWarnings } : {}) });
  });

  router.patch("/agents/:id/permissions", validate(updateAgentPermissionsSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCompanyAccess(db, req, existing.companyId);

    // Spec §10 governance: only founders may edit AoA agents (Commander +
    // sub-agents). This handler uses neither shared authz helper, so the
    // kind='aoa' gate is inline here, before any mutation/authz that could let
    // a non-founder through. assertRole is a NO-OP for agent actors (rbac.ts),
    // so the explicit non-board rejection is load-bearing: pre-fix a cxo agent
    // (role==='cxo') passed the agent branch below and a non-founder board user
    // had no gate at all, letting either toggle an AoA agent's canCreateAgents.
    // Mirrors the FX2 assertCanUpdateAgent pattern. kind!=='aoa' byte-unchanged.
    if (existing.kind === "aoa") {
      if (req.actor.type !== "board") {
        res.status(403).json({ error: "Only a founder may modify AoA agents" });
        return;
      }
      await assertRole(db, req, existing.companyId, "founder");
    } else if (req.actor.type === "agent") {
      const actorAgent = req.actor.agentId ? await svc.getById(req.actor.agentId) : null;
      if (!actorAgent || actorAgent.companyId !== existing.companyId) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      if (actorAgent.role !== "cxo") {
        res.status(403).json({ error: "Only CXO can manage permissions" });
        return;
      }
    }

    const agent = await svc.updatePermissions(id, req.body);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.permissions_updated",
      entityType: "agent",
      entityId: agent.id,
      details: req.body,
    });

    res.json(agent);
  });

  router.patch("/agents/:id/instructions-path", validate(updateAgentInstructionsPathSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    await assertCanManageInstructionsPath(req, existing);

    const existingAdapterConfig = asRecord(existing.adapterConfig) ?? {};
    const explicitKey = asNonEmptyString(req.body.adapterConfigKey);
    const defaultKey = DEFAULT_INSTRUCTIONS_PATH_KEYS[existing.adapterType] ?? null;
    const adapterConfigKey = explicitKey ?? defaultKey;
    if (!adapterConfigKey) {
      res.status(422).json({
        error: `No default instructions path key for adapter type '${existing.adapterType}'. Provide adapterConfigKey.`,
      });
      return;
    }

    const nextAdapterConfig: Record<string, unknown> = { ...existingAdapterConfig };
    if (req.body.path === null) {
      delete nextAdapterConfig[adapterConfigKey];
    } else {
      nextAdapterConfig[adapterConfigKey] = resolveInstructionsFilePath(req.body.path, existingAdapterConfig);
    }

    const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
      existing.companyId,
      nextAdapterConfig,
      { strictMode: strictSecretsMode },
    );
    const actor = getActorInfo(req);
    const agent = await svc.update(
      id,
      { adapterConfig: normalizedAdapterConfig, instructionsCustomized: true },
      {
        recordRevision: {
          createdByAgentId: actor.agentId,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null,
          source: "instructions_path_patch",
        },
      },
    );
    if (agent) {
      await secretsSvc.syncEnvBindingsForTarget(existing.companyId, {
        targetType: "agent",
        targetId: agent.id,
        pathPrefix: "env",
      }, normalizedAdapterConfig.env);
    }
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const updatedAdapterConfig = asRecord(agent.adapterConfig) ?? {};
    const pathValue = asNonEmptyString(updatedAdapterConfig[adapterConfigKey]);

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.instructions_path_updated",
      entityType: "agent",
      entityId: agent.id,
      details: {
        adapterConfigKey,
        path: pathValue,
        cleared: req.body.path === null,
      },
    });

    res.json({
      agentId: agent.id,
      adapterType: agent.adapterType,
      adapterConfigKey,
      path: pathValue,
    });
  });

  router.patch("/agents/:id", validate(updateAgentSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanUpdateAgent(req, existing);

    if (Object.prototype.hasOwnProperty.call(req.body, "permissions")) {
      res.status(422).json({ error: "Use /api/agents/:id/permissions for permission changes" });
      return;
    }

    // Destructure the transport-only optimistic-concurrency token OUT of the
    // patch so it never reaches Drizzle `.set()` as a phantom column; it is
    // forwarded only via the svc.update options object below.
    const { expectedUpdatedAt, ...bodyRest } = req.body as Record<string, unknown>;
    const patchData = { ...bodyRest };
    if (Object.prototype.hasOwnProperty.call(patchData, "adapterConfig")) {
      const adapterConfig = asRecord(patchData.adapterConfig);
      if (!adapterConfig) {
        res.status(422).json({ error: "adapterConfig must be an object" });
        return;
      }
      const changingInstructionsPath = Object.keys(adapterConfig).some((key) =>
        KNOWN_INSTRUCTIONS_PATH_KEYS.has(key),
      );
      if (changingInstructionsPath) {
        await assertCanManageInstructionsPath(req, existing);
      }
      // D22 (Decision #114): this route is the FIFTH instruction-changing write
      // path. `adapterConfig` is free-form, and the shipped Config tab edits
      // `promptTemplate` / `instructionsFilePath` through here — keys a catalog
      // update deletes or overwrites. Without this stamp the row stays `false`
      // and `crew-updater` silently destroys the edit on the next bump.
      //
      // Server-side assignment onto the Zod-parsed body: a client cannot
      // suppress it, and cannot set the flag itself (it is absent from
      // `updateAgentSchema`, and `validate` reassigns `req.body` from the parse).
      // Keyed on the PATCH's OWN keys, not the merged config, so an unrelated
      // PATCH never stamps an agent that merely happens to have a promptTemplate.
      if (
        Object.keys(adapterConfig).some((key) =>
          INSTRUCTION_BEARING_ADAPTER_CONFIG_KEYS.has(key),
        )
      ) {
        patchData.instructionsCustomized = true;
      }
      patchData.adapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
        existing.companyId,
        adapterConfig,
        { strictMode: strictSecretsMode },
      );
    }

    const requestedAdapterType =
      typeof patchData.adapterType === "string" ? patchData.adapterType : existing.adapterType;
    const touchesAdapterConfiguration =
      Object.prototype.hasOwnProperty.call(patchData, "adapterType") ||
      Object.prototype.hasOwnProperty.call(patchData, "adapterConfig");
    let adapterWarnings: string[] = [];
    // Codex P2: a model-only PATCH carries no adapterType in the body, so the
    // schema's refineAdapterModel early-returns; and the ADAPTER_CONSTRAINT_TYPES
    // path below only covers four types. So an unsafe model on another model-aware
    // adapter (cursor/grok_local/pi_local — all spawn `--model`) would persist and
    // fail at runtime. Hard-block a shell-unsafe EFFECTIVE model for EVERY
    // model-aware adapter, using the SAME rule (isShellSafeModelId) the schema
    // applies, so the route and schema can never diverge.
    if (touchesAdapterConfiguration && requestedAdapterType != null && MODEL_AWARE_ADAPTER_TYPES.has(requestedAdapterType)) {
      const effectiveModel = asNonEmptyString(
        (Object.prototype.hasOwnProperty.call(patchData, "adapterConfig")
          ? asRecord(patchData.adapterConfig)
          : asRecord(existing.adapterConfig)
        )?.model,
      );
      if (effectiveModel && !isShellSafeModelId(effectiveModel)) {
        res.status(422).json({ error: `Unsafe model identifier: ${effectiveModel}` });
        return;
      }
    }
    if (touchesAdapterConfiguration && requestedAdapterType != null && ADAPTER_CONSTRAINT_TYPES.has(requestedAdapterType)) {
      const rawEffectiveAdapterConfig = Object.prototype.hasOwnProperty.call(patchData, "adapterConfig")
        ? (asRecord(patchData.adapterConfig) ?? {})
        : (asRecord(existing.adapterConfig) ?? {});
      const effectiveAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
        existing.companyId,
        rawEffectiveAdapterConfig,
        { strictMode: strictSecretsMode },
      );
      // Codex finding ②: the schema's cross-family refinement can't see the EFFECTIVE
      // model on an adapter-only PATCH (no model in the body) or a model-only PATCH
      // (no adapterType in the body). Hard-block a persisted-model/new-adapter mismatch
      // here so we never persist e.g. claude_local + a gpt model. (opencode_local is
      // exempt — adapterModelFamilyMismatch returns null for it.)
      const familyMismatch = adapterModelFamilyMismatch(
        requestedAdapterType,
        asNonEmptyString(effectiveAdapterConfig.model) ?? undefined,
      );
      if (familyMismatch) {
        res.status(422).json({ error: familyMismatch });
        return;
      }
      adapterWarnings = await assertAdapterConfigConstraints(
        existing.companyId,
        requestedAdapterType,
        effectiveAdapterConfig,
      );
    }

    // Validate skillKeys against company's available skills (throws 422 on unknown/ambiguous)
    // and persist the *canonical* keys — resolveSkillKeys accepts id/slug/normalizable
    // forms but delivery + enforcement compare against skill.key, so a non-canonical
    // attach would silently no-op if stored raw. An empty array clears skills as-is.
    if (Object.prototype.hasOwnProperty.call(patchData, "skillKeys")) {
      const requestedKeys = patchData.skillKeys;
      if (Array.isArray(requestedKeys) && requestedKeys.length > 0) {
        patchData.skillKeys = await skillSvc.resolveSkillKeys(
          existing.companyId,
          requestedKeys as string[],
        );
      }
    }

    const actor = getActorInfo(req);
    const agent = await svc.update(id, patchData, {
      recordRevision: {
        createdByAgentId: actor.agentId,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
        source: "patch",
      },
      ...(typeof expectedUpdatedAt === "string" ? { expectedUpdatedAt } : {}),
    });
    if (agent && patchData.adapterConfig) {
      await secretsSvc.syncEnvBindingsForTarget(existing.companyId, {
        targetType: "agent",
        targetId: agent.id,
        pathPrefix: "env",
      }, (patchData.adapterConfig as Record<string, unknown>).env);
    }
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.updated",
      entityType: "agent",
      entityId: agent.id,
      details: summarizeAgentUpdateDetails(patchData),
    });

    res.json({ ...agent, ...(adapterWarnings.length ? { warnings: adapterWarnings } : {}) });
  });

  router.post("/agents/:id/pause", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCompanyAccess(db, req, existing.companyId);
    if (existing.kind === "aoa") {
      await assertRole(db, req, existing.companyId, "founder");
    }

    const agent = await svc.pause(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    await heartbeat.cancelActiveForAgent(id);

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "agent.paused",
      entityType: "agent",
      entityId: agent.id,
    });

    // D3: AoA-specific audit entry.
    if (existing.kind === "aoa") {
      await logActivity(db, {
        companyId: agent.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "aoa_agent.paused",
        entityType: "agent",
        entityId: agent.id,
      });
    }

    res.json(agent);
  });

  router.post("/agents/:id/resume", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCompanyAccess(db, req, existing.companyId);
    if (existing.kind === "aoa") {
      await assertRole(db, req, existing.companyId, "founder");
    }

    const agent = await svc.resume(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "agent.resumed",
      entityType: "agent",
      entityId: agent.id,
    });

    res.json(agent);
  });

  router.post("/agents/:id/terminate", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    // FX-del: AoA agents (Commander + sub-agents) are reserved framework
    // agents. Terminate is hard-blocked for ALL actors (founders included) —
    // before the company/role gate. kind='org' is unaffected.
    //
    // ⚠️ D23 asymmetry: unlike DELETE above, this gates on `kind` ALONE. That
    // covers Commander and Steward today because both are kind='aoa', but if
    // crew rows ever become individually terminable this loses protection while
    // delete keeps it. Add the `protectedAgentRole` check here at that point.
    // (Not added now: terminate is reversible — it sets status, it destroys
    // nothing — so the fail-closed argument that justifies the delete guard
    // does not apply with the same force.)
    if (existing.kind === "aoa") {
      res.status(409).json({
        error:
          "AoA agents are reserved framework agents and cannot be deleted or terminated",
      });
      return;
    }
    await assertCompanyAccess(db, req, existing.companyId);

    const agent = await svc.terminate(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    await heartbeat.cancelActiveForAgent(id);

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "agent.terminated",
      entityType: "agent",
      entityId: agent.id,
    });

    res.json(agent);
  });

  router.delete("/agents/:id", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    // `getById` is NOT company-scoped, and both 409s below describe the row
    // (the protected one echoes its name). Scope the caller to the agent's
    // company BEFORE either can answer — this tightens the pre-existing FX-del
    // refusal too. The founder gate still runs below; this is access, not role.
    //
    // Stated precisely: this stops the *content* of the row leaking across
    // tenants (name, kind). It does NOT make existence unobservable — a
    // cross-tenant hit now answers 403 where a miss answers 404, the same
    // oracle every other `assertCompanyAccess` route in this file has. Closing
    // that would mean 404-ing on forbidden everywhere, which is a separate
    // decision about the whole file, not this handler.
    await assertCompanyAccess(db, req, existing.companyId);
    // D23 (T2.5): protected AoA agents are refused on identity, independent of
    // `kind`. Deliberately BEFORE the FX-del check below: that one is scoped to
    // kind='aoa', so it would stop covering a protected agent the day crew rows
    // become individually removable. Also gives a refusal that names the reason.
    const protectedRole = protectedAgentRole(existing);
    if (protectedRole) {
      res.status(409).json({
        error: protectedAgentRefusal([{ name: existing.name, role: protectedRole }], {
          operation: "Deleting this agent",
          remedy: "Pause it from the agent page if you want it to stop working.",
        }),
      });
      return;
    }
    // FX-del: AoA agents (Commander + sub-agents) are reserved framework
    // agents. Delete is hard-blocked for ALL actors (founders included) —
    // before the founder gate. kind='org' is unaffected.
    if (existing.kind === "aoa") {
      res.status(409).json({
        error:
          "AoA agents are reserved framework agents and cannot be deleted or terminated",
      });
      return;
    }
    await assertRole(db, req, existing.companyId, "founder");
    const agent = await svc.remove(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "agent.deleted",
      entityType: "agent",
      entityId: agent.id,
    });

    res.json({ ok: true });
  });

  router.get("/agents/:id/keys", async (req, res) => {
    assertBoard(req);
    const agent = await svc.getById(req.params.id as string);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCompanyAccess(db, req, agent.companyId);
    const keys = await svc.listKeys(agent.id);
    res.json(keys);
  });

  router.post("/agents/:id/keys", validate(createAgentKeySchema), async (req, res) => {
    assertBoard(req);
    const agent = await svc.getById(req.params.id as string);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCompanyAccess(db, req, agent.companyId);

    const key = await svc.createApiKey(agent.id, req.body.name);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.key_created",
      entityType: "agent",
      entityId: agent.id,
      details: { keyId: key.id, name: key.name },
    });

    res.status(201).json(key);
  });

  router.delete("/agents/:id/keys/:keyId", async (req, res) => {
    assertBoard(req);
    const agent = await svc.getById(req.params.id as string);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCompanyAccess(db, req, agent.companyId);

    const key = await svc.getKeyById(req.params.keyId as string);
    if (!key || key.agentId !== agent.id) {
      res.status(404).json({ error: "Key not found" });
      return;
    }
    await svc.revokeKey(req.params.keyId as string);

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.key_revoked",
      entityType: "agent",
      entityId: agent.id,
      details: { keyId: key.id },
    });

    res.json({ ok: true });
  });

  router.post("/agents/:id/wakeup", validate(wakeAgentSchema), async (req, res) => {
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCompanyAccess(db, req, agent.companyId);

    if (req.actor.type === "agent" && req.actor.agentId !== id) {
      res.status(403).json({ error: "Agent can only invoke itself" });
      return;
    }

    const run = await heartbeat.wakeup(id, {
      source: req.body.source,
      triggerDetail: req.body.triggerDetail ?? "manual",
      reason: req.body.reason ?? null,
      payload: req.body.payload ?? null,
      idempotencyKey: req.body.idempotencyKey ?? null,
      requestedByActorType: req.actor.type === "agent" ? "agent" : "user",
      requestedByActorId: req.actor.type === "agent" ? req.actor.agentId ?? null : req.actor.userId ?? null,
      contextSnapshot: {
        triggeredBy: req.actor.type,
        actorId: req.actor.type === "agent" ? req.actor.agentId : req.actor.userId,
      },
    });

    if (!run) {
      res.status(202).json({ status: "skipped" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "heartbeat.invoked",
      entityType: "heartbeat_run",
      entityId: run.id,
      details: { agentId: id },
    });

    res.status(202).json(run);
  });

  router.post("/agents/:id/heartbeat/invoke", validate(wakeAgentSchema), async (req, res) => {
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCompanyAccess(db, req, agent.companyId);

    if (req.actor.type === "agent" && req.actor.agentId !== id) {
      res.status(403).json({ error: "Agent can only invoke itself" });
      return;
    }

    const body = req.body as WakeAgent;
    const run = await heartbeat.wakeup(id, {
      source: body.source ?? "on_demand",
      triggerDetail: body.triggerDetail ?? "manual",
      reason: body.reason ?? null,
      payload: body.payload ?? null,
      idempotencyKey: body.idempotencyKey ?? null,
      requestedByActorType: req.actor.type === "agent" ? "agent" : "user",
      requestedByActorId: req.actor.type === "agent" ? req.actor.agentId ?? null : req.actor.userId ?? null,
      contextSnapshot: {
        triggeredBy: req.actor.type,
        actorId: req.actor.type === "agent" ? req.actor.agentId : req.actor.userId,
      },
    });

    if (!run) {
      res.status(202).json({ status: "skipped" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "heartbeat.invoked",
      entityType: "heartbeat_run",
      entityId: run.id,
      details: { agentId: id },
    });

    res.status(202).json(run);
  });

  router.post("/agents/:id/claude-login", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCompanyAccess(db, req, agent.companyId);
    if (agent.adapterType !== "claude_local") {
      res.status(400).json({ error: "Login is only supported for claude_local agents" });
      return;
    }

    const config = asRecord(agent.adapterConfig) ?? {};
    const runtimeConfig = await secretsSvc.resolveAdapterConfigForRuntime(agent.companyId, agent.adapterType, config, {
      consumerType: "agent",
      consumerId: agent.id,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
    });
    const result = await runClaudeLogin({
      runId: `claude-login-${randomUUID()}`,
      agent: {
        id: agent.id,
        companyId: agent.companyId,
        name: agent.name,
        adapterType: agent.adapterType,
        adapterConfig: agent.adapterConfig,
      },
      config: runtimeConfig,
    });

    res.json(result);
  });

  router.get("/companies/:companyId/heartbeat-runs", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const agentId = req.query.agentId as string | undefined;
    const limitParam = req.query.limit as string | undefined;
    const limit = limitParam ? Math.max(1, Math.min(1000, parseInt(limitParam, 10) || 200)) : undefined;
    const runs = await heartbeat.list(companyId, agentId, limit);
    res.json(runs);
  });

  router.get("/companies/:companyId/live-runs", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);

    const minCountParam = req.query.minCount as string | undefined;
    const minCount = minCountParam ? Math.max(0, Math.min(20, parseInt(minCountParam, 10) || 0)) : 0;

    // Task 5.5: heartbeat live rows UNION crew (internal_agent) live rows so the
    // kanban / Crew Board "Live" pill reflects crew runs, not just heartbeat.
    const liveRuns = await liveRunsForCompany(db, companyId, { minCount });
    res.json(liveRuns);
  });

  router.post("/heartbeat-runs/:runId/cancel", async (req, res) => {
    assertBoard(req);
    const runId = req.params.runId as string;
    const existing = await heartbeat.getRun(runId);
    if (!existing) {
      res.status(404).json({ error: "Heartbeat run not found" });
      return;
    }
    await assertCompanyAccess(db, req, existing.companyId);

    const run = await heartbeat.cancelRun(runId);

    if (run) {
      await logActivity(db, {
        companyId: run.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "heartbeat.cancelled",
        entityType: "heartbeat_run",
        entityId: run.id,
        details: { agentId: run.agentId },
      });
    }

    res.json(run);
  });

  router.get("/heartbeat-runs/:runId/events", async (req, res) => {
    const runId = req.params.runId as string;
    const run = await heartbeat.getRun(runId);
    if (!run) {
      res.status(404).json({ error: "Heartbeat run not found" });
      return;
    }
    await assertCompanyAccess(db, req, run.companyId);

    const afterSeq = Number(req.query.afterSeq ?? 0);
    const limit = Number(req.query.limit ?? 200);
    const events = await heartbeat.listEvents(runId, Number.isFinite(afterSeq) ? afterSeq : 0, Number.isFinite(limit) ? limit : 200);
    const redactedEvents = events.map((event) => ({
      ...event,
      payload: redactEventPayload(event.payload),
    }));
    res.json(redactedEvents);
  });

  router.get("/heartbeat-runs/:runId/log", async (req, res) => {
    const runId = req.params.runId as string;
    const run = await heartbeat.getRun(runId);
    if (!run) {
      res.status(404).json({ error: "Heartbeat run not found" });
      return;
    }
    await assertCompanyAccess(db, req, run.companyId);

    const offset = Number(req.query.offset ?? 0);
    const limitBytes = Number(req.query.limitBytes ?? 256000);
    const result = await heartbeat.readLog(runId, {
      offset: Number.isFinite(offset) ? offset : 0,
      limitBytes: Number.isFinite(limitBytes) ? limitBytes : 256000,
    });

    res.json(result);
  });

  router.get("/issues/:issueId/live-runs", async (req, res) => {
    const rawId = req.params.issueId as string;
    const issueSvc = issueService(db);
    const isIdentifier = /^[A-Z]+-\d+$/i.test(rawId);
    const issue = isIdentifier
      ? await issueSvc.getByIdentifier(rawId, accessibleCompanyIdsForActor(req.actor))
      : await issueSvc.getById(rawId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    await assertCompanyAccess(db, req, issue.companyId);

    // Task 5.5: heartbeat live rows for this issue UNION crew (internal_agent)
    // live rows for the same issue (related_entity_id = issue.id), so the card's
    // "Live" pill reflects a crew agent working it — not just heartbeat runs.
    const liveRuns = await liveRunsForIssue(db, issue.companyId, issue.id);
    res.json(liveRuns);
  });

  router.get("/issues/:issueId/active-run", async (req, res) => {
    const rawId = req.params.issueId as string;
    const issueSvc = issueService(db);
    const isIdentifier = /^[A-Z]+-\d+$/i.test(rawId);
    const issue = isIdentifier
      ? await issueSvc.getByIdentifier(rawId, accessibleCompanyIdsForActor(req.actor))
      : await issueSvc.getById(rawId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    await assertCompanyAccess(db, req, issue.companyId);

    let run = issue.executionRunId ? await heartbeat.getRun(issue.executionRunId) : null;
    if (run && run.status !== "queued" && run.status !== "running") {
      run = null;
    }

    if (!run && issue.assigneeAgentId && issue.status === "in_progress") {
      const candidateRun = await heartbeat.getActiveRunForAgent(issue.assigneeAgentId);
      const candidateContext = asRecord(candidateRun?.contextSnapshot);
      const candidateIssueId = asNonEmptyString(candidateContext?.issueId);
      if (candidateRun && candidateIssueId === issue.id) {
        run = candidateRun;
      }
    }
    if (!run) {
      res.json(null);
      return;
    }

    const agent = await svc.getById(run.agentId);
    if (!agent) {
      res.json(null);
      return;
    }

    res.json({
      ...run,
      agentId: agent.id,
      agentName: agent.name,
      adapterType: agent.adapterType,
    });
  });

  // Temporary admin endpoint — backfill parentType/parentId from reportsTo (T3).
  // Remove after confirming all data migrated.
  router.post("/agents/admin/backfill-parent-fields", async (req, res) => {
    assertCanManageInstanceSettings(req);
    if (tenantIsolationEnforced()) {
      res.status(403).json({ error: "Global agent maintenance is unavailable in multi-tenant deployments" });
      return;
    }
    const count = await svc.backfillParentFields();
    res.json({ ok: true, backfilledCount: count });
  });

  // Temporary admin endpoint — backfill rootless org agents to the founder so
  // every chain tops at a human (W6 human-at-top). Iterates all companies and
  // sums the re-parent counts. Remove after confirming all data migrated.
  router.post("/agents/admin/backfill-human-at-top", async (req, res) => {
    assertCanManageInstanceSettings(req);
    if (tenantIsolationEnforced()) {
      res.status(403).json({ error: "Global agent maintenance is unavailable in multi-tenant deployments" });
      return;
    }
    const rows = await db.select({ id: companies.id }).from(companies);
    let reparented = 0;
    for (const c of rows) {
      reparented += await svc.backfillHumanAtTop(c.id);
    }
    res.json({ reparented });
  });

  // ── Agent Instructions Bundle routes ──
  //
  // D22 (Decision #114): a route that can change what an agent's instructions
  // SAY stamps `instructionsCustomized: true`. That flag is what stops
  // `marketplace-install/crew-updater.ts` from full-replacing the bundle on the
  // next catalog bump — see that module's docblock.
  //
  // ⚠️ **The four routes below are NOT the complete set.** There are FIVE
  // instruction-changing write paths, and the fifth is not in this section:
  //
  //   1. `PATCH  /agents/:id/instructions-bundle`       (below)
  //   2. `PUT    /agents/:id/instructions-bundle/file`  (below)
  //   3. `DELETE /agents/:id/instructions-bundle/file`  (below)
  //   4. `PATCH  /agents/:id/instructions-path`         (above)
  //   5. `PATCH  /agents/:id` — the GENERIC agent patch, whose free-form
  //      `adapterConfig` carries `promptTemplate`, `bootstrapPromptTemplate`
  //      and the bundle path keys. This one is easy to miss precisely because
  //      it does not look like an instructions route; it is the shipped Config
  //      tab's Prompt Template editor. Gated by
  //      `INSTRUCTION_BEARING_ADAPTER_CONFIG_KEYS`.
  //
  // Routes 1-3 write to DISK before they know the adapterConfig to persist, so
  // they stamp with a separate pre-write (`stampInstructionsCustomized`) rather
  // than folding the flag into the main update. 4 and 5 mutate only
  // `adapterConfig`, so a single atomic write carries both.
  //
  // ⚠️ This flag records edits **that went through this API**. It does NOT
  // detect a file edited directly on disk (the bundle root is a real directory
  // under the founder's home), nor an edit made before the column existed —
  // those rows stay NULL, which the updater treats as customized. It is also
  // deliberately one-way: it is set on a no-op write (content identical to the
  // catalog's), because a false "customized" costs a notification while a false
  // "untouched" costs the founder's work. Nothing here ever clears it; only a
  // successful catalog replacement does.
  //
  // `instructionsCustomized` is absent from `updateAgentSchema`, and `validate`
  // re-assigns `req.body` from the parsed result, so a client cannot clear the
  // flag through `PATCH /agents/:id`.

  router.get("/agents/:id/instructions-bundle", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanReadConfigurations(req, existing.companyId);
    res.json(await instructions.getBundle(existing));
  });

  router.patch("/agents/:id/instructions-bundle", validate(updateAgentInstructionsBundleSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanManageInstructionsPath(req, existing);
    // D22/F3: stamp BEFORE `updateBundle` touches disk. See stampInstructionsCustomized.
    if (!(await stampInstructionsCustomized(id))) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    const actor = getActorInfo(req);
    const { bundle, adapterConfig } = await instructions.updateBundle(existing, req.body);
    const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
      existing.companyId,
      adapterConfig,
      { strictMode: strictSecretsMode },
    );
    await svc.update(
      id,
      { adapterConfig: normalizedAdapterConfig },
      {
        recordRevision: {
          createdByAgentId: actor.agentId,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null,
          source: "instructions_bundle_patch",
        },
      },
    );
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.instructions_bundle_updated",
      entityType: "agent",
      entityId: existing.id,
      details: {
        mode: bundle.mode,
        rootPath: bundle.rootPath,
        entryFile: bundle.entryFile,
        clearLegacyPromptTemplate: req.body.clearLegacyPromptTemplate === true,
      },
    });
    res.json(bundle);
  });

  router.get("/agents/:id/instructions-bundle/file", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanReadConfigurations(req, existing.companyId);
    const relativePath = typeof req.query.path === "string" ? req.query.path : "";
    if (!relativePath.trim()) {
      res.status(422).json({ error: "Query parameter 'path' is required" });
      return;
    }
    res.json(await instructions.readFile(existing, relativePath));
  });

  router.put("/agents/:id/instructions-bundle/file", validate(upsertAgentInstructionsFileSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanManageInstructionsPath(req, existing);
    // D22/F3: stamp BEFORE the founder's bytes land on disk.
    if (!(await stampInstructionsCustomized(id))) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    const actor = getActorInfo(req);
    const result = await instructions.writeFile(existing, req.body.path, req.body.content, {
      clearLegacyPromptTemplate: req.body.clearLegacyPromptTemplate,
    });
    const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
      existing.companyId,
      result.adapterConfig,
      { strictMode: strictSecretsMode },
    );
    await svc.update(
      id,
      { adapterConfig: normalizedAdapterConfig },
      {
        recordRevision: {
          createdByAgentId: actor.agentId,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null,
          source: "instructions_bundle_file_put",
        },
      },
    );
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.instructions_file_updated",
      entityType: "agent",
      entityId: existing.id,
      details: {
        path: result.file.path,
        size: result.file.size,
        clearLegacyPromptTemplate: req.body.clearLegacyPromptTemplate === true,
      },
    });
    res.json(result.file);
  });

  router.delete("/agents/:id/instructions-bundle/file", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanManageInstructionsPath(req, existing);
    const relativePath = typeof req.query.path === "string" ? req.query.path : "";
    if (!relativePath.trim()) {
      res.status(422).json({ error: "Query parameter 'path' is required" });
      return;
    }
    // D22/F3: stamp BEFORE the file is removed from disk.
    if (!(await stampInstructionsCustomized(id))) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    const actor = getActorInfo(req);
    const result = await instructions.deleteFile(existing, relativePath);
    const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
      existing.companyId,
      result.adapterConfig,
      { strictMode: strictSecretsMode },
    );
    await svc.update(
      id,
      { adapterConfig: normalizedAdapterConfig },
      {
        recordRevision: {
          createdByAgentId: actor.agentId,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null,
          source: "instructions_bundle_file_delete",
        },
      },
    );
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.instructions_file_deleted",
      entityType: "agent",
      entityId: existing.id,
      details: { path: relativePath },
    });
    res.json(result.bundle);
  });

  return router;
}
