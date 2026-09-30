export interface MemoryFolderRecord {
  id: string;
  companyId: string;
  departmentId: string | null;
  path: string;
  displayName: string;
  icon: string | null;
  sortOrder: number;
  seedKey: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryFolderCreateInput {
  departmentId: string | null;
  path: string;
  displayName: string;
  icon?: string | null;
}

export interface MemoryFolderUpdateInput {
  path?: string;
  displayName?: string;
  icon?: string | null;
  sortOrder?: number;
}
