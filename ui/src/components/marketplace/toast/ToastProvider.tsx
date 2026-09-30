import { createContext, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";
import { useOperationStatus } from "@/hooks/useOperationStatus";
import { useToast, type ToastTone } from "@/context/ToastContext";

export type InstallToastStatus = "installing" | "success" | "failure" | "blocked";

export interface InstallToastInput {
  status: InstallToastStatus;
  message: string;
  detail?: string;
  actionLabel?: string;
  actionTo?: string;
}

export interface InstallToastOperation {
  toastId: string;
  companyId: string;
  operationId: string;
  itemName: string;
  successMessage?: string;
  requestedMessage?: string;
  failureMessage?: string;
  invalidate?: "plugins" | "companySkills";
  startedAfter?: Date;
}

interface InstallToastContextValue {
  show: (input: InstallToastInput) => string;
  update: (id: string, patch: Partial<InstallToastInput>) => void;
  trackOperation: (operation: InstallToastOperation) => void;
  dismiss: () => void;
}

export const InstallToastContext = createContext<InstallToastContextValue | null>(null);

function statusToTone(status: InstallToastStatus): ToastTone {
  if (status === "installing") return "loading";
  if (status === "success") return "success";
  if (status === "blocked") return "info";
  return "error";
}

function toAction(input: { actionLabel?: string; actionTo?: string }) {
  return input.actionLabel && input.actionTo
    ? { label: input.actionLabel, href: input.actionTo }
    : undefined;
}

/**
 * One tracker per active operation. Calling useOperationStatus inside a dedicated
 * child (keyed by toastId) lets N concurrent installs each poll and resolve their
 * OWN sticky loading toast. A single shared poll could only ever track one
 * operation, leaving the others' loading toasts spinning forever.
 */
function OperationTracker({
  operation,
  onResolve,
}: {
  operation: InstallToastOperation;
  onResolve: (operation: InstallToastOperation, patch: Partial<InstallToastInput>) => void;
}) {
  const { data } = useOperationStatus({
    companyId: operation.companyId,
    operationId: operation.operationId,
    startedAfter: operation.startedAfter,
  });
  const resolvedRef = useRef(false);

  useEffect(() => {
    if (!data || resolvedRef.current) return;
    if (data.status === "success") {
      resolvedRef.current = true;
      onResolve(operation, {
        status: "success",
        message: operation.successMessage ?? `Installed ${operation.itemName}`,
      });
    } else if (data.status === "requested") {
      resolvedRef.current = true;
      onResolve(operation, {
        status: "success",
        message:
          operation.requestedMessage ??
          `Request submitted - a founder will review ${operation.itemName}`,
      });
    } else if (
      data.status === "failure" &&
      data.errorCode === "PLUGIN_WORKER_BLOCKED_IN_CLOUD"
    ) {
      resolvedRef.current = true;
      onResolve(operation, {
        status: "blocked",
        message: `${operation.itemName} is blocked on AoA Cloud`,
        detail:
          "The plugin was not installed because executable manifests and workers require isolation. Self-hosting is the current recovery path.",
        actionLabel: "Read policy",
        actionTo: data.errorDocs ?? "/docs/guides/cloud-plugin-execution",
      });
    } else if (data.status === "failure") {
      resolvedRef.current = true;
      onResolve(operation, {
        status: "failure",
        message: operation.failureMessage ?? `Failed to install ${operation.itemName}`,
        detail: data.errorMessage ?? "Unknown error",
      });
    }
  }, [data, onResolve, operation]);

  return null;
}

export function InstallToastProvider({ children }: { children: ReactNode }) {
  const { pushToast, updateToast, dismissToast } = useToast();
  const [operations, setOperations] = useState<InstallToastOperation[]>([]);
  const lastIdRef = useRef<string | null>(null);
  const queryClient = useQueryClient();

  const show = useCallback(
    (input: InstallToastInput) => {
      const id =
        pushToast({
          tone: statusToTone(input.status),
          title: input.message,
          body: input.detail,
          action: toAction(input),
        }) ?? "";
      lastIdRef.current = id;
      return id;
    },
    [pushToast],
  );

  const update = useCallback(
    (id: string, patch: Partial<InstallToastInput>) => {
      updateToast(id, {
        ...(patch.status ? { tone: statusToTone(patch.status) } : {}),
        ...(patch.message !== undefined ? { title: patch.message } : {}),
        ...(patch.detail !== undefined ? { body: patch.detail } : {}),
        ...(patch.actionLabel && patch.actionTo ? { action: toAction(patch) } : {}),
      });
    },
    [updateToast],
  );

  const trackOperation = useCallback((operation: InstallToastOperation) => {
    setOperations((prev) => [
      ...prev.filter((o) => o.toastId !== operation.toastId),
      operation,
    ]);
  }, []);

  // Dismisses the most-recently shown install toast (matches the old single-toast
  // dismiss intent; each toast also carries its own close button).
  const dismiss = useCallback(() => {
    if (lastIdRef.current) dismissToast(lastIdRef.current);
  }, [dismissToast]);

  const handleResolve = useCallback(
    (operation: InstallToastOperation, patch: Partial<InstallToastInput>) => {
      update(operation.toastId, patch);
      if (operation.invalidate === "plugins") {
        void queryClient.invalidateQueries({ queryKey: queryKeys.plugins.all });
      } else if (operation.invalidate === "companySkills") {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.companySkills.list(operation.companyId),
        });
      }
      setOperations((prev) => prev.filter((o) => o.toastId !== operation.toastId));
    },
    [queryClient, update],
  );

  return (
    <InstallToastContext.Provider value={{ show, update, trackOperation, dismiss }}>
      {children}
      {operations.map((op) => (
        <OperationTracker key={op.toastId} operation={op} onResolve={handleResolve} />
      ))}
    </InstallToastContext.Provider>
  );
}
