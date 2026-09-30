import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { RadioGroup, RadioGroupItem } from "../radio-group";

describe("RadioGroup", () => {
  it("renders without crashing", () => {
    const { container } = render(
      <RadioGroup>
        <RadioGroupItem value="one" />
        <RadioGroupItem value="two" />
      </RadioGroup>
    );
    const root = container.querySelector("[role='radiogroup']");
    expect(root).toBeInTheDocument();
  });

  it("renders multiple items", () => {
    const { container } = render(
      <RadioGroup>
        <RadioGroupItem value="one" />
        <RadioGroupItem value="two" />
        <RadioGroupItem value="three" />
      </RadioGroup>
    );
    const items = container.querySelectorAll("[role='radio']");
    expect(items).toHaveLength(3);
  });

  it("custom className merges through on root", () => {
    const { container } = render(
      <RadioGroup className="custom-group">
        <RadioGroupItem value="one" />
      </RadioGroup>
    );
    expect(container.querySelector("[role='radiogroup']")?.className).toContain("custom-group");
  });

  it("custom className merges through on item", () => {
    const { container } = render(
      <RadioGroup>
        <RadioGroupItem value="one" className="custom-item" />
      </RadioGroup>
    );
    expect(container.querySelector("[role='radio']")?.className).toContain("custom-item");
  });

  it("default value selects the right item", () => {
    const { container } = render(
      <RadioGroup defaultValue="two">
        <RadioGroupItem value="one" />
        <RadioGroupItem value="two" />
      </RadioGroup>
    );
    const items = container.querySelectorAll("[role='radio']");
    expect(items[1].getAttribute("data-state")).toBe("checked");
    expect(items[0].getAttribute("data-state")).toBe("unchecked");
  });
});
