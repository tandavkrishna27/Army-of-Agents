export interface BudgetPolicy {
  id: string;
  companyId: string;
  scopeType: "company" | "agent";
  scopeId: string;
  metric: string;
  windowKind: string;
  amountCents: number;
  warnPercent: number;
  hardStopEnabled: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface BudgetPolicySummary extends BudgetPolicy {
  scopeName: string;
  observedCents: number;
  utilizationPercent: number;
  status: "ok" | "warning" | "hard_stop";
}

export interface BudgetIncident {
  id: string;
  companyId: string;
  policyId: string;
  scopeType: string;
  scopeId: string;
  windowStart: Date;
  windowEnd: Date;
  thresholdType: "warning" | "hard_stop";
  amountLimitCents: number;
  amountObservedCents: number;
  status: "open" | "resolved" | "dismissed";
  approvalId: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  scopeName?: string;
}

export interface BudgetOverview {
  policies: BudgetPolicySummary[];
  openIncidents: BudgetIncident[];
}

export interface UpsertBudgetPolicyInput {
  scopeType: "company" | "agent";
  scopeId: string;
  amountCents: number;
  warnPercent?: number;
  hardStopEnabled?: boolean;
}

export interface ResolveBudgetIncidentInput {
  action: "raise_and_resume" | "dismiss";
  newAmountCents?: number;
}
