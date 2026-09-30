import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../client", () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

import { api } from "../client";
import {
  braindumpApi,
  braindumpIdempotencyKey,
  clearBraindumpSessionId,
  getBraindumpSessionId,
} from "../braindump";

describe("braindumpApi", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  it("submit POSTs to the company braindumps endpoint", async () => {
    vi.mocked(api.post).mockResolvedValueOnce({ id: "bd-1" });
    await braindumpApi.submit("c1", {
      departmentId: "d1",
      content: "notes",
      idempotencyKey: "d1:sess-1",
    });
    expect(api.post).toHaveBeenCalledWith("/companies/c1/braindumps", {
      departmentId: "d1",
      content: "notes",
      idempotencyKey: "d1:sess-1",
    });
  });

  it("listByDepartment GETs with the departmentId query param", async () => {
    vi.mocked(api.get).mockResolvedValueOnce([]);
    await braindumpApi.listByDepartment("c1", "d1");
    expect(api.get).toHaveBeenCalledWith("/companies/c1/braindumps?departmentId=d1");
  });

  it("get GETs a single capture by id", async () => {
    vi.mocked(api.get).mockResolvedValueOnce({ id: "bd-1" });
    await braindumpApi.get("c1", "bd-1");
    expect(api.get).toHaveBeenCalledWith("/companies/c1/braindumps/bd-1");
  });

  it("retry POSTs to the retry endpoint", async () => {
    vi.mocked(api.post).mockResolvedValueOnce({ id: "bd-1" });
    await braindumpApi.retry("c1", "bd-1");
    expect(api.post).toHaveBeenCalledWith("/companies/c1/braindumps/bd-1/retry", {});
  });
});

describe("getBraindumpSessionId / braindumpIdempotencyKey", () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  it("returns a stable id across repeated calls for the same company", () => {
    const first = getBraindumpSessionId("c1");
    const second = getBraindumpSessionId("c1");
    expect(first).toBe(second);
  });

  it("returns different ids for different companies", () => {
    const a = getBraindumpSessionId("c1");
    const b = getBraindumpSessionId("c2");
    expect(a).not.toBe(b);
  });

  it("persists the run id in localStorage so onboarding survives a browser restart", () => {
    // localStorage, not sessionStorage: the in-flight step marker is durable,
    // so a tab-scoped id would resume into the Librarian step with a fresh id
    // and filter out the captures the founder just submitted.
    const first = getBraindumpSessionId("c1");
    const second = getBraindumpSessionId("c1");
    expect(localStorage.getItem("aoa:braindump-session:c1")).toBe(first);
    expect(second).toBe(first);
  });

  it("clearBraindumpSessionId ends the run so the next braindump gets a new id", () => {
    const first = getBraindumpSessionId("c1");
    clearBraindumpSessionId("c1");
    expect(localStorage.getItem("aoa:braindump-session:c1")).toBeNull();
    expect(getBraindumpSessionId("c1")).not.toBe(first);
  });

  it("derives a stable idempotency key from departmentId + session id", () => {
    const key1 = braindumpIdempotencyKey("c1", "d1");
    const key2 = braindumpIdempotencyKey("c1", "d1");
    expect(key1).toBe(key2);
    expect(key1).toContain("d1:");
  });

  it("derives different idempotency keys for different departments in the same session", () => {
    const keyD1 = braindumpIdempotencyKey("c1", "d1");
    const keyD2 = braindumpIdempotencyKey("c1", "d2");
    expect(keyD1).not.toBe(keyD2);
  });
});
