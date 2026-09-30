import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommanderSurface } from "../CommanderSurface";
import type { Presentation } from "../commander-presentation";

const pres = (over: Partial<Presentation> = {}): Presentation => ({
  chat: "compact",
  lastVisible: "compact",
  blob: true,
  captions: false,
  chatFrontmost: true,
  ...over,
});

describe("CommanderSurface", () => {
  it("compact: shows the blob, status and the Ask Commander composer", () => {
    render(<CommanderSurface presentation={pres()} onPrimary={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Commander" })).toBeInTheDocument();
    expect(screen.getByText(/Ready when you are/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Ask Commander" })).toBeInTheDocument();
  });

  it("blob click calls onPrimary; Expand calls onExpand", async () => {
    const user = userEvent.setup();
    const onPrimary = vi.fn();
    const onExpand = vi.fn();
    render(
      <CommanderSurface presentation={pres()} onPrimary={onPrimary} onExpand={onExpand} />
    );
    await user.click(screen.getByRole("button", { name: "Commander" }));
    expect(onPrimary).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Expand chat" }));
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  it("tucked: hides the composer but keeps the blob", () => {
    render(<CommanderSurface presentation={pres({ chat: "tucked", chatFrontmost: false })} onPrimary={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Commander" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Ask Commander" })).toBeNull();
  });

  it("expanded: renders history + Tuck/Maximize/Compact controls", () => {
    render(
      <CommanderSurface
        presentation={pres({ chat: "expanded", lastVisible: "expanded" })}
        messages={[{ id: "m1", role: "commander", text: "Hello there" }]}
        onPrimary={vi.fn()}
      />
    );
    expect(screen.getByText("Hello there")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tuck chat" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Maximize chat" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Compact chat" })).toBeInTheDocument();
  });

  it("maximized: offers Restore instead of Maximize", () => {
    render(
      <CommanderSurface presentation={pres({ chat: "maximized", lastVisible: "expanded" })} onPrimary={vi.fn()} />
    );
    expect(screen.getByRole("button", { name: "Restore chat" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Maximize chat" })).toBeNull();
  });

  it("captions render only when provided; blob hides when presentation.blob is false", () => {
    const { rerender } = render(
      <CommanderSurface presentation={pres({ captions: true })} captionText="Live caption" onPrimary={vi.fn()} />
    );
    expect(screen.getByText("Live caption")).toBeInTheDocument();
    rerender(<CommanderSurface presentation={pres({ blob: false })} onPrimary={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Commander" })).toBeNull();
  });
});
