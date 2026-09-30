import { describe, expect, it } from "vitest";
import { createStorageService } from "../storage/service.js";
import { createHash } from "node:crypto";

function fakeProvider() {
  const store = new Map<string, Buffer>();
  return {
    id: "local_disk" as const,
    putObject: async ({ objectKey, body }: any) => {
      store.set(objectKey, body);
    },
    getObject: async ({ objectKey }: any) =>
      ({ stream: store.get(objectKey), contentLength: 1, lastModified: new Date() }) as any,
    headObject: async () => ({ exists: true }) as any,
    deleteObject: async () => {},
  };
}

describe("storage tenant scope", () => {
  it("new writes carry the {organizationId}/{companyId}/ prefix", async () => {
    const res = await createStorageService(fakeProvider()).putFile({
      organizationId: "org-1",
      companyId: "c1",
      namespace: "assets",
      contentType: "text/plain",
      originalFilename: "a.txt",
      body: Buffer.from("hi"),
    });
    expect(res.objectKey.startsWith("org-1/c1/")).toBe(true);
  });

  it("legacy writes (no organizationId) keep the company-only prefix", async () => {
    const res = await createStorageService(fakeProvider()).putFile({
      companyId: "c1",
      namespace: "assets",
      contentType: "text/plain",
      originalFilename: "a.txt",
      body: Buffer.from("hi"),
    });
    expect(res.objectKey.startsWith("c1/")).toBe(true);
  });

  it("getObject rejects a key from another tenant", async () => {
    await expect(
      createStorageService(fakeProvider()).getObject(
        "org-1",
        "c1",
        "org-2/c1/assets/2026/01/01/x.txt",
      ),
    ).rejects.toThrow(/tenant|organization|belong/i);
  });

  it("getObject serves a tenant-scoped key whose org matches", async () => {
    await expect(
      createStorageService(fakeProvider()).getObject(
        "org-1",
        "c1",
        "org-1/c1/assets/2026/01/01/x.txt",
      ),
    ).resolves.toBeDefined();
  });

  it("getObject stays backward-compatible with the legacy 2-arg (companyId, objectKey) form", async () => {
    await expect(
      createStorageService(fakeProvider()).getObject("c1", "c1/assets/2026/01/01/x.txt"),
    ).resolves.toBeDefined();
  });

  it("a null-org reader still serves a tenant-scoped key (company boundary satisfied)", async () => {
    await expect(
      createStorageService(fakeProvider()).getObject(
        null,
        "c1",
        "org-9/c1/assets/2026/01/01/x.txt",
      ),
    ).resolves.toBeDefined();
  });

  it("getObject rejects a key that belongs to a different company", async () => {
    await expect(
      createStorageService(fakeProvider()).getObject("c1", "c2/assets/2026/01/01/x.txt"),
    ).rejects.toThrow(/belong/i);
  });

  it("getObject rejects path traversal", async () => {
    await expect(
      createStorageService(fakeProvider()).getObject("org-1", "c1", "org-1/c1/../etc/passwd"),
    ).rejects.toThrow(/invalid/i);
  });

  it("reserved writes accept only verified Universe intake keys", async () => {
    const service = createStorageService(fakeProvider());
    const body = Buffer.from("original");
    const sha256 = createHash("sha256").update(body).digest("hex");
    await expect(service.putReservedObject({
      organizationId: "org-1", companyId: "c1",
      objectKey: "org-1/c1/universe-intakes/intake/parts/0",
      body, contentType: "application/octet-stream", sha256,
    })).resolves.toBeUndefined();
    await expect(service.putReservedObject({
      organizationId: "org-1", companyId: "c1",
      objectKey: "org-1/c1/assets/arbitrary",
      body, contentType: "application/octet-stream", sha256,
    })).rejects.toThrow(/reservation/i);
    await expect(service.putReservedObject({
      organizationId: "org-1", companyId: "c1",
      objectKey: "org-1/c1/universe-intakes/intake/parts/0",
      body, contentType: "application/octet-stream", sha256: "0".repeat(64),
    })).rejects.toThrow(/hash/i);
  });
});
