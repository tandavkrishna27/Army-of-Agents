import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ThreadErrorBanner } from "./ThreadErrorBanner";

describe("ThreadErrorBanner", () => {
  it("renders nothing when error is null (self-clear on recovery)", () => {
    const { container } = render(<ThreadErrorBanner error={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when error is an empty string", () => {
    const { container } = render(<ThreadErrorBanner error="" />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the friendly headline and reveals the raw error only on expand", () => {
    render(<ThreadErrorBanner error={"action_commit_failed_skipped: boom"} consecutiveFailures={3} />);

    expect(screen.getByTestId("thread-error-banner")).toBeInTheDocument();
    expect(screen.getByText(/didn't go through/i)).toBeInTheDocument();
    // raw internal error is hidden until the founder asks for details
    expect(screen.queryByText(/action_commit_failed_skipped/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /details/i }));
    expect(screen.getByText(/action_commit_failed_skipped: boom/)).toBeInTheDocument();
  });
});
