import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Bell } from "lucide-react";
import { SettingsCard } from "../SettingsCard";

describe("SettingsCard", () => {
  it("renders the title, description and body", () => {
    render(
      <SettingsCard icon={Bell} title="Notifications" description="How updates reach you">
        <div>body content</div>
      </SettingsCard>,
    );
    expect(screen.getByRole("heading", { name: /^Notifications$/ })).toBeInTheDocument();
    expect(screen.getByText(/how updates reach you/i)).toBeInTheDocument();
    expect(screen.getByText("body content")).toBeInTheDocument();
  });

  it("renders a header aside only when supplied", () => {
    const { rerender } = render(
      <SettingsCard icon={Bell} title="Notifications">
        <div>x</div>
      </SettingsCard>,
    );
    expect(screen.queryByTestId("aside")).toBeNull();
    rerender(
      <SettingsCard
        icon={Bell}
        title="Notifications"
        headerAside={<span data-testid="aside">pill</span>}
      >
        <div>x</div>
      </SettingsCard>,
    );
    expect(screen.getByTestId("aside")).toBeInTheDocument();
  });
});
