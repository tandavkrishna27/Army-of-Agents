import {layoutPatchSchema, universeLayoutDocumentSchema} from "@armyofagents/shared";
import {forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState} from "react";
import {UniverseWorkspace, type WorkspaceHandle, type WorkspaceProps} from "./UniverseWorkspace";
import {UniverseLayoutRecovery} from "./UniverseLayoutRecovery";
import {layoutEdit, documentFromState} from "./layout-adapter";
import {useUniverseState} from "./useUniverseState";
import type {AuthorizedLayoutSnapshot} from "./panel-state";

type Props = Pick<WorkspaceProps, "content" | "resolveContent" | "onStateObserved" | "onViewportObserved" | "motion" | "motionMode" | "initialAutoTile"> & {companyId: string; conversationId: string};
/** Persistence boundary for the authorized Universe route. The route supplies
 * already-authorized renderers; this boundary owns layout recovery, not execution. */
export const PersistedUniverseWorkspace = forwardRef<WorkspaceHandle, Props>(function PersistedUniverseWorkspace(props, forwardedRef) {
  const frame = useRef<WorkspaceHandle | null>(null);
  const epoch = useRef(crypto.randomUUID());
  const hydrated = useRef(-1);
  const recoveredScope = useRef<string | null>(null);
  const savedCamera = useRef({x: 0, y: 0, zoom: 1});
  const [interactionEnded, setInteractionEnded] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const layout = useUniverseState(props.companyId, props.conversationId, {
    onAcknowledged: (patch, ack, context) => {
      if (!frame.current || !context || context.epoch !== epoch.current) return;
      const scope = frame.current.getState().scope;
      frame.current.reconcile({...ack, scope}, context.openings.map(opening => ({...opening, scope, operationId: patch.operationId})));
    },
  });
  const snapshot = useMemo<AuthorizedLayoutSnapshot | null>(() => layout.document && layout.ownerUserId ? {
    ...layout.document, schemaVersion: 1, revision: layout.revision,
    scope: {companyId: props.companyId, userId: layout.ownerUserId, conversationId: props.conversationId},
  } : null, [layout.document, layout.revision, layout.ownerUserId, props.companyId, props.conversationId]);
  const attach = useCallback((node: WorkspaceHandle | null) => {
    frame.current = node;
    // React refreshes imperative handles during normal commits; only a real
    // unmount invalidates the local generation epoch.
    if (!node) queueMicrotask(() => {if (!frame.current) {epoch.current = crypto.randomUUID(); hydrated.current = -1;}});
  }, []);
  const requireFrame = () => {if (!frame.current) throw new Error("Load the authorized workspace first"); return frame.current;};
  useImperativeHandle(forwardedRef, () => ({
    dispatch: action => requireFrame().dispatch(action), open: (entry, policy) => requireFrame().open(entry, policy),
    getState: () => requireFrame().getState(), isInteracting: () => requireFrame().isInteracting(), getViewport: () => requireFrame().getViewport(),
    setViewport: viewport => requireFrame().setViewport(viewport), undo: () => requireFrame().undo(), redo: () => requireFrame().redo(),
    arrange: () => requireFrame().arrange(), fit: () => requireFrame().fit(), setAutoTile: on => requireFrame().setAutoTile(on),
    requestNavigation: intent => requireFrame().requestNavigation(intent),
    hydrate: () => {throw new Error("Reload through the authorized layout query");},
    refresh: () => {throw new Error("Reload through the authorized layout query");},
    reconcile: () => {throw new Error("Receipts are reconciled by the persistence queue");},
  }));
  useEffect(() => {
    if (!snapshot || !frame.current || frame.current.isInteracting() || layout.hasPending || snapshot.revision < layout.acknowledgedFloor || hydrated.current === snapshot.revision) return;
    frame.current.refresh(snapshot);
    savedCamera.current = {...snapshot.viewport};
    hydrated.current = snapshot.revision;
  }, [snapshot, layout.hasPending, layout.acknowledgedFloor, interactionEnded]);
  useEffect(() => {if (!layout.hasPending && (layout.status === "saved" || layout.status === "idle")) setError(null);}, [layout.hasPending, layout.status]);
  const report = (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause));
  useEffect(() => {
    if (!snapshot) return;
    const scope = JSON.stringify([layout.ownerIdentity, props.companyId, props.conversationId]);
    if (recoveredScope.current === scope) return;
    recoveredScope.current = scope;
    if (layout.hasPending && !layout.corruptRecovery && !layout.conflictingPatch)
      void layout.retryRecovery().catch(report);
  }, [snapshot, layout.ownerIdentity, props.companyId, props.conversationId]);
  return <section className="universe-persistence" aria-label="Universe workspace">
    <div role="status" aria-label="Layout save status" aria-live="polite">{{idle: "Ready", saving: "Saving", saved: "Saved", offline: "Offline — changes kept in this tab", conflict: "Layout conflict — review required", blocked: "Layout recovery needs attention"}[layout.status]}</div>
    {(error || layout.recoveryError) && <p role="alert">{error ?? layout.recoveryError}</p>}
    <UniverseLayoutRecovery key={"recovery:" + JSON.stringify([layout.ownerIdentity, props.companyId, props.conversationId])} layout={layout}/>
    {!snapshot ? <p role={layout.isError ? "alert" : "status"}>{layout.isError ? "Layout is unavailable. Your recovery data has been kept." : "Loading your workspace…"}</p> :
      <UniverseWorkspace key={JSON.stringify([layout.ownerIdentity, props.companyId, props.conversationId])} ref={attach}
        scope={snapshot.scope} initialLayout={snapshot} content={props.content} resolveContent={props.resolveContent} motion={props.motion} motionMode={props.motionMode} initialAutoTile={props.initialAutoTile}
        onStateObserved={props.onStateObserved}
        onViewportObserved={props.onViewportObserved}
        onInteractionEnd={() => setInteractionEnded(value => value + 1)}
        editsBlocked={!!layout.recoveryError}
        beforeViewportCommit={() => {
          try {
            layout.assertEditable();
            universeLayoutDocumentSchema.parse(documentFromState(requireFrame().getState(), savedCamera.current));
            return true;
          } catch (cause) {report(cause); return false;}
        }}
        beforeStateCommit={(before, after) => {
          try {
            layout.assertEditable();
            const edit = layoutEdit(before, after);
            if (!edit.operations.length) return true;
            if (!layoutPatchSchema.safeParse({schemaVersion: 1, operationId: "x".repeat(256), expectedRevision: Number.MAX_SAFE_INTEGER, operations: edit.operations}).success)
              throw new Error("This arrangement exceeds the operation or byte budget. Arrange fewer panels at a time.");
            universeLayoutDocumentSchema.parse(documentFromState(before, savedCamera.current));
            return true;
          } catch (cause) {report(cause); return false;}
        }}
        onStateCommit={(before, after) => {
          try {
            layout.assertEditable();
            const edit = layoutEdit(before, after);
            if (edit.operations.length) void layout.queueOps(edit.operations, true, {epoch: epoch.current, openings: edit.openings}, {revision: before.layoutRevision ?? snapshot.revision, document: documentFromState(before, savedCamera.current)})?.catch(report);
          } catch (cause) {report(cause);}
        }}
        onViewportCommit={viewport => {try {
          const before = requireFrame().getState();
          void layout.queueOps([{type: "viewport", ...viewport}], true, undefined, {revision: before.layoutRevision ?? snapshot.revision, document: documentFromState(before, savedCamera.current)})?.catch(report);
          savedCamera.current = {...viewport};
        } catch (cause) {report(cause);}}}/>
    }
  </section>;
});
