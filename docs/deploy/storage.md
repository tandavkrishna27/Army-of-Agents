---
title: Storage
summary: Local disk vs S3-compatible storage
---

AoA stores uploaded files (issue attachments, images) using a configurable storage provider.

## Local Disk (Default)

Files are stored at:

```
~/.aoa/instances/default/data/storage
```

> Note: existing installs that still have `~/.paperclip/` are read via the legacy fallback in `cli/src/config/home.ts`. On a fresh install, AoA writes only to `~/.aoa/`.

No configuration required. Suitable for local development and single-machine deployments.

## S3-Compatible Storage

For production or multi-node deployments, use S3-compatible object storage (AWS S3, MinIO, Cloudflare R2, etc.).

Configure via CLI:

```sh
pnpm aoa configure --section storage
```

## Configuration

| Provider | Best For |
|----------|----------|
| `local_disk` | Local development, single-machine deployments |
| `s3` | Production, multi-node, cloud deployments |

Storage configuration is stored in the instance config file:

```
~/.aoa/instances/default/config.json
```
