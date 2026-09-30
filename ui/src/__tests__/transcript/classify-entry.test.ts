// ui/src/__tests__/transcript/classify-entry.test.ts

import { describe, expect, it } from "vitest";
import { classifyToolEntry } from "../../components/workspace/transcript/classify-entry";

describe("classifyToolEntry", () => {
  // Universal
  it("classifies Read as file_read", () => {
    expect(classifyToolEntry("Read", { path: "auth.ts" }, "general")).toBe("file_read");
  });
  it("classifies Edit as file_edit", () => {
    expect(classifyToolEntry("Edit", { file_path: "auth.ts" }, "general")).toBe("file_edit");
  });
  it("classifies Write as file_edit", () => {
    expect(classifyToolEntry("Write", { file_path: "new.ts" }, "general")).toBe("file_edit");
  });
  it("classifies Grep as search", () => {
    expect(classifyToolEntry("Grep", { pattern: "foo" }, "general")).toBe("search");
  });
  it("classifies Glob as search", () => {
    expect(classifyToolEntry("Glob", { pattern: "*.ts" }, "general")).toBe("search");
  });
  it("classifies Bash as command", () => {
    expect(classifyToolEntry("Bash", { command: "ls" }, "general")).toBe("command");
  });
  it("classifies WebFetch as web", () => {
    expect(classifyToolEntry("WebFetch", { url: "https://x.com" }, "general")).toBe("web");
  });
  it("classifies WebSearch as web", () => {
    expect(classifyToolEntry("WebSearch", { query: "test" }, "general")).toBe("web");
  });
  it("classifies TodoWrite as progress_update", () => {
    expect(classifyToolEntry("TodoWrite", { todos: [] }, "general")).toBe("progress_update");
  });
  it("classifies unknown tools as generic_tool", () => {
    expect(classifyToolEntry("some_random_tool", {}, "general")).toBe("generic_tool");
  });

  // Software dev — command content detection
  it("classifies git commands as git_operation in software_development", () => {
    expect(classifyToolEntry("Bash", { command: "git commit -m 'fix'" }, "software_development")).toBe("git_operation");
  });
  it("classifies npm test as test_run in software_development", () => {
    expect(classifyToolEntry("Bash", { command: "npm test" }, "software_development")).toBe("test_run");
  });
  it("classifies npm run build as build in software_development", () => {
    expect(classifyToolEntry("Bash", { command: "npm run build" }, "software_development")).toBe("build");
  });
  it("keeps git as generic command outside software_development", () => {
    expect(classifyToolEntry("Bash", { command: "git status" }, "marketing")).toBe("command");
  });

  // Marketing
  it("classifies generate_image as image_generated in marketing", () => {
    expect(classifyToolEntry("generate_image", {}, "marketing")).toBe("image_generated");
  });
  it("classifies generate_image as generic_tool outside marketing", () => {
    expect(classifyToolEntry("generate_image", {}, "finance")).toBe("generic_tool");
  });

  // Finance
  it("classifies generate_report as report_generated in finance", () => {
    expect(classifyToolEntry("generate_report", {}, "finance")).toBe("report_generated");
  });

  // Support
  it("classifies search_tickets as ticket_lookup in support", () => {
    expect(classifyToolEntry("search_tickets", {}, "support")).toBe("ticket_lookup");
  });
  it("classifies draft_reply as draft_response in support", () => {
    expect(classifyToolEntry("draft_reply", {}, "support")).toBe("draft_response");
  });
});
