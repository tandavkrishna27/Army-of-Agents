import { createServer } from "node:net";
import { expect, it, vi } from "vitest";
import { createBlockedTaskFixture } from "./helpers/blocked-task-fixture.js";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";

function harness() {
  const events: string[] = [];
  const step = (name: string) => vi.fn(async () => { events.push(name); });
  const db = { fixture: true };
  const pg = { initialise: step("initialise"), start: step("start"), stop: step("stop") };
  const d = {
    createDirectory: vi.fn(async () => { events.push("directory"); return "/fixture-owned"; }),
    allocatePort: vi.fn(async () => { events.push("port"); return 58300; }),
    createPostgres: vi.fn(async (_directory: string, _port: number) => pg),
    migrate: vi.fn(async (_url: string) => { events.push("migrate"); }),
    connect: vi.fn((_url: string) => { events.push("connect"); return db; }),
    seed: vi.fn(async (_db: typeof db) => { events.push("seed"); }),
    closeDb: vi.fn(async (_db: typeof db) => { events.push("close"); }),
    removeDirectory: vi.fn(async (_dir: string) => { events.push("remove"); }),
  };
  return { events, db, pg, d, f: createBlockedTaskFixture(d) };
}

it("starts once and disposes once in ownership order", async () => {
  const h = harness();
  expect(await h.f.start()).toBe(h.db);
  expect(await h.f.start()).toBe(h.db);
  await Promise.all([h.f.dispose(), h.f.dispose()]);
  expect(h.events).toEqual(["directory", "port", "initialise", "start", "migrate", "connect", "seed", "close", "stop", "remove"]);
  expect(h.d.createPostgres).toHaveBeenCalledWith("/fixture-owned", 58300);
  expect(h.d.migrate).toHaveBeenCalledWith("postgres://test:test@127.0.0.1:58300/postgres");
  expect(h.d.connect).toHaveBeenCalledWith("postgres://test:test@127.0.0.1:58300/postgres");
});

it.each([undefined, new Error("bind failed")])("fails closed on rejected start: %s", async cause => {
  const h = harness(); h.pg.start.mockRejectedValueOnce(cause);
  await expect(h.f.start()).rejects.toMatchObject({ message: "Blocked-task fixture failed during start", cause });
  await h.f.dispose();
  expect(h.d.migrate).not.toHaveBeenCalled();
  expect(h.d.connect).not.toHaveBeenCalled();
  expect(h.d.seed).not.toHaveBeenCalled();
  expect(h.pg.stop).not.toHaveBeenCalled();
  expect(h.d.removeDirectory).toHaveBeenCalledOnce();
});

it("does not stop after init failure", async () => {
  const h = harness(); h.pg.initialise.mockRejectedValueOnce(new Error("init failed"));
  await expect(h.f.start()).rejects.toThrow("during initialise");
  await h.f.dispose(); expect(h.pg.stop).not.toHaveBeenCalled();
});
it("stops a started cluster after migration failure without an unacquired client", async () => {
  const h = harness(); h.d.migrate.mockRejectedValueOnce(new Error("migration failed"));
  await expect(h.f.start()).rejects.toThrow("during migrate");
  await h.f.dispose();
  expect(h.d.closeDb).not.toHaveBeenCalled(); expect(h.pg.stop).toHaveBeenCalledOnce();
});
it("closes client before stopping after seed failure", async () => {
  const h = harness(); h.d.seed.mockRejectedValueOnce(new Error("seed failed"));
  await expect(h.f.start()).rejects.toThrow("during seed");
  await h.f.dispose(); expect(h.events.slice(-3)).toEqual(["close", "stop", "remove"]);
});
it("still stops after client-close failure and retains cleanup error and directory", async () => {
  const h = harness(); await h.f.start(); const cause = new Error("close failed");
  h.d.closeDb.mockRejectedValueOnce(cause);
  await expect(h.f.dispose()).rejects.toMatchObject({ errors: [cause] });
  expect(h.pg.stop).toHaveBeenCalledOnce(); expect(h.d.removeDirectory).not.toHaveBeenCalled();
});
it("retains directory and error on stop failure", async () => {
  const h = harness(); await h.f.start(); const cause = new Error("stop failed");
  h.pg.stop.mockRejectedValueOnce(cause);
  await expect(h.f.dispose()).rejects.toMatchObject({ errors: [cause] });
  expect(h.d.removeDirectory).not.toHaveBeenCalled();
});
it("does not swallow directory removal failure", async () => {
  const h = harness(); await h.f.start(); const cause = new Error("remove failed");
  h.d.removeDirectory.mockRejectedValueOnce(cause);
  await expect(h.f.dispose()).rejects.toMatchObject({ errors: [cause] });
});
it("cannot start after disposal", async () => {
  const h = harness(); await h.f.dispose();
  await expect(h.f.start()).rejects.toThrow("disposed");
  expect(h.d.createDirectory).not.toHaveBeenCalled();
});
it("serializes disposal with pending start and prevents later queries", async () => {
  const h = harness();
  let finish!: () => void; let entered!: () => void;
  const entry = new Promise<void>(resolve => { entered = resolve; });
  h.pg.start.mockImplementationOnce(() => { entered(); return new Promise<void>(resolve => { finish = resolve; }); });
  const starting = h.f.start();
  const rejection = expect(starting).rejects.toThrow("during start");
  await entry; const disposing = h.f.dispose(); finish();
  await rejection; await disposing;
  expect(h.d.migrate).not.toHaveBeenCalled(); expect(h.d.seed).not.toHaveBeenCalled();
  expect(h.pg.stop).toHaveBeenCalledOnce(); expect(h.d.removeDirectory).toHaveBeenCalledOnce();
});
it("avoids an occupied preferred port without closing its listener", async () => {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  try {
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("Missing TCP address");
    const free = await allocateEmbeddedPgPort(address.port);
    expect(free).not.toBe(address.port); expect(listener.listening).toBe(true);
  } finally {
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  }
});
