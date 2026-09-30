import { describe, expect, it, vi } from "vitest";
import { createProcessShutdownHandler } from "../services/server-shutdown.js";

function makeLogger() {
  return {
    info: vi.fn(),
    error: vi.fn(),
  };
}

describe("process shutdown", () => {
  it("cleans up plugins and exits for external-Postgres deployments", async () => {
    const order: string[] = [];
    const shutdownAll = vi.fn(async () => {
      order.push("plugins");
    });
    const teardown = vi.fn(() => {
      order.push("host-cleanup");
    });
    const exit = vi.fn(() => {
      order.push("exit");
    });
    const shutdown = createProcessShutdownHandler({
      getPluginSubsystem: () => ({
        loader: { shutdownAll },
        hostServiceCleanup: { teardown },
      }),
      ownedEmbeddedPostgres: null,
      logger: makeLogger(),
      exit,
    });

    await Promise.all([shutdown("SIGTERM"), shutdown("SIGINT")]);

    expect(order).toEqual(["plugins", "host-cleanup", "exit"]);
    expect(shutdownAll).toHaveBeenCalledOnce();
    expect(teardown).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
  });

  it("cleans up plugins before stopping process-owned embedded Postgres", async () => {
    const order: string[] = [];
    const options = {
      getPluginSubsystem: () => ({
        loader: {
          shutdownAll: vi.fn(async () => {
            order.push("plugins");
          }),
        },
        hostServiceCleanup: {
          teardown: vi.fn(() => {
            order.push("host-cleanup");
          }),
        },
      }),
      ownedEmbeddedPostgres: {
        stop: vi.fn(async () => {
          order.push("postgres");
        }),
      },
      boundedDatabases: {
        close: vi.fn(async () => {
          order.push("bounded");
        }),
      },
      logger: makeLogger(),
      exit: vi.fn(() => {
        order.push("exit");
      }),
    };
    const shutdown = createProcessShutdownHandler(options);

    await shutdown("SIGTERM");

    expect(order).toEqual([
      "plugins",
      "host-cleanup",
      "bounded",
      "postgres",
      "exit",
    ]);
  });

  it("logs bounded database shutdown failures and continues stopping owned resources", async () => {
    const order: string[] = [];
    const logger = makeLogger();
    const boundedFailure = new Error("pool close failed");
    const options = {
      getPluginSubsystem: () => ({
        loader: {
          shutdownAll: vi.fn(async () => {
            order.push("plugins");
          }),
        },
        hostServiceCleanup: {
          teardown: vi.fn(() => {
            order.push("host-cleanup");
          }),
        },
      }),
      boundedDatabases: {
        close: vi.fn(async () => {
          order.push("bounded");
          throw boundedFailure;
        }),
      },
      ownedEmbeddedPostgres: {
        stop: vi.fn(async () => {
          order.push("postgres");
        }),
      },
      logger,
      exit: vi.fn(() => {
        order.push("exit");
      }),
    };
    const shutdown = createProcessShutdownHandler(options);

    await shutdown("SIGTERM");

    expect(order).toEqual([
      "plugins",
      "host-cleanup",
      "bounded",
      "postgres",
      "exit",
    ]);
    expect(logger.error).toHaveBeenCalledWith(
      { err: boundedFailure },
      "Bounded distributed database shutdown failed",
    );
  });
});
