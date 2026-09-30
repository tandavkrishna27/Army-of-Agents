import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { privateHostnameGuard } from "../middleware/private-hostname-guard.js";
import { MarketplaceReconcileErrorResponseSchema } from "@armyofagents/shared";

function createApp(opts: { enabled: boolean; allowedHostnames?: string[]; bindHost?: string }) {
  const app = express();
  app.use(
    privateHostnameGuard({
      enabled: opts.enabled,
      allowedHostnames: opts.allowedHostnames ?? [],
      bindHost: opts.bindHost ?? "0.0.0.0",
    }),
  );
  app.get("/api/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });
  app.get("/dashboard", (_req, res) => {
    res.status(200).send("ok");
  });
  return app;
}

describe("privateHostnameGuard", () => {
  it("allows requests when disabled", async () => {
    const app = createApp({ enabled: false });
    const res = await request(app).get("/api/health").set("Host", "dotta-macbook-pro:3100");
    expect(res.status).toBe(200);
  });

  it("allows loopback hostnames", async () => {
    const app = createApp({ enabled: true });
    const res = await request(app).get("/api/health").set("Host", "localhost:3100");
    expect(res.status).toBe(200);
  });

  it("allows explicitly configured hostnames", async () => {
    const app = createApp({ enabled: true, allowedHostnames: ["dotta-macbook-pro"] });
    const res = await request(app).get("/api/health").set("Host", "dotta-macbook-pro:3100");
    expect(res.status).toBe(200);
  });

  it("blocks unknown hostnames with remediation command", async () => {
    const app = createApp({ enabled: true, allowedHostnames: ["some-other-host"] });
    const res = await request(app).get("/api/health").set("Host", "dotta-macbook-pro:3100");
    expect(res.status).toBe(403);
    expect(res.body?.error).toContain("please run pnpm aoa allowed-hostname dotta-macbook-pro");
  });

  it("blocks unknown hostnames on page routes with plain-text remediation command", async () => {
    const app = createApp({ enabled: true, allowedHostnames: ["some-other-host"] });
    const res = await request(app).get("/dashboard").set("Host", "dotta-macbook-pro:3100");
    expect(res.status).toBe(403);
    expect(res.text).toContain("please run pnpm aoa allowed-hostname dotta-macbook-pro");
  });

  it("uses the strict marketplace error envelope before the admin router", async () => {
    const app = createApp({ enabled: true, allowedHostnames: ["some-other-host"] });
    const res = await request(app)
      .post("/api/admin/marketplace/reconcile")
      .set("Host", "dotta-macbook-pro:3100")
      .send({});

    expect(res.status).toBe(403);
    expect(() =>
      MarketplaceReconcileErrorResponseSchema.parse(res.body),
    ).not.toThrow();
    expect(res.body).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
      operationId: null,
    });
  });
});
