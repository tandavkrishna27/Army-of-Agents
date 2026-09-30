/**
 * One-shot startup step runner (WRK-007).
 *
 * The mirror image of `createShutdownHandler`'s ordered-step model, but for the BOOT
 * side: `createStartupSteps` composes zero-or-one startup steps from an OPTIONAL
 * reconciler seam, and `runStartupSteps` runs them ONCE in order between the health
 * server opening and signal registration. A missing reconciler degrades to `[]`
 * (exactly how the WRK-005 `renewal?` / WRK-006 `eventOutbox?` shutdown seams degrade)
 * so the default composition runs NOTHING — inert until E4-D12 live wiring; rollback
 * = omit the reconciler. A throwing step is swallowed + logged; it never aborts boot.
 *
 * The precedent shape is `EventOutboxDrain.recover()` — a one-shot boot pass, not a
 * loop. This module starts no loop and dispatches no work.
 */

/** The minimal startup lifecycle the bootstrap drives. The concrete WRK-007
 * `StartupReconciler` (`supervisor/startup-reconcile.ts`) satisfies it — `run()`
 * returning a `StartupReconcileResult` is assignable to `Promise<unknown>`. */
export interface StartupReconciler {
  /** Run the one-shot startup reconciliation pass (idempotent + convergent). */
  run(): Promise<unknown> | void;
}

export interface StartupStep {
  readonly name: string;
  run(): Promise<void> | void;
}

/** Compose the ordered startup steps. When no reconciler is wired the list is empty
 * (nothing runs) — the inert default. */
export function createStartupSteps(reconciler?: StartupReconciler): readonly StartupStep[] {
  if (reconciler === undefined) return [];
  // Return the reconciler's promise (do NOT `void` it) so `runStartupSteps` AWAITS the
  // pass in order and its try/catch actually catches a rejection — a fire-and-forget
  // `void reconciler.run()` would (1) let boot proceed to signal registration before the
  // pass finishes (breaking the reconcile-before-continue ordering) and (2) orphan any
  // rejection into an unhandledRejection (process termination).
  return [{ name: "startup-reconcile", run: async () => void (await reconciler.run()) }];
}

export interface StartupLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  error(bindings: { readonly err: unknown } | Record<string, unknown>, message: string): void;
}

/**
 * Run every startup step ONCE, in order. A step that throws is caught + logged so a
 * failed startup pass never blocks the daemon from opening for business (the server
 * reaper is the authoritative orphan-safety net — WRK-007 is a best-effort fast path).
 */
export async function runStartupSteps(steps: readonly StartupStep[], logger: StartupLogger): Promise<void> {
  for (const step of steps) {
    logger.info({ step: step.name }, `startup: running ${step.name}`);
    try {
      await step.run();
      logger.info({ step: step.name, outcome: "ok" }, `startup: ${step.name} complete`);
    } catch (err) {
      logger.error({ step: step.name, outcome: "error", err }, `startup: ${step.name} failed`);
    }
  }
}
