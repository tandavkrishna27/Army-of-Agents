import express from "express";
import http from "node:http";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { createPreviewRouter } from "../routes/preview.js";
import { buildPreviewTargetUrl } from "../services/preview-proxy.js";
import { setDeploymentMode } from "../config/deployment-mode.js";

function startLocalServer(
  handler: http.RequestListener,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("missing address");
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function makeDbWithRuntimeService(row: Record<string, unknown> | null) {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => (row ? [row] : []),
  };
  return {
    select: () => chain,
  };
}

function makeApp(row: Record<string, unknown> | null, actor: Record<string, unknown> = {
  type: "board",
  source: "local_implicit",
}) {
  const app = express();
  app.use((req, _res, next) => {
    req.actor = actor as any;
    next();
  });
  app.use("/preview", createPreviewRouter(makeDbWithRuntimeService(row) as any));
  app.use(errorHandler);
  return app;
}

function makeRuntimeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "svc-1",
    companyId: "company-1",
    executionWorkspaceId: "workspace-1",
    status: "running",
    healthStatus: "healthy",
    url: "http://127.0.0.1:5173",
    ...overrides,
  };
}

describe("preview proxy route", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((close) => close()));
    setDeploymentMode("local_trusted");
  });

  it("proxies registered healthy loopback runtime services and strips AoA credentials", async () => {
    const upstream = await startLocalServer((req, res) => {
      expect(req.headers.cookie).toBeUndefined();
      expect(req.headers.authorization).toBeUndefined();
      expect(req.headers["x-aoa-auth"]).toBeUndefined();
      expect(req.headers["x-openclaw-auth"]).toBeUndefined();
      expect(req.headers["x-aoa-preview"]).toBe("1");
      res.setHeader("content-type", "text/html");
      res.end(`<h1>${req.url}</h1>`);
    });
    cleanup.push(upstream.close);

    const app = makeApp(makeRuntimeRow({ url: upstream.url }));

    const res = await request(app)
      .get("/preview/services/svc-1/hello?x=1")
      .set("Cookie", "aoa_session=secret")
      .set("Authorization", "Bearer secret")
      .set("x-aoa-auth", "secret")
      .set("x-openclaw-auth", "secret");

    expect(res.status).toBe(200);
    expect(res.text).toContain("/hello?x=1");
  });

  it("proxies healthy project-scoped runtime services", async () => {
    const upstream = await startLocalServer((_req, res) => {
      res.setHeader("content-type", "text/plain");
      res.end("project preview");
    });
    cleanup.push(upstream.close);

    const app = makeApp(makeRuntimeRow({
      executionWorkspaceId: null,
      projectWorkspaceId: "project-workspace-1",
      scopeType: "project_workspace",
      url: upstream.url,
    }));

    const res = await request(app).get("/preview/services/svc-1/");

    expect(res.status).toBe(200);
    expect(res.text).toBe("project preview");
  });

  it("strips upstream cookies and applies a sandbox policy to proxied responses", async () => {
    const upstream = await startLocalServer((_req, res) => {
      res.setHeader("Set-Cookie", [
        "aoa_session=evil; Path=/; HttpOnly",
        "preview_state=dirty; Path=/",
      ]);
      res.setHeader("Content-Security-Policy", "default-src *");
      res.setHeader("content-type", "text/html");
      res.end("<script>window.previewLoaded = true</script>");
    });
    cleanup.push(upstream.close);

    const app = makeApp(makeRuntimeRow({ url: upstream.url }));

    const res = await request(app).get("/preview/services/svc-1/");

    expect(res.status).toBe(200);
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(res.headers["content-security-policy"]).toContain("sandbox");
    expect(res.headers["content-security-policy"]).not.toContain("allow-same-origin");
  });

  it("streams non-json POST bodies without express.json consuming them", async () => {
    const upstream = await startLocalServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        res.setHeader("content-type", "text/plain");
        res.end(Buffer.concat(chunks).toString("utf8"));
      });
    });
    cleanup.push(upstream.close);

    const app = makeApp(makeRuntimeRow({ url: upstream.url }));
    app.use(express.json());

    const res = await request(app)
      .post("/preview/services/svc-1/submit")
      .set("content-type", "text/plain")
      .send("raw=not-json");

    expect(res.status).toBe(200);
    expect(res.text).toBe("raw=not-json");
  });

  it("rejects unregistered runtime services", async () => {
    const res = await request(makeApp(null)).get("/preview/services/missing/");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Preview service not found");
  });

  it("rejects unhealthy or stopped runtime services", async () => {
    const res = await request(makeApp(makeRuntimeRow({
      status: "stopped",
      healthStatus: "unhealthy",
    }))).get("/preview/services/svc-1/");

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Preview service is not available");
  });

  it("rejects foreign-owner local runtime services before proxying loopback", async () => {
    const res = await request(makeApp(makeRuntimeRow({
      provider: "local_process",
      processOwnerId: "foreign-owner",
    }))).get("/preview/services/svc-1/");

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/another runtime host/);
  });

  it("rejects adapter-managed loopback previews in cloud without contacting the control plane", async () => {
    setDeploymentMode("cloud_auth");
    const res = await request(makeApp(makeRuntimeRow({
      provider: "adapter_managed",
      url: "http://127.0.0.1:65534/private-control-plane",
    }))).get("/preview/services/svc-1/");

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/another runtime host/);
  });

  it("rejects runtime services with unsafe upstream targets", async () => {
    const res = await request(makeApp(makeRuntimeRow({
      url: "http://169.254.169.254/latest/meta-data",
    }))).get("/preview/services/svc-1/");

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("Preview target is not allowed");
  });

  it("enforces company access before proxying", async () => {
    const res = await request(makeApp(
      makeRuntimeRow({ companyId: "company-1" }),
      { type: "agent", agentId: "agent-1", companyId: "company-2" },
    )).get("/preview/services/svc-1/");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Agent key cannot access another company");
  });

  it("checks company access before revealing foreign runtime ownership", async () => {
    const res = await request(makeApp(
      makeRuntimeRow({
        companyId: "company-1",
        provider: "local_process",
        processOwnerId: "foreign-owner",
      }),
      { type: "agent", agentId: "agent-1", companyId: "company-2" },
    )).get("/preview/services/svc-1/");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Agent key cannot access another company");
  });
});

describe("buildPreviewTargetUrl", () => {
  it("preserves app-owned token query parameters when forwarding preview traffic upstream", () => {
    expect(buildPreviewTargetUrl({
      serviceUrl: "http://127.0.0.1:5173/",
      serviceId: "svc-1",
      originalUrl: "/preview/services/svc-1/ws?token=secret&keep=1",
    })).toBe("http://127.0.0.1:5173/ws?token=secret&keep=1");
  });

  it("strips AoA-owned query auth before forwarding preview traffic upstream", () => {
    expect(buildPreviewTargetUrl({
      serviceUrl: "http://127.0.0.1:5173/",
      serviceId: "svc-1",
      originalUrl: "/preview/services/svc-1/ws?aoa_preview_token=secret&keep=1",
    })).toBe("http://127.0.0.1:5173/ws?keep=1");
  });
});
