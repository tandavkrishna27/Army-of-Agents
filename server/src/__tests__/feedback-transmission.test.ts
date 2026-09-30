import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Silence pino during tests. feedback-transmission imports the middleware
// logger at module-load; stubbing it keeps the test output quiet without
// interfering with the transmission logic we're actually exercising.
vi.mock("../middleware/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  httpLogger: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import {
  isTransmissionEnabled,
  transmitFeedbackBundle,
  transmitPluginTelemetry,
  ENDPOINT_ENV,
  API_KEY_ENV,
} from "../services/feedback-transmission.js";

describe("feedback-transmission", () => {
  beforeEach(() => {
    delete process.env[ENDPOINT_ENV];
    delete process.env[API_KEY_ENV];
  });

  afterEach(() => {
    delete process.env[ENDPOINT_ENV];
    delete process.env[API_KEY_ENV];
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // ---------------------------------------------------------------------------
  // isTransmissionEnabled
  // ---------------------------------------------------------------------------

  it("isTransmissionEnabled reflects AOA_FEEDBACK_ENDPOINT presence", () => {
    expect(isTransmissionEnabled()).toBe(false);
    process.env[ENDPOINT_ENV] = "https://example.com";
    expect(isTransmissionEnabled()).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // transmitFeedbackBundle
  // ---------------------------------------------------------------------------

  it("returns { ok: false, error: 'not_configured' } when endpoint is absent", async () => {
    const result = await transmitFeedbackBundle({});
    expect(result.ok).toBe(false);
    expect(result.error).toBe("not_configured");
  });

  it("POSTs bundle JSON with Content-Type header when endpoint is set", async () => {
    process.env[ENDPOINT_ENV] = "https://example.com/feedback";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const bundle = { id: "b1", payload: { hello: "world" } };
    const result = await transmitFeedbackBundle(bundle);

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://example.com/feedback");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.body).toBe(JSON.stringify(bundle));
  });

  it("omits Authorization when AOA_FEEDBACK_API_KEY is unset", async () => {
    process.env[ENDPOINT_ENV] = "https://example.com";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    await transmitFeedbackBundle({});
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("includes Bearer Authorization when AOA_FEEDBACK_API_KEY is set", async () => {
    process.env[ENDPOINT_ENV] = "https://example.com";
    process.env[API_KEY_ENV] = "secret123";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    await transmitFeedbackBundle({});
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer secret123");
  });

  it("returns { ok: false, status } on non-2xx response", async () => {
    process.env[ENDPOINT_ENV] = "https://example.com";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    const result = await transmitFeedbackBundle({});
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    expect(result.error).toBeUndefined();
  });

  it("returns { ok: false, error } when fetch rejects (network failure)", async () => {
    process.env[ENDPOINT_ENV] = "https://example.com";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const result = await transmitFeedbackBundle({});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ECONNREFUSED");
    expect(result.status).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // transmitPluginTelemetry
  // ---------------------------------------------------------------------------

  it("transmitPluginTelemetry is a no-op when endpoint is unset", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await transmitPluginTelemetry("my_event", { a: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("transmitPluginTelemetry fires POST with a plugin_telemetry envelope when endpoint is set", async () => {
    process.env[ENDPOINT_ENV] = "https://example.com/telemetry";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    await transmitPluginTelemetry("sync_completed", { attempts: 2 });
    // Fire-and-forget launches inside a `void`; let microtasks drain.
    await new Promise((resolve) => setImmediate(resolve));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://example.com/telemetry");
    const parsed = JSON.parse(init.body);
    expect(parsed.kind).toBe("plugin_telemetry");
    expect(parsed.event).toBe("sync_completed");
    expect(parsed.dims).toEqual({ attempts: 2 });
    expect(typeof parsed.timestamp).toBe("string");
    expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("transmitPluginTelemetry substitutes empty dims when dimensions are omitted", async () => {
    process.env[ENDPOINT_ENV] = "https://example.com";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    await transmitPluginTelemetry("bare_event", undefined);
    await new Promise((resolve) => setImmediate(resolve));

    const [, init] = fetchMock.mock.calls[0];
    const parsed = JSON.parse(init.body);
    expect(parsed.dims).toEqual({});
  });

  it("transmitPluginTelemetry swallows fetch failures (never throws to caller)", async () => {
    process.env[ENDPOINT_ENV] = "https://example.com";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    // Must not throw. Plugins should not see transport errors.
    await expect(transmitPluginTelemetry("event", {})).resolves.toBeUndefined();
  });
});
