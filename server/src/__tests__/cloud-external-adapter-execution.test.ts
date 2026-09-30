import express from "express";
import request from "supertest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execNpm = vi.hoisted(() => vi.fn());
vi.mock("../utils/npm-spawn.js", () => ({ execNpm }));

import { adapterRoutes } from "../routes/adapters.js";
import { errorHandler } from "../middleware/error-handler.js";
import {
  CLOUD_EXTERNAL_ADAPTER_BLOCK_CODE,
  CloudExternalAdapterExecutionBlockedError,
  assertExternalAdapterExecutionAllowed,
  loadExternalAdapterPackage,
  reloadExternalAdapter,
} from "../adapters/plugin-loader.js";
import { setDeploymentMode } from "../config/deployment-mode.js";
import { __resetAdapterPluginStoreCaches } from "../services/adapter-plugin-store.js";

function app() {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    req.actor = {
      type: "board",
      source: "session",
      userId: "operator-1",
      operator: true,
      isInstanceAdmin: false,
      companyIds: [],
    } as never;
    next();
  });
  server.use("/api", adapterRoutes());
  server.use(errorHandler);
  return server;
}

let tempRoot: string;
let originalAoaHome: string | undefined;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-cloud-adapter-"));
  originalAoaHome = process.env.AOA_HOME;
  process.env.AOA_HOME = tempRoot;
  execNpm.mockReset();
  __resetAdapterPluginStoreCaches();
  setDeploymentMode("cloud_auth");
});

afterEach(async () => {
  setDeploymentMode("local_trusted");
  __resetAdapterPluginStoreCaches();
  if (originalAoaHome === undefined) delete process.env.AOA_HOME;
  else process.env.AOA_HOME = originalAoaHome;
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("cloud external adapter execution boundary", () => {
  it.each([
    ["post", "/api/adapters/install"],
    ["post", "/api/adapters/evil/reload"],
    ["post", "/api/adapters/evil/reinstall"],
    ["delete", "/api/adapters/evil"],
    ["get", "/api/adapters/evil/ui-parser.js"],
  ] as const)(
    "returns canonical 503 for %s %s before npm",
    async (method, url) => {
      const response = await request(app())
        [method](url)
        .send({ packageName: "evil" });
      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({
        code: CLOUD_EXTERNAL_ADAPTER_BLOCK_CODE,
      });
      expect(execNpm).not.toHaveBeenCalled();
    }
  );

  it("blocks direct load/reload sinks before reading or importing package code", async () => {
    const packageDir = path.join(tempRoot, "malicious-adapter");
    const marker = path.join(tempRoot, "executed.txt");
    await fs.mkdir(packageDir, { recursive: true });
    await fs.writeFile(
      path.join(packageDir, "package.json"),
      JSON.stringify({ type: "module", main: "index.mjs" })
    );
    await fs.writeFile(
      path.join(packageDir, "index.mjs"),
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(
        marker
      )}, "executed");\nexport function createServerAdapter(){ return { type: "malicious" }; }\n`
    );

    await expect(
      loadExternalAdapterPackage("malicious-adapter", packageDir)
    ).rejects.toBeInstanceOf(CloudExternalAdapterExecutionBlockedError);
    await expect(reloadExternalAdapter("malicious")).rejects.toBeInstanceOf(
      CloudExternalAdapterExecutionBlockedError
    );
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });

    // Preserve the explicitly trusted self-hosted policy decision. The route
    // loader's existing fixture tests cover actual self-hosted imports.
    setDeploymentMode("local_trusted");
    expect(() =>
      assertExternalAdapterExecutionAllowed("test-control")
    ).not.toThrow();
  });
});
