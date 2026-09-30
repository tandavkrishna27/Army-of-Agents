import type { ArtifactType, ArtifactStatus, ArtifactVersionSource } from "../constants.js";

export interface Artifact {
  id: string;
  companyId: string;
  title: string;
  description: string | null;
  type: ArtifactType;
  status: ArtifactStatus;
  currentVersionId: string | null;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ArtifactVersion {
  id: string;
  artifactId: string;
  versionNumber: number;
  source: ArtifactVersionSource;
  sourceDetail: string | null;
  changelog: string | null;
  parentVersionId: string | null;
  content: string | null;
  fileUrl: string | null;
  storageKind?: "inline" | "asset" | null;
  assetId?: string | null;
  filename?: string | null;
  contentType?: string | null;
  extension?: string | null;
  byteSize?: number | null;
  sha256?: string | null;
  createdAt: Date;
}

export interface ArtifactWithVersions extends Artifact {
  versions: ArtifactVersion[];
}
