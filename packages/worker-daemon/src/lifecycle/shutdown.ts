/**
 * Idempotent one-shot graceful shutdown (WRK-001).
 *
 * Mirrors `server/src/services/server-shutdown.ts`
 * (`createProcessShutdownHandler`): the returned handler is idempotent across
 * competing SIGINT/SIGTERM delivery (an `inFlight` guard), runs its ordered
 * steps once, and ALWAYS exits — even when a step throws. WRK-003 registers a
 * lease-stop step ahead of the drain step so leasing stops before in-flight
 * work drains.
 */

export interface ShutdownStep {
  readonly name: string;
  stop(): Promise<void> | void;
}

/** The minimal leasing lifecycle the shutdown wiring drives (implemented by the
 * WRK-003 poll loop): stop acquiring new leases, then drain in-flight work. */
export interface LeasingLifecycle {
  /** Stop leasing new work (idempotent). */
  stopLeasing(): void;
  /** Await all in-flight leases handed to the supervisor to settle. */
  drain(): Promise<void>;
}

/** The minimal renewal lifecycle the shutdown wiring drives (WRK-005 lease-renewal
 * driver): stop all renewal timers so no renew fires during drain. */
export interface RenewalLifecycle {
  /** Stop all renewal timers (idempotent). */
  stop(): void;
}

/** The minimal event-outbox lifecycle the shutdown wiring drives (WRK-006 durable
 * event outbox): stop the drain loop, attempt a final flush, then close the store. */
export interface EventOutboxLifecycle {
  /** Stop the background drain loop (idempotent). */
  stopDrain(): void;
  /** A best-effort final flush attempt (one drain pass). */
  flush(): Promise<void> | void;
  /** Close the durable store handle. */
  closeStore(): void;
}

/**
 * The ordered event-outbox shutdown steps (WRK-006): stop the drain FIRST, then a
 * final flush attempt, then close the store — mirroring the design's
 * "stop drain → final flush attempt → close store". Each is a distinct
 * {@link ShutdownStep} so a failing step never aborts the sequence (the handler
 * swallows step errors) and the order is testable independently of the entrypoint.
 */
export function createEventOutboxShutdownSteps(outbox: EventOutboxLifecycle): readonly ShutdownStep[] {
  return [
    { name: "event-outbox-stop", stop: () => outbox.stopDrain() },
    { name: "event-outbox-flush", stop: () => outbox.flush() },
    { name: "event-outbox-close", stop: () => outbox.closeStore() },
  ];
}

/**
 * The ordered lease shutdown steps: lease-stop FIRST, then — when a WRK-005
 * renewal driver is present — `renewal-stop`, then drain. Composing these ahead of
 * the health-server step guarantees the worker stops accepting new work AND stops
 * renewing existing leases before it waits for in-flight work to finish
 * (lease-stop-before-drain, with no renew firing during drain). The order is
 * encoded here so it is testable independently of the entrypoint. When no renewal
 * driver is wired the steps are exactly the WRK-003 `[lease-stop, lease-drain]`.
 */
export function createLeaseLifecycleSteps(
  lifecycle: LeasingLifecycle,
  renewal?: RenewalLifecycle,
): readonly ShutdownStep[] {
  const steps: ShutdownStep[] = [{ name: "lease-stop", stop: () => lifecycle.stopLeasing() }];
  if (renewal !== undefined) {
    steps.push({ name: "renewal-stop", stop: () => renewal.stop() });
  }
  steps.push({ name: "lease-drain", stop: () => lifecycle.drain() });
  return steps;
}

export interface ShutdownLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  error(bindings: { readonly err: unknown } | Record<string, unknown>, message: string): void;
}

export interface ShutdownOptions {
  /** Ordered stop steps: leasing → drain → health server → … (WRK-001 = health). */
  readonly steps: readonly ShutdownStep[];
  readonly logger: ShutdownLogger;
  /** Terminate the process; injected for tests. */
  exit(code: number): void;
  /** Best-effort final log flush. */
  flush?(): Promise<void> | void;
}

export type ShutdownSignal = "SIGINT" | "SIGTERM";

export function createShutdownHandler(
  opts: ShutdownOptions,
): (signal: ShutdownSignal) => Promise<void> {
  let inFlight: Promise<void> | null = null;

  return (signal: ShutdownSignal): Promise<void> => {
    if (inFlight) return inFlight;

    inFlight = (async () => {
      for (const step of opts.steps) {
        opts.logger.info({ signal, step: step.name }, `shutdown: stopping ${step.name}`);
        try {
          await step.stop();
          opts.logger.info({ step: step.name, outcome: "ok" }, `shutdown: stopped ${step.name}`);
        } catch (err) {
          // A failing step never aborts the ordered sequence or blocks exit.
          opts.logger.error(
            { step: step.name, outcome: "error", err },
            `shutdown: ${step.name} failed`,
          );
        }
      }
      if (opts.flush) {
        try {
          await opts.flush();
        } catch {
          // Best-effort final flush; never block exit.
        }
      }
      opts.exit(0);
    })();

    return inFlight;
  };
}
