import { api } from "./client";

export interface InboxDismissal {
  id: string;
  userId: string;
  companyId: string;
  itemKey: string;
  dismissedAt: string;
  createdAt: string;
  updatedAt: string;
}

function base(companyId: string) {
  return `/companies/${companyId}/inbox-dismissals`;
}

export const inboxDismissalsApi = {
  list: (companyId: string) => api.get<InboxDismissal[]>(base(companyId)),
  dismiss: (companyId: string, itemKey: string) =>
    api.post<InboxDismissal>(base(companyId), { itemKey }),
  undismiss: (companyId: string, itemKey: string) =>
    api.delete<void>(`${base(companyId)}/${encodeURIComponent(itemKey)}`),
};
