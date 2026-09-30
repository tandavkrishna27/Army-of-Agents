import { describe, expect, it } from "vitest";
import {
  RECENT_FAILURE_WINDOW_MS,
  isRecentFailure,
  sanitizeHealthDiagnostic,
} from "../services/health/redaction.js";

describe("health diagnostics safety helpers", () => {
  it("redacts common secret formats before returning diagnostics", () => {
    const raw = [
      "Authorization: Bearer sk-live-secret-value",
      "api_key: abc123",
      "OPENAI_API_KEY=sk-project-secret",
      "https://user:password@example.test/path",
    ].join(" ");

    const sanitized = sanitizeHealthDiagnostic(raw);

    expect(sanitized).toContain("Bearer [redacted]");
    expect(sanitized).toContain("api_key: [redacted]");
    expect(sanitized).toContain("OPENAI_API_KEY=[redacted]");
    expect(sanitized).toContain("https://[redacted]@example.test/path");
    expect(sanitized).not.toMatch(/sk-live-secret-value|abc123|sk-project-secret|user:password/);
  });

  it("treats only failures inside the recent window as recent", () => {
    const now = new Date("2026-05-25T12:00:00.000Z");
    const fresh = new Date(now.getTime() - RECENT_FAILURE_WINDOW_MS + 1);
    const old = new Date(now.getTime() - RECENT_FAILURE_WINDOW_MS - 1);

    expect(isRecentFailure(fresh, now)).toBe(true);
    expect(isRecentFailure(old, now)).toBe(false);
  });
});
