import type {
  AddMember,
  CompanyUserProfile,
  CreateHumanCapabilityDocument,
  HumanCapabilityBundle,
  HumanCapabilityDocumentDetail,
  HumanWorkload,
  HumanSearchResponse,
  MemberDependencies,
  SearchHumansInput,
  TeamMemberSummary,
  TeamSummary,
  TransferAdmin,
  ReassignAndRemove,
  UpdateHumanCapabilityDocument,
  UpdateTeamMemberRole,
  UpdateCompanyUserProfile,
} from "@armyofagents/shared";
import { api } from "./client";

export const teamApi = {
  get: (companyId: string) => api.get<TeamSummary>(`/companies/${companyId}/team`),
  searchHumans: (companyId: string, input: SearchHumansInput) => {
    const params = new URLSearchParams();
    params.set("q", input.q);
    if (input.role) params.set("role", input.role);
    if (input.departmentId) params.set("departmentId", input.departmentId);
    if (input.limit !== undefined) params.set("limit", String(input.limit));
    return api.get<HumanSearchResponse>(`/companies/${companyId}/team/humans/search?${params.toString()}`);
  },
  updateRole: (companyId: string, userId: string, input: UpdateTeamMemberRole) =>
    api.patch<{ role: string | null; projectId: string | null; parentType: string | null; parentId: string | null }>(
      `/companies/${companyId}/team/users/${userId}/role`,
      input,
    ),
  updateProfile: (companyId: string, userId: string, input: UpdateCompanyUserProfile) =>
    api.patch<{ profile: CompanyUserProfile }>(`/companies/${companyId}/team/users/${userId}/profile`, input),
  listCapabilities: (companyId: string, userId: string) =>
    api.get<HumanCapabilityBundle>(`/companies/${companyId}/team/users/${userId}/capabilities`),
  createCapabilityDocument: (companyId: string, userId: string, input: CreateHumanCapabilityDocument) =>
    api.post<{ document: HumanCapabilityDocumentDetail }>(
      `/companies/${companyId}/team/users/${userId}/capabilities`,
      input,
    ),
  updateCapabilityDocument: (
    companyId: string,
    userId: string,
    documentId: string,
    input: UpdateHumanCapabilityDocument,
  ) =>
    api.patch<{ document: HumanCapabilityDocumentDetail }>(
      `/companies/${companyId}/team/users/${userId}/capabilities/${documentId}`,
      input,
    ),
  deleteCapabilityDocument: (companyId: string, userId: string, documentId: string) =>
    api.delete<{ ok: true }>(`/companies/${companyId}/team/users/${userId}/capabilities/${documentId}`),
  removeMember: (companyId: string, userId: string) =>
    api.delete<{ ok: true }>(`/companies/${companyId}/team/users/${userId}`),
  addMember: (companyId: string, input: AddMember) =>
    api.post<{ userId: string }>(`/companies/${companyId}/team/members`, input),
  getMember: (companyId: string, userId: string) =>
    api.get<{ member: TeamMemberSummary; dependencies: MemberDependencies }>(
      `/companies/${companyId}/team/users/${userId}`,
    ),
  getWorkload: (companyId: string, userId: string) =>
    api.get<HumanWorkload>(`/companies/${companyId}/team/users/${userId}/workload`),
  getDependencies: (companyId: string, userId: string) =>
    api.get<MemberDependencies>(`/companies/${companyId}/team/users/${userId}/dependencies`),
  transferAdmin: (companyId: string, input: TransferAdmin) =>
    api.post<{ ok: true }>(`/companies/${companyId}/team/transfer-admin`, input),
  reassignAndRemove: (companyId: string, userId: string, input: ReassignAndRemove) =>
    api.post<{ ok: true }>(`/companies/${companyId}/team/users/${userId}/reassign-and-remove`, input),
  revokeInvite: (companyId: string, inviteId: string) =>
    api.patch<{ ok: true }>(`/companies/${companyId}/invites/${inviteId}/revoke`, {}),
  resendInvite: (companyId: string, inviteId: string) =>
    api.post<{ inviteId: string; token: string; inviteUrl: string; expiresAt: string }>(
      `/companies/${companyId}/invites/${inviteId}/resend`,
      {},
    ),
};
