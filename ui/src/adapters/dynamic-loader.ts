import type { TranscriptEntry } from "@armyofagents/adapter-utils";
import type { StdoutLineParser, StdoutParserFactory } from "./types";
import { createSandboxedWorker } from "./sandboxed-parser-worker";
import type { SandboxRequest, SandboxResponse } from "./sandboxed-parser-worker";

interface DynamicParserModule {
  parseStdoutLine: StdoutLineParser;
  createStdoutParser?: StdoutParserFactory;
}

interface SandboxedParser {
  worker: Worker;
  nextId: number;
  pendingResolves: Map<number, (entries: TranscriptEntry[]) => void>;
}

const sandboxedParsers = new Map<string, SandboxedParser>();
const dynamicParserCache = new Map<string, DynamicParserModule>();
const failedLoads = new Set<string>();
const loadPromises = new Map<string, Promise<DynamicParserModule | null>>();

let resultNotifier: (() => void) | null = null;

export function setDynamicParserResultNotifier(fn: (() => void) | null): void {
  resultNotifier = fn;
}

function sendToWorker(sandbox: SandboxedParser, msg: SandboxRequest): void {
  sandbox.worker.postMessage(msg);
}

function lineCacheKey(line: string, ts: string): string {
  return `${ts}\u0000${line}`;
}

function drainPendingRequests(sandbox: SandboxedParser): void {
  for (const resolver of sandbox.pendingResolves.values()) resolver([]);
  sandbox.pendingResolves.clear();
}

function initSandboxedWorker(source: string): Promise<SandboxedParser> {
  return new Promise((resolve, reject) => {
    const worker = createSandboxedWorker();
    const sandbox: SandboxedParser = {
      worker,
      nextId: 1,
      pendingResolves: new Map(),
    };

    const timeout = setTimeout(() => {
      drainPendingRequests(sandbox);
      worker.terminate();
      reject(new Error("Parser worker init timed out"));
    }, 5000);

    worker.onmessage = (e: MessageEvent<SandboxResponse>) => {
      const msg = e.data;
      if (msg.type === "ready") {
        clearTimeout(timeout);
        worker.onmessage = (ev: MessageEvent<SandboxResponse>) => {
          const resp = ev.data;
          if (resp.type === "result") {
            const resolver = sandbox.pendingResolves.get(resp.id);
            if (resolver) {
              sandbox.pendingResolves.delete(resp.id);
              resolver(resp.entries as TranscriptEntry[]);
            }
          } else if (resp.type === "error") {
            drainPendingRequests(sandbox);
          }
        };
        resolve(sandbox);
      } else if (msg.type === "error") {
        clearTimeout(timeout);
        drainPendingRequests(sandbox);
        worker.terminate();
        reject(new Error(msg.message));
      }
    };

    worker.onerror = (ev) => {
      clearTimeout(timeout);
      drainPendingRequests(sandbox);
      worker.terminate();
      reject(new Error(`Worker error: ${ev.message}`));
    };

    sendToWorker(sandbox, { type: "init", source });
  });
}

function parseLineAsync(sandbox: SandboxedParser, line: string, ts: string): Promise<TranscriptEntry[]> {
  return new Promise((resolve) => {
    const id = sandbox.nextId++;
    sandbox.pendingResolves.set(id, resolve);
    sendToWorker(sandbox, { type: "parse", id, line, ts });
  });
}

function buildParserModule(sandbox: SandboxedParser): DynamicParserModule {
  const parseCache = new Map<string, TranscriptEntry[]>();
  const pendingParseKeys = new Set<string>();

  const parseStdoutLine: StdoutLineParser = (line: string, ts: string) => {
    const key = lineCacheKey(line, ts);
    const cached = parseCache.get(key);
    if (cached) return cached.slice();

    if (!pendingParseKeys.has(key)) {
      pendingParseKeys.add(key);
      parseLineAsync(sandbox, line, ts).then((entries) => {
        pendingParseKeys.delete(key);
        parseCache.set(key, entries);
        resultNotifier?.();
      });
    }

    return [];
  };

  return { parseStdoutLine };
}

export async function loadDynamicParser(adapterType: string): Promise<DynamicParserModule | null> {
  const cached = dynamicParserCache.get(adapterType);
  if (cached) return cached;
  if (failedLoads.has(adapterType)) return null;

  const inflight = loadPromises.get(adapterType);
  if (inflight) return inflight;

  const loadPromise = (async (): Promise<DynamicParserModule | null> => {
    try {
      const response = await fetch(`/api/adapters/${encodeURIComponent(adapterType)}/ui-parser.js`);
      if (!response.ok) {
        failedLoads.add(adapterType);
        return null;
      }

      const sandbox = await initSandboxedWorker(await response.text());
      sandboxedParsers.set(adapterType, sandbox);
      const parserModule = buildParserModule(sandbox);
      dynamicParserCache.set(adapterType, parserModule);
      return parserModule;
    } catch {
      failedLoads.add(adapterType);
      return null;
    } finally {
      loadPromises.delete(adapterType);
    }
  })();

  loadPromises.set(adapterType, loadPromise);
  return loadPromise;
}

export function invalidateDynamicParser(adapterType: string): boolean {
  const wasCached = dynamicParserCache.has(adapterType);
  dynamicParserCache.delete(adapterType);
  failedLoads.delete(adapterType);
  loadPromises.delete(adapterType);

  const sandbox = sandboxedParsers.get(adapterType);
  if (sandbox) {
    drainPendingRequests(sandbox);
    sandbox.worker.terminate();
    sandboxedParsers.delete(adapterType);
  }

  return wasCached;
}
