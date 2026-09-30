# Commander attachment runtime boundary

For operator workflows, see [Work with Commander](../guides/board-operator/commander.md)
and [Compose messages and comments](../guides/board-operator/composer.md). For the
request contract, see the [Commander API](../api/internal-agent.md).

Commander file selection uploads through the authenticated, company-scoped asset
endpoint. The composer represents each completed upload as a typed `asset`
Commander input reference containing the asset ID, filename, content type, byte
size, and governed `/api/assets/:assetId/content` route. That reference is included
in the submitted Commander context and remains in the composer when the request
fails before the server accepts it.

## Runtime delivery v1 — text (implemented 2026-07-15)

The chat request carries structured `attachmentAssetIds`. Before the turn,
`agentLoopService.chat()` resolves them through
`server/src/services/internal-agent/runtime-attachments.ts`:

- **Authorization:** each asset is loaded and dropped unless it belongs to the
  requesting company. A cross-company or missing asset's bytes are never read.
- **Capability** is classified by content type via the shared
  `attachmentRuntimeCapability` (single source of truth for UI + server):
  `text-readable` (text/plain, text/markdown, application/json), `vision-readable`
  (images), or `stored-only` (everything else).
- **Text-readable** files are streamed from storage, UTF-8 decoded up to
  `RUNTIME_ATTACHMENT_TEXT_BYTE_CAP` (32 KB, truncation flagged), and folded into
  the user turn shown to the model — never into the persisted user message row.
  Object keys / host paths are never exposed to the provider; the server reads the
  bytes and injects text.
- **Images and other types** are disclosed honestly ("stored but not readable by
  this runtime") with **no** bytes read — the model never assumes it saw an image.

Delivery is best-effort: any attachment failure leaves the message untouched
rather than failing the turn. Verified live — an agent quoted a sentinel string
that existed only inside an attached `.txt`.

## Not yet delivered (Phase 2)

**Vision** (delivering images to vision-capable adapters) is a later phase; images
remain stored-only with disclosure today. PDF/office extraction is out of scope
until a preview/extraction contract exists.
