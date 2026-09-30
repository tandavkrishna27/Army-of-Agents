import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UsedByAgentsPanel } from "../UsedByAgentsPanel";

describe("UsedByAgentsPanel", () => {
  it("renders aggregated agent usage without raw run nodes", () => {
    render(
      <UsedByAgentsPanel
        usage={[
          {
            agentId: "agent-1",
            agentName: "Memory Keeper",
            retrievalCount: 7,
            lastRetrievedAt: "2026-06-02T08:30:00.000Z",
            linkedTaskCount: 3,
          },
        ]}
        isLoading={false}
      />,
    );

    expect(screen.getByText("Used by agents")).toBeInTheDocument();
    expect(screen.getByText("Memory Keeper")).toBeInTheDocument();
    expect(screen.getByText("7 retrievals")).toBeInTheDocument();
    expect(screen.getByText("3 linked tasks")).toBeInTheDocument();
    expect(screen.queryByText(/run/i)).not.toBeInTheDocument();
  });

  it("renders an empty state when no agent has retrieved the item", () => {
    render(<UsedByAgentsPanel usage={[]} isLoading={false} />);

    expect(screen.getByText("No agent retrievals yet")).toBeInTheDocument();
  });
});
