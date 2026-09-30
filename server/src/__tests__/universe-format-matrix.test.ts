import { describe, expect, it } from "vitest";
import {
  UNIVERSE_FORMAT_CAPABILITIES,
  resolveFormatCapability,
} from "../services/universe-format-registry.js";

const EXPECTED_EXTENSIONS = [
  "txt", "md", "log", "js", "ts", "json", "yaml", "yml", "xml", "csv", "tsv",
  "pdf", "docx", "odt", "doc", "rtf", "xlsx", "xls", "xlsb", "ods", "xlsm",
  "pptx", "ppt", "odp", "png", "jpg", "jpeg", "webp", "gif", "avif", "tiff",
  "tif", "heic", "raw", "svg", "mmd", "mermaid", "drawio", "excalidraw",
  "wav", "mp3", "m4a", "aac", "ogg", "opus", "flac", "mp4", "webm", "mov",
  "mkv", "avi", "srt", "vtt", "zip", "tar", "gz", "7z", "eml", "msg", "ics",
  "epub", "psd", "ai", "indd", "dwg", "dxf", "obj", "gltf", "glb", "ipynb",
  "parquet", "db", "sqlite",
] as const;

describe("Universe format capability matrix", () => {
  it("maps every accepted extension to exactly one explicit capability", () => {
    const registrations = new Map<string, string[]>();
    for (const capability of UNIVERSE_FORMAT_CAPABILITIES) {
      for (const extension of capability.extensions) {
        registrations.set(extension, [...(registrations.get(extension) ?? []), capability.id]);
      }
    }
    for (const extension of EXPECTED_EXTENSIONS) {
      expect(registrations.get(extension), extension).toHaveLength(1);
      expect(resolveFormatCapability({ filename: `fixture.${extension}` }).capability.id)
        .toBe(registrations.get(extension)![0]);
    }
  });

  it("keeps an unknown ordinary file downloadable without inventing preview support", () => {
    const result = resolveFormatCapability({ filename: "archive.unknown-format" });
    expect(result.capability.preview).toBe("download_only");
    expect(result.downloadAllowed).toBe(true);
    expect(result.failure).toBe("unsupported");
  });

  it("denies executable uploads instead of treating them as ordinary unknown downloads", () => {
    for (const filename of ["setup.exe", "payload.dll", "script.bat", "tool.ps1", "bundle.msi"]) {
      const result = resolveFormatCapability({ filename });
      expect(result.downloadAllowed, filename).toBe(false);
      expect(result.failure, filename).toBe("denied");
    }
  });

  it("does not activate an unqualified converter merely because its processor family is known", () => {
    const unavailable = resolveFormatCapability({ filename: "deck.pptx" });
    expect(unavailable.previewReady).toBe(false);
    expect(unavailable.capability.processorId).not.toBeNull();
    expect(unavailable.capability.processorBuild).toBeNull();
    const namedButUnqualified = resolveFormatCapability(
      { filename: "deck.pptx" },
      { qualifiedProcessors: { "libreoffice-headless": "unreviewed-local-build" } },
    );
    expect(namedButUnqualified.previewReady).toBe(false);
  });
});
