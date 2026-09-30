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
}

export interface StorageProvider {
  id: StorageProviderId;
  putObject(input: PutObjectInput): Promise<void>;
  getObject(input: GetObjectInput): Promise<GetObjectResult>;
  headObject(input: GetObjectInput): Promise<HeadObjectResult>;
  deleteObject(input: GetObjectInput): Promise<void>;
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

export interface StorageService {
  provider: StorageProviderId;
  putFile(input: PutFileInput): Promise<PutFileResult>;
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
