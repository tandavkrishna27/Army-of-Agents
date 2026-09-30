import type { ArtifactVersion, ArtifactWithVersions } from "@armyofagents/shared";

function extensionFromName(value: string | null | undefined): string {
  const name = value?.split(/[?#]/, 1)[0]?.trim().toLowerCase() ?? "";
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1);
}

export function filenameForArtifactVersion(
  artifact: Pick<ArtifactWithVersions, "title">,
  version: ArtifactVersion,
): string {
  return version.filename ?? artifact.title;
}

export function assetUrlForArtifactVersion(version: ArtifactVersion): string | null {
  if (version.storageKind === "asset" && version.assetId) {
    return `/api/assets/${version.assetId}/content`;
  }
  return version.fileUrl ?? null;
}

export function contentTypeForArtifactVersion(
  artifact: Pick<ArtifactWithVersions, "title" | "type">,
  version: ArtifactVersion,
): string {
  if (version.contentType) return version.contentType;

  const filename = filenameForArtifactVersion(artifact, version);
  const extension =
    version.extension?.trim().toLowerCase() ||
    extensionFromName(filename) ||
    extensionFromName(version.fileUrl);

  switch (extension) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "pdf":
      return "application/pdf";
    case "mp4":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "mp3":
      return "audio/mpeg";
    case "wav":
      return "audio/wav";
    case "html":
    case "htm":
      return "text/html";
    case "md":
    case "mdx":
      return "text/markdown";
    case "json":
      return "application/json";
    case "csv":
      return "text/csv";
  }
  if (artifact.type === "design" && assetUrlForArtifactVersion(version)) return "image/png";
  if (version.content !== null && version.content !== undefined) {
    if (artifact.type === "code") return "text/plain";
    if (artifact.type === "document") return "text/markdown";
    return "text/plain";
  }
  return "application/octet-stream";
}
