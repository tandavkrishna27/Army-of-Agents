import {
  Bot,
  Building2,
  ClipboardPen,
  FileText,
  FolderKanban,
  GitBranch,
  Globe2,
  Lock,
  Mic,
  Plug,
  Radio,
  RefreshCw,
  Target,
  Users,
  Webhook,
} from "lucide-react";
import type { ThreadListItem } from "../../api/threads";

export function getInputSourceMeta(inputType: string | null | undefined) {
  switch (inputType) {
    case "voice":
      return { label: "Voice", Icon: Mic };
    case "mcp":
      return { label: "MCP", Icon: Plug };
    case "transcript":
      return { label: "Transcript", Icon: FileText };
    case "document":
      return { label: "Document", Icon: FileText };
    case "routine":
      return { label: "Routine", Icon: RefreshCw };
    case "webhook":
      return { label: "Webhook", Icon: Webhook };
    case "integration":
      return { label: "Integration", Icon: Plug };
    case "agent":
      return { label: "Agent", Icon: Bot };
    case "scope_proposal":
      return { label: "Proposal", Icon: Target };
    case "system":
      return { label: "System", Icon: Radio };
    case "paste":
    case "write":
    default:
      return { label: "Paste", Icon: ClipboardPen };
  }
}

export function getScopeMeta(
  thread: Pick<ThreadListItem, "scopeType" | "scopeName">,
) {
  if (!thread.scopeType || !thread.scopeName) return null;
  if (thread.scopeType === "department") {
    return {
      label: thread.scopeName,
      title: `Department: ${thread.scopeName}`,
      Icon: Building2,
    };
  }
  if (thread.scopeType === "project") {
    return {
      label: thread.scopeName,
      title: `Project: ${thread.scopeName}`,
      Icon: FolderKanban,
    };
  }
  if (thread.scopeType === "goal") {
    return {
      label: thread.scopeName,
      title: `Goal: ${thread.scopeName}`,
      Icon: Target,
    };
  }
  return null;
}

export function getVisibilityMeta(visibility: ThreadListItem["visibility"]) {
  if (visibility === "private") return { label: "Private", Icon: Lock };
  if (visibility === "department") {
    return { label: "Department visibility", Icon: Users };
  }
  return { label: "Company visibility", Icon: Globe2 };
}

export function getAttentionCount(
  thread: Pick<ThreadListItem, "pendingItemCount">,
) {
  return thread.pendingItemCount > 0
    ? { count: thread.pendingItemCount, kind: "review" as const }
    : null;
}

export function getBranchMeta(thread: Pick<ThreadListItem, "linkCount">) {
  const count = thread.linkCount ?? 0;
  return count > 0
    ? {
        count,
        Icon: GitBranch,
        title: `${count} linked thread${count === 1 ? "" : "s"}`,
      }
    : null;
}

export function getAvatarInitials(name: string | null | undefined) {
  const cleaned = (name ?? "").trim();
  if (!cleaned) return "?";
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}
