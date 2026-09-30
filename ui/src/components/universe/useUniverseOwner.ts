import { useEffect } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { authApi, type AuthSession } from "../../api/auth";
import { clearForeignLayoutJournals } from "./layout-journal";
import { queryKeys } from "../../lib/queryKeys";

export function universeOwnerKey(session: AuthSession | null | undefined): string | null {
  if (!session?.user.id || !session.session.id || session.session.userId !== session.user.id) return null;
  return JSON.stringify([session.user.id, session.session.id]);
}

const observedClients = new WeakSet<QueryClient>();
function observeIdentity(qc: QueryClient) {
  if (observedClients.has(qc)) return;
  observedClients.add(qc);
  // One listener per QueryClient remains active when the Universe view unmounts,
  // so signing out elsewhere still clears this tab's private recovery data.
  qc.getQueryCache().subscribe(event => {
    if (JSON.stringify(event.query.queryKey) !== JSON.stringify(queryKeys.auth.session)) return;
    if (event.type !== "removed" && event.query.state.status !== "success") return;
    const identity = event.type === "removed" ? null
      : universeOwnerKey(event.query.state.data as AuthSession | null);
    try {clearForeignLayoutJournals(sessionStorage, identity);} catch { /* Storage may be disabled. */ }
    qc.removeQueries({predicate: q => (q.queryKey[0] === "universe-layout" || q.queryKey[0] === "universe-draft") && q.queryKey[1] !== identity});
  });
}

/** Identity comes from the authenticated session, never a body/caller user ID. */
export function useUniverseOwner() {
  const qc = useQueryClient();
  useEffect(() => {observeIdentity(qc);}, [qc]);
  const auth = useQuery({queryKey: queryKeys.auth.session, queryFn: authApi.getSession, retry: false});
  const identity = universeOwnerKey(auth.data);
  const isSameIdentity = () => identity !== null &&
    universeOwnerKey(qc.getQueryData<AuthSession | null>(queryKeys.auth.session)) === identity;
  const isCurrent = () => isSameIdentity() && qc.getQueryState(queryKeys.auth.session)?.status === "success";
  const assertCurrent = () => {
    if (!isCurrent()) throw new Error("Universe owner session changed");
  };
  return {identity, userId: auth.data?.user.id ?? null, isCurrent, isSameIdentity, assertCurrent, isLoading: auth.isLoading, isVerified: auth.isSuccess};
}
