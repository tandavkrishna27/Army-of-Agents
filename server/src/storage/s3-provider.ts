import {
  S3Client,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from "node:stream";
import type { StorageProvider, GetObjectResult, HeadObjectResult, PresignInput, PresignResult } from "./types.js";
import { notFound, unprocessable } from "../errors.js";

interface S3ProviderConfig {
  bucket: string;
  region: string;
  endpoint?: string;
  /** DAT-002 — the worker-facing https endpoint used ONLY for presigned grant URLs
   * (distinct from `endpoint`, which the control plane uses for headObject/get/put).
   * When absent it falls back to `endpoint`, then the AWS default (https). */
  presignEndpoint?: string;
  prefix?: string;
  forcePathStyle?: boolean;
  credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
}

/** base64 (S3 `x-amz-checksum-sha256`) → hex, so the whole app compares hex sha256
 * digests. Returns undefined for an absent/short value (fail-closed at the caller). */
function base64ChecksumToHex(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const hex = Buffer.from(value, "base64").toString("hex");
  return hex.length === 64 ? hex : undefined;
}

function normalizePrefix(prefix: string | undefined): string {
  if (!prefix) return "";
  return prefix
    .trim()
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function buildKey(prefix: string, objectKey: string): string {
  if (!prefix) return objectKey;
  return `${prefix}/${objectKey}`;
}

async function toReadableStream(body: unknown): Promise<Readable> {
  if (!body) throw notFound("Object not found");
  if (body instanceof Readable) return body;

  const candidate = body as {
    transformToWebStream?: () => ReadableStream<Uint8Array>;
    arrayBuffer?: () => Promise<ArrayBuffer>;
  };

  if (typeof candidate.transformToWebStream === "function") {
    const webStream = candidate.transformToWebStream();
    const reader = webStream.getReader();
    return Readable.from((async function* () {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) yield value;
      }
    })());
  }

  if (typeof candidate.arrayBuffer === "function") {
    const buffer = Buffer.from(await candidate.arrayBuffer());
    return Readable.from(buffer);
  }

  throw unprocessable("Unsupported S3 body stream type");
}

function toDate(value: Date | undefined): Date | undefined {
  return value instanceof Date ? value : undefined;
}

export function createS3StorageProvider(config: S3ProviderConfig): StorageProvider {
  const bucket = config.bucket.trim();
  const region = config.region.trim();
  if (!bucket) throw unprocessable("S3 storage bucket is required");
  if (!region) throw unprocessable("S3 storage region is required");

  const prefix = normalizePrefix(config.prefix);
  // A BLANK endpoint means UNSET (use the AWS default host), not a literal ""
  // endpoint. Without this coercion an empty AOA_STORAGE_S3_ENDPOINT / _PRESIGN_
  // ENDPOINT (the AWS, non-MinIO case) reaches `assertPresignHttps` below as ""
  // and is rejected as "not https" — turning every artifact-transfer grant into a
  // 422/503 even though the AWS default host IS https. Only coerce blank; a real
  // non-https endpoint (e.g. "http://…") must still fail closed.
  const endpoint = config.endpoint?.trim() || undefined;
  const client = new S3Client({
    region,
    endpoint,
    forcePathStyle: Boolean(config.forcePathStyle),
    ...(config.credentials ? { credentials: config.credentials } : {}),
  });

  // DAT-002 — a SEPARATE client bound to the worker-facing presign endpoint so a
  // minted grant URL points at a worker-reachable https host, never the control
  // plane's internal endpoint. Resolution: presignEndpoint → endpoint → AWS default.
  const presignEndpoint = config.presignEndpoint?.trim() || endpoint;
  const presignClient = new S3Client({
    region,
    endpoint: presignEndpoint,
    forcePathStyle: Boolean(config.forcePathStyle),
    ...(config.credentials ? { credentials: config.credentials } : {}),
  });

  function assertPresignHttps(): void {
    // The frozen grant `url` is strictly https. A defined non-https presign endpoint
    // cannot yield a conformant grant, so fail closed early with a clear error
    // (an undefined endpoint means the AWS default host, which is https).
    if (presignEndpoint !== undefined && !presignEndpoint.startsWith("https://")) {
      throw unprocessable("S3 presign endpoint must be https to mint a worker grant");
    }
  }

  async function presign(
    method: "PUT" | "GET",
    input: PresignInput,
  ): Promise<PresignResult> {
    assertPresignHttps();
    const key = buildKey(prefix, input.objectKey);
    const command = method === "PUT"
      ? new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          // Bind a SHA256 checksum requirement into the signed PUT: the store computes
          // + records the actual object checksum, which DAT-002 commit re-verifies
          // against the manifest hash via headObject.
          ChecksumAlgorithm: "SHA256",
          ...(input.contentType ? { ContentType: input.contentType } : {}),
        })
      : new GetObjectCommand({ Bucket: bucket, Key: key });
    // aws-sdk packages resolve slightly different @smithy/types versions across the
    // client + presigner, so the structurally-identical S3Client/Command types are
    // nominally incompatible. Narrow the cast to the presigner's expected param types.
    const url = await getSignedUrl(
      presignClient as unknown as Parameters<typeof getSignedUrl>[0],
      command as unknown as Parameters<typeof getSignedUrl>[1],
      { expiresIn: input.expiresInSeconds },
    );
    if (!url.startsWith("https://")) {
      throw unprocessable("presigned URL must be https");
    }
    return { method, url, headers: {} };
  }

  return {
    id: "s3",

    async presignPut(input: PresignInput): Promise<PresignResult> {
      return presign("PUT", input);
    },

    async presignGet(input: PresignInput): Promise<PresignResult> {
      return presign("GET", input);
    },

    async putObject(input) {
      const key = buildKey(prefix, input.objectKey);
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: input.body,
          ContentType: input.contentType,
          ContentLength: input.contentLength,
        }),
      );
    },

    async getObject(input): Promise<GetObjectResult> {
      const key = buildKey(prefix, input.objectKey);
      try {
        const output = await client.send(
          new GetObjectCommand({
            Bucket: bucket,
            Key: key,
          }),
        );

        return {
          stream: await toReadableStream(output.Body),
          contentType: output.ContentType,
          contentLength: output.ContentLength,
          etag: output.ETag,
          lastModified: toDate(output.LastModified),
        };
      } catch (err) {
        const code = (err as { name?: string }).name;
        if (code === "NoSuchKey" || code === "NotFound") throw notFound("Object not found");
        throw err;
      }
    },

    async headObject(input): Promise<HeadObjectResult> {
      const key = buildKey(prefix, input.objectKey);
      try {
        const output = await client.send(
          new HeadObjectCommand({
            Bucket: bucket,
            Key: key,
            // Ask the store to return the stored SHA256 checksum so DAT-002 commit
            // can verify content integrity without re-reading the bytes.
            ChecksumMode: "ENABLED",
          }),
        );

        return {
          exists: true,
          contentType: output.ContentType,
          contentLength: output.ContentLength,
          etag: output.ETag,
          lastModified: toDate(output.LastModified),
          checksumSha256: base64ChecksumToHex(output.ChecksumSHA256),
        };
      } catch (err) {
        const code = (err as { name?: string }).name;
        if (code === "NoSuchKey" || code === "NotFound") return { exists: false };
        throw err;
      }
    },

    async deleteObject(input): Promise<void> {
      const key = buildKey(prefix, input.objectKey);
      await client.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: key,
        }),
      );
    },
  };
}
