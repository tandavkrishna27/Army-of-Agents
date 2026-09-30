import { describe, it, expect } from "vitest";
import { formatBytes } from "../format";

describe("formatBytes", () => {
  it("renders bytes under 1024 in B", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1)).toBe("1 B");
    expect(formatBytes(412)).toBe("412 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("renders KB with one decimal up to 1 MB", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 1023)).toBe("1023.0 KB");
  });

  it("renders MB with one decimal up to 1 GB", () => {
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(1024 * 1024 * 5)).toBe("5.0 MB");
  });

  it("renders GB with two decimals beyond 1 GB", () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.00 GB");
    expect(formatBytes(1024 * 1024 * 1024 * 2.5)).toBe("2.50 GB");
  });
});
