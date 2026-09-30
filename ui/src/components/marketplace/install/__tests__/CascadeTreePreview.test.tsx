import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { CascadeTreePreview } from "../CascadeTreePreview";

const FAKE_PLAN = {
  rootItem: { id: "team:test/eng", name: "Eng Team", type: "team", version: "1.0.0" },
  steps: [
    { catalogItemId: "skill:test/code-review", itemType: "skill" as const, name: "Code Review", version: "1.0.0", action: "install-new" as const },
    { catalogItemId: "agent:test/engineer", itemType: "agent" as const, name: "Engineer", version: "1.0.0", action: "skip-already-installed" as const, reason: "Already installed at 1.0.0" },
    { catalogItemId: "plugin:test/github-issues", itemType: "plugin" as const, name: "GitHub Issues", version: "1.0.0", action: "fail-version-mismatch" as const, reason: "Installed 0.9.0; catalog 1.0.0" },
    { catalogItemId: "team:test/eng", itemType: "team" as const, name: "Eng Team", version: "1.0.0", action: "install-new" as const },
  ],
  conflicts: [],
};

describe("CascadeTreePreview", () => {
  it("renders one row per step with correct action labels", () => {
    render(<MemoryRouter><CascadeTreePreview plan={FAKE_PLAN} /></MemoryRouter>);
    expect(screen.getByText("Code Review")).toBeInTheDocument();
    expect(screen.getByText("Engineer")).toBeInTheDocument();
    expect(screen.getByText("GitHub Issues")).toBeInTheDocument();
    expect(screen.getByText("Eng Team")).toBeInTheDocument();

    expect(screen.getAllByText("Will install").length).toBe(2);  // skill + team root
    expect(screen.getByText("Already installed")).toBeInTheDocument();
    expect(screen.getByText("Version mismatch")).toBeInTheDocument();
  });

  it("renders detail page links with slashes preserved", () => {
    render(<MemoryRouter><CascadeTreePreview plan={FAKE_PLAN} /></MemoryRouter>);
    const links = screen.getAllByRole("link");
    expect(links[0]).toHaveAttribute("href", "/marketplace/skill/test/code-review");
    expect(links[1]).toHaveAttribute("href", "/marketplace/agent/test/engineer");
  });
});
