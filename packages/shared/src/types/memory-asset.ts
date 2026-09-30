export interface MemoryAssetRecord {
  id: string;
  companyId: string;
  departmentId: string | null;
  folderPath: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  storageKey: string;
  importJobId: string | null;
  extractedItemCount: number;
  metadata: Record<string, unknown> | null;
  uploadedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryAssetCreateInput {
  departmentId: string | null;
  folderPath: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  storageKey: string;
  importJobId?: string | null;
  metadata?: Record<string, unknown> | null;
  uploadedByUserId?: string | null;
}

export interface MemoryAssetUpdateInput {
  fileName?: string;
  folderPath?: string;
  metadata?: Record<string, unknown> | null;
}
