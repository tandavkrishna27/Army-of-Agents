/**
 * Shared composer primitives (approved mock v2): one icon button, one
 * mention picker, one trailing-@ detection rule for every chat surface.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ComposerMentionMenu, type MentionOption } from "./ComposerMentionMenu";
import { ComposerIconButton } from "./ComposerIconButton";
import { detectTrailingMention } from "./useComposerMention";

const OPTIONS: MentionOption[] = [
  { id: "a1", name: "Adjutant", type: "agent" },
  { id: "a2", name: "Scout", type: "agent" },
  { id: "u1", name: "Maya", type: "user", subtitle: "maya@co.io" },
];

describe("ComposerMentionMenu", () => {
  it("renders options with the first item preselected styling and picks on mousedown", () => {
    const onSelect = vi.fn();
    render(
      <ComposerMentionMenu options={OPTIONS} selectionIndex={0} onSelect={onSelect} />,
    );
    const first = screen.getByTestId("composer-mention-option-Adjutant");
    expect(first.getAttribute("aria-selected")).toBe("true");
    // onMouseDown (not click) so selection wins the race against input blur.
    fireEvent.mouseDown(screen.getByTestId("composer-mention-option-Scout"));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ name: "Scout" }));
  });

  it("shows the empty state when nothing matches", () => {
    render(<ComposerMentionMenu options={[]} selectionIndex={0} onSelect={() => {}} />);
    expect(screen.getByTestId("composer-mention-empty").textContent).toContain("No matches");
    expect(screen.queryByTestId("composer-mention-loading")).not.toBeInTheDocument();
  });

  it("shows the loading row instead of 'No matches' while teammates load (F8)", () => {
    render(<ComposerMentionMenu options={[]} selectionIndex={0} onSelect={() => {}} loading />);
    expect(screen.getByTestId("composer-mention-loading").textContent).toContain(
      "Loading teammates",
    );
    expect(screen.queryByTestId("composer-mention-empty")).not.toBeInTheDocument();
  });

  it("ignores loading once options exist — the real list renders", () => {
    render(
      <ComposerMentionMenu options={OPTIONS} selectionIndex={0} onSelect={() => {}} loading />,
    );
    expect(screen.getByTestId("composer-mention")).toBeTruthy();
    expect(screen.queryByTestId("composer-mention-loading")).not.toBeInTheDocument();
  });

  it("honors a legacy testid prefix (Discussion delegate)", () => {
    render(
      <ComposerMentionMenu
        options={OPTIONS}
        selectionIndex={0}
        onSelect={() => {}}
        testIdPrefix="entry-autocomplete"
      />,
    );
    expect(screen.getByTestId("entry-autocomplete")).toBeTruthy();
    expect(screen.getByTestId("entry-autocomplete-option-Maya")).toBeTruthy();
  });
});

describe("ComposerIconButton", () => {
  it("renders enabled with the shared size/rounding and fires onClick", () => {
    const onClick = vi.fn();
    render(
      <ComposerIconButton aria-label="Attach file" onClick={onClick}>
        x
      </ComposerIconButton>,
    );
    const btn = screen.getByRole("button", { name: "Attach file" });
    expect(btn.className).toContain("size-8");
    expect(btn.className).toContain("rounded-md");
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalled();
  });

  it("comingSoon renders disabled + dimmed with a coming-soon title", () => {
    render(
      <ComposerIconButton aria-label="Voice input" title="Voice input" comingSoon>
        m
      </ComposerIconButton>,
    );
    const btn = screen.getByRole("button", { name: "Voice input" });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(btn.className).toContain("opacity-40");
    expect(btn.getAttribute("title")).toBe("Voice input — coming soon");
  });

  it("comingSoon without a title renders a single 'Coming soon', never doubled (F7)", () => {
    render(
      <ComposerIconButton aria-label="Voice input" comingSoon>
        m
      </ComposerIconButton>,
    );
    const btn = screen.getByRole("button", { name: "Voice input" });
    expect(btn.getAttribute("title")).toBe("Coming soon");
  });
});

describe("detectTrailingMention", () => {
  it.each([
    ["@", 1, ""],
    ["hi @Adj", 7, "Adj"],
    ["hi @Adj more", 7, "Adj"], // caret inside — only text up to caret counts
    ["no mention", 10, null],
    ["email@host", 10, null], // @ must follow start or whitespace
  ])("%s (caret %i) → token %s", (text, caret, expected) => {
    const hit = detectTrailingMention(text as string, caret as number);
    expect(hit?.token ?? null).toBe(expected);
  });

  it("returns the exact range of the token so select() can replace mid-text (F1)", () => {
    // "hello  world" with "@S" typed at caret 6 → "hello @S world", caret 8.
    const hit = detectTrailingMention("hello @S world", 8);
    expect(hit).toEqual({ token: "S", start: 6, end: 8 });
  });
});
