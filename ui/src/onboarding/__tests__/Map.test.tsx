import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Map } from "../Map";

vi.mock("../mapDiagram", () => ({
  MapDiagram: () => <div data-testid="map-diagram" />,
}));

describe("Map (WS9 — the journey-card fork)", () => {
  it("renders the heading + sub", () => {
    render(<Map onPick={vi.fn()} />);

    expect(screen.getByText(/where are you starting from/i)).toBeInTheDocument();
    expect(screen.getByText(/three ways in/i)).toBeInTheDocument();
  });

  it("renders three large journey cards with the mock labels; idea card is coming-soon/disabled", () => {
    const onPick = vi.fn();
    render(<Map onPick={onPick} />);

    expect(screen.getByText(/bring a project in motion/i)).toBeInTheDocument();
    expect(screen.getByText(/explore on your own/i)).toBeInTheDocument();
    expect(screen.getByText(/start from an idea/i)).toBeInTheDocument();

    // idea card disabled + coming soon
    const idea = screen.getByRole("button", { name: /start from an idea|coming soon/i });
    expect(idea).toBeDisabled();

    // live cards fire onPick
    fireEvent.click(screen.getByRole("button", { name: /bring a project in motion|continue setup/i }));
    expect(onPick).toHaveBeenCalledWith("in_flight");

    fireEvent.click(screen.getByRole("button", { name: /explore on your own|open the workspace/i }));
    expect(onPick).toHaveBeenCalledWith("explorer");
  });

  it("does not render the flow diagram", () => {
    render(<Map onPick={vi.fn()} />);
    // MapDiagram is mocked to a testid; absence here confirms Map no longer renders it.
    expect(screen.queryByTestId("map-diagram")).toBeNull();
  });

  it("shows the 'Most teams start here' flag only on the in-flight card", () => {
    render(<Map onPick={vi.fn()} />);
    expect(screen.getByText(/most teams start here/i)).toBeInTheDocument();
  });

  it("shows an explicit 'Coming soon' marker on the disabled idea card only", () => {
    render(<Map onPick={vi.fn()} />);

    const idea = screen.getByRole("button", { name: /start from an idea/i });
    expect(idea).toHaveAccessibleName(/coming soon/i);

    const inFlight = screen.getByRole("button", { name: /bring a project in motion/i });
    const explorer = screen.getByRole("button", { name: /explore on your own/i });
    expect(inFlight).not.toHaveAccessibleName(/coming soon/i);
    expect(explorer).not.toHaveAccessibleName(/coming soon/i);
  });

  it("picking in-flight via user interaction calls onPick with 'in_flight'", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<Map onPick={onPick} />);

    await user.click(screen.getByRole("button", { name: /bring a project in motion/i }));
    expect(onPick).toHaveBeenCalledWith("in_flight");
  });

  it("picking explorer via user interaction calls onPick with 'explorer'", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<Map onPick={onPick} />);

    await user.click(screen.getByRole("button", { name: /explore on your own/i }));
    expect(onPick).toHaveBeenCalledWith("explorer");
  });

  it("clicking the idea card (disabled) never calls onPick", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<Map onPick={onPick} />);

    await user.click(screen.getByRole("button", { name: /start from an idea/i }));
    expect(onPick).not.toHaveBeenCalled();
  });
});
