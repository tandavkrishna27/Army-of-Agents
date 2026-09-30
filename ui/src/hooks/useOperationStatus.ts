import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { marketplaceApi, type InstallOperation } from "@/api/marketplace";
import { ApiError } from "@/api/client";

const POLL_INTERVAL_MS = 2000;

export interface UseOperationStatusOpts {
  companyId: string | null;
  operationId: string | null;
  /** If provided, any operation whose createdAt is before this date is treated as stale. */
  startedAfter?: Date;
}

/**
 * Poll an install operation's status until terminal (success/failure/requested).
 * Refetches every 2s while pending/running. Stops via refetchInterval=false on terminal.
 * "requested" is terminal — the install was queued for founder approval, not dispatched.
 */
export function useOperationStatus(
  opts: UseOperationStatusOpts,
): UseQueryResult<InstallOperation, Error> {
  const { companyId, operationId, startedAfter } = opts;
  return useQuery({
    queryKey: ["marketplace", "operation", companyId, operationId] as const,
    queryFn: async () => {
      let data: InstallOperation;
      try {
        data = await marketplaceApi.getOperation(companyId!, operationId!);
      } catch (err) {
        if (err instanceof ApiError && err.status === 503) {
          const body = err.body as {
            error?: unknown;
            code?: unknown;
            docs?: unknown;
          } | null;
          if (body?.code === "PLUGIN_WORKER_BLOCKED_IN_CLOUD") {
            return {
              id: operationId!,
              companyId: companyId!,
              catalogItemId: "",
              itemType: "plugin" as const,
              targetDepartmentId: null,
              status: "failure" as const,
              resultEntityId: null,
              errorMessage:
                typeof body.error === "string" ? body.error : err.message,
              errorCode: body.code,
              errorDocs: typeof body.docs === "string" ? body.docs : null,
              cascadeResults: null,
              startedAt: new Date().toISOString(),
              completedAt: new Date().toISOString(),
              createdAt: new Date().toISOString(),
            } satisfies InstallOperation;
          }
        }
        throw err;
      }
      if (startedAfter && new Date(data.createdAt) < startedAfter) {
        return { ...data, status: "failure" as const, errorMessage: "stale_operation" };
      }
      return data;
    },
    enabled: !!companyId && !!operationId,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return POLL_INTERVAL_MS;
      if (data.status === "success" || data.status === "failure" || data.status === "requested") return false;
      return POLL_INTERVAL_MS;
    },
  });
}
