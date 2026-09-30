# DAT-002 slice-7 — Live-MinIO integration tier (design)

**Status:** DESIGN. The deferred slice-7 of DAT-002 (see [`DAT-002-design.md`](DAT-002-design.md) §slice 7 + [`DAT-002-result.md`](DAT-002-result.md) §4). This is the DEC-03 Linux-CI authority proof that the frozen **https** presigned-PUT/GET round-trip works against a **real MinIO-over-TLS** store — slices 1–6 already prove all fail-closed acceptance in-process.
**Terrain-mapped** (`wf_02107a49-396`, 4 readers → synth); every load-bearing claim orchestrator-re-verified against `C:/e3`.

## 0. Framing (verified)
Slice 7 is **pure `docker/d1` + compose + CI + e6f-harness + test infra — ZERO server-code, ZERO worker-protocol edits.** The server side (s3-provider presign, artifact-transfer-grant, artifact-commit, config vars) is already built + merged (slices 1–6). The e6f harness already mints the full fenced 13-field worker identity (`seedScenario → enroll → poll → ack → active lease`). Validated **Linux-CI-only** (the `foundation` d1-merge-train lane, `AOA_D1_LIVE=1`), so land in 2 increments to keep each slow iteration's blast radius small.

## 1. The three hard facts (re-verified)
- **MinIO-over-TLS is mandatory.** The grant `url` is `httpsUrlSchema` and `presign` fails closed on non-https (`s3-provider.ts:109,139`). MinIO serves HTTPS on :9000 when `public.crt`+`private.key` sit in `/root/.minio/certs/`. toxiproxy is L4 → forwards **opaque TLS bytes** to upstream `minio:9000` (unchanged; `EXPECTED_TOXIPROXY_UPSTREAMS` asserts exactly `minio:9000`, so no `toxiproxy.json` edit).
- **SigV4 host must equal the connected host.** Workers reach S3 only via `toxiproxy:19000`. So `AOA_STORAGE_S3_PRESIGN_ENDPOINT=https://toxiproxy:19000` (the exact host:port the PUT/GET dials) + **path-style** (`AOA_STORAGE_S3_FORCE_PATH_STYLE=true`) so the Host stays literally `toxiproxy:19000`. Cert SAN must include `DNS:toxiproxy` (+ `DNS:minio` for the control-plane's direct `headObject`, + `DNS:localhost,IP:127.0.0.1` for the container healthcheck).
- **★ The checksum header (HIGHEST RISK).** `presign` binds `ChecksumAlgorithm:"SHA256"` (`s3-provider.ts:127`) but returns `headers:{}` (:142). So the presigned PUT URL carries `x-amz-sdk-checksum-algorithm=SHA256` in its query, and the **raw-bytes PUT step-script MUST compute + send `x-amz-checksum-sha256: base64(sha256(body))`** (and `x-amz-sdk-checksum-algorithm: SHA256`) as request headers, or MinIO rejects the PUT. Commit *depends* on it: `headObject` reads the stored `ChecksumSHA256` and fails closed if absent. This is the single most likely thing to break the first CI run — nail it, and inspect the minted `grant.url` query on the first run if it 400s.

## 2. Credentials + config (re-verified)
`provider-registry.ts:11-18` passes **no `credentials`** → the SDK uses the env chain, so control-plane needs `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` = MinIO root creds (`aoa-d1`/`aoa-d1-secret`). Config reads `AOA_STORAGE_S3_*` (config.ts:158-183); the compose's current `AOA_S3_ENDPOINT` is **unread** and must be renamed. Bucket default is `paperclip` → set `AOA_STORAGE_S3_BUCKET=aoa-artifacts` explicitly. `AOA_STORAGE_S3_PRESIGN_ENDPOINT` is already documented (`docs/deploy/environment-variables.md:160-161` — brand-check ok, no docs change).

## 3. Keystone constraints (a wrong move kills the static gate)
- **No new compose service** — `checkServiceSet` (`d1-compose-invariants.mjs:142-151`) rejects any service not in `EXPECTED_NETWORKS`. → cert **committed** (`docker/d1/certs/`), bucket **self-provisioned** by the test via control-plane's S3 client (no init container, no cert-gen sidecar).
- **Cert mounts = short-form `.`-prefixed bind, `:ro`** (`checkNoSharedRwVolume` :301+); a named volume for certs is rejected. Two services may share the same ro bind.
- **No network attachment change** (`checkNetworkMatrix`) — TLS is volumes+env only.
- The new `checkPresignEndpoint` invariant must also update the checker's own corpus (`check-d1-compose.test.mjs`: `validCompose()` env + "real compose ZERO violations" + a non-vacuous REJECT fixture with presign `http://…`).
- Test file must be named `tests/d1/e6f-05-*.test.mjs` (the `foundation` glob `e6f-*.test.mjs`, `d1-merge-train.yml:143-145`), gated `AOA_D1_LIVE=1`.

## 4. Increment 1 — TLS MinIO + upload-bypass + download (land CI-green first)
**New:** `docker/d1/certs/public.crt` + `private.key` (self-signed, SAN above; throwaway CI-only, matching the inline throwaway secrets already in the compose); `tests/d1/e6f-05-live-minio.test.mjs`.
**Change:**
- `docker-compose.d1.yml`: **minio** → add `./docker/d1/certs:/root/.minio/certs:ro`, healthcheck → `curl -fsSk https://127.0.0.1:9000/minio/health/live`. **control-plane** → rename `AOA_S3_ENDPOINT`→`AOA_STORAGE_S3_ENDPOINT=https://minio:9000`; add `AOA_STORAGE_PROVIDER=s3`, `AOA_STORAGE_S3_PRESIGN_ENDPOINT=https://toxiproxy:19000`, `AOA_STORAGE_S3_BUCKET=aoa-artifacts`, `AOA_STORAGE_S3_REGION=us-east-1`, `AOA_STORAGE_S3_FORCE_PATH_STYLE=true`, `AWS_ACCESS_KEY_ID=aoa-d1`, `AWS_SECRET_ACCESS_KEY=aoa-d1-secret`, `./docker/d1/certs/public.crt:/certs/ca.crt:ro` + `NODE_EXTRA_CA_CERTS=/certs/ca.crt`. **test-runner** → `NODE_EXTRA_CA_CERTS=/repo/docker/d1/certs/public.crt`.
- `tests/d1/lib/e6f-harness.mjs`: add `artifactTransferGrant(session, {kind, ...fence, objectKey, sha256, sizeBytes})` + `artifactCommit(session, {...fence, manifest})` (clones of `ack()` with the new route + inner body + device proof), and a **raw-bytes PUT/GET step-script emitter** run in `test-runner` via `dexecModule` (PUT sends the body + the `x-amz-checksum-sha256`/`x-amz-sdk-checksum-algorithm` headers).
- `.env.example`: add the `AOA_STORAGE_S3_*` + `AOA_STORAGE_PROVIDER` + `AWS_*` keys.
- `scripts/lib/d1-compose-invariants.mjs` + `scripts/check-d1-compose.test.mjs`: `checkPresignEndpoint` (control-plane must set `AOA_STORAGE_S3_PRESIGN_ENDPOINT` https + `AOA_STORAGE_S3_ENDPOINT` https + provider `s3` + path-style true) + fixtures (valid update + a `http://` presign REJECT).
**Assertions:** (1) grant(upload) → real PUT → commit `committed{artifactId,versionNumber≥1}` + a persisted `job_artifacts` row; (3) grant(download) → real GET returns byte-identical bytes.
**Setup:** the test self-provisions `aoa-artifacts` via control-plane's S3 client (a `dexecModule` on control-plane) before the first grant.

## 5. Increment 2 — toxiproxy incomplete-upload (adds assertion 2 only)
Runtime toxic on `worker-to-minio` via the toxiproxy admin API (`toxiproxy:8474`; `limit_data`/bandwidth) → the PUT writes a short/partial object → `artifactCommit` **rejects on hash/size** (`event_hash_mismatch` for sha, `malformed` for size — the frozen 13-code vocab has no `upload_incomplete`), proving "incomplete uploads never commit" against a REAL short object. No compose/checker change.

## 6. Load-bearing claims — orchestrator re-verified
1. Checksum header required on the presigned PUT — ✓ (`s3-provider.ts:127,142`). 2. Credentials via env chain — ✓ (`provider-registry.ts:11-18`). 3. Config var names + `AOA_S3_ENDPOINT` dead — ✓ (`config.ts:158-183`). 4. `checkServiceSet` forbids new services — ✓ (`d1-compose-invariants.mjs:142-151`). 5. toxiproxy upstream = `minio:9000`, no json edit — ✓ (`:431`). 6. Cert mounts = ro binds ok — ✓ (`checkNoSharedRwVolume`). 7. presign endpoint = `https://toxiproxy:19000` resolves SigV4 host match — ✓ (`s3-provider.ts:97`). 8. `e6f-*` glob + `AOA_D1_LIVE` gate — ✓ (`d1-merge-train.yml:143-145`).

**Non-goals:** the worker-daemon S3 client consumer (the live tier drives `/api/worker-control/*` from the test-runner directly, as e6f-03 does); any server-code or worker-protocol change.
