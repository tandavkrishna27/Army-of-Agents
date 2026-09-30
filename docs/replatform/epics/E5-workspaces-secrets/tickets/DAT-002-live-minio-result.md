# DAT-002 slice-7 — Live-MinIO tier result

**Status:** COMPLETE + Linux-CI-green. The deferred DEC-03 authority proof of DAT-002 (see [`DAT-002-result.md`](DAT-002-result.md) §4 + [`DAT-002-live-minio-design.md`](DAT-002-live-minio-design.md)).
**Proof:** `d1-merge-train` run `31885553697` = `success`, **13/13** on `b27817824`.

## 1. What landed (pure `docker/d1` + compose + harness + test infra — zero server/protocol edits)

The real https presigned PUT/GET round-trip against a **real MinIO-over-TLS** store, driven by the e6f harness on the Linux D1 lane. Slices 1–6 already proved every fail-closed acceptance in-process; this tier is the live authority proof the in-process fakes stood in for.

- **MinIO-over-TLS** — a committed throwaway self-signed cert (`docker/d1/certs/`, SAN `minio,toxiproxy,localhost,127.0.0.1`) mounted into MinIO's certs dir; TLS-aware healthcheck. toxiproxy (L4) forwards the opaque TLS bytes to `minio:9000` unchanged.
- **SigV4 host = connected host** — `AOA_STORAGE_S3_PRESIGN_ENDPOINT=https://toxiproxy:19000` (the exact host the worker dials) + path-style, so the signed authority matches; control-plane `headObject` uses the direct `https://minio:9000`.
- **The presigned-PUT checksum** — the server binds `ChecksumAlgorithm:SHA256` but returns `headers:{}`, so the raw-bytes PUT step-script computes + sends `x-amz-checksum-sha256`; the fenced commit re-verifies it via `headObject`.
- **AWS creds via env chain** (`provider-registry` passes none) + a `checkPresignEndpoint` compose invariant + fixtures.

**Assertion 1 (increment 1):** grant(upload) → real PUT → commit `committed` + persisted `job_artifacts` row; grant(download) → real GET byte-identical.
**Assertion 2 (increment 2):** a runtime `limit_data` toxic (upstream, 64 B) on `worker-to-minio` (via the toxiproxy admin API `:8474`, always removed in a `finally` so it never leaks into a later serial-campaign test) truncates the PUT → commit **rejects fail-closed** (`malformed`|`event_hash_mismatch`) + persists NO row. Proves "incomplete uploads never commit" against a REAL short object.

## 2. Iteration log (Linux-CI-only loop — honest record)

1. **Seed collision** — `seedScenario` hardcoded the globally-unique `companies.issue_prefix='E6F'`; the new `e6f-05` was the second `seedScenario` caller in the campaign → collision. Fixed: derive it per-scenario from the slug (`e48daf9f7`).
2. **`E6F-01` drain flake** — the 100-race "never 5xx" drain intermittently caught a `internal_unavailable` 503. First hypothesis (cross-test contention → `--test-concurrency=1`, `b4cff2f20`) was **wrong** (serial runs `E6F-01` first, before `e6f-05`; a same-commit re-run passed 12/12). **Root cause:** that 503 is a *retryable* backpressure (carries `retryAfterMs`; frozen retryable set) the control-plane emits under the burst — the drain harness wasn't honoring the retry contract, so it was a runner-load flake, not a defect. **Fix (`b27817824`):** `pollOnce` retries a retryable `internal_unavailable`/`throttled` (fresh nonce + device proof, ≤4 attempts, capped 500 ms); a non-retryable 5xx or any 4xx is still an anomaly; compare-and-set `offerLease` preserves exactly-one-winner. The green run confirmed the 503 was transient (the retry cleared it → no control-plane defect).

**Kept:** the serial-campaign change (`--test-concurrency=1`) — a genuine determinism improvement for tests sharing one live control-plane, even though its original "fix contention" rationale was disproved by the re-run.

## 3. Non-goals / notes

- The worker-daemon S3 client consumer is deferred (the tier drives `/api/worker-control/*` from the test-runner directly, as e6f-03 does).
- `docker/d1/minio-init.sh` still targets `http://minio:9000` (unused by the lane; the test self-provisions the bucket) — a harmless parity follow-up.
- Commits: impl `2a7a2b003`, seed-fix `e48daf9f7`, serial `b4cff2f20`, increment 2 `8bd318457`, E6F-01 retry `b27817824`.
