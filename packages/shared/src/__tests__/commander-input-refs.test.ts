import { describe, expect, it } from "vitest";
import {
  COMMANDER_INPUT_REF_DRAG_MIME,
  appendCommanderInputRef,
  appendCommanderInputRefsToMessage,
  commanderInputRefKey,
  encodeCommanderInputRefDragPayload,
  formatCommanderInputRefsBlock,
  parseCommanderInputRefDragPayload,
  type CommanderInputRef,
} from "../commander-input-refs.js";

const taskRef: CommanderInputRef = {
  v: 1,
  kind: "task",
  id: "task-1",
  label: "AOA-1 Fix cockpit",
  route: "/issues/task-1",
  detail: "status=in_review",
};

const assetRef: CommanderInputRef = {
  v: 1,
  kind: "asset",
  id: "asset-1",
  label: "launch-plan.pdf",
  route: "/api/assets/asset-1/content",
  detail: "contentType=application/pdf | byteSize=2048",
  source: "commander-upload",
};

describe("commander input refs", () => {
  it("builds stable keys", () => {
    expect(commanderInputRefKey(taskRef)).toBe("task:task-1");
  });

  it("formats references as a compact text block", () => {
    expect(formatCommanderInputRefsBlock([taskRef])).toContain(
      "Task: AOA-1 Fix cockpit | id=task-1 | route=/issues/task-1 | detail=status=in_review",
    );
  });

  it("formats uploaded assets as typed file context", () => {
    expect(commanderInputRefKey(assetRef)).toBe("asset:asset-1");
    expect(formatCommanderInputRefsBlock([assetRef])).toContain(
      "File: launch-plan.pdf | id=asset-1 | route=/api/assets/asset-1/content | source=commander-upload | detail=contentType=application/pdf | byteSize=2048",
    );
  });

  it("appends refs to an existing message", () => {
    expect(appendCommanderInputRefsToMessage("What changed?", [taskRef])).toContain(
      "What changed?\n\nReferenced context:",
    );
  });

  it("dedupes existing refs and reports the existing key", () => {
    expect(appendCommanderInputRef([taskRef], taskRef)).toEqual({
      refs: [taskRef],
      added: false,
      existingKey: "task:task-1",
    });
  });

  it("encodes and parses drag payloads", () => {
    const encoded = encodeCommanderInputRefDragPayload(taskRef, "Show this task");
    expect(encoded).toContain(COMMANDER_INPUT_REF_DRAG_MIME);
    expect(parseCommanderInputRefDragPayload(encoded)).toEqual({
      ref: taskRef,
      prompt: "Show this task",
    });
    expect(parseCommanderInputRefDragPayload("not-json")).toBeNull();
  });
});
