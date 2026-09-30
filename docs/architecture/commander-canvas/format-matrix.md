> Current scope authority: [master scope](master-scope.md). Source revisions, tests and unresolved integration dependencies: [code evidence](code-evidence.md). This companion describes planned behavior unless explicitly evidenced.

# Canvas file coverage and artifact pipeline

Research date: September 10, 2026. Proposed coverage, not a promise of universal native editing. The initial research ran no converter fixtures. The follow-up ran the existing DOCX/XLSX, Office-limit and viewer tests recorded in code-evidence.md; broad conversion, export and codec coverage remains untested. Existing source inspected: `ui/src/components/viewers/viewer-registry.ts`, which declares text/code/JSON/table/image/video/audio/PDF/HTML/SVG/Mermaid/canvas/DOCX/XLSX/download kinds. Its DOCX/XLSX path references server-rendered sanitized HTML. Registry presence does not prove full format fidelity, model understanding or export support.

## Coverage matrix

### Source-to-capability crosswalk

This follow-up traced renderer implementations as well as registry declarations. Status means code present, not runtime certification. Searches for generators were bounded to the inspected application services and manifests; agents or external plugins may produce files through other routes.

| Capability | Existing implementation evidence | Implementation disposition |
|---|---|---|
| Markdown, code, JSON, CSV/TSV | `SharedContentViewer.tsx`, `csv-parse.ts`, registry and viewer tests | Reuse; extend virtualization, large-file handling and context projection. Plain-text generation can use worker outputs, but validate typed output and ingestion rather than assuming every agent writes valid files. |
| HTML, SVG, Mermaid | Shared viewer contains sandbox renderers and Mermaid loading; UI manifest includes Mermaid | Reuse render paths after security/version audit. Existing HTML preview is not the newly proposed privileged capability bridge. |
| Raster images | Shared viewer uses an image element | Reuse browser-decodable display; add conversion/thumbnail worker for unsupported formats and large assets. No universal image decoding follows from an image MIME match. |
| Audio/video | Shared viewer uses native media elements | Reuse native playback. Add codec probing/transcoding, captions and time-based context adapters. No dedicated media generation service was established in the scoped service search. |
| PDF | `PdfDocumentViewer.tsx`, `PdfDocumentRenderer.tsx`; UI manifest includes PDF.js | Reuse display, audit large/scanned/encrypted cases; OCR and extraction require separate capability mapping. |
| DOCX | `server/src/services/docx-render.ts`, Mammoth dependency, server-rendered HTML UI | Reuse sanitized content preview. Native editing/export and page-fidelity preview are separate additions. |
| XLSX | `server/src/services/xlsx-render.ts` imports ExcelJS and sanitizes output | Reuse bounded preview; displayed caps are 12 sheets, 1000 rows and 50 columns per sheet. Whole workbook parsing is input-size bounded. Do not claim formula recalculation or complete workbook fidelity. Prefer extending ExcelJS usage over adding SheetJS without a demonstrated gap. |
| Office render routing | `ServerRenderedHtmlView.tsx`; `memory-asset-render.ts` imports shared DOCX/XLSX renderers; registry references asset render endpoint | Reuse shared conversion helpers and preserve authorization. Follow-up source trace found the generic /assets/:assetId/render route in server/src/routes/assets.ts with asset company authorization and shared render helpers. Integration tests for future canvas/private access remain required. |
| Presentation files | No PPTX viewer kind in inspected registry; no dedicated generator found in scoped service search | Add slide preview conversion and native-file generation adapter. Candidate conversion is isolated LibreOffice; choose and verify a dedicated writer separately. |
| Legacy/OpenDocument formats | Current office render paths explicitly target DOCX/XLSX | New conversion/parser adapters; retain download fallback. Not covered merely because files are office documents. |
| Draw.io/Excalidraw and specialist diagrams | Mermaid/SVG exist; structured diagram-specific parser not established | New dedicated adapters or source/download fallback. |
| Archives, EPUB, EML/MSG/ICS, specialist binaries | No dedicated kind in inspected shared viewer registry | Explicit fallback now; dedicated inspection adapters when advertised. Acceptance/storage still follows upload policy, not universal unrestricted upload. |
| Generated charts/tools | Shared viewer has a canvas kind | Audit its schema before reuse; do not equate that kind with the proposed extensible interactive-tool runtime. New registry/state/action bridge remains necessary. |

**Generation ownership:** agents/workers may produce canonical files through governed outputs; model-provider adapters are needed specifically for generative image/audio/video capabilities. Office/text/chart export can be deterministic libraries rather than an external AI provider. File creation, successful native-file validation and visual preview are independent acceptance stages. No new generation provider was selected by this crosswalk.

**Build groups:** reuse shared viewers first; extend office/media/large-file rendering second; implement missing format adapters and generated-tool bridge as distinct capabilities; add provider-based media generation through governed jobs. These are dependency groups, not finalized release assignments.

All acceptance is subject to validated type, size and company policy. Preserve the original bytes. Preview, semantic extraction and generation are independently versioned capabilities.

| Family / representative formats | Understanding and preview plan | Creation/edit/export boundary |
|---|---|---|
| Text/code: TXT, MD, source files, logs | Bounded text/code viewer; encoding handling, search and line references | Text generation and versioned editing; never execute uploaded scripts automatically |
| Structured data: JSON, YAML, XML, CSV, TSV | Schema-aware inspection and virtualized tables; reject unsafe parser features | Export structured files; prevent accidental spreadsheet formula execution on text export |
| PDF, scanned documents | PDF viewer, text extraction; OCR separately for scans with page provenance | Generate PDF; annotation is not arbitrary faithful PDF editing; signatures require explicit preservation handling |
| Documents: DOCX, ODT, legacy DOC, RTF | Existing DOCX preview first; isolated conversion for other formats; note font/layout limitations | Generate supported native files with dedicated writers; revision fidelity tested against tables, footnotes and tracked changes |
| Spreadsheets: XLSX, XLS, XLSB, ODS, XLSM | Existing XLSX path plus parser adapters; sheet/cell views, formula and cached-value distinction | Workbook export with explicit supported features; importing formulas does not guarantee recalculation, pivot or macro support; macros never auto-run |
| Presentations: PPTX, PPT, ODP | Slide thumbnails/PDF derivative plus text/notes extraction | Dedicated presentation writer; native editable PPTX output where supported. PDF previews do not preserve animation or prove editable deck generation |
| Raster images: PNG, JPEG, WebP, GIF, AVIF, TIFF; HEIC/RAW | Native display or converted derivative; orientation, multi-frame/page handling; vision/OCR separate | Export supported raster formats; generation/edit provider capability separate; HEIC/RAW require explicitly available codecs |
| Vector/diagrams: SVG, Mermaid, draw.io, Excalidraw | Sanitized SVG; strict Mermaid renderer; dedicated adapters for structured diagram formats | Retain editable source plus image/PDF export; do not flatten the only copy |
| Charts | Versioned chart specification and source data; interactive renderer | Export data/spec and SVG/PNG/PDF where supported; an image alone is not an editable chart |
| Audio: WAV, MP3, M4A/AAC, OGG/Opus, FLAC | Codec-probed playback or derivative; transcript with timestamps via selected provider | Speech generation and media transforms are separate; support actual codec/container combinations |
| Video: MP4, WebM, MOV, MKV, AVI | Probe codecs, create playable derivative/poster; captions/transcript and selected frame understanding separately | Transcoding/trimming is not generative video. Generative creation needs a distinct provider/worker; preserve original and timed provenance |
| Captions: SRT, VTT | Text/timeline view associated with media | Export subtitle files and explicit conversion; preserve timing |
| Archives: ZIP, TAR, GZ, 7Z | List manifest; selectively unpack in bounded sandbox; inherited permission on extracted files | Package authorized artifacts; no automatic execution; bound nesting, expansion ratio and paths |
| Email/calendar files: EML, MSG, ICS | Dedicated parsing/sanitized preview candidates; attachments tracked separately | File export is distinct from sending mail or syncing calendars; connectors remain separate workstreams |
| Books: EPUB | Text/metadata and reader adapter candidate | Supported export/conversion only; protected content may be unavailable |
| Specialist: PSD/AI/INDD, CAD, 3D, notebooks, Parquet, database files | Dedicated future adapter or bounded metadata/source inspection; external-open/download fallback | No blanket native editing promise. Notebook code does not run on preview; database files are not connected automatically |
| Unknown/encrypted/damaged files | Explain unsupported, locked or invalid state; preserve allowed original for download | No guessed preview or silent destructive conversion. Password entry requires a dedicated transient handling flow |

## Candidate components and primary evidence

- [PDF.js](https://mozilla.github.io/pdf.js/getting_started/) for PDF display; OCR and semantic extraction remain separate.
- [LibreOffice conversion](https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html) for isolated Office/OpenDocument preview conversion. Font and feature fidelity must be tested; it is not a guarantee of Microsoft Office parity.
- [SheetJS formats](https://docs.sheetjs.com/docs/miscellany/formats/) for spreadsheet parsing/writing evaluation. [Formula documentation](https://docs.sheetjs.com/docs/csf/features/formulae/) distinguishes stored formulas from calculation capability; do not promise spreadsheet-engine behavior from a parser.
- [Sharp input formats](https://sharp.pixelplumbing.com/api-constructor/) for image derivatives. Deployment codecs and pixel limits govern effective support.
- [FFmpeg formats](https://www.ffmpeg.org/ffmpeg-formats.html) and [codecs](https://www.ffmpeg.org/ffmpeg-codecs.html) for audio/video probing and conversion. Build availability, licensing review and browser playback support must be checked for chosen codecs.
- [Apache Tika format catalog](https://tika.apache.org/3.2.2/formats.html) as a broad extraction adapter candidate, not a visual renderer or universal generator. Pin a supported maintained release after dependency review; the cited catalog is version-specific.
- [Mermaid strict configuration](https://mermaid.js.org/config/schema-docs/config-properties-securitylevel.html) for diagrams. Generated content cannot lower host security settings.

These are candidates to compare against existing dependencies before adding packages. Specialist-format entries are architectural coverage/fallback decisions, not researched production adapter selections.

## Ingestion and result lifecycle

Validate upload identity/limits and inspect actual content type, not just extension. Store original with content hash, source/provenance, actor/company scope and immutable version. Dispatch bounded extraction, preview and optional transcoding jobs through governed execution. Maintain separate status for upload, validation, extraction, preview and generation. Derived files inherit source authorization and link to converter version and input hash.

Retry an individual failed stage idempotently; do not regenerate the canonical artifact because its preview failed. Large transfers require resumable/multipart handling, cancellation and quotas; large previews use pagination, tiling or range playback. Converted files must retain visible fidelity limitations. Extraction output is untrusted context, not agent instructions.

Run complex parsers/converters with bounded memory/time/storage, restricted network and no macro execution. Handle archive traversal/bombs, malformed images, remote document resources and formula-injection explicitly. File storage support is subject to policy; it does not imply every arbitrary executable should be previewed.

## Acceptance evidence

Use representative fixtures per advertised format: valid, malformed, oversized, encrypted, missing fonts, Unicode/RTL, embedded objects and unsupported features. Verify original-byte retention, extraction provenance, preview fidelity, authorized download, derived-file access, stage retries and native export reopening. Media tests cover codec/container mismatch and long files; spreadsheet tests distinguish formulas, cached results and actual recalculation. Unsupported files must degrade clearly instead of disappearing.

Next: reconcile this matrix with existing renderer/generator implementations and dependency versions; mark each cell implemented, extension required, provider-dependent or fallback-only before release claims. No promise of every conceivable format is made.
