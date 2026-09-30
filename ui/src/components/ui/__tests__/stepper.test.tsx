import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { Stepper, type Step } from "../stepper";

const STEPS: Step[] = [
  { id: "1", label: "Identity", description: "Name & dept" },
  { id: "2", label: "Adapter" },
  { id: "3", label: "Capabilities" },
  { id: "4", label: "Behavior" },
];

describe("Stepper · horizontal (default)", () => {
  it("renders all step labels", () => {
    const { container } = render(<Stepper steps={STEPS} current={1} />);
    expect(container.textContent).toContain("Identity");
    expect(container.textContent).toContain("Adapter");
    expect(container.textContent).toContain("Capabilities");
    expect(container.textContent).toContain("Behavior");
  });

  it("marks done / active / pending states correctly via data-state", () => {
    const { container } = render(<Stepper steps={STEPS} current={2} />);
    const buttons = container.querySelectorAll("button");
    expect(buttons[0].getAttribute("data-state")).toBe("done");
    expect(buttons[1].getAttribute("data-state")).toBe("done");
    expect(buttons[2].getAttribute("data-state")).toBe("active");
    expect(buttons[3].getAttribute("data-state")).toBe("pending");
  });

  it("active step gets aria-current=step", () => {
    const { container } = render(<Stepper steps={STEPS} current={1} />);
    const active = container.querySelector("[aria-current='step']");
    expect(active).toBeInTheDocument();
    expect(active?.textContent).toContain("Adapter");
  });

  it("pending steps are disabled, clickable steps are enabled", () => {
    const onStepClick = vi.fn();
    const { container } = render(<Stepper steps={STEPS} current={2} onStepClick={onStepClick} />);
    const buttons = container.querySelectorAll("button");
    expect(buttons[0].hasAttribute("disabled")).toBe(false);  // done = clickable
    expect(buttons[2].hasAttribute("disabled")).toBe(false);  // active = clickable
    expect(buttons[3].hasAttribute("disabled")).toBe(true);   // pending = disabled
  });

  it("onStepClick fires for done + active steps", () => {
    const onStepClick = vi.fn();
    const { container } = render(<Stepper steps={STEPS} current={2} onStepClick={onStepClick} />);
    const buttons = container.querySelectorAll("button");
    fireEvent.click(buttons[0]);
    fireEvent.click(buttons[2]);
    expect(onStepClick).toHaveBeenCalledTimes(2);
    expect(onStepClick).toHaveBeenCalledWith(0);
    expect(onStepClick).toHaveBeenCalledWith(2);
  });

  it("onStepClick does not fire for pending steps", () => {
    const onStepClick = vi.fn();
    const { container } = render(<Stepper steps={STEPS} current={1} onStepClick={onStepClick} />);
    const buttons = container.querySelectorAll("button");
    fireEvent.click(buttons[3]);  // pending
    expect(onStepClick).not.toHaveBeenCalled();
  });
});

describe("Stepper · vertical", () => {
  it("renders steps with descriptions", () => {
    const { container } = render(<Stepper steps={STEPS} current={0} variant="vertical" />);
    expect(container.textContent).toContain("Identity");
    expect(container.textContent).toContain("Name & dept");
  });

  it("marks states correctly", () => {
    const { container } = render(<Stepper steps={STEPS} current={1} variant="vertical" />);
    const buttons = container.querySelectorAll("button");
    expect(buttons[0].getAttribute("data-state")).toBe("done");
    expect(buttons[1].getAttribute("data-state")).toBe("active");
    expect(buttons[2].getAttribute("data-state")).toBe("pending");
  });
});

describe("Stepper · dots", () => {
  it("renders one button per step", () => {
    const { container } = render(<Stepper steps={STEPS} current={0} variant="dots" />);
    const buttons = container.querySelectorAll("button");
    expect(buttons).toHaveLength(4);
  });

  it("marks states correctly", () => {
    const { container } = render(<Stepper steps={STEPS} current={2} variant="dots" />);
    const buttons = container.querySelectorAll("button");
    expect(buttons[0].getAttribute("data-state")).toBe("done");
    expect(buttons[1].getAttribute("data-state")).toBe("done");
    expect(buttons[2].getAttribute("data-state")).toBe("active");
    expect(buttons[3].getAttribute("data-state")).toBe("pending");
  });

  it("aria-label includes step number + label", () => {
    const { container } = render(<Stepper steps={STEPS} current={0} variant="dots" />);
    const buttons = container.querySelectorAll("button");
    expect(buttons[0].getAttribute("aria-label")).toBe("Step 1: Identity");
  });
});
