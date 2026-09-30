import { createRef } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { UniverseWorkspace, type WorkspaceHandle } from "../UniverseWorkspace";
import { panelKey, type AuthorizedLayoutSnapshot } from "../panel-state";

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(400);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(element: Element) {
        this.callback(
          [
            {
              target: element,
              contentRect: { width: 1200, height: 900 },
            } as ResizeObserverEntry,
          ],
          this as unknown as ResizeObserver
        );
      }
      unobserve() {}
      disconnect() {}
    }
  );
  vi.stubGlobal(
    "DOMMatrixReadOnly",
    class {
      m22 = 1;
    }
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const scope = { companyId: "a", userId: "u", conversationId: "c" };
const ref = { companyId: "a", kind: "task" as const, id: "t" };
const key = panelKey(scope, ref);
const layout: AuthorizedLayoutSnapshot = {
  scope,
  schemaVersion: 1,
  revision: 1,
  nextOpenedOrdinal: 2,
  viewport: { x: 30, y: 40, zoom: 0.5 },
  panels: [
    {
      ref,
      title: "Task fixture",
      rect: { x: 20, y: 30, width: 600, height: 400 },
      openedOrdinal: 1,
      minimized: false,
      pinned: false,
    },
  ],
  order: [key],
  selected: key,
  maximized: null,
};

it("resolves restored references without a preloaded library and preserves mounted content on minimize", async () => {
  const handle = createRef<WorkspaceHandle>();
  render(<UniverseWorkspace ref={handle} scope={scope} initialLayout={layout} content={{}}
    resolveContent={panel => ({ref: panel.ref, title: panel.title,
      render: () => <textarea aria-label="Restored draft" defaultValue="original"/>})}/>);
  const input = await screen.findByRole("textbox", {name: "Restored draft"});
  fireEvent.change(input, {target: {value: "unsent"}});
  const generation = handle.current!.getState().panels[key].generation;
  act(() => handle.current!.dispatch({type: "minimize", key, generation}));
  act(() => handle.current!.dispatch({type: "restore", key, generation}));
  expect(screen.getByRole("textbox", {name: "Restored draft"})).toBe(input);
  expect(input).toHaveValue("unsent");
});

it("rejects a resolved renderer for another reference", async () => {
  const renderPrivate = vi.fn(() => <p>Wrong task</p>);
  render(<UniverseWorkspace scope={scope} initialLayout={layout} content={{}}
    resolveContent={() => ({ref: {...ref, id: "other"}, title: "Other", render: renderPrivate})}/>);
  expect(await screen.findByText("Content is unavailable or still loading.")).toBeInTheDocument();
  expect(renderPrivate).not.toHaveBeenCalled();
});

it("publishes the hydrated registry without treating it as an edit", async () => {
  const observed = vi.fn(); const committed = vi.fn();
  render(<UniverseWorkspace scope={scope} initialLayout={layout} content={{}}
    onStateObserved={observed} onStateCommit={committed}/>);
  await waitFor(() => expect(observed).toHaveBeenCalled());
  expect(observed.mock.calls.at(-1)?.[0].panels[key].ref).toEqual(ref);
  expect(committed).not.toHaveBeenCalled();
});

function setup() {
  const handle = createRef<WorkspaceHandle>();
  const changed = vi.fn();
  const camera = vi.fn();
  const committed = vi.fn();
  const result = render(
    <UniverseWorkspace
      ref={handle}
      scope={scope}
      initialLayout={layout}
      content={{
        [key]: {
          ref,
          title: "Task fixture",
          render: () => <textarea aria-label="Draft" defaultValue="original" />,
        },
      }}
      onStateChange={changed}
      onViewportCommit={camera}
      onStateCommit={committed}
    />
  );
  return { handle, changed, camera, committed, ...result };
}

function mouse(target: EventTarget, type: string, x: number, y: number) {
  const event = new MouseEvent(type, {
    bubbles: true,
    clientX: x,
    clientY: y,
    buttons: 1,
  });
  Object.defineProperty(event, "view", { value: window });
  fireEvent(target, event);
}

async function settleCameraEnd() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 170));
  });
}

describe("controlled workspace", () => {
  it("commits only the completed drag and never hydration or cancelled samples", async () => {
    const {handle, committed} = setup();
    expect(committed).not.toHaveBeenCalled();
    const header = screen.getByLabelText("Task fixture panel controls");
    const initial = handle.current!.getState().panels[key].rect;
    mouse(header, "mousedown", 50, 50);
    mouse(window, "mousemove", 100, 80);
    expect(committed).not.toHaveBeenCalled();
    mouse(window, "mouseup", 100, 80);
    await act(async () => {await new Promise(resolve => setTimeout(resolve, 0));});
    expect(committed).toHaveBeenCalledTimes(1);
    expect(committed.mock.calls[0]![0].panels[key].rect).toEqual(initial);
    expect(committed.mock.calls[0]![1].panels[key].rect).toEqual(handle.current!.getState().panels[key].rect);
    committed.mockClear();
    mouse(header, "mousedown", 100, 80);
    mouse(window, "mousemove", 140, 90);
    fireEvent(window, new Event("pointercancel"));
    mouse(window, "mouseup", 140, 90);
    await act(async () => {await new Promise(resolve => setTimeout(resolve, 0));});
    expect(committed).not.toHaveBeenCalled();
  });
  it("commits a lifecycle action with before and after state", () => {
    const {committed} = setup();
    fireEvent.click(screen.getByRole("button", {name: "Minimize panel"}));
    expect(committed).toHaveBeenCalledTimes(1);
    expect(committed.mock.calls[0]![0].panels[key].minimized).toBe(false);
    expect(committed.mock.calls[0]![1].panels[key].minimized).toBe(true);
  });

  it.each(["close", "minimize"] as const)(
    "returns fallback focus to the recovery group after %s without a launcher",
    (type) => {
      const { handle } = setup();
      fireEvent.click(
        screen.getByRole("button", {
          name: type === "close" ? "Close panel" : "Minimize panel",
        })
      );
      const recovery = screen.getByRole("group", {
        name: "Workspace controls",
      });
      expect(recovery).toHaveFocus();
      expect(
        screen.queryByRole("button", { name: "Workspace controls" })
      ).not.toBeInTheDocument();
      if (type === "minimize") {
        const restore = screen.getByRole("button", {
          name: "Restore Task fixture",
        });
        expect(recovery).toContainElement(restore);
        fireEvent.click(restore);
        expect(handle.current!.getState().panels[key].minimized).toBe(false);
      }
    }
  );

  it("rejects a mismapped company's renderer while retaining an operable shell", () => {
    const handle = createRef<WorkspaceHandle>();
    const foreignRender = vi.fn(() => <p>Foreign content</p>);
    render(
      <UniverseWorkspace
        ref={handle}
        scope={scope}
        initialLayout={layout}
        content={{
          [key]: {
            ref: { ...ref, companyId: "b" },
            title: "Foreign task",
            render: foreignRender,
          },
        }}
      />
    );
    expect(foreignRender).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Content is unavailable"
    );
    fireEvent.click(screen.getByRole("button", { name: "Minimize panel" }));
    expect(handle.current!.getState().panels[key].minimized).toBe(true);
    fireEvent.click(
      screen.getByRole("button", { name: "Restore Task fixture" })
    );
    fireEvent.click(screen.getByRole("button", { name: "Maximize panel" }));
    expect(handle.current!.getState().maximized).toBe(key);
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    expect(handle.current!.getState().panels[key]).toBeUndefined();
    expect(foreignRender).not.toHaveBeenCalled();
  });

  it.each(["undo", "redo"] as const)(
    "does not adopt a completed gesture's reentrant external edit or consume prior %s",
    (direction) => {
      const { handle, changed } = setup();
      const header = screen.getByLabelText("Task fixture panel controls");
      const initial = handle.current!.getState().panels[key].rect;
      fireEvent.keyDown(header, { key: "ArrowRight", altKey: true });
      const moved = handle.current!.getState().panels[key].rect;
      if (direction === "redo") act(() => handle.current!.undo());
      const before = handle.current!.getState().panels[key];
      const external = { ...initial, x: 777, y: 888 };
      let edited = false;
      changed.mockImplementation((state) => {
        if (edited || state.panels[key].rect.x === before.rect.x) return;
        edited = true;
        handle.current!.dispatch({
          type: "geometry",
          key,
          generation: before.generation,
          rect: external,
          source: "human",
        });
      });
      fireEvent.keyDown(header, { key: "ArrowRight", altKey: true });
      expect(edited).toBe(true);
      expect(handle.current!.getState().panels[key].rect).toEqual(external);
      expect(changed).toHaveBeenLastCalledWith(handle.current!.getState());
      act(() => handle.current!.undo());
      expect(handle.current!.getState().panels[key].rect).toEqual(external);
      // Returning to the prior history entry's expected value makes its survival observable.
      act(() =>
        handle.current!.dispatch({
          type: "geometry",
          key,
          generation: before.generation,
          rect: before.rect,
          source: "human",
        })
      );
      act(() => handle.current![direction]());
      expect(handle.current!.getState().panels[key].rect).toEqual(
        direction === "undo" ? initial : moved
      );
    }
  );

  it.each(["close", "minimize"] as const)(
    "publishes the final rollback when a sibling %s interrupts a real drag",
    async (type) => {
      const { handle, changed } = setup();
      const header = screen.getByLabelText("Task fixture panel controls");
      const initial = handle.current!.getState().panels[key].rect;
      fireEvent.keyDown(header, { key: "ArrowRight", altKey: true });
      const prior = handle.current!.getState().panels[key].rect;
      const siblingRef = { ...ref, id: "sibling" };
      const siblingKey = panelKey(scope, siblingRef);
      act(() => handle.current!.open({ ref: siblingRef, title: "Sibling" }));
      const sibling = handle.current!.getState().panels[siblingKey];
      mouse(header, "mousedown", 100, 100);
      mouse(window, "mousemove", 150, 120);
      expect(handle.current!.getState().panels[key].rect).not.toEqual(prior);
      expect(screen.getAllByTestId("iframe-shield")).toHaveLength(2);
      act(() =>
        handle.current!.dispatch({
          type,
          key: siblingKey,
          generation: sibling.generation,
        })
      );
      const final = handle.current!.getState();
      expect(final.panels[key].rect).toEqual(prior);
      if (type === "close") expect(final.panels[siblingKey]).toBeUndefined();
      else expect(final.panels[siblingKey].minimized).toBe(true);
      expect(changed).toHaveBeenLastCalledWith(final);
      expect(screen.queryAllByTestId("iframe-shield")).toHaveLength(0);
      mouse(window, "mousemove", 200, 150);
      mouse(window, "mouseup", 200, 150);
      expect(handle.current!.getState()).toEqual(final);
      expect(changed).toHaveBeenLastCalledWith(final);
      act(() => handle.current!.undo());
      expect(handle.current!.getState().panels[key].rect).toEqual(initial);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  );

  it.each([0.5, 1, 2])(
    "opens absent panels in screen pixels at zoom %s without refitting existing panels",
    (zoom) => {
      const { handle } = setup();
      act(() => handle.current!.setViewport({ x: 50, y: -25, zoom }));
      const newRef = { ...ref, id: "new" };
      act(() => handle.current!.open({ ref: newRef, title: "New" }));
      const opened = handle.current!.getState().panels[panelKey(scope, newRef)];
      expect(opened.rect.width * zoom).toBe(520);
      expect(opened.rect.height * zoom).toBe(360);
      expect(opened.rect.x * zoom + 50).toBeGreaterThanOrEqual(0);
      expect(opened.rect.y * zoom - 25).toBeGreaterThanOrEqual(0);
      act(() => handle.current!.setViewport({ x: 0, y: 0, zoom: 1 }));
      act(() => handle.current!.open({ ref: newRef, title: "New" }));
      expect(handle.current!.getState().panels[opened.key].rect).toEqual(
        opened.rect
      );
    }
  );
  it("routes actual frame actions through registry and preserves minimized drafts", () => {
    const { handle, camera } = setup();
    const draft = screen.getByLabelText("Draft");
    fireEvent.change(draft, { target: { value: "kept" } });
    fireEvent.click(screen.getByRole("button", { name: "Pin panel" }));
    expect(handle.current!.getState().panels[key].pinned).toBe(true);
    const normal = handle.current!.getState().panels[key].rect;
    fireEvent.click(screen.getByRole("button", { name: "Maximize panel" }));
    expect(handle.current!.getState().maximized).toBe(key);
    expect(handle.current!.getState().panels[key].rect).toEqual(normal);
    fireEvent.click(screen.getByRole("button", { name: "Minimize panel" }));
    expect(handle.current!.getState().panels[key].minimized).toBe(true);
    expect(draft.isConnected).toBe(true);
    fireEvent.click(
      screen.getByRole("button", { name: "Restore Task fixture" })
    );
    expect(screen.getByLabelText("Draft")).toBe(draft);
    expect(draft).toHaveValue("kept");
    expect(camera).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    expect(handle.current!.getState().panels[key]).toBeUndefined();
    expect(draft.isConnected).toBe(false);
  });

  it("keeps eight resize affordances and records header geometry for undo", () => {
    const { handle, container } = setup();
    expect(
      container.querySelectorAll(".react-flow__resize-control")
    ).toHaveLength(8);
    const header = screen.getByLabelText("Task fixture panel controls");
    const before = handle.current!.getState().panels[key].rect;
    fireEvent.keyDown(header, { key: "ArrowRight", altKey: true });
    expect(handle.current!.getState().panels[key].rect.x).toBe(before.x + 20);
    act(() => handle.current!.undo());
    expect(handle.current!.getState().panels[key].rect).toEqual(before);
    act(() => handle.current!.redo());
    expect(handle.current!.getState().panels[key].rect.x).toBe(before.x + 20);
    fireEvent.keyDown(screen.getByLabelText("Draft"), {
      key: "ArrowRight",
      altKey: true,
    });
    expect(handle.current!.getState().panels[key].rect.x).toBe(before.x + 20);
  });

  it("cancels real header callbacks, rolls back and preserves prior undo", async () => {
    const { handle } = setup();
    const header = screen.getByLabelText("Task fixture panel controls");
    const initial = handle.current!.getState().panels[key].rect;
    fireEvent.keyDown(header, { key: "ArrowRight", altKey: true });
    const prior = handle.current!.getState().panels[key].rect;
    const mouse = (target: EventTarget, type: string, x: number, y: number) => {
      const event = new MouseEvent(type, {
        bubbles: true,
        clientX: x,
        clientY: y,
        buttons: 1,
      });
      Object.defineProperty(event, "view", { value: window });
      fireEvent(target, event);
    };
    mouse(header, "mousedown", 100, 100);
    mouse(window, "mousemove", 150, 120);
    expect(handle.current!.getState().panels[key].rect).not.toEqual(prior);
    fireEvent.pointerCancel(window);
    expect(handle.current!.getState().panels[key].rect).toEqual(prior);
    mouse(window, "mousemove", 200, 150);
    mouse(window, "mouseup", 200, 150);
    expect(handle.current!.getState().panels[key].rect).toEqual(prior);
    act(() => handle.current!.undo());
    expect(handle.current!.getState().panels[key].rect).toEqual(initial);
    // D3 releases its native post-drag click suppression on the next timer tick.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });

  it("preserves an observer's reentrant geometry edit when the drag is cancelled", async () => {
    const { handle, changed } = setup();
    const header = screen.getByLabelText("Task fixture panel controls");
    const initial = handle.current!.getState().panels[key].rect;
    const external = { ...initial, x: 777, y: 888 };
    let edited = false;
    changed.mockImplementation((state) => {
      if (edited || state.panels[key].rect.x === initial.x) return;
      edited = true;
      handle.current!.dispatch({
        type: "geometry",
        key,
        generation: state.panels[key].generation,
        rect: external,
        source: "human",
      });
    });
    const mouse = (target: EventTarget, type: string, x: number, y: number) => {
      const event = new MouseEvent(type, {
        bubbles: true,
        clientX: x,
        clientY: y,
        buttons: 1,
      });
      Object.defineProperty(event, "view", { value: window });
      fireEvent(target, event);
    };
    mouse(header, "mousedown", 100, 100);
    mouse(window, "mousemove", 150, 120);
    expect(edited).toBe(true);
    expect(handle.current!.getState().panels[key].rect).toEqual(external);
    fireEvent.pointerCancel(window);
    expect(handle.current!.getState().panels[key].rect).toEqual(external);
    mouse(window, "mouseup", 150, 120);
    expect(handle.current!.getState().panels[key].rect).toEqual(external);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });

  it("focuses a newly opened incarnation after its frame becomes ready", async () => {
    const { handle } = setup();
    act(() =>
      handle.current!.open({
        ref: { ...ref, id: "new-focus" },
        title: "New focus",
      })
    );
    await waitFor(() =>
      expect(screen.getByLabelText("New focus panel controls")).toHaveFocus()
    );
  });

  it("waits for restored child readiness before consuming header focus", async () => {
    const { handle } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Minimize panel" }));
    const header = screen.getByLabelText("Task fixture panel controls");
    const originalFocus = header.focus.bind(header);
    const focus = vi.spyOn(header, "focus").mockImplementation(() => {
      // Browsers reject focus while React Flow still has the old inert child.
      if (!header.closest("[inert]")) originalFocus();
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Restore Task fixture" })
    );
    expect(handle.current!.getState().panels[key].minimized).toBe(false);
    await waitFor(() => expect(header).toHaveFocus());
    focus.mockRestore();
  });

  it("does not let a delayed camera synchronization roll back a live pan", async () => {
    const { handle, camera, container } = setup();
    act(() => handle.current!.setViewport({ x: 0, y: 0, zoom: 2 }));
    camera.mockClear();
    const pane = container.querySelector(".react-flow__pane")!;
    mouse(pane, "mousedown", 100, 100);
    mouse(window, "mousemove", 110, 105);
    expect(handle.current!.getViewport()).toEqual({ x: 10, y: 5, zoom: 2 });
    // XYFlow delays both synchronization and native gesture end by 150 ms.
    await settleCameraEnd();
    expect(handle.current!.getViewport()).toEqual({ x: 10, y: 5, zoom: 2 });
    expect(camera).not.toHaveBeenCalled();
    mouse(window, "mousemove", 140, 120);
    mouse(window, "mouseup", 140, 120);
    await settleCameraEnd();
    expect(handle.current!.getViewport()).toEqual({ x: 40, y: 20, zoom: 2 });
    expect(camera).toHaveBeenCalledTimes(1);
    expect(camera).toHaveBeenLastCalledWith({ x: 40, y: 20, zoom: 2 });
  });

  it("does not let an earlier native pan end overwrite a newer pan", async () => {
    const { handle, camera, container } = setup();
    act(() => handle.current!.setViewport({ x: 0, y: 0, zoom: 2 }));
    await settleCameraEnd();
    camera.mockClear();
    const pane = container.querySelector(".react-flow__pane")!;
    mouse(pane, "mousedown", 100, 100);
    mouse(window, "mousemove", 110, 105);
    mouse(window, "mouseup", 110, 105);
    mouse(pane, "mousedown", 100, 100);
    mouse(window, "mousemove", 120, 110);
    expect(handle.current!.getViewport()).toEqual({ x: 30, y: 15, zoom: 2 });
    await settleCameraEnd();
    expect(handle.current!.getViewport()).toEqual({ x: 30, y: 15, zoom: 2 });
    expect(camera).not.toHaveBeenCalled();
    mouse(window, "mousemove", 140, 120);
    mouse(window, "mouseup", 140, 120);
    await settleCameraEnd();
    expect(camera).toHaveBeenCalledTimes(1);
    expect(camera).toHaveBeenLastCalledWith({ x: 50, y: 25, zoom: 2 });
  });

  it("commits one completed native wheel pan without committing hydration", async () => {
    const { handle, camera, container } = setup();
    await settleCameraEnd();
    expect(camera).not.toHaveBeenCalled();
    fireEvent.wheel(container.querySelector(".react-flow__pane")!, {
      deltaX: 40,
      deltaY: 20,
    });
    expect(handle.current!.getViewport()).toEqual({ x: 10, y: 30, zoom: 0.5 });
    expect(camera).not.toHaveBeenCalled();
    await settleCameraEnd();
    expect(camera).toHaveBeenCalledTimes(1);
    expect(camera).toHaveBeenLastCalledWith({ x: 10, y: 30, zoom: 0.5 });
  });

  it.each(["maximize", "scope", "unmount"])(
    "ignores a pending camera end after %s",
    async (change) => {
      const { handle, camera, container, rerender, unmount } = setup();
      await settleCameraEnd();
      camera.mockClear();
      mouse(
        container.querySelector(".react-flow__pane")!,
        "mousedown",
        100,
        100
      );
      mouse(window, "mousemove", 140, 120);
      mouse(window, "mouseup", 140, 120);
      expect(handle.current!.getViewport()).toEqual({
        x: 70,
        y: 60,
        zoom: 0.5,
      });
      if (change === "maximize") {
        // D3 suppresses clicks until the first timer tick after a native drag.
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        fireEvent.click(screen.getByRole("button", { name: "Maximize panel" }));
        expect(handle.current!.getState().maximized).toBe(key);
      } else if (change === "scope") {
        const other = { ...scope, conversationId: "next-camera" };
        rerender(
          <UniverseWorkspace
            ref={handle}
            scope={other}
            initialLayout={{
              ...layout,
              scope: other,
              panels: [],
              order: [],
              selected: null,
            }}
            content={{}}
            onViewportCommit={camera}
          />
        );
      } else {
        unmount();
      }
      await settleCameraEnd();
      expect(camera).not.toHaveBeenCalled();
      if (change === "scope") {
        expect(handle.current!.getViewport()).toEqual(layout.viewport);
      } else if (change === "maximize") {
        expect(handle.current!.getViewport()).toEqual({
          x: 70,
          y: 60,
          zoom: 0.5,
        });
      }
    }
  );

  it("rejects invalid and maximized camera changes and returns defensive state", () => {
    const { handle, changed, camera } = setup();
    expect(changed).not.toHaveBeenCalled();
    const snapshot = handle.current!.getState();
    snapshot.panels[key].rect.x = 999;
    expect(handle.current!.getState().panels[key].rect.x).toBe(20);
    act(() => handle.current!.setViewport({ x: NaN, y: 0, zoom: 1 }));
    expect(camera).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Maximize panel" }));
    act(() => handle.current!.setViewport({ x: 0, y: 0, zoom: 2 }));
    expect(camera).not.toHaveBeenCalled();
    expect(handle.current!.getViewport()).toEqual(layout.viewport);
  });

  it("rejects retained callbacks after a scope switch", () => {
    const { handle, rerender, changed } = setup();
    const old = handle.current!;
    const other = { ...scope, conversationId: "new" };
    rerender(
      <UniverseWorkspace
        ref={handle}
        scope={other}
        initialLayout={{
          ...layout,
          scope: other,
          panels: [],
          order: [],
          selected: null,
        }}
        content={{}}
        onStateChange={changed}
      />
    );
    act(() => old.dispatch({ type: "close", key, generation: 1 }));
    expect(handle.current!.getState().scope).toEqual(other);
    expect(changed).not.toHaveBeenCalled();
  });
});

it("hydrates authoritative state and camera without issuing save callbacks", () => {
 const {handle, committed, camera} = setup();
 const remote = {...layout, revision: 5, viewport: {x: 100, y: 200, zoom: 1}, panels: layout.panels.map(p => ({...p, rect: {...p.rect, x: 70}}))};
 act(() => handle.current!.hydrate(remote));
 expect(handle.current!.getState().panels[key].rect.x).toBe(70);
 expect(handle.current!.getViewport()).toEqual(remote.viewport);
 expect(committed).not.toHaveBeenCalled();
 expect(camera).not.toHaveBeenCalled();
});
it("reconciles an opening receipt only against its matching generation", () => {
 const {handle, committed} = setup();
 const generation = handle.current!.getState().panels[key].generation;
 const ack = {scope, operationId: "save", revision: 2, nextOpenedOrdinal: 10, opened: [{operationIndex: 0, key, openedOrdinal: 9}]};
 act(() => handle.current!.reconcile(ack, [{scope, operationId: "save", operationIndex: 0, key, generation}]));
 expect(handle.current!.getState().panels[key].openedOrdinal).toBe(9);
 expect(committed).not.toHaveBeenCalled();
});

it("cancels a live camera interaction when recovery becomes blocked", async () => {
 const handle = createRef<WorkspaceHandle>(); const camera = vi.fn();
 const props = {scope, initialLayout: layout, content: {}, onViewportCommit: camera};
 const {container, rerender} = render(<UniverseWorkspace ref={handle} {...props}/>);
 mouse(container.querySelector(".react-flow__pane")!, "mousedown", 100, 100);
 mouse(window, "mousemove", 140, 120);
 expect(handle.current!.isInteracting()).toBe(true);
 rerender(<UniverseWorkspace ref={handle} {...props} editsBlocked/>);
 mouse(window, "mousemove", 180, 160); mouse(window, "mouseup", 180, 160);
 await settleCameraEnd();
 expect(handle.current!.isInteracting()).toBe(false);
 expect(handle.current!.getViewport()).toEqual(layout.viewport);
 expect(camera).not.toHaveBeenCalled();
});

it("reveals and highlights a deliberate offscreen reference but defers while typing", async () => {
  const { handle } = setup();
  const generation = handle.current!.getState().panels[key].generation;
  const input = screen.getByRole("textbox", { name: "Draft" });
  input.focus();
  expect(handle.current!.requestNavigation({
    id: "nav-1", panelKey: key, generation, cause: "commander-reference", highlight: true,
  })).toBe("deferred");
  expect(handle.current!.getViewport()).toEqual(layout.viewport);
  act(() => { input.blur(); screen.getByLabelText("Workspace controls").focus(); });
  await waitFor(() => expect(handle.current!.getViewport()).not.toEqual(layout.viewport));
  expect(screen.getByLabelText("Task fixture")).toHaveAttribute("data-reference-highlight", "true");
  expect(handle.current!.requestNavigation({
    id: "background", panelKey: key, generation, cause: "background", highlight: true,
  })).toBe("ignored");
});

it("commits minimize immediately while using only a noninteractive motion proxy", () => {
  const handle=createRef<WorkspaceHandle>();
  const {container}=render(<UniverseWorkspace ref={handle} scope={scope} initialLayout={layout} content={{}} motion motionMode="full"/>);
  const generation=handle.current!.getState().panels[key].generation;
  act(()=>handle.current!.dispatch({type:"minimize",key,generation}));
  expect(handle.current!.getState().panels[key].minimized).toBe(true);
  const proxy=container.querySelector(".universe-minimize-proxy");
  expect(proxy).toBeInTheDocument();
  expect(proxy).toHaveAttribute("aria-hidden","true");
  expect(proxy?.querySelector("button,input,textarea")).toBeNull();
});
