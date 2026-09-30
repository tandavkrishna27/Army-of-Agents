import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { AoaLogo } from "../AoaLogo";

describe("AoaLogo", () => {
  it("renders the real SVG wordmark sized from the `size` prop, with the breathing dot by default", () => {
    const { container } = render(<AoaLogo size={64} />);
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
    expect(svg?.getAttribute("role")).toBe("img");
    expect(svg?.getAttribute("aria-label")).toBe("Army of Agents");
    // authoritative viewBox from the brand SVG
    expect(svg?.getAttribute("viewBox")).toBe("0 0 1085 350");
    // width follows `size`; height follows the 1085:350 aspect ratio
    expect(svg?.getAttribute("width")).toBe("64");
    expect(svg?.getAttribute("height")).toBe(String(Math.round(64 * (350 / 1085))));
    // the breathing dot path is present by default
    expect(container.querySelector(".aoa-dot")).toBeTruthy();
  });

  it("hideDot omits the breathing dot", () => {
    const { container } = render(<AoaLogo size={40} hideDot />);
    expect(container.querySelector(".aoa-dot")).toBeNull();
    // the wordmark itself still renders
    expect(container.querySelector("svg")).toBeTruthy();
  });
});
