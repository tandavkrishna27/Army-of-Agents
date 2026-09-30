export type SandboxRequest =
  | { type: "init"; source: string }
  | { type: "parse"; id: number; line: string; ts: string };

export type SandboxResponse =
  | { type: "ready" }
  | { type: "error"; message: string }
  | { type: "result"; id: number; entries: unknown[] };

const WORKER_BOOTSTRAP = `
"use strict";

const _undefined = void 0;

self.fetch = _undefined;
self.XMLHttpRequest = _undefined;
self.WebSocket = _undefined;
self.EventSource = _undefined;
self.RTCPeerConnection = _undefined;
self.RTCDataChannel = _undefined;
self.Request = _undefined;
self.Response = _undefined;
self.Headers = _undefined;
self.Cache = _undefined;
self.CacheStorage = _undefined;
self.caches = _undefined;
self.importScripts = _undefined;
self.Worker = _undefined;
self.SharedWorker = _undefined;
self.Blob = _undefined;
if (self.URL) {
  try { Object.defineProperty(self.URL, "createObjectURL", { value: _undefined, writable: false, configurable: false }); } catch {}
  try { Object.defineProperty(self.URL, "revokeObjectURL", { value: _undefined, writable: false, configurable: false }); } catch {}
}
if (self.navigator) {
  try { Object.defineProperty(self.navigator, "sendBeacon", { value: _undefined, writable: false, configurable: false }); } catch {}
}
self.BroadcastChannel = _undefined;
self.indexedDB = _undefined;
self.IDBFactory = _undefined;

let parseStdoutLine = null;
let createStdoutParser = null;
let fallbackParser = null;

self.onmessage = function (e) {
  const msg = e.data;

  if (msg.type === "init") {
    try {
      const exports = {};
      const module = { exports };
      const factory = new Function(
        "exports", "module", "self", "globalThis",
        "\\"use strict\\";\\n{\\n" + msg.source + "\\n}"
      );
      factory(exports, module, _undefined, _undefined);

      const resolved = module.exports && typeof module.exports === "object" && Object.keys(module.exports).length > 0
        ? module.exports
        : exports;

      if (typeof resolved.parseStdoutLine === "function") {
        parseStdoutLine = resolved.parseStdoutLine;
      }
      if (typeof resolved.createStdoutParser === "function") {
        createStdoutParser = resolved.createStdoutParser;
      }
      if (!parseStdoutLine && createStdoutParser) {
        fallbackParser = createStdoutParser();
        if (fallbackParser && typeof fallbackParser.parseLine === "function") {
          parseStdoutLine = (line, ts) => fallbackParser.parseLine(line, ts);
        }
      }

      if (!parseStdoutLine) {
        self.postMessage({ type: "error", message: "Parser module exports no usable parser" });
        return;
      }

      self.postMessage({ type: "ready" });
    } catch (err) {
      self.postMessage({ type: "error", message: "Parser init failed: " + (err && err.message || String(err)) });
    }
    return;
  }

  if (msg.type === "parse") {
    try {
      const entries = parseStdoutLine ? parseStdoutLine(msg.line, msg.ts) : [];
      self.postMessage({ type: "result", id: msg.id, entries: entries || [] });
    } catch {
      self.postMessage({ type: "result", id: msg.id, entries: [] });
    }
  }
};
`;

export function getWorkerBootstrapSource(): string {
  return WORKER_BOOTSTRAP;
}

export function createSandboxedWorker(): Worker {
  const blob = new Blob([WORKER_BOOTSTRAP], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  try {
    return new Worker(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}
