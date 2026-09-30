import type { StorageProvider as StorageProviderId } from "@armyofagents/shared";
import type { Readable } from "node:stream";

export interface PutObjectInput {
  objectKey: string;
  body: Buffer;
  contentType: string;
  contentLength: number;
}

export interface GetObjectInput {
  objectKey: string;
}

export interface GetObjectResult {
  stream: Readable;
  contentType?: string;
  contentLength?: number;
  etag?: string;
  lastModified?: Date;
}

export interface HeadObjectResult {
  exists: boolean;
  contentType?: string;
  contentLength?: number;
  etag?: string;
  lastModified?: Date;
  /** The object's stored SHA256 checksum, hex-encoded, when the store supplies one
   * (S3/MinIO `x-amz-checksum-sha256`, which is base64 on the wire — providers
   * normalize to hex here). Undefined when the store cannot supply a checksum;
   * DAT-002 commit fails closed rather than commit an unverifiable hash. */
  checksumSha256?: string;
}

/** DAT-002 — the input to a scoped, presigned direct-to-store transfer grant.
 * `checksumSha256` is the expected content hash (hex); `expiresInSeconds` bounds
 * the upload/download window; `maxBytes` is advisory (commit re-verifies size). */
export interface PresignInput {
  objectKey: string;
  expiresInSeconds: number;
  maxBytes: number;
  checksumSha256: string;
  contentType?: string;
}

/** DAT-002 — a minted presigned grant. `url` MUST be https (the frozen grant
 * schema pins it); `headers` are the credential-scrubbed headers the worker must
 * echo on the request. */
export interface PresignResult {
  method: "PUT" | "GET";
  url: string;
  headers: Record<string, string>;
}

export interface StorageProvider {
  id: StorageProviderId;
  putObject(input: PutObjectInput): Promise<void>;
  getObject(input: GetObjectInput): Promise<GetObjectResult>;
  headObject(input: GetObjectInput): Promise<HeadObjectResult>;
  deleteObject(input: GetObjectInput): Promise<void>;
  /** Presign a scoped PUT to `objectKey`. Present ONLY on providers that can issue
   * an https direct-to-store grant (the S3 provider); a provider without it (e.g.
   * `local_disk`) makes the distributed transfer-grant ops fail closed. */
  presignPut?(input: PresignInput): Promise<PresignResult>;
  /** Presign a scoped GET from `objectKey`. See `presignPut`. */
  presignGet?(input: PresignInput): Promise<PresignResult>;
}

export interface PutFileInput {
  companyId: string;
  /**
   * Owning organization. When present, new writes carry the `{organizationId}/{companyId}/…`
   * tenant segment (org grouping + defense-in-depth). Optional/nullable: writers without a
   * resolved org fall back to the legacy company-only prefix, which is still isolated.
   */
  organizationId?: string | null;
  namespace: string;
  originalFilename: string | null;
  contentType: string;
  body: Buffer;
}

export interface PutFileResult {
  provider: StorageProviderId;
  objectKey: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  originalFilename: string | null;
}

export interface PutReservedObjectInput {
  organizationId: string | null;
  companyId: string;
  objectKey: string;
  body: Buffer;
  contentType: string;
  sha256: string;
}

export interface StorageService {
  provider: StorageProviderId;
  putFile(input: PutFileInput): Promise<PutFileResult>;
  putReservedObject(input: PutReservedObjectInput): Promise<void>;
  // Backward-compatible overloads: legacy `(companyId, objectKey)` callers keep working;
  // asset-serving routes pass the request-resolved `(organizationId, companyId, objectKey)`
  // for cross-tenant defense-in-depth.
  getObject(companyId: string, objectKey: string): Promise<GetObjectResult>;
  getObject(
    organizationId: string | null,
    companyId: string,
    objectKey: string,
  ): Promise<GetObjectResult>;
  headObject(companyId: string, objectKey: string): Promise<HeadObjectResult>;
  headObject(
    organizationId: string | null,
    companyId: string,
    objectKey: string,
  ): Promise<HeadObjectResult>;
  deleteObject(companyId: string, objectKey: string): Promise<void>;
  deleteObject(
    organizationId: string | null,
    companyId: string,
    objectKey: string,
  ): Promise<void>;
}
