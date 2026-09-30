/**
 * Task 3: Tests for CockpitConversationZone (plan §Task 3).
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { CommanderOutputRef } from "@armyofagents/shared";
import { CockpitConversationZone } from "./CockpitConversationZone";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeRef(overrides?: Partial<CommanderOutputRef>): CommanderOutputRef {
  return {
    v: 1,
    kind: "artifact",
    id: "artifact-uuid-1234",
    versionId: "ver-abc-5678",
    title: "My Spec Doc",
    action: "created",
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("CockpitConversationZone", () => {
  it("renders null when refs is empty (no DOM output)", () => {
    const { container } = render(<CockpitConversationZone refs={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the zone when refs is non-empty (testid present)", () => {
    render(<CockpitConversationZone refs={[makeRef()]} />);
    expect(screen.getByTestId("cockpit-zone-conversation")).toBeInTheDocument();
  });

  it("shows the ref title when provided", () => {
    render(<CockpitConversationZone refs={[makeRef({ title: "My Spec Doc" })]} />);
    expect(screen.getByText("My Spec Doc")).toBeInTheDocument();
  });

  it("falls back to 'Artifact <id8>' when title is null", () => {
    render(
      <CockpitConversationZone
        refs={[makeRef({ title: null, id: "abcdefghijklmnop" })]}
      />,
    );
    // Only the first 8 chars of the id
    expect(screen.getByText("Artifact abcdefgh")).toBeInTheDocument();
  });

  it("shows 'created' note only for action='created'", () => {
    render(
      <CockpitConversationZone
        refs={[
          makeRef({ id: "id-1", action: "created", title: "Created Artifact" }),
          makeRef({ id: "id-2", action: "referenced", title: "Referenced Artifact" }),
        ]}
      />,
    );
    // There should be exactly one "created" note (not two)
    const createdNotes = screen.getAllByText("created");
    expect(createdNotes).toHaveLength(1);
  });

  it("does NOT show 'created' note for action='referenced'", () => {
    render(
      <CockpitConversationZone
        refs={[makeRef({ action: "referenced", title: "Ref Only" })]}
      />,
    );
    expect(screen.queryByText("created")).not.toBeInTheDocument();
  });

  it("click a row → onOpen called with the FULL ref object (includes versionId)", () => {
    const onOpen = vi.fn();
    const ref = makeRef({ id: "artifact-uuid-1234", versionId: "ver-abc-5678", title: "My Spec Doc" });
    render(<CockpitConversationZone refs={[ref]} onOpen={onOpen} />);
    fireEvent.click(screen.getByText("My Spec Doc"));
    expect(onOpen).toHaveBeenCalledOnce();
    // Codex #1: the full ref is passed so versionId is preserved
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ id: "artifact-uuid-1234", versionId: "ver-abc-5678" }),
    );
  });

  it("shows the count of refs in the header", () => {
    render(
      <CockpitConversationZone
        refs={[makeRef({ id: "r1", title: "A" }), makeRef({ id: "r2", title: "B" })]}
      />,
    );
    // The count is rendered as a span with the numeric value
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("In this conversation")).toBeInTheDocument();
  });

  it("does not throw when onOpen is not provided and a row is clicked", () => {
    render(<CockpitConversationZone refs={[makeRef({ title: "Clickable" })]} />);
    expect(() => fireEvent.click(screen.getByText("Clickable"))).not.toThrow();
  });
});
