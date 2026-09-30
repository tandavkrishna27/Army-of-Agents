import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../client", async () => {
  const actual = await vi.importActual<typeof import("../client")>("../client");
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn() },
  };
});

import { api } from "../client";
import { desktopDevicesApi, type DesktopDevice } from "../desktop-devices";

/**
 * A REAL projection row, matching the eight fields
 * `projectDesktopDevice` (server/src/services/desktop-device-projection.ts)
 * emits — never a hand-cast partial, so a widening of the shape here would
 * force this fixture (and the assertion below) to change with it.
 */
function device(over: Partial<DesktopDevice> = {}): DesktopDevice {
  return {
    deviceId: "dev-1",
    targetSlug: "owner-desktop",
    label: "Alex's MacBook",
    status: "active",
    deviceGeneration: 2,
    enrolledAt: "2026-08-01T00:00:00.000Z",
    lastSeenAt: "2026-09-01T00:00:00.000Z",
    health: "healthy",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("desktopDevicesApi.list", () => {
  it("GETs the org-scoped desktop-devices route", async () => {
    vi.mocked(api.get).mockResolvedValueOnce([]);
    await desktopDevicesApi.list("org-1");
    expect(api.get).toHaveBeenCalledWith("/organizations/org-1/desktop-devices");
  });

  it("returns the array of projected devices, all seven fields preserved", async () => {
    const payload = [device(), device({ deviceId: "dev-2", status: "enrolled", lastSeenAt: null })];
    vi.mocked(api.get).mockResolvedValueOnce(payload);

    const res = await desktopDevicesApi.list("org-1");
    expect(res).toHaveLength(2);
    expect(res[0]).toEqual({
      deviceId: "dev-1",
      targetSlug: "owner-desktop",
      label: "Alex's MacBook",
      status: "active",
      deviceGeneration: 2,
      enrolledAt: "2026-08-01T00:00:00.000Z",
      lastSeenAt: "2026-09-01T00:00:00.000Z",
      health: "healthy",
    });
    // A never-seen device carries a null lastSeenAt through unflattened.
    expect(res[1].status).toBe("enrolled");
    expect(res[1].lastSeenAt).toBeNull();
  });

  it("passes an empty listing through unchanged (the empty-state source)", async () => {
    vi.mocked(api.get).mockResolvedValueOnce([]);
    const res = await desktopDevicesApi.list("org-1");
    expect(res).toEqual([]);
  });
});

describe("desktopDevicesApi.verify", () => {
  it("POSTs the org- and device-scoped verify route with an empty body", async () => {
    vi.mocked(api.post).mockResolvedValueOnce({
      verified: true,
      thumbprintMatches: true,
      keyValid: true,
      reason: "ok",
    });
    await desktopDevicesApi.verify("org-1", "dev-1");
    expect(api.post).toHaveBeenCalledWith(
      "/organizations/org-1/desktop-devices/dev-1/verify",
      {},
    );
  });

  it("returns the verification verdict unchanged", async () => {
    const verdict = {
      verified: false,
      thumbprintMatches: false,
      keyValid: true,
      reason: "The stored device thumbprint does not match the SHA-256 of the stored public key.",
    };
    vi.mocked(api.post).mockResolvedValueOnce(verdict);
    const res = await desktopDevicesApi.verify("org-1", "dev-1");
    expect(res).toEqual(verdict);
  });
});
