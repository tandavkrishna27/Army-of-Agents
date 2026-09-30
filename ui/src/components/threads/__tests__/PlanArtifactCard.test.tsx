import { describe, it, expect, vi } from "vitest";
import React from "react";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../../__tests__/test-utils";

// MarkdownBody depends on the ThemeProvider context. Stub it with a simple
// pre-formatted block so we can assert on the rendered text without booting
// the theme + react-markdown stack.
vi.mock("../../MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: React.ReactNode }) => {
    // Minimal H1 + paragraph parser so the existing "h1 + Step one" assertion
    // still holds for our fixture content.
    const text = typeof children === "string" ? children : "";
    const lines = text.split("\n").filter(Boolean);
    return (
      <div data-testid="markdown-stub">
        {lines.map((l, i) =>
          l.startsWith("# ") ? <h1 key={i}>{l.slice(2)}</h1> : <p key={i}>{l}</p>,
        )}
      </div>
    );
  },
}));

import { PlanArtifactCard } from "../PlanArtifactCard";

describe("PlanArtifactCard", () => {
  it("renders the Plan eyebrow label + version pill", () => {
    renderWithProviders(
      <PlanArtifactCard
        planContent="# My plan\n\nStep one."
        currentVersion={2}
        versionCount={5}
        onApprove={vi.fn()}
        onComment={vi.fn()}
        title="Onboarding rewrite"
      />,
    );
    expect(screen.getByText("Plan")).toBeInTheDocument();
    expect(screen.getByTestId("plan-artifact-version-pill")).toHaveTextContent(
      "v2 of 5",
    );
    expect(screen.getByText("Onboarding rewrite")).toBeInTheDocument();
  });

  it("renders the markdown body", () => {
    renderWithProviders(
      <PlanArtifactCard
        planContent="# My plan\n\nStep one."
        currentVersion={1}
        versionCount={1}
        onApprove={vi.fn()}
        onComment={vi.fn()}
      />,
    );
    const body = screen.getByTestId("plan-artifact-body");
    expect(body).toBeInTheDocument();
    // MarkdownBody renders h1 for `#` and inline text "Step one."
    expect(body.querySelector("h1")?.textContent).toContain("My plan");
    expect(body.textContent).toContain("Step one");
  });

  it("fires onApprove when 'Approve plan' is clicked", async () => {
    const onApprove = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <PlanArtifactCard
        planContent="# Plan"
        currentVersion={1}
        versionCount={1}
        onApprove={onApprove}
        onComment={vi.fn()}
      />,
    );
    await user.click(screen.getByTestId("plan-artifact-approve"));
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it("fires onComment when 'Request changes' is clicked", async () => {
    const onComment = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <PlanArtifactCard
        planContent="# Plan"
        currentVersion={1}
        versionCount={1}
        onApprove={vi.fn()}
        onComment={onComment}
      />,
    );
    await user.click(screen.getByTestId("plan-artifact-comment"));
    expect(onComment).toHaveBeenCalledTimes(1);
  });
});
