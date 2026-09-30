import { afterEach, expect, it, vi } from "vitest";
import { createBackupFixture, cleanupBackupResources } from "./helpers/backup-fixture.js";
afterEach(() => vi.useRealTimers());
function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
function harness(pending: "initialise" | "start" | "seed" = "initialise") {
  const gate = deferred(), entered = deferred();
  const events: string[] = [];
  let started = false;
  const cleanup = vi.fn(async () => {
    if (started) events.push("stop");
    events.push("remove");
  });
  const f = createBackupFixture(["initialise", "start", "seed"].map(name => ({
    name, async run() {
      events.push(name);
      if (name === pending) { entered.resolve(); await gate.promise; }
      if (name === "start") started = true;
    },
  })), cleanup, { startupMs: 30_000, cleanupMs: 25_000 });
  return { f, gate, entered, events, cleanup };
}
it.each(["initialise", "start", "seed"] as const)("owns late %s completion", async phase => {
  vi.useFakeTimers(); const h = harness(phase);
  const starting = h.f.start();
  const rejection = expect(starting).rejects.toThrow(`during ${phase}`);
  await h.entered.promise;
  await vi.advanceTimersByTimeAsync(30_000); await rejection;
  const disposing = h.f.dispose();
  expect(h.cleanup).not.toHaveBeenCalled();
  h.gate.resolve(); await disposing;
  expect(h.events).toEqual(phase === "initialise"
    ? ["initialise", "remove"] : phase === "start"
    ? ["initialise", "start", "stop", "remove"]
    : ["initialise", "start", "seed", "stop", "remove"]);
  await h.f.dispose(); expect(h.cleanup).toHaveBeenCalledOnce();
});
it("reports cleanup expiry without deleting pending initialization", async () => {
  vi.useFakeTimers(); const h = harness();
  const rejected = expect(h.f.start()).rejects.toThrow("during initialise");
  await h.entered.promise; await vi.advanceTimersByTimeAsync(30_000); await rejected;
  const cleanupResult = h.f.dispose().then(
    () => ({ ok: true, error: undefined }),
    error => ({ ok: false, error }),
  );
  await vi.advanceTimersByTimeAsync(25_000);
  const result = await cleanupResult;
  expect(result.ok).toBe(false);
  expect(result.error).toBeInstanceOf(Error);
  expect(result.error.message).toContain("cleanup exceeded");
  expect(h.cleanup).not.toHaveBeenCalled();
  // Release synthetic work; never leave an actual test process hung.
  h.gate.resolve(); await vi.runAllTimersAsync();
  expect(h.cleanup).toHaveBeenCalledOnce();
});
it("accepts slow successful setup once within its explicit budget", async () => {
  vi.useFakeTimers(); const h = harness(); const starting = h.f.start();
  expect(h.f.start()).toBe(starting);
  await h.entered.promise; await vi.advanceTimersByTimeAsync(12_000);
  h.gate.resolve(); await starting; await h.f.dispose();
  expect(h.events).toEqual(["initialise", "start", "seed", "stop", "remove"]);
});
it.each([undefined, new Error("init failure")])("retains rejection cause %s", async cause => {
  const h = harness(); const rejected = expect(h.f.start()).rejects.toMatchObject({ cause });
  await h.entered.promise; h.gate.reject(cause); await rejected;
  await h.f.dispose(); expect(h.events).toEqual(["initialise", "remove"]);
});
it("does not swallow cleanup failure", async () => {
  const h = harness(); h.gate.resolve(); await h.f.start();
  const error = new Error("cleanup fault"); h.cleanup.mockRejectedValueOnce(error);
  await expect(h.f.dispose()).rejects.toBe(error);
  expect(h.cleanup).toHaveBeenCalledOnce();
});
it("cannot allocate after disposal", async () => {
  const h = harness(); await h.f.dispose();
  await expect(h.f.start()).rejects.toThrow("disposed");
  expect(h.events).toEqual(["remove"]);
});

it.each(["close", "stop", "unsafe", "remove", "none"])("cleanup ownership: %s", async fault => {
  const events: string[] = [];
  const error = new Error(fault);
  const perform = (name: string) => async () => {
    events.push(name); if (fault === name) throw error;
  };
  const work = cleanupBackupResources({
    closeClient: perform("close"),
    stop: fault === "unsafe" ? undefined : perform("stop"),
    unsafe: fault === "unsafe" ? "uncertain startup" : undefined,
    directories: ["/owned/data", "/owned/backups"],
    remove: async () => { events.push("remove"); if (fault === "remove") throw error; },
  });
  if (fault === "none") await work;
  else await expect(work).rejects.toBeInstanceOf(AggregateError);
  expect(events).toEqual(fault === "unsafe" ? ["close"]
    : fault === "close" || fault === "stop" ? ["close", "stop"]
    : ["close", "stop", "remove", "remove"]);
});
it("removes only acquired directories before postgres is constructed", async () => {
  const remove = vi.fn(async (_directory: string) => {});
  await cleanupBackupResources({ directories: ["/owned/data"], remove });
  expect(remove).toHaveBeenCalledOnce();
  expect(remove).toHaveBeenCalledWith("/owned/data");
});

it("rejects disposal during the final pending step before the startup deadline", async () => {
  const h = harness("seed");
  const starting = h.f.start();
  const rejected = expect(starting).rejects.toThrow("during seed");
  await h.entered.promise;
  const disposing = h.f.dispose();
  h.gate.resolve();
  await rejected;
  await disposing;
  expect(h.events).toEqual(["initialise", "start", "seed", "stop", "remove"]);
});
