import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CapabilityConsentStep } from "../CapabilityConsentStep";

const CAPS = ["issues.read", "http.outbound"] as const;

describe("CapabilityConsentStep", () => {
  it("renders human-readable descriptions for each capability", () => {
    render(
      <CapabilityConsentStep
        pluginName="My Plugin"
        capabilities={[...CAPS]}
        agreed={false}
        onAgreedChange={vi.fn()}
      />,
    );
    // "issues.read" → "Read tasks and issues"
    expect(screen.getByText(/Read tasks and issues/i)).toBeInTheDocument();
    // "http.outbound" → "Make outbound HTTP requests"
    expect(screen.getByText(/Make outbound HTTP requests/i)).toBeInTheDocument();
  });

  it("renders the consent checkbox unchecked when agreed=false", () => {
    render(
      <CapabilityConsentStep
        pluginName="My Plugin"
        capabilities={[...CAPS]}
        agreed={false}
        onAgreedChange={vi.fn()}
      />,
    );
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).not.toBeChecked();
  });

  it("renders the consent checkbox checked when agreed=true", () => {
    render(
      <CapabilityConsentStep
        pluginName="My Plugin"
        capabilities={[...CAPS]}
        agreed={true}
        onAgreedChange={vi.fn()}
      />,
    );
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).toBeChecked();
  });

  it("calls onAgreedChange(true) when checkbox is clicked while unchecked", async () => {
    const onAgreedChange = vi.fn();
    render(
      <CapabilityConsentStep
        pluginName="My Plugin"
        capabilities={[...CAPS]}
        agreed={false}
        onAgreedChange={onAgreedChange}
      />,
    );
    await userEvent.click(screen.getByRole("checkbox"));
    expect(onAgreedChange).toHaveBeenCalledWith(true);
  });

  it("renders 'No special permissions' message when capabilities is empty", () => {
    render(
      <CapabilityConsentStep
        pluginName="My Plugin"
        capabilities={[]}
        agreed={false}
        onAgreedChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/No special permissions/i)).toBeInTheDocument();
  });
});
