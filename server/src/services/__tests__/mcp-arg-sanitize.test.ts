import { describe, expect, it } from "vitest";
import { stripUserMcpArgs } from "../mcp-arg-sanitize.js";

describe("stripUserMcpArgs", () => {
  it("removes a user-supplied --mcp-config and its value", () => {
    expect(stripUserMcpArgs(["--mcp-config", "/tmp/evil.json", "--foo"])).toEqual(["--foo"]);
  });

  it("removes --strict-mcp-config supplied by the user", () => {
    expect(stripUserMcpArgs(["--strict-mcp-config", "--foo"])).toEqual(["--foo"]);
  });

  it("removes --mcp-config=inline form (single token)", () => {
    expect(stripUserMcpArgs(["--mcp-config=/tmp/evil.json", "--foo"])).toEqual(["--foo"]);
  });

  it("leaves unrelated args untouched", () => {
    expect(stripUserMcpArgs(["--model", "opus"])).toEqual(["--model", "opus"]);
  });

  it("strips multiple occurrences", () => {
    expect(stripUserMcpArgs(["--mcp-config", "a.json", "--x", "--mcp-config", "b.json"])).toEqual(["--x"]);
  });

  it("returns a new array and does not mutate the input", () => {
    const input = ["--mcp-config", "a.json", "--keep"];
    const out = stripUserMcpArgs(input);
    expect(input).toEqual(["--mcp-config", "a.json", "--keep"]);
    expect(out).toEqual(["--keep"]);
  });
});
