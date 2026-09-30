import { describe, expect, it } from "vitest";
import {
  COMMANDER_INTERACTION_CONTRACT,
  commanderBreakpoint,
  commanderExpandedWorkSurfaceCount,
  commanderPaneCoordinatorReducer,
  initialCommanderPaneCoordinatorState,
} from "./commanderPaneCoordinator";

function reduce(
  width: number,
  actions: Parameters<typeof commanderPaneCoordinatorReducer>[1][],
) {
  return actions.reduce(commanderPaneCoordinatorReducer, initialCommanderPaneCoordinatorState(width));
}

describe("Commander breakpoint contract", () => {
  it("uses the approved mobile, tablet, desktop, and wide boundaries", () => {
    expect(commanderBreakpoint(390)).toBe("mobile");
    expect(commanderBreakpoint(720)).toBe("mobile");
    expect(commanderBreakpoint(768)).toBe("tablet");
    expect(commanderBreakpoint(1099)).toBe("tablet");
    expect(commanderBreakpoint(1280)).toBe("desktop");
    expect(commanderBreakpoint(1600)).toBe("wide");
  });

  it("freezes accessibility and density constants before component work", () => {
    expect(COMMANDER_INTERACTION_CONTRACT.minimumTouchTargetPx).toBe(44);
    expect(COMMANDER_INTERACTION_CONTRACT.minimumMarkerTextPx).toBe(11);
    expect(COMMANDER_INTERACTION_CONTRACT.maximumVisibleAttentionMarkers).toBe(2);
  });
});

describe("Commander pane coordinator", () => {
  it("opens Workspace focus and restores the exact default layout", () => {
    const focused = reduce(1280, [{
      type: "open_focus",
      target: { kind: "workspace", entityId: "task-1", anchorId: "question-1" },
      originFocusKey: "cockpit:task-1",
    }]);
    expect(focused.focus).toMatchObject({ kind: "workspace", entityId: "task-1" });
    expect(focused.restoreSnapshot).not.toBeNull();

    const closed = commanderPaneCoordinatorReducer(focused, { type: "close_focus" });
    expect(closed).toMatchObject({ chat: "expanded", focus: null, viewerOpen: false, cockpit: "rail" });
  });

  it("replaces Focus without replacing the original restoration snapshot", () => {
    const first = reduce(1600, [{
      type: "open_focus",
      target: { kind: "workspace", entityId: "task-1" },
      originFocusKey: "task-1-row",
    }]);
    const second = commanderPaneCoordinatorReducer(first, {
      type: "open_focus",
      target: { kind: "discussion", entityId: "discussion-1" },
      originFocusKey: "discussion-1-row",
    });

    expect(second.focus).toEqual({ kind: "discussion", entityId: "discussion-1" });
    expect(second.restoreSnapshot).toEqual(first.restoreSnapshot);
  });

  it("uses Viewer as the topmost surface and never expands more than two work surfaces", () => {
    const state = reduce(1600, [
      {
        type: "open_focus",
        target: { kind: "discussion", entityId: "discussion-1" },
        originFocusKey: "discussion-row",
      },
      { type: "open_viewer", originFocusKey: "artifact-link" },
    ]);

    expect(state).toMatchObject({ chat: "rail", viewerOpen: true });
    expect(commanderExpandedWorkSurfaceCount(state)).toBe(2);
    expect(commanderPaneCoordinatorReducer(state, { type: "escape" }).viewerOpen).toBe(false);
  });

  it("hides chat when Viewer opens over Focus at desktop width", () => {
    const state = reduce(1280, [
      {
        type: "open_focus",
        target: { kind: "workspace", entityId: "task-1", title: "Review onboarding" },
        originFocusKey: "review-row",
      },
      { type: "open_viewer", originFocusKey: "artifact-link" },
    ]);

    expect(state.focus).toMatchObject({
      kind: "workspace",
      entityId: "task-1",
      title: "Review onboarding",
    });
    expect(state.chat).toBe("hidden");
    expect(commanderExpandedWorkSurfaceCount(state)).toBe(2);
  });

  it("closes drawer, Viewer, and Focus in Escape order", () => {
    const open = reduce(1280, [
      {
        type: "open_focus",
        target: { kind: "workspace", entityId: "task-1" },
        originFocusKey: "task-row",
      },
      { type: "open_viewer", originFocusKey: "approval-marker" },
      { type: "open_cockpit_drawer" },
    ]);
    const noDrawer = commanderPaneCoordinatorReducer(open, { type: "escape" });
    const noViewer = commanderPaneCoordinatorReducer(noDrawer, { type: "escape" });
    const noFocus = commanderPaneCoordinatorReducer(noViewer, { type: "escape" });

    expect(noDrawer.cockpitDrawerOpen).toBe(false);
    expect(noDrawer.viewerOpen).toBe(true);
    expect(noViewer.viewerOpen).toBe(false);
    expect(noViewer.focus).not.toBeNull();
    expect(noFocus.focus).toBeNull();
  });

  it("replaces chat with Focus at tablet and mobile widths", () => {
    const tablet = reduce(768, [{
      type: "open_focus",
      target: { kind: "workspace", entityId: "task-1" },
      originFocusKey: "task-row",
    }]);
    expect(tablet.chat).toBe("hidden");
    expect(commanderExpandedWorkSurfaceCount(tablet)).toBe(1);
  });
});
