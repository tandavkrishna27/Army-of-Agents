import type { SuggestionCategory, SuggestionStatus, SuggestionActionType } from "../constants.js";

export interface Suggestion {
  id: string;
  companyId: string;
  category: SuggestionCategory;
  actionType: SuggestionActionType;
  actionPayload: Record<string, unknown> | null;
  title: string;
  evidence: string | null;
  status: SuggestionStatus;
  expiresAt: Date | null;
  relatedMemoryItemId: string | null;
  createdAt: Date;
  updatedAt: Date;
}
