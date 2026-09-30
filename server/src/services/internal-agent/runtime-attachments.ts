import type { Readable } from "node:stream";
import {
  attachmentRuntimeCapability,
  type AttachmentRuntimeCapability,
} from "@armyofagents/shared";

/**
 * Runtime attachment delivery (v1 — text only; Decision: composer scope §9.6).
 *
 * Resolves composer attachment asset IDs to content the active runtime can read,
 * gated by company ownership. Text-readable files (txt/md/json) are decoded and
 * delivered inline; images and other types are disclosed as stored-only WITHOUT
 * their bytes (vision delivery is a later phase). Object keys / host paths are
 * never exposed to the provider — the server reads the bytes and injects text.
 */

/** Per-file cap on delivered text. Keeps a large paste from blowing the turn. */
export const RUNTIME_ATTACHMENT_TEXT_BYTE_CAP = 32 * 1024;

export type RuntimeAttachment = {
  assetId: string;
  filename: string | null;
  contentType: string;
  capability: AttachmentRuntimeCapability;
  /** Decoded text for text-readable files; null for anything not delivered. */
  text: string | null;
  truncated: boolean;
};

type ResolvedAsset = {
  companyId: string;
  contentType: string;
  objectKey: string;
  originalFilename: string | null;
  byteSize: number;
  /** Trusted provenance (PR #291 round-6 #2): true only for a validated composer
   * upload. Runtime delivery refuses anything else so a spoofed namespace=files
   * asset can't be decoded into a Commander turn. */
  composerValidated?: boolean | null;
};

export interface RuntimeAttachmentDeps {
  getAsset: (assetId: string) => Promise<ResolvedAsset | null>;
  /** Read up to `byteCap` bytes of an object and decode as UTF-8. */
  readObjectText: (
    companyId: string,
    objectKey: string,
    byteCap: number,
  ) => Promise<{ text: string; truncated: boolean }>;
}

export async function resolveRuntimeAttachments(
  deps: RuntimeAttachmentDeps,
  companyId: string,
  assetIds: readonly string[],
): Promise<RuntimeAttachment[]> {
  const out: RuntimeAttachment[] = [];
  for (const assetId of assetIds) {
    const asset = await deps.getAsset(assetId);
    // Authorization boundary: a missing asset or one owned by another company is
    // dropped entirely — its bytes are never read.
    if (!asset || asset.companyId !== companyId) continue;
    // Provenance boundary (PR #291 round-6 #2): only a validated composer upload
    // may be delivered to the runtime. An asset uploaded via the unrestricted
    // namespace=files path (no allowlist, no size cap, no byte sniff) is dropped
    // — its bytes are never read/decoded into the turn — even if the caller owns
    // it, closing the spoofed-text/plain-into-Commander vector.
    if (asset.composerValidated !== true) continue;

    const capability = attachmentRuntimeCapability(asset.contentType);
    let text: string | null = null;
    let truncated = false;

    if (capability === "text-readable") {
      const read = await deps.readObjectText(companyId, asset.objectKey, RUNTIME_ATTACHMENT_TEXT_BYTE_CAP);
      text = read.text;
      truncated = read.truncated;
    }

    out.push({
      assetId,
      filename: asset.originalFilename,
      contentType: asset.contentType,
      capability,
      text,
      truncated,
    });
  }
  return out;
}

/** Read up to `byteCap` bytes from a stream and decode as UTF-8. */
export async function readStreamTextCapped(
  stream: Readable,
  byteCap: number,
): Promise<{ text: string; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (total + buf.length >= byteCap) {
      chunks.push(buf.subarray(0, byteCap - total));
      truncated = true;
      if (typeof (stream as { destroy?: () => void }).destroy === "function") {
        (stream as { destroy: () => void }).destroy();
      }
      break;
    }
    chunks.push(buf);
    total += buf.length;
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}

/** Build resolver deps from an asset lookup + a storage service. */
export function createRuntimeAttachmentDeps(
  getAssetById: (assetId: string) => Promise<ResolvedAsset | null>,
  storage: { getObject: (companyId: string, objectKey: string) => Promise<{ stream: Readable }> },
): RuntimeAttachmentDeps {
  return {
    getAsset: getAssetById,
    readObjectText: async (companyId, objectKey, byteCap) => {
      const obj = await storage.getObject(companyId, objectKey);
      return readStreamTextCapped(obj.stream, byteCap);
    },
  };
}

/**
 * Render resolved attachments into a text block for the turn. Text-readable
 * content is embedded; non-readable files get an honest one-line disclosure so
 * the model never assumes it "saw" an image it only received a filename for.
 */
export function formatRuntimeAttachmentBlock(
  attachments: readonly RuntimeAttachment[],
): string | null {
  if (attachments.length === 0) return null;

  const parts: string[] = ["--- Attached files ---"];
  for (const a of attachments) {
    const name = a.filename || a.assetId;
    if (a.capability === "text-readable" && a.text != null) {
      const note = a.truncated ? " (truncated)" : "";
      parts.push(`\n[${name}]${note}\n${a.text}`);
    } else {
      const kind = a.capability === "vision-readable" ? "image" : "file";
      parts.push(`\n[${name}] — ${kind} attached; stored but not readable by this runtime.`);
    }
  }
  return parts.join("\n");
}
