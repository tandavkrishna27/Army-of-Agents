import { createContext, useContext } from "react";
import type { CommanderContextScope } from "@armyofagents/shared";

const CommanderContextScopeContext = createContext<CommanderContextScope | null>(null);

export const CommanderContextScopeProvider = CommanderContextScopeContext.Provider;

export function useCommanderContextScope(): CommanderContextScope | null {
  return useContext(CommanderContextScopeContext);
}
