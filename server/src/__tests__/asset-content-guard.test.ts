import { describe, it, expect } from "vitest";
import {
  sniffAndVerifyContentType,
  normalizeFilename,
} from "../services/asset-content-guard.js";

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const gif = Buffer.from("GIF89a", "binary");
const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP")]);
const pdf = Buffer.from("%PDF-1.7", "binary");

describe("sniffAndVerifyContentType", () => {
  it("accepts real image/pdf bytes matching the declared type", () => {
    expect(sniffAndVerifyContentType(png, "image/png")).toBe("image/png");
    expect(sniffAndVerifyContentType(jpeg, "image/jpeg")).toBe("image/jpeg");
    expect(sniffAndVerifyContentType(gif, "image/gif")).toBe("image/gif");
    expect(sniffAndVerifyContentType(webp, "image/webp")).toBe("image/webp");
    expect(sniffAndVerifyContentType(pdf, "application/pdf")).toBe("application/pdf");
  });

  it("REJECTS a shell script masquerading as image/png (magic bytes win over the header)", () => {
    const spoof = Buffer.from("#!/bin/sh", "utf8");
    expect(() => sniffAndVerifyContentType(spoof, "image/png")).toThrow(/type|mismatch|unsupported/i);
  });

  it("accepts UTF-8 text/markdown/json and rejects binary posing as text", () => {
    expect(sniffAndVerifyContentType(Buffer.from("hello", "utf8"), "text/plain")).toBe("text/plain");
    expect(sniffAndVerifyContentType(Buffer.from("#Title", "utf8"), "text/markdown")).toBe("text/markdown");
    expect(sniffAndVerifyContentType(Buffer.from('{"a":1}', "utf8"), "application/json")).toBe("application/json");
    expect(() => sniffAndVerifyContentType(Buffer.from([0x00, 0x01, 0x02, 0xff]), "text/plain")).toThrow();
  });

  it("rejects a content type outside the composer allowlist", () => {
    expect(() => sniffAndVerifyContentType(Buffer.from("<svg>"), "image/svg+xml")).toThrow(/unsupported/i);
    expect(() => sniffAndVerifyContentType(Buffer.from("x"), "application/x-sh")).toThrow(/unsupported/i);
  });

  it("rejects an empty buffer", () => {
    expect(() => sniffAndVerifyContentType(Buffer.alloc(0), "image/png")).toThrow(/empty/i);
  });
});

describe("normalizeFilename", () => {
  it("strips path separators and keeps a safe basename", () => {
    expect(normalizeFilename("../../etc/passwd")).toBe("passwd");
    expect(normalizeFilename("a\\b\\c\\report.pdf")).toBe("report.pdf");
  });

  it("strips leading dots but keeps legitimate spaces", () => {
    expect(normalizeFilename("...hidden.txt")).toBe("hidden.txt");
    expect(normalizeFilename("my report.pdf")).toBe("my report.pdf");
  });

  it("strips control characters", () => {
    expect(normalizeFilename("na\tme\x00.txt")).toBe("name.txt");
  });

  it("falls back for an empty/degenerate name and caps length", () => {
    expect(normalizeFilename("")).toBe("file");
    expect(normalizeFilename("/")).toBe("file");
    expect(normalizeFilename("a".repeat(500)).length).toBeLessThanOrEqual(200);
  });
});
