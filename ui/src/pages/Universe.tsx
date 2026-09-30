import {useEffect, useLayoutEffect, useRef, useState, type CSSProperties} from "react";
import {Link, useNavigate, useSearchParams} from "react-router-dom";
import {ArrowLeft} from "lucide-react";
import {useQuery, useQueryClient} from "@tanstack/react-query";
import {useCompany} from "../context/CompanyContext";
import {commanderConversationsApi} from "../api/internal-agent";
import {issuesApi} from "../api/issues";
import {queryKeys} from "../lib/queryKeys";
import {useUniverseOwner} from "../components/universe/useUniverseOwner";
import {PersistedUniverseWorkspace} from "../components/universe/PersistedUniverseWorkspace";
import {TaskConversationPanel} from "../components/universe/TaskConversationPanel";
import {UniverseTray} from "../components/universe/UniverseTray";
import {CommanderBlob} from "../components/universe/CommanderBlob";
import {UniverseCommanderChat} from "../components/universe/UniverseCommanderChat";
import {PanelPreviewRail, isPanelOutOfView} from "../components/universe/PanelPreviewRail";
import {initialPresentation, toggleTrayChat} from "../components/universe/commander-presentation";
import {isTransientUniverseReadError} from "../components/universe/transient-read-error";
import type {WorkspaceHandle} from "../components/universe/UniverseWorkspace";
import type {State, Viewport} from "../components/universe/panel-state";
import {buildUniverseContext} from "../components/universe/buildUniverseContext";
import {useUniverseReconciliation} from "../components/universe/useUniverseReconciliation";
import {useUniversePreferences} from "../hooks/useUniversePreferences";
import {UNIVERSE_ACCENTS} from "../components/universe/appearance-tokens";
import {universeAttentionApi} from "../api/universe-attention";
import {AttentionRail} from "../components/universe/AttentionRail";
import {AttentionQuestion} from "../components/universe/AttentionQuestion";
import {openTaskReference} from "../components/universe/open-task-reference";
import type {UniverseAttentionEntry} from "@armyofagents/shared";
import "../components/universe/commander-surface.css";
import "../components/universe/universe-shell.css";

/** Dedicated Universe presentation; authentication and company scope remain authoritative. */
export function Universe() {
  const {selectedCompanyId} = useCompany();
  const owner = useUniverseOwner();
  if (!selectedCompanyId) return <p>Select a company to open Universe.</p>;
  if (!owner.identity || !owner.userId || !owner.isVerified || !owner.isCurrent())
    return <p role="status">Sign in to open your workspace.</p>;
  return <OwnedUniverse key={JSON.stringify([owner.identity, selectedCompanyId])}
    companyId={selectedCompanyId} userId={owner.userId} identity={owner.identity}/>;
}

function OwnedUniverse({companyId, userId, identity}: {companyId: string; userId: string; identity: string}) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const {selectedCompany} = useCompany();
  const [creating, setCreating] = useState(false);
  const [implicitConversation, setImplicitConversation] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attentionEntry, setAttentionEntry] = useState<UniverseAttentionEntry | null>(null);
  const [presentation, setPresentation] = useState(initialPresentation);
  const preferences = useUniversePreferences(companyId);
  const appliedPreferences = useRef(-1);
  const [registry, setRegistry] = useState<State | null>(null);
  const [viewport, setViewport] = useState<Viewport>({x: 0, y: 0, zoom: 1});
  const [canvasBounds, setCanvasBounds] = useState({width: 1, height: 1});
  const frame = useRef<WorkspaceHandle>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const commanderPrimary = useRef<HTMLButtonElement | null>(null);
  const alive = useRef(true);
  useEffect(() => {alive.current = true; return () => {alive.current = false;};}, []);
  useLayoutEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const measure = () => {
      const bounds = element.getBoundingClientRect();
      setCanvasBounds({width: Math.max(1, bounds.width), height: Math.max(1, bounds.height)});
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener("resize", measure);
    return () => {observer?.disconnect(); window.removeEventListener("resize", measure);};
  }, []);
  const conversationKey = ["commander-conversations", companyId, "universe-owner", identity];
  const conversations = useQuery({queryKey: conversationKey,
    queryFn: () => commanderConversationsApi.list(companyId), retry: false});
  const suspended = conversations.isError && !!conversations.data && isTransientUniverseReadError(conversations.error);
  const authorized = conversations.isSuccess || suspended ? conversations.data?.conversations.filter(row => row.userId === userId) ?? [] : [];
  const mine = conversations.isSuccess ? authorized : [];
  const requested = params.get("conversation");
  const selected = requested
    ? authorized.find(row => row.id === requested)?.id ?? null
    : authorized.find(row => row.id === implicitConversation)?.id ?? authorized[0]?.id ?? null;
  const reconciliation = useUniverseReconciliation({companyId,conversationId:selected,ownerSession:identity});
  const effectivePreferences = preferences.snapshot?.effective;
  useEffect(() => {
    if (!preferences.snapshot || appliedPreferences.current === preferences.snapshot.revision) return;
    appliedPreferences.current = preferences.snapshot.revision;
    const value = preferences.snapshot.effective;
    setPresentation(previous => ({
      ...previous,
      chat: value.chatVisibility === "tucked" ? "tucked" : value.conversationPresentation,
      lastVisible: value.conversationPresentation,
      chatFrontmost: value.chatVisibility === "shown",
      blob: value.blobVisibility === "shown",
      captions: value.captions === "visible",
    }));
  }, [preferences.snapshot]);
  // Pin the initial selection in the route; a later list reorder is not navigation.
  useLayoutEffect(() => {
    if (!conversations.isSuccess || requested || !selected) return;
    setImplicitConversation(previous => previous ?? selected);
    setParams(previous => {
      if (previous.get("conversation")) return previous;
      const next = new URLSearchParams(previous); next.set("conversation", selected); return next;
    }, {replace: true});
  }, [conversations.isSuccess, requested, selected, setParams]);
  const currentRegistry = registry?.scope.conversationId === selected ? registry : null;
  const tasks = useQuery({queryKey: [...queryKeys.issues.list(companyId), "universe-owner", identity],
    queryFn: () => issuesApi.list(companyId), retry: false});
  const attention = useQuery({queryKey:["universe-attention",companyId,identity],
    queryFn:()=>universeAttentionApi.get(companyId), retry:false, refetchInterval:30_000});
  const [finishingAttention,setFinishingAttention]=useState(false);
  const finishAttention=async()=>{
    const snapshot=attention.data;
    if(!snapshot?.checkpoint||!snapshot.checkpointToken||finishingAttention)return;
    setFinishingAttention(true);
    try{await universeAttentionApi.finish(companyId,snapshot.checkpoint.revision,snapshot.checkpointToken);
      setAttentionEntry(null);await attention.refetch();setError(null);
    }catch(cause){setError(cause instanceof Error?cause.message:"Could not finish attention review.");}
    finally{if(alive.current)setFinishingAttention(false);}
  };
  useEffect(()=>{
    if(!attentionEntry||!attention.data)return;
    const visible=[...attention.data.needsYou,...attention.data.ready,...attention.data.comingUp].some(item=>item.id===attentionEntry.id);
    if(!visible)setAttentionEntry(null);
  },[attention.data,attentionEntry]);
  const available = tasks.isSuccess ? tasks.data.filter(task => task.companyId === companyId) : [];
  const openConversation = (id: string) => {
    setParams(previous => {const next = new URLSearchParams(previous); next.set("conversation", id); return next;});
  };
  async function create() {
    if (creating) return;
    setCreating(true); setError(null);
    try {
      const row = await commanderConversationsApi.create(companyId);
      if (!alive.current) return;
      await client.invalidateQueries({queryKey: conversationKey});
      if (alive.current) openConversation(row.id);
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : "Could not create conversation.");
    } finally {if (alive.current) setCreating(false);}
  }
  const perform = (action: () => void) => {
    try {action(); setError(null);} catch (cause) {setError(cause instanceof Error ? cause.message : "Could not update workspace.");}
  };
  const openPanel = (key: string) => {
    const panel = currentRegistry?.panels[key];
    if (panel) perform(() => {
      frame.current?.dispatch({type: panel.minimized ? "restore" : "focus", key, generation: panel.generation});
      if (panel.minimized || isPanelOutOfView(panel.rect, viewport, canvasBounds)) {
        frame.current?.requestNavigation({id: crypto.randomUUID(), panelKey:key, generation:panel.generation, cause:"user-reference", highlight:false});
      }
    });
  };
  const openTask = async (issueId: string, route: Parameters<typeof openTaskReference>[0]["route"], anchorId?: string | null) => {
    if (!selected || !currentRegistry || !frame.current) {
      setError("Choose or create a conversation in Commander options before opening a task."); return;
    }
    try {
      await openTaskReference({issueId,anchorId,route},{companyId,state:currentRegistry,workspace:frame.current,resolveIssue:issuesApi.get});
      setError(null);
    } catch(cause) { setError(cause instanceof Error ? cause.message : "Could not open task."); }
  };
  const directTask = params.get("task");
  const consumedDirectTask = useRef<string | null>(null);
  useEffect(()=>{
    if (!directTask || directTask === consumedDirectTask.current || !currentRegistry || !selected) return;
    consumedDirectTask.current=directTask; void openTask(directTask,"direct-reference",params.get("anchor"));
  },[directTask,currentRegistry,selected]);
  const prefix = selectedCompany?.issuePrefix;
  const returnPath = prefix ? `/${prefix}/commander${selected ? `?conversation=${encodeURIComponent(selected)}` : ""}` : "/";
  const accent = UNIVERSE_ACCENTS[effectivePreferences?.accent ?? "brand_red"];
  return <main className="universe-shell" aria-label="Universe canvas"
    data-theme={effectivePreferences?.theme ?? "inherit"} data-density={effectivePreferences?.density ?? "comfortable"}
    data-grid={effectivePreferences?.grid ?? "dots"} data-blob-style={effectivePreferences?.blobStyle ?? "fluid"}
    style={{"--universe-accent":accent,"--universe-grid-opacity":effectivePreferences?.gridIntensity ?? .15} as CSSProperties}>
    <Link className="universe-exit" to={returnPath} aria-label="Back to Commander" title="Back to Commander"><ArrowLeft size={18}/></Link>
    <div className="universe-shell-tray">
      <UniverseTray scopeKey={`${identity}:${companyId}:${selected ?? "none"}`}
        conversationTitle={mine.find(row => row.id === selected)?.title || undefined}
        dockHiding={effectivePreferences?.dockHiding === "auto_hide" ? "auto" : "always"}
        counts={{inbox:attention.data?.needsYou.length}}
        openPanels={suspended ? [] : currentRegistry?.order.map(key => ({...currentRegistry.panels[key], kind: "Task"})) ?? []}
        menuItems={{work: available.map(task => ({key: task.id, label: task.title})),
          settings: [{key: "company-settings", label: "Company settings"}, {key: "lobby", label: "Return to lobby"}]}}
        commanderConversations={[...mine.map(row => ({key: row.id, label: row.title || "Untitled conversation"})),
          {key: "new-conversation", label: creating ? "Creating conversation…" : "New conversation"}]}
        commanderToggles={{chat: presentation.chat !== "tucked", blob: presentation.blob, captions: presentation.captions}}
        commanderPrimaryRef={node => { commanderPrimary.current = node; }}
        onCommanderPrimary={() => setPresentation(toggleTrayChat)}
        onToggleCommander={(which, value) => setPresentation(previous => which === "chat"
          ? {...previous, chat: value ? previous.lastVisible : "tucked", chatFrontmost: value}
          : {...previous, [which]: value})}
        onOpenConversation={id => {if (id === "new-conversation") void create(); else openConversation(id);}}
        onOpenPanel={key=>{
          const panel=currentRegistry?.panels[key];
          if(panel?.ref.kind==="task")void openTask(panel.ref.id,"open-panels"); else openPanel(key);
        }}
        onOpenReference={(menu, id) => {
          if (menu === "settings") { navigate(id === "lobby" ? "/" : `/${prefix}/settings?tab=universe`); return; }
          const task = available.find(row => row.id === id);
          if (menu !== "work" || !task) return;
          if (!selected || !currentRegistry || !frame.current) {setError("Choose or create a conversation in Commander options before opening a task."); return;}
          void openTask(task.id,"work");
        }}/>
    </div>
    {effectivePreferences?.openPanelPreviews !== "hidden" && <PanelPreviewRail panels={currentRegistry?.order.flatMap(key => {
      const panel = currentRegistry.panels[key];
      const outside = !panel.minimized && currentRegistry.maximized === null && isPanelOutOfView(panel.rect, viewport, canvasBounds);
      return panel.minimized || outside ? [{key, title: panel.title, kind: panel.ref.kind === "task" ? "Task" : panel.ref.kind, minimized: panel.minimized}] : [];
    }) ?? []} onOpen={openPanel}/>}
    {effectivePreferences?.attentionPreviews !== "hidden" && attention.data &&
      (effectivePreferences?.attentionPreviews === "always" || attention.data.needsYou.length+attention.data.ready.length+attention.data.comingUp.length>0) &&
      <AttentionRail attention={attention.data} selectedId={attentionEntry?.id} onSelect={setAttentionEntry}
        onViewAll={()=>navigate(`/${prefix}/inbox`)} onFinish={()=>void finishAttention()} finishing={finishingAttention}/>}
    {attentionEntry && <AttentionQuestion companyId={companyId} entry={attentionEntry}
      onOpenTask={id=>void openTask(id,"needs-you")} onClose={()=>setAttentionEntry(null)}/>}
    <div className="universe-shell-notices" aria-live="polite">
      {selected && reconciliation.state.status !== "current" && <p role="status">Workspace updates are {reconciliation.state.status}. Showing the last confirmed view.</p>}
      {reconciliation.query.data?.partialReasons.length ? <p role="status">Some workspace updates are still being reconciled.</p> : null}
      {(error || conversations.isError || tasks.isError) && <p role="alert">{error || (conversations.isError ? "Conversations could not be loaded." : "Tasks could not be loaded.")}</p>}
      {attention.isError && <p role="alert">Attention items could not be loaded. Inbox remains available.</p>}
      {conversations.isError && <button type="button" onClick={() => void conversations.refetch()}>Retry conversations</button>}
      {tasks.isError && <button type="button" onClick={() => void tasks.refetch()}>Retry tasks</button>}
      {conversations.isLoading && <p role="status">Loading conversations…</p>}
      {requested && conversations.isSuccess && !selected && <p role="alert">This conversation is unavailable. Choose another in Commander options.</p>}
    </div>
    <div ref={canvas} className="universe-shell-canvas" style={suspended ? {display: "none"} : undefined}>
      {selected && <PersistedUniverseWorkspace key={selected} ref={frame} companyId={companyId} conversationId={selected}
        content={{}} motion motionMode={effectivePreferences?.motion ?? "subtle"} initialAutoTile={effectivePreferences?.arrangement === "assisted"}
        onStateObserved={setRegistry} onViewportObserved={setViewport} resolveContent={panel => panel.ref.kind === "task" ? {
          ref: panel.ref, title: panel.title, render: () => <TaskConversationPanel companyId={companyId}
            issueId={panel.ref.id} panelKey={panel.key} generation={panel.generation} active/>,
        } : undefined}/>}
    </div>
    {presentation.blob && presentation.chat !== "maximized" && <div className="universe-shell-blob" data-occupied={!!currentRegistry?.order.some(key => !currentRegistry.panels[key].minimized)} data-style={effectivePreferences?.blobStyle ?? "fluid"} data-color={effectivePreferences?.blobColor ?? "match_accent"}
      style={{"--blob-accent":effectivePreferences?.blobColor && effectivePreferences.blobColor !== "match_accent" ? UNIVERSE_ACCENTS[effectivePreferences.blobColor] : accent} as CSSProperties}>
      <CommanderBlob onPrimary={() => setPresentation(toggleTrayChat)} onHide={() => setPresentation(previous => ({...previous, blob: false}))}/>
    </div>}
    {(conversations.isSuccess || suspended) && (!requested || !!selected) && <div className="universe-shell-chat" style={suspended ? {display: "none"} : undefined}>
      <UniverseCommanderChat conversationId={selected} onSelectConversation={async id => {
        await client.invalidateQueries({queryKey: conversationKey}); if (alive.current) openConversation(id);
      }} presentation={presentation} onPresentationChange={setPresentation} onTuck={() => commanderPrimary.current?.focus()} getUniverseContext={() => {
        if (!selected || !currentRegistry) return null;
        const bounds = document.querySelector(".universe-shell-canvas")?.getBoundingClientRect();
        const viewport = frame.current?.getViewport() ?? {x: 0, y: 0, zoom: 1};
        const referenceFor = (key: string) => {
          const panel = currentRegistry.panels[key];
          if (!panel || panel.minimized || panel.ref.kind === "browser") return null;
          return panel.ref.kind === "artifact"
            ? {kind: "artifact" as const, id: panel.ref.id, ...(panel.ref.version ? {versionId: panel.ref.version} : {})}
            : {kind: "task" as const, id: panel.ref.id};
        };
        return buildUniverseContext({
          conversationId: selected,
          selected: currentRegistry.selected ? referenceFor(currentRegistry.selected) : null,
          visible: currentRegistry.order.flatMap(key => {const ref = referenceFor(key); return ref ? [ref] : [];}),
          viewport: {width: Math.max(1, bounds?.width ?? window.innerWidth), height: Math.max(1, bounds?.height ?? window.innerHeight), ...viewport},
        });
      }}/>
    </div>}
  </main>;
}
