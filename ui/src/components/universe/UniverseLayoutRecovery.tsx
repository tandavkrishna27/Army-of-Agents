import type {LayoutOp} from "@armyofagents/shared";
import {useState} from "react";
import type {useUniverseState} from "./useUniverseState";

type Props = {layout: ReturnType<typeof useUniverseState>};
export function UniverseLayoutRecovery({layout}: Props) {
 const describe = (op: LayoutOp) => {
   const title = "key" in op ? layout.document?.panels.find(p => p.key === op.key)?.title ?? "Panel" : "Workspace";
   switch (op.type) {
     case "geometry": return `${title}: position ${op.rect.x}, ${op.rect.y}; size ${op.rect.width} × ${op.rect.height}`;
     case "pin": return `${title}: ${op.value ? "pinned" : "unpinned"}`;
     case "minimize": return `${title}: ${op.value ? "minimized" : "restored"}`;
     case "close": return `${title}: closed`;
     case "open": return `${op.title}: opened`;
     case "viewport": return `Canvas: position ${op.x}, ${op.y}; zoom ${Math.round(op.zoom * 100)}%`;
     case "order": return "Panel stacking order changed";
     case "presentation": return op.maximized ? "Panel maximized" : "Normal panel view and selection";
   }
 };
 const [error, setError] = useState<string | null>(null);
 const [busy, setBusy] = useState(false);
 const [exported, setExported] = useState(false);
 const [discard, setDiscard] = useState(false);
 const run = async (action: () => unknown | Promise<unknown>) => {
   setError(null); setBusy(true);
   try {await action();} catch (cause) {setError(cause instanceof Error ? cause.message : String(cause));}
   finally {setBusy(false);}
 };
 const download = () => {
   const raw = layout.exportRecovery();
   const url = URL.createObjectURL(new Blob([raw], {type: "application/json"}));
   const anchor = document.createElement("a");
   anchor.href = url; anchor.download = "universe-layout-recovery.json";
   document.body.append(anchor);
   try {anchor.click(); setExported(true);} finally {anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 0);}
 };
 if (!layout.hasPending && !layout.isError) return null;
 return <aside className="universe-layout-recovery" aria-label="Layout recovery">
   {error && <p role="alert">{error}</p>}
   {layout.conflictingPatch && <>
     <p>Your layout edits conflict with another saved change. Both versions remain available until you choose.</p>
     <details><summary>Compare layout changes</summary>
       <h3>Your edits</h3><ul>{layout.conflictingPatch.operations.map((op, index) => <li key={index}>{describe(op)}</li>)}</ul>
       <h3>Saved layout</h3>
       {layout.document && <>
         <p>Canvas: position {layout.document.viewport.x}, {layout.document.viewport.y}; zoom {Math.round(layout.document.viewport.zoom * 100)}%</p>
         <ul>{layout.document.panels.map(panel => <li key={panel.key}>{panel.title}: position {panel.rect.x}, {panel.rect.y}; size {panel.rect.width} × {panel.rect.height}; {panel.pinned ? "pinned" : "unpinned"}; {panel.minimized ? "minimized" : layout.document!.maximized === panel.key ? "maximized" : "visible"}{layout.document!.selected === panel.key ? "; selected" : ""}</li>)}</ul>
       </>}
     </details>
     <button type="button" disabled={busy || !layout.document} onClick={() => void run(() => layout.resolveConflict([], layout.revision))}>Use saved layout</button>
     <button type="button" disabled={busy || !layout.document} onClick={() => void run(() => layout.resolveConflict(layout.conflictingPatch!.operations, layout.revision))}>Apply my layout edits</button>
   </>}
   {layout.hasPending && <button type="button" disabled={busy} onClick={() => void run(download)}>Export layout recovery</button>}
   {(layout.status === "offline" || layout.status === "blocked" || layout.isError) && !layout.corruptRecovery &&
     <button type="button" disabled={busy} onClick={() => void run(async () => {await layout.refetch(); await layout.retryRecovery();})}>Retry layout</button>}
   {layout.corruptRecovery && <>
     <p>This tab’s recovery record cannot be read. Export it before discarding it. The saved layout is kept.</p>
     <label><input type="checkbox" checked={discard} onChange={event => setDiscard(event.target.checked)}/>Discard this unreadable local recovery record</label>
     <button type="button" disabled={busy || !exported || !discard} onClick={() => void run(layout.discardInvalidRecovery)}>Discard invalid recovery</button>
   </>}
 </aside>;
}
