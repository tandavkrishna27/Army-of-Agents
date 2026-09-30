import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TranscriptMessageBlock } from "../../components/workspace/transcript/TranscriptMessageBlock";

vi.mock("../../components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => <div>{children}</div>,
}));

describe("TranscriptMessageBlock", () => {
  it("renders assistant text as quiet thread prose without timestamp chrome", () => {
    render(
      <TranscriptMessageBlock
        role="assistant"
        text="I checked the files and updated the footer."
        streaming={false}
        ts="2026-05-17T10:00:00.000Z"
      />,
    );

    expect(screen.getByTestId("transcript-message-block")).toHaveClass("px-1");
    expect(screen.getByText("I checked the files and updated the footer.")).toBeInTheDocument();
    expect(screen.queryByText(/10:00/)).not.toBeInTheDocument();
  });
});
