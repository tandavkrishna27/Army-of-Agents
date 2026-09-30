import type { Db } from "@armyofagents/db";
import { runAoaDispatch } from "../aoa-agents/dispatcher.js";

export interface SweepOptions {
  /** Max simultaneous extractions per sweep tick. */
  limiterMax: number;
  /** A 'processing' entry whose LINKED run has been 'running' (non-terminal)
   *  longer than this is treated as orphaned (crash between the M2 atomic
   *  claim and a terminal status). Must be conservatively larger than the
   *  longest legitimate extraction so healthy in-flight is never reset. */
  staleMs: number;
}

/**
 * @deprecated Superseded by `runAoaDispatch` (Decision #100 / spec §11): the
 * extraction pipeline is now one specialization of the generalized AoA
 * dispatcher (outbox-gated, `kind='aoa'` extraction agent; the old
 * `kind='platform'` agent was migrated/retired). This shim preserves the
 * `server/src/index.ts` call site (`runExtractionSweep` on the setInterval
 * worker) so the wiring is untouched while behaviour evolves in
 * `aoa-agents/dispatcher.ts`. New code must call `runAoaDispatch` directly.
 */
export async function runExtractionSweep(db: Db, opts: SweepOptions): Promise<void> {
  await runAoaDispatch(db, opts);
}
