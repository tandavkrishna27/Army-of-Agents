/// <reference types="vite/client" />
import { useMemo, useRef, useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import {
  UniverseWorkspace,
  type ContentEntry,
  type WorkspaceHandle,
} from "../components/universe/UniverseWorkspace";
import {
  panelKey,
  type AuthorizedLayoutSnapshot,
  type Ref,
  type Scope,
  type State,
} from "../components/universe/panel-state";
import {
  UniverseTray,
  type LibraryMenu,
  type TrayReferenceItem,
} from "../components/universe/UniverseTray";
import type { OpenPanelTile } from "../components/universe/OpenPanelsOverview";
import { CommanderSurface } from "../components/universe/CommanderSurface";
import {
  compactChat,
  initialPresentation,
  toggleTrayChat,
  type Presentation,
} from "../components/universe/commander-presentation";
import "../index.css";

const initialViewport = { x: 0, y: 0, zoom: 1 };
const KIND_LABEL: Record<Ref["kind"], string> = {
  task: "Task",
  artifact: "Artifact",
  browser: "Browser",
};

/** Fixture library: each entry maps a tray reference to a canvas Ref. */
type LibraryEntry = TrayReferenceItem & { ref: Ref };

function Fixture({ label }: { label: string }) {
  return (
    <div style={{ padding: 4 }}>
      <p style={{ margin: "0 0 6px", fontWeight: 600 }}>{label}</p>
      <textarea
        aria-label={`${label} draft`}
        placeholder="Fixture content — stays mounted while tucked"
        style={{ width: "100%", minHeight: 80 }}
      />
    </div>
  );
}

function Harness() {
  const companyId = "fixture-company";
  const scope: Scope = {
    companyId,
    userId: "fixture-user",
    conversationId: "fixture-1",
  };
  const handle = useRef<WorkspaceHandle>(null);
  const [state, setState] = useState<State | null>(null);
  const [presentation, setPresentation] = useState<Presentation>(
    initialPresentation()
  );
  const setChat = (chat: Presentation["chat"]) =>
    setPresentation((p) => ({
      ...p,
      chat,
      lastVisible: chat === "tucked" ? p.lastVisible : chat,
      chatFrontmost: chat !== "tucked",
    }));
  const showChat = () =>
    setPresentation((p) => ({
      ...p,
      chat: p.chat === "tucked" ? p.lastVisible : p.chat,
      chatFrontmost: true,
    }));

  const commanderRef: Ref = { companyId, kind: "task", id: "commander-chat" };
  const library: Record<LibraryMenu, LibraryEntry[]> = {
    work: [
      { key: "draft-plan", label: "Draft the plan", ref: { companyId, kind: "task", id: "draft-plan" } },
      { key: "ship-tray", label: "Ship the tray", ref: { companyId, kind: "task", id: "ship-tray" } },
      { key: "linux-qual", label: "Linux qualification", ref: { companyId, kind: "task", id: "linux-qual" } },
      { key: "polish", label: "Polish the motion", ref: { companyId, kind: "task", id: "polish" } },
    ],
    artifacts: [
      { key: "spec", label: "Canvas spec", hint: "v3", ref: { companyId, kind: "artifact", id: "spec" } },
      { key: "design", label: "Tray design doc", hint: "v1", ref: { companyId, kind: "artifact", id: "design" } },
    ],
    inbox: [
      { key: "approve-dispatch", label: "Approve crew dispatch", hint: "needs you", ref: { companyId, kind: "task", id: "approve-dispatch" } },
      { key: "budget", label: "Budget threshold", hint: "82%", ref: { companyId, kind: "task", id: "budget" } },
    ],
    browser: [
      { key: "docs", label: "React Flow docs", ref: { companyId, kind: "browser", id: "docs" } },
    ],
    settings: [],
  };

  const refByKey = useMemo(() => {
    const map = new Map<string, LibraryEntry>();
    for (const entries of Object.values(library))
      for (const entry of entries) map.set(entry.key, entry);
    return map;
  }, []);

  const allRefs: Ref[] = [
    commanderRef,
    ...Array.from(refByKey.values(), (e) => e.ref),
  ];
  const content: Record<string, ContentEntry> = Object.fromEntries(
    allRefs.map((ref) => {
      const label =
        ref.id === "commander-chat"
          ? "Commander"
          : refByKey.get(ref.id)?.label ?? ref.id;
      return [
        panelKey(scope, ref),
        { ref, title: label, render: () => <Fixture label={label} /> },
      ];
    })
  );

  const layout: AuthorizedLayoutSnapshot = {
    scope,
    schemaVersion: 1,
    revision: 0,
    nextOpenedOrdinal: 1,
    viewport: { ...initialViewport },
    panels: [],
    order: [],
    selected: null,
    maximized: null,
  };

  const openRef = (ref: Ref, title: string) =>
    handle.current?.open({ ref, title });

  const onOpenReference = (menu: LibraryMenu, key: string) => {
    const entry = refByKey.get(key);
    if (entry) openRef(entry.ref, entry.label);
  };

  // Restore/focus an existing instance from the overview (never a new open).
  const onOpenPanel = (key: string) => {
    const live = handle.current?.getState();
    const panel = live?.panels[key];
    if (!panel) return;
    if (panel.minimized)
      handle.current?.dispatch({
        type: "restore",
        key,
        generation: panel.generation,
      });
    handle.current?.dispatch({
      type: "focus",
      key,
      generation: panel.generation,
    });
  };

  const openPanels: OpenPanelTile[] = state
    ? Object.values(state.panels).map((panel) => ({
        key: panel.key,
        title: panel.title,
        kind: KIND_LABEL[panel.ref.kind],
        openedOrdinal: panel.openedOrdinal,
        minimized: panel.minimized,
      }))
    : [];

  const menuItems: Partial<Record<LibraryMenu, TrayReferenceItem[]>> =
    Object.fromEntries(
      (Object.keys(library) as LibraryMenu[]).map((menu) => [
        menu,
        library[menu].map(({ key, label, hint }) => ({ key, label, hint })),
      ])
    );

  return (
    <main
      style={
        {
          height: "100vh",
          display: "flex",
          flexDirection: "column",
          // Dark canvas so light work panels float on it (JARVIS/Atlas). The
          // workspace reads --bg for its own surface; keep panels (--card) light.
          "--bg": "#0a0b10",
          background:
            "radial-gradient(1200px 700px at 50% -10%, #1d2030 0%, #0b0c12 60%, #07080c 100%)",
          color: "#edeef2",
          font: "13px system-ui, sans-serif",
        } as CSSProperties
      }
    >
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          padding: "10px 12px 4px",
          position: "relative",
          zIndex: 50,
        }}
      >
        <UniverseTray
          openPanels={openPanels}
          menuItems={menuItems}
          conversationTitle="Launch direction"
          counts={{ inbox: library.inbox.length }}
          commanderConversations={[
            { key: "planning", label: "Planning chat", hint: "today" },
            { key: "review", label: "Review notes", hint: "yesterday" },
          ]}
          commanderToggles={{
            chat: presentation.chat !== "tucked",
            blob: presentation.blob,
            captions: presentation.captions,
          }}
          onToggleCommander={(which, value) =>
            setPresentation((p) =>
              which === "chat"
                ? value
                  ? { ...p, chat: p.lastVisible, chatFrontmost: true }
                  : { ...p, chat: "tucked", chatFrontmost: false }
                : which === "blob"
                  ? { ...p, blob: value }
                  : { ...p, captions: value }
            )
          }
          onOpenReference={onOpenReference}
          onOpenConversation={showChat}
          onOpenPanel={onOpenPanel}
          onCommanderPrimary={() => setPresentation(toggleTrayChat)}
        />
      </div>
      <details style={{ padding: "0 12px 6px", color: "var(--dim, #71717a)" }}>
        <summary style={{ cursor: "pointer" }}>
          Open panels ({openPanels.length}) — overview is sorted by openedOrdinal
        </summary>
        <pre style={{ maxHeight: 140, overflow: "auto" }}>
          {JSON.stringify(
            openPanels
              .slice()
              .sort((a, b) => a.openedOrdinal - b.openedOrdinal)
              .map((p) => ({ o: p.openedOrdinal, title: p.title, min: p.minimized })),
            null,
            2
          )}
        </pre>
      </details>
      <div style={{ flex: 1, minHeight: 0, position: "relative", zIndex: 0 }}>
        <UniverseWorkspace
          ref={handle}
          scope={scope}
          initialLayout={layout}
          content={content}
          initialAutoTile
          onStateChange={setState}
        />
        <CommanderSurface
          presentation={presentation}
          captionText={
            presentation.captions
              ? "…opening the launch story presentation for you."
              : undefined
          }
          messages={[
            { id: "m1", role: "commander", text: "I'm here. Ready when you are." },
            { id: "m2", role: "user", text: "Draft the launch story." },
            { id: "m3", role: "commander", text: "On it — opening a presentation." },
          ]}
          onPrimary={() => setPresentation(toggleTrayChat)}
          onExpand={() => setChat("expanded")}
          onCompact={() => setPresentation(compactChat)}
          onMaximize={() => setChat("maximized")}
          onRestore={() => setChat("expanded")}
          onTuck={() => setChat("tucked")}
          onHideBlob={() => setPresentation((p) => ({ ...p, blob: false }))}
        />
      </div>
    </main>
  );
}

if (import.meta.env.DEV)
  createRoot(document.getElementById("root")!).render(<Harness />);
