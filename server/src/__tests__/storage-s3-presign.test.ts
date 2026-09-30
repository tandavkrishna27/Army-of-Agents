import { describe, expect, it } from "vitest";
import { createS3StorageProvider } from "../storage/s3-provider.js";

// DAT-002 slice 1 — S3 presign capability (unit).
//
// The frozen artifact grant `url` is strictly `^https://\S+$`, so every presigned
// URL a grant carries MUST be https. These tests prove the S3 provider mints a
// scoped, expiring, checksum-bound https URL against a worker-facing presign
// endpoint, honors path-style for MinIO, and FAILS CLOSED when the presign
// endpoint is not https. No network: getSignedUrl only signs.

const DUMMY_CREDS = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
const KEY = "organizations/org-1/jobs/job-1/attempts/1/out.bin";
const SHA = "a".repeat(64);

describe("S3 storage provider presign (DAT-002)", () => {
  it("presignPut mints a scoped, expiring, checksum-bound https PUT url", async () => {
    const provider = createS3StorageProvider({
      bucket: "aoa-artifacts",
      region: "us-east-1",
      endpoint: "https://internal.minio.local:9000",
      presignEndpoint: "https://worker.minio.example:9000",
      forcePathStyle: true,
      credentials: DUMMY_CREDS,
    });
    expect(typeof provider.presignPut).toBe("function");
    const grant = await provider.presignPut!({
      objectKey: KEY,
      expiresInSeconds: 300,
      maxBytes: 1024,
      checksumSha256: SHA,
      contentType: "application/octet-stream",
    });
    expect(grant.method).toBe("PUT");
    expect(grant.url.startsWith("https://")).toBe(true);
    // worker-facing presign host, NOT the internal endpoint.
    expect(grant.url).toContain("worker.minio.example");
    expect(grant.url).not.toContain("internal.minio.local");
    // path-style → the bucket is in the path, and the object key is present.
    expect(grant.url).toContain("/aoa-artifacts/");
    expect(grant.url).toContain("attempts/1/out.bin");
    // signed + expiring.
    expect(grant.url).toContain("X-Amz-Expires=300");
    expect(grant.url).toContain("X-Amz-Signature=");
    // SHA256 checksum requirement is bound into the signed request.
    expect(grant.url.toLowerCase()).toContain("checksum");
  });

  it("presignGet mints a scoped, expiring https GET url", async () => {
    const provider = createS3StorageProvider({
      bucket: "aoa-artifacts",
      region: "us-east-1",
      presignEndpoint: "https://worker.minio.example:9000",
      forcePathStyle: true,
      credentials: DUMMY_CREDS,
    });
    const grant = await provider.presignGet!({
      objectKey: KEY,
      expiresInSeconds: 120,
      maxBytes: 1024,
      checksumSha256: SHA,
    });
    expect(grant.method).toBe("GET");
    expect(grant.url.startsWith("https://")).toBe(true);
    expect(grant.url).toContain("attempts/1/out.bin");
    expect(grant.url).toContain("X-Amz-Expires=120");
  });

  it("honors a configured object-key prefix in the signed key", async () => {
    const provider = createS3StorageProvider({
      bucket: "aoa-artifacts",
      region: "us-east-1",
      prefix: "tenants",
      presignEndpoint: "https://worker.minio.example:9000",
      forcePathStyle: true,
      credentials: DUMMY_CREDS,
    });
    const grant = await provider.presignPut!({
      objectKey: KEY,
      expiresInSeconds: 300,
      maxBytes: 1024,
      checksumSha256: SHA,
    });
    expect(grant.url).toContain("/aoa-artifacts/tenants/organizations/");
  });

  it("fails closed when the presign endpoint is not https", async () => {
    const provider = createS3StorageProvider({
      bucket: "aoa-artifacts",
      region: "us-east-1",
      presignEndpoint: "http://worker.minio.example:9000",
      forcePathStyle: true,
      credentials: DUMMY_CREDS,
    });
    await expect(
      provider.presignPut!({ objectKey: KEY, expiresInSeconds: 300, maxBytes: 1024, checksumSha256: SHA }),
    ).rejects.toThrow(/https/i);
  });

  it("treats a BLANK endpoint/presignEndpoint as unset (AWS default https), not a '' endpoint", async () => {
    // Regression for the staging artifact-transfer-grant 503: on AWS (non-MinIO)
    // AOA_STORAGE_S3_ENDPOINT / _PRESIGN_ENDPOINT are empty, so a "" reached the
    // provider and assertPresignHttps rejected the valid AWS-default presign as
    // "not https" (errStatus 422). A blank endpoint MUST mean unset, not "".
    for (const blank of ["", "   "]) {
      const provider = createS3StorageProvider({
        bucket: "aoa-e7-canary-artifacts",
        region: "us-east-1",
        endpoint: blank,
        presignEndpoint: blank,
        forcePathStyle: true,
        credentials: DUMMY_CREDS,
      });
      const grant = await provider.presignGet!({
        objectKey: KEY,
        expiresInSeconds: 120,
        maxBytes: 1024,
        checksumSha256: SHA,
      });
      expect(grant.method).toBe("GET");
      expect(grant.url.startsWith("https://")).toBe(true);
      expect(grant.url).toContain("amazonaws.com");
      expect(grant.url).toContain("attempts/1/out.bin");
    }
  });
});
