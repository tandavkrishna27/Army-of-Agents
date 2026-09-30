import { useQuery } from "@tanstack/react-query";
import { healthApi } from "@/api/health";
import { queryKeys } from "@/lib/queryKeys";

/**
 * Static cloud plugin policy for UI controls. The policy is fail-closed while
 * deployment mode is unresolved or failed, and becomes permissive only after a
 * successful non-cloud health response.
 */
export function useCloudPluginExecutionPolicy() {
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
  });
  const isCloud = healthQuery.data?.deploymentMode === "cloud_auth";
  return {
    isCloud,
    controlsBlocked: !healthQuery.isSuccess || isCloud,
  };
}
