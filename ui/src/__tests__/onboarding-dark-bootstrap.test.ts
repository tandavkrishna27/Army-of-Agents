import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("onboarding pre-React dark bootstrap", () => {
  it("keeps a static dark recovery surface when the application bundle cannot mount", () => {
    const html = fs.readFileSync(path.resolve(process.cwd(), "ui", "index.html"), "utf8");

    expect(html).toContain('dataset.aoaOnboardingBoot = "dark"');
    expect(html).toContain('id="aoa-boot-fallback"');
    expect(html).toContain("background: #0a0a0a");
    expect(html).toContain("Loading AOA onboarding");

    const boundary = fs.readFileSync(
      path.resolve(process.cwd(), "ui", "src", "components", "ErrorBoundary.tsx"),
      "utf8",
    );
    expect(boundary).toContain("componentDidMount");
    expect(boundary).toContain('removeAttribute("data-aoa-onboarding-boot")');
  });
});
