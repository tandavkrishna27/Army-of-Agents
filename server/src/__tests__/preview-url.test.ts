import { describe, expect, it } from "vitest";
import {
  buildRuntimeServicePreviewUrl,
  classifyRuntimeServiceTarget,
  isAllowedPreviewUpstream,
} from "../services/preview-url.js";

describe("preview URL contract", () => {
  it("builds stable AoA preview URLs for runtime services", () => {
    expect(buildRuntimeServicePreviewUrl("svc-123")).toBe("/preview/services/svc-123/");
  });

  it("classifies loopback runtime URLs as local AoA host targets", () => {
    expect(classifyRuntimeServiceTarget("http://127.0.0.1:5173")).toEqual({
      access: "local",
      localTargetUrl: "http://127.0.0.1:5173/",
    });
  });

  it("rejects arbitrary external upstream targets for first-phase proxying", () => {
    expect(isAllowedPreviewUpstream("https://example.com")).toBe(false);
    expect(isAllowedPreviewUpstream("http://169.254.169.254/latest/meta-data")).toBe(false);
    expect(isAllowedPreviewUpstream("http://0.0.0.0:5173")).toBe(false);
    expect(isAllowedPreviewUpstream("http://192.168.1.20:5173")).toBe(false);
    expect(isAllowedPreviewUpstream("http://172.16.0.3:5173")).toBe(false);
    expect(isAllowedPreviewUpstream("http://10.0.0.3:5173")).toBe(false);
    expect(isAllowedPreviewUpstream("http://localhost.evil.test:5173")).toBe(false);
    expect(isAllowedPreviewUpstream("http://user:pass@127.0.0.1:5173")).toBe(false);
    expect(isAllowedPreviewUpstream("file:///tmp/app.html")).toBe(false);
    expect(isAllowedPreviewUpstream("http://localhost:5173")).toBe(true);
    expect(isAllowedPreviewUpstream("http://[::1]:5173")).toBe(true);
  });
});
