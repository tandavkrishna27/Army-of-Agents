import type {
  OrganizationStatus,
  OrganizationRole,
  OrganizationInvitationStatus,
} from "../constants.js";

export interface Organization {
  id: string;
  name: string;
  slug: string;
  status: OrganizationStatus;
  plan: string;
  concurrencyCap: number | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrganizationMembership {
  id: string;
  organizationId: string;
  userId: string;
  role: OrganizationRole;
  status: "pending" | "active" | "suspended";
  invitedByUserId: string | null;
  joinedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrganizationInvitation {
  id: string;
  organizationId: string;
  email: string;
  role: OrganizationRole;
  status: OrganizationInvitationStatus;
  invitedByUserId: string | null;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
