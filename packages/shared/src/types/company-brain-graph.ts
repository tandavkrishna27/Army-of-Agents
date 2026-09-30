import type {
  CompanyBrainEdgeEditability,
  CompanyBrainEdgeKind,
  CompanyBrainEdgeSourceClass,
  CompanyBrainNodeType,
} from "../constants.js";

export interface CompanyBrainNodeRef {
  type: CompanyBrainNodeType;
  id: string;
}

export interface CompanyBrainNode extends CompanyBrainNodeRef {
  companyId: string;
  label: string;
  subtitle?: string | null;
  status?: string | null;
  scope?: {
    departmentId?: string | null;
    projectId?: string | null;
    goalId?: string | null;
    visibility?: string | null;
    isCompanyWide?: boolean;
  };
  href?: string | null;
  metadata?: Record<string, unknown>;
}

export interface CompanyBrainEdge {
  id: string;
  companyId: string;
  from: CompanyBrainNodeRef;
  to: CompanyBrainNodeRef;
  kind: CompanyBrainEdgeKind;
  sourceClass: CompanyBrainEdgeSourceClass;
  editability: CompanyBrainEdgeEditability;
  confidence?: number | null;
  evidence?: string | null;
  createdBy?: string | null;
  createdAt?: string | null;
  metadata?: Record<string, unknown>;
}

export interface CompanyBrainSemanticEdgeRecord {
  id: string;
  companyId: string;
  fromType: CompanyBrainNodeType;
  fromId: string;
  toType: CompanyBrainNodeType;
  toId: string;
  kind: CompanyBrainEdgeKind;
  confidence?: string | number | null;
  evidence?: string | null;
  createdByPrincipalType: "agent" | "user" | "system";
  createdByPrincipalId: string;
  source: string;
  status: "active" | "archived";
  metadata?: Record<string, unknown>;
  createdAt?: string | Date | null;
  updatedAt?: string | Date | null;
  archivedAt?: string | Date | null;
}

export interface CompanyBrainNeighborsResponse {
  center: CompanyBrainNode;
  nodes: CompanyBrainNode[];
  edges: CompanyBrainEdge[];
}

export interface CompanyBrainOverviewResponse {
  nodes: CompanyBrainNode[];
  edges: CompanyBrainEdge[];
  limit: number;
  truncated: boolean;
}

export interface CompanyBrainMemoryUsageAgent {
  agentId: string | null;
  agentName: string;
  retrievalCount: number;
  lastRetrievedAt: string | null;
  linkedTaskCount: number;
}

export interface CompanyBrainMemoryUsageResponse {
  itemId: string;
  agents: CompanyBrainMemoryUsageAgent[];
}
