import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const warn = vi.fn();
vi.mock("../middleware/logger.js", () => ({
  logger: { warn, error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const {
  applyConnectorEmergencyPolicy,
  createConnectorCatalogService,
  resolveConnectorCatalogService,
  CONNECTOR_CATALOG_TTL_MS,
} = await import("../services/mcp-connector-catalog.js");

const URL_ = "https://cdn.example.test/connectors.json";
const T0 = 1_000_000;
const originalConnectorsEnabled = process.env.AOA_MCP_CONNECTORS_ENABLED;
const originalConnectorDenylist = process.env.AOA_MCP_CONNECTOR_DENYLIST;

function httpEntry(id: string) {
  return {
    id,
    displayName: id,
    serverName: id,
    transport: "http",
    url: `https://${id}.example.test/mcp`,
  };
}

/** A response whose body is whatever you hand it. */
function okJson(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  warn.mockClear();
  delete process.env.AOA_MCP_CONNECTORS_ENABLED;
  delete process.env.AOA_MCP_CONNECTOR_DENYLIST;
});

afterEach(() => {
  if (originalConnectorsEnabled === undefined) {
    delete process.env.AOA_MCP_CONNECTORS_ENABLED;
  } else {
    process.env.AOA_MCP_CONNECTORS_ENABLED = originalConnectorsEnabled;
  }
  if (originalConnectorDenylist === undefined) {
    delete process.env.AOA_MCP_CONNECTOR_DENYLIST;
  } else {
    process.env.AOA_MCP_CONNECTOR_DENYLIST = originalConnectorDenylist;
  }
});

describe("connector catalog service — happy path", () => {
  it("fetches and parses the CDN body", async () => {
    const fetchFn = vi.fn(async () => okJson({ entries: [httpEntry("alpha"), httpEntry("beta")] }));
    const svc = createConnectorCatalogService({ url: URL_, fetchFn: fetchFn as unknown as typeof fetch });

    const res = await svc.load(T0);
    expect(res.stale).toBe(false);
    expect(res.entries.map((e) => e.id)).toEqual(["alpha", "beta"]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][0]).toBe(URL_);
  });

  it("serves the cache within the TTL without refetching", async () => {
    const fetchFn = vi.fn(async () => okJson({ entries: [httpEntry("alpha")] }));
    const svc = createConnectorCatalogService({ url: URL_, fetchFn: fetchFn as unknown as typeof fetch });

    await svc.load(T0);
    const second = await svc.load(T0 + CONNECTOR_CATALOG_TTL_MS - 1);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(second.stale).toBe(false);
    expect(second.entries.map((e) => e.id)).toEqual(["alpha"]);
  });

  it("refetches once the TTL has elapsed", async () => {
    let body: unknown = { entries: [httpEntry("alpha")] };
    const fetchFn = vi.fn(async () => okJson(body));
    const svc = createConnectorCatalogService({ url: URL_, fetchFn: fetchFn as unknown as typeof fetch });

    await svc.load(T0);
    body = { entries: [httpEntry("alpha"), httpEntry("gamma")] };
    const second = await svc.load(T0 + CONNECTOR_CATALOG_TTL_MS);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(second.stale).toBe(false);
    expect(second.entries.map((e) => e.id)).toEqual(["alpha", "gamma"]);
  });

  it("uses a 6-hour TTL", () => {
    expect(CONNECTOR_CATALOG_TTL_MS).toBe(6 * 60 * 60 * 1000);
  });

  it("hands back a copy, so a caller mutating the result cannot corrupt the cache", async () => {
    const fetchFn = vi.fn(async () => okJson({ entries: [httpEntry("alpha")] }));
    const svc = createConnectorCatalogService({ url: URL_, fetchFn: fetchFn as unknown as typeof fetch });

    const first = await svc.load(T0);
    first.entries.length = 0;
    const second = await svc.load(T0 + 1);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(second.entries.map((e) => e.id)).toEqual(["alpha"]);
  });
});

describe("connector catalog service — degradation", () => {
  it("serves last-known-good with stale:true when the fetch throws", async () => {
    let mode: "ok" | "throw" = "ok";
    const fetchFn = vi.fn(async () => {
      if (mode === "throw") throw new Error("ENOTFOUND");
      return okJson({ entries: [httpEntry("alpha")] });
    });
    const svc = createConnectorCatalogService({ url: URL_, fetchFn: fetchFn as unknown as typeof fetch });

    await svc.load(T0);
    mode = "throw";
    const res = await svc.load(T0 + CONNECTOR_CATALOG_TTL_MS);

    expect(res.stale).toBe(true);
    expect(res.entries.map((e) => e.id)).toEqual(["alpha"]);
    expect(warn).toHaveBeenCalled();
  });

  it("returns an empty shelf without throwing when the very first fetch fails", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("offline");
    });
    const svc = createConnectorCatalogService({ url: URL_, fetchFn: fetchFn as unknown as typeof fetch });

    const res = await svc.load(T0);
    expect(res).toEqual({ entries: [], stale: true });
  });

  it("falls back to the bundled snapshot (offline, cache never populated)", async () => {
    // P3b: an air-gapped instance whose CDN fetch fails on the very first load
    // serves the build-time bundled snapshot instead of an empty shelf.
    const fetchFn = vi.fn(async () => {
      throw new Error("offline");
    });
    const svc = createConnectorCatalogService({
      url: URL_,
      fetchFn: fetchFn as unknown as typeof fetch,
      snapshot: [httpEntry("snap-notion"), httpEntry("snap-linear")],
    });

    const res = await svc.load(T0);
    expect(res.stale).toBe(true);
    expect(res.entries.map((e) => e.id)).toEqual(["snap-notion", "snap-linear"]);
  });

  it("prefers a live cache over the snapshot once it has fetched successfully", async () => {
    let mode: "ok" | "throw" = "ok";
    const fetchFn = vi.fn(async () => {
      if (mode === "throw") throw new Error("offline");
      return okJson({ entries: [httpEntry("live")] });
    });
    const svc = createConnectorCatalogService({
      url: URL_,
      fetchFn: fetchFn as unknown as typeof fetch,
      snapshot: [httpEntry("snap-only")],
    });

    await svc.load(T0); // populates cache with "live"
    mode = "throw";
    const res = await svc.load(T0 + CONNECTOR_CATALOG_TTL_MS);
    // Live cache wins over the snapshot — the snapshot is only a never-fetched fallback.
    expect(res.entries.map((e) => e.id)).toEqual(["live"]);
  });

  it("treats a non-ok HTTP status as a failure and keeps the cache", async () => {
    let status = 200;
    const fetchFn = vi.fn(async () =>
      status === 200
        ? okJson({ entries: [httpEntry("alpha")] })
        : ({ ok: false, status, json: async () => ({ entries: [] }) } as unknown as Response),
    );
    const svc = createConnectorCatalogService({ url: URL_, fetchFn: fetchFn as unknown as typeof fetch });

    await svc.load(T0);
    status = 503;
    const res = await svc.load(T0 + CONNECTOR_CATALOG_TTL_MS);

    // A 503 body is NOT parsed — an error page must never be able to empty the shelf.
    expect(res.stale).toBe(true);
    expect(res.entries.map((e) => e.id)).toEqual(["alpha"]);
  });

  it("treats an unparseable body (invalid JSON) as a failure and keeps the cache", async () => {
    let broken = false;
    const fetchFn = vi.fn(async () =>
      broken
        ? ({
            ok: true,
            status: 200,
            json: async () => {
              throw new SyntaxError("Unexpected token <");
            },
          } as unknown as Response)
        : okJson({ entries: [httpEntry("alpha")] }),
    );
    const svc = createConnectorCatalogService({ url: URL_, fetchFn: fetchFn as unknown as typeof fetch });

    await svc.load(T0);
    broken = true;
    const res = await svc.load(T0 + CONNECTOR_CATALOG_TTL_MS);

    expect(res.stale).toBe(true);
    expect(res.entries.map((e) => e.id)).toEqual(["alpha"]);
  });

  it("does NOT mark the cache fresh after a failure — the next load retries", async () => {
    let mode: "ok" | "throw" = "ok";
    const fetchFn = vi.fn(async () => {
      if (mode === "throw") throw new Error("ENOTFOUND");
      return okJson({ entries: [httpEntry("alpha")] });
    });
    const svc = createConnectorCatalogService({ url: URL_, fetchFn: fetchFn as unknown as typeof fetch });

    await svc.load(T0);
    mode = "throw";
    await svc.load(T0 + CONNECTOR_CATALOG_TTL_MS);
    expect(fetchFn).toHaveBeenCalledTimes(2);

    mode = "ok";
    const res = await svc.load(T0 + CONNECTOR_CATALOG_TTL_MS + 1);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(res.stale).toBe(false);
  });
});

describe("connector catalog service — malformed vs legitimately empty", () => {
  it("a MALFORMED response keeps the cached shelf intact", async () => {
    let body: unknown = { entries: [httpEntry("alpha"), httpEntry("beta")] };
    const fetchFn = vi.fn(async () => okJson(body));
    const svc = createConnectorCatalogService({ url: URL_, fetchFn: fetchFn as unknown as typeof fetch });

    await svc.load(T0);
    body = "<html>404 not found</html>"; // valid JSON-able value, unintelligible envelope
    const res = await svc.load(T0 + CONNECTOR_CATALOG_TTL_MS);

    expect(res.stale).toBe(true);
    expect(res.entries.map((e) => e.id)).toEqual(["alpha", "beta"]);
    expect(warn).toHaveBeenCalled();
  });

  it.each([
    ["a bare string", "garbage"],
    ["null", null],
    ["an array at the top level", [{ id: "alpha" }]],
    ["an object with no entries key", { items: [] }],
    ["entries that is not an array", { entries: { alpha: {} } }],
    ["entries: null", { entries: null }],
  ])("keeps the cache when the CDN serves %s", async (_label, badBody) => {
    let body: unknown = { entries: [httpEntry("alpha")] };
    const fetchFn = vi.fn(async () => okJson(body));
    const svc = createConnectorCatalogService({ url: URL_, fetchFn: fetchFn as unknown as typeof fetch });

    await svc.load(T0);
    body = badBody;
    const res = await svc.load(T0 + CONNECTOR_CATALOG_TTL_MS);

    expect(res.stale).toBe(true);
    expect(res.entries.map((e) => e.id)).toEqual(["alpha"]);
  });

  it("a LEGITIMATELY EMPTY response replaces the cache", async () => {
    let body: unknown = { entries: [httpEntry("alpha")] };
    const fetchFn = vi.fn(async () => okJson(body));
    const svc = createConnectorCatalogService({ url: URL_, fetchFn: fetchFn as unknown as typeof fetch });

    await svc.load(T0);
    body = { entries: [] }; // the curator removed every connector — a real state
    const res = await svc.load(T0 + CONNECTOR_CATALOG_TTL_MS);

    expect(res.stale).toBe(false);
    expect(res.entries).toEqual([]);
  });

  it("the emptied cache then persists through the TTL rather than resurrecting", async () => {
    let body: unknown = { entries: [httpEntry("alpha")] };
    const fetchFn = vi.fn(async () => okJson(body));
    const svc = createConnectorCatalogService({ url: URL_, fetchFn: fetchFn as unknown as typeof fetch });

    await svc.load(T0);
    body = { entries: [] };
    await svc.load(T0 + CONNECTOR_CATALOG_TTL_MS);
    const res = await svc.load(T0 + CONNECTOR_CATALOG_TTL_MS + 1);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(res.entries).toEqual([]);
    expect(res.stale).toBe(false);
  });

  it("a malformed FIRST fetch returns an empty shelf as stale, not fresh", async () => {
    const fetchFn = vi.fn(async () => okJson({ nope: true }));
    const svc = createConnectorCatalogService({ url: URL_, fetchFn: fetchFn as unknown as typeof fetch });

    const res = await svc.load(T0);
    expect(res).toEqual({ entries: [], stale: true });
  });
});

describe("connector catalog service — dropped entries", () => {
  it("keeps the good entries and warns naming the dropped ids", async () => {
    const fetchFn = vi.fn(async () =>
      okJson({
        entries: [
          httpEntry("alpha"),
          { ...httpEntry("bad-one"), transport: "carrier-pigeon" }, // unknown transport
          { id: "bad-two" }, // missing required fields
          { displayName: "no id at all" },
          httpEntry("beta"),
        ],
      }),
    );
    const svc = createConnectorCatalogService({ url: URL_, fetchFn: fetchFn as unknown as typeof fetch });

    const res = await svc.load(T0);

    expect(res.stale).toBe(false);
    expect(res.entries.map((e) => e.id)).toEqual(["alpha", "beta"]);
    expect(warn).toHaveBeenCalledTimes(1);
    const [ctx] = warn.mock.calls[0] as [{ dropped?: string[] }, string];
    expect(ctx.dropped).toEqual(["bad-one", "bad-two", "<unidentified>"]);
  });

  it("does not warn when nothing was dropped", async () => {
    const fetchFn = vi.fn(async () => okJson({ entries: [httpEntry("alpha")] }));
    const svc = createConnectorCatalogService({ url: URL_, fetchFn: fetchFn as unknown as typeof fetch });

    await svc.load(T0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("an all-dropped payload KEEPS the cache and reports stale (FU-22)", async () => {
    // FU-22 reversal (previously asserted the opposite): kept-zero/dropped-many is
    // NOT a real "empty shelf" answer — every raw entry failed to parse, so the
    // last known-good cache survives and the founder is told it is stale, rather
    // than the whole shelf being blanked and pinned as fresh.
    let body: unknown = { entries: [httpEntry("alpha")] };
    const fetchFn = vi.fn(async () => okJson(body));
    const svc = createConnectorCatalogService({ url: URL_, fetchFn: fetchFn as unknown as typeof fetch });

    await svc.load(T0);
    body = { entries: [{ id: "bad-one" }] };
    const res = await svc.load(T0 + CONNECTOR_CATALOG_TTL_MS);

    expect(res.stale).toBe(true);
    expect(res.entries.map((e) => e.id)).toEqual(["alpha"]);
  });
});

describe("resolveConnectorCatalogService — the E2E fixture seam", () => {
  const fixture = path.join(os.tmpdir(), `aoa-connectors-fixture-${process.pid}.json`);
  const originalPath = process.env.AOA_E2E_CONNECTOR_CATALOG_PATH;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(async () => {
    await fs.writeFile(fixture, JSON.stringify({ entries: [httpEntry("fixture-one")] }), "utf8");
    process.env.AOA_E2E_CONNECTOR_CATALOG_PATH = fixture;
  });

  afterEach(async () => {
    if (originalPath === undefined) delete process.env.AOA_E2E_CONNECTOR_CATALOG_PATH;
    else process.env.AOA_E2E_CONNECTOR_CATALOG_PATH = originalPath;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    await fs.rm(fixture, { force: true });
  });

  it("serves the local file through the SAME parse/cache path as the CDN", async () => {
    process.env.NODE_ENV = "test";
    const res = await resolveConnectorCatalogService().load(T0);
    expect(res.entries.map((e) => e.id)).toEqual(["fixture-one"]);
    expect(res.stale).toBe(false);
  });

  it("is INERT in production — the seam can never redirect a real deployment's shelf", async () => {
    // Asserted on the branch's own log line rather than by calling `load()`,
    // which in production would reach for the real CDN over the network.
    process.env.NODE_ENV = "production";
    resolveConnectorCatalogService();
    expect(warn).not.toHaveBeenCalled();

    process.env.NODE_ENV = "test";
    resolveConnectorCatalogService();
    expect(warn).toHaveBeenCalledWith(
      { fixturePath: fixture },
      "connector catalog: serving E2E fixture instead of the CDN",
    );
  });

  it("is inert when the seam is unset — the default is always the CDN", async () => {
    delete process.env.AOA_E2E_CONNECTOR_CATALOG_PATH;
    process.env.NODE_ENV = "test";
    resolveConnectorCatalogService();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("connector catalog service - emergency policy", () => {
  it("removes denylisted connectors without poisoning the underlying cache", async () => {
    const fetchFn = vi.fn(async () =>
      okJson({ entries: [httpEntry("context7"), httpEntry("healthy")] }),
    );
    const underlying = createConnectorCatalogService({
      url: URL_,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const guarded = applyConnectorEmergencyPolicy(underlying);

    process.env.AOA_MCP_CONNECTOR_DENYLIST = "context7";
    const denied = await guarded.load(T0);
    expect(denied.entries.map((entry) => entry.id)).toEqual(["healthy"]);

    delete process.env.AOA_MCP_CONNECTOR_DENYLIST;
    const restored = await guarded.load(T0 + 1);
    expect(restored.entries.map((entry) => entry.id)).toEqual(["context7", "healthy"]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the global connector switch is explicitly disabled", async () => {
    const underlying = createConnectorCatalogService({
      url: URL_,
      fetchFn: vi.fn(async () =>
        okJson({ entries: [httpEntry("context7")] }),
      ) as unknown as typeof fetch,
    });

    process.env.AOA_MCP_CONNECTORS_ENABLED = "false";
    const result = await applyConnectorEmergencyPolicy(underlying).load(T0);

    expect(result.entries).toEqual([]);
    expect(result.stale).toBe(false);
  });
});
