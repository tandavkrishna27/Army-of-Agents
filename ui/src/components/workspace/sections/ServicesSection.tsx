import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Play, Square, RotateCw, Server, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { executionWorkspacesApi } from "@/api/execution-workspaces";
import type { WorkspaceRuntimeService } from "@/api/execution-workspaces";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { useWorkspacePermissions } from "@/hooks/useWorkspacePermissions";
import type { ExecutionWorkspace } from "@armyofagents/shared";

interface ServicesSectionProps {
  workspace: ExecutionWorkspace;
  onOpenBrowser?: (service: WorkspaceRuntimeService) => void;
}

type ServiceAction = "start" | "stop" | "restart";

function statusDotClass(status: string): string {
  switch (status) {
    case "running":
      return "bg-green-500";
    case "starting":
      return "bg-amber-500 animate-pulse";
    case "failed":
      return "bg-destructive";
    default:
      return "bg-muted-foreground/40";
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case "running":
      return "Running";
    case "starting":
      return "Starting";
    case "failed":
      return "Failed";
    case "stopped":
      return "Stopped";
    default:
      return status;
  }
}

function isPreviewOnlyService(service: WorkspaceRuntimeService): boolean {
  return service.provider === "adapter_managed" && !service.command && !service.providerRef;
}

function canControlService(service: WorkspaceRuntimeService): boolean {
  return service.provider === "local_process";
}

function isUnavailablePreviewService(service: WorkspaceRuntimeService): boolean {
  return isPreviewOnlyService(service) && (service.status !== "running" || service.healthStatus === "unhealthy");
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function StoppedPreviewSummary({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <div
      className="flex min-w-0 items-center gap-2 rounded-md border border-border/60 bg-muted/20 px-2 py-1.5 text-[11px] text-muted-foreground"
      data-testid="service-stopped-preview-summary"
    >
      <Server className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate">
        {plural(count, "stopped preview")} from earlier runs
      </span>
    </div>
  );
}

export function ServicesSection({ workspace, onOpenBrowser }: ServicesSectionProps) {
  const queryClient = useQueryClient();
  const workspacePermissions = useWorkspacePermissions(workspace.companyId, workspace.projectId);
  const [pendingByService, setPendingByService] = useState<Record<string, ServiceAction | null>>({});
  const [errorByService, setErrorByService] = useState<Record<string, string | null>>({});

  const { data: services, isLoading } = useQuery({
    queryKey: queryKeys.executionWorkspaces.runtimeServices(workspace.id),
    queryFn: () => executionWorkspacesApi.runtimeServices(workspace.id),
    refetchInterval: 3000,
    staleTime: 2500,
  });

  // Clear stale errors when a service transitions to "running" (e.g., external
  // fix or successful retry by another client). Without this the error would
  // linger until the user clicks an action on the row.
  useEffect(() => {
    if (!services) return;
    setErrorByService((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const s of services) {
        if (s.status === "running" && next[s.id]) {
          delete next[s.id];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [services]);

  const invalidateAfterAction = () => {
    queryClient.invalidateQueries({
      queryKey: queryKeys.executionWorkspaces.runtimeServices(workspace.id),
    });
    queryClient.invalidateQueries({
      queryKey: queryKeys.executionWorkspaces.detail(workspace.id),
    });
  };

  const controlMutation = useMutation({
    mutationFn: ({ serviceId, action }: { serviceId: string; action: ServiceAction }) =>
      executionWorkspacesApi.controlRuntimeServices(workspace.id, action, {
        runtimeServiceId: serviceId,
      }),
    onSuccess: (_data, { serviceId }) => {
      setPendingByService((prev) => ({ ...prev, [serviceId]: null }));
      invalidateAfterAction();
    },
    onError: (err, { serviceId }) => {
      setPendingByService((prev) => ({ ...prev, [serviceId]: null }));
      const message = err instanceof Error ? err.message : "Action failed";
      setErrorByService((prev) => ({ ...prev, [serviceId]: message }));
    },
  });

  const handleAction = (serviceId: string, action: ServiceAction) => {
    setPendingByService((prev) => ({ ...prev, [serviceId]: action }));
    setErrorByService((prev) => ({ ...prev, [serviceId]: null }));
    controlMutation.mutate({ serviceId, action });
  };

  if (isLoading) {
    return (
      <div className="min-w-0 max-w-full space-y-2 overflow-hidden px-1" data-testid="section-services-body">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  if (!services || services.length === 0) {
    return (
      <div
        className="flex min-w-0 max-w-full items-start gap-2 overflow-hidden px-1 py-2 text-xs"
        data-testid="section-services-body"
      >
        <Server className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 space-y-0.5 overflow-hidden">
          <p className="truncate font-medium text-foreground">No app previews</p>
          <p className="text-[11px] leading-4 text-muted-foreground">
            Agent-created localhost apps will appear here.
          </p>
        </div>
      </div>
    );
  }

  const unavailablePreviewCount = services.filter(isUnavailablePreviewService).length;
  const primaryServices = services.filter((service) => !isUnavailablePreviewService(service));

  if (primaryServices.length === 0) {
    return (
      <div className="min-w-0 max-w-full space-y-2 overflow-hidden px-1" data-testid="section-services-body">
        <div className="flex min-w-0 max-w-full items-start gap-2 overflow-hidden py-2 text-xs">
          <Server className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0 space-y-0.5 overflow-hidden">
            <p className="truncate font-medium text-foreground">No running app previews</p>
            <p className="text-[11px] leading-4 text-muted-foreground">
              New agent-created localhost apps will appear here.
            </p>
          </div>
        </div>
        <StoppedPreviewSummary count={unavailablePreviewCount} />
      </div>
    );
  }

  return (
    <div className="min-w-0 max-w-full space-y-2 overflow-hidden px-1" data-testid="section-services-body">
      {primaryServices.map((service: WorkspaceRuntimeService) => {
        const pendingAction = pendingByService[service.id] ?? null;
        const error = errorByService[service.id] ?? null;
        const isPending = pendingAction !== null;
        const isRunning = service.status === "running";
        const isStarting = service.status === "starting";
        const previewOnly = isPreviewOnlyService(service);
        const unavailablePreview = isUnavailablePreviewService(service);
        const controllable = canControlService(service) && workspacePermissions.canControlRuntimeServices;
        const canOpenPreview = Boolean(service.previewUrl) && !unavailablePreview;

        return (
          <div
            key={service.id}
            className="flex min-w-0 max-w-full flex-col gap-1 overflow-hidden rounded-md border border-border bg-background/40 px-2 py-1.5"
            data-testid={`service-row-${service.id}`}
          >
            <div className="flex min-w-0 items-center gap-2 overflow-hidden">
              <div
                className={cn("h-2 w-2 rounded-full shrink-0", statusDotClass(service.status))}
                aria-label={statusLabel(service.status)}
                title={statusLabel(service.status)}
              />
              <span className="text-xs font-medium text-foreground truncate flex-1 min-w-0">
                {service.serviceName}
              </span>
              {previewOnly && (
                <span className="shrink-0 rounded border border-brand/[0.25] bg-brand/[0.08] px-1.5 py-0.5 text-[10px] font-medium leading-none text-[hsl(15_60%_75%)]">
                  Preview
                </span>
              )}
              {unavailablePreview && (
                <span className="shrink-0 rounded border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground">
                  Unavailable
                </span>
              )}
              {service.port !== null && (
                <span className="text-[10px] text-muted-foreground font-mono shrink-0">
                  :{service.port}
                </span>
              )}
              <div className="flex items-center gap-1 shrink-0 ml-auto">
                {isRunning && (
                  <>
                    {canOpenPreview && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-[11px]"
                        onClick={() => onOpenBrowser?.(service)}
                        title={`Open ${service.serviceName}`}
                        aria-label={`Open ${service.serviceName}`}
                        data-testid={`service-open-${service.id}`}
                      >
                        Open
                      </Button>
                    )}
                    {controllable && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => handleAction(service.id, "stop")}
                        disabled={isPending}
                        title="Stop service"
                        aria-label={`Stop ${service.serviceName}`}
                        data-testid={`service-stop-${service.id}`}
                      >
                        <Square className="h-3 w-3" />
                      </Button>
                    )}
                    {controllable && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => handleAction(service.id, "restart")}
                        disabled={isPending}
                        title="Restart service"
                        aria-label={`Restart ${service.serviceName}`}
                        data-testid={`service-restart-${service.id}`}
                      >
                        <RotateCw className="h-3 w-3" />
                      </Button>
                    )}
                  </>
                )}
                {isStarting && controllable && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => handleAction(service.id, "stop")}
                    disabled
                    title="Stop service (starting…)"
                    aria-label={`Stop ${service.serviceName} (starting)`}
                    data-testid={`service-stop-${service.id}`}
                  >
                    <Square className="h-3 w-3" />
                  </Button>
                )}
                {!isRunning && !isStarting && controllable && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => handleAction(service.id, "start")}
                    disabled={isPending}
                    title="Start service"
                    aria-label={`Start ${service.serviceName}`}
                    data-testid={`service-start-${service.id}`}
                  >
                    <Play className="h-3 w-3" />
                  </Button>
                )}
              </div>
            </div>
            {service.localTargetUrl && (
              <div
                className="flex min-w-0 items-center gap-1 overflow-hidden pl-4 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
                data-testid={`service-local-target-${service.id}`}
              >
                <ExternalLink className="h-3 w-3 shrink-0" />
                <span className="shrink-0">Local to AoA host</span>
                <span className="truncate font-mono">{service.localTargetUrl}</span>
              </div>
            )}
            {error && (
              <div
                className="min-w-0 truncate pl-4 text-[10px] text-destructive"
                data-testid={`service-error-${service.id}`}
              >
                {error}
              </div>
            )}
          </div>
        );
      })}
      <StoppedPreviewSummary count={unavailablePreviewCount} />
    </div>
  );
}
