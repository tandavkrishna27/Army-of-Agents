import { and, eq, inArray, isNotNull, ne, or } from "drizzle-orm";
import { Router, type Request, type Response } from "express";
import type { Db } from "@armyofagents/db";
import { projects, projectWorkspaces, workspaceRuntimeServices } from "@armyofagents/db";
import {
  updateExecutionWorkspaceSchema,
  workspaceRuntimeControlTargetSchema,
  type WorkspaceRuntimeControlTarget,
} from "@armyofagents/shared";
import { validate } from "../middleware/validate.js";
import { executionWorkspaceService, instanceSettingsService, logActivity, workspaceOperationService } from "../services/index.js";
import { parseProjectExecutionWorkspacePolicy } from "../services/execution-workspace-policy.js";
import {
  mergeExecutionWorkspaceConfig,
  readExecutionWorkspaceConfig,
  toWorkspaceRuntimeService,
} from "../services/execution-workspaces.js";
import { readProjectWorkspaceRuntimeConfig } from "../services/project-workspace-runtime-config.js";
import {
  areRuntimeServicesTrackedLocally,
  buildWorkspaceRuntimeDesiredStatePatch,
  cleanupExecutionWorkspaceArtifacts,
  ensurePersistedExecutionWorkspaceAvailable,
  listConfiguredRuntimeServiceEntries,
  refreshPersistedRuntimeServiceRows,
  resolveConfiguredRuntimeServiceIndexForRow,
  RuntimeServiceActivationFenceError,
  startRuntimeServicesForWorkspaceControl,
  stopRuntimeServicesForExecutionWorkspace,
  withRuntimeControlLocks,
} from "../services/workspace-runtime.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { assertCloudWorkspaceCommandConfigurationAllowed } from "./projects.js";
import {
  assertCanConfigureWorkspaceShellCommands,
  assertCanControlWorkspace,
  workspaceConfigPatchHasShellCommands,
} from "../services/workspace-authz.js";

export function executionWorkspaceRoutes(db: Db) {
  const router = Router();
  const svc = executionWorkspaceService(db);
  const workspaceOperationsSvc = workspaceOperationService(db);
  const instanceSettings = instanceSettingsService(db);

  const loadPidBearingLocalRuntimeRows = async (workspace: {
    id: string;
    companyId: string;
    mode: string;
    projectWorkspaceId: string | null;
    config?: { workspaceRuntime?: Record<string, unknown> | null } | null;
  }, options: { includeInheritedProjectRuntime?: boolean } = {}) => {
    const inheritsProjectRuntime =
      options.includeInheritedProjectRuntime !== false &&
      workspace.mode === "shared_workspace" &&
      Boolean(workspace.projectWorkspaceId) &&
      !workspace.config?.workspaceRuntime;
    const scope = inheritsProjectRuntime
      ? and(
          eq(workspaceRuntimeServices.projectWorkspaceId, workspace.projectWorkspaceId!),
          eq(workspaceRuntimeServices.scopeType, "project_workspace"),
        )
      : workspace.mode === "shared_workspace" && options.includeInheritedProjectRuntime === false
        ? and(
            eq(workspaceRuntimeServices.executionWorkspaceId, workspace.id),
            ne(workspaceRuntimeServices.scopeType, "project_workspace"),
          )
        : eq(workspaceRuntimeServices.executionWorkspaceId, workspace.id);
    return await db
      .select({
        id: workspaceRuntimeServices.id,
        serviceName: workspaceRuntimeServices.serviceName,
        command: workspaceRuntimeServices.command,
        cwd: workspaceRuntimeServices.cwd,
      })
      .from(workspaceRuntimeServices)
      .where(and(
        eq(workspaceRuntimeServices.companyId, workspace.companyId),
        scope,
        eq(workspaceRuntimeServices.provider, "local_process"),
        or(
          inArray(workspaceRuntimeServices.status, ["starting", "running"]),
          isNotNull(workspaceRuntimeServices.providerRef),
        ),
      ));
  };

  async function assertIsolatedWorkspacesEnabled(res: Response): Promise<boolean> {
    const experimental = await instanceSettings.getExperimental();
    if (!experimental.enableIsolatedWorkspaces) {
      res.status(404).json({ error: "Execution workspaces are not enabled" });
      return false;
    }
    return true;
  }

  router.get("/companies/:companyId/execution-workspaces", async (req, res) => {
    if (!(await assertIsolatedWorkspacesEnabled(res))) return;
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const filters = {
      projectId: req.query.projectId as string | undefined,
      projectWorkspaceId: req.query.projectWorkspaceId as string | undefined,
      issueId: req.query.issueId as string | undefined,
      status: req.query.status as string | undefined,
      reuseEligible: req.query.reuseEligible === "true",
    };
    if (req.query.summary === "true") {
      const summaries = await svc.listSummaries(companyId, filters);
      res.json(summaries);
      return;
    }
    const workspaces = await svc.list(companyId, filters);
    res.json(workspaces);
  });

  router.get("/execution-workspaces/:id", async (req, res) => {
    if (!(await assertIsolatedWorkspacesEnabled(res))) return;
    const id = req.params.id as string;
    const workspace = await svc.getById(id);
    if (!workspace) {
      res.status(404).json({ error: "Execution workspace not found" });
      return;
    }
    await assertCompanyAccess(db, req, workspace.companyId);
    res.json(workspace);
  });

  router.patch("/execution-workspaces/:id", validate(updateExecutionWorkspaceSchema), async (req, res) => {
    if (!(await assertIsolatedWorkspacesEnabled(res))) return;
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Execution workspace not found" });
      return;
    }
    await assertCompanyAccess(db, req, existing.companyId);
    await assertCanControlWorkspace(db, req, {
      companyId: existing.companyId,
      projectId: existing.projectId ?? null,
    });
    const { config: configPatch, ...restBody } = req.body as Record<string, unknown>;
    if (workspaceConfigPatchHasShellCommands(configPatch)) {
      await assertCanConfigureWorkspaceShellCommands(db, req, {
        companyId: existing.companyId,
        projectId: existing.projectId ?? null,
      });
      assertCloudWorkspaceCommandConfigurationAllowed();
    }
    const patch: Record<string, unknown> = { ...restBody };
    if (configPatch !== undefined) {
      patch.metadata = mergeExecutionWorkspaceConfig(
        existing.metadata,
        configPatch as Record<string, unknown>,
      );
    }
    let workspace = existing;
    let cleanupWarnings: string[] = [];

    if (req.body.status === "archived" && existing.status !== "archived") {
      await withRuntimeControlLocks([
        `execution:${existing.id}`,
        existing.projectWorkspaceId ? `project:${existing.projectWorkspaceId}` : null,
      ], async () => {
      const readiness = await svc.getCloseReadiness(id);
      if (readiness && readiness.state === "blocked") {
        res.status(409).json({
          error:
            readiness.blockingReasons[0] ?? "Workspace cannot be archived",
          blockingReasons: readiness.blockingReasons,
        });
        return;
      }

      const localServiceIds = (await loadPidBearingLocalRuntimeRows(existing, {
        // Archiving a shared session must preserve inherited project runtime
        // infrastructure; only execution-linked processes belong to the session.
        includeInheritedProjectRuntime: false,
      })).map((row) => row.id);
      if (!areRuntimeServicesTrackedLocally(localServiceIds)) {
        res.status(409).json({
          error: "Workspace has runtime services owned by another or unavailable runtime host",
        });
        return;
      }

      const closedAt = new Date();
      const archivedWorkspace = await svc.archiveIfVersion({
        id,
        companyId: existing.companyId,
        expectedUpdatedAt: existing.updatedAt,
        patch: {
          ...patch,
          closedAt,
          cleanupReason: null,
        },
        detachLinkedIssues: existing.mode === "shared_workspace",
      });
      if (!archivedWorkspace) {
        res.status(409).json({ error: "Execution workspace changed before it could be archived" });
        return;
      }
      workspace = archivedWorkspace;

      try {
        await stopRuntimeServicesForExecutionWorkspace({
          db,
          executionWorkspaceId: existing.id,
          workspaceCwd: existing.mode === "shared_workspace" ? null : existing.cwd,
          preserveProjectWorkspaceServices: existing.mode === "shared_workspace",
        });
        const projectWorkspace = existing.projectWorkspaceId
          ? await db
              .select({
                cwd: projectWorkspaces.cwd,
                cleanupCommand: projectWorkspaces.cleanupCommand,
              })
              .from(projectWorkspaces)
              .where(
                and(
                  eq(projectWorkspaces.id, existing.projectWorkspaceId),
                  eq(projectWorkspaces.companyId, existing.companyId),
                ),
              )
              .then((rows) => rows[0] ?? null)
          : null;
        const projectPolicy = existing.projectId
          ? await db
              .select({
                executionWorkspacePolicy: projects.executionWorkspacePolicy,
              })
              .from(projects)
              .where(and(eq(projects.id, existing.projectId), eq(projects.companyId, existing.companyId)))
              .then((rows) => parseProjectExecutionWorkspacePolicy(rows[0]?.executionWorkspacePolicy))
          : null;
        const cleanupResult = await cleanupExecutionWorkspaceArtifacts({
          workspace: existing,
          projectWorkspace,
          cleanupCommand: existing.config?.cleanupCommand ?? null,
          teardownCommand: existing.config?.teardownCommand ?? projectPolicy?.workspaceStrategy?.teardownCommand ?? null,
          recorder: workspaceOperationsSvc.createRecorder({
            companyId: existing.companyId,
            executionWorkspaceId: existing.id,
          }),
        });
        cleanupWarnings = cleanupResult.warnings;
        const cleanupPatch: Record<string, unknown> = {
          closedAt,
          cleanupReason: cleanupWarnings.length > 0 ? cleanupWarnings.join(" | ") : null,
        };
        if (!cleanupResult.cleaned) {
          cleanupPatch.status = "cleanup_failed";
        }
        if (cleanupResult.warnings.length > 0 || !cleanupResult.cleaned) {
          workspace = (await svc.update(id, cleanupPatch)) ?? workspace;
        }
      } catch (error) {
        const failureReason = error instanceof Error ? error.message : String(error);
        workspace =
          (await svc.update(id, {
            status: "cleanup_failed",
            closedAt,
            cleanupReason: failureReason,
          })) ?? workspace;
        res.status(500).json({
          error: `Failed to archive execution workspace: ${failureReason}`,
        });
        return;
      }
      });
      if (res.headersSent) return;
    } else {
      const updatedWorkspace = await svc.updateIfVersion(id, existing.updatedAt, patch);
      if (!updatedWorkspace) {
        res.status(409).json({ error: "Execution workspace changed before the update could be committed" });
        return;
      }
      workspace = updatedWorkspace;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "execution_workspace.updated",
      entityType: "execution_workspace",
      entityId: workspace.id,
      details: {
        changedKeys: Object.keys(req.body).sort(),
        ...(cleanupWarnings.length > 0 ? { cleanupWarnings } : {}),
      },
    });
    res.json(workspace);
  });

  router.get("/execution-workspaces/:id/runtime-services", async (req, res) => {
    if (!(await assertIsolatedWorkspacesEnabled(res))) return;
    const id = req.params.id as string;
    const workspace = await svc.getById(id);
    if (!workspace) {
      res.status(404).json({ error: "Execution workspace not found" });
      return;
    }
    await assertCompanyAccess(db, req, workspace.companyId);
    const services = await db
      .select()
      .from(workspaceRuntimeServices)
      .where(
        and(
          eq(workspaceRuntimeServices.companyId, workspace.companyId),
          eq(workspaceRuntimeServices.executionWorkspaceId, id),
        ),
      );
    const refreshedServices = await refreshPersistedRuntimeServiceRows({
      db,
      rows: services,
    });
    res.json(refreshedServices.map(toWorkspaceRuntimeService));
  });

  router.get("/execution-workspaces/:id/close-readiness", async (req, res) => {
    if (!(await assertIsolatedWorkspacesEnabled(res))) return;
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Execution workspace not found" });
      return;
    }
    await assertCompanyAccess(db, req, existing.companyId);
    const readiness = await svc.getCloseReadiness(id);
    if (!readiness) {
      res.status(404).json({ error: "Execution workspace not found" });
      return;
    }
    res.json(readiness);
  });

  router.get("/execution-workspaces/:id/workspace-operations", async (req, res) => {
    if (!(await assertIsolatedWorkspacesEnabled(res))) return;
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Execution workspace not found" });
      return;
    }
    await assertCompanyAccess(db, req, existing.companyId);

    const rawLimit = Number(req.query.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 100;
    const operations = await workspaceOperationsSvc.listForExecutionWorkspace(id, { limit });
    res.json(operations);
  });

  async function handleExecutionWorkspaceRuntimeCommand(req: Request, res: Response) {
    if (!(await assertIsolatedWorkspacesEnabled(res))) return;
    const id = req.params.id as string;
    const action = String(req.params.action ?? "").trim().toLowerCase();
    if (action !== "start" && action !== "stop" && action !== "restart" && action !== "run") {
      res.status(400).json({ error: "Invalid action" });
      return;
    }

    const authorizedWorkspace = await svc.getById(id);
    if (!authorizedWorkspace) {
      res.status(404).json({ error: "Execution workspace not found" });
      return;
    }
    await assertCompanyAccess(db, req, authorizedWorkspace.companyId);
    await assertCanControlWorkspace(db, req, {
      companyId: authorizedWorkspace.companyId,
      projectId: authorizedWorkspace.projectId ?? null,
    });
    await withRuntimeControlLocks([
      `execution:${authorizedWorkspace.id}`,
      authorizedWorkspace.projectWorkspaceId ? `project:${authorizedWorkspace.projectWorkspaceId}` : null,
    ], async () => {
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Execution workspace not found" });
      return;
    }
    await assertCompanyAccess(db, req, existing.companyId);
    await assertCanControlWorkspace(db, req, {
      companyId: existing.companyId,
      projectId: existing.projectId ?? null,
    });
    if (action !== "stop" && (existing.status === "archived" || existing.status === "cleanup_failed")) {
      res.status(409).json({ error: `Execution workspace is ${existing.status} and cannot be activated` });
      return;
    }

    const workspaceCwd = existing.cwd;
    if (!workspaceCwd) {
      res.status(422).json({ error: "Execution workspace needs a local path before AoA can run workspace commands" });
      return;
    }

    const projectWorkspace = existing.projectWorkspaceId
      ? await db
          .select({
            id: projectWorkspaces.id,
            cwd: projectWorkspaces.cwd,
            repoUrl: projectWorkspaces.repoUrl,
            repoRef: projectWorkspaces.repoRef,
            defaultRef: projectWorkspaces.defaultRef,
            metadata: projectWorkspaces.metadata,
            updatedAt: projectWorkspaces.updatedAt,
          })
          .from(projectWorkspaces)
          .where(
            and(
              eq(projectWorkspaces.id, existing.projectWorkspaceId),
              eq(projectWorkspaces.companyId, existing.companyId),
            ),
          )
          .then((rows) => rows[0] ?? null)
      : null;

    const projectWorkspaceRuntime = readProjectWorkspaceRuntimeConfig(
      (projectWorkspace?.metadata as Record<string, unknown> | null) ?? null,
    )?.workspaceRuntime ?? null;

    const effectiveRuntimeConfig = existing.config?.workspaceRuntime ?? projectWorkspaceRuntime ?? null;
    const effectiveRuntimeServices = await svc.loadEffectiveRuntimeServicesByExecutionWorkspace(existing.id);

    let target: WorkspaceRuntimeControlTarget;
    try {
      target = workspaceRuntimeControlTargetSchema.parse(req.body ?? {});
    } catch (err) {
      res.status(400).json({ error: "Invalid control target", details: err instanceof Error ? err.message : String(err) });
      return;
    }

    const configuredServices = effectiveRuntimeConfig
      ? listConfiguredRuntimeServiceEntries({ workspaceRuntime: effectiveRuntimeConfig })
      : [];

    if (
      target.runtimeServiceId
      && !effectiveRuntimeServices.some((service) => service.id === target.runtimeServiceId)
    ) {
      res.status(404).json({ error: "Runtime service not found for this execution workspace" });
      return;
    }

    const selectedRuntimeServiceId = target.runtimeServiceId ?? null;
    const selectedServiceIndex = target.serviceIndex ?? null;
    const selectedRuntimeService = selectedRuntimeServiceId
      ? effectiveRuntimeServices.find((service) => service.id === selectedRuntimeServiceId) ?? null
      : null;
    const resolvedServiceIndex =
      selectedServiceIndex ??
      (selectedRuntimeService
        ? resolveConfiguredRuntimeServiceIndexForRow({
            services: configuredServices,
            row: selectedRuntimeService,
            workspaceCwd,
          })
        : null);
    const runtimeServiceForSelectedIndex = selectedRuntimeServiceId || selectedServiceIndex === null
      ? selectedRuntimeService
      : effectiveRuntimeServices.find((service) =>
          resolveConfiguredRuntimeServiceIndexForRow({
            services: configuredServices,
            row: service,
            workspaceCwd,
          }) === selectedServiceIndex,
        ) ?? null;
    let runtimeServiceIdsToStop: string[] | null = null;
    if (
      selectedServiceIndex !== null
      && (selectedServiceIndex < 0 || selectedServiceIndex >= configuredServices.length)
    ) {
      res.status(422).json({ error: "Selected runtime service is not defined in this execution workspace runtime config" });
      return;
    }

    if (
      selectedRuntimeServiceId
      && (action === "start" || action === "restart")
      && resolvedServiceIndex === null
    ) {
      res.status(422).json({ error: "Selected runtime service cannot be mapped to a configured service" });
      return;
    }

    if ((action === "start" || action === "restart") && !effectiveRuntimeConfig) {
      res.status(422).json({ error: "Execution workspace has no workspace command configuration or inherited project workspace default" });
      return;
    }

    if (action === "run") {
      res.status(422).json({ error: "Workspace job execution requires a workspaceCommandId (Task 9 — workspace command definitions)" });
      return;
    }

    const actor = getActorInfo(req);
    const actorAgent = {
      id: actor.agentId ?? null,
      name: actor.actorType === "user" ? "Board" : "Agent",
      companyId: existing.companyId,
    };
    const recorder = workspaceOperationsSvc.createRecorder({
      companyId: existing.companyId,
      executionWorkspaceId: existing.id,
    });

    let runtimeServiceCount = effectiveRuntimeServices.length;
    const stdout: string[] = [];
    const stderr: string[] = [];
    const onLog = async (stream: "stdout" | "stderr", chunk: string) => {
      if (stream === "stdout") stdout.push(chunk);
      else stderr.push(chunk);
    };
    const currentDesiredState: "running" | "stopped" =
      existing.config?.desiredState
      ?? (effectiveRuntimeServices.some((service) => service.status === "starting" || service.status === "running")
        ? "running"
        : "stopped");
    const nextRuntimeState = action === "stop" && selectedRuntimeServiceId && resolvedServiceIndex === null
      ? {
          desiredState: currentDesiredState,
          serviceStates: existing.config?.serviceStates ?? null,
        }
      : buildWorkspaceRuntimeDesiredStatePatch({
          config: { workspaceRuntime: effectiveRuntimeConfig ?? {} },
          currentDesiredState,
          currentServiceStates: existing.config?.serviceStates ?? null,
          action: action as "start" | "stop" | "restart",
          serviceIndex: resolvedServiceIndex,
        });
    const desiredStateMetadata = mergeExecutionWorkspaceConfig(
      existing.metadata as Record<string, unknown> | null,
      {
        desiredState: nextRuntimeState.desiredState,
        serviceStates: nextRuntimeState.serviceStates,
      },
    );
    let desiredStateCommitted = false;
    let activationExpectedUpdatedAt = existing.updatedAt;

    if (action === "start" || action === "stop" || action === "restart") {
      // Query every PID-bearing row, not the deduplicated presentation model:
      // an old live row must not be hidden by a newer terminal row with the
      // same reuse/identity key.
      const persistedLocalRows = await loadPidBearingLocalRuntimeRows(existing);
      const indexedPersistedRows = persistedLocalRows.map((row) => ({
        row,
        serviceIndex: resolveConfiguredRuntimeServiceIndexForRow({
          services: configuredServices,
          row,
          workspaceCwd,
        }),
      }));
      if (
        (selectedServiceIndex !== null || action === "start" || action === "restart") &&
        indexedPersistedRows.some((entry) => entry.serviceIndex === null)
      ) {
        res.status(409).json({
          error: "PID-bearing runtime rows are ambiguous; select a runtimeServiceId before controlling this service",
        });
        return;
      }
      let scopedPersistedRows = persistedLocalRows;
      if (action !== "start" && action !== "restart") {
        if (resolvedServiceIndex !== null) {
          scopedPersistedRows = indexedPersistedRows
            .filter((entry) => entry.serviceIndex === resolvedServiceIndex)
            .map((entry) => entry.row);
        } else if (selectedRuntimeServiceId) {
          scopedPersistedRows = persistedLocalRows.filter((row) => row.id === selectedRuntimeServiceId);
        }
      }
      const requestedLocalServiceIds = scopedPersistedRows.map((row) => row.id);
      if (!areRuntimeServicesTrackedLocally(requestedLocalServiceIds)) {
        res.status(409).json({
          error: "Runtime service is owned by another or unavailable runtime host",
        });
        return;
      }
      if (selectedRuntimeServiceId || selectedServiceIndex !== null) {
        const selectedLocalRows = resolvedServiceIndex !== null
          ? indexedPersistedRows
              .filter((entry) => entry.serviceIndex === resolvedServiceIndex)
              .map((entry) => entry.row)
          : selectedRuntimeServiceId
            ? persistedLocalRows.filter((row) => row.id === selectedRuntimeServiceId)
            : [];
        runtimeServiceIdsToStop = selectedLocalRows.map((row) => row.id);
        const selectedAdapterService = runtimeServiceForSelectedIndex?.provider === "adapter_managed"
          ? runtimeServiceForSelectedIndex.id
          : null;
        if (selectedAdapterService) runtimeServiceIdsToStop.push(selectedAdapterService);
      } else if (action === "stop" || action === "restart") {
        // Always stop the rows explicitly scoped by the workspace read model.
        // CWD containment can capture sibling/child workspaces and cross scope.
        runtimeServiceIdsToStop = [
          ...requestedLocalServiceIds,
          ...effectiveRuntimeServices
            .filter((service) => service.provider === "adapter_managed")
            .map((service) => service.id),
        ];
      }
    }

    try {
      if (action === "stop" || action === "restart") {
        const stoppedRuntimeState = selectedRuntimeServiceId && resolvedServiceIndex === null
          ? {
              desiredState: currentDesiredState,
              serviceStates: existing.config?.serviceStates ?? null,
            }
          : buildWorkspaceRuntimeDesiredStatePatch({
              config: { workspaceRuntime: effectiveRuntimeConfig ?? {} },
              currentDesiredState,
              currentServiceStates: existing.config?.serviceStates ?? null,
              action: "stop",
              serviceIndex: resolvedServiceIndex,
            });
        const stoppedMetadata = mergeExecutionWorkspaceConfig(
          existing.metadata as Record<string, unknown> | null,
          {
            desiredState: stoppedRuntimeState.desiredState,
            serviceStates: stoppedRuntimeState.serviceStates,
          },
        );
        // Persist the irreversible stop intent first. Any later config update
        // observes/stays based on stopped state; restart promotes it back to
        // running only inside the start batch's atomic commit guard.
        let claimedStop = await svc.updateIfVersion(
          existing.id,
          existing.updatedAt,
          { metadata: stoppedMetadata },
          ["active", "idle", "in_review"],
        );
        if (!claimedStop) {
          const fresh = await svc.getById(existing.id);
          if (fresh && fresh.status !== "archived") {
            claimedStop = await svc.updateIfVersion(
              existing.id,
              fresh.updatedAt,
              { metadata: stoppedMetadata },
              ["active", "idle", "in_review"],
            );
          }
        }
        if (!claimedStop) {
          res.status(409).json({ error: "Execution workspace changed before runtime stop could be committed" });
          return;
        }
        activationExpectedUpdatedAt = claimedStop.updatedAt;
        if (action === "stop") desiredStateCommitted = true;
        // A serviceIndex with no current row is already stopped; restart can
        // proceed directly to starting just that configured service. Never
        // translate a missing indexed row into an unscoped "stop all" call.
        if (runtimeServiceIdsToStop === null || runtimeServiceIdsToStop.length > 0) {
          await stopRuntimeServicesForExecutionWorkspace({
            db,
            executionWorkspaceId: existing.id,
            workspaceCwd,
            runtimeServiceIds: runtimeServiceIdsToStop,
          });
        }
      }

      if (action === "start" || action === "restart") {
        const activationWorkspace = await svc.getById(existing.id);
        if (
          !activationWorkspace ||
          activationWorkspace.status === "archived" ||
          activationWorkspace.status === "cleanup_failed" ||
          String(activationWorkspace.updatedAt) !== String(activationExpectedUpdatedAt)
        ) {
          res.status(409).json({ error: "Execution workspace became unavailable before runtime activation" });
          return;
        }
        const availableWorkspace = await ensurePersistedExecutionWorkspaceAvailable(
          activationWorkspace,
          {
            baseCwd: projectWorkspace?.cwd ?? workspaceCwd,
            source: activationWorkspace.mode === "shared_workspace" ? "project_primary" : "task_session",
            projectId: activationWorkspace.projectId,
            workspaceId: activationWorkspace.projectWorkspaceId,
            repoUrl: activationWorkspace.repoUrl,
            repoRef: activationWorkspace.baseRef,
          },
          recorder,
        );
        if (!availableWorkspace) {
          res.status(422).json({ error: "Execution workspace needs a local path before AoA can manage local runtime services" });
          return;
        }
        let startedServices;
        try {
          startedServices = await startRuntimeServicesForWorkspaceControl({
            db,
            actor: actorAgent,
            issue: existing.sourceIssueId
              ? { id: existing.sourceIssueId, identifier: null, title: existing.name }
              : null,
            workspace: availableWorkspace,
            executionWorkspaceId: existing.id,
            config: { workspaceRuntime: effectiveRuntimeConfig },
            adapterEnv: {},
            onLog,
            serviceIndex: resolvedServiceIndex,
            commitGuard: async () => {
              const persisted = await svc.updateIfVersion(
                existing.id,
                activationWorkspace.updatedAt,
                { metadata: desiredStateMetadata },
                ["active", "idle", "in_review"],
                projectWorkspace
                  ? { id: projectWorkspace.id, expectedUpdatedAt: projectWorkspace.updatedAt }
                  : null,
              );
              desiredStateCommitted = Boolean(persisted);
              return desiredStateCommitted;
            },
          });
        } catch (err) {
          if (!(err instanceof RuntimeServiceActivationFenceError)) throw err;
          if (availableWorkspace.created && err.cleanupArtifactsAllowed) {
            const rollbackCleanup = await cleanupExecutionWorkspaceArtifacts({
              workspace: {
                ...activationWorkspace,
                cwd: availableWorkspace.cwd,
                providerRef: availableWorkspace.worktreePath ?? activationWorkspace.providerRef,
              },
              projectWorkspace: projectWorkspace
                ? { cwd: projectWorkspace.cwd, cleanupCommand: null }
                : null,
              recorder,
            });
            if (!rollbackCleanup.cleaned) {
              await svc.update(existing.id, {
                status: "cleanup_failed",
                cleanupReason: rollbackCleanup.warnings.join(" | ") || "Runtime activation rollback could not remove recreated workspace artifacts",
              });
            }
          }
          res.status(409).json({ error: "Execution workspace became unavailable during runtime activation" });
          return;
        }
        runtimeServiceCount = startedServices.length;
      } else {
        const scopedStop = Boolean(selectedRuntimeServiceId) || selectedServiceIndex !== null;
        runtimeServiceCount = scopedStop
          ? effectiveRuntimeServices.filter((service) =>
              (service.status === "starting" || service.status === "running") &&
              !(runtimeServiceIdsToStop ?? []).includes(service.id),
            ).length
          : 0;
      }

      if (!desiredStateCommitted) {
        const persistedDesiredState = await svc.updateIfVersion(
          existing.id,
          activationExpectedUpdatedAt,
          { metadata: desiredStateMetadata },
          ["active", "idle", "in_review"],
          projectWorkspace
            ? { id: projectWorkspace.id, expectedUpdatedAt: projectWorkspace.updatedAt }
            : null,
        );
        if (!persistedDesiredState) {
          res.status(409).json({ error: "Execution workspace changed before runtime state could be committed" });
          return;
        }
      }
    } catch (err) {
      res.status(500).json({
        error: "Runtime command failed",
        details: err instanceof Error ? err.message : String(err),
        stdout: stdout.join(""),
        stderr: stderr.join(""),
      });
      return;
    }

    const workspace = await svc.getById(id);
    if (!workspace) {
      res.status(404).json({ error: "Execution workspace not found" });
      return;
    }

    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: `execution_workspace.runtime_${action}`,
      entityType: "execution_workspace",
      entityId: existing.id,
      details: {
        runtimeServiceCount,
        runtimeServiceId: selectedRuntimeServiceId,
        serviceIndex: resolvedServiceIndex,
      },
    });

    res.json({
      workspace,
      runtimeServiceCount,
      stdout: stdout.join(""),
      stderr: stderr.join(""),
    });
    });
  }

  router.post("/execution-workspaces/:id/runtime-services/:action", handleExecutionWorkspaceRuntimeCommand);
  router.post("/execution-workspaces/:id/runtime-commands/:action", handleExecutionWorkspaceRuntimeCommand);

  return router;
}
