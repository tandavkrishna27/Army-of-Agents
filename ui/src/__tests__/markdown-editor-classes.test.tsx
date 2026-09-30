import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { ThemeProvider } from "../context/ThemeContext";
import { MarkdownBody } from "../components/MarkdownBody";

// react-markdown v10 sanitizes custom protocol URLs (project://) to empty string.
// Mock parseProjectMentionHref to recognise a sentinel https URL we can embed
// in the markdown without it being stripped — this lets us test the className
// branch in MarkdownBody without fighting the sanitizer.
vi.mock("@armyofagents/shared", async () => {
  const actual = await vi.importActual<typeof import("@armyofagents/shared")>(
    "@armyofagents/shared",
  );
  return {
    ...actual,
    parseProjectMentionHref: (href: string) => {
      // treat our sentinel URL as a project mention
      if (href === "https://mention.test/dev") {
        return { projectId: "dev", color: null };
      }
      return actual.parseProjectMentionHref(href);
    },
  };
});

function renderBody(markdown: string) {
  return render(
    <ThemeProvider>
      <MarkdownBody>{markdown}</MarkdownBody>
    </ThemeProvider>,
  );
}

describe("MarkdownBody — CSS class rename (paperclip- → aoa-)", () => {
  it("renders a project mention link with class aoa-project-mention-chip", () => {
    // Use an https sentinel URL that passes react-markdown's protocol sanitizer
    // but is intercepted by our mocked parseProjectMentionHref above.
    const markdown = "see [Dev](https://mention.test/dev)";
    const { container } = renderBody(markdown);

    const chip = container.querySelector(".aoa-project-mention-chip");
    expect(chip).not.toBeNull();
  });

  it("does NOT emit any element whose class starts with paperclip-", () => {
    const markdown = "see [Dev](https://mention.test/dev)";
    const { container } = renderBody(markdown);

    // querySelectorAll with attribute-contains selector to catch any paperclip- class
    const paperclipNodes = container.querySelectorAll('[class*="paperclip-"]');
    expect(paperclipNodes.length).toBe(0);
  });
});
