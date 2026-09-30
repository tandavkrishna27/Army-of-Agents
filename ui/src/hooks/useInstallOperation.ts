import { useMutation, type UseMutationResult } from "@tanstack/react-query";
import { marketplaceApi, type InstallRequest } from "@/api/marketplace";

export interface UseInstallOperationOpts {
  companyId: string;
}

export interface InstallResult {
  operationId: string;
  status: string;
}

/**
 * Mutation hook for POST /companies/:cid/marketplace/install.
 * Returns `{ operationId, status }` on success — caller polls status via useOperationStatus.
 */
export function useInstallOperation(
  opts: UseInstallOperationOpts,
): UseMutationResult<InstallResult, Error, InstallRequest> {
  const { companyId } = opts;
  return useMutation({
    mutationFn: (request: InstallRequest) =>
      marketplaceApi.install(companyId, request),
  });
}
