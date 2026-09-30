import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommanderEmptyState } from "@/components/commander/CommanderEmptyState";
import type { ConversationRow } from "@/api/internal-agent";

function makeConv(overrides: Partial<ConversationRow> = {}): ConversationRow {
  return {
    id: "conv-1",
    title: "Test chat",
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    updatedAt: new Date(Date.now() - 60_000).toISOString(),
    messageCount: 3,
    userId: "user-1",
    pinned: false,
    ...overrides,
  };
}

describe("CommanderEmptyState", () => {
  it("renders 4 prompt chips", () => {
    render(
      <CommanderEmptyState
        onPromptClick={vi.fn()}
        recentChats={[]}
        onSelectChat={vi.fn()}
      />,
    );
    expect(screen.getByText("What happened while I was away?")).toBeInTheDocument();
    expect(screen.getByText("Show me blocked tasks")).toBeInTheDocument();
    expect(screen.getByText("Summarize today's progress")).toBeInTheDocument();
    expect(screen.getByText("What needs my approval?")).toBeInTheDocument();
  });

  it("clicking a prompt chip calls onPromptClick with the chip text", async () => {
    const user = userEvent.setup();
    const onPromptClick = vi.fn();
    render(
      <CommanderEmptyState
        onPromptClick={onPromptClick}
        recentChats={[]}
        onSelectChat={vi.fn()}
      />,
    );
    await user.click(screen.getByText("Show me blocked tasks"));
    expect(onPromptClick).toHaveBeenCalledWith("Show me blocked tasks");
  });

  it("clicking each chip passes the correct text", async () => {
    const user = userEvent.setup();
    const onPromptClick = vi.fn();
    render(
      <CommanderEmptyState
        onPromptClick={onPromptClick}
        recentChats={[]}
        onSelectChat={vi.fn()}
      />,
    );
    await user.click(screen.getByText("What happened while I was away?"));
    expect(onPromptClick).toHaveBeenCalledWith("What happened while I was away?");

    await user.click(screen.getByText("Summarize today's progress"));
    expect(onPromptClick).toHaveBeenCalledWith("Summarize today's progress");

    await user.click(screen.getByText("What needs my approval?"));
    expect(onPromptClick).toHaveBeenCalledWith("What needs my approval?");
  });

  it("renders recent chats and clicking one calls onSelectChat", async () => {
    const user = userEvent.setup();
    const onSelectChat = vi.fn();
    const chats = [
      makeConv({ id: "c1", title: "Sprint review" }),
      makeConv({ id: "c2", title: "Budget check" }),
    ];
    render(
      <CommanderEmptyState
        onPromptClick={vi.fn()}
        recentChats={chats}
        onSelectChat={onSelectChat}
      />,
    );
    expect(screen.getByText("Sprint review")).toBeInTheDocument();
    expect(screen.getByText("Budget check")).toBeInTheDocument();

    await user.click(screen.getByText("Sprint review"));
    expect(onSelectChat).toHaveBeenCalledWith("c1");

    await user.click(screen.getByText("Budget check"));
    expect(onSelectChat).toHaveBeenCalledWith("c2");
  });

  it("uses greetingText when provided", () => {
    render(
      <CommanderEmptyState
        greetingText="Here's what happened"
        onPromptClick={vi.fn()}
        recentChats={[]}
        onSelectChat={vi.fn()}
      />,
    );
    expect(screen.getByText("Here's what happened")).toBeInTheDocument();
  });

  it("falls back to default greeting when greetingText is omitted", () => {
    render(
      <CommanderEmptyState
        onPromptClick={vi.fn()}
        recentChats={[]}
        onSelectChat={vi.fn()}
      />,
    );
    expect(screen.getByText("How can I help you today?")).toBeInTheDocument();
  });

  it("shows 'Untitled chat' for chats with null title", () => {
    render(
      <CommanderEmptyState
        onPromptClick={vi.fn()}
        recentChats={[makeConv({ id: "c1", title: null })]}
        onSelectChat={vi.fn()}
      />,
    );
    expect(screen.getByText("Untitled chat")).toBeInTheDocument();
  });

  it("does not render Recent section when recentChats is empty", () => {
    render(
      <CommanderEmptyState
        onPromptClick={vi.fn()}
        recentChats={[]}
        onSelectChat={vi.fn()}
      />,
    );
    expect(screen.queryByText("Recent")).not.toBeInTheDocument();
  });
});
