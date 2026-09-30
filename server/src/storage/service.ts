import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { StorageService, StorageProvider, PutFileInput, PutFileResult } from "./types.js";
import { badRequest, forbidden, unprocessable } from "../errors.js";

const MAX_SEGMENT_LENGTH = 120;

function sanitizeSegment(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!cleaned) return "file";
  return cleaned.slice(0, MAX_SEGMENT_LENGTH);
}

function normalizeNamespace(namespace: string): string {
  const normalized = namespace
    .split("/")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => sanitizeSegment(entry));
  if (normalized.length === 0) return "misc";
  return normalized.join("/");
}

function splitFilename(filename: string | null): { stem: string; ext: string } {
  if (!filename) return { stem: "file", ext: "" };
  const base = path.basename(filename).trim();
  if (!base) return { stem: "file", ext: "" };

  const extRaw = path.extname(base);
  const stemRaw = extRaw ? base.slice(0, base.length - extRaw.length) : base;
  const stem = sanitizeSegment(stemRaw);
  const ext = extRaw
    .toLowerCase()
    .replace(/[^a-z0-9.]/g, "")
    .slice(0, 16);
  return {
    stem,
    ext,
  };
}

/**
 * Authoritative object-key access guard. Two key shapes are valid for a company:
 *   - legacy:        `{companyId}/…`
 *   - tenant-scoped: `{organizationId}/{companyId}/…`
 * The company segment is the live isolation boundary (companyId is a globally-unique
 * UUID). When the caller also supplies its resolved `organizationId` (asset-serving
 * routes), the tenant segment of a tenant-scoped key MUST match it — defense-in-depth
 * against cross-tenant reads. Callers without org context (`null`) still get the full
 * company-boundary guarantee, so legacy and tenant-scoped keys remain readable from
 * every path.
 */
function ensureObjectAccess(
  organizationId: string | null,
  companyId: string,
  objectKey: string,
): void {
  if (objectKey.includes("..")) {
    throw badRequest("Invalid object key");
  }
  const segments = objectKey.split("/");
  const legacyMatch = segments[0] === companyId; // {companyId}/…
  const tenantScopedMatch = !legacyMatch && segments[1] === companyId; // {org}/{companyId}/…
  if (legacyMatch) {
    return;
  }
  if (tenantScopedMatch) {
    if (organizationId !== null && segments[0] !== organizationId) {
      throw forbidden("Object does not belong to organization");
    }
    return;
  }
  throw forbidden("Object does not belong to company");
}

/**
 * Normalize the two accepted call shapes to `[organizationId, companyId, objectKey]`:
 *   - `(companyId, objectKey)`                 — legacy, org unknown (null)
 *   - `(organizationId, companyId, objectKey)` — tenant-aware (asset-serving routes)
 */
function resolveObjectArgs(
  a: string | null,
  b: string,
  c?: string,
): [string | null, string, string] {
  if (c === undefined) {
    return [null, a as string, b];
  }
  return [a, b, c];
}

function hashBuffer(input: Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

function buildObjectKey(
  organizationId: string | null,
  companyId: string,
  namespace: string,
  originalFilename: string | null,
): string {
  const ns = normalizeNamespace(namespace);
  const now = new Date();
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  const { stem, ext } = splitFilename(originalFilename);
  const suffix = randomUUID();
  const filename = `${suffix}-${stem}${ext}`;
  // New writes carry the tenant segment when the org is known; otherwise fall back
  // to the legacy company-only prefix (still isolated — companyId is globally unique).
  const prefix = organizationId ? `${organizationId}/${companyId}` : companyId;
  return `${prefix}/${ns}/${year}/${month}/${day}/${filename}`;
}

function assertPutFileInput(input: PutFileInput): void {
  if (!input.companyId || input.companyId.trim().length === 0) {
    throw unprocessable("companyId is required");
  }
  if (!input.namespace || input.namespace.trim().length === 0) {
    throw unprocessable("namespace is required");
  }
  if (!input.contentType || input.contentType.trim().length === 0) {
    throw unprocessable("contentType is required");
  }
  if (!(input.body instanceof Buffer)) {
    throw unprocessable("body must be a Buffer");
  }
  if (input.body.length <= 0) {
    throw unprocessable("File is empty");
  }
}

export function createStorageService(provider: StorageProvider): StorageService {
  return {
    provider: provider.id,

    async putFile(input: PutFileInput): Promise<PutFileResult> {
      assertPutFileInput(input);
      const objectKey = buildObjectKey(
        input.organizationId ?? null,
        input.companyId,
        input.namespace,
        input.originalFilename,
      );
      const byteSize = input.body.length;
      const contentType = input.contentType.trim().toLowerCase();
      await provider.putObject({
        objectKey,
        body: input.body,
        contentType,
        contentLength: byteSize,
      });

      return {
        provider: provider.id,
        objectKey,
        contentType,
        byteSize,
        sha256: hashBuffer(input.body),
        originalFilename: input.originalFilename,
      };
    },

    async getObject(a: string | null, b: string, c?: string) {
      const [organizationId, companyId, objectKey] = resolveObjectArgs(a, b, c);
      ensureObjectAccess(organizationId, companyId, objectKey);
      return provider.getObject({ objectKey });
    },

    async headObject(a: string | null, b: string, c?: string) {
      const [organizationId, companyId, objectKey] = resolveObjectArgs(a, b, c);
      ensureObjectAccess(organizationId, companyId, objectKey);
      return provider.headObject({ objectKey });
    },

    async deleteObject(a: string | null, b: string, c?: string) {
      const [organizationId, companyId, objectKey] = resolveObjectArgs(a, b, c);
      ensureObjectAccess(organizationId, companyId, objectKey);
      await provider.deleteObject({ objectKey });
    },
  };
}
