/**
 * Returns `id` if it exists in `validIds`, otherwise `""`.
 *
 * Used when rehydrating persisted form drafts (e.g. from localStorage) to
 * drop references to entities that have since been deleted on the server.
 * Sending a stale foreign-key id otherwise produces an opaque 404 from the
 * create endpoint with no actionable error for the user.
 */
export function pruneStaleId(
  id: string | null | undefined,
  validIds: ReadonlySet<string>,
): string {
  if (!id) return "";
  return validIds.has(id) ? id : "";
}
