const BASE = "/api";

export interface ApiFieldError {
  field: string;
  id: string;
  message: string;
}

export class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }

  /**
   * If this is a 422 with a `{ details: { field, id } }` body (the shape the
   * server emits when an FK reference is invalid), return the field/id/message
   * tuple so callers can render an inline error against the offending input.
   */
  get fieldError(): ApiFieldError | null {
    if (this.status !== 422) return null;
    const body = this.body;
    if (!body || typeof body !== "object") return null;
    const details = (body as { details?: unknown }).details;
    if (!details || typeof details !== "object") return null;
    const { field, id } = details as { field?: unknown; id?: unknown };
    if (typeof field !== "string" || typeof id !== "string") return null;
    return { field, id, message: this.message };
  }
}

/**
 * True when `err` is an {@link ApiError} carrying HTTP 403 — i.e. the caller
 * is authenticated but not authorized for the requested resource. Shared so
 * company-scoped surfaces can render a friendly access-required state instead
 * of the generic error UI. (Instance-admin 403 handling keeps its own local
 * check in InstanceSettingsPage.)
 */
export function isForbidden(err: unknown): boolean {
  return err instanceof ApiError && err.status === 403;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers ?? undefined);
  const body = init?.body;
  if (!(body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(`${BASE}${path}`, {
    headers,
    credentials: "include",
    ...init,
  });
  if (!res.ok) {
    const errorBody = await res.json().catch(() => null);
    // B3.3: surface the most informative message available so save-failure
    // toasts and other error UIs show what actually went wrong server-side
    // rather than a generic "Request failed: 400". The AoA server emits
    // `{ error: <msg> }` (see `server/src/middleware/error-handler.ts`); the
    // `message` fallback is defensive against responses produced by routes
    // that bypass the middleware or by upstream proxies.
    const body = errorBody as { error?: string; message?: string } | null;
    const msg = body?.error ?? body?.message ?? `Request failed: ${res.status}`;
    throw new ApiError(msg, res.status, errorBody);
  }
  // Codex P2-2: 204 No Content has an empty body. Calling res.json() on an
  // empty body throws SyntaxError "Unexpected end of JSON input", which would
  // surface to callers as a failed request despite the server having succeeded.
  // Affects DELETE routes that respond with res.status(204).end() — e.g.
  // archive (DELETE /teams/:id) and removeMember (DELETE /teams/:id/members/:agentId).
  // Resolve as `undefined` (cast through `T`) so `api.delete<void>` works as
  // intended and `api.delete<X>` callers see undefined rather than a parse error.
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body) }),
  postForm: <T>(path: string, body: FormData) =>
    request<T>(path, { method: "POST", body }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PUT", body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};
