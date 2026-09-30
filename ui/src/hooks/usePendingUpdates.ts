import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { marketplaceApi, type PendingUpdate } from "@/api/marketplace";
import { useCompany } from "@/context/CompanyContext";

export function usePendingUpdates() {
  const { selectedCompany } = useCompany();
  return useQuery<PendingUpdate[]>({
    queryKey: ["marketplace", "updates", selectedCompany?.id],
    queryFn: () => marketplaceApi.getUpdates(selectedCompany!.id),
    enabled: !!selectedCompany?.id,
    staleTime: 2 * 60 * 1000,
  });
}

export function useDismissUpdate() {
  const { selectedCompany } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (updateId: string) =>
      marketplaceApi.dismissUpdate(selectedCompany!.id, updateId),
    onSuccess: () =>
      qc.invalidateQueries({
        queryKey: ["marketplace", "updates", selectedCompany?.id],
      }),
  });
}
