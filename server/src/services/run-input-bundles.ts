import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import {
  artifacts,
  artifactVersions,
  assets,
  discussionEntries,
  issueAttachments,
  issueComments,
  issueContextBundleItems,
  issueContextBundles,
  threadScopeItems,
} from "@armyofagents/db";
import type { StorageService } from "../storage/types.js";
import { getStorageService } from "../storage/index.js";
import { isContextBundleItemIncluded } from "./issue-context-bundles.js";

type RunInputDb = Pick<Db, "select">;

export type RunInputBundle = {
  markdown: string;
  inputs: Array<{
    type:
      | "attachment"
      | "artifact"
      | "comment"
      | "memory"
      | "text"
      | "url"
      | "discussion_entry"
      | "asset"
      | "scope_item";
    id: string;
    label: string;
    contentType?: string | null;
    byteSize?: number | null;
    localPath?: string | null;
    sourceIssueId?: string | null;
    url?: string | null;
    excerpt?: string | null;
    body?: string | null;
  }>;
  skipped: Array<{ id: string; type: string; reason: string }>;
};

function safeFilename(input: string) {
  return input
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160) || "input";
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function writeRunInputFile(input: {
  cwd: string | null | undefined;
  inputId: string;
  filename: string;
  content: Buffer | string;
}) {
  if (!input.cwd) return null;
  const inputsDir = path.join(input.cwd, ".aoa", "inputs", safeFilename(input.inputId));
  await fs.mkdir(inputsDir, { recursive: true });
  const localPath = path.join(inputsDir, safeFilename(input.filename));
  await fs.writeFile(localPath, input.content);
  return path.relative(input.cwd, localPath).replace(/\\/g, "/");
}

function metadataString(metadata: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export async function buildRunInputBundle(input: {
  db: RunInputDb;
  companyId: string;
  issueId: string;
  cwd?: string | null;
  storage?: Pick<StorageService, "getObject">;
}): Promise<RunInputBundle> {
  const storage = input.storage ?? getStorageService();
  const bundles = await input.db
    .select()
    .from(issueContextBundles)
    .where(and(eq(issueContextBundles.companyId, input.companyId), eq(issueContextBundles.targetIssueId, input.issueId)));

  const result: RunInputBundle = { markdown: "", inputs: [], skipped: [] };
  for (const bundle of bundles) {
    if (bundle.brief) {
      result.inputs.push({
        type: "text",
        id: bundle.id,
        label: "Inherited brief",
        sourceIssueId: bundle.sourceIssueId,
      });
    }

    const items = await input.db
      .select()
      .from(issueContextBundleItems)
      .where(and(eq(issueContextBundleItems.companyId, input.companyId), eq(issueContextBundleItems.bundleId, bundle.id)));

    for (const item of items) {
      if (!isContextBundleItemIncluded(item)) continue;
      if (item.itemType === "url") {
        const url = metadataString(item.metadata, "url");
        if (!url) {
          result.skipped.push({ id: item.id, type: "url", reason: "missing_url" });
          continue;
        }
        result.inputs.push({
          type: "url",
          id: item.id,
          label: item.label ?? "Reference URL",
          sourceIssueId: bundle.sourceIssueId,
          url,
        });
        continue;
      }

      if (item.itemType === "discussion_entry") {
        if (!item.sourceId) {
          result.skipped.push({ id: item.id, type: "discussion_entry", reason: "missing_source_id" });
          continue;
        }
        if (!bundle.sourceDiscussionId) {
          result.skipped.push({ id: item.sourceId, type: "discussion_entry", reason: "missing_source_discussion_id" });
          continue;
        }
        const entry = await input.db
          .select({ id: discussionEntries.id, rawContent: discussionEntries.rawContent })
          .from(discussionEntries)
          .where(and(eq(discussionEntries.id, item.sourceId), eq(discussionEntries.discussionId, bundle.sourceDiscussionId)))
          .then((rows) => rows[0] ?? null);
        if (!entry) {
          result.skipped.push({ id: item.sourceId, type: "discussion_entry", reason: "not_found" });
          continue;
        }
        result.inputs.push({
          type: "discussion_entry",
          id: entry.id,
          label: item.label ?? "Source message",
          sourceIssueId: bundle.sourceIssueId,
          excerpt: metadataString(item.metadata, "excerpt") ?? entry.rawContent.slice(0, 300),
        });
        continue;
      }

      if (item.itemType === "scope_item") {
        if (!item.sourceId) {
          result.skipped.push({ id: item.id, type: "scope_item", reason: "missing_source_id" });
          continue;
        }
        const scopeItem = await input.db
          .select({ id: threadScopeItems.id, title: threadScopeItems.title, description: threadScopeItems.description })
          .from(threadScopeItems)
          .where(and(eq(threadScopeItems.id, item.sourceId), eq(threadScopeItems.companyId, input.companyId)))
          .then((rows) => rows[0] ?? null);
        if (!scopeItem) {
          result.skipped.push({ id: item.sourceId, type: "scope_item", reason: "not_found" });
          continue;
        }
        result.inputs.push({
          type: "scope_item",
          id: scopeItem.id,
          label: item.label ?? scopeItem.title,
          sourceIssueId: bundle.sourceIssueId,
          body: scopeItem.description ?? null,
        });
        continue;
      }

      const itemType = item.itemType as RunInputBundle["inputs"][number]["type"];
      if (item.itemType === "text") {
        result.inputs.push({
          type: "text",
          id: item.id,
          label: item.label ?? "Text context",
          sourceIssueId: bundle.sourceIssueId,
          body: metadataString(item.metadata, "body"),
        });
        continue;
      }

      if (!item.sourceId) {
        result.skipped.push({ id: item.id, type: item.itemType, reason: "missing_source_id" });
        continue;
      }

      if (item.itemType === "comment") {
        const comment = await input.db
          .select({ id: issueComments.id, body: issueComments.body, issueId: issueComments.issueId })
          .from(issueComments)
          .where(and(eq(issueComments.id, item.sourceId), eq(issueComments.companyId, input.companyId)))
          .then((rows) => rows[0] ?? null);
        if (!comment) {
          result.skipped.push({ id: item.sourceId, type: "comment", reason: "not_found" });
          continue;
        }
        result.inputs.push({
          type: "comment",
          id: comment.id,
          label: item.label ?? comment.body.slice(0, 80),
          sourceIssueId: comment.issueId,
        });
        continue;
      }

      if (item.itemType === "attachment") {
        const attachment = await input.db
          .select({
            id: issueAttachments.id,
            issueId: issueAttachments.issueId,
            objectKey: assets.objectKey,
            originalFilename: assets.originalFilename,
            contentType: assets.contentType,
            byteSize: assets.byteSize,
          })
          .from(issueAttachments)
          .innerJoin(assets, eq(assets.id, issueAttachments.assetId))
          .where(and(eq(issueAttachments.id, item.sourceId), eq(issueAttachments.companyId, input.companyId)))
          .then((rows) => rows[0] ?? null);
        if (!attachment) {
          result.skipped.push({ id: item.sourceId, type: "attachment", reason: "not_found" });
          continue;
        }
        let localPath: string | null = null;
        if (input.cwd) {
          try {
            const object = await storage.getObject(input.companyId, attachment.objectKey);
            localPath = await writeRunInputFile({
              cwd: input.cwd,
              inputId: item.id,
              filename: attachment.originalFilename ?? `${attachment.id}`,
              content: await streamToBuffer(object.stream),
            });
          } catch {
            result.skipped.push({ id: item.sourceId, type: "attachment", reason: "materialize_failed" });
          }
        }
        result.inputs.push({
          type: "attachment",
          id: attachment.id,
          label: item.label ?? attachment.originalFilename ?? attachment.id,
          contentType: attachment.contentType,
          byteSize: attachment.byteSize,
          localPath,
          sourceIssueId: attachment.issueId,
        });
        continue;
      }

      if (item.itemType === "asset") {
        const asset = await input.db
          .select({
            id: assets.id,
            objectKey: assets.objectKey,
            originalFilename: assets.originalFilename,
            contentType: assets.contentType,
            byteSize: assets.byteSize,
          })
          .from(assets)
          .where(and(eq(assets.id, item.sourceId), eq(assets.companyId, input.companyId)))
          .then((rows) => rows[0] ?? null);
        if (!asset) {
          result.skipped.push({ id: item.sourceId, type: "asset", reason: "not_found" });
          continue;
        }
        let localPath: string | null = null;
        if (input.cwd) {
          try {
            const object = await storage.getObject(input.companyId, asset.objectKey);
            localPath = await writeRunInputFile({
              cwd: input.cwd,
              inputId: item.id,
              filename: asset.originalFilename ?? `${asset.id}`,
              content: await streamToBuffer(object.stream),
            });
          } catch {
            result.skipped.push({ id: item.sourceId, type: "asset", reason: "materialize_failed" });
          }
        }
        result.inputs.push({
          type: "asset",
          id: asset.id,
          label: item.label ?? asset.originalFilename ?? asset.id,
          contentType: asset.contentType,
          byteSize: asset.byteSize,
          localPath,
          sourceIssueId: bundle.sourceIssueId,
        });
        continue;
      }

      if (item.itemType === "artifact") {
        const artifact = await input.db
          .select({
            id: artifacts.id,
            title: artifacts.title,
            type: artifacts.type,
            currentVersionId: artifacts.currentVersionId,
          })
          .from(artifacts)
          .where(and(eq(artifacts.id, item.sourceId), eq(artifacts.companyId, input.companyId)))
          .then((rows) => rows[0] ?? null);
        if (!artifact) {
          result.skipped.push({ id: item.sourceId, type: "artifact", reason: "not_found" });
          continue;
        }
        let localPath: string | null = null;
        if (input.cwd && artifact.currentVersionId) {
          const version = await input.db
            .select({ content: artifactVersions.content, fileUrl: artifactVersions.fileUrl })
            .from(artifactVersions)
            .where(eq(artifactVersions.id, artifact.currentVersionId))
            .then((rows) => rows[0] ?? null);
          if (version?.content) {
            localPath = await writeRunInputFile({
              cwd: input.cwd,
              inputId: item.id,
              filename: `${artifact.title}.${artifact.type === "markdown" ? "md" : "txt"}`,
              content: version.content,
            });
          }
        }
        result.inputs.push({
          type: "artifact",
          id: artifact.id,
          label: item.label ?? artifact.title,
          localPath,
        });
        continue;
      }

      if (itemType === "memory") {
        result.inputs.push({
          type: "memory",
          id: item.sourceId,
          label: item.label ?? "Memory context",
          sourceIssueId: bundle.sourceIssueId,
        });
        continue;
      }

      result.skipped.push({ id: item.sourceId, type: item.itemType, reason: "unsupported_type" });
    }
  }

  if (result.inputs.length > 0 || result.skipped.length > 0) {
    const lines = ["## Run Inputs"];
    for (const entry of result.inputs) {
      const detail = [entry.contentType, entry.localPath].filter(Boolean).join(" - ");
      const source = entry.url ? `: ${entry.url}` : "";
      const excerpt = entry.excerpt ?? entry.body;
      lines.push(`- ${entry.label}${detail ? ` (${detail})` : ""}${source}${excerpt ? ` - ${excerpt}` : ""}`);
    }
    for (const skipped of result.skipped) {
      lines.push(`- Skipped ${skipped.type} ${skipped.id}: ${skipped.reason}`);
    }
    result.markdown = lines.join("\n");
  }

  return result;
}
