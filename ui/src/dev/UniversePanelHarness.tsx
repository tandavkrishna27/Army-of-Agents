/// <reference types="vite/client" />
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  UniverseWorkspace,
  type ContentEntry,
  type WorkspaceHandle,
} from "../components/universe/UniverseWorkspace";
import {
  panelKey,
  type Action,
  type AuthorizedLayoutSnapshot,
  type Ref,
  type Scope,
  type State,
} from "../components/universe/panel-state";
import "../index.css";

let mounts = 0;
const initialViewport = { x: 0, y: 0, zoom: 1 };
function DraftFixture() {
  const [instance] = useState(() => ++mounts);
  return (
    <div>
      <p data-testid="mount-count">Content instance {instance}</p>
      <textarea
        aria-label="Fixture draft"
        placeholder="Draft stays mounted"
        style={{ width: "100%", minHeight: 100 }}
      />
      <p>Task/chat fixture only. Real task content is a later integration.</p>
    </div>
  );
}
function ThrowingFixture(): never {
  throw new Error("Deliberately unavailable fixture");
}
function Harness() {
  const [conversationId, setConversation] = useState("fixture-1");
  const scope: Scope = {
    companyId: "fixture-company",
    userId: "fixture-user",
    conversationId,
  };
  const handle = useRef<WorkspaceHandle>(null);
  const [observed, setObserved] = useState<State | null>(null);
  const [camera, setCamera] = useState({ ...initialViewport });
  const [autoTile, setAutoTile] = useState(false);
  const [motion, setMotion] = useState(false);
  const stale = useRef<Action | null>(null);
  const refs: Ref[] = [
    { companyId: scope.companyId, kind: "task", id: "task" },
    { companyId: scope.companyId, kind: "artifact", id: "artifact" },
    { companyId: scope.companyId, kind: "browser", id: "iframe" },
    { companyId: scope.companyId, kind: "task", id: "missing" },
    { companyId: scope.companyId, kind: "task", id: "throwing" },
  ];
  const batchRefs: Ref[] = Array.from({ length: 50 }, (_, index) => ({
    companyId: scope.companyId,
    kind: "task",
    id: `load-${index + 1}`,
  }));
  const content: Record<string, ContentEntry> = Object.fromEntries(
    [...refs, ...batchRefs]
      .filter((ref) => ref.id !== "missing")
      .map((ref) => [
        panelKey(scope, ref),
        {
          ref,
          title: `${ref.id} fixture`,
          render: () =>
            ref.id === "task" || ref.id.startsWith("load-") ? (
              <DraftFixture />
            ) : ref.id === "artifact" ? (
              <article>
                {Array.from({ length: 60 }, (_, index) => (
                  <p key={index}>
                    Artifact fixture paragraph {index + 1}. Select this text and
                    scroll within the panel.
                  </p>
                ))}
              </article>
            ) : ref.id === "iframe" ? (
              <iframe
                title="Iframe fixture"
                style={{ width: "100%", height: "100%", border: 0 }}
                srcDoc="<html><body style='font:16px system-ui'><h3>Iframe fixture</h3><input placeholder='Embedded text input'><p>This inert local document tests pointer crossing only.</p></body></html>"
              />
            ) : (
              <ThrowingFixture />
            ),
        },
      ])
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
  const open = (ref: Ref) =>
    handle.current?.open({ ref, title: `${ref.id} fixture` });
  return (
    <main
      className="universe-harness"
      style={{ height: "100vh", display: "flex", flexDirection: "column" }}
    >
      <style>{`
        .universe-harness { font: 13px system-ui, sans-serif; color: var(--text); background: var(--bg); }
        .universe-harness-heading { padding: 10px 12px 0; font-size: 14px; }
        .universe-harness-tools { display: flex; flex-wrap: wrap; gap: 8px 16px; padding: 8px 12px; }
        .universe-harness-group { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
        .universe-harness-group > span { color: var(--dim); font-size: 12px; margin-right: 4px; }
        .universe-harness-tools button { font: inherit; color: inherit; background: var(--card-2); border: 1px solid var(--border); border-radius: 5px; padding: 5px 8px; cursor: pointer; }
        .universe-harness-tools button:hover { background: var(--hd); }
        .universe-harness-tools button:focus-visible, .universe-harness-diagnostics summary:focus-visible { outline: 2px solid var(--brand-focus-ring, #d95059); outline-offset: 2px; }
        .universe-harness-diagnostics { padding: 0 12px 8px; color: var(--dim); }
        .universe-harness-diagnostics summary { cursor: pointer; }
        .universe-harness-diagnostics pre { max-height: 180px; overflow: auto; color: var(--text); }
      `}</style>
      <strong className="universe-harness-heading">
        Internal frame fixtures
      </strong>
      <div className="universe-harness-tools">
        <div
          className="universe-harness-group"
          role="group"
          aria-label="Launch fixtures"
        >
          <span>Launch</span>
          {refs.map((ref) => (
            <button key={ref.id} onClick={() => open(ref)}>
              Open {ref.id}
            </button>
          ))}
        </div>
        <div
          className="universe-harness-group"
          role="group"
          aria-label="Camera"
        >
          <span>Camera</span>
          {[0.5, 1, 2].map((zoom) => (
            <button
              key={zoom}
              onClick={() => handle.current?.setViewport({ x: 0, y: 0, zoom })}
            >
              Zoom {zoom}
            </button>
          ))}
        </div>
        <div
          className="universe-harness-group"
          role="group"
          aria-label="Geometry history"
        >
          <span>History</span>
          <button onClick={() => handle.current?.undo()}>Undo geometry</button>
          <button onClick={() => handle.current?.redo()}>Redo geometry</button>
        </div>
        <div
          className="universe-harness-group"
          role="group"
          aria-label="Arrange"
        >
          <span>Arrange</span>
          <button onClick={() => handle.current?.arrange()}>Arrange</button>
          <button onClick={() => handle.current?.fit()}>Fit</button>
          <button
            aria-label="Toggle auto-tile"
            aria-pressed={autoTile}
            onClick={() => {
              const next = !autoTile;
              setAutoTile(next);
              handle.current?.setAutoTile(next);
            }}
          >
            Auto-tile: {autoTile ? "on" : "off"}
          </button>
          <button
            aria-label="Toggle motion"
            aria-pressed={motion}
            onClick={() => setMotion((m) => !m)}
          >
            Motion: {motion ? "on" : "off"}
          </button>
        </div>
        <div
          className="universe-harness-group"
          role="group"
          aria-label="Fixture test tools"
        >
          <span>Test tools</span>
          {[10, 50].map((count) => (
            <button
              key={count}
              onClick={() => {
                const state = handle.current?.getState();
                if (state)
                  for (const panel of Object.values(state.panels))
                    handle.current?.dispatch({
                      type: "close",
                      key: panel.key,
                      generation: panel.generation,
                    });
                for (const ref of batchRefs.slice(0, count)) open(ref);
              }}
            >
              Open {count} fixtures
            </button>
          ))}
          <button
            onClick={() => {
              const state = handle.current!.getState();
              const panel = state.selected && state.panels[state.selected];
              if (panel)
                stale.current = {
                  type: "close",
                  key: panel.key,
                  generation: panel.generation,
                };
            }}
          >
            Capture stale close
          </button>
          <button
            onClick={() => {
              if (stale.current) handle.current?.dispatch(stale.current);
            }}
          >
            Replay stale close
          </button>
          <button
            onClick={() => {
              const state = handle.current!.getState();
              const panel = state.selected && state.panels[state.selected];
              if (panel)
                handle.current?.dispatch({
                  type: "geometry",
                  key: panel.key,
                  generation: panel.generation,
                  rect: { ...panel.rect, x: panel.rect.x + 50 },
                  source: "commander",
                });
            }}
          >
            Commander arrange fixture
          </button>
          <button
            onClick={() => {
              setConversation((old) =>
                old === "fixture-1" ? "fixture-2" : "fixture-1"
              );
              setObserved(null);
              setCamera({ ...initialViewport });
            }}
          >
            Switch scope
          </button>
        </div>
      </div>
      <details className="universe-harness-diagnostics">
        <summary>Raw fixture diagnostics ({conversationId})</summary>
        <p>
          Committed camera:{" "}
          <output data-testid="camera-state">{JSON.stringify(camera)}</output>
        </p>
        <pre data-testid="registry-state">
          {JSON.stringify(observed, null, 2)}
        </pre>
      </details>
      <div style={{ flex: 1, minHeight: 0 }}>
        <UniverseWorkspace
          ref={handle}
          scope={scope}
          initialLayout={layout}
          content={content}
          motion={motion}
          onStateChange={setObserved}
          onViewportCommit={setCamera}
        />
      </div>
    </main>
  );
}
if (import.meta.env.DEV)
  createRoot(document.getElementById("root")!).render(<Harness />);
