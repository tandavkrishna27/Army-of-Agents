import { api } from "./client";

export interface FileImportJob {
  id: string;
  status: "pending" | "processing" | "done" | "failed";
  fileName: string;
  itemCount: number;
  errorMessage: string | null;
  parserWarnings: string[] | null;
  createdAt: string;
  completedAt: string | null;
}

export interface StartImportResult {
  jobId: string;
  fileName: string;
}

export const fileImportApi = {
  upload: (
    companyId: string,
    file: File,
    opts: {
      departmentId?: string | null;
      projectId?: string | null;
      defaultLayer?: string;
      defaultCategory?: string;
    } = {},
  ): Promise<StartImportResult> => {
    const form = new FormData();
    form.append("file", file);
    if (opts.departmentId) form.append("departmentId", opts.departmentId);
    if (opts.projectId) form.append("projectId", opts.projectId);
    if (opts.defaultLayer) form.append("defaultLayer", opts.defaultLayer);
    if (opts.defaultCategory) form.append("defaultCategory", opts.defaultCategory);
    return api.postForm<StartImportResult>(
      `/companies/${companyId}/memory/import-file`,
      form,
    );
  },

  getJob: (companyId: string, jobId: string): Promise<FileImportJob> =>
    api.get<FileImportJob>(
      `/companies/${companyId}/memory/import-jobs/${jobId}`,
    ),
};
