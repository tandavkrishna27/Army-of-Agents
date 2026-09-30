import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, it, expect, vi } from "vitest";
import { runStreamingLogin, type RunStreamingLoginOptions } from "./streaming-login.js";
import type { TrackedChildHandle } from "./server-utils.js";

/** A fake child + handle whose stdout/stderr/close/error we drive by hand. */
function fakeSpawn() {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.stdout = stdout;
  child.stderr = stderr;
  const terminate = vi.fn();
  const handle: TrackedChildHandle = {
    child: child as never,
    pid: 4242,
    pgid: 4242,
    startedAt: new Date(0),
    terminate,
  };
  const spawn: RunStreamingLoginOptions["spawn"] = () => handle;
  return { spawn, stdout, stderr, child, handle, terminate };
}

const base = (spawn: RunStreamingLoginOptions["spawn"]): RunStreamingLoginOptions => ({
  runId: "login-1",
  command: "codex",
  args: ["login"],
  cwd: "/tmp",
  env: {},
  spawn,
});

/** A fake TrackedChildHandle whose stdin can be supplied for submitCode tests. */
function makeFakeHandle(opts?: { stdin?: unknown }): TrackedChildHandle {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin?: unknown;
  };
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = opts?.stdin;
  return {
    child: child as never,
    pid: 1,
    pgid: 1,
    startedAt: new Date(),
    terminate: () => {},
  };
}

describe("runStreamingLogin (Plan 3 T3)", () => {
  it("resolves urlPromise from a stdout chunk", async () => {
    const f = fakeSpawn();
    const { urlPromise, handle } = runStreamingLogin(base(f.spawn));
    expect(handle).toBe(f.handle);
    f.stdout.emit("data", Buffer.from("Sign in at https://chatgpt.com/device?code=AB12 now\n"));
    await expect(urlPromise).resolves.toBe("https://chatgpt.com/device?code=AB12");
  });

  it("resolves urlPromise from stderr (some CLIs print the URL there)", async () => {
    const f = fakeSpawn();
    const { urlPromise } = runStreamingLogin(base(f.spawn));
    f.stderr.emit("data", "visit https://claude.ai/oauth?x=9\n");
    await expect(urlPromise).resolves.toBe("https://claude.ai/oauth?x=9");
  });

  it("does not let a newline on one stream terminate a partial URL on the other", async () => {
    const f = fakeSpawn();
    const { urlPromise } = runStreamingLogin(base(f.spawn));
    let resolved: string | undefined;
    void urlPromise.then((url) => {
      resolved = url;
    });
    f.stdout.emit("data", "visit https://auth.openai.com/codex/dev");
    f.stderr.emit("data", "\n");
    await Promise.resolve();
    expect(resolved).toBeUndefined();
    f.stdout.emit("data", "ice\n");
    await expect(urlPromise).resolves.toBe("https://auth.openai.com/codex/device");
  });

  it("exitPromise resolves with the code; urlPromise rejects no-url when the child exits first", async () => {
    const f = fakeSpawn();
    const { urlPromise, exitPromise } = runStreamingLogin(base(f.spawn));
    const urlSettled = urlPromise.catch((e: Error) => e.message);
    f.child.emit("close", 1);
    await expect(exitPromise).resolves.toBe(1);
    await expect(urlSettled).resolves.toBe("no-url");
  });

  it("urlPromise rejects with the spawn error; exitPromise resolves null", async () => {
    const f = fakeSpawn();
    const { urlPromise, exitPromise } = runStreamingLogin(base(f.spawn));
    const urlSettled = urlPromise.catch((e: Error) => e.message);
    f.child.emit("error", new Error("ENOENT"));
    await expect(exitPromise).resolves.toBeNull();
    await expect(urlSettled).resolves.toBe("ENOENT");
  });

  it("rejects urlPromise with login-url-timeout after the discovery window", async () => {
    vi.useFakeTimers();
    try {
      const f = fakeSpawn();
      const { urlPromise } = runStreamingLogin({ ...base(f.spawn), discoveryTimeoutMs: 1000 });
      const settled = urlPromise.catch((e: Error) => e.message);
      await vi.advanceTimersByTimeAsync(1001);
      await expect(settled).resolves.toBe("login-url-timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reject twice: a URL after timeout is ignored (single-settle)", async () => {
    vi.useFakeTimers();
    try {
      const f = fakeSpawn();
      const { urlPromise } = runStreamingLogin({ ...base(f.spawn), discoveryTimeoutMs: 500 });
      const settled = urlPromise.then(() => "resolved").catch((e: Error) => e.message);
      await vi.advanceTimersByTimeAsync(501);
      f.stdout.emit("data", "https://claude.ai/oauth?late=1\n");
      f.child.emit("close", 0);
      await expect(settled).resolves.toBe("login-url-timeout");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("runStreamingLogin — stdin opt-in", () => {
  it("ignores stdin by default so codex's spawn is unchanged", () => {
    let captured: unknown;
    runStreamingLogin({
      runId: "r1", command: "codex", args: ["login"], cwd: "/tmp", env: {},
      spawn: (_r, _c, _a, opts) => { captured = opts.stdio; return makeFakeHandle(); },
    });
    expect(captured).toEqual(["ignore", "pipe", "pipe"]);
  });

  it("pipes stdin when explicitly requested", () => {
    let captured: unknown;
    runStreamingLogin({
      runId: "r1", command: "claude", args: ["auth", "login"], cwd: "/tmp", env: {},
      stdin: "pipe",
      spawn: (_r, _c, _a, opts) => { captured = opts.stdio; return makeFakeHandle(); },
    });
    expect(captured).toEqual(["pipe", "pipe", "pipe"]);
  });
});

describe("runStreamingLogin — submitCode", () => {
  it("writes the code with a trailing newline to the child's stdin", () => {
    const written: string[] = [];
    const handle = makeFakeHandle({ stdin: { write: (s: string) => { written.push(s); return true; }, writable: true } });
    const r = runStreamingLogin({
      runId: "r1", command: "claude", args: ["auth", "login"], cwd: "/tmp", env: {},
      stdin: "pipe", spawn: () => handle,
    });
    expect(r.submitCode("ABC-123")).toBe(true);
    expect(written).toEqual(["ABC-123\n"]);
  });

  it("returns false when stdin was not piped", () => {
    const handle = makeFakeHandle({ stdin: null });
    const r = runStreamingLogin({
      runId: "r1", command: "codex", args: ["login"], cwd: "/tmp", env: {}, spawn: () => handle,
    });
    expect(r.submitCode("ABC-123")).toBe(false);
  });

  it("returns false once the child's stdin is no longer writable", () => {
    const handle = makeFakeHandle({ stdin: { write: () => true, writable: false } });
    const r = runStreamingLogin({
      runId: "r1", command: "claude", args: ["auth", "login"], cwd: "/tmp", env: {},
      stdin: "pipe", spawn: () => handle,
    });
    expect(r.submitCode("ABC-123")).toBe(false);
  });
});

describe("runStreamingLogin — submitCode never crashes the process", () => {
  it("survives an async EPIPE on the child's stdin", async () => {
    const stdin = new PassThrough();
    const handle = makeFakeHandle({ stdin });
    const r = runStreamingLogin({
      runId: "r1", command: "claude", args: ["auth", "login"], cwd: "/tmp", env: {},
      stdin: "pipe", spawn: () => handle,
    });
    expect(r.submitCode("ABC-123")).toBe(true);

    // An unhandled 'error' on a writable throws as an uncaught exception.
    // The runner must have attached a listener, so this is absorbed.
    expect(() => stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }))).not.toThrow();
  });

  it("returns false instead of propagating a synchronous write failure", () => {
    const handle = makeFakeHandle({
      stdin: {
        writable: true,
        on: () => {},
        write: () => { throw new Error("write EPIPE"); },
      },
    });
    const r = runStreamingLogin({
      runId: "r1", command: "claude", args: ["auth", "login"], cwd: "/tmp", env: {},
      stdin: "pipe", spawn: () => handle,
    });
    expect(r.submitCode("ABC-123")).toBe(false);
  });

  it("attaches the stdin error listener only once, not per submitCode call", () => {
    const added: string[] = [];
    const handle = makeFakeHandle({
      stdin: { writable: true, on: (ev: string) => { added.push(ev); }, write: () => true },
    });
    const r = runStreamingLogin({
      runId: "r1", command: "claude", args: ["auth", "login"], cwd: "/tmp", env: {},
      stdin: "pipe", spawn: () => handle,
    });
    r.submitCode("A");
    r.submitCode("B");
    r.submitCode("C");
    expect(added.filter((e) => e === "error")).toHaveLength(1);
  });
});
