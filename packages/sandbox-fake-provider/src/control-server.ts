// -----------------------------------------------------------------------------
// Loopback HTTP control plane for the fake sandbox provider.
//
// Control channel:
//   POST /script       { providerId, fixtureId? | fixture?, failureInjection?,
//                        includeAllCheckpoints? }  → 200 {ok,fixtureId} | 400
//   POST /reset        → 200 {ok:true}
//   GET  /invocations?providerId=  → 200 [ ledger entries ]
// Driver channel (addressed by providerId):
//   POST /invoke       { providerId, op, args }  → 200 { result } | 400
//   POST /replay       { providerId }            → 200 { result } | 400
//
// The server binds to 127.0.0.1 only (loopback); it is fully local-verifiable
// (no Docker, no external network). A fixture requested by id is loaded from the
// configured golden-fixtures directory and validated FAIL-CLOSED before scripting.
// -----------------------------------------------------------------------------

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FakeSandboxProvider, type ProviderOpArgs } from "./fake-driver.js";
import { PROVIDER_OPERATIONS, type ProviderOperation } from "@armyofagents/worker-protocol";

/** Repository-relative default golden-fixtures directory (both src + dist resolve
 * to the repo root two levels above the package). */
export function defaultGoldenFixturesDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "..", "tests", "fixtures", "distributed-execution");
}

/** Load a fixture by id from a directory (basename-guarded, `.json` appended). */
export async function loadFixtureFromDir(fixturesDir: string, fixtureId: string): Promise<unknown> {
  const base = path.basename(fixtureId);
  const file = base.endsWith(".json") ? base : `${base}.json`;
  const text = await readFile(path.join(fixturesDir, file), "utf8");
  return JSON.parse(text) as unknown;
}

export interface ControlServerOptions {
  readonly fixturesDir?: string;
}

const PROVIDER_OPERATION_SET: ReadonlySet<string> = new Set(PROVIDER_OPERATIONS);

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim() === "") return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

/** Build (but do not start) the loopback control server. */
export function createControlServer(provider: FakeSandboxProvider, options: ControlServerOptions = {}): Server {
  const fixturesDir = options.fixturesDir ?? defaultGoldenFixturesDir();

  return createServer((req, res) => {
    void handle(req, res).catch((err) => {
      send(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const method = req.method ?? "GET";
    const route = `${method} ${url.pathname}`;

    if (route === "GET /invocations") {
      const providerId = url.searchParams.get("providerId") ?? undefined;
      send(res, 200, provider.invocations(providerId));
      return;
    }
    if (route === "POST /reset") {
      provider.reset();
      send(res, 200, { ok: true });
      return;
    }
    if (route === "POST /script") {
      const body = (await readBody(req)) as Record<string, unknown>;
      const providerId = String(body.providerId ?? "");
      if (providerId === "") return void send(res, 400, { ok: false, error: "providerId is required" });
      try {
        const fixture = await provider.script({
          providerId,
          fixture: body.fixture,
          fixtureId: typeof body.fixtureId === "string" ? body.fixtureId : undefined,
          loadFixture: (id) => loadFixtureFromDir(fixturesDir, id),
          failureInjection: (body.failureInjection ?? null) as never,
          includeAllCheckpoints: body.includeAllCheckpoints === true,
        });
        send(res, 200, { ok: true, fixtureId: fixture.id });
      } catch (err) {
        // Fail-closed: an invalid/unknown fixture is REJECTED, never partially scripted.
        send(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    if (route === "POST /invoke") {
      const body = (await readBody(req)) as Record<string, unknown>;
      const providerId = String(body.providerId ?? "");
      const op = String(body.op ?? "");
      if (providerId === "") return void send(res, 400, { ok: false, error: "providerId is required" });
      if (!PROVIDER_OPERATION_SET.has(op)) {
        return void send(res, 400, { ok: false, error: `unknown provider operation: ${op}` });
      }
      const args = { providerId, ...((body.args as Partial<ProviderOpArgs>) ?? {}) } as ProviderOpArgs;
      try {
        const result = await provider.makeDriver(providerId).invoke(op as ProviderOperation, args);
        send(res, 200, { ok: true, result });
      } catch (err) {
        send(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    if (route === "POST /replay") {
      const body = (await readBody(req)) as Record<string, unknown>;
      const providerId = String(body.providerId ?? "");
      if (providerId === "") return void send(res, 400, { ok: false, error: "providerId is required" });
      try {
        const result = await provider.replay(providerId);
        send(res, 200, { ok: true, result });
      } catch (err) {
        send(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    send(res, 404, { ok: false, error: `no route: ${route}` });
  }
}

export interface StartedControlServer {
  readonly server: Server;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

/** Start the control server on a loopback ephemeral port (127.0.0.1:0). */
export function startControlServer(
  provider: FakeSandboxProvider,
  options: ControlServerOptions = {},
): Promise<StartedControlServer> {
  const server = createControlServer(provider, options);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("control server did not bind to a TCP port"));
        return;
      }
      const port = address.port;
      resolve({
        server,
        port,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });
  });
}
