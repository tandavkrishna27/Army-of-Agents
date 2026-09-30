import { describe, expect, it } from "vitest";
import type { ShowRef } from "@armyofagents/shared";
import type { DiscussionDetail, DiscussionEntryAttachment, ExtractedItem } from "../../../api/discussions";
import {
  OPEN_TAB_KEY,
  browserTab,
  artifactRefTab,
  closeTab,
  createGlobalMapTab,
  createOpenTab,
  createThreadMapTab,
  ensureTab,
  extractThreadUrls,
  extractUrlsFromThread,
  scopeArtifactToTab,
  scopeItemToTab,
  showRefToThreadTab,
  taskOutputTab,
  taskTab,
  threadAttachmentToTab,
  threadViewerTabToOpenRequest,
} from "../threadViewerModel";

function item(overrides: Partial<ExtractedItem> = {}): ExtractedItem {
  return {
    id: "item-1",
    type: "task",
    title: "Approve launch scope",
    description: "Confirm the proposed scope.",
    suggestedPriority: null,
    suggestedAssigneeId: null,
    suggestedDepartmentId: null,
    suggestedLayer: null,
    layer: null,
    priority: null,
    dedupAction: null,
    status: "pending",
    resultTaskId: null,
    resultMemoryId: null,
    conflictsWith: null,
    createdAt: "2026-06-04T00:00:00.000Z",
    ...overrides,
  };
}

describe("threadViewerModel", () => {
  it("creates a closeable Open tab", () => {
    expect(createOpenTab()).toEqual({
      key: OPEN_TAB_KEY,
      label: "Open",
      kind: "open",
      closeable: true,
    });
  });

  it("maps scope items to closeable tabs", () => {
    expect(scopeItemToTab(item())).toMatchObject({
      key: "scope:item-1",
      label: "Approve launch scope",
      kind: "scope_item",
      closeable: true,
    });
  });

  it("maps artifact and asset attachments to distinct tab kinds", () => {
    const artifactAttachment: DiscussionEntryAttachment = {
      id: "att-1",
      assetId: null,
      artifactId: "artifact-1",
      artifactType: "markdown",
      artifactTitle: "Launch brief",
    };
    const assetAttachment: DiscussionEntryAttachment = {
      id: "att-2",
      assetId: "asset-1",
      artifactId: null,
      artifactType: null,
      artifactTitle: null,
      assetContentType: "image/png",
      assetOriginalFilename: "screenshot.png",
      assetByteSize: 1200,
    };

    expect(threadAttachmentToTab(artifactAttachment, "entry-1")).toMatchObject({
      key: "artifact:artifact-1",
      label: "Launch brief",
      kind: "artifact",
    });
    expect(threadAttachmentToTab(assetAttachment, "entry-1")).toMatchObject({
      key: "asset:asset-1",
      label: "screenshot.png",
      kind: "asset",
    });
  });

  it("maps asset-backed artifact attachments to asset tabs", () => {
    const attachment: DiscussionEntryAttachment = {
      id: "att-asset-artifact",
      assetId: null,
      artifactId: "artifact-1",
      artifactType: "design",
      artifactTitle: "Brand deck",
      currentVersionStorageKind: "asset",
      currentVersionAssetId: "asset-9",
      currentVersionFilename: "deck.pdf",
      currentVersionContentType: "application/pdf",
      currentVersionByteSize: 2048,
    };

    expect(threadAttachmentToTab(attachment, "entry-1")).toMatchObject({
      key: "asset:asset-9",
      label: "deck.pdf",
      kind: "asset",
    });
  });

  it("maps asset-backed scope artifact links to asset tabs", () => {
    expect(scopeArtifactToTab({
      id: "scope-item-artifact",
      type: "artifact_link",
      kind: "artifact_link",
      scopeVersionId: "scope-version-1",
      title: "Brand deck",
      description: null,
      status: "draft",
      artifactId: "artifact-1",
      artifactVersionId: "artifact-version-1",
      payload: {
        storageKind: "asset",
        assetId: "asset-9",
        filename: "deck.pdf",
        contentType: "application/pdf",
        byteSize: 2048,
      },
    })).toMatchObject({
      key: "asset:asset-9",
      label: "deck.pdf",
      kind: "asset",
      payload: {
        attachment: {
          id: "scope-item-artifact",
          assetId: "asset-9",
          artifactId: "artifact-1",
          artifactTitle: "Brand deck",
          currentVersionStorageKind: "asset",
          currentVersionAssetId: "asset-9",
          currentVersionFilename: "deck.pdf",
          currentVersionContentType: "application/pdf",
          currentVersionByteSize: 2048,
        },
      },
    });
  });

  it("maps scope artifact links with asset ids to asset tabs even without storage flags", () => {
    expect(scopeArtifactToTab({
      id: "scope-item-artifact",
      type: "artifact_link",
      kind: "artifact_link",
      scopeVersionId: "scope-version-1",
      title: "Brand deck",
      description: null,
      status: "draft",
      artifactId: "artifact-1",
      artifactVersionId: "artifact-version-1",
      payload: {
        assetId: "asset-9",
        filename: "deck.pdf",
        contentType: "application/pdf",
      },
    })).toMatchObject({
      key: "asset:asset-9",
      label: "deck.pdf",
      kind: "asset",
    });
  });

  it("deduplicates tabs and allows closing the final Open tab", () => {
    const tabs = [createOpenTab()];
    const scopeTab = scopeItemToTab(item());

    expect(ensureTab(ensureTab(tabs, scopeTab), scopeTab)).toHaveLength(2);
    expect(closeTab([createOpenTab(), scopeTab], OPEN_TAB_KEY)).toEqual([scopeTab]);
    expect(closeTab([createOpenTab(), scopeTab], scopeTab.key)).toEqual([createOpenTab()]);
    expect(closeTab([createOpenTab()], OPEN_TAB_KEY)).toEqual([]);
  });

  it("normalizes browser and map tabs", () => {
    expect(browserTab("https://www.example.com/path")).toMatchObject({
      key: "browser:https://www.example.com/path",
      label: "example.com",
      kind: "browser",
    });
    expect(createThreadMapTab("thread-1")).toMatchObject({
      key: "map:thread:thread-1",
      label: "Map",
      kind: "map",
    });
    expect(createGlobalMapTab()).toMatchObject({
      key: "map:global",
      label: "Global Map",
      kind: "map",
    });
  });

  it("converts native viewer tabs into typed host requests", () => {
    expect(threadViewerTabToOpenRequest(taskTab("task-1", "Ship"))).toEqual({
      kind: "task",
      issueId: "task-1",
      title: "Ship",
      scopeItemId: undefined,
    });
    expect(threadViewerTabToOpenRequest(taskOutputTab("task-1", "Ship"))).toMatchObject({
      kind: "task_output",
      issueId: "task-1",
    });
    expect(threadViewerTabToOpenRequest(artifactRefTab("artifact-1", "Brief", "v1"))).toEqual({
      kind: "artifact",
      artifactId: "artifact-1",
      versionId: "v1",
      title: "Brief",
    });
    expect(threadViewerTabToOpenRequest(browserTab("https://example.com"))).toMatchObject({
      kind: "browser",
      url: "https://example.com/",
    });
    expect(threadViewerTabToOpenRequest(createThreadMapTab("thread-1"))).toEqual({
      kind: "map",
      scope: "thread",
      threadId: "thread-1",
    });
    expect(threadViewerTabToOpenRequest(createOpenTab())).toBeNull();
  });

  it("extracts unique http urls and strips sentence punctuation", () => {
    expect(
      extractThreadUrls([
        "Open https://example.com/path, then https://aoa.test/deck).",
        "Duplicate https://example.com/path",
      ]),
    ).toEqual(["https://example.com/path", "https://aoa.test/deck"]);
  });

  it("extracts urls from thread title, entries, and sourceInfo", () => {
    const thread = {
      id: "thread-1",
      title: "Review https://thread.example",
      status: "active",
      scopeType: null,
      scopeId: null,
      scopeName: null,
      tags: [],
      entryCount: 1,
      pendingItemCount: 0,
      createdBy: "user",
      createdAt: "2026-06-04T00:00:00.000Z",
      updatedAt: "2026-06-04T00:00:00.000Z",
      crewPaused: false,
      autonomyLevel: null,
      entries: [
        {
          id: "entry-1",
          inputType: "paste",
          rawContent: "Here is https://entry.example/doc",
          title: null,
          sourceInfo: { url: "https://source.example/call", ignored: 2 },
          departmentId: null,
          projectId: null,
          goalId: null,
          parentEntryId: null,
          authorAgentId: null,
          authorAgentName: null,
          authorAgentAvatar: null,
          extractionStatus: "completed",
          createdBy: "user",
          createdAt: "2026-06-04T00:00:00.000Z",
          extractedItems: [],
          annotations: [],
        },
      ],
    } satisfies DiscussionDetail;

    expect(extractUrlsFromThread(thread)).toEqual([
      "https://thread.example/",
      "https://entry.example/doc",
      "https://source.example/call",
    ]);
  });
});

describe("showRefToThreadTab — delivered-ref openRef adapter", () => {
  function v2(kind: ShowRef["kind"], overrides: Partial<ShowRef> = {}): ShowRef {
    return {
      v: 2,
      kind,
      id: `${kind}-id`,
      action: "referenced",
      ...overrides,
    } as ShowRef;
  }

  it("maps artifact → artifact_ref tab (carries id + versionId)", () => {
    const tab = showRefToThreadTab(v2("artifact", { id: "art-1", versionId: "ver-9", title: "Brief" }));
    expect(tab.kind).toBe("artifact_ref");
    expect(tab.payload).toMatchObject({ artifactId: "art-1", artifactVersionId: "ver-9" });
  });

  it("maps a legacy v1 artifact ref → artifact_ref tab", () => {
    const legacy: ShowRef = { v: 1, kind: "artifact", id: "art-2", action: "created", title: "Deck" };
    const tab = showRefToThreadTab(legacy);
    expect(tab.kind).toBe("artifact_ref");
    expect(tab.payload).toMatchObject({ artifactId: "art-2" });
  });

  it("maps asset → asset tab (assetId carried via synthesized attachment)", () => {
    const tab = showRefToThreadTab(v2("asset", { id: "asset-1", mimeType: "image/png", title: "logo.png" }));
    expect(tab.kind).toBe("asset");
    expect(tab.key).toBe("asset:asset-1");
    expect(tab.payload).toMatchObject({ attachment: { assetId: "asset-1", assetContentType: "image/png" } });
  });

  it("maps task → task tab (TaskDetail, carries issueId)", () => {
    const tab = showRefToThreadTab(v2("task", { id: "issue-1", title: "Ship it" }));
    expect(tab.kind).toBe("task");
    expect(tab.payload).toMatchObject({ issueId: "issue-1" });
  });

  it("maps memory_item → memory tab (carries companyId + memoryId)", () => {
    const tab = showRefToThreadTab(v2("memory_item", { id: "mem-1", title: "How we test" }), "comp-1");
    expect(tab.kind).toBe("memory");
    expect(tab.payload).toMatchObject({ companyId: "comp-1", memoryId: "mem-1" });
  });

  it("maps url → browser tab (normalized url in payload)", () => {
    const tab = showRefToThreadTab(v2("url", { id: "https://example.com/x", title: "Example" }));
    expect(tab.kind).toBe("browser");
    expect(tab.payload).toMatchObject({ url: "https://example.com/x" });
  });

  it("maps discussion → discussion tab (NEW body, carries companyId + discussionId)", () => {
    const tab = showRefToThreadTab(v2("discussion", { id: "disc-1", title: "Kickoff" }), "comp-1");
    expect(tab.kind).toBe("discussion");
    expect(tab.key).toBe("discussion:disc-1");
    expect(tab.payload).toMatchObject({ companyId: "comp-1", discussionId: "disc-1" });
  });

  it("maps approval → approval tab (NEW body, carries approvalId)", () => {
    const tab = showRefToThreadTab(v2("approval", { id: "appr-1", title: "Dispatch crew" }));
    expect(tab.kind).toBe("approval");
    expect(tab.key).toBe("approval:appr-1");
    expect(tab.payload).toMatchObject({ approvalId: "appr-1" });
  });

  it("maps output → output_ref tab (NEW body, distinct from whole-task task_output)", () => {
    const tab = showRefToThreadTab(v2("output", { id: "out-1", title: "PR #42", viewerKind: "code" }), "comp-1");
    expect(tab.kind).toBe("output_ref");
    expect(tab.key).toBe("output-ref:out-1");
    expect(tab.payload).toMatchObject({ companyId: "comp-1", outputId: "out-1", viewerKind: "code" });
  });

  it("falls back to a kind-derived title when the ref has none", () => {
    const tab = showRefToThreadTab(v2("task", { id: "abcdef1234567890", title: null }));
    expect(tab.label).toBe("task abcdef12");
  });
});
