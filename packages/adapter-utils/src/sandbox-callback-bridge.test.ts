import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  generateSandboxBridgeEntrypointInstallScript,
  isAllowedAoaBridgeRequest,
  startSandboxCallbackBridgeServer,
  type SandboxCallbackBridgeServer,
} from "./sandbox-callback-bridge.js";

let bridges: SandboxCallbackBridgeServer[] = [];

afterEach(async () => {
  await Promise.all(bridges.map((bridge) => bridge.close()));
  bridges = [];
});

async function startApiServer(handler: http.RequestListener): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind to a port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

describe("isAllowedAoaBridgeRequest", () => {
  it.each([
    ["GET", "/api/health"],
    ["GET", "/api/agents/me"],
    ["GET", "/api/approvals/ap_1"],
    ["GET", "/api/approvals/ap_1/issues"],
    ["GET", "/api/companies/co_1/issues"],
    ["POST", "/api/companies/co_1/issues"],
    ["GET", "/api/issues/iss_1"],
    ["GET", "/api/issues/iss_1/comments"],
    ["POST", "/api/issues/iss_1/comments"],
    ["POST", "/api/issues/iss_1/checkout"],
    ["PATCH", "/api/issues/iss_1"],
  ])("allows %s %s", (method, pathname) => {
    expect(isAllowedAoaBridgeRequest(method, pathname)).toBe(true);
  });

  it.each([
    ["GET", "/api/companies"],
    ["GET", "/api/admin/companies/co_1"],
    ["GET", "/api/companies/co_1/admin"],
    ["GET", "/api/admin"],
    ["GET", "/api/agents"],
    ["POST", "/api/issues/iss_1/checkout/again"],
    ["GET", "/not-api/health"],
  ])("rejects %s %s", (method, pathname) => {
    expect(isAllowedAoaBridgeRequest(method, pathname)).toBe(false);
  });
});

describe("startSandboxCallbackBridgeServer", () => {
  it("forwards allowed requests with bearer auth", async () => {
    const received: Array<{ authorization: string | undefined; runId: string | undefined; body: string }> = [];
    const api = await startApiServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += String(chunk);
      });
      req.on("end", () => {
        received.push({
          authorization: req.headers.authorization,
          runId: req.headers["x-aoa-run-id"] as string | undefined,
          body,
        });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true }));
      });
    });

    try {
      const bridge = await startSandboxCallbackBridgeServer({
        apiBaseUrl: api.url,
        authToken: "server-token",
        runId: "run_1",
      });
      bridges.push(bridge);

      const response = await fetch(`${bridge.listenUrl}/api/issues/iss_1/comments`, {
        method: "POST",
        headers: {
          authorization: "Bearer server-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ body: "hello" }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(received).toEqual([
        {
          authorization: "Bearer server-token",
          runId: "run_1",
          body: JSON.stringify({ body: "hello" }),
        },
      ]);
    } finally {
      await api.close();
    }
  });

  it("rejects requests without inbound bearer auth", async () => {
    const api = await startApiServer((_req, res) => res.end("ok"));
    try {
      const bridge = await startSandboxCallbackBridgeServer({
        apiBaseUrl: api.url,
        authToken: "server-token",
        runId: "run_1",
      });
      bridges.push(bridge);

      const response = await fetch(`${bridge.listenUrl}/api/agents/me`);
      expect(response.status).toBe(401);
    } finally {
      await api.close();
    }
  });

  it("rejects requests with the wrong inbound bearer auth", async () => {
    const api = await startApiServer((_req, res) => res.end("ok"));
    try {
      const bridge = await startSandboxCallbackBridgeServer({
        apiBaseUrl: api.url,
        authToken: "server-token",
        runId: "run_1",
      });
      bridges.push(bridge);

      const response = await fetch(`${bridge.listenUrl}/api/agents/me`, {
        headers: { authorization: "Bearer anything" },
      });
      expect(response.status).toBe(401);
    } finally {
      await api.close();
    }
  });

  it("rejects disallowed paths", async () => {
    const api = await startApiServer((_req, res) => res.end("ok"));
    try {
      const bridge = await startSandboxCallbackBridgeServer({
        apiBaseUrl: api.url,
        authToken: "server-token",
        runId: "run_1",
      });
      bridges.push(bridge);

      const response = await fetch(`${bridge.listenUrl}/api/admin`, {
        headers: { authorization: "Bearer server-token" },
      });
      expect(response.status).toBe(403);
    } finally {
      await api.close();
    }
  });

  it("rejects oversized bodies", async () => {
    const api = await startApiServer((_req, res) => res.end("ok"));
    try {
      const bridge = await startSandboxCallbackBridgeServer({
        apiBaseUrl: api.url,
        authToken: "server-token",
        runId: "run_1",
      });
      bridges.push(bridge);

      const response = await fetch(`${bridge.listenUrl}/api/issues/iss_1/comments`, {
        method: "POST",
        headers: { authorization: "Bearer server-token" },
        body: "x".repeat(2 * 1024 * 1024 + 1),
      });
      expect(response.status).toBe(413);
    } finally {
      await api.close();
    }
  });

  it("uses a Docker-facing host.docker.internal container URL", async () => {
    const api = await startApiServer((_req, res) => res.end("ok"));
    try {
      const bridge = await startSandboxCallbackBridgeServer({
        apiBaseUrl: api.url,
        authToken: "server-token",
        runId: "run_1",
        exposeToDocker: true,
      });
      bridges.push(bridge);

      expect(bridge.listenUrl).toContain("0.0.0.0");
      expect(bridge.containerUrl).toContain("host.docker.internal");
    } finally {
      await api.close();
    }
  });

  it("binds non-Docker bridges to loopback", async () => {
    const api = await startApiServer((_req, res) => res.end("ok"));
    try {
      const bridge = await startSandboxCallbackBridgeServer({
        apiBaseUrl: api.url,
        authToken: "server-token",
        runId: "run_1",
      });
      bridges.push(bridge);

      expect(bridge.listenUrl).toContain("127.0.0.1");
      expect(bridge.containerUrl).toContain("127.0.0.1");
    } finally {
      await api.close();
    }
  });
});

describe("generateSandboxBridgeEntrypointInstallScript", () => {
  it("includes mutex, checksum, atomic move, and cleanup trap", () => {
    const script = generateSandboxBridgeEntrypointInstallScript();
    expect(script).toContain('mkdir "$lock_dir"');
    expect(script).toContain("sha256sum");
    expect(script).toContain('mv "$tmp_file" "$target_file"');
    expect(script).toContain("trap");
  });
});
