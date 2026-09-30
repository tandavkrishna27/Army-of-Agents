/**
 * Transport-only newline-delimited JSON-RPC 2.0 stdio client for
 * `codex app-server` (W5c Task 2).
 *
 * This layer carries NO Codex semantics — no thread/turn/approval logic. It only
 * owns the wire: framing, request/response correlation, server-request + notification
 * dispatch, a serialized backpressure-aware write queue, and a max-frame cap.
 * Codex semantics (thread/start, turn/start, approval decisions) live in Task 3
 * on top of `request` / `notify` / `respond`.
 *
 * Framing (confirmed live in docs/adapters/codex-appserver-protocol.md §8):
 * frames split across stdout chunks AND multiple frames arrive in one chunk, so
 * the read loop carries a partial-line buffer, splits on "\n", and JSON.parses
 * each COMPLETE line synchronously. A server REQUEST has BOTH `method` and `id`;
 * a notification has `method` only; a response has `id` + `result|error`.
 *
 * Non-blocking invariant: a server-request (approval) handler is dispatched
 * ASYNCHRONOUSLY — never awaited inside the stdout-drain path — so a 2nd frame in
 * the same chunk (or a later notification) keeps being decoded while an approval
 * is pending.
 */
import type { ChildProcess } from "node:child_process";
import { spawnTrackedChild } from "@armyofagents/adapter-utils/server-utils";

type Writable = {
  write(chunk: string, cb?: (err?: Error | null) => void): boolean;
  once(event: "drain", listener: () => void): unknown;
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
  end?(): void;
};

type Readable = {
  on(event: "data", listener: (chunk: unknown) => void): unknown;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: "data", listener: (chunk: unknown) => void): unknown;
};

/** A decoded JSON-RPC message. */
interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown } | null;
}

export interface JsonRpcClient {
  /** Send a request; resolves with `result` (or rejects with `error`). */
  request(method: string, params?: unknown): Promise<unknown>;
  /** Fire-and-forget notification (no id, no correlation). */
  notify(method: string, params?: unknown): void;
  /** Answer a server request with a success result. */
  respond(id: number | string, result: unknown): void;
  /** Answer a server request with an error. */
  respondError(id: number | string, error: { code: number; message: string; data?: unknown }): void;
  /** Register a callback fired once when the transport closes. */
  onClose(cb: () => void): void;
  /** Reject all pending requests, clear queues, and detach. */
  close(err?: Error): void;
}

export interface CreateJsonRpcClientOptions {
  stdin: Writable;
  stdout: Readable;
  /** Notification (method only). */
  onNotification?: (method: string, params: unknown) => void;
  /**
   * Server request (method + id). Dispatched asynchronously — its returned
   * promise settles LATER; the caller answers via `respond` / `respondError`.
   * MUST NOT be awaited on the drain path (this module guarantees that).
   */
  onServerRequest?: (
    id: number | string,
    method: string,
    params: unknown,
  ) => void | Promise<void>;
  /** Non-fatal transport diagnostics (garbage line, oversized frame, etc.). */
  onError?: (err: unknown) => void;
  /** Reject a single line longer than this many chars (no unbounded buffer). */
  maxFrameBytes?: number;
}

const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;

/**
 * Injectable client core. Drives against ANY stdin/stdout pair so it can be
 * unit-tested with fake streams; the real spawn wrapper (`spawnAppServerClient`)
 * builds these from a tracked child.
 */
export function createJsonRpcClient(opts: CreateJsonRpcClientOptions): JsonRpcClient {
  const maxFrameBytes = opts.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  const onError = opts.onError ?? (() => {});

  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();
  const closeCallbacks: Array<() => void> = [];
  let nextId = 1;
  let closed = false;

  // --- Serialized, backpressure-aware write queue -------------------------
  const writeQueue: string[] = [];
  let writing = false;

  const flushWrites = (): void => {
    if (writing || closed) return;
    writing = true;
    const pump = (): void => {
      if (closed) {
        writing = false;
        return;
      }
      const next = writeQueue.shift();
      if (next === undefined) {
        writing = false;
        return;
      }
      const ok = opts.stdin.write(next);
      if (ok) {
        // Synchronously continue with the next frame.
        pump();
      } else {
        // Buffer full — wait for 'drain' before the next write.
        opts.stdin.once("drain", pump);
      }
    };
    pump();
  };

  const enqueueWrite = (msg: JsonRpcMessage): void => {
    if (closed) return;
    writeQueue.push(JSON.stringify(msg) + "\n");
    flushWrites();
  };

  // --- Read loop: carry buffer + newline framing --------------------------
  let carry = "";

  const dispatch = (msg: JsonRpcMessage): void => {
    // Response to one of our requests: id present, method absent.
    if (msg.method === undefined && msg.id !== undefined) {
      const idNum = typeof msg.id === "number" ? msg.id : Number(msg.id);
      const entry = pending.get(idNum);
      if (!entry) return; // unknown / already-settled id — ignore.
      pending.delete(idNum);
      if (msg.error) {
        entry.reject(
          new Error(msg.error.message || `JSON-RPC error ${msg.error.code ?? ""}`.trim()),
        );
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    // Server request: method + id → answer LATER (never await on drain path).
    if (msg.method !== undefined && msg.id !== undefined) {
      if (opts.onServerRequest) {
        // Fire-and-forget: schedule so parsing/correlation keep running while the
        // (possibly slow, human-gated) handler is outstanding.
        void Promise.resolve()
          .then(() => opts.onServerRequest!(msg.id!, msg.method!, msg.params))
          .catch((err) => onError(err));
      }
      return;
    }

    // Notification: method only.
    if (msg.method !== undefined) {
      try {
        opts.onNotification?.(msg.method, msg.params);
      } catch (err) {
        onError(err);
      }
    }
  };

  const onChunk = (chunk: unknown): void => {
    if (closed) return;
    carry += String(chunk);
    let idx: number;
    while ((idx = carry.indexOf("\n")) >= 0) {
      const line = carry.slice(0, idx).trim();
      carry = carry.slice(idx + 1);
      if (!line) continue;
      let parsed: JsonRpcMessage;
      try {
        parsed = JSON.parse(line) as JsonRpcMessage;
      } catch (err) {
        // Garbage line — log and skip; not fatal.
        onError(err);
        continue;
      }
      dispatch(parsed);
    }
    // Enforce the max-frame cap on the still-unterminated carry so a single
    // pathological line cannot grow the buffer without bound.
    if (carry.length > maxFrameBytes) {
      const err = new Error(
        `JSON-RPC frame exceeded max size (${carry.length} > ${maxFrameBytes} bytes)`,
      );
      onError(err);
      close(err);
    }
  };

  opts.stdout.on("data", onChunk);

  // --- Public API ---------------------------------------------------------
  const request = (method: string, params?: unknown): Promise<unknown> => {
    if (closed) return Promise.reject(new Error("JSON-RPC client is closed"));
    const id = nextId++;
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      // codex app-server's request envelope REQUIRES the `params` field
      // (omitted → -32600 "missing field `params`"). JSON.stringify drops
      // undefined values, so default to {} to keep the key on the wire.
      enqueueWrite({ jsonrpc: "2.0", id, method, params: params ?? {} });
    });
  };

  const notify = (method: string, params?: unknown): void => {
    enqueueWrite({ jsonrpc: "2.0", method, params });
  };

  const respond = (id: number | string, result: unknown): void => {
    enqueueWrite({ jsonrpc: "2.0", id, result });
  };

  const respondError = (
    id: number | string,
    error: { code: number; message: string; data?: unknown },
  ): void => {
    enqueueWrite({ jsonrpc: "2.0", id, error });
  };

  const onClose = (cb: () => void): void => {
    closeCallbacks.push(cb);
  };

  function close(err?: Error): void {
    if (closed) return;
    closed = true;
    // Detach the stdout reader so the transport is self-contained on close
    // (matters for a long-lived injected stream; the real child stream is torn
    // down with the process). `onChunk` also early-returns once `closed`.
    opts.stdout.off?.("data", onChunk);
    const rejection = err ?? new Error("JSON-RPC client closed");
    for (const [, entry] of pending) {
      entry.reject(rejection);
    }
    pending.clear();
    writeQueue.length = 0;
    writing = false;
    carry = "";
    for (const cb of closeCallbacks) {
      try {
        cb();
      } catch {
        // close callbacks must not throw into the caller.
      }
    }
  }

  return { request, notify, respond, respondError, onClose, close };
}

export interface SpawnAppServerClientOptions {
  runId: string;
  command?: string;
  cwd: string;
  env: Record<string, string>;
  graceSec: number;
  onNotification?: CreateJsonRpcClientOptions["onNotification"];
  onServerRequest?: CreateJsonRpcClientOptions["onServerRequest"];
  onError?: CreateJsonRpcClientOptions["onError"];
  maxFrameBytes?: number;
  /** Mirrors runChildProcess.onSpawn — lets the caller persist PID/PGID. */
  onSpawn?: (pid: number | null, pgid: number | null, startedAt: Date) => void;
  /** Strip the ambient OPENAI_API_KEY (unless the overlay set its own). */
  unsetEnvKeys?: string[];
  shell?: boolean;
  /**
   * Best-effort stderr sink. The child's stderr pipe is ALWAYS drained (the
   * listener existing is what prevents the child from blocking once the OS pipe
   * buffer fills — see the drain wiring below); this callback merely forwards the
   * drained chunks. It carries NO Codex semantics (no noise-stripping) — the
   * bridged runner layers that on top. A throwing callback must NOT break the
   * drain (it is wrapped in try/catch).
   */
  onStderr?: (chunk: string) => void;
}

export interface SpawnedAppServerClient {
  client: JsonRpcClient;
  child: ChildProcess;
  /** SIGTERM→SIGKILL the app-server child (via the tracked handle). */
  terminate(): void;
}

/**
 * Spawn a real `codex app-server` (local target only) through the shared
 * `spawnTrackedChild` so the long-lived child is registered in
 * `runningProcesses` (cancellable + un-reaped while blocked on approval) and
 * strips the ambient OPENAI_API_KEY, then wrap its stdio in the client core.
 * The transport is exercised against fakes in tests; this wrapper is exercised
 * live in Task 3.
 */
export function spawnAppServerClient(
  opts: SpawnAppServerClientOptions,
): SpawnedAppServerClient {
  const handle = spawnTrackedChild(
    opts.runId,
    opts.command ?? "codex",
    ["app-server"],
    {
      cwd: opts.cwd,
      env: opts.env,
      graceSec: opts.graceSec,
      unsetEnvKeys: opts.unsetEnvKeys ?? ["OPENAI_API_KEY"],
      shell: opts.shell,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  opts.onSpawn?.(handle.pid, handle.pgid, handle.startedAt);

  const stdin = handle.child.stdin;
  const stdout = handle.child.stdout;
  if (!stdin || !stdout) {
    handle.terminate();
    throw new Error("codex app-server child has no stdin/stdout pipes");
  }
  // Swallow stdin EPIPE — the child may exit before we finish a write.
  stdin.on("error", () => {});

  // ALWAYS drain stderr. `codex app-server` writes to stderr during normal
  // operation; because a supervised turn is long-lived (blocks up to the 300s
  // approval SLA), an unconsumed stderr pipe fills the OS buffer (~64KB) and then
  // BLOCKS the child on its next stderr write → the turn deadlocks and degrades
  // to a timeout. The LISTENER EXISTING is what drains the pipe; forwarding via
  // `onStderr` is best-effort (a throwing callback must not break the drain).
  // Transport-pure: no Codex noise-stripping here — the bridged runner layers it.
  handle.child.stderr?.on("data", (chunk: unknown) => {
    try {
      opts.onStderr?.(String(chunk));
    } catch {
      // best-effort forward; the drain is the invariant, not the forward.
    }
  });

  const client = createJsonRpcClient({
    stdin: stdin as unknown as Writable,
    stdout: stdout as unknown as Readable,
    onNotification: opts.onNotification,
    onServerRequest: opts.onServerRequest,
    onError: opts.onError,
    maxFrameBytes: opts.maxFrameBytes,
  });

  handle.child.on("close", () => client.close());
  handle.child.on("error", (err: Error) => client.close(err));

  return { client, child: handle.child, terminate: handle.terminate };
}
