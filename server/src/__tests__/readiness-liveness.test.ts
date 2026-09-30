/**
 * DEP-003 (E6 deployment harness) — PURE readiness/liveness proof. Exercises the
 * schema-compatibility core, the readiness probe composition, and the readiness-gate
 * middleware with fakes (no PG, no server boot). Proves: liveness stays UP while
 * readiness is DOWN; dependency health is reflected; and the gate 503s while
 * incompatible (never a crash) but always lets health/ready through.
 */
import { describe, it, expect } from "vitest";
import express from "express";
import {
  evaluateSchemaCompatibility,
  type SchemaCompatibility,
} from "../services/schema-compatibility.js";
import {
  buildReadinessProbe,
  readinessRoutes,
  readinessGate,
  type ReadinessSnapshot,
} from "../routes/readiness.js";

const HASHES = ["h0", "h1", "h2", "h3"];

describe("evaluateSchemaCompatibility — pure serving gate", () => {
  it("is COMPATIBLE when applied == required", () => {
    expect(
      evaluateSchemaCompatibility({
        requiredOrderedHashes: HASHES,
        appliedOrderedHashes: HASHES,
        rawAppliedCount: HASHES.length,
      }),
    ).toEqual({ status: "compatible", schemaCompatible: true });
  });

  it("is PENDING (behind, not ready) when applied is a strict prefix of required", () => {
    expect(
      evaluateSchemaCompatibility({
        requiredOrderedHashes: HASHES,
        appliedOrderedHashes: HASHES.slice(0, 2),
        rawAppliedCount: 2,
      }),
    ).toEqual({ status: "pending", schemaCompatible: false, pendingCount: 2 });
  });

  it("is INCOMPATIBLE/newer when the DB has MORE applied rows than the image knows", () => {
    expect(
      evaluateSchemaCompatibility({
        requiredOrderedHashes: HASHES,
        appliedOrderedHashes: HASHES,
        rawAppliedCount: HASHES.length + 1,
      }),
    ).toEqual({ status: "incompatible", schemaCompatible: false, reason: "newer" });
  });

  it("is INCOMPATIBLE/divergent when an applied hash differs from the required prefix", () => {
    expect(
      evaluateSchemaCompatibility({
        requiredOrderedHashes: HASHES,
        appliedOrderedHashes: ["h0", "XX", "h2"],
        rawAppliedCount: 3,
      }),
    ).toEqual({ status: "incompatible", schemaCompatible: false, reason: "divergent" });
  });

  it("is INCOMPATIBLE/divergent when raw rows within range do not resolve to image files", () => {
    expect(
      evaluateSchemaCompatibility({
        requiredOrderedHashes: HASHES,
        appliedOrderedHashes: HASHES.slice(0, 2),
        rawAppliedCount: 3,
      }),
    ).toEqual({ status: "incompatible", schemaCompatible: false, reason: "divergent" });
  });
});

const compatible: SchemaCompatibility = { status: "compatible", schemaCompatible: true };
const pending: SchemaCompatibility = { status: "pending", schemaCompatible: false, pendingCount: 1 };

describe("buildReadinessProbe — liveness up while readiness down", () => {
  it("is live but NOT ready when schema is incompatible even if dependencies are healthy", async () => {
    const probe = buildReadinessProbe({
      schemaCompatibility: async () => pending,
      checkPostgres: async () => true,
      checkMinio: async () => true,
    });
    const snapshot = await probe();
    expect(snapshot.live).toBe(true);
    expect(snapshot.ready).toBe(false);
    expect(snapshot.schemaCompatible).toBe(false);
  });

  it("reflects an unavailable PostgreSQL dependency (live, not ready)", async () => {
    const probe = buildReadinessProbe({
      schemaCompatibility: async () => compatible,
      checkPostgres: async () => false,
    });
    const snapshot = await probe();
    expect(snapshot).toMatchObject({
      live: true,
      ready: false,
      schemaCompatible: true,
      dependencies: { postgres: "unavailable", minio: "not_checked" },
    });
  });

  it("reflects an unavailable MinIO dependency when MinIO is part of the deployment", async () => {
    const probe = buildReadinessProbe({
      schemaCompatibility: async () => compatible,
      checkPostgres: async () => true,
      checkMinio: async () => false,
    });
    const snapshot = await probe();
    expect(snapshot).toMatchObject({
      ready: false,
      dependencies: { postgres: "ok", minio: "unavailable" },
    });
  });

  it("is READY when schema is compatible and every required dependency is healthy", async () => {
    const probe = buildReadinessProbe({
      schemaCompatibility: async () => compatible,
      checkPostgres: async () => true,
      checkMinio: async () => true,
    });
    expect(await probe()).toEqual({
      live: true,
      ready: true,
      schemaCompatible: true,
      dependencies: { postgres: "ok", minio: "ok" },
    });
  });

  it("treats a throwing dependency check as unavailable (fail-closed), not a crash", async () => {
    const probe = buildReadinessProbe({
      schemaCompatibility: async () => compatible,
      checkPostgres: async () => {
        throw new Error("connection refused");
      },
    });
    const snapshot = await probe();
    expect(snapshot.ready).toBe(false);
    expect(snapshot.dependencies.postgres).toBe("unavailable");
  });
});

async function call(
  app: express.Express,
  path: string,
): Promise<{ status: number; body: unknown }> {
  // Minimal in-process request via the app's router using node's http.
  const { createServer } = await import("node:http");
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  } finally {
    server.close();
  }
}

describe("readinessGate — 503 while incompatible, never a crash", () => {
  function appWith(snapshot: ReadinessSnapshot) {
    const probe = async () => snapshot;
    const app = express();
    // Health/readiness answer first (mounted before the gate).
    app.get("/api/health/live", (_req, res) => res.json({ status: "ok", live: true }));
    app.use("/api", readinessRoutes(probe));
    app.use(
      "/api",
      readinessGate({
        probe,
        bypass: (p) => p === "/ready" || p === "/health/live",
      }),
    );
    app.get("/api/companies", (_req, res) => res.json({ served: true }));
    return app;
  }

  const notReady: ReadinessSnapshot = {
    live: true,
    ready: false,
    schemaCompatible: false,
    dependencies: { postgres: "ok", minio: "not_checked" },
  };
  const ready: ReadinessSnapshot = {
    live: true,
    ready: true,
    schemaCompatible: true,
    dependencies: { postgres: "ok", minio: "not_checked" },
  };

  it("503s a tenant/app route while not ready, but liveness + readiness still answer", async () => {
    const app = appWith(notReady);
    expect((await call(app, "/api/companies")).status).toBe(503);
    expect((await call(app, "/api/health/live")).status).toBe(200);
    // /ready answers with 503 status but a JSON body (it always answers).
    const readyRes = await call(app, "/api/ready");
    expect(readyRes.status).toBe(503);
    expect(readyRes.body).toMatchObject({ ready: false, live: true });
  });

  it("serves tenant/app routes once ready", async () => {
    const app = appWith(ready);
    expect((await call(app, "/api/companies")).status).toBe(200);
    expect((await call(app, "/api/ready")).status).toBe(200);
  });
});
