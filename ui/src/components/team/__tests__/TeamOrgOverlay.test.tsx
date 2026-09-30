import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { TeamOrgOverlay } from "../TeamOrgOverlay";

describe("TeamOrgOverlay", () => {
  it("renders nothing when boxes is empty", () => {
    const { container } = render(<TeamOrgOverlay boxes={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders one div per box with correct positioning", () => {
    const boxes = [
      {
        teamId: "t1",
        name: "Frontend",
        color: "#6366f1",
        x: 100,
        y: 200,
        width: 300,
        height: 150,
      },
    ];
    const { container } = render(<TeamOrgOverlay boxes={boxes} />);
    const div = container.querySelector("div");
    expect(div).not.toBeNull();
    expect(div?.style.left).toBe("100px");
    expect(div?.style.top).toBe("200px");
    expect(div?.style.width).toBe("300px");
    expect(div?.style.height).toBe("150px");
  });

  it("renders team name in uppercase in the label", () => {
    const boxes = [
      {
        teamId: "t1",
        name: "Frontend",
        color: "#6366f1",
        x: 0,
        y: 0,
        width: 100,
        height: 100,
      },
    ];
    const { getByText } = render(<TeamOrgOverlay boxes={boxes} />);
    expect(getByText(/FRONTEND/i)).toBeInTheDocument();
  });
});
