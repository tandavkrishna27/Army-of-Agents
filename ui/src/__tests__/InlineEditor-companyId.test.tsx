import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InlineEditor } from "../components/InlineEditor";

// Capture props passed into MarkdownEditor so we can assert companyId forwarding.
const capturedProps: Record<string, unknown> = {};

vi.mock("../components/MarkdownEditor", () => ({
  MarkdownEditor: (props: Record<string, unknown>) => {
    Object.assign(capturedProps, props);
    return (
      <textarea
        data-testid="markdown-editor-mock"
        value={(props.value as string) ?? ""}
        placeholder={props.placeholder as string}
        onChange={(event) => (props.onChange as (value: string) => void)(event.target.value)}
        onBlur={() => (props.onBlur as (() => void) | undefined)?.()}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
            (props.onSubmit as (() => void) | undefined)?.();
          }
        }}
      />
    );
  },
}));

vi.mock("../components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

describe("InlineEditor companyId forwarding", () => {
  beforeEach(() => {
    for (const key of Object.keys(capturedProps)) delete capturedProps[key];
  });

  it("forwards companyId prop to MarkdownEditor in multiline edit mode", async () => {
    const user = userEvent.setup();
    render(
      <InlineEditor
        value=""
        onSave={() => {}}
        multiline
        companyId="comp-abc-123"
        placeholder="click me"
      />,
    );

    await user.click(screen.getByText("click me"));
    expect(capturedProps.companyId).toBe("comp-abc-123");
  });

  it("forwards null companyId when not provided", async () => {
    const user = userEvent.setup();
    render(<InlineEditor value="" onSave={() => {}} multiline placeholder="click me" />);

    await user.click(screen.getByText("click me"));
    expect(capturedProps.companyId).toBeUndefined();
  });

  it("autosaves multiline edits on blur without showing explicit Save and Cancel buttons", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <InlineEditor
        value="Old description"
        onSave={onSave}
        multiline
        multilineAutoSave
        placeholder="click me"
      />,
    );

    await user.click(screen.getByText("Old description"));
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();

    const editor = screen.getByTestId("markdown-editor-mock");
    await user.clear(editor);
    await user.type(editor, "Updated description");
    await user.tab();

    expect(onSave).toHaveBeenCalledWith("Updated description");
  });

  it("lets Escape revert a multiline autosave draft before it is saved", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <InlineEditor
        value="Original description"
        onSave={onSave}
        multiline
        multilineAutoSave
        placeholder="click me"
      />,
    );

    await user.click(screen.getByText("Original description"));
    const editor = screen.getByTestId("markdown-editor-mock");
    await user.clear(editor);
    await user.type(editor, "Discard this");
    await user.keyboard("{Escape}");

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText("Original description")).toBeInTheDocument();
  });
});
