import { EventEmitter } from "node:events";
import { logger } from "../middleware/logger.js";

export type BudgetEnforcementScope = {
  companyId: string;
  scopeType: "company" | "agent";
  scopeId: string;
};

export type BudgetExhaustedListener = (
  scope: BudgetEnforcementScope,
) => void | Promise<void>;

const emitter = new EventEmitter();
// Internal runtime guard: budget breaches on very large fleets could emit
// hundreds of signals; raise the default Node cap so we don't log warnings.
emitter.setMaxListeners(50);

const EVENT = "budget.exhausted";

export function onBudgetExhausted(listener: BudgetExhaustedListener): () => void {
  const wrapped = (scope: BudgetEnforcementScope) => {
    try {
      const result = listener(scope);
      if (result && typeof (result as Promise<unknown>).catch === "function") {
        (result as Promise<unknown>).catch((err) => {
          logger.error({ err, scope }, "budget.exhausted async listener failed");
        });
      }
    } catch (err) {
      logger.error({ err, scope }, "budget.exhausted listener threw");
    }
  };
  emitter.on(EVENT, wrapped);
  return () => {
    emitter.off(EVENT, wrapped);
  };
}

export function emitBudgetExhausted(scope: BudgetEnforcementScope): void {
  emitter.emit(EVENT, scope);
}

export function clearBudgetHooks(): void {
  emitter.removeAllListeners(EVENT);
}
