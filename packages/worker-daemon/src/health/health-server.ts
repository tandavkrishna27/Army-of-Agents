/**
 * Loopback-only health + payload-free metrics HTTP surface (WRK-001).
 *
 * Binds a tiny `node:http` server to a loopback address only, exposing
 * `GET /healthz` (liveness) and `GET /metrics` (payload-free bounded counters).
 * It exposes no tenant data and no remote-reachable interface; a non-loopback
 * bind host is rejected BEFORE any socket opens (H-06 network boundary).
 */

import { createServer, type Server } from "node:http";

import { isLoopbackHost } from "../config/config.js";
import type { Metrics } from "../metrics/metrics.js";

/** Throw unless `host` is a loopback bind address (single source: config). */
export function assertLoopbackHost(host: string): void {
  if (!isLoopbackHost(host)) {
    throw new Error(
      `health host ${JSON.stringify(host)} is not loopback; refusing to bind a ` +
        "remote-reachable health/metrics surface",
    );
  }
}

export interface HealthServerConfig {
  readonly host: string;
  readonly port: number;
  /**
   * DSK-003 — the per-boot instance nonce served at `GET /instance`.
   *
   * It exists for the stale-pid defence: `control/host-state.ts` will not hand a control
   * command a pid to signal unless the LIVE host reports the same nonce the state record
   * carries. Without it, a crashed host whose pid the OS recycled would be signalled in
   * place of an unrelated process.
   *
   * Serving it here is deliberate and stays inside this surface's stated category — a
   * random nonce identifies WHICH process is listening and nothing about it, so it is
   * read-only liveness exactly like `/healthz`, not tenant data. OPTIONAL: with no nonce
   * configured the route 404s and the server behaves exactly as before.
   */
  readonly instanceId?: string;
}

export interface HealthServerHandle {
  /** The actually-bound port (useful when port 0 is requested in tests). */
  readonly port: number;
  close(): Promise<void>;
}

export async function startHealthServer(
  config: HealthServerConfig,
  metrics: Metrics,
): Promise<HealthServerHandle> {
  // Reject a non-loopback host BEFORE any socket is created.
  assertLoopbackHost(config.host);

  const server: Server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (req.method === "GET" && url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("ok\n");
      return;
    }
    // DSK-003: the nonce echo the stale-pid defence probes. Gated on presence, so an
    // unconfigured server keeps its exact prior surface. Nothing else is disclosed here —
    // the endpoint is unauthenticated by design and must not grow into a status surface.
    if (req.method === "GET" && url === "/instance" && config.instanceId !== undefined) {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(`${JSON.stringify({ instanceId: config.instanceId })}\n`);
      return;
    }
    if (req.method === "GET" && url === "/metrics") {
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
      res.end(metrics.renderPrometheus());
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found\n");
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: unknown) => reject(err);
    server.once("error", onError);
    server.listen(config.port, config.host, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : config.port;

  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
