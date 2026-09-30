import { useQuery } from "@tanstack/react-query";
import { teamApi } from "../api/team";
import { queryKeys } from "../lib/queryKeys";

export function useTeamAccess(companyId: string | null | undefined) {
  const query = useQuery({
    queryKey: companyId ? queryKeys.team.summary(companyId) : ["team", "none"],
    queryFn: () => teamApi.get(companyId!),
    enabled: Boolean(companyId),
  });

  return {
    ...query,
    summary: query.data ?? null,
    currentUser: query.data?.currentUser ?? null,
    // Guard `currentUser` too (not just `data`): a partial/loading team summary —
    // or a test mock returning `{ members: [] }` without `currentUser` — would
    // otherwise throw "Cannot read properties of undefined (reading 'permissions')".
    permissions: query.data?.currentUser?.permissions ?? {
      canAssignTasks: false,
      canInviteUsers: false,
      canManageRoles: false,
      canEditIdentityMemory: false,
    },
    role: query.data?.currentUser?.role ?? null,
  };
}
