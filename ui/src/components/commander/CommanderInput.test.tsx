import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  COMMANDER_INPUT_REF_DRAG_MIME,
  encodeCommanderInputRefDragPayload,
  type CommanderInputRef,
} from "@armyofagents/shared";
import { CommanderInput } from "./CommanderInput";

const taskRef: CommanderInputRef = {
  v: 1,
  kind: "task",
  id: "task-1",
  label: "Fix login",
  route: "/issues/task-1",
};

describe("CommanderInput", () => {
  it("accepts dropped Commander reference payloads", () => {
    const onReferenceDrop = vi.fn();
    render(
      <CommanderInput
        placeholder="Ask Commander"
        onSubmit={vi.fn()}
        onEmptyChange={vi.fn()}
        onSlashChange={vi.fn()}
        onReferenceDrop={onReferenceDrop}
      />,
    );

    fireEvent.drop(screen.getByRole("textbox"), {
      dataTransfer: {
        files: [],
        getData: (type: string) =>
          type === COMMANDER_INPUT_REF_DRAG_MIME
            ? encodeCommanderInputRefDragPayload(taskRef, "Show this task")
            : "",
      },
    });

    expect(onReferenceDrop).toHaveBeenCalledWith({
      ref: taskRef,
      prompt: "Show this task",
    });
  });

  it("forwards pasted files to the attachment uploader", () => {
    const onFilesSelected = vi.fn();
    const image = new File(["image"], "clipboard.png", { type: "image/png" });
    render(
      <CommanderInput
        placeholder="Ask Commander"
        onSubmit={vi.fn()}
        onEmptyChange={vi.fn()}
        onSlashChange={vi.fn()}
        onFilesSelected={onFilesSelected}
      />,
    );

    fireEvent.paste(screen.getByRole("textbox"), {
      clipboardData: { files: [image], getData: () => "" },
    });

    expect(onFilesSelected).toHaveBeenCalledWith([image]);
  });

  it("forwards dropped OS files without treating them as Commander refs", () => {
    const onFilesSelected = vi.fn();
    const pdf = new File(["pdf"], "brief.pdf", { type: "application/pdf" });
    render(
      <CommanderInput
        placeholder="Ask Commander"
        onSubmit={vi.fn()}
        onEmptyChange={vi.fn()}
        onSlashChange={vi.fn()}
        onFilesSelected={onFilesSelected}
      />,
    );

    fireEvent.drop(screen.getByRole("textbox"), {
      dataTransfer: { files: [pdf], getData: () => "" },
    });

    expect(onFilesSelected).toHaveBeenCalledWith([pdf]);
  });

});
