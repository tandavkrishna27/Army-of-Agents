/**
 * newThreadModel — pure model for new thread type resolution.
 * Codex #2: "goal" type creates a thread + linked goal, NOT a bare goal.
 */

export type NewThreadType = "idea" | "discussion" | "goal" | "transcript" | "document";

export interface CreateTarget {
  backend: "discussion" | "thread+goal";
  requires: string[];
}

/**
 * Given a thread type, returns the backend target and list of required fields.
 *
 * "goal" → backend: "thread+goal", requires: ["level", "projectIds"]
 * All others → backend: "discussion", requires: []
 */
export function resolveCreateTarget(type: NewThreadType): CreateTarget {
  if (type === "goal") {
    return {
      backend: "thread+goal",
      requires: ["level", "projectIds"],
    };
  }
  return {
    backend: "discussion",
    requires: [],
  };
}
