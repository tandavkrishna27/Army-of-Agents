import type { ShowRef } from "@armyofagents/shared";
import type {
  DiscussionDetail,
  DiscussionEntry,
  DiscussionEntryAttachment,
} from "../../api/discussions";

export type ThreadViewerTabKind =
  | "open"
  | "scope_item"
  | "task"
  | "task_output"
  | "memory"
  | "artifact_ref"
  | "asset"
  | "artifact"
  | "browser"
  | "map"
  // Viewer Upgrade Phase 7B — navigational ShowRef bodies not previously reachable
  // from a Thread. Distinct from `task_output` (whole-task outputs) — `output_ref`
  // opens a single task_output by id.
  | "discussion"
  | "approval"
  | "output_ref";

export interface ThreadViewerTab {
  key: string;
  label: string;
  kind: ThreadViewerTabKind;
  closeable: boolean;
  payload?: unknown;
}

export interface ThreadViewerScopeItem {
  id: string;
  type: string;
  kind?: string;
  scopeVersionId?: string | null;
  title: string;
  description: string | null;
  status: string;
  resultIssueId?: string | null;
  resultMemoryId?: string | null;
  artifactId?: string | null;
  artifactVersionId?: string | null;
  sourceEntryIds?: unknown[];
  payload?: Record<string, unknown>;
  suggestedPriority?: string | null;
  priority?: string | null;
  suggestedAssigneeId?: string | null;
  suggestedDepartmentId?: string | null;
  suggestedLayer?: string | null;
  layer?: string | null;
}

export interface ThreadViewerScopePayload {
  item: ThreadViewerScopeItem;
}

export interface ThreadViewerAttachmentPayload {
  attachment: DiscussionEntryAttachment;
  entryId?: string;
}

export interface ThreadViewerTaskPayload {
  issueId: string;
  title: string;
  scopeItemId?: string;
}

export interface ThreadViewerTaskOutputPayload {
  issueId: string;
  title: string;
  scopeItemId?: string;
}

export interface ThreadViewerMemoryPayload {
  companyId: string;
  memoryId: string;
  title: string;
  scopeItemId?: string;
}

export interface ThreadViewerArtifactRefPayload {
  artifactId: string;
  artifactVersionId?: string | null;
  title: string;
  scopeItemId?: string;
}

export interface ThreadViewerBrowserPayload {
  url: string;
  title: string;
}

// Viewer Upgrade Phase 7B — payloads for the three navigational bodies newly
// reachable from a Thread. companyId is carried on the payload (like memoryTab)
// so the self-fetching shared bodies can resolve the entity.
export interface ThreadViewerDiscussionPayload {
  companyId: string;
  discussionId: string;
  title: string;
}

export interface ThreadViewerApprovalPayload {
  approvalId: string;
  title: string;
}

export interface ThreadViewerOutputRefPayload {
  companyId: string;
  outputId: string;
  title: string;
  viewerKind?: string | null;
}

export interface ThreadViewerMapPayload {
  scope: "thread" | "global";
  threadId?: string;
}

export type ThreadOpenRequest =
  | { kind: "task"; issueId: string; title: string; scopeItemId?: string }
  | { kind: "task_output"; issueId: string; title: string; scopeItemId?: string }
  | { kind: "scope_item"; item: ThreadViewerScopeItem; scopeVersionId?: string | null }
  | { kind: "memory"; memoryId: string; title: string; scopeItemId?: string }
  | { kind: "artifact"; artifactId: string; versionId?: string | null; title: string }
  | { kind: "asset"; attachment: DiscussionEntryAttachment; entryId?: string }
  | { kind: "browser"; url: string; title: string }
  | { kind: "map"; scope: "thread" | "global"; threadId?: string };

export function threadViewerTabToOpenRequest(tab: ThreadViewerTab): ThreadOpenRequest | null {
  switch (tab.kind) {
    case "task":
    case "task_output": {
      const payload = tab.payload as ThreadViewerTaskPayload | ThreadViewerTaskOutputPayload;
      return { kind: tab.kind, ...payload };
    }
    case "scope_item": {
      const payload = tab.payload as ThreadViewerScopePayload;
      return {
        kind: "scope_item",
        item: payload.item,
        scopeVersionId: payload.item.scopeVersionId,
      };
    }
    case "memory": {
      const payload = tab.payload as ThreadViewerMemoryPayload;
      return {
        kind: "memory",
        memoryId: payload.memoryId,
        title: payload.title,
        scopeItemId: payload.scopeItemId,
      };
    }
    case "artifact_ref": {
      const payload = tab.payload as ThreadViewerArtifactRefPayload;
      return {
        kind: "artifact",
        artifactId: payload.artifactId,
        versionId: payload.artifactVersionId,
        title: payload.title,
      };
    }
    case "artifact":
    case "asset": {
      const payload = tab.payload as ThreadViewerAttachmentPayload;
      if (tab.kind === "artifact" && payload.attachment.artifactId) {
        return {
          kind: "artifact",
          artifactId: payload.attachment.artifactId,
          title: payload.attachment.artifactTitle ?? tab.label,
        };
      }
      return { kind: "asset", ...payload };
    }
    case "browser": {
      const payload = tab.payload as ThreadViewerBrowserPayload;
      return { kind: "browser", ...payload };
    }
    case "map": {
      const payload = tab.payload as ThreadViewerMapPayload;
      return { kind: "map", ...payload };
    }
    case "open":
    // Phase 7B: the navigational bodies are Thread-viewer-only — there is no
    // ThreadOpenRequest equivalent yet, so an embedded host can't re-host them.
    // Returning null leaves them inert in embedded mode (not broken).
    case "discussion":
    case "approval":
    case "output_ref":
      return null;
  }
}

export const OPEN_TAB_KEY = "open";
const TRAILING_URL_PUNCTUATION = /[.,!?;:)\]}]+$/;
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"')]+/gi;

export function createOpenTab(): ThreadViewerTab {
  return {
    key: OPEN_TAB_KEY,
    label: "Open",
    kind: "open",
    closeable: true,
  };
}

export function createThreadMapTab(threadId: string): ThreadViewerTab {
  return {
    key: `map:thread:${threadId}`,
    label: "Map",
    kind: "map",
    closeable: true,
    payload: { scope: "thread", threadId } satisfies ThreadViewerMapPayload,
  };
}

export function createGlobalMapTab(): ThreadViewerTab {
  return {
    key: "map:global",
    label: "Global Map",
    kind: "map",
    closeable: true,
    payload: { scope: "global" } satisfies ThreadViewerMapPayload,
  };
}

export function scopeItemToTab(item: ThreadViewerScopeItem): ThreadViewerTab {
  return {
    key: `scope:${item.id}`,
    label: item.title || "Scope item",
    kind: "scope_item",
    closeable: true,
    payload: { item } satisfies ThreadViewerScopePayload,
  };
}

export function taskTab(issueId: string, title: string, scopeItemId?: string): ThreadViewerTab {
  return {
    key: `task:${issueId}`,
    label: title || "Task",
    kind: "task",
    closeable: true,
    payload: { issueId, title: title || "Task", scopeItemId } satisfies ThreadViewerTaskPayload,
  };
}

export function taskOutputTab(issueId: string, title: string, scopeItemId?: string): ThreadViewerTab {
  return {
    key: `task-output:${issueId}`,
    label: `${title} · Outputs` || "Task Outputs",
    kind: "task_output",
    closeable: true,
    payload: { issueId, title: title || "Task", scopeItemId } satisfies ThreadViewerTaskOutputPayload,
  };
}

export function memoryTab(
  companyId: string,
  memoryId: string,
  title: string,
  scopeItemId?: string,
): ThreadViewerTab {
  return {
    key: `memory:${memoryId}`,
    label: title || "Memory",
    kind: "memory",
    closeable: true,
    payload: { companyId, memoryId, title: title || "Memory", scopeItemId } satisfies ThreadViewerMemoryPayload,
  };
}

export function artifactRefTab(
  artifactId: string,
  title: string,
  artifactVersionId?: string | null,
  scopeItemId?: string,
): ThreadViewerTab {
  const scopeSuffix = scopeItemId ?? artifactVersionId ?? "latest";
  return {
    key: `artifact-ref:${artifactId}:${scopeSuffix}`,
    label: title || "Artifact",
    kind: "artifact_ref",
    closeable: true,
    payload: {
      artifactId,
      artifactVersionId,
      title: title || "Artifact",
      scopeItemId,
    } satisfies ThreadViewerArtifactRefPayload,
  };
}

export function scopeArtifactToTab(item: ThreadViewerScopeItem): ThreadViewerTab | null {
  if (!item.artifactId) return null;
  const payload = item.payload ?? {};
  const assetId = stringPayload(payload.assetId);
  if (assetId) {
    return threadAttachmentToTab({
      id: item.id,
      assetId,
      artifactId: item.artifactId,
      artifactType: stringPayload(payload.artifactType) ?? item.type,
      artifactTitle: item.title,
      assetContentType: stringPayload(payload.contentType),
      assetOriginalFilename: stringPayload(payload.filename) ?? item.title,
      assetByteSize: numberPayload(payload.byteSize),
      currentVersionStorageKind: "asset",
      currentVersionAssetId: assetId,
      currentVersionFilename: stringPayload(payload.filename) ?? item.title,
      currentVersionContentType: stringPayload(payload.contentType),
      currentVersionByteSize: numberPayload(payload.byteSize),
    });
  }
  return artifactRefTab(item.artifactId, item.title, item.artifactVersionId, item.id);
}

function stringPayload(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberPayload(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function threadAttachmentToTab(
  attachment: DiscussionEntryAttachment,
  entryId?: string,
): ThreadViewerTab {
  const assetBackedArtifact =
    attachment.currentVersionStorageKind === "asset" &&
    Boolean(attachment.currentVersionAssetId);
  const isArtifact = Boolean(attachment.artifactId) && !assetBackedArtifact;
  const assetId = attachment.currentVersionAssetId ?? attachment.assetId ?? attachment.id;
  const title =
    (assetBackedArtifact ? attachment.currentVersionFilename : null) ||
    attachment.artifactTitle ||
    attachment.assetOriginalFilename ||
    (isArtifact ? "Artifact" : "File");

  return {
    key: isArtifact
      ? `artifact:${attachment.artifactId}`
      : `asset:${assetId}`,
    label: title,
    kind: isArtifact ? "artifact" : "asset",
    closeable: true,
    payload: { attachment, entryId } satisfies ThreadViewerAttachmentPayload,
  };
}

export function browserTab(url: string, title?: string): ThreadViewerTab {
  const normalizedUrl = normalizeUrl(url);
  return {
    key: `browser:${normalizedUrl}`,
    label: title || browserLabel(normalizedUrl),
    kind: "browser",
    closeable: true,
    payload: { url: normalizedUrl, title: title || browserLabel(normalizedUrl) } satisfies ThreadViewerBrowserPayload,
  };
}

// ── Viewer Upgrade Phase 7B — navigational tab builders ──────────────────────

export function discussionRefTab(
  companyId: string,
  discussionId: string,
  title: string,
): ThreadViewerTab {
  return {
    key: `discussion:${discussionId}`,
    label: title || "Discussion",
    kind: "discussion",
    closeable: true,
    payload: {
      companyId,
      discussionId,
      title: title || "Discussion",
    } satisfies ThreadViewerDiscussionPayload,
  };
}

export function approvalRefTab(approvalId: string, title: string): ThreadViewerTab {
  return {
    key: `approval:${approvalId}`,
    label: title || "Approval",
    kind: "approval",
    closeable: true,
    payload: { approvalId, title: title || "Approval" } satisfies ThreadViewerApprovalPayload,
  };
}

export function outputRefTab(
  companyId: string,
  outputId: string,
  title: string,
  viewerKind?: string | null,
): ThreadViewerTab {
  return {
    key: `output-ref:${outputId}`,
    label: title || "Output",
    kind: "output_ref",
    closeable: true,
    payload: {
      companyId,
      outputId,
      title: title || "Output",
      viewerKind: viewerKind ?? null,
    } satisfies ThreadViewerOutputRefPayload,
  };
}

/**
 * openRef adapter — maps a delivered ShowRef (any of the 8 kinds) to a Thread
 * viewer tab. A thin adapter over the existing Thread tab builders: it does NOT
 * merge the Commander/Workspace viewer models. Five kinds route to bodies the
 * Thread already had (artifact/asset/task/memory_item/url); three route to the
 * Phase-7B bodies (discussion/approval/output).
 *
 * `companyId` is required by the self-fetching memory/discussion/output bodies;
 * pass the active company at the call site (the Thread has it in scope).
 */
export function showRefToThreadTab(ref: ShowRef, companyId = ""): ThreadViewerTab {
  const title = ref.title ?? `${ref.kind} ${ref.id.slice(0, 8)}`;
  switch (ref.kind) {
    case "artifact":
      return artifactRefTab(ref.id, title, ref.versionId ?? null);
    case "asset":
      // No full attachment record from a bare ref — synthesize the minimal
      // asset-backed attachment the existing `asset` body reads (assetId +
      // filename/contentType fallbacks). mimeType/viewerKind narrow to v2 here.
      return threadAttachmentToTab({
        id: ref.id,
        assetId: ref.id,
        artifactId: null,
        artifactType: null,
        artifactTitle: null,
        assetContentType: ref.mimeType ?? null,
        assetOriginalFilename: title,
      });
    case "task":
      return taskTab(ref.id, title);
    case "memory_item":
      return memoryTab(companyId, ref.id, title);
    case "url":
      return browserTab(ref.id, title);
    case "discussion":
      return discussionRefTab(companyId, ref.id, title);
    case "approval":
      return approvalRefTab(ref.id, title);
    case "output":
      return outputRefTab(companyId, ref.id, title, ref.viewerKind ?? null);
  }
}

export { ensureTab, closeTab } from "../../lib/viewer-tabs";

export function extractThreadUrls(values: string[]): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];

  for (const value of values) {
    for (const match of value.matchAll(URL_PATTERN)) {
      const url = normalizeUrl(match[0].replace(TRAILING_URL_PUNCTUATION, ""));
      if (!seen.has(url)) {
        seen.add(url);
        urls.push(url);
      }
    }
  }

  return urls;
}

export function extractUrlsFromThread(thread: DiscussionDetail | null | undefined): string[] {
  if (!thread) return [];
  const values: string[] = [thread.title];
  for (const entry of thread.entries) {
    values.push(entry.rawContent);
    values.push(...sourceInfoValues(entry));
  }
  return extractThreadUrls(values);
}

function sourceInfoValues(entry: DiscussionEntry): string[] {
  if (!entry.sourceInfo) return [];
  return Object.values(entry.sourceInfo)
    .filter((value): value is string => typeof value === "string")
    .filter((value) => value.length > 0);
}

function normalizeUrl(url: string): string {
  try {
    return new URL(url).toString();
  } catch {
    return url.trim();
  }
}

function browserLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "") || "Browser";
  } catch {
    return "Browser";
  }
}
