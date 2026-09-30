import { describe, expect, it } from "vitest";

import { createFakeSandboxProvider } from "../index.js";

describe("reset + reconcile isolation (E6F-02)", () => {
  it("reconcile_cleanup leaves zero live resources; list/inspect then report zero", async () => {
    const provider = createFakeSandboxProvider();
    const driver = provider.makeDriver("p1");

    const created: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const r = await driver.invoke("create", { providerId: "p1" });
      if (r.kind !== "created") throw new Error("create failed");
      created.push(r.resource.resourceId);
    }
    expect(provider.liveResourceCount("p1")).toBe(4);

    const cleanup = await driver.invoke("reconcile_cleanup", { providerId: "p1" });
    expect(cleanup.kind).toBe("cleanup");
    if (cleanup.kind === "cleanup") expect(cleanup.cleanup.cleanupStatus).toBe("success");

    expect(provider.liveResourceCount("p1")).toBe(0);
    const list = await driver.invoke("list", { providerId: "p1" });
    if (list.kind !== "list") throw new Error("list failed");
    expect(list.list.resources).toHaveLength(0);
    for (const id of created) {
      const inspect = await driver.invoke("inspect", { providerId: "p1", resourceId: id });
      if (inspect.kind !== "inspect") throw new Error("inspect failed");
      expect(inspect.projection).toBeNull();
    }
  });

  it("reset restores zero invocations and zero live resources across all providers", async () => {
    const provider = createFakeSandboxProvider();
    await provider.makeDriver("a").invoke("create", { providerId: "a" });
    await provider.makeDriver("b").invoke("create", { providerId: "b" });
    expect(provider.invocations().length).toBeGreaterThan(0);
    expect(provider.liveResourceCount()).toBe(2);

    provider.reset();

    expect(provider.invocations()).toEqual([]);
    expect(provider.liveResourceCount()).toBe(0);
  });

  it("is NON-VACUOUS: a live resource before reconcile is genuinely observable", async () => {
    const provider = createFakeSandboxProvider();
    const driver = provider.makeDriver("p1");
    const r = await driver.invoke("create", { providerId: "p1" });
    if (r.kind !== "created") throw new Error("create failed");
    const inspect = await driver.invoke("inspect", { providerId: "p1", resourceId: r.resource.resourceId });
    if (inspect.kind !== "inspect") throw new Error("inspect failed");
    expect(inspect.projection).not.toBeNull();
    expect(inspect.projection?.resourceId).toBe(r.resource.resourceId);
  });
});
