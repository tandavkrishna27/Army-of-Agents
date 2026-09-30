import type { ArtifactWithVersions, ArtifactVersion, CreateArtifactVersion } from "@armyofagents/shared";
import { api } from "./client";

export const artifactsApi = {
  /** Get artifact linked to a task. Returns null (not 404) if none linked. */
  getByIssueId: (issueId: string) =>
    api.get<ArtifactWithVersions | null>(`/issues/${issueId}/artifacts`),

  /** Get artifact by ID with all versions (newest first). */
  get: (id: string) => api.get<ArtifactWithVersions>(`/artifacts/${id}`),

  /** Company-wide artifact list (newest first). Rows have no versions array. */
  listByCompany: (companyId: string) =>
    api.get<Array<{ id: string; title: string; type: string; status: string; currentVersionId: string | null; updatedAt: string }>>(
      `/companies/${companyId}/artifacts`,
    ),

  /** Add immutable version to artifact. */
  addVersion: (artifactId: string, data: CreateArtifactVersion) =>
    api.post<ArtifactVersion>(`/artifacts/${artifactId}/versions`, data),
};

/* ════════════════════════════════════════════════════════════════════════
   Artifact Lifecycle P1 — founder-gated archive/unarchive + founder upload
   ════════════════════════════════════════════════════════════════════════ */

export interface ArtifactSummary {
  id: string;
  companyId: string;
  title: string;
  description: string | null;
  type: string;
  status: string;
  currentVersionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export function archiveArtifact(artifactId: string) {
  return api.post<ArtifactSummary>(`/artifacts/${artifactId}/archive`, {});
}

export function unarchiveArtifact(artifactId: string) {
  return api.post<ArtifactSummary>(`/artifacts/${artifactId}/unarchive`, {});
}

export interface UploadFileArtifactMeta {
  title: string;
  type: string;
  description?: string | null;
}

/** Founder upload (P1): compose the existing assets-file upload + artifact create. No new multipart artifact route. */
export async function uploadFileArtifact(
  companyId: string,
  file: File,
  meta: UploadFileArtifactMeta,
): Promise<ArtifactSummary> {
  const form = new FormData();
  form.append("file", file);
  const asset = await api.postForm<{
    assetId: string;
    contentType: string;
    byteSize: number;
    sha256: string;
    originalFilename: string | null;
  }>(`/companies/${companyId}/assets/files`, form);
  const dot = file.name.lastIndexOf(".");
  const extension = dot > 0 ? file.name.slice(dot + 1) : null;
  return api.post<ArtifactSummary>(`/companies/${companyId}/artifacts`, {
    title: meta.title,
    description: meta.description ?? null,
    type: meta.type,
    source: "founder",
    storageKind: "asset",
    assetId: asset.assetId,
    filename: asset.originalFilename ?? file.name,
    contentType: asset.contentType,
    extension,
    byteSize: asset.byteSize,
    sha256: asset.sha256,
  });
}
