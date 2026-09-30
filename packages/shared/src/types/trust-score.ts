export interface AgentTrustScore {
  id: string;
  companyId: string;
  agentId: string;
  totalCompleted: number;
  approvedWithoutChanges: number;
  recentCompleted: number;
  recentApproved: number;
  currentScore: number;
  createdAt: Date;
  updatedAt: Date;
}
