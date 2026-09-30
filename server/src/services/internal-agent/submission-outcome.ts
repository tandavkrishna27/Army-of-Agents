export type CommanderSubmissionOutcome =
  | { state: "not_found" }
  | { state: "unknown"; userMessageId: string; reason: "legacy_identity" }
  | { state: "accepted"; userMessageId: string }
  | { state: "completed"; userMessageId: string; assistantMessageId: string }
  | { state: "failed"; userMessageId: string };

export function classifyCommanderSubmissionOutcome(
  userMessage: { id: string; turnStatus?: string | null; submissionPayloadHash?: string | null } | null,
  assistantMessage: { id: string } | null,
): CommanderSubmissionOutcome {
  if (!userMessage) return { state: "not_found" };
  if (!userMessage.submissionPayloadHash)
    return { state: "unknown", userMessageId: userMessage.id, reason: "legacy_identity" };
  if (assistantMessage) {
    return { state: "completed", userMessageId: userMessage.id, assistantMessageId: assistantMessage.id };
  }
  if (userMessage.turnStatus === "failed") {
    return { state: "failed", userMessageId: userMessage.id };
  }
  return { state: "accepted", userMessageId: userMessage.id };
}
