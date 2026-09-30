import { describe, expect, it } from "vitest";
import {
  shouldOmitHttpRequestPayload,
  shouldSilenceHttpSuccessLog,
  safeHttpLogUrl,
} from "../middleware/http-log-policy.js";

describe("shouldOmitHttpRequestPayload", () => {
  it("omits distributed job and credential-bearing worker-control payloads from HTTP logs", () => {
    const path = "/api/organizations/org-1/companies/company-1/jobs";
    expect(shouldOmitHttpRequestPayload("POST", `${path}?trace=1`)).toBe(true);
    expect(shouldOmitHttpRequestPayload("POST", path.slice(4))).toBe(true);
    expect(shouldOmitHttpRequestPayload("POST", "/api/worker-control/enroll?raw-code=must-not-log")).toBe(true);
    expect(shouldOmitHttpRequestPayload("POST", "/api/execution-targets/heartbeat?session=must-not-log")).toBe(true);
    expect(shouldOmitHttpRequestPayload("GET", path)).toBe(false);
    expect(shouldOmitHttpRequestPayload("POST", `${path}/other`)).toBe(false);
  });
});

describe("shouldSilenceHttpSuccessLog", () => {
  it("silences cached 304 responses", () => {
    expect(shouldSilenceHttpSuccessLog("GET", "/api/issues/AOA-1", 304)).toBe(true);
  });

  it("silences successful polling endpoints", () => {
    expect(shouldSilenceHttpSuccessLog("GET", "/api/health", 200)).toBe(true);
    expect(
      shouldSilenceHttpSuccessLog(
        "GET",
        "/api/companies/5cbe79ee-acb3-4597-896e-7662742593cd/heartbeat-runs",
        200,
      ),
    ).toBe(true);
    expect(
      shouldSilenceHttpSuccessLog(
        "GET",
        "/api/heartbeat-runs/b7044268-19b6-4b3a-a9f3-9c57dce70253/log?offset=1103894&limitBytes=256000",
        200,
      ),
    ).toBe(true);
    expect(
      shouldSilenceHttpSuccessLog(
        "GET",
        "/api/companies/5cbe79ee-acb3-4597-896e-7662742593cd/live-runs?minCount=3",
        200,
      ),
    ).toBe(true);
    expect(
      shouldSilenceHttpSuccessLog(
        "HEAD",
        "/api/companies/5cbe79ee-acb3-4597-896e-7662742593cd/sidebar-badges",
        200,
      ),
    ).toBe(true);
    expect(
      shouldSilenceHttpSuccessLog(
        "GET",
        "/api/companies/5cbe79ee-acb3-4597-896e-7662742593cd/issues?includeRoutineExecutions=true",
        200,
      ),
    ).toBe(true);
    expect(
      shouldSilenceHttpSuccessLog(
        "GET",
        "/api/companies/5cbe79ee-acb3-4597-896e-7662742593cd/activity",
        200,
      ),
    ).toBe(true);
    expect(
      shouldSilenceHttpSuccessLog(
        "GET",
        "/api/companies/5cbe79ee-acb3-4597-896e-7662742593cd/dashboard",
        200,
      ),
    ).toBe(true);
  });

  it("silences successful static asset requests", () => {
    expect(shouldSilenceHttpSuccessLog("GET", "/@fs/Users/tk/aoa/ui/src/main.tsx", 200)).toBe(true);
    expect(shouldSilenceHttpSuccessLog("GET", "/src/App.tsx?t=123", 200)).toBe(true);
    expect(shouldSilenceHttpSuccessLog("GET", "/site.webmanifest", 200)).toBe(true);
    expect(shouldSilenceHttpSuccessLog("GET", "/sw.js", 200)).toBe(true);
    expect(shouldSilenceHttpSuccessLog("GET", "/favicon.ico", 200)).toBe(true);
  });

  it("keeps normal successful application requests", () => {
    expect(shouldSilenceHttpSuccessLog("GET", "/api/issues/AOA-1", 200)).toBe(false);
    expect(shouldSilenceHttpSuccessLog("PATCH", "/api/issues/AOA-1", 200)).toBe(false);
  });

  it("keeps failing requests visible (4xx/5xx on silenced paths still logged)", () => {
    expect(shouldSilenceHttpSuccessLog("GET", "/api/health", 500)).toBe(false);
    expect(shouldSilenceHttpSuccessLog("GET", "/@fs/Users/tk/aoa/ui/src/main.tsx", 404)).toBe(false);
    expect(
      shouldSilenceHttpSuccessLog(
        "GET",
        "/api/companies/5cbe79ee-acb3-4597-896e-7662742593cd/issues",
        403,
      ),
    ).toBe(false);
  });

  it("keeps POST/PATCH/DELETE on silenced paths visible (only GET/HEAD silenced)", () => {
    expect(
      shouldSilenceHttpSuccessLog(
        "POST",
        "/api/companies/5cbe79ee-acb3-4597-896e-7662742593cd/issues",
        201,
      ),
    ).toBe(false);
  });

  it("returns false when method or url is missing", () => {
    expect(shouldSilenceHttpSuccessLog(undefined, "/api/health", 200)).toBe(false);
    expect(shouldSilenceHttpSuccessLog("GET", undefined, 200)).toBe(false);
  });
});

describe("DAT-008 execution-secret resolve is treated as credential-bearing", () => {
  it("omits the payload for the resolve route, mounted with and without the /api prefix", () => {
    expect(shouldOmitHttpRequestPayload("POST", "/api/worker-control/execution-secrets/resolve"))
      .toBe(true);
    expect(shouldOmitHttpRequestPayload("POST", "/worker-control/execution-secrets/resolve"))
      .toBe(true);
  });

  it("logs only the safe route for it, dropping any query string", () => {
    expect(safeHttpLogUrl("POST", "/api/worker-control/execution-secrets/resolve?trace=1"))
      .toBe("/api/worker-control/execution-secrets/resolve");
  });

  it("does not accidentally cover a sibling worker-control route", () => {
    // The registration must be the resolve route specifically, not a prefix match that
    // would silently start omitting payloads for every worker-control operation.
    expect(shouldOmitHttpRequestPayload("POST", "/api/worker-control/execution-secrets/resolve/extra"))
      .toBe(false);
    expect(shouldOmitHttpRequestPayload("POST", "/api/worker-control/events")).toBe(false);
  });
});
