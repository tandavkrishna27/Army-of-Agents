import {
  formatCapabilitySchema,
  type FormatCapability,
  type FormatFailure,
} from "@armyofagents/shared";

const MIB = 1024 * 1024;
const capability = (value: FormatCapability): FormatCapability => formatCapabilitySchema.parse(value);

export const UNIVERSE_FORMAT_CAPABILITIES: readonly FormatCapability[] = [
  capability({ id: "bounded-text", version: 1, extensions: ["txt", "md", "log", "js", "ts"], preview: "native", extraction: "text", nativeExport: "original_only", processorId: null, processorBuild: null, maxInputBytes: 2 * MIB, limitations: ["UTF-8 text only", "Preview truncates at the declared limit", "Source is never executed"] }),
  capability({ id: "structured-source", version: 1, extensions: ["json", "yaml", "yml", "xml"], preview: "source_only", extraction: "text", nativeExport: "original_only", processorId: null, processorBuild: null, maxInputBytes: 2 * MIB, limitations: ["Only JSON has a native structured preview", "External entities and custom YAML tags are never resolved"] }),
  capability({ id: "delimited-table", version: 1, extensions: ["csv", "tsv"], preview: "native", extraction: "structured", nativeExport: "original_only", processorId: null, processorBuild: null, maxInputBytes: 15 * MIB, limitations: ["Raw values are displayed", "Formulas are not evaluated"] }),
  capability({ id: "pdf", version: 1, extensions: ["pdf"], preview: "native", extraction: "provider_gated", nativeExport: "original_only", processorId: null, processorBuild: null, maxInputBytes: 50 * MIB, limitations: ["OCR is not available until a worker is qualified", "Locked PDFs remain downloadable originals"] }),
  capability({ id: "docx", version: 1, extensions: ["docx"], preview: "native", extraction: "text", nativeExport: "original_only", processorId: null, processorBuild: null, maxInputBytes: 15 * MIB, limitations: ["Sanitized preview may not preserve all layout", "Macros and active content never execute"] }),
  capability({ id: "legacy-document", version: 1, extensions: ["odt", "doc", "rtf"], preview: "converted", extraction: "provider_gated", nativeExport: "original_only", processorId: "libreoffice-headless", processorBuild: null, maxInputBytes: 50 * MIB, limitations: ["Converter qualification pending", "Original remains downloadable"] }),
  capability({ id: "xlsx", version: 1, extensions: ["xlsx"], preview: "native", extraction: "structured", nativeExport: "original_only", processorId: null, processorBuild: null, maxInputBytes: 15 * MIB, limitations: ["Formulas are not recalculated", "Preview uses cached values when present"] }),
  capability({ id: "legacy-workbook", version: 1, extensions: ["xls", "xlsb", "ods", "xlsm"], preview: "converted", extraction: "provider_gated", nativeExport: "original_only", processorId: "libreoffice-headless", processorBuild: null, maxInputBytes: 50 * MIB, limitations: ["Converter qualification pending", "Macros never execute"] }),
  capability({ id: "slides", version: 1, extensions: ["pptx", "ppt", "odp"], preview: "converted", extraction: "provider_gated", nativeExport: "original_only", processorId: "libreoffice-headless", processorBuild: null, maxInputBytes: 50 * MIB, limitations: ["Converter qualification pending", "Animations and embedded media are not reproduced"] }),
  capability({ id: "browser-image", version: 1, extensions: ["png", "jpg", "jpeg", "webp", "gif", "avif"], preview: "native", extraction: "none", nativeExport: "original_only", processorId: null, processorBuild: null, maxInputBytes: 50 * MIB, limitations: ["Decode is bounded by browser capability", "Animation remains user-controlled"] }),
  capability({ id: "special-image", version: 1, extensions: ["tiff", "tif", "heic", "raw"], preview: "converted", extraction: "none", nativeExport: "original_only", processorId: "image-derivative-worker", processorBuild: null, maxInputBytes: 50 * MIB, limitations: ["Codec qualification pending", "Original remains downloadable"] }),
  capability({ id: "safe-diagram-source", version: 1, extensions: ["svg", "mmd", "mermaid"], preview: "native", extraction: "text", nativeExport: "original_only", processorId: null, processorBuild: null, maxInputBytes: 2 * MIB, limitations: ["Scripts, foreignObject, external URLs and click handlers are removed"] }),
  capability({ id: "design-source", version: 1, extensions: ["drawio", "excalidraw"], preview: "source_only", extraction: "structured", nativeExport: "original_only", processorId: "design-schema-adapter", processorBuild: null, maxInputBytes: 15 * MIB, limitations: ["Adapter qualification pending", "External images and fonts are unavailable"] }),
  capability({ id: "browser-audio", version: 1, extensions: ["wav", "mp3", "m4a", "aac", "ogg", "opus", "flac"], preview: "source_only", extraction: "provider_gated", nativeExport: "original_only", processorId: "ffmpeg-media-worker", processorBuild: null, maxInputBytes: 50 * MIB, limitations: ["Playback depends on an explicit browser codec probe", "Transcoding and transcription are unavailable until qualified"] }),
  capability({ id: "browser-video", version: 1, extensions: ["mp4", "webm", "mov", "mkv", "avi"], preview: "source_only", extraction: "provider_gated", nativeExport: "original_only", processorId: "ffmpeg-media-worker", processorBuild: null, maxInputBytes: 50 * MIB, limitations: ["Playback depends on an explicit browser codec probe", "Poster generation is unavailable until qualified"] }),
  capability({ id: "captions", version: 1, extensions: ["srt", "vtt"], preview: "source_only", extraction: "structured", nativeExport: "original_only", processorId: null, processorBuild: null, maxInputBytes: 2 * MIB, limitations: ["Timing is validated but never rewritten automatically"] }),
  capability({ id: "archive", version: 1, extensions: ["zip", "tar", "gz", "7z"], preview: "download_only", extraction: "provider_gated", nativeExport: "original_only", processorId: "archive-manifest-worker", processorBuild: null, maxInputBytes: 50 * MIB, limitations: ["No extraction on open", "Symlinks, traversal and nested archives are denied"] }),
  capability({ id: "message-calendar", version: 1, extensions: ["eml", "msg", "ics"], preview: "download_only", extraction: "provider_gated", nativeExport: "original_only", processorId: "message-parser-worker", processorBuild: null, maxInputBytes: 50 * MIB, limitations: ["Parser qualification pending", "Remote pixels, sending and calendar synchronization are disabled"] }),
  capability({ id: "epub", version: 1, extensions: ["epub"], preview: "download_only", extraction: "provider_gated", nativeExport: "original_only", processorId: "epub-reader-worker", processorBuild: null, maxInputBytes: 50 * MIB, limitations: ["Reader qualification pending", "Active scripts and remote resources are disabled"] }),
  capability({ id: "specialized-original", version: 1, extensions: ["psd", "ai", "indd", "dwg", "dxf", "obj", "gltf", "glb", "ipynb", "parquet", "db", "sqlite"], preview: "download_only", extraction: "none", nativeExport: "original_only", processorId: null, processorBuild: null, maxInputBytes: 50 * MIB, limitations: ["No qualified native preview", "Notebooks never execute and databases never auto-connect"] }),
] as const;

const extensionIndex = new Map<string, FormatCapability>();
for (const entry of UNIVERSE_FORMAT_CAPABILITIES) {
  for (const extension of entry.extensions) {
    if (extensionIndex.has(extension)) throw new Error(`Duplicate Universe format extension: ${extension}`);
    extensionIndex.set(extension, entry);
  }
}

const DENIED_EXTENSIONS = new Set(["exe", "dll", "bat", "cmd", "com", "msi", "ps1", "sh"]);
const UNKNOWN = capability({ id: "unknown", version: 1, extensions: ["unknown"], preview: "download_only", extraction: "none", nativeExport: "original_only", processorId: null, processorBuild: null, maxInputBytes: 50 * MIB, limitations: ["No qualified preview", "Original download only"] });

export interface FormatResolution {
  capability: FormatCapability;
  previewReady: boolean;
  downloadAllowed: boolean;
  failure: FormatFailure | null;
}

function extensionOf(filename: string): string {
  const clean = filename.trim().toLowerCase();
  const index = clean.lastIndexOf(".");
  return index >= 0 && index < clean.length - 1 ? clean.slice(index + 1) : "";
}

export function resolveFormatCapability(
  input: { filename: string; contentType?: string | null; sniffedContentType?: string | null },
  options: { qualifiedProcessors?: Readonly<Record<string, string>> } = {},
): FormatResolution {
  const extension = extensionOf(input.filename);
  if (DENIED_EXTENSIONS.has(extension)) {
    return { capability: UNKNOWN, previewReady: false, downloadAllowed: false, failure: "denied" };
  }
  const selected = extensionIndex.get(extension);
  if (!selected) return { capability: UNKNOWN, previewReady: false, downloadAllowed: true, failure: "unsupported" };
  const processorReady = !selected.processorId || (
    selected.processorBuild !== null &&
    options.qualifiedProcessors?.[selected.processorId] === selected.processorBuild
  );
  const previewReady = (selected.preview === "native" || selected.preview === "source_only") && processorReady;
  return { capability: selected, previewReady, downloadAllowed: true, failure: previewReady ? null : "unsupported" };
}

