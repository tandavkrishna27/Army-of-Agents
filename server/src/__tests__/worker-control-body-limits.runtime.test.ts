import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import http from "node:http";
import { gzipSync } from "node:zlib";
import {
  WORKER_CONTROL_BODY_LIMIT_BYTES,
  WORKER_CONTROL_EVENTS_BODY_LIMIT_BYTES,
  WORKER_CONTROL_EVENTS_PATH,
  WORKER_CONTROL_INFLATE,
  WORKER_CONTROL_PATH_PREFIX,
} from "../worker-control-body-limits.js";

// BRW-003d-1 — RUNTIME behaviour of the worker-control body mounts.
//
// ★ WHAT THIS TIER DOES AND DOES NOT PROVE, stated so neither is over-claimed.
// It proves the MECHANISM: that these limits, mounted in this order with these
// options, produce the intended boundary behaviour under the real express and
// body-parser this repo resolves. It does NOT prove app.ts wires them — that is
// the integration tier's job, and that tier skips on Windows without
// AOA_RUN_WIN_INTEGRATION. Neither test substitutes for the other, which is why
// both exist.
//
// A source-text assertion ("app.ts contains this mount") was considered and
// rejected: a mount whose path string never matches the real URL satisfies a
// text check while parsing nothing. It passes against a system that does nothing.

let server: http.Server;
let base: string;

beforeAll(async () => {
  const app = express();
  const api = express.Router();
  const capture = (
    req: express.Request,
    _res: express.Response,
    buf: Buffer,
  ) => {
    if (buf && buf.length > 0) {
      (req as unknown as { rawBody?: Buffer }).rawBody = buf;
    }
  };

  // Exactly app.ts's order: specific mount, prefix mount, then the global
  // default-limit parser. The router mounts LAST, as it does at app.ts.
  app.use(
    WORKER_CONTROL_EVENTS_PATH,
    express.json({
      limit: WORKER_CONTROL_EVENTS_BODY_LIMIT_BYTES,
      inflate: WORKER_CONTROL_INFLATE,
      verify: capture,
    }),
  );
  app.use(
    WORKER_CONTROL_PATH_PREFIX,
    express.json({
      limit: WORKER_CONTROL_BODY_LIMIT_BYTES,
      inflate: WORKER_CONTROL_INFLATE,
      verify: capture,
    }),
  );
  app.use(express.json({ verify: capture }));

  const handler = (req: express.Request, res: express.Response) => {
    const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
    // Stand in for a worker-control handler: it can only answer in the
    // protocol's own shape if the body reached it at all.
    res.json({ envelope: "protocol", rawBytes: raw ? raw.length : null });
  };
  api.post("/worker-control/events", handler);
  api.post("/worker-control/poll", handler);
  api.post("/other", handler);
  app.use("/api", api);
  app.use((
    err: { status?: number; type?: string },
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    res.status(err.status ?? 500).json({ envelope: "NOT-protocol", type: err.type });
  });

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const postJson = async (path: string, payloadBytes: number) => {
  const body = JSON.stringify({ p: "x".repeat(payloadBytes) });
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

describe("BRW-003d-1 worker-control body limits — runtime boundaries", () => {
  it("ACCEPTS a legal event batch that the express default would have refused", async () => {
    // THE HEADLINE RED STATE. 200,000 bytes is ~2x express's 100 KB default and
    // ~21x INSIDE the frozen 4 MiB event_upload ceiling — i.e. a perfectly legal
    // batch that was being refused. The correct post-fix behaviour is
    // ACCEPTANCE, not a better-shaped refusal; a test asserting refusal here
    // would pin a contract regression.
    const res = await postJson("/api/worker-control/events", 200_000);
    expect(res.status).toBe(200);
    expect(res.body.envelope).toBe("protocol");
    expect(res.body.rawBytes).toBeGreaterThan(200_000);
  });

  it("keeps the WIDE limit off the shared prefix", async () => {
    // 500,000 bytes is above the prefix limit (256 KiB + headroom) and below the
    // events limit. If both paths accepted it, the specific mount would be
    // pointless and every 64 KiB operation would carry a 4 MiB pre-auth buffer.
    const wide = await postJson("/api/worker-control/events", 500_000);
    expect(wide.status).toBe(200);

    const narrow = await postJson("/api/worker-control/poll", 500_000);
    expect(narrow.status).toBe(413);
    expect(narrow.body.envelope).toBe("NOT-protocol");
  });

  it("still lifts the prefix paths clear of the 100 KB default", async () => {
    // artifact_commit / quarantine_finalize / control_command all declare
    // 256 KiB. Before this mount, a 200 KB body on those paths died at express.
    const res = await postJson("/api/worker-control/poll", 200_000);
    expect(res.status).toBe(200);
    expect(res.body.envelope).toBe("protocol");
  });

  it("leaves every OTHER path on the express default", async () => {
    // The mount must not become a blanket raise. A non-worker-control path must
    // still refuse a 200 KB body.
    const res = await postJson("/api/other", 200_000);
    expect(res.status).toBe(413);
  });

  it("★ REFUSES a compressed body — the 1019.8:1 amplification", async () => {
    // With inflate:true, body-parser skips the Content-Length pre-check for a
    // compressed body, so the limit bounds DECOMPRESSED bytes: a few KB of gzip
    // buys megabytes of heap on a surface whose auth is checked after the parse.
    // The real worker never sets content-encoding, so refusing costs nothing.
    const raw = Buffer.from(JSON.stringify({ p: "x".repeat(4_000_000) }));
    const gz = gzipSync(raw);
    expect(gz.length).toBeLessThan(raw.length / 100); // the amplification is real

    const res = await fetch(`${base}${WORKER_CONTROL_EVENTS_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
      body: gz as unknown as BodyInit,
    });
    expect(res.status).toBe(415);
    expect((await res.json() as Record<string, unknown>).type).toBe("encoding.unsupported");
  });

  it("still refuses a body above the mounted ceiling, honestly", async () => {
    // Above the mount there is no protocol-shaped answer available without
    // unbounded buffering. Asserted rather than glossed over: this band exists,
    // and it now starts past the contract ceiling plus headroom instead of at
    // 100 KB.
    const res = await postJson(
      "/api/worker-control/events",
      WORKER_CONTROL_EVENTS_BODY_LIMIT_BYTES + 50_000,
    );
    expect(res.status).toBe(413);
    expect(res.body.envelope).toBe("NOT-protocol");
  });
});
