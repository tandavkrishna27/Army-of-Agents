import { describe, it, expect, beforeEach, vi } from "vitest";
import { archiveArtifact, unarchiveArtifact } from "../artifacts";

const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
function ok(body: unknown, status = 200) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response);
}

describe("artifacts client API", () => {
  it("archiveArtifact POSTs the archive route", async () => {
    fetchMock.mockReturnValue(ok({ id: "a1", status: "archived" }));
    await archiveArtifact("a1");
    expect(fetchMock).toHaveBeenCalledWith("/api/artifacts/a1/archive", expect.objectContaining({ method: "POST" }));
  });
  it("unarchiveArtifact POSTs the unarchive route", async () => {
    fetchMock.mockReturnValue(ok({ id: "a1", status: "active" }));
    await unarchiveArtifact("a1");
    expect(fetchMock).toHaveBeenCalledWith("/api/artifacts/a1/unarchive", expect.objectContaining({ method: "POST" }));
  });
});
