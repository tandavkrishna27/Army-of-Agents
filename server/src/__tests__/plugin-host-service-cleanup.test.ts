import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createPluginHostServiceCleanup } from "../services/plugin-host-service-cleanup.js";

describe("plugin host-service lifecycle cleanup", () => {
  it("releases resources on replace, crash, stop, and uninstall", () => {
    const lifecycle = new EventEmitter();
    const disposers = new Map<string, () => void>();
    const cleanup = createPluginHostServiceCleanup(lifecycle, disposers);
    const first = vi.fn();
    const replacement = vi.fn();

    cleanup.replace("plugin-a", first);
    cleanup.replace("plugin-a", replacement);
    expect(first).toHaveBeenCalledOnce();

    cleanup.handleWorkerEvent({
      type: "plugin.worker.crashed",
      pluginId: "plugin-a",
    });
    expect(replacement).toHaveBeenCalledTimes(1);

    // A restarted worker reuses the same handlers. Cleanup happens on the
    // crash boundary; the ready notification must not dispose them again.
    cleanup.handleWorkerEvent({
      type: "plugin.worker.restarted",
      pluginId: "plugin-a",
    });
    expect(replacement).toHaveBeenCalledTimes(1);

    lifecycle.emit("plugin.worker_stopped", {
      pluginId: "plugin-a",
      pluginKey: "acme.a",
    });
    expect(replacement).toHaveBeenCalledTimes(2);

    lifecycle.emit("plugin.unloaded", {
      pluginId: "plugin-a",
      pluginKey: "acme.a",
      removeData: false,
    });
    expect(replacement).toHaveBeenCalledTimes(3);
    expect(disposers.has("plugin-a")).toBe(false);
  });

  it("releases every remaining plugin during shutdown and detaches listeners", () => {
    const lifecycle = new EventEmitter();
    const first = vi.fn();
    const second = vi.fn();
    const disposers = new Map<string, () => void>([
      ["plugin-a", first],
      ["plugin-b", second],
    ]);
    const cleanup = createPluginHostServiceCleanup(lifecycle, disposers);

    cleanup.disposeAll();
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(disposers.size).toBe(0);

    cleanup.replace("plugin-a", first);
    cleanup.teardown();
    lifecycle.emit("plugin.worker_stopped", {
      pluginId: "plugin-a",
      pluginKey: "acme.a",
    });
    expect(first).toHaveBeenCalledOnce();
  });
});
