import { beforeEach, describe, expect, it, vi } from "vitest";
import { universeAttentionApi } from "../universe-attention";

describe("universeAttentionApi", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("reads and validates the observation-only projection", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      asOf: "2026-09-20T10:00:00.000Z",
      needsYou: [], ready: [], comingUp: [], nextCursor: "next",
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await universeAttentionApi.get("company-1", "cursor value");
    expect(result.nextCursor).toBe("next");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/companies/company-1/universe/attention?cursor=cursor%20value",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("rejects malformed projection data", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      asOf: "not-a-date", needsYou: [], ready: [], comingUp: [], nextCursor: null,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    await expect(universeAttentionApi.get("company-1")).rejects.toThrow();
  });

  it("advances an explicit server-issued attention checkpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      revision: 4, lastAcknowledgedAt: "2026-09-20T10:00:00.000Z",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    await expect(universeAttentionApi.finish("company-1", 3, "signed-token")).resolves.toMatchObject({ revision: 4 });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/companies/company-1/universe/attention/checkpoint",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ baseRevision: 3, through: "signed-token" }) }),
    );
  });
});
