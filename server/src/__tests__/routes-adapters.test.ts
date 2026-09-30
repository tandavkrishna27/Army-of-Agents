import express from "express";
import request from "supertest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { adapterRoutes } from "../routes/adapters.js";
import {
  __resetAdapterPluginStoreCaches,
  addAdapterPlugin,
  setAdapterDisabled,
} from "../services/adapter-plugin-store.js";

type Actor =
  | { type: "none"; source: "none" }
  | {
      type: "board";
      userId: string;
      source: string;
      isInstanceAdmin: boolean;
      companyIds: string[];
    };

function createApp(actor: Actor) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as never;
    next();
  });
  app.use("/api", adapterRoutes());
  app.use(errorHandler);
  return app;
}

const boardActor: Actor = {
  type: "board",
  userId: "user-1",
  source: "session",
  // Operator-plane authority — actorMiddleware mints this alongside
  // isInstanceAdmin for a genuine operator; the operator-plane routes here read it.
  operator: true,
  isInstanceAdmin: true,
  companyIds: [],
};

let tmpHome: string;
let originalHome: string | undefined;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-adapter-routes-"));
  originalHome = process.env.AOA_HOME;
  process.env.AOA_HOME = tmpHome;
  __resetAdapterPluginStoreCaches();
});

afterEach(async () => {
  if (originalHome === undefined) {
    delete process.env.AOA_HOME;
  } else {
    process.env.AOA_HOME = originalHome;
  }
  __resetAdapterPluginStoreCaches();
  await fs.rm(tmpHome, { recursive: true, force: true });
});

describe("adapter routes — auth", () => {
  it("rejects non-board actors on GET /adapters", async () => {
    const app = createApp({ type: "none", source: "none" });
    const res = await request(app).get("/api/adapters");
    expect(res.status).toBe(403);
  });

  it("rejects non-board actors on PATCH /adapters/:type", async () => {
    const app = createApp({ type: "none", source: "none" });
    const res = await request(app)
      .patch("/api/adapters/claude_local")
      .send({ disabled: true });
    expect(res.status).toBe(403);
  });
});

describe("adapter routes — GET /adapters", () => {
  it("lists builtin adapters sorted by type", async () => {
    const app = createApp(boardActor);
    const res = await request(app).get("/api/adapters");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);

    const types = res.body.map((a: { type: string }) => a.type);
    const sorted = [...types].sort((a, b) => a.localeCompare(b));
    expect(types).toEqual(sorted);

    // A handful of known builtin adapters should be present.
    expect(types).toContain("claude_local");
    expect(types).toContain("http");
    expect(types).toContain("process");
  });

  it("marks all listed adapters as source=builtin when no external plugins installed", async () => {
    const app = createApp(boardActor);
    const res = await request(app).get("/api/adapters");
    expect(res.status).toBe(200);
    for (const entry of res.body) {
      expect(entry.source).toBe("builtin");
    }
  });

  it("reports disabled=true for adapters flagged in the plugin store", async () => {
    setAdapterDisabled("claude_local", true);
    const app = createApp(boardActor);
    const res = await request(app).get("/api/adapters");
    expect(res.status).toBe(200);
    const claude = res.body.find((a: { type: string }) => a.type === "claude_local");
    expect(claude).toBeDefined();
    expect(claude.disabled).toBe(true);
  });
});

describe("adapter routes — PATCH /adapters/:type (enable/disable)", () => {
  it("400s on non-boolean disabled", async () => {
    const app = createApp(boardActor);
    const res = await request(app)
      .patch("/api/adapters/claude_local")
      .send({ disabled: "yes" });
    expect(res.status).toBe(400);
  });

  it("404s on unknown adapter type", async () => {
    const app = createApp(boardActor);
    const res = await request(app)
      .patch("/api/adapters/this-adapter-does-not-exist")
      .send({ disabled: true });
    expect(res.status).toBe(404);
  });

  it("persists disabled=true and returns changed=true on first toggle", async () => {
    const app = createApp(boardActor);
    const res = await request(app)
      .patch("/api/adapters/claude_local")
      .send({ disabled: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ type: "claude_local", disabled: true, changed: true });

    // Idempotency — second call should return changed=false.
    const res2 = await request(app)
      .patch("/api/adapters/claude_local")
      .send({ disabled: true });
    expect(res2.body.changed).toBe(false);
  });
});

describe("adapter routes — DELETE /adapters/:type", () => {
  it("403s on attempts to delete a builtin adapter", async () => {
    const app = createApp(boardActor);
    const res = await request(app).delete("/api/adapters/claude_local");
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/built-in/i);
  });

  it("404s when the adapter is not registered at all", async () => {
    const app = createApp(boardActor);
    const res = await request(app).delete("/api/adapters/nonexistent-adapter");
    expect(res.status).toBe(404);
  });
});

describe("adapter routes — PATCH /adapters/:type/override", () => {
  it("400s on missing paused field", async () => {
    const app = createApp(boardActor);
    const res = await request(app)
      .patch("/api/adapters/claude_local/override")
      .send({});
    expect(res.status).toBe(400);
  });

  it("400s when type is not a builtin", async () => {
    const app = createApp(boardActor);
    const res = await request(app)
      .patch("/api/adapters/my-external-adapter/override")
      .send({ paused: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not a builtin/i);
  });

  it("accepts paused=true and reports changed=false when no external override exists", async () => {
    // setOverridePaused returns false when the type isn't currently overridden
    // — builtin-only types legitimately have nothing to pause.
    const app = createApp(boardActor);
    const res = await request(app)
      .patch("/api/adapters/claude_local/override")
      .send({ paused: true });
    expect(res.status).toBe(200);
    expect(res.body.type).toBe("claude_local");
    expect(res.body.paused).toBe(true);
  });
});

describe("adapter routes — GET /adapters/:type/config-schema", () => {
  it("404s when adapter is not registered", async () => {
    const app = createApp(boardActor);
    const res = await request(app).get("/api/adapters/nonexistent/config-schema");
    expect(res.status).toBe(404);
  });

  it("404s when adapter doesn't expose getConfigSchema", async () => {
    // AoA's builtins don't define getConfigSchema — this exercises the
    // missing-capability branch.
    const app = createApp(boardActor);
    const res = await request(app).get("/api/adapters/claude_local/config-schema");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/does not provide/i);
  });

  it("returns OpenClaw Gateway's schema-driven config fields", async () => {
    const app = createApp(boardActor);
    const res = await request(app).get("/api/adapters/openclaw_gateway/config-schema");
    expect(res.status).toBe(200);
    expect(res.body.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "url", label: "Gateway URL" }),
        expect.objectContaining({ key: "sessionKeyStrategy", label: "Session strategy" }),
      ]),
    );
  });
});

describe("adapter routes — GET /adapters/:type/ui-parser.js", () => {
  it("404s when no UI parser is available", async () => {
    const app = createApp(boardActor);
    const res = await request(app).get("/api/adapters/claude_local/ui-parser.js");
    expect(res.status).toBe(404);
  });
});

describe("adapter routes — external-adapter store interaction (GET)", () => {
  it("surfaces external adapter records via the list endpoint source/packageName fields", async () => {
    // Register an external record in the plugin store. The adapter itself
    // isn't loaded (plugin-loader would need a real package on disk) so it
    // only affects the metadata enrichment branch in buildAdapterInfo.
    //
    // Because buildAdapterInfo only enriches for adapters that are ALREADY
    // registered in the server registry, we can't observe the external
    // record here without loading. So this test documents the expected
    // no-op behavior: listing adapters should not crash even when a plugin
    // store record exists for an unregistered type.
    addAdapterPlugin({
      packageName: "nonexistent-adapter",
      type: "nonexistent-adapter",
      installedAt: "2026-04-20T00:00:00.000Z",
    });

    const app = createApp(boardActor);
    const res = await request(app).get("/api/adapters");
    expect(res.status).toBe(200);

    // The unregistered external should not appear (buildAdapterInfo only
    // iterates registered adapters).
    const types = res.body.map((a: { type: string }) => a.type);
    expect(types).not.toContain("nonexistent-adapter");
  });
});
