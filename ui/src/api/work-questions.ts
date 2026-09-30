import type {
  AnswerWorkQuestionInput,
  WorkQuestion,
  WorkQuestionDetail,
  WorkQuestionStatus,
} from "@armyofagents/shared";
import { api } from "./client";

export interface WorkQuestionListOptions {
  status?: WorkQuestionStatus;
  issueId?: string;
  sourceDiscussionId?: string;
  executionWorkspaceId?: string;
  sourceCommanderConversationId?: string;
  scope?: "mine" | "all";
}

function queryString(options: WorkQuestionListOptions) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(options)) {
    if (value) query.set(key, value);
  }
  const encoded = query.toString();
  return encoded ? `?${encoded}` : "";
}

export const workQuestionsApi = {
  list: (companyId: string, options: WorkQuestionListOptions = {}) =>
    api.get<WorkQuestion[]>(`/companies/${companyId}/work-questions${queryString(options)}`),
  listInline: (companyId: string, options: WorkQuestionListOptions = {}) =>
    api.get<WorkQuestionDetail[]>(`/companies/${companyId}/work-questions/inline${queryString(options)}`),
  detail: (companyId: string, questionId: string) =>
    api.get<WorkQuestionDetail>(`/companies/${companyId}/work-questions/${questionId}`),
  answer: (companyId: string, questionId: string, payload: AnswerWorkQuestionInput) =>
    api.post<WorkQuestion>(`/companies/${companyId}/work-questions/${questionId}/answer`, payload),
  takeOver: (companyId: string, questionId: string, expectedVersion: number) =>
    api.post<WorkQuestion>(`/companies/${companyId}/work-questions/${questionId}/take-over`, { expectedVersion }),
  retryContinuation: (companyId: string, questionId: string, expectedVersion: number) =>
    api.post<WorkQuestion>(`/companies/${companyId}/work-questions/${questionId}/retry-continuation`, { expectedVersion }),
};
