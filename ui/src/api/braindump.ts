// ui/src/api/braindump.ts — WS6 client for the braindump ingestion API
// (server/src/routes/braindump.ts). See server/src/services/braindump.ts for
// the full status-machine + idempotency contract this client relies on.
import { api } from "./client";

/** Stored status. "approved" is NEVER stored — see `effectiveStatus` below. */
export type BraindumpStatus = "pending" | "running" | "proposed" | "failed";

/** `effectiveStatus` is "approved" when status="proposed", at least one item
 *  was proposed, and every linked memory item has since been approved via
 *  the founder approval route. Otherwise it mirrors `status`. */
export type BraindumpEffectiveStatus = BraindumpStatus | "approved";

/** Which memory scope a capture seeds — "company" (→ identity-layer memory
 *  under the "Company" folder) or "department" (→ domain-layer). */
export type BraindumpScope = "company" | "department";

export interface BraindumpCapture {
  id: string;
  companyId: string;
  /** NULL for a company-wide capture. */
  departmentId: string | null;
  scope: BraindumpScope;
  /** `memory_assets.id`s dropped on this scope's card. */
  assetIds: string[];
  idempotencyKey: string;
  content: string;
  contentLength: number;
  status: BraindumpStatus;
  effectiveStatus: BraindumpEffectiveStatus;
  librarianAgentId: string | null;
  runId: string | null;
  proposedMemoryItemIds: string[];
  failureReason: string | null;
  dispatchStartedAt: string | null;
  dispatchCompletedAt: string | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SubmitBraindumpInput {
  scope: BraindumpScope;
  /** null for company scope; required for department scope. */
  departmentId: string | null;
  /** May be empty when files are provided — the server accepts text OR files. */
  content: string;
  /** `memory_assets.id`s returned by the /memory/assets/upload route. */
  assetIds?: string[];
  idempotencyKey: string;
}

export const braindumpApi = {
  /** Submit (or idempotently resubmit, if `idempotencyKey` repeats) a
   *  braindump for a department. The Librarian dispatch is attempted
   *  synchronously best-effort — the response may already be "proposed" or
   *  "failed", not just "pending"/"running". */
  submit: (companyId: string, input: SubmitBraindumpInput) =>
    api.post<BraindumpCapture>(`/companies/${companyId}/braindumps`, input),

  /** Every capture for the company, BOTH scopes. LibrarianStep polls this —
   *  a per-department sweep would never see the company-wide capture. */
  list: (companyId: string) => api.get<BraindumpCapture[]>(`/companies/${companyId}/braindumps`),

  listByDepartment: (companyId: string, departmentId: string) =>
    api.get<BraindumpCapture[]>(
      `/companies/${companyId}/braindumps?departmentId=${encodeURIComponent(departmentId)}`,
    ),

  get: (companyId: string, id: string) =>
    api.get<BraindumpCapture>(`/companies/${companyId}/braindumps/${encodeURIComponent(id)}`),

  /** Retry a failed (or stuck-pending) capture. Idempotent. */
  retry: (companyId: string, id: string) =>
    api.post<BraindumpCapture>(`/companies/${companyId}/braindumps/${encodeURIComponent(id)}/retry`, {}),
};

const fallbackSessionIds = new Map<string, string>();

const SESSION_STORAGE_KEY = (companyId: string) => `aoa:braindump-session:${companyId}`;

/**
 * Stable id for the current braindump RUN — the founder's pass through the
 * Braindump step and the Librarian review that follows it.
 *
 * Two things depend on it: the idempotency key (so a double-click reuses one
 * capture) and LibrarianStep's filter (so the review shows this run's captures
 * and not every historical one).
 *
 * It lives in `localStorage`, not `sessionStorage`, because onboarding is
 * resumable across a browser restart: the in-flight step marker is durable, so
 * a tab-scoped id would resume straight into the Librarian step with a fresh
 * id, filter out the captures just submitted, and show the founder nothing.
 * `clearBraindumpSessionId` ends the run once the review is done, so a later
 * braindump mints a new id instead of colliding with these captures.
 *
 * Falls back to an in-memory id (stable for the lifetime of the page) when
 * storage is unavailable (privacy mode, non-browser test runner).
 */
export function getBraindumpSessionId(companyId: string): string {
  const storageKey = SESSION_STORAGE_KEY(companyId);
  try {
    const existing = localStorage.getItem(storageKey);
    if (existing) return existing;
    const next = crypto.randomUUID();
    localStorage.setItem(storageKey, next);
    return next;
  } catch {
    let id = fallbackSessionIds.get(companyId);
    if (!id) {
      id = crypto.randomUUID();
      fallbackSessionIds.set(companyId, id);
    }
    return id;
  }
}

/**
 * Ends the current braindump run. Called once the founder finishes the
 * Librarian review — the next braindump then starts a fresh run rather than
 * reusing these captures' idempotency keys (which would return the OLD capture
 * instead of creating a new one).
 */
export function clearBraindumpSessionId(companyId: string): void {
  try {
    localStorage.removeItem(SESSION_STORAGE_KEY(companyId));
  } catch {
    // Storage unavailable — the in-memory fallback id dies with the page.
  }
  fallbackSessionIds.delete(companyId);
}

/**
 * Idempotency key for one scope's braindump within the current onboarding
 * session. Stable across resubmits of the SAME (scope, session) pair — a
 * double-click on Submit, or a re-render triggered by an unrelated state
 * change, reuses the same `braindump_captures` row instead of creating a
 * duplicate capture / double-dispatching the Librarian.
 *
 * `departmentId` is null for the company-wide card; we key it as "company" so
 * the company card and a department card can never collide. Server-side
 * uniqueness is per (company, department, key) / (company, key) via two
 * partial indexes, so the key only needs to be unique per session.
 */
export function braindumpIdempotencyKey(
  companyId: string,
  departmentId: string | null,
): string {
  return `${departmentId ?? "company"}:${getBraindumpSessionId(companyId)}`;
}
