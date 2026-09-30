import type {
  Environment,
  CreateEnvironmentInput,
  EnvironmentProbeResult,
  ProbeEnvironmentInput,
  UpdateEnvironmentInput,
} from "@armyofagents/shared";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import { queryKeys } from "@/lib/queryKeys";

// ---------------------------------------------------------------------------
// Plain fetch functions (no hooks)
// ---------------------------------------------------------------------------

export function listEnvironments(companyId: string): Promise<Environment[]> {
  return api.get<Environment[]>(`/companies/${companyId}/environments`);
}

export function getEnvironment(companyId: string, id: string): Promise<Environment> {
  return api.get<Environment>(`/companies/${companyId}/environments/${id}`);
}

export function createEnvironment(
  companyId: string,
  input: CreateEnvironmentInput,
): Promise<Environment> {
  return api.post<Environment>(`/companies/${companyId}/environments`, input);
}

export function updateEnvironment(
  companyId: string,
  id: string,
  input: UpdateEnvironmentInput,
): Promise<Environment> {
  return api.patch<Environment>(`/companies/${companyId}/environments/${id}`, input);
}

export function deleteEnvironment(companyId: string, id: string): Promise<void> {
  return api.delete<void>(`/companies/${companyId}/environments/${id}`);
}

export function probeEnvironment(
  companyId: string,
  input: ProbeEnvironmentInput,
): Promise<EnvironmentProbeResult> {
  return api.post<EnvironmentProbeResult>(`/companies/${companyId}/environments/probe`, input);
}

// ---------------------------------------------------------------------------
// React Query hooks
// ---------------------------------------------------------------------------

export function useEnvironments(companyId: string) {
  return useQuery({
    queryKey: queryKeys.environments.list(companyId),
    queryFn: () => listEnvironments(companyId),
    enabled: !!companyId,
  });
}

export function useEnvironment(companyId: string, id: string) {
  return useQuery({
    queryKey: queryKeys.environments.detail(companyId, id),
    queryFn: () => getEnvironment(companyId, id),
    enabled: !!companyId && !!id,
  });
}

export function useCreateEnvironment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      companyId,
      input,
    }: {
      companyId: string;
      input: CreateEnvironmentInput;
    }) => createEnvironment(companyId, input),
    onSuccess: (_data, { companyId }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.environments.list(companyId),
      });
    },
  });
}

export function useUpdateEnvironment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      companyId,
      id,
      input,
    }: {
      companyId: string;
      id: string;
      input: UpdateEnvironmentInput;
    }) => updateEnvironment(companyId, id, input),
    onSuccess: (_data, { companyId, id }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.environments.list(companyId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.environments.detail(companyId, id),
      });
    },
  });
}

export function useDeleteEnvironment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ companyId, id }: { companyId: string; id: string }) =>
      deleteEnvironment(companyId, id),
    onSuccess: (_data, { companyId }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.environments.list(companyId),
      });
    },
  });
}

export function useProbeEnvironment() {
  return useMutation({
    mutationFn: ({
      companyId,
      input,
    }: {
      companyId: string;
      input: ProbeEnvironmentInput;
    }) => probeEnvironment(companyId, input),
  });
}
