import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { describe, expect, it } from "vitest";
import { handlePreviewProxyUpgrade } from "../services/preview-proxy.js";

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

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo | null;
      if (!address) throw new Error("missing address");
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function onceOpen(client: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    client.once("open", () => resolve());
    client.once("error", reject);
  });
}

function onceUpgradeHeaders(client: WebSocket): Promise<Record<string, string | string[] | undefined>> {
  return new Promise((resolve, reject) => {
    client.once("upgrade", (res) => resolve(res.headers));
    client.once("error", reject);
  });
}

function onceClose(client: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    client.on("error", () => {});
    client.once("close", (code) => resolve(code));
  });
}

function nextMessage(client: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    client.once("message", (message) => resolve(message.toString()));
    client.once("error", reject);
  });
}

describe("preview websocket proxy", () => {
  it("proxies websocket upgrades for registered preview services", async () => {
    const upstreamServer = createServer();
    const upstreamWs = new WebSocketServer({ server: upstreamServer });
    upstreamWs.on("connection", (socket) => {
      socket.on("message", (message) => socket.send(`echo:${message.toString()}`));
    });
    const upstreamUrl = await listen(upstreamServer);

    const db = makeDbWithRuntimeService(makeRuntimeRow({ url: upstreamUrl })) as any;
    const app = express();
    const aoaServer = createServer(app);
    aoaServer.on("upgrade", (req, socket, head) => {
      void handlePreviewProxyUpgrade(db, req, socket, head, {
        deploymentMode: "local_trusted",
      });
    });
    const aoaUrl = await listen(aoaServer);

    const client = new WebSocket(`${aoaUrl.replace("http://", "ws://")}/preview/services/svc-1/ws`);
    try {
      await onceOpen(client);
      client.send("hi");
      await expect(nextMessage(client)).resolves.toBe("echo:hi");
    } finally {
      client.close();
      upstreamWs.close();
      await closeServer(aoaServer);
      await closeServer(upstreamServer);
    }
  });

  it("strips upstream Set-Cookie headers from websocket upgrade responses", async () => {
    const upstreamServer = createServer();
    const upstreamWs = new WebSocketServer({ server: upstreamServer });
    upstreamWs.on("headers", (headers) => {
      headers.push("Set-Cookie: aoa_session=evil; Path=/; HttpOnly");
    });
    upstreamWs.on("connection", (socket) => {
      socket.send("ready");
    });
    const upstreamUrl = await listen(upstreamServer);

    const db = makeDbWithRuntimeService(makeRuntimeRow({ url: upstreamUrl })) as any;
    const aoaServer = createServer();
    aoaServer.on("upgrade", (req, socket, head) => {
      void handlePreviewProxyUpgrade(db, req, socket, head, {
        deploymentMode: "local_trusted",
      });
    });
    const aoaUrl = await listen(aoaServer);

    const client = new WebSocket(`${aoaUrl.replace("http://", "ws://")}/preview/services/svc-1/ws`);
    try {
      const upgradeHeaders = onceUpgradeHeaders(client);
      const opened = onceOpen(client);
      const headers = await upgradeHeaders;
      await opened;
      expect(headers["set-cookie"]).toBeUndefined();
    } finally {
      client.close();
      upstreamWs.close();
      await closeServer(aoaServer);
      await closeServer(upstreamServer);
    }
  });

  it("rejects unauthenticated preview websocket upgrades in authenticated mode", async () => {
    const db = makeDbWithRuntimeService(makeRuntimeRow()) as any;
    const aoaServer = createServer();
    aoaServer.on("upgrade", (req, socket, head) => {
      void handlePreviewProxyUpgrade(db, req, socket, head, {
        deploymentMode: "authenticated",
        resolveSessionFromHeaders: async () => null,
      });
    });
    const aoaUrl = await listen(aoaServer);
    const client = new WebSocket(`${aoaUrl.replace("http://", "ws://")}/preview/services/svc-1/ws`);

    try {
      await expect(onceClose(client)).resolves.toBeDefined();
    } finally {
      await closeServer(aoaServer);
    }
  });
});
