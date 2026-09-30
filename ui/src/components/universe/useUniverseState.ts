import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { universeLayoutDocumentSchema, layoutPatchSchema, UNIVERSE_LAYOUT_SCHEMA_VERSION, type LayoutOp, type LayoutPatch, type LayoutAck } from "@armyofagents/shared";
import { ApiError } from "../../api/client";
import { universeLayoutApi, type UniverseLayoutResponse } from "../../api/universe-layout";
import { readLayoutJournal, writeLayoutJournal, clearForeignLayoutJournals } from "./layout-journal";
import type {LayoutEditContext} from "./layout-adapter";
import {captureWitnesses, canRebaseLayout, type RebaseWitnesses} from "./layout-rebase";
import { useUniverseOwner } from "./useUniverseOwner";
import { queryKeys } from "../../lib/queryKeys";

export type UniverseSaveStatus = "idle" | "saving" | "saved" | "offline" | "conflict" | "blocked";
type Session = {
  hydrated: boolean;
  controller: AbortController | null;
  corruptRecovery: boolean;
  exportedRecovery?: boolean;
  recoveryError: string | null;
  rejectedEdit: LayoutOp[] | null;
  rejectedGroup?: {operations: LayoutOp[]; baseRevision: number; witnesses?: RebaseWitnesses; context?: LayoutEditContext};
  pending: { operations: LayoutOp[]; baseRevision: number; witnesses?: RebaseWitnesses; context?: LayoutEditContext }[];
  uncertain: LayoutPatch | null;
  uncertainWitnesses?: RebaseWitnesses;
  uncertainContext?: LayoutEditContext;
  conflict: LayoutPatch | null;
  flight: Promise<LayoutAck | undefined> | null;
  timer: ReturnType<typeof setTimeout> | null;
  status: UniverseSaveStatus;
  revisionFloor: number;
  resolvedRemoteBase: number;
};

async function readSnapshot(companyId: string, conversationId: string, signal?: AbortSignal): Promise<UniverseLayoutResponse> {
  const result = await universeLayoutApi.get(companyId, conversationId, signal);
  if (result.schemaVersion !== 1 || !Number.isSafeInteger(result.revision) || result.revision < 0) throw new Error("Unsupported layout snapshot version or revision");
  return {...result, document: universeLayoutDocumentSchema.parse(result.document)};
}

function fitsPatch(operations: LayoutOp[]) {
  return layoutPatchSchema.safeParse({schemaVersion: 1, operationId: "x".repeat(256),
    expectedRevision: Number.MAX_SAFE_INTEGER, operations}).success;
}
function validateAtomicGroup(operations: LayoutOp[]) {
  if (operations.length && !fitsPatch(operations)) throw new Error("Atomic layout edit exceeds the valid operation or byte budget");
}

/** Owner/session-scoped queue with tab-only recovery. Unknown replies retain
 * their exact identity; same-property conflicts require explicit resolution. */
export function useUniverseState(
  companyId: string | null | undefined,
  conversationId: string | null | undefined,
  options?: { debounceMs?: number; onAcknowledged?: (patch: LayoutPatch, ack: LayoutAck, context?: LayoutEditContext) => void },
) {
  const qc = useQueryClient();
  const callbacks = useRef(options);
  callbacks.current = options;
  const owner = useUniverseOwner();
  const enabled = owner.isVerified && !!owner.identity && !!companyId && !!conversationId;
  const key = queryKeys.universeLayout(companyId ?? "", conversationId ?? "", owner.identity ?? "");
  const scope = JSON.stringify([owner.identity, companyId, conversationId]);
  const sessions = useRef(new Map<string, Session>());
  const previousOwner = useRef(owner.identity);
  useEffect(() => {
    if (owner.isVerified) {
      try { clearForeignLayoutJournals(sessionStorage, owner.identity); }
      catch { /* Actual writes surface denied storage as a recoverable blocked state. */ }
    }
  }, [owner.identity, owner.isVerified]);
  useEffect(() => {
    if (previousOwner.current !== owner.identity) {
      const oldOwner = previousOwner.current;
      for (const entry of sessions.current.values()) if (entry.timer) clearTimeout(entry.timer);
      for (const entryKey of sessions.current.keys()) if (JSON.parse(entryKey)[0] !== owner.identity) sessions.current.delete(entryKey);
      if (oldOwner) qc.removeQueries({queryKey: ["universe-layout", oldOwner]});
      previousOwner.current = owner.identity;
    }
  }, [owner.identity, qc]);
  let session = sessions.current.get(scope);
  if (!session) {
    session = { hydrated: false, controller: null, corruptRecovery: false, recoveryError: null, rejectedEdit: null, pending: [], uncertain: null, conflict: null, flight: null, timer: null, status: "idle", revisionFloor: 0, resolvedRemoteBase: 0 };
    sessions.current.set(scope, session);
  }
  if (enabled && !session.hydrated) {
      session.hydrated = true;
      try {
        const recovered = readLayoutJournal(sessionStorage, scope);
        if (recovered) { Object.assign(session, recovered); session.status = recovered.conflict ? "conflict" : "offline"; }
      } catch (error) {session.corruptRecovery = true; session.recoveryError = String(error); session.status = "blocked";}
  }
  const state = session;
  const active = useRef<Session | null>(state);
  const [, render] = useState(0);
  useEffect(() => {
    active.current = state;
    return () => {
      active.current = null;
      state.controller?.abort();
      void qc.cancelQueries({queryKey: key});
      qc.removeQueries({queryKey: key});
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
    };
  }, [state]);
  const publish = useCallback((status: UniverseSaveStatus) => {
    state.status = status;
    if (active.current === state) render((value) => value + 1);
  }, [state]);
  const persist = useCallback(() => {
    owner.assertCurrent();
    try {
      writeLayoutJournal(sessionStorage, scope, state);
      state.recoveryError = null;
    } catch (error) {
      state.recoveryError = String(error);
      publish("blocked");
      throw error;
    }
  }, [state, scope, owner.identity, publish]);
  const query = useQuery({
    queryKey: key,
    refetchOnMount: "always",
    queryFn: async ({signal}) => {
      owner.assertCurrent();
      const result = await readSnapshot(companyId as string, conversationId as string, signal);
      owner.assertCurrent();
      return result;
    },
    enabled,
  });

  const flush = useCallback((): Promise<LayoutAck | undefined> => {
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    if (state.flight) return state.flight;
    if (!enabled || !owner.isCurrent() || active.current !== state || state.conflict || state.recoveryError) return Promise.resolve(undefined);
    const controller = new AbortController();
    state.controller = controller;
    const assertActive = () => {owner.assertCurrent(); controller.signal.throwIfAborted();};
    const run = async () => {
      let lastAck: LayoutAck | undefined;
      while (state.uncertain || state.pending.length) {
        assertActive();
        publish("saving");
        let patch = state.uncertain;
        try {
          let ack: LayoutAck | undefined;
          if (patch) {
            try {
              ack = await universeLayoutApi.receipt(companyId!, conversationId!, patch.operationId, controller.signal);
              assertActive();
            } catch (err) {
              if (err instanceof ApiError && err.status === 409) {
                state.uncertain = null;
                state.conflict = patch;
                state.uncertainWitnesses = undefined;
                state.uncertainContext = undefined;
                persist();
                publish("conflict");
                await qc.invalidateQueries({ queryKey: key });
                throw err;
              }
              if (!(err instanceof ApiError && err.status === 404)) throw err;
              assertActive();
              const snapshot = await readSnapshot(companyId!, conversationId!, controller.signal);
              assertActive();
              if (snapshot.revision < Math.max(state.revisionFloor, patch.expectedRevision)) throw new Error("Layout snapshot is older than the pending operation");
              qc.setQueryData(key, snapshot);
              if (snapshot.revision > patch.expectedRevision) {
                // The first missing receipt can race a commit. Once a newer CAS
                // revision is observed the old request cannot newly commit, but
                // it may already have committed: look up its receipt again.
                try {
                  ack = await universeLayoutApi.receipt(companyId!, conversationId!, patch.operationId, controller.signal);
                  assertActive();
                } catch (lookupError) {
                  if (!(lookupError instanceof ApiError && lookupError.status === 404)) throw lookupError;
                  assertActive();
                  if (patch.expectedRevision >= state.resolvedRemoteBase &&
                      canRebaseLayout(patch.operations, state.uncertainWitnesses, snapshot.document)) {
                    patch = {...patch, operationId: crypto.randomUUID(), expectedRevision: snapshot.revision};
                    state.resolvedRemoteBase = Math.max(state.resolvedRemoteBase, snapshot.revision);
                    state.uncertainWitnesses = captureWitnesses(snapshot.document, patch.operations);
                  } else {
                    state.conflict = patch;
                    state.uncertain = null;
                    state.uncertainWitnesses = undefined;
                    state.uncertainContext = undefined;
                    persist();
                    publish("conflict");
                    throw new ApiError("Layout changed while the save outcome was being checked", 409, null);
                  }
                }
              }
            }
          } else {
            // A fresh read is required before each new request, including after
            // a confirmed receipt. Failed/stale reads never drain the queue.
            const snapshot = await readSnapshot(companyId!, conversationId!, controller.signal);
            assertActive();
            if (snapshot.revision < state.revisionFloor) throw new Error("Layout snapshot is older than its acknowledged revision");
            qc.setQueryData(key, snapshot);
            const first = state.pending[0]!;
            const operations: LayoutOp[] = [];
            const witnesses: RebaseWitnesses = [];
            while (state.pending.length && state.pending[0]!.baseRevision === first.baseRevision &&
                   operations.length + state.pending[0]!.operations.length <= 50) {
              if (operations.length && (first.context || state.pending[0]!.context)) break;
              const candidate = [...operations, ...state.pending[0]!.operations];
              if (!fitsPatch(candidate)) break;
              const group = state.pending.shift()!;
              operations.push(...group.operations);
              witnesses.push(...(group.witnesses ?? group.operations.map(() => null)));
            }
            state.uncertainWitnesses = witnesses;
            state.uncertainContext = first.context;
            patch = {
              schemaVersion: UNIVERSE_LAYOUT_SCHEMA_VERSION,
              operationId: crypto.randomUUID(),
              expectedRevision: first.baseRevision < state.resolvedRemoteBase
                ? first.baseRevision
                : Math.max(first.baseRevision, state.revisionFloor),
              operations,
            };
            if (snapshot.revision > patch.expectedRevision && first.baseRevision >= state.resolvedRemoteBase &&
                canRebaseLayout(operations, witnesses, snapshot.document)) {
              patch.expectedRevision = snapshot.revision;
              // Only this checked batch adopts the remote base. Later old-base
              // groups must not inherit its acknowledgement without review.
              state.resolvedRemoteBase = Math.max(state.resolvedRemoteBase, snapshot.revision);
            }
            if (snapshot.revision !== patch.expectedRevision) {
              state.conflict = patch;
              state.uncertainWitnesses = undefined;
              state.uncertainContext = undefined;
              persist();
              publish("conflict");
              throw new ApiError("Layout changed while gestures were queued", 409, null);
            }
          }
          try {
            assertActive();
            state.uncertain = patch;
            persist(); // Write ahead: reload can reconcile this exact identity.
            ack ??= await universeLayoutApi.apply(companyId!, conversationId!, patch, controller.signal);
            assertActive();
          } catch (err) {
            if (err instanceof ApiError && err.status === 409) {
              state.uncertain = null;
              state.conflict = patch;
              state.uncertainWitnesses = undefined;
              state.uncertainContext = undefined;
              persist();
              publish("conflict");
              await qc.invalidateQueries({ queryKey: key });
              throw err;
            }
            throw err;
          }
          const completedContext = state.uncertainContext;
          state.uncertain = null;
          state.uncertainWitnesses = undefined;
          state.uncertainContext = undefined;
          state.revisionFloor = Math.max(state.revisionFloor, ack.revision);
          persist();
          lastAck = ack;
          try { callbacks.current?.onAcknowledged?.(patch, ack, completedContext); }
          catch (error) {
            state.recoveryError = `Layout saved but its display could not reconcile: ${String(error)}`;
            publish("blocked");
            return ack;
          }
          await qc.invalidateQueries({ queryKey: key });
        } catch (err) {
          if (owner.isCurrent() && !state.conflict) {
            if (patch) state.uncertain = patch;
            try {persist();} catch { /* Retain the in-memory patch for export. */ }
            if (!state.recoveryError) publish("offline");
          }
          throw err;
        }
      }
      if (lastAck) publish(state.rejectedEdit ? "blocked" : "saved");
      return lastAck;
    };
    const flight = run().finally(() => { if (state.flight === flight) state.flight = null; });
    state.flight = flight;
    return flight;
  }, [companyId, conversationId, enabled, key, qc, state, publish, owner.identity, persist]);

  const queueOps = useCallback((ops: LayoutOp[], flushNow = false, context?: LayoutEditContext, renderedBase?: Pick<UniverseLayoutResponse, "revision" | "document">) => {
    validateAtomicGroup(ops);
    const baseline = qc.getQueryData<UniverseLayoutResponse>(key);
    if (!enabled || !owner.isCurrent() || active.current !== state || !baseline) throw new Error("Load the authorized layout before editing");
    if (state.recoveryError) throw new Error(state.recoveryError);
    if (renderedBase && (!Number.isSafeInteger(renderedBase.revision) || renderedBase.revision < 0)) throw new Error("Invalid rendered layout revision");
    const editBase = renderedBase ?? baseline;
    if (renderedBase) universeLayoutDocumentSchema.parse(renderedBase.document);
    if (ops.length) {
      const group = {operations: structuredClone(ops), baseRevision: editBase.revision, witnesses: captureWitnesses(editBase.document, ops), ...(context ? {context: structuredClone(context)} : {})};
      try {writeLayoutJournal(sessionStorage, scope, {...state, pending: [...state.pending, group]});}
      catch (error) {
        state.rejectedEdit = structuredClone(ops);
        state.rejectedGroup = group;
        state.recoveryError = String(error);
        publish("blocked");
        throw error;
      }
      state.pending.push(group);
      publish("idle");
    }
    if (flushNow) return flush();
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => { void flush().catch(() => undefined); }, options?.debounceMs ?? 250);
    return undefined;
  }, [state, flush, options?.debounceMs, qc, key, enabled, owner.identity, scope, publish]);

  // The caller supplies the reviewed replacement for the quarantined patch.
  // Later queued gestures remain queued; resolving does not silently discard them.
  const resolveConflict = useCallback(async (operations: LayoutOp[], reviewedRevision?: number) => {
    owner.assertCurrent();
    validateAtomicGroup(operations);
    if (active.current !== state) throw new Error("Universe layout scope changed");
    const conflict = state.conflict;
    if (!conflict) return undefined;
    // Resolution must not mutate a still-settling flight's conflict marker.
    await state.flight?.catch(() => undefined);
    const snapshot = await readSnapshot(companyId!, conversationId!);
    owner.assertCurrent();
    if (active.current !== state || state.conflict !== conflict) return undefined;
    if (snapshot.revision < state.revisionFloor) throw new Error("Cannot resolve against an older layout revision");
    if (reviewedRevision !== undefined && snapshot.revision !== reviewedRevision) {
      qc.setQueryData(key, snapshot);
      publish("conflict");
      throw new Error("The saved layout changed again. Review the latest version before choosing.");
    }
    // Only the explicitly reviewed replacement adopts this remote base. Older
    // queued groups must still conflict, even after the replacement is saved.
    state.resolvedRemoteBase = Math.max(state.resolvedRemoteBase, snapshot.revision);
    qc.setQueryData(key, snapshot);
    if (operations.length) state.pending.unshift({operations: structuredClone(operations), baseRevision: snapshot.revision, witnesses: captureWitnesses(snapshot.document, operations)});
    state.conflict = null;
    persist();
    publish("idle");
    return flush();
  }, [state, flush, companyId, conversationId, qc, key, publish, owner.identity, persist]);

  const retryRecovery = async () => {
    owner.assertCurrent();
    if (active.current !== state) throw new Error("Universe layout scope changed");
    if (state.corruptRecovery) throw new Error("Export the invalid recovery journal before explicitly discarding it");
    persist();
    await flush();
    owner.assertCurrent();
    if (active.current !== state) throw new Error("Universe layout scope changed");
    if (!state.conflict && state.rejectedEdit) {
      // Keep the original rendered revision, witnesses and opening context.
      // A refreshed query must not promote a rejected gesture to a newer base.
      const group = state.rejectedGroup;
      if (!group) throw new Error("Rejected layout edit needs explicit recovery");
      try {writeLayoutJournal(sessionStorage, scope, {...state, pending: [...state.pending, group]});}
      catch (cause) {
        state.recoveryError = String(cause);
        publish("blocked");
        throw cause;
      }
      state.pending.push(group);
      state.rejectedEdit = null;
      state.rejectedGroup = undefined;
      await flush();
    }
  };
  return {
    assertEditable: () => {
      owner.assertCurrent();
      if (!enabled || active.current !== state || !qc.getQueryData(key)) throw new Error("Load the authorized layout before editing");
      if (state.recoveryError) throw new Error(state.recoveryError);
    },
    ownerIdentity: owner.identity,
    ownerUserId: owner.identity ? JSON.parse(owner.identity)[0] as string : null,
    hasPending: !!(state.pending.length || state.uncertain || state.conflict || state.rejectedEdit || state.recoveryError),
    acknowledgedFloor: state.revisionFloor,
    corruptRecovery: state.corruptRecovery,
    discardInvalidRecovery: () => {
      owner.assertCurrent();
      if (active.current !== state || !state.corruptRecovery || !state.exportedRecovery) throw new Error("Export this invalid recovery before discarding it");
      sessionStorage.removeItem("aoa:universe:layout:v1:" + scope);
      state.corruptRecovery = false;
      state.recoveryError = null;
      publish("idle");
    },
    document: enabled && !query.isError && query.isFetchedAfterMount ? query.data?.document : undefined,
    revision: query.data?.revision ?? 0,
    schemaVersion: query.data?.schemaVersion ?? UNIVERSE_LAYOUT_SCHEMA_VERSION,
    isLoading: owner.isLoading || query.isLoading,
    isError: query.isError,
    status: state.status,
    conflictingPatch: state.conflict,
    recoveryError: state.recoveryError,
    exportRecovery: () => {
      owner.assertCurrent();
      const exported = JSON.stringify({scope, rawRecovery: state.corruptRecovery ? sessionStorage.getItem("aoa:universe:layout:v1:" + scope) : undefined, pending: state.pending, uncertain: state.uncertain, conflict: state.conflict,
        rejectedEdit: state.rejectedEdit, rejectedGroup: state.rejectedGroup, revisionFloor: state.revisionFloor, resolvedRemoteBase: state.resolvedRemoteBase});
      state.exportedRecovery = true;
      return exported;
    },
    queueOps, flush, resolveConflict, retryRecovery,
    refetch: query.refetch,
  };
}
