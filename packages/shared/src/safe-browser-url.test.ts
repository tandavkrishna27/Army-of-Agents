import { describe, it, expect } from "vitest";
import { toSafeBrowserUrl } from "./safe-browser-url.js";

const TAB = String.fromCharCode(9);
const NUL = String.fromCharCode(0);

describe("toSafeBrowserUrl", () => {
  it("passes http/https through unchanged", () => {
    expect(toSafeBrowserUrl("https://example.com/x")).toBe("https://example.com/x");
    expect(toSafeBrowserUrl("http://localhost:3000")).toBe("http://localhost:3000");
  });
  it("passes about:blank, single-slash relative, schemeless host, and host:port", () => {
    expect(toSafeBrowserUrl("about:blank")).toBe("about:blank");
    expect(toSafeBrowserUrl("/preview/services/abc/")).toBe("/preview/services/abc/");
    expect(toSafeBrowserUrl("example.com")).toBe("example.com");
    expect(toSafeBrowserUrl("localhost:3000")).toBe("localhost:3000");
    expect(toSafeBrowserUrl("127.0.0.1:5173")).toBe("127.0.0.1:5173");
  });
  it("trims surrounding whitespace and returns empty for empty input", () => {
    expect(toSafeBrowserUrl("  https://x.com/  ")).toBe("https://x.com/");
    expect(toSafeBrowserUrl("")).toBe("");
    expect(toSafeBrowserUrl("   ")).toBe("");
  });
  it("blocks dangerous schemes to about:blank (with or without //)", () => {
    for (const bad of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,x",
      "blob:https://x.com/uuid",
      "vbscript:msgbox(1)",
      "ftp://host/f",
    ]) {
      expect(toSafeBrowserUrl(bad)).toBe("about:blank");
    }
  });
  it("blocks protocol-relative and backslash network-path forms", () => {
    expect(toSafeBrowserUrl("//evil.com")).toBe("about:blank");
    expect(toSafeBrowserUrl("/" + "\\" + "evil.com")).toBe("about:blank");
    expect(toSafeBrowserUrl("\\" + "\\" + "evil.com")).toBe("about:blank");
    expect(toSafeBrowserUrl("\\" + "evil.com")).toBe("about:blank");
  });
  it("blocks embedded control characters", () => {
    expect(toSafeBrowserUrl("java" + TAB + "script:alert(1)")).toBe("about:blank");
    expect(toSafeBrowserUrl("https://x.com/" + NUL)).toBe("about:blank");
  });
  it("is case-insensitive on scheme", () => {
    expect(toSafeBrowserUrl("HTTPS://x.com")).toBe("HTTPS://x.com");
    expect(toSafeBrowserUrl("JavaScript:alert(1)")).toBe("about:blank");
  });
});
