import type { NotificationType } from "../constants.js";

/**
 * A single user-facing notification row.
 *
 * Mirrors the `notifications` DB table (`packages/db/src/schema/notifications.ts`).
 * The Inbox UI renders these grouped above the existing approvals / failed-runs
 * sections.
 *
 * Phase 1 Phase E batch 3 (T23) added thread-coordination types:
 *  - thread.artifact_needs_review
 *  - thread.crew_failed
 *  - thread.spinoff_suggested
 * (thread.scope_proposal_posted + thread.human_input_needed were pruned in
 * Task 10, 2026-07-04 — zero writers ever shipped.)
 *
 * These piggyback on the existing row shape — the contextual payload (artifact
 * title, agent name, etc.) is encoded in `message`, and the destination thread
 * is identified by `relatedEntityType="discussion" + relatedEntityId`.
 */
export interface Notification {
  id: string;
  companyId: string;
  userId: string;
  type: NotificationType | string;
  title: string;
  message: string | null;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  readAt: string | null;
  dismissedAt: string | null;
  createdAt: string;
}
