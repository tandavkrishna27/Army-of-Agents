export interface HeartbeatTaskContext {
  id: string;
  identifier: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function buildWorkQuestionContinuationMarkdown(envelopeValue: unknown): string | null {
  const envelope = asRecord(envelopeValue);
  const question = asRecord(envelope?.question);
  const answer = asRecord(envelope?.answer);
  const answerValue = asRecord(answer?.value);
  const questionText = asNonEmptyString(question?.text) ?? asNonEmptyString(question?.title);
  if (!questionText || !answerValue) return null;

  const options = Array.isArray(question?.options)
    ? question.options.map(asRecord).filter((option): option is Record<string, unknown> => option !== null)
    : [];
  const optionLabels = new Map(
    options.flatMap((option) => {
      const value = asNonEmptyString(option.value);
      const label = asNonEmptyString(option.label);
      return value && label ? [[value, label] as const] : [];
    }),
  );
  const selectedValues = Array.isArray(answerValue.selectedValues)
    ? answerValue.selectedValues.map(asNonEmptyString).filter((value): value is string => value !== null)
    : [];
  const answerLines = [
    asNonEmptyString(answerValue.text),
    ...selectedValues.map((value) => {
      const label = optionLabels.get(value);
      return label ? `${label} (${value})` : value;
    }),
  ].filter((value): value is string => value !== null);
  if (answerLines.length === 0) return null;

  const instructions = asNonEmptyString(envelope?.remainingWorkInstructions)
    ?? "Apply this answer to the current task and resume the remaining work.";
  return [
    "## Human Answer Received",
    `- Question: ${questionText}`,
    `- Answer: ${answerLines.join("; ")}`,
    `- Answer version: ${typeof answer?.version === "number" ? answer.version : "unknown"}`,
    "",
    instructions,
  ].join("\n");
}

export interface WakeCommentContext {
  body: string;
  /** Human-readable author ("the board", "Maya", "agent Scout"). */
  authorLabel: string;
  /** Wake reason — a mention gets a sharper heading than a plain message. */
  reason: string | null;
}

/**
 * Inline the comment that woke this run (review F11, 2026-07-16): before this,
 * a founder's "Send & wake" chat message or @mention woke the agent but the
 * prompt never carried the message text — the agent only saw it if it chose
 * to fetch comments via MCP tools. Mirrors the work-question continuation
 * pattern above: what the human said is part of the wake, so it goes in the
 * prompt.
 */
export function buildWakeCommentMarkdown(comment: WakeCommentContext | null): string | null {
  const body = comment?.body?.trim();
  if (!comment || !body) return null;
  const heading =
    comment.reason === "issue_comment_mentioned"
      ? "## You Were Mentioned in a Comment"
      : "## New Message on This Task";
  return [
    heading,
    `- From: ${comment.authorLabel}`,
    "",
    body,
    "",
    "Address this message as part of your work on the task. Reply by posting a task comment; if it needs a human decision, use `ask_human`.",
  ].join("\n");
}

export function buildCurrentTaskMarkdown(task: HeartbeatTaskContext): string {
  return [
    "## Current Task",
    `- Task ID: ${task.id}`,
    `- Identifier: ${task.identifier ?? task.id}`,
    `- Title: ${task.title}`,
    `- Status: ${task.status}`,
    `- Priority: ${task.priority}`,
    "- Tool context: pass the Task ID above to task tools. `ask_human` automatically binds to this active task.",
    "- Human input: use the AoA MCP tool `mcp__aoa__ask_human` (shown as `ask_human` by some clients). Never use a provider-local `request_user_input`; it is not durable and cannot resume this task.",
    task.description ? "" : null,
    task.description ? "### Description" : null,
    task.description ?? null,
  ].filter((line): line is string => line !== null).join("\n");
}
