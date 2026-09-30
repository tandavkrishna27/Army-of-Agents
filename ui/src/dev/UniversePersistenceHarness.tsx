/// <reference types="vite/client" />
import {useRef} from "react";
import {createRoot} from "react-dom/client";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {PersistedUniverseWorkspace} from "../components/universe/PersistedUniverseWorkspace";
import type {WorkspaceHandle} from "../components/universe/UniverseWorkspace";
import {panelKey} from "../components/universe/panel-state";
import "../index.css";
const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
const scope = {companyId: "fixture-company", userId: "fixture-user", conversationId: "fixture-conversation"};
const ref = {companyId: scope.companyId, kind: "task" as const, id: "task"};
function Harness() {
 const frame = useRef<WorkspaceHandle>(null);
 return <main style={{height: "100vh", display: "flex", flexDirection: "column"}}>
  <nav aria-label="Qualification controls">
   <button onClick={() => frame.current?.undo()}>Undo gesture</button>
   <button onClick={() => frame.current?.setViewport({x: 40, y: 20, zoom: .75})}>Set camera</button>
   <button onClick={() => void client.invalidateQueries({queryKey: ["universe-layout"]})}>Refresh snapshot</button>
  </nav>
  <div style={{flex: 1, minHeight: 0}}><PersistedUniverseWorkspace ref={frame} companyId={scope.companyId} conversationId={scope.conversationId}
   content={{[panelKey(scope, ref)]: {ref, title: "Fixture task", render: () => <textarea aria-label="Local task draft"/>}}}/></div>
 </main>;
}
// Development fixture only; transport is supplied by the browser test, not a production route.
if (import.meta.env.DEV) createRoot(document.getElementById("root")!).render(<QueryClientProvider client={client}><Harness/></QueryClientProvider>);
