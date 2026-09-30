import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  UNIVERSE_DRAFT_SCHEMA_VERSION,
  type UniverseDraft,
  type UniverseDraftDestination,
} from "@armyofagents/shared";
import { ApiError } from "../../api/client";
import { universeDraftApi } from "../../api/universe-draft";
import { commanderConversationsApi } from "../../api/internal-agent";
import { issuesApi } from "../../api/issues";
import { queryKeys } from "../../lib/queryKeys";
import { useUniverseOwner } from "./useUniverseOwner";
import { afterAcknowledgement, type SentSnapshot } from "./draft-state";

export type DraftSaveStatus =
  | "idle"
  | "saving"
  | "saved"
  | "offline"
  | "conflict";

const EMPTY: UniverseDraft = { revision: 0, text: "", attachmentAssetIds: [] };

/**
 * E1.3 client layer for a single destination-scoped draft. Keeps the
 * server-acknowledged draft (React Query) and debounces edits; save status
 * reflects the server. A 409 refreshes the acknowledged cache; the local Send
 * candidate is retained, but conflict-resolution UI is not implemented. A
 * network failure keeps the newest queued edit for retry. `submitSnapshot`
 * freezes the draft for Send and `acknowledge` clears exactly the sent snapshot
 * after a durable ack (keeping anything typed since). The actual send calls the
 * destination's own client (Commander/task) — wired by E1.5/E2.4, not here.
 */
export function useUniverseDraft(
  companyId: string | null | undefined,
  conversationId: string | null | undefined,
  destination: UniverseDraftDestination,
  options?: { debounceMs?: number },
) {
  const qc = useQueryClient();
  const owner = useUniverseOwner();
  const enabled = owner.isVerified && !!owner.identity && !!companyId && !!conversationId;
  const key = queryKeys.universeDraft(
    companyId ?? "",
    conversationId ?? "",
    destination.kind,
    destination.id,
    owner.identity ?? "",
  );
  const debounceMs = options?.debounceMs ?? 400;

  const query = useQuery({
    queryKey: key,
    refetchOnMount: "always",
    queryFn: async ({signal}) => {
      owner.assertCurrent();
      const value = await universeDraftApi.get(companyId as string, conversationId as string, destination, signal);
      owner.assertCurrent();
      return value;
    },
    enabled,
  });

  const [status, setStatus] = useState<DraftSaveStatus>("idle");
  const pending = useRef<{ text: string; attachmentAssetIds: string[] } | null>(
    null,
  );
  // Keep the editor candidate separate from the acknowledged query cache. A
  // save removes pending work while the network is in flight, but Send must
  // still see what the user typed. Scope tags prevent another destination from
  // borrowing this candidate.
  const scope = JSON.stringify([
    owner.identity, companyId, conversationId, destination.kind, destination.id,
  ]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const local = useRef<{
    scope: string;
    value: { text: string; attachmentAssetIds: string[] };
  } | null>(null);
  const draftSessions = useRef(new Map<string, {pending: typeof pending.current; local: typeof local.current}>());
  const controllers = useRef(new Set<AbortController>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    for (const savedScope of draftSessions.current.keys()) {
      if (JSON.parse(savedScope)[0] !== owner.identity) draftSessions.current.delete(savedScope);
    }
    const recovered = draftSessions.current.get(scope);
    pending.current = recovered?.pending ?? null;
    local.current = recovered?.local ?? null;
    setStatus(pending.current ? "offline" : "idle");
    return () => {
      if (owner.isSameIdentity()) draftSessions.current.set(scope, {
        pending: pending.current ?? local.current?.value ?? null, local: local.current,
      });
      if (timer.current) clearTimeout(timer.current);
      for (const controller of controllers.current) controller.abort();
      controllers.current.clear();
      void qc.cancelQueries({queryKey: key});
      qc.removeQueries({queryKey: key});
    };
  }, [scope]);
  const assertScope = () => {
    owner.assertCurrent();
    if (currentScope.current !== scope) throw new Error("Universe draft scope changed");
  };
  const flush = useCallback(async () => {
    assertScope();
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const next = pending.current;
    if (!enabled || !next) return undefined;
    pending.current = null;
    const current = qc.getQueryData<UniverseDraft>(key);
    setStatus("saving");
    const controller = new AbortController();
    controllers.current.add(controller);
    try {
      const saved = await universeDraftApi.save(
        companyId as string,
        conversationId as string,
        destination,
        {
          schemaVersion: UNIVERSE_DRAFT_SCHEMA_VERSION,
          expectedRevision: current?.revision ?? 0,
          text: next.text,
          attachmentAssetIds: next.attachmentAssetIds,
        },
        controller.signal,
      );
      controller.signal.throwIfAborted();
      assertScope();
      qc.setQueryData(key, saved);
      if (local.current?.value === next) local.current = null;
      setStatus("saved");
      return saved;
    } catch (err) {
      if (!owner.isCurrent() || currentScope.current !== scope) throw err;
      if (err instanceof ApiError && err.status === 409) {
        await qc.invalidateQueries({ queryKey: key });
        assertScope();
        setStatus("conflict");
      } else {
        pending.current ??= next;
        setStatus("offline");
      }
      throw err;
    } finally {controllers.current.delete(controller);}
  }, [companyId, conversationId, destination, enabled, key, qc, scope]);

  const save = useCallback(
    (text: string, attachmentAssetIds: string[], flushNow = false) => {
      assertScope();
      if (!enabled || !qc.getQueryData(key)) throw new Error("Load the authorized draft before editing");
      pending.current = { text, attachmentAssetIds: [...attachmentAssetIds] };
      local.current = { scope, value: pending.current };
      if (flushNow) return flush();
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        void flush().catch(() => undefined);
      }, debounceMs);
      return undefined;
    },
    [flush, debounceMs, scope, enabled, qc, key],
  );

  const submitSnapshot = useCallback(
    (clientSubmissionId: string): SentSnapshot | null => {
      if (!enabled || !owner.isCurrent()) return null;
      const current = qc.getQueryData<UniverseDraft>(key) ?? EMPTY;
      const candidate = local.current?.scope === scope ? local.current.value : current;
      return {
        revision: current.revision,
        text: candidate.text,
        attachmentAssetIds: [...candidate.attachmentAssetIds],
        clientSubmissionId,
      };
    },
    [qc, key, scope, enabled],
  );

  const acknowledge = useCallback(
    (sent: SentSnapshot) => {
      assertScope();
      const current = qc.getQueryData<UniverseDraft>(key) ?? EMPTY;
      const candidate = {
        ...current,
        ...(local.current?.scope === scope ? local.current.value : {}),
      };
      const next = afterAcknowledgement(candidate, sent);
      // Only persist when the acknowledged snapshot was cleared; if the user kept
      // typing, the newer draft is left untouched.
      if (next === candidate) return undefined;
      return save(next.text, next.attachmentAssetIds, true);
    },
    [qc, key, save, scope],
  );

  const recoverCommanderSubmission = useCallback(async (sent: SentSnapshot) => {
    assertScope();
    if (destination.kind !== "commander") throw new Error("Commander recovery requires a Commander destination");
    if (!companyId || !conversationId) return { state: "not_found" } as const;
    const outcome = await commanderConversationsApi.getSubmissionOutcome(
      companyId,
      conversationId,
      sent.clientSubmissionId,
    );
    assertScope();
    if (outcome.state === "accepted" || outcome.state === "completed") await acknowledge(sent);
    return outcome;
  }, [acknowledge, companyId, conversationId, destination.kind, scope]);

  const recoverSubmission = useCallback(async (sent: SentSnapshot) => {
    assertScope();
    if (destination.kind === "commander") return recoverCommanderSubmission(sent);
    if (destination.kind !== "task") throw new Error("This destination does not yet expose a canonical submission receipt");
    const outcome = await issuesApi.getCommentSubmissionOutcome(destination.id, sent.clientSubmissionId);
    assertScope();
    if (outcome.state === "completed") await acknowledge(sent);
    return outcome;
  }, [acknowledge, destination, recoverCommanderSubmission, scope]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return {
    draft: enabled && !query.isError && query.isFetchedAfterMount ? query.data ?? EMPTY : EMPTY,
    revision: query.data?.revision ?? 0,
    isLoading: owner.isLoading || query.isLoading,
    status,
    save,
    flush,
    submitSnapshot,
    acknowledge,
    recoverCommanderSubmission,
    recoverSubmission,
    refetch: query.refetch,
  };
}
