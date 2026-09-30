import { api } from "./client";

export type MemoryAutonomyLevel = "manual" | "supervised" | "trusted" | "policy";
export type MemoryActiveContextTier = "ephemeral" | "durable" | "protected";

export interface MemorySettingsRow {
  id: string;
  companyId: string;
  departmentId: string | null;
  autonomyLevel: MemoryAutonomyLevel;
  activeContextTier: MemoryActiveContextTier;
  retentionDays: number;
  legalHold: boolean;
  runMinerEnabled: boolean;
  runMinerBudgetCents: number | null;
  externalScreeningEnabled: boolean;
  privateMemoryEnabled: boolean;
  workingMemoryTtlDays: number | null;
}

export interface MemorySettingsPatch {
  departmentId?: string | null;
  autonomyLevel?: MemoryAutonomyLevel;
  activeContextTier?: MemoryActiveContextTier;
}

export const memorySettingsApi = {
  /** All rows for a company: the company default (departmentId null) + department overrides. */
  list: (companyId: string) =>
    api.get<MemorySettingsRow[]>(`/companies/${companyId}/memory-settings`),
  /** Upsert the company default (departmentId null) or a department override. */
  update: (companyId: string, patch: MemorySettingsPatch) =>
    api.put<MemorySettingsRow>(`/companies/${companyId}/memory-settings`, {
      departmentId: null,
      ...patch,
    }),
  /** Clear a department override so the department reverts to the company default. */
  deleteOverride: (companyId: string, departmentId: string) =>
    api.delete<void>(`/companies/${companyId}/memory-settings/departments/${departmentId}`),
};
