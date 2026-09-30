import type { Notification } from "@armyofagents/shared";
import { api } from "./client";

export const notificationsApi = {
  /**
   * Unread badge count. Cheap; used in sidebar/header polling.
   */
  getUnreadCount: (companyId: string) =>
    api.get<{ count: number }>(
      `/companies/${companyId}/notifications/unread-count`,
    ),

  /**
   * Full list of notifications for the current user in this company.
   * Phase 1 Phase E batch 3 (T23): added so the Inbox can render the new
   * `thread.*` types.
   */
  list: (companyId: string, opts?: { unreadOnly?: boolean }) => {
    const params = new URLSearchParams();
    if (opts?.unreadOnly) params.set("unreadOnly", "true");
    const qs = params.toString();
    return api.get<Notification[]>(
      `/companies/${companyId}/notifications${qs ? `?${qs}` : ""}`,
    );
  },

  markRead: (companyId: string, id: string) =>
    api.patch<Notification>(
      `/companies/${companyId}/notifications/${id}/read`,
      {},
    ),

  dismiss: (companyId: string, id: string) =>
    api.patch<Notification>(
      `/companies/${companyId}/notifications/${id}/dismiss`,
      {},
    ),
};
