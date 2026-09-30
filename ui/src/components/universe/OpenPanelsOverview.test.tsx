import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OpenPanelsOverview, type OpenPanelTile } from "./OpenPanelsOverview";

const panels = (count: number): OpenPanelTile[] => Array.from({ length: count }, (_, index) => ({
  key: `panel-${index + 1}`,
  title: `Panel ${index + 1}`,
  kind: "Task",
  openedOrdinal: index + 1,
  minimized: index % 2 === 0,
}));

describe("OpenPanelsOverview pagination", () => {
  it("shows bounded pages without a horizontal-scroll strip", () => {
    render(<OpenPanelsOverview panels={panels(14)} onOpen={vi.fn()} pageSize={6} />);
    expect(screen.getAllByRole("button", { name: /Panel \d+/ })).toHaveLength(6);
    expect(screen.getByText("1–6 of 14")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next open panels" }));
    expect(screen.getByRole("button", { name: /Panel 7/ })).toBeInTheDocument();
    expect(screen.getByText("7–12 of 14")).toBeInTheDocument();
  });

  it("clamps the page when panels close", async () => {
    const { rerender } = render(<OpenPanelsOverview panels={panels(14)} onOpen={vi.fn()} pageSize={6} />);
    fireEvent.click(screen.getByRole("button", { name: "Next open panels" }));
    fireEvent.click(screen.getByRole("button", { name: "Next open panels" }));
    rerender(<OpenPanelsOverview panels={panels(2)} onOpen={vi.fn()} pageSize={6} />);
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: /Panel \d+/ })).toHaveLength(2);
      expect(screen.queryByRole("navigation", { name: "Open panels pages" })).not.toBeInTheDocument();
    });
  });
});
