import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SessionRow } from "@/components/commander/SessionRow";
import type { ConversationRow } from "@/api/internal-agent";

function makeConv(overrides: Partial<ConversationRow> = {}): ConversationRow {
  return {
    id: "conv-1",
    title: "Test session",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messageCount: 3,
    userId: "user-1",
    pinned: false,
    ...overrides,
  };
}

describe("SessionRow", () => {
  it("renders the conversation title", () => {
    render(
      <SessionRow
        conversation={makeConv({ title: "Vision brainstorm" })}
        isActive={false}
        onSelect={vi.fn()}
        onArchive={vi.fn()}
      />,
    );
    expect(screen.getByText("Vision brainstorm")).toBeInTheDocument();
  });

  it("falls back to 'New chat' when title is null", () => {
    render(
      <SessionRow
        conversation={makeConv({ title: null })}
        isActive={false}
        onSelect={vi.fn()}
        onArchive={vi.fn()}
      />,
    );
    expect(screen.getByText("New chat")).toBeInTheDocument();
  });

  it("shows filled dot (bg-brand) when isActive is true and not pinned", () => {
    const { container } = render(
      <SessionRow
        conversation={makeConv({ pinned: false })}
        isActive={true}
        onSelect={vi.fn()}
        onArchive={vi.fn()}
      />,
    );
    // The active dot is a <span> with bg-brand class
    const dot = container.querySelector("span.bg-brand");
    expect(dot).toBeInTheDocument();
  });

  it("shows outline dot (border-very-dim, no bg-brand) when not active and not pinned", () => {
    const { container } = render(
      <SessionRow
        conversation={makeConv({ pinned: false })}
        isActive={false}
        onSelect={vi.fn()}
        onArchive={vi.fn()}
      />,
    );
    // Active dot should not be present
    expect(container.querySelector("span.bg-brand")).not.toBeInTheDocument();
    // Outline dot uses border-[1.5px]
    const outlineDot = container.querySelector("span.rounded-full");
    expect(outlineDot).toBeInTheDocument();
  });

  it("shows Pin icon when conversation.pinned is true", () => {
    render(
      <SessionRow
        conversation={makeConv({ pinned: true })}
        isActive={false}
        onSelect={vi.fn()}
        onArchive={vi.fn()}
      />,
    );
    // Lucide Pin renders an SVG; check via title or aria / role fallback.
    // Lucide icons have no default aria — we check that neither dot variant appears.
    const { container } = render(
      <SessionRow
        conversation={makeConv({ pinned: true })}
        isActive={false}
        onSelect={vi.fn()}
        onArchive={vi.fn()}
      />,
    );
    expect(container.querySelector("span.bg-brand")).not.toBeInTheDocument();
    // A Lucide SVG should be rendered inside the indicator box
    const indicatorBox = container.querySelector(".w-3.h-3");
    expect(indicatorBox?.querySelector("svg")).toBeInTheDocument();
  });
});
