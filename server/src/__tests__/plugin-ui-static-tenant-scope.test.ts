import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import supertest from "supertest";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const registry = vi.hoisted(() => ({
  getById: vi.fn(),
  getConfig: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => registry,
}));

import { errorHandler } from "../middleware/error-handler.js";
import { pluginUiStaticRoutes } from "../routes/plugin-ui-static.js";
import { setDeploymentMode } from "../config/deployment-mode.js";
import {
  CLOUD_PLUGIN_BLOCK_MESSAGE,
  CLOUD_PLUGIN_EXECUTION_DOC_PATH,
  PLUGIN_WORKER_BLOCKED_IN_CLOUD,
  cloudPluginExecutionBlockedEnvelope,
} from "../services/cloud-plugin-execution.js";

const PLUGIN_ID = "11111111-1111-4111-8111-111111111111";
const COMPANY_A = "company-a";
const COMPANY_B = "company-b";
let packageDir: string;

function actor(companyIds: string[]) {
  return {
    type: "board",
    source: "session",
    userId: "user-a",
    companyIds,
    organizationIds: [],
    isInstanceAdmin: false,
  };
}

function settingsDb(rows: Array<{ enabled: boolean }> = []) {
  return {
    select: () => ({
      from: () => ({ where: () => Promise.resolve(rows) }),
    }),
  } as any;
}

function appFor(requestActor: object) {
  const app = express();
  app.use((req, _res, next) => {
    (req as any).actor = requestActor;
    next();
  });
  app.use(
    "/_plugins",
    pluginUiStaticRoutes(settingsDb(), { localPluginDir: packageDir })
  );
  app.use(errorHandler);
  return supertest(app);
}

function readyPlugin(companyId: string) {
  return {
    id: PLUGIN_ID,
    companyId,
    pluginKey: "acme.shared",
    packageName: "@acme/shared",
    packagePath: packageDir,
    status: "ready",
    manifestJson: { entrypoints: { ui: "./dist/ui" } },
  };
}

beforeAll(() => {
  packageDir = fs.mkdtempSync(path.join(os.tmpdir(), "aoa-plugin-ui-"));
  fs.mkdirSync(path.join(packageDir, "dist", "ui"), { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, "dist", "ui", "index.js"),
    "export const ok = true;\n"
  );
});

afterAll(() => {
  fs.rmSync(packageDir, { recursive: true, force: true });
});

beforeEach(() => {
  setDeploymentMode("local_trusted");
  registry.getById.mockReset();
  registry.getConfig.mockReset();
  registry.getConfig.mockResolvedValue(null);
});

  // RW5a (Wave 5 review — fixes the U10-a regression this test used to
  // pin): `plugin-ui-static.ts:271`'s `isCloudPluginExecutionBlocked()` call
  // now passes the "ui-static" sink explicitly, and that sink is
  // unconditionally blocked on cloud regardless of the worker-fork sink U10
  // is about — the route's own comment says "Same-origin plugin JavaScript
  // is executable tenant code," a browser-trust boundary the host-resident
  // worker model does not address. See `cloud-plugin-execution.ts`'s
  // `PluginCloudExecutionSink` doc comment for the full sink taxonomy.
describe("tenant-scoped plugin UI assets", () => {
  it("RW5a: short-circuits with the cloud-blocked envelope before any registry/tenant access", async () => {
    setDeploymentMode("cloud_auth");
    registry.getById.mockResolvedValue(readyPlugin(COMPANY_A));
    const response = await appFor(actor([COMPANY_A])).get(
      `/_plugins/${PLUGIN_ID}/ui/index.js`
    );

    // The "ui-static" sink stays blocked on cloud — the request never
    // reaches the registry lookup / tenant-access check.
    expect(response.status).toBe(503);
    expect(response.body).toEqual(cloudPluginExecutionBlockedEnvelope());
    expect(registry.getById).not.toHaveBeenCalled();
  });

  it("FND-008: the ui-static 503 carries the exact Decision #103 error/code/docs envelope", async () => {
    setDeploymentMode("cloud_auth");
    registry.getById.mockResolvedValue(readyPlugin(COMPANY_A));
    const response = await appFor(actor([COMPANY_A])).get(
      `/_plugins/${PLUGIN_ID}/ui/index.js`
    );

    // The browser-code (ui-static) surface is one of the registered plugin HTTP
    // surfaces FND-008 keeps returning the stable 503 denial contract, not a 404.
    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: CLOUD_PLUGIN_BLOCK_MESSAGE,
      code: PLUGIN_WORKER_BLOCKED_IN_CLOUD,
      docs: CLOUD_PLUGIN_EXECUTION_DOC_PATH,
    });
    expect(CLOUD_PLUGIN_EXECUTION_DOC_PATH).toBe(
      "/docs/guides/cloud-plugin-execution"
    );
    expect(registry.getById).not.toHaveBeenCalled();
  });

  it("RW5a: does not block the same request off-cloud", async () => {
    setDeploymentMode("local_trusted");
    registry.getById.mockResolvedValue(readyPlugin(COMPANY_A));
    const response = await appFor(actor([COMPANY_A])).get(
      `/_plugins/${PLUGIN_ID}/ui/index.js`
    );

    expect(response.status).not.toBe(503);
    expect(registry.getById).toHaveBeenCalled();
  });

  it("rejects unauthenticated requests before registry access", async () => {
    await appFor({ type: "none" })
      .get(`/_plugins/${PLUGIN_ID}/ui/index.js`)
      .expect(401);
    expect(registry.getById).not.toHaveBeenCalled();
  });

  it("rejects non-UUID plugin keys before registry access", async () => {
    await appFor(actor([COMPANY_A]))
      .get("/_plugins/acme.shared/ui/index.js")
      .expect(404);
    expect(registry.getById).not.toHaveBeenCalled();
  });

  it("rejects a foreign plugin before config or filesystem serving", async () => {
    registry.getById.mockResolvedValue(readyPlugin(COMPANY_B));
    await appFor(actor([COMPANY_A]))
      .get(`/_plugins/${PLUGIN_ID}/ui/index.js`)
      .expect(403);
    expect(registry.getConfig).not.toHaveBeenCalled();
  });

  it("serves an own-company asset privately without wildcard CORS", async () => {
    registry.getById.mockResolvedValue(readyPlugin(COMPANY_A));
    const response = await appFor(actor([COMPANY_A]))
      .get(`/_plugins/${PLUGIN_ID}/ui/index.js`)
      .expect(200);
    expect(response.text).toContain("export const ok");
    expect(response.headers["cache-control"]).toContain("private");
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("does not serve assets for an explicitly disabled company plugin", async () => {
    registry.getById.mockResolvedValue(readyPlugin(COMPANY_A));
    const app = express();
    app.use((req, _res, next) => {
      (req as any).actor = actor([COMPANY_A]);
      next();
    });
    app.use(
      "/_plugins",
      pluginUiStaticRoutes(settingsDb([{ enabled: false }]), {
        localPluginDir: packageDir,
      })
    );
    app.use(errorHandler);
    await supertest(app).get(`/_plugins/${PLUGIN_ID}/ui/index.js`).expect(404);
    expect(registry.getConfig).not.toHaveBeenCalled();
  });

  it("does not fall back to a legacy shared package when the persisted path is missing", async () => {
    const legacyRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "aoa-plugin-ui-legacy-")
    );
    try {
      const legacyUiDir = path.join(
        legacyRoot,
        "node_modules",
        "@acme",
        "shared",
        "dist",
        "ui"
      );
      fs.mkdirSync(legacyUiDir, { recursive: true });
      fs.writeFileSync(path.join(legacyUiDir, "index.js"), "legacy\n");
      registry.getById.mockResolvedValue({
        ...readyPlugin(COMPANY_A),
        packagePath: path.join(legacyRoot, "companies", COMPANY_A, "missing"),
      });

      const app = express();
      app.use((req, _res, next) => {
        (req as any).actor = actor([COMPANY_A]);
        next();
      });
      app.use(
        "/_plugins",
        pluginUiStaticRoutes(settingsDb(), { localPluginDir: legacyRoot })
      );
      app.use(errorHandler);

      await supertest(app)
        .get(`/_plugins/${PLUGIN_ID}/ui/index.js`)
        .expect(404);
    } finally {
      fs.rmSync(legacyRoot, { recursive: true, force: true });
    }
  });

  it("preserves local implicit access", async () => {
    registry.getById.mockResolvedValue(readyPlugin(COMPANY_B));
    await appFor({
      type: "board",
      source: "local_implicit",
      userId: "local",
      companyIds: [],
    })
      .get(`/_plugins/${PLUGIN_ID}/ui/index.js`)
      .expect(200);
  });
});
