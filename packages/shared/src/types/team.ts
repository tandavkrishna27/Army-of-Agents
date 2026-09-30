import type { IssuePriority, IssueStatus, PermissionKey, UserRole } from "../constants.js";

export type HumanSocialLinkType =
  | "linkedin"
  | "github"
  | "x"
  | "instagram"
  | "facebook"
  | "substack"
  | "website"
  | "portfolio"
  | "youtube"
  | "medium"
  | "other";

export interface HumanSocialLink {
  type: HumanSocialLinkType;
  label: string | null;
  url: string;
}

export interface CompanyUserProfile {
  id: string;
  companyId: string;
  userId: string;
  displayName: string | null;
  title: string | null;
  bio: string | null;
  location: string | null;
  timezone: string | null;
  socialLinks: HumanSocialLink[];
  avatarAssetId: string | null;
  createdAt: Date;
  updatedAt: Date;
  updatedByUserId: string | null;
}

export type HumanCapabilityDocumentKind =
  | "resume"
  | "skills"
  | "responsibilities"
  | "preferences"
  | "availability"
  | "background"
  | "custom";

export interface HumanCapabilityDocumentTemplate {
  slug: string;
  filename: string;
  title: string;
  kind: Exclude<HumanCapabilityDocumentKind, "custom">;
  sortOrder: number;
  content: string;
}

export interface HumanCapabilityDocumentSummary {
  id: string;
  companyId: string;
  userId: string;
  slug: string;
  filename: string;
  title: string;
  kind: HumanCapabilityDocumentKind;
  content: string;
  sortOrder: number;
  isStandard: boolean;
  createdAt: Date;
  updatedAt: Date;
  createdByUserId: string | null;
  updatedByUserId: string | null;
}

export type HumanCapabilityDocumentDetail = HumanCapabilityDocumentSummary;

export interface HumanCapabilityBundle {
  companyId: string;
  userId: string;
  documents: HumanCapabilityDocumentSummary[];
}

export interface HumanContextIdentity {
  userId: string;
  email: string | null;
  displayName: string | null;
  title: string | null;
  bio: string | null;
  location: string | null;
  timezone: string | null;
  socialLinks: HumanSocialLink[];
}

export interface HumanContextAuthority {
  role: UserRole;
  departmentId: string | null;
  departmentName: string | null;
  reportsToUserId: string | null;
  reportsToName: string | null;
  isSystemAdmin: boolean;
  explicitGrants: PermissionKey[];
}

export interface HumanContextResponsibility {
  directHumanReports: Array<{
    userId: string;
    displayName: string | null;
    email: string | null;
    role: UserRole;
  }>;
  directAgentTrees: Array<{
    rootAgentId: string;
    rootAgentName: string;
    subAgentCount: number;
    agentIds: string[];
  }>;
  assignedTaskCount: number;
  createdTaskCount: number;
}

export interface HumanContextCapabilityDocument {
  id: string;
  slug: string;
  filename: string;
  title: string;
  kind: HumanCapabilityDocumentKind;
  content: string;
  isStandard: boolean;
  updatedAt: Date;
  updatedByUserId: string | null;
}

export interface HumanContextBundle {
  companyId: string;
  userId: string;
  generatedAt: Date;
  identity: HumanContextIdentity;
  authority: HumanContextAuthority;
  responsibility: HumanContextResponsibility;
  capabilities: HumanContextCapabilityDocument[];
  markdown: string;
}

export type HumanSearchMatchedField =
  | "identity"
  | "authority"
  | "responsibility"
  | "capability_document";

export interface SearchHumansInput {
  q: string;
  role?: UserRole | "all";
  departmentId?: string | null;
  limit?: number;
}

export interface HumanSearchMatchSnippet {
  field: HumanSearchMatchedField;
  label: string;
  value: string;
  documentId?: string;
  filename?: string;
}

export interface HumanSearchResult {
  userId: string;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  title: string | null;
  role: UserRole;
  departmentId: string | null;
  departmentName: string | null;
  reportsToUserId: string | null;
  reportsToName: string | null;
  matchedFields: HumanSearchMatchedField[];
  snippets: HumanSearchMatchSnippet[];
  responsibilitySummary: {
    directHumanReportCount: number;
    directAgentTreeCount: number;
    assignedTaskCount: number;
    createdTaskCount: number;
  };
}

export interface HumanSearchResponse {
  companyId: string;
  query: string;
  results: HumanSearchResult[];
}

export interface HumanWorkloadTaskSummary {
  id: string;
  identifier: string | null;
  title: string;
  status: IssueStatus;
  priority: IssuePriority;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  responsibleUserId: string | null;
  dueDate: Date | null;
  updatedAt: Date;
}

export interface HumanWorkloadManagedAgent {
  id: string;
  name: string;
  role: string;
  status: string;
  rootAgentId: string;
  rootAgentName: string;
  openTaskCount: number;
}

export interface HumanWorkloadManagedAgentTask extends HumanWorkloadTaskSummary {
  managedAgentId: string;
  managedAgentName: string;
  rootAgentId: string;
  rootAgentName: string;
}

export interface HumanWorkloadAttentionItem {
  kind: "blocked_task" | "review_task";
  taskId: string;
  identifier: string | null;
  title: string;
  status: IssueStatus;
  source: "responsible" | "assigned" | "managed_agent";
  agentId: string | null;
  agentName: string | null;
}

export interface HumanWorkloadSummary {
  responsibleOpenTaskCount: number;
  assignedOpenTaskCount: number;
  managedAgentCount: number;
  managedAgentOpenTaskCount: number;
  attentionCount: number;
}

export interface HumanWorkload {
  companyId: string;
  userId: string;
  generatedAt: Date;
  summary: HumanWorkloadSummary;
  responsibleTasks: HumanWorkloadTaskSummary[];
  assignedTasks: HumanWorkloadTaskSummary[];
  managedAgents: HumanWorkloadManagedAgent[];
  managedAgentTasks: HumanWorkloadManagedAgentTask[];
  attentionItems: HumanWorkloadAttentionItem[];
}

export type HumanContextResolutionMode =
  | "direct_context"
  | "resolved_context"
  | "multiple_matches"
  | "no_match";

export interface HumanContextResolutionResult {
  mode: HumanContextResolutionMode;
  query: string | null;
  selectedHuman: HumanSearchResult | null;
  candidates: HumanSearchResult[];
  bundle: HumanContextBundle | null;
}

export interface TeamPermissionSummary {
  canAssignTasks: boolean;
  canInviteUsers: boolean;
  canManageRoles: boolean;
  canEditIdentityMemory: boolean;
}

export interface TeamCurrentUserSummary {
  userId: string | null;
  role: UserRole | null;
  departmentId: string | null;
  isSystemAdmin: boolean;
  permissions: TeamPermissionSummary;
}

export interface TeamMemberSummary {
  userId: string;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  title: string | null;
  bio: string | null;
  location: string | null;
  timezone: string | null;
  socialLinks: HumanSocialLink[];
  avatarAssetId: string | null;
  role: UserRole;
  departmentId: string | null;
  departmentName: string | null;
  permissions: PermissionKey[];
  isCurrentUser: boolean;
  isSystemAdmin: boolean;
  parentType: "user" | null;
  parentId: string | null;
}

export interface TeamInviteSummary {
  id: string;
  email: string | null;
  role: UserRole;
  departmentId: string | null;
  departmentName: string | null;
  reportsToId: string | null;
  reportsToName: string | null;
  expiresAt: Date;
  inviteUrl: string;
}

export interface TeamSummary {
  currentUser: TeamCurrentUserSummary;
  members: TeamMemberSummary[];
  pendingInvites: TeamInviteSummary[];
}

export interface AddMemberInput {
  name: string;
  email: string;
  role: UserRole;
  projectId?: string | null;
  parentType?: "user" | null;
  parentId?: string | null;
}

export interface TransferAdminInput {
  toUserId: string;
  confirmation: string;
}

export interface MemberDependencies {
  teamMembers: Array<{ userId: string; displayName: string | null; email: string | null; role: UserRole }>;
  agentTrees: Array<{ rootAgentId: string; rootAgentName: string; subAgentCount: number; agentIds: string[] }>;
  assignedTaskCount: number;
  createdTaskCount: number;
}

export interface ReassignAndRemoveInput {
  humanReassignments: Array<{ userId: string; newParentId: string | null }>;
  agentReassignments: Array<{ agentId: string; newParentId: string; newParentType: "user" }>;
}

/** A node in the unified org tree that can represent either an agent or a human. */
export interface UnifiedOrgNode {
  id: string;
  name: string;
  role: string;
  status: string;
  nodeType: "agent" | "user";

  // Agent-specific (undefined for users)
  adapterType?: string;
  trustScore?: number;
  icon?: string;
  pendingApproval?: boolean;

  // User-specific (undefined for agents)
  email?: string;
  userRole?: "founder" | "team_lead" | "team_member";
  departmentName?: string;
  avatarUrl?: string;

  // Hierarchy. `parentType` is included on agent nodes so the org-tree UI
  // can compute the apex CXO (= Chief of Staff) without an extra fetch:
  //   apexCxo = role === "cxo" && (parentType === "user" || parentType === null).
  parentType?: "agent" | "user" | null;
  children: UnifiedOrgNode[];
}
