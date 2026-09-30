import type { IssueComment } from "@armyofagents/shared";

export function isSystemNoticeComment(comment: Pick<IssueComment, "authorType" | "presentation">): boolean {
  return comment.authorType === "system" && comment.presentation?.kind === "system_notice";
}

export function formatNoticeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
}

export function formatNoticeValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "None";
  if (value instanceof Date) return value.toLocaleString();
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value).replace(/_/g, " ");
  }
  return JSON.stringify(value);
}
