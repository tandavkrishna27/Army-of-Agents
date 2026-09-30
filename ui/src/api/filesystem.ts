import { api } from "./client";

export interface FsBrowseEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isGitRepo: boolean;
}

export interface FsBrowseResult {
  currentPath: string;
  parentPath: string | null;
  homePath: string;
  platform: string;
  /**
   * WS0a — present on the company-scoped workspace-fs API. true when the
   * caller is confined to a server-owned per-company base dir
   * (`authenticated` deployment mode); false/absent for the unjailed
   * instance-admin API and for `local_trusted` company members.
   */
  jailed?: boolean;
  entries: FsBrowseEntry[];
}

export interface FsDrive {
  name: string;
  path: string;
}

export interface FsDrivesResult {
  drives: FsDrive[];
  platform: string;
  jailed?: boolean;
}

export interface FsHomeResult {
  homePath: string;
  platform: string;
  jailed?: boolean;
}

export interface FilesystemApi {
  browse: (
    dirPath?: string,
    opts?: { gitAware?: boolean; includeFiles?: boolean; extensions?: string[] },
  ) => Promise<FsBrowseResult>;
  mkdir: (dirPath: string) => Promise<{ created: boolean; path: string }>;
  home: () => Promise<FsHomeResult>;
  drives: () => Promise<FsDrivesResult>;
}

function buildFilesystemApi(basePath: string): FilesystemApi {
  return {
    browse: async (dirPath, opts) => {
      const params = new URLSearchParams();
      if (dirPath) params.set("path", dirPath);
      if (opts?.gitAware) params.set("gitAware", "true");
      if (opts?.includeFiles) params.set("includeFiles", "true");
      if (opts?.extensions?.length) params.set("extensions", opts.extensions.join(","));
      const qs = params.toString();
      return api.get(`${basePath}/browse${qs ? `?${qs}` : ""}`);
    },

    mkdir: async (dirPath) => {
      return api.post(`${basePath}/mkdir`, { path: dirPath });
    },

    home: async () => {
      return api.get(`${basePath}/home`);
    },

    drives: async () => {
      return api.get(`${basePath}/drives`);
    },
  };
}

// Instance-admin filesystem API (gated by assertCanManageInstanceSettings on
// the server) — unchanged surface, used by instance-settings and other
// existing callers that predate WS0a.
const instanceFilesystemApi = buildFilesystemApi("/filesystem");

export const filesystemApi: FilesystemApi & {
  reveal: (dirPath: string) => Promise<{ ok: boolean }>;
} = {
  ...instanceFilesystemApi,
  reveal: async (dirPath: string): Promise<{ ok: boolean }> => {
    return api.post("/filesystem/reveal", { path: dirPath });
  },
};

/**
 * WS0a — company-scoped filesystem API. Gated by company membership (not
 * instance-admin) on the server. Deployment-split: unjailed real-filesystem
 * browse in `local_trusted`, jailed to a per-company base dir in
 * `authenticated` mode (server decides; the client just reads the `jailed`
 * flag back from `home`/`browse`/`drives` responses).
 */
export function companyWorkspaceFsApi(companyId: string): FilesystemApi {
  return buildFilesystemApi(`/companies/${companyId}/workspace-fs`);
}
