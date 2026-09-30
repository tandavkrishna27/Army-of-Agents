import { describe, expect, it } from "vitest";
import {
  commanderPaneReducer,
  initialCommanderPaneState,
  type CommanderPaneSnapshot,
} from "./commanderPaneModel";

const snapshot: CommanderPaneSnapshot = {
  sessionsCollapsed: false,
  cockpitCollapsed: false,
  viewerCollapsed: true,
};

describe("commanderPaneReducer", () => {
  it("captures the pre-discussion snapshot once and retains it on replacement", () => {
    const first = commanderPaneReducer(initialCommanderPaneState, {
      type: "open_discussion",
      discussion: { id: "d1", title: "First" },
      snapshot,
    });
    const replacement = commanderPaneReducer(first, {
      type: "open_discussion",
      discussion: { id: "d2", title: "Second" },
      snapshot: { sessionsCollapsed: true, cockpitCollapsed: true, viewerCollapsed: false },
    });

    expect(replacement.discussion?.id).toBe("d2");
    expect(replacement.restoreSnapshot).toEqual(snapshot);
  });

  it("opens and closes only the topmost nested detail", () => {
    const discussion = commanderPaneReducer(initialCommanderPaneState, {
      type: "open_discussion",
      discussion: { id: "d1", title: "First" },
      snapshot,
    });
    const detail = commanderPaneReducer(discussion, { type: "open_nested_detail" });
    expect(detail.nestedDetailOpen).toBe(true);
    expect(commanderPaneReducer(detail, { type: "close_nested_detail" })).toEqual(discussion);
  });

  it("closing Discussion clears transient state after the caller reads the snapshot", () => {
    const discussion = commanderPaneReducer(initialCommanderPaneState, {
      type: "open_discussion",
      discussion: { id: "d1", title: "First" },
      snapshot,
    });
    expect(commanderPaneReducer(discussion, { type: "close_discussion" })).toEqual(
      initialCommanderPaneState,
    );
  });
});
