import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { CrewUninstallResultDialog } from "../CrewUninstallResultDialog";
import type { TeamUninstallResult } from "../../../api/marketplace";

const result: TeamUninstallResult = {
  success: true,
  deletedAgentIds: ["a1", "a2", "a3"],
  retainedAgentIds: ["s1", "c1"],
  retainedAgents: [
    { id: "s1", name: "Steward", role: "steward", why: "Curates the marketplace library." },
    { id: "c1", name: "Commander", role: "commander", why: "Always-on internal assistant." },
  ],
};

describe("CrewUninstallResultDialog", () => {
  it("surfaces each retained protected agent by name AND reason (the #33 requirement)", () => {
    render(<CrewUninstallResultDialog result={result} open onClose={() => {}} />);

    // The deleted count is reported…
    expect(screen.getByTestId("crew-uninstall-result")).toHaveTextContent(
      "Removed 3 crew agents",
    );
    // …and every retained agent is named with its reason (not just a count).
    const rows = screen.getAllByTestId("retained-agent");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Steward");
    expect(rows[0]).toHaveTextContent("Curates the marketplace library.");
    expect(rows[1]).toHaveTextContent("Commander");
    expect(rows[1]).toHaveTextContent("Always-on internal assistant.");
    expect(screen.getByText("2 protected agents kept")).toBeInTheDocument();
  });

  it("omits the retained section when nothing was retained", () => {
    render(
      <CrewUninstallResultDialog
        result={{ success: true, deletedAgentIds: ["a1"], retainedAgentIds: [], retainedAgents: [] }}
        open
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId("crew-uninstall-result")).toHaveTextContent(
      "Removed 1 crew agent",
    );
    expect(screen.queryByTestId("retained-agent")).toBeNull();
    expect(screen.queryByText(/protected agent/i)).toBeNull();
  });

  it("calls onClose when Done is clicked", async () => {
    const onClose = vi.fn();
    render(<CrewUninstallResultDialog result={result} open onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders nothing visible when closed", () => {
    render(<CrewUninstallResultDialog result={result} open={false} onClose={() => {}} />);
    expect(screen.queryByTestId("crew-uninstall-result")).toBeNull();
  });
});
