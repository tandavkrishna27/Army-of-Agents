import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mock state (vi.mock factories are hoisted before imports) ─────────

const { mockSaveSnapshot, mockGetById, mockUpdateStatus } = vi.hoisted(() => {
  const basePlugin = {
    id: "plugin-1",
    pluginKey: "test.plugin",
    companyId: "co-a",
    status: "ready" as const,
    version: "1.0.0",
    packageName: "@test/plugin",
    manifestJson: { capabilities: ["tools.register"] },
    installOrder: 1,
    apiVersion: "1.0",
    categories: [],
    lastError: null,
    statusReasonCode: null,
    installedAt: new Date(),
    updatedAt: new Date(),
    catalogItemId: null,
    packagePath: null,
  };
  const mockSaveSnapshot = vi.fn().mockResolvedValue(undefined);
  const mockGetById = vi.fn().mockResolvedValue(basePlugin);
  const mockUpdateStatus = vi
    .fn()
    .mockImplementation(
      async (_id: string, { status }: { status: string }) => ({
        ...basePlugin,
        status,
      })
    );
  return { mockSaveSnapshot, mockGetById, mockUpdateStatus };
});

vi.mock("@armyofagents/db", () => ({
  plugins: new Proxy({}, { get: () => Symbol("col") }),
  pluginVersionSnapshots: new Proxy({}, { get: () => Symbol("col") }),
}));
vi.mock("drizzle-orm", () => ({
  eq: () => Symbol("eq"),
  and: () => Symbol("and"),
  asc: () => Symbol("asc"),
}));
vi.mock("../services/plugin-rollback.js", () => ({
  pluginRollbackService: () => ({ saveSnapshot: mockSaveSnapshot }),
}));
vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => ({
    getById: mockGetById,
    updateStatus: mockUpdateStatus,
  }),
}));
vi.mock("../services/plugin-loader.js", () => ({ pluginLoader: vi.fn() }));
vi.mock("../middleware/logger.js", () => {
  const logger = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return { logger };
});

import {
  diffCapabilities,
  pluginLifecycleManager,
} from "../services/plugin-lifecycle.js";
import { createPluginHostServiceCleanup } from "../services/plugin-host-service-cleanup.js";
import { setDeploymentMode } from "../config/deployment-mode.js";
import {
  CloudPluginExecutionBlockedError,
  PLUGIN_WORKER_BLOCKED_IN_CLOUD,
} from "../services/cloud-plugin-execution.js";

afterEach(() => setDeploymentMode("local_trusted"));

describe("cloud plugin lifecycle policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateStatus.mockImplementation(
      async (
        _id: string,
        input: {
          status: string;
          lastError?: string | null;
          statusReasonCode?: string | null;
        }
      ) => ({
        id: "plugin-1",
        pluginKey: "test.plugin",
        companyId: "co-a",
        status: input.status,
        lastError: input.lastError ?? null,
        statusReasonCode: input.statusReasonCode ?? null,
      })
    );
  });

  it("FND-006: denies load() on cloud_auth — persists the typed blocked state and throws (Decision #103)", async () => {
    setDeploymentMode("cloud_auth");
    const loadSingle = vi.fn().mockResolvedValue({ success: true });
    const lifecycle = pluginLifecycleManager({} as any, {
      loader: { hasRuntimeServices: () => true, loadSingle } as any,
    });

    // blockActivationInCloud() (called first inside load()) fails closed on
    // cloud_auth: it persists status="error" + PLUGIN_WORKER_BLOCKED_IN_CLOUD
    // and throws CloudPluginExecutionBlockedError before any ready-transition
    // or worker activation.
    await expect(lifecycle.load("plugin-1")).rejects.toBeInstanceOf(
      CloudPluginExecutionBlockedError
    );

    expect(mockUpdateStatus).toHaveBeenCalledWith(
      "plugin-1",
      expect.objectContaining({ statusReasonCode: PLUGIN_WORKER_BLOCKED_IN_CLOUD })
    );
    expect(loadSingle).not.toHaveBeenCalled();
  });

  it("fails closed when persisting the blocked-state write fails on cloud_auth (no activation)", async () => {
    setDeploymentMode("cloud_auth");
    mockUpdateStatus.mockRejectedValueOnce(new Error("database unavailable"));
    const loadSingle = vi.fn();
    const lifecycle = pluginLifecycleManager({} as any, {
      loader: { hasRuntimeServices: () => true, loadSingle } as any,
    });

    // On cloud_auth the first updateStatus inside load() is
    // blockActivationInCloud()'s blocked-state persist. If that write fails, the
    // exception still fails load() closed before any worker activation.
    await expect(lifecycle.load("plugin-1")).rejects.toThrow(
      "database unavailable"
    );
    expect(loadSingle).not.toHaveBeenCalled();
  });
});

// ── diffCapabilities (pure function, no DB) ───────────────────────────────────

describe("plugin lifecycle upgrade helpers", () => {
  it("detects no new capabilities when sets are equal", () => {
    const delta = diffCapabilities(
      ["tools.register", "http.outbound"],
      ["tools.register", "http.outbound"]
    );
    expect(delta).toEqual([]);
  });

  it("detects newly added capabilities", () => {
    const delta = diffCapabilities(
      ["tools.register", "http.outbound"],
      ["tools.register", "http.outbound", "jobs.create"]
    );
    expect(delta).toEqual(["jobs.create"]);
  });

  it("does not flag removed capabilities (backward compat is OK)", () => {
    const delta = diffCapabilities(
      ["tools.register", "http.outbound"],
      ["tools.register"]
    );
    expect(delta).toEqual([]);
  });
});

// ── upgrade() state machine ───────────────────────────────────────────────────

describe("upgrade() state machine", () => {
  beforeEach(() => vi.clearAllMocks());

  it("calls pluginRollbackService.saveSnapshot with plugin fields (not raw db.insert)", async () => {
    const mockLoader = {
      upgradePlugin: vi.fn().mockResolvedValue({
        oldManifest: { version: "1.0.0", capabilities: ["tools.register"] },
        newManifest: { version: "2.0.0", capabilities: ["tools.register"] },
        discovered: { version: "2.0.0" },
      }),
    };
    const lifecycle = pluginLifecycleManager({} as any, {
      loader: mockLoader as any,
    });
    await lifecycle.upgrade("plugin-1");

    expect(mockSaveSnapshot).toHaveBeenCalledOnce();
    expect(mockSaveSnapshot).toHaveBeenCalledWith(
      "plugin-1",
      "co-a",
      "1.0.0",
      "@test/plugin",
      { capabilities: ["tools.register"] }
    );
  });

  it("returns { version, status: 'ready' } when no new capabilities are added", async () => {
    const mockLoader = {
      upgradePlugin: vi.fn().mockResolvedValue({
        oldManifest: { version: "1.0.0", capabilities: ["tools.register"] },
        newManifest: { version: "2.0.0", capabilities: ["tools.register"] },
        discovered: { version: "2.0.0" },
      }),
    };
    const lifecycle = pluginLifecycleManager({} as any, {
      loader: mockLoader as any,
    });
    const result = await lifecycle.upgrade("plugin-1");
    expect(result).toEqual({ version: "2.0.0", status: "ready" });
  });

  it("returns { version, status: 'upgrade_pending', delta } when new capabilities are added", async () => {
    const mockLoader = {
      upgradePlugin: vi.fn().mockResolvedValue({
        oldManifest: { version: "1.0.0", capabilities: ["tools.register"] },
        newManifest: {
          version: "2.0.0",
          capabilities: ["tools.register", "jobs.create"],
        },
        discovered: { version: "2.0.0" },
      }),
    };
    const lifecycle = pluginLifecycleManager({} as any, {
      loader: mockLoader as any,
    });
    const result = await lifecycle.upgrade("plugin-1");
    expect(result).toEqual({
      version: "2.0.0",
      status: "upgrade_pending",
      delta: ["jobs.create"],
    });
  });
});

describe("runtime loader binding", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses the bound runtime loader for activation and deactivation", async () => {
    const runtimeLoader = {
      hasRuntimeServices: vi.fn(() => true),
      loadSingle: vi.fn().mockResolvedValue({
        success: true,
        plugin: await mockGetById("plugin-1"),
      }),
      unloadSingle: vi.fn().mockResolvedValue(undefined),
    };
    const lifecycle = pluginLifecycleManager({} as any, {
      loader: {} as any,
    });
    lifecycle.bindLoader(runtimeLoader as any);

    await lifecycle.load("plugin-1");
    expect(runtimeLoader.loadSingle).toHaveBeenCalledWith("plugin-1");

    await lifecycle.disable("plugin-1", "test");
    expect(runtimeLoader.unloadSingle).toHaveBeenCalledWith(
      "plugin-1",
      "test.plugin"
    );
  });

  it("does not transition or activate an explicitly disabled upgrade", async () => {
    mockGetById.mockResolvedValueOnce({
      ...(await mockGetById("plugin-1")),
      status: "upgrade_pending",
    });
    const runtimeLoader = {
      isCompanyEnabled: vi.fn().mockResolvedValue(false),
      hasRuntimeServices: vi.fn(() => true),
      loadSingle: vi.fn(),
      unloadSingle: vi.fn(),
    };
    const lifecycle = pluginLifecycleManager({} as any, {
      loader: runtimeLoader as any,
    });

    await expect(lifecycle.enable("plugin-1")).rejects.toThrow(/disabled/);
    expect(mockUpdateStatus).not.toHaveBeenCalled();
    expect(runtimeLoader.loadSingle).not.toHaveBeenCalled();
  });
});

describe("worker restart cleanup ordering", () => {
  beforeEach(() => vi.clearAllMocks());

  it("disposes the stopped generation before replacement setup, not after it", async () => {
    const order: string[] = [];
    let activeSubscriptions = 1;
    const handle = {
      stop: vi.fn(async () => {
        order.push("stop");
      }),
      start: vi.fn(async () => {
        order.push("start/setup");
        activeSubscriptions = 1;
      }),
    };
    const workerManager = {
      getWorker: vi.fn(() => handle),
    };
    const lifecycle = pluginLifecycleManager({} as any, {
      workerManager: workerManager as any,
    });
    const cleanup = createPluginHostServiceCleanup(lifecycle, new Map());
    cleanup.replace("plugin-1", () => {
      order.push("dispose");
      activeSubscriptions = 0;
    });
    lifecycle.on("plugin.worker_started", () => order.push("started"));

    await lifecycle.restartWorker("plugin-1");

    expect(order).toEqual(["stop", "dispose", "start/setup", "started"]);
    expect(activeSubscriptions).toBe(1);
    expect(handle.stop).toHaveBeenCalledOnce();
    expect(handle.start).toHaveBeenCalledOnce();
    cleanup.teardown();
  });
});
