// DEP-011 reaper Slice B (B2) — the AM outbound lease-truth client.
//
// The REAL oracle the reaper trusts to reclaim, so the mapping is STRUCTURAL
// positive-confirmed-death: start "unknown", promote to "live"/"orphan" ONLY on exact
// recognized strings; every out-of-contract response, missing key, non-2xx, throw, or
// timeout stays "unknown" (fail-safe). The client NEVER rejects. Loads the frozen fixture
// (dual-asserted with B1).
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { ResourceLabels, ResourceSummary } from "@armyofagents/worker-daemon";
import {
  makeControlPlaneResolveTruth,
  mapControlPlaneVerdict,
  LEASE_TRUTH_PATH,
  TRUTH_SHARED_SECRET_HEADER,
} from "../reaper-truth-client.js";

const BASE = "http://control-plane:8080";
const ENDPOINT = `${BASE}${LEASE_TRUTH_PATH}`;

const LABELS: ResourceLabels = {
  organizationId: "org-A",
  targetId: "target-1",
  workerId: "worker-1",
  jobId: "job-1",
  attempt: 1,
  leaseId: "lease-1",
  deviceGeneration: 1,
};

function summary(sandboxId: string, over: Partial<ResourceLabels> = {}): ResourceSummary {
  return {
    sandboxId,
    resourceLabels: { ...LABELS, ...over },
    generation: 1,
    state: "running",
    hasLiveLease: false,
  };
}

/** A fake `fetch` that records requests and returns a scripted body/status. */
function fakeFetch(handler: (url: string, init: RequestInit) => { ok: boolean; body: unknown }) {
  const calls: Array<{ url: string; init: RequestInit; parsedBody: unknown }> = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const i = init ?? {};
    calls.push({ url: u, init: i, parsedBody: JSON.parse(String(i.body)) });
    const { ok, body } = handler(u, i);
    return {
      ok,
      status: ok ? 200 : 500,
      json: async () => body,
    } as Response;
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

function verdictsBody(verdicts: Record<string, string>): { ok: boolean; body: unknown } {
  return { ok: true, body: { verdicts } };
}

describe("mapControlPlaneVerdict — structural positive-confirmed-death", () => {
  it("promotes ONLY on exact recognized strings", () => {
    expect(mapControlPlaneVerdict("live")).toBe("live");
    expect(mapControlPlaneVerdict("terminal")).toBe("orphan");
    expect(mapControlPlaneVerdict("superseded")).toBe("orphan");
  });
  it("everything else → unknown (never a negative default)", () => {
    for (const v of ["absent", "stale", "LIVE", "Terminal", "", "orphan", 1, null, undefined, {}]) {
      expect(mapControlPlaneVerdict(v)).toBe("unknown");
    }
  });
});

describe("makeControlPlaneResolveTruth", () => {
  it("maps terminal/superseded → orphan and live → live", async () => {
    const { fn, calls } = fakeFetch(() =>
      verdictsBody({ "lease-t": "terminal", "lease-l": "live", "lease-s": "superseded" }),
    );
    const resolve = makeControlPlaneResolveTruth(BASE, fn);
    const out = await resolve([
      summary("sb-t", { leaseId: "lease-t" }),
      summary("sb-l", { leaseId: "lease-l" }),
      summary("sb-s", { leaseId: "lease-s" }),
    ]);
    expect(out.get("sb-t")).toBe("orphan");
    expect(out.get("sb-l")).toBe("live");
    expect(out.get("sb-s")).toBe("orphan");
    // POSTs to base + the known path with the frozen request shape.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(ENDPOINT);
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]!.parsedBody).toEqual({
      orgs: [
        {
          organizationId: "org-A",
          leases: [{ leaseId: "lease-t" }, { leaseId: "lease-l" }, { leaseId: "lease-s" }],
        },
      ],
    });
  });

  it("DEP-012 P3: sends the shared-secret bearer header when configured", async () => {
    const { fn, calls } = fakeFetch(() => verdictsBody({ "lease-1": "live" }));
    const resolve = makeControlPlaneResolveTruth(BASE, fn, undefined, "staging-bearer-value");
    await resolve([summary("sb", { leaseId: "lease-1" })]);
    expect((calls[0]!.init.headers as Record<string, string>)[TRUTH_SHARED_SECRET_HEADER]).toBe(
      "staging-bearer-value",
    );
  });

  it("DEP-012 P3: omits the bearer header when no secret is configured (inert)", async () => {
    const { fn, calls } = fakeFetch(() => verdictsBody({ "lease-1": "live" }));
    await makeControlPlaneResolveTruth(BASE, fn)([summary("sb", { leaseId: "lease-1" })]);
    expect(TRUTH_SHARED_SECRET_HEADER in (calls[0]!.init.headers as Record<string, string>)).toBe(false);
  });

  it("an UNRECOGNIZED enum → unknown (no mass-kill on drift)", async () => {
    const { fn } = fakeFetch(() => verdictsBody({ "lease-1": "stale" }));
    const out = await makeControlPlaneResolveTruth(BASE, fn)([summary("sb")]);
    expect(out.get("sb")).toBe("unknown");
  });

  it("a NON-2xx response with a JSON body → unknown (res.ok checked first)", async () => {
    const { fn } = fakeFetch(() => ({ ok: false, body: { verdicts: { "lease-1": "terminal" }, error: "boom" } }));
    const out = await makeControlPlaneResolveTruth(BASE, fn)([summary("sb")]);
    expect(out.get("sb")).toBe("unknown");
  });

  it("a missing `verdicts` key → unknown", async () => {
    const { fn } = fakeFetch(() => ({ ok: true, body: { results: {} } }));
    const out = await makeControlPlaneResolveTruth(BASE, fn)([summary("sb")]);
    expect(out.get("sb")).toBe("unknown");
  });

  it("a `verdicts` that is an array (wrong shape) → unknown", async () => {
    const { fn } = fakeFetch(() => ({ ok: true, body: { verdicts: ["terminal"] } }));
    const out = await makeControlPlaneResolveTruth(BASE, fn)([summary("sb")]);
    expect(out.get("sb")).toBe("unknown");
  });

  it("a timeout / thrown fetch → unknown, and the client NEVER rejects", async () => {
    const fn = (async () => {
      throw new DOMException("timed out", "TimeoutError");
    }) as unknown as typeof fetch;
    const out = await makeControlPlaneResolveTruth(BASE, fn)([summary("sb")]);
    expect(out.get("sb")).toBe("unknown");
  });

  it("a leaseId the CP omits from verdicts → unknown", async () => {
    const { fn } = fakeFetch(() => verdictsBody({ "other-lease": "terminal" }));
    const out = await makeControlPlaneResolveTruth(BASE, fn)([summary("sb", { leaseId: "lease-1" })]);
    expect(out.get("sb")).toBe("unknown");
  });

  it("two sandboxes SHARING one leaseId both get that lease's verdict (fail-safe keying)", async () => {
    const { fn, calls } = fakeFetch(() => verdictsBody({ "shared-lease": "superseded" }));
    const out = await makeControlPlaneResolveTruth(BASE, fn)([
      summary("sb-a", { leaseId: "shared-lease" }),
      summary("sb-b", { leaseId: "shared-lease" }),
    ]);
    expect(out.get("sb-a")).toBe("orphan");
    expect(out.get("sb-b")).toBe("orphan");
    // The shared leaseId is de-duplicated in the request.
    expect(calls[0]!.parsedBody).toEqual({
      orgs: [{ organizationId: "org-A", leases: [{ leaseId: "shared-lease" }] }],
    });
  });

  it("groups by organizationId — a 2-org batch → one request per org, each applied to its own sandboxes", async () => {
    const { fn, calls } = fakeFetch((_url, init) => {
      const body = JSON.parse(String(init.body)) as { orgs: { organizationId: string }[] };
      const org = body.orgs[0]!.organizationId;
      // Org A's lease is terminal; org B's lease is live.
      return org === "org-A"
        ? verdictsBody({ "lease-A": "terminal" })
        : verdictsBody({ "lease-B": "live" });
    });
    const out = await makeControlPlaneResolveTruth(BASE, fn)([
      summary("sb-A", { organizationId: "org-A", leaseId: "lease-A" }),
      summary("sb-B", { organizationId: "org-B", leaseId: "lease-B" }),
    ]);
    expect(out.get("sb-A")).toBe("orphan");
    expect(out.get("sb-B")).toBe("live");
    expect(calls).toHaveLength(2);
    const orgs = calls.map((c) => (c.parsedBody as { orgs: { organizationId: string }[] }).orgs[0]!.organizationId).sort();
    expect(orgs).toEqual(["org-A", "org-B"]);
  });

  it("one org failing leaves the OTHER org's verdicts intact (per-org isolation)", async () => {
    const { fn } = fakeFetch((_url, init) => {
      const body = JSON.parse(String(init.body)) as { orgs: { organizationId: string }[] };
      return body.orgs[0]!.organizationId === "org-A"
        ? { ok: false, body: {} } // org A fails
        : verdictsBody({ "lease-B": "terminal" });
    });
    const out = await makeControlPlaneResolveTruth(BASE, fn)([
      summary("sb-A", { organizationId: "org-A", leaseId: "lease-A" }),
      summary("sb-B", { organizationId: "org-B", leaseId: "lease-B" }),
    ]);
    expect(out.get("sb-A")).toBe("unknown");
    expect(out.get("sb-B")).toBe("orphan");
  });

  it("empty summaries → empty map, no fetch", async () => {
    const { fn, calls } = fakeFetch(() => verdictsBody({}));
    const out = await makeControlPlaneResolveTruth(BASE, fn)([]);
    expect(out.size).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe("frozen fixture round-trip (dual-asserted with B1)", () => {
  function fixture(name: string): unknown {
    const here = fileURLToPath(new URL(".", import.meta.url));
    return JSON.parse(
      readFileSync(join(here, "..", "..", "..", "..", "tests", "fixtures", "reaper-lease-truth", "v1", name), "utf8"),
    );
  }

  it("summaries.json + response.json → expected-client-verdicts.json (incl. the multi-sandbox-per-lease case)", async () => {
    const summaries = fixture("summaries.json") as ResourceSummary[];
    const response = fixture("response.json") as { verdicts: Record<string, string> };
    const expected = fixture("expected-client-verdicts.json") as Record<string, string>;
    const request = fixture("request.json") as { orgs: { organizationId: string; leases: { leaseId: string }[] }[] };

    const { fn, calls } = fakeFetch(() => ({ ok: true, body: response }));
    const out = await makeControlPlaneResolveTruth(BASE, fn)(summaries);

    expect(Object.fromEntries(out)).toEqual(expected);
    // The client's derived request matches the frozen request fixture exactly (single-org,
    // leaseIds de-duplicated in first-seen order).
    expect(calls).toHaveLength(1);
    expect(calls[0]!.parsedBody).toEqual(request);
  });
});
