/**
 * MentionInput.test.tsx
 * Tests for the @mention chip input component
 */
import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../../__tests__/test-utils";
import { MentionInput } from "../MentionInput";

describe("MentionInput", () => {
  it("renders the input field", () => {
    renderWithProviders(
      <MentionInput chips={[]} onChipsChange={vi.fn()} />,
    );
    expect(screen.getByTestId("mention-input")).toBeInTheDocument();
  });

  it("renders existing chips", () => {
    renderWithProviders(
      <MentionInput chips={["@alice", "@Bot"]} onChipsChange={vi.fn()} />,
    );
    expect(screen.getByTestId("mention-chip-alice")).toBeInTheDocument();
    expect(screen.getByTestId("mention-chip-Bot")).toBeInTheDocument();
  });

  it("creates a chip when user types @name and presses Enter", async () => {
    const onChipsChange = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <MentionInput chips={[]} onChipsChange={onChipsChange} />,
    );
    const input = screen.getByTestId("mention-input");
    await user.click(input);
    await user.type(input, "@alice");
    await user.keyboard("{Enter}");
    expect(onChipsChange).toHaveBeenCalledWith(["@alice"]);
  });

  it("creates a chip when user types @name and presses Space", async () => {
    const onChipsChange = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <MentionInput chips={[]} onChipsChange={onChipsChange} />,
    );
    const input = screen.getByTestId("mention-input");
    await user.click(input);
    await user.type(input, "@Bot ");
    expect(onChipsChange).toHaveBeenCalledWith(["@Bot"]);
  });

  it("removes a chip via its X button", async () => {
    const onChipsChange = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <MentionInput chips={["@alice"]} onChipsChange={onChipsChange} />,
    );
    const removeBtn = screen.getByRole("button", { name: /remove @alice/i });
    await user.click(removeBtn);
    expect(onChipsChange).toHaveBeenCalledWith([]);
  });

  it("renders placeholder when chips list is empty", () => {
    renderWithProviders(
      <MentionInput chips={[]} onChipsChange={vi.fn()} placeholder="@mention someone..." />,
    );
    expect(screen.getByPlaceholderText("@mention someone...")).toBeInTheDocument();
  });
});
