import { describe, expect, it, vi } from "vitest";
import type { CommanderInputRef } from "@armyofagents/shared";
import {
  buildCommanderInputRefState,
  openCommanderInputRef,
  settleCommanderInputRefsAfterSend,
  type CommanderInputRefOpenDeps,
} from "./InternalAgentPanel";

const taskRef: CommanderInputRef = {
  v: 1,
  kind: "task",
  id: "task-1",
  label: "Fix login",
  route: "/issues/task-1",
};

const inboxRef: CommanderInputRef = {
  v: 1,
  kind: "inbox",
  id: "hub-1",
  label: "Approve budget",
  route: "/inbox/waiting/hub-1",
};

const discussionRef: CommanderInputRef = {
  v: 1,
  kind: "discussion",
  id: "discussion-1",
  label: "Launch review",
  route: "/discussions/discussion-1",
};

const assetRef: CommanderInputRef = {
  v: 1,
  kind: "asset",
  id: "asset-1",
  label: "brief.pdf",
  route: "/api/assets/asset-1/content",
};

describe("Commander input refs", () => {
  it("adds a new ref once and reports duplicate refs for emphasis", () => {
    const first = buildCommanderInputRefState([], taskRef);
    expect(first).toEqual({
      refs: [taskRef],
      duplicateKey: null,
    });

    const second = buildCommanderInputRefState(first.refs, taskRef);
    expect(second).toEqual({
      refs: [taskRef],
      duplicateKey: "task:task-1",
    });
  });

  it("routes tasks to the slide-over, discussions to the work pane, and inbox to the viewer", () => {
    const deps: CommanderInputRefOpenDeps = {
      openPreview: vi.fn(),
      openTask: vi.fn(),
      openDiscussion: vi.fn(),
      openArtifact: vi.fn(),
      openInputRef: vi.fn(),
      navigate: vi.fn(),
    };

    openCommanderInputRef(taskRef, deps);
    expect(deps.openTask).toHaveBeenCalledWith("task-1", "Fix login");
    expect(deps.openPreview).not.toHaveBeenCalled();
    expect(deps.openInputRef).not.toHaveBeenCalled();

    openCommanderInputRef(discussionRef, deps);
    expect(deps.openDiscussion).toHaveBeenCalledWith("discussion-1", "Launch review");
    expect(deps.openPreview).not.toHaveBeenCalled();
    expect(deps.openInputRef).not.toHaveBeenCalled();

    expect(deps.navigate).not.toHaveBeenCalled();

    openCommanderInputRef(inboxRef, deps);
    expect(deps.openPreview).toHaveBeenCalledWith("right-panel");
    expect(deps.openInputRef).toHaveBeenCalledWith(inboxRef);
    expect(deps.navigate).not.toHaveBeenCalled();
  });

  it("preserves attached asset refs on send failure and removes only accepted refs", () => {
    expect(settleCommanderInputRefsAfterSend([assetRef], [assetRef], false)).toEqual([assetRef]);
    expect(settleCommanderInputRefsAfterSend([assetRef, taskRef], [assetRef], true)).toEqual([taskRef]);
  });
});
