export interface ShutdownPluginSubsystem {
  loader: {
    shutdownAll(): Promise<void>;
  };
  hostServiceCleanup?: {
    teardown(): void;
  };
}

export interface OwnedEmbeddedPostgres {
  stop(): Promise<void>;
}

export interface BoundedDatabases {
  close(): Promise<void>;
}

export interface JobControlRuntime {
  stop(): Promise<void>;
}

export interface ShutdownLogger {
  info(message: string): void;
  info(bindings: Record<string, unknown>, message: string): void;
  error(bindings: { err: unknown }, message: string): void;
}

export interface ProcessShutdownOptions {
  getPluginSubsystem(): ShutdownPluginSubsystem | undefined;
  jobControlRuntime?: JobControlRuntime | null;
  boundedDatabases?: BoundedDatabases | null;
  ownedEmbeddedPostgres?: OwnedEmbeddedPostgres | null;
  logger: ShutdownLogger;
  exit(code: number): void;
}

/**
 * Build the one-shot process shutdown path shared by external- and
 * embedded-Postgres deployments.
 *
 * The returned handler is idempotent across competing SIGINT/SIGTERM delivery.
 * Plugin workers and host-side resources always stop first; the embedded
 * database is stopped only when this process owns it; process exit happens
 * last even when one of the best-effort cleanup steps fails.
 */
export function createProcessShutdownHandler(opts: ProcessShutdownOptions) {
  let inFlight: Promise<void> | null = null;

  return (signal: "SIGINT" | "SIGTERM"): Promise<void> => {
    if (inFlight) return inFlight;

    inFlight = (async () => {
      const pluginSubsystem = opts.getPluginSubsystem();
      if (pluginSubsystem) {
        opts.logger.info("Stopping plugin subsystem");
        try {
          await pluginSubsystem.loader.shutdownAll();
        } catch (err) {
          opts.logger.error({ err }, "Plugin subsystem shutdown failed");
        } finally {
          try {
            pluginSubsystem.hostServiceCleanup?.teardown();
          } catch (err) {
            opts.logger.error(
              { err },
              "Plugin host-service cleanup teardown failed"
            );
          }
        }
      }

      if (opts.jobControlRuntime) {
        opts.logger.info("Stopping durable job-control runtime");
        try {
          await opts.jobControlRuntime.stop();
        } catch (err) {
          opts.logger.error({ err }, "Durable job-control runtime shutdown failed");
        }
      }

      if (opts.boundedDatabases) {
        opts.logger.info("Stopping bounded distributed database pools");
        try {
          await opts.boundedDatabases.close();
        } catch (err) {
          opts.logger.error(
            { err },
            "Bounded distributed database shutdown failed",
          );
        }
      }

      if (opts.ownedEmbeddedPostgres) {
        opts.logger.info({ signal }, "Stopping embedded PostgreSQL");
        try {
          await opts.ownedEmbeddedPostgres.stop();
        } catch (err) {
          opts.logger.error(
            { err },
            "Failed to stop embedded PostgreSQL cleanly"
          );
        }
      }

      opts.exit(0);
    })();

    return inFlight;
  };
}
