import { api } from "./client";

export interface AdapterCapabilities {
  supportsInstructionsBundle: boolean;
  supportsSkills: boolean;
  supportsLocalAgentJwt: boolean;
  requiresMaterializedRuntimeSkills: boolean;
  supportsModelProfiles?: boolean;
}

export interface AdapterInfo {
  type: string;
  label: string;
  source: "builtin" | "external";
  modelsCount: number;
  loaded: boolean;
  disabled: boolean;
  capabilities: AdapterCapabilities;
  overriddenBuiltin?: boolean;
  overridePaused?: boolean;
  version?: string;
  packageName?: string;
  isLocalPath?: boolean;
}

export const adaptersApi = {
  list: () => api.get<AdapterInfo[]>("/adapters"),
};
