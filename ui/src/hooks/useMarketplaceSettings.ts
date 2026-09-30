import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { marketplaceApi, type MarketplaceSettings } from "@/api/marketplace";

export function useMarketplaceSettings(companyId: string | undefined) {
  return useQuery({
    queryKey: ["marketplace", "settings", companyId],
    queryFn: () => marketplaceApi.getSettings(companyId!),
    enabled: !!companyId,
    staleTime: 5 * 60 * 1000,
  });
}

export function usePatchMarketplaceSettings(companyId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<MarketplaceSettings>) =>
      marketplaceApi.patchSettings(companyId!, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["marketplace", "settings", companyId] });
    },
    onError: (err: Error) => {
      console.error("Marketplace settings patch failed:", err);
    },
  });
}
