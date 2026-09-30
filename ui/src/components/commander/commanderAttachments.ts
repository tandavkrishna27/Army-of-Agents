import {
  COMPOSER_ATTACHMENT_CONTENT_TYPES,
  COMPOSER_MAX_ATTACHMENTS,
  COMPOSER_MAX_ATTACHMENT_BYTES,
  type CommanderInputRef,
} from "@armyofagents/shared";
import type { AssetFileResponse } from "@/api/assets";

export interface CommanderAttachmentSelection {
  accepted: File[];
  errors: string[];
}

export function attachmentCapability(contentType: string): "text-readable" | "vision-readable" | "stored-only" {
  const type = contentType.toLowerCase();
  if (["text/plain", "text/markdown", "application/json"].includes(type)) return "text-readable";
  if (type.startsWith("image/")) return "vision-readable";
  return "stored-only";
}

export function validateCommanderAttachmentFiles(
  files: readonly File[],
  attachedCount: number,
  uploadingCount = 0,
): CommanderAttachmentSelection {
  const available = Math.max(0, COMPOSER_MAX_ATTACHMENTS - attachedCount - uploadingCount);
  const errors: string[] = [];
  if (files.length > available) {
    errors.push(`Attach up to ${COMPOSER_MAX_ATTACHMENTS} files per message.`);
  }

  const accepted = files.slice(0, available).filter((file) => {
    if (
      !COMPOSER_ATTACHMENT_CONTENT_TYPES.includes(
        file.type as (typeof COMPOSER_ATTACHMENT_CONTENT_TYPES)[number],
      )
    ) {
      errors.push(`Unsupported attachment type: ${file.type || "unknown"}.`);
      return false;
    }
    if (file.size <= 0) {
      errors.push(`${file.name} is empty.`);
      return false;
    }
    if (file.size > COMPOSER_MAX_ATTACHMENT_BYTES) {
      errors.push(`${file.name} exceeds the 10 MB attachment limit.`);
      return false;
    }
    return true;
  });

  return { accepted, errors };
}

export function assetResponseToCommanderInputRef(
  asset: AssetFileResponse,
  fallbackFilename: string,
): CommanderInputRef {
  return {
    v: 1,
    kind: "asset",
    id: asset.assetId,
    label: asset.originalFilename || fallbackFilename,
    route: asset.contentPath,
    source: "commander-upload",
    detail: `contentType=${asset.contentType} | byteSize=${asset.byteSize} | capability=${attachmentCapability(asset.contentType)}`,
  };
}
