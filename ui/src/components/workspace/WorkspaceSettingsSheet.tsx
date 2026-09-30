import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Loader2 } from "lucide-react";
import type { ExecutionWorkspace, Issue, WorkspaceOperation } from "@armyofagents/shared";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

import { executionWorkspacesApi } from "../../api/execution-workspaces";
import { issuesApi } from "../../api/issues";
import { ApiError } from "../../api/client";
import { queryKeys } from "../../lib/queryKeys";
import { formatDateTime } from "../../lib/utils";
import { useWorkspacePermissions } from "../../hooks/useWorkspacePermissions";

type WorkspaceFormState = {
  name: string;
  cwd: string;
  repoUrl: string;
  baseRef: string;
  branchName: string;
  providerRef: string;
  provisionCommand: string;
  teardownCommand: string;
  cleanupCommand: string;
};

function readText(value: string | null | undefined) {
  return value ?? "";
}

function normalizeText(value: string) {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function formStateFromWorkspace(workspace: ExecutionWorkspace): WorkspaceFormState {
  return {
    name: workspace.name,
    cwd: readText(workspace.cwd),
    repoUrl: readText(workspace.repoUrl),
    baseRef: readText(workspace.baseRef),
    branchName: readText(workspace.branchName),
    providerRef: readText(workspace.providerRef),
    provisionCommand: readText(workspace.config?.provisionCommand),
    teardownCommand: readText(workspace.config?.teardownCommand),
    cleanupCommand: readText(workspace.config?.cleanupCommand),
  };
}

function buildWorkspacePatch(initialState: WorkspaceFormState, nextState: WorkspaceFormState) {
  const patch: Record<string, unknown> = {};
  const configPatch: Record<string, unknown> = {};

  const maybeAssign = (
    key: keyof Pick<WorkspaceFormState, "name" | "cwd" | "repoUrl" | "baseRef" | "branchName" | "providerRef">,
  ) => {
    if (initialState[key] === nextState[key]) return;
    patch[key] = key === "name" ? (normalizeText(nextState[key]) ?? initialState.name) : normalizeText(nextState[key]);
  };

  maybeAssign("name");
  maybeAssign("cwd");
  maybeAssign("repoUrl");
  maybeAssign("baseRef");
  maybeAssign("branchName");
  maybeAssign("providerRef");

  const maybeAssignConfigText = (key: keyof Pick<WorkspaceFormState, "provisionCommand" | "teardownCommand" | "cleanupCommand">) => {
    if (initialState[key] === nextState[key]) return;
    configPatch[key] = normalizeText(nextState[key]);
  };

  maybeAssignConfigText("provisionCommand");
  maybeAssignConfigText("teardownCommand");
  maybeAssignConfigText("cleanupCommand");

  if (Object.keys(configPatch).length > 0) {
    patch.config = configPatch;
  }

  return patch;
}

function validateForm(form: WorkspaceFormState) {
  const repoUrl = normalizeText(form.repoUrl);
  if (repoUrl) {
    try {
      new URL(repoUrl);
    } catch {
      return "Repo URL must be a valid URL.";
    }
  }

  return null;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="space-y-1.5 block">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        <span className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">{label}</span>
        {hint ? <span className="text-[11px] leading-relaxed text-muted-foreground sm:text-right">{hint}</span> : null}
      </div>
      {children}
    </label>
  );
}

function CopyTextInline({ value, testId }: { value: string; testId?: string }) {
  const [copied, setCopied] = useState(false);
  if (!value) return <Input value="" readOnly disabled data-testid={testId} />;
  return (
    <div className="flex items-center gap-1">
      <Input value={value} readOnly data-testid={testId} className="font-mono text-xs" />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={copied ? "Copied" : "Copy"}
        onClick={() => {
          void navigator.clipboard?.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        }}
      >
        <Copy className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

const OPERATION_STATUS_DOT: Record<WorkspaceOperation["status"], string> = {
  running: "bg-amber-500",
  succeeded: "bg-green-500",
  failed: "bg-red-500",
  skipped: "bg-muted-foreground",
};

const ISSUE_STATUS_TONE: Record<string, string> = {
  done: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  in_review: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
  in_progress: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  blocked: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  cancelled: "bg-muted text-muted-foreground",
  todo: "bg-muted text-muted-foreground",
  backlog: "bg-muted text-muted-foreground",
};

interface Props {
  workspaceId: string;
  companyId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function WorkspaceSettingsSheet({ workspaceId, companyId, open, onOpenChange }: Props) {
  const qc = useQueryClient();

  const workspaceQuery = useQuery({
    queryKey: queryKeys.executionWorkspaces.detail(workspaceId),
    queryFn: () => executionWorkspacesApi.get(workspaceId),
    enabled: open,
  });

  const workspace = workspaceQuery.data ?? null;
  const workspacePermissions = useWorkspacePermissions(companyId, workspace?.projectId);

  const [formState, setFormState] = useState<WorkspaceFormState | null>(null);
  const [initialState, setInitialState] = useState<WorkspaceFormState | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const patchString = useMemo(() => {
    if (!formState || !initialState) return "{}";
    try {
      return JSON.stringify(buildWorkspacePatch(initialState, formState));
    } catch {
      return "{}";
    }
  }, [formState, initialState]);
  const isDirty = patchString !== "{}";

  // Sync query data → local form state, but skip when the user has unsaved
  // edits: a background refetch (window focus, polling, mutation invalidation)
  // must not clobber in-progress changes.
  useEffect(() => {
    if (!workspace) return;
    if (isDirty) return;
    const next = formStateFromWorkspace(workspace);
    setFormState(next);
    setInitialState(next);
    setValidationError(null);
  }, [workspace, isDirty]);

  const operationsQuery = useQuery({
    queryKey: [...queryKeys.executionWorkspaces.detail(workspaceId), "workspace-operations"] as const,
    queryFn: () => executionWorkspacesApi.listWorkspaceOperations(workspaceId, { limit: 50 }),
    enabled: open,
  });

  const issuesQuery = useQuery({
    queryKey: workspace?.projectId
      ? queryKeys.issues.listByProject(companyId, workspace.projectId)
      : (["issues-empty-for-no-project"] as const),
    queryFn: () =>
      workspace?.projectId
        ? issuesApi.list(companyId, { projectId: workspace.projectId })
        : Promise.resolve([] as Issue[]),
    enabled: open && !!workspace?.projectId,
  });

  const linkedIssues = useMemo(
    () => (issuesQuery.data ?? []).filter((issue) => issue.executionWorkspaceId === workspaceId),
    [issuesQuery.data, workspaceId],
  );

  const updateMutation = useMutation({
    mutationFn: (patch: Record<string, unknown>) => executionWorkspacesApi.update(workspaceId, patch),
    onSuccess: (updated) => {
      qc.invalidateQueries({ queryKey: queryKeys.executionWorkspaces.detail(workspaceId) });
      if (updated) {
        const next = formStateFromWorkspace(updated);
        setInitialState(next);
        setFormState(next);
      }
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 403) setForbidden(true);
    },
  });

  const handleSave = () => {
    if (!formState || !initialState) return;
    const validation = validateForm(formState);
    if (validation) {
      setValidationError(validation);
      return;
    }
    try {
      const patch = buildWorkspacePatch(initialState, formState);
      if (Object.keys(patch).length === 0) return;
      setValidationError(null);
      updateMutation.mutate(patch);
    } catch (err) {
      setValidationError(err instanceof Error ? err.message : "Invalid form state.");
    }
  };

  const handleReset = () => {
    if (!initialState) return;
    setFormState(initialState);
    setValidationError(null);
  };

  const cannotEditWorkspace = !workspacePermissions.canEditDepartmentWorkspaceSettings;
  const inputDisabled = forbidden || cannotEditWorkspace || updateMutation.isPending;
  const commandInputDisabled = inputDisabled || !workspacePermissions.canConfigureRuntimeCommands;
  const mutationErrorMessage = updateMutation.error instanceof Error ? updateMutation.error.message : null;
  const showErrorBanner = !forbidden && (validationError || (updateMutation.isError && mutationErrorMessage));

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {open && (
        <SheetContent
          side="right"
          className="w-full sm:max-w-xl overflow-y-auto"
          data-testid="workspace-settings-sheet"
        >
          <SheetHeader>
            <SheetTitle>Workspace settings</SheetTitle>
            <SheetDescription>
              Edit workspace configuration, review recent runtime activity, and see linked tasks.
            </SheetDescription>
          </SheetHeader>

          <div className="px-4 pb-6 space-y-6">
            {workspaceQuery.isLoading && (
              <div
                className="flex items-center gap-2 text-sm text-muted-foreground"
                data-testid="workspace-settings-loading"
              >
                <Loader2 className="h-4 w-4 animate-spin" /> Loading workspace...
              </div>
            )}

            {formState && initialState && workspace && (
              <>
                <section className="space-y-4">
                  <h3 className="text-sm font-semibold">Configuration</h3>

                  {(forbidden || cannotEditWorkspace) && (
                    <div
                      className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200"
                      data-testid="workspace-settings-forbidden-banner"
                    >
                      You don&apos;t have permission to edit workspace configuration. Ask a founder or team lead.
                    </div>
                  )}

                  {showErrorBanner && (
                    <div
                      className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
                      data-testid="workspace-settings-error-banner"
                    >
                      {validationError ?? mutationErrorMessage}
                    </div>
                  )}

                  <Field label="Name">
                    <Input
                      value={formState.name}
                      onChange={(e) => setFormState({ ...formState, name: e.target.value })}
                      disabled={inputDisabled}
                      data-testid="workspace-settings-field-name"
                    />
                  </Field>

                  <Field label="Working directory" hint="Read-only">
                    <CopyTextInline value={formState.cwd} testId="workspace-settings-field-cwd" />
                  </Field>

                  <Field label="Repo URL">
                    <Input
                      value={formState.repoUrl}
                      onChange={(e) => setFormState({ ...formState, repoUrl: e.target.value })}
                      disabled={inputDisabled}
                      data-testid="workspace-settings-field-repoUrl"
                    />
                  </Field>

                  <Field label="Base ref">
                    <Input
                      value={formState.baseRef}
                      onChange={(e) => setFormState({ ...formState, baseRef: e.target.value })}
                      disabled={inputDisabled}
                      data-testid="workspace-settings-field-baseRef"
                    />
                  </Field>

                  <Field label="Branch name">
                    <Input
                      value={formState.branchName}
                      onChange={(e) => setFormState({ ...formState, branchName: e.target.value })}
                      disabled={inputDisabled}
                      data-testid="workspace-settings-field-branchName"
                    />
                  </Field>

                  <Field label="Provider ref">
                    <Input
                      value={formState.providerRef}
                      onChange={(e) => setFormState({ ...formState, providerRef: e.target.value })}
                      disabled={inputDisabled}
                      data-testid="workspace-settings-field-providerRef"
                    />
                  </Field>

                  <Field label="Provision command">
                    <Input
                      value={formState.provisionCommand}
                      onChange={(e) => setFormState({ ...formState, provisionCommand: e.target.value })}
                      disabled={commandInputDisabled}
                      data-testid="workspace-settings-field-provisionCommand"
                    />
                  </Field>

                  <Field label="Teardown command">
                    <Input
                      value={formState.teardownCommand}
                      onChange={(e) => setFormState({ ...formState, teardownCommand: e.target.value })}
                      disabled={commandInputDisabled}
                      data-testid="workspace-settings-field-teardownCommand"
                    />
                  </Field>

                  <Field label="Cleanup command">
                    <Input
                      value={formState.cleanupCommand}
                      onChange={(e) => setFormState({ ...formState, cleanupCommand: e.target.value })}
                      disabled={commandInputDisabled}
                      data-testid="workspace-settings-field-cleanupCommand"
                    />
                  </Field>

                  {!forbidden && !cannotEditWorkspace && (
                    <div className="flex items-center gap-2 pt-1">
                      <Button
                        type="button"
                        onClick={handleSave}
                        disabled={!isDirty || updateMutation.isPending}
                        data-testid="workspace-settings-save"
                      >
                        {updateMutation.isPending ? (
                          <>
                            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> Saving...
                          </>
                        ) : (
                          "Save changes"
                        )}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={handleReset}
                        disabled={!isDirty || updateMutation.isPending}
                        data-testid="workspace-settings-reset"
                      >
                        Reset
                      </Button>
                    </div>
                  )}
                </section>

                <Separator />

                <section className="space-y-3" data-testid="workspace-settings-operations">
                  <h3 className="text-sm font-semibold">Runtime logs</h3>
                  {operationsQuery.isLoading && (
                    <p className="text-xs text-muted-foreground">Loading operations...</p>
                  )}
                  {!operationsQuery.isLoading && (operationsQuery.data?.length ?? 0) === 0 && (
                    <p
                      className="text-xs text-muted-foreground"
                      data-testid="workspace-settings-operations-empty"
                    >
                      No operations recorded yet.
                    </p>
                  )}
                  {!operationsQuery.isLoading && (operationsQuery.data?.length ?? 0) > 0 && (
                    <ul className="space-y-2">
                      {(operationsQuery.data ?? []).map((op) => {
                        const commandShort =
                          op.command && op.command.length > 60 ? `${op.command.slice(0, 60)}...` : op.command;
                        return (
                          <li
                            key={op.id}
                            className="flex items-start gap-3 rounded-md border border-border px-3 py-2 text-xs"
                            data-testid={`workspace-settings-operation-${op.id}`}
                          >
                            <span
                              className={cn("mt-1 inline-block h-2 w-2 rounded-full shrink-0", OPERATION_STATUS_DOT[op.status])}
                              aria-hidden="true"
                            />
                            <div className="min-w-0 flex-1 space-y-1">
                              <div className="flex items-center gap-2">
                                <Badge variant="secondary" className="text-[10px]">
                                  {op.phase}
                                </Badge>
                                <span className="text-muted-foreground">{formatDateTime(op.startedAt)}</span>
                                {op.exitCode !== null && (
                                  <span className="text-muted-foreground">exit {op.exitCode}</span>
                                )}
                              </div>
                              {commandShort && (
                                <code className="block font-mono text-[11px] text-muted-foreground break-all">
                                  {commandShort}
                                </code>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>

                <Separator />

                <section className="space-y-3" data-testid="workspace-settings-linked-issues">
                  <h3 className="text-sm font-semibold">Linked tasks</h3>
                  {issuesQuery.isLoading && workspace.projectId && (
                    <p className="text-xs text-muted-foreground">Loading tasks...</p>
                  )}
                  {(!workspace.projectId || linkedIssues.length === 0) && !issuesQuery.isLoading && (
                    <p
                      className="text-xs text-muted-foreground"
                      data-testid="workspace-settings-linked-issues-empty"
                    >
                      No tasks linked to this workspace.
                    </p>
                  )}
                  {linkedIssues.length > 0 && (
                    <ul className="space-y-1">
                      {linkedIssues.map((issue) => {
                        const tone = ISSUE_STATUS_TONE[issue.status] ?? "bg-muted text-muted-foreground";
                        return (
                          <li
                            key={issue.id}
                            className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs"
                            data-testid={`workspace-settings-linked-issue-${issue.id}`}
                          >
                            {issue.identifier && (
                              <Badge variant="outline" className="font-mono text-[10px]">
                                {issue.identifier}
                              </Badge>
                            )}
                            <span className="flex-1 truncate">{issue.title}</span>
                            <span
                              className={cn(
                                "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium capitalize",
                                tone,
                              )}
                            >
                              {issue.status.replace(/_/g, " ")}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>
              </>
            )}
          </div>
        </SheetContent>
      )}
    </Sheet>
  );
}
