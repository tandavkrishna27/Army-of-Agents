// Same-origin XSS prevention for asset GETs. Allowlist-based: anything not on the
// list is served as `attachment` so the browser cannot execute it under the AoA
// origin. SVG is intentionally excluded — it can carry <script>.
//
// RFC 6266 reference: https://datatracker.ietf.org/doc/html/rfc6266#section-4.1

export const SAFE_INLINE_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "audio/mpeg",
  "audio/webm",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "application/json",
]);

export interface SafeServingHeaders {
  contentType: string;
  contentDisposition: string;
  xContentTypeOptions: "nosniff";
}

const FALLBACK_CONTENT_TYPE = "application/octet-stream";
const FALLBACK_FILENAME = "download";

function normaliseContentType(raw: string | null | undefined): string {
  if (!raw) return "";
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return "";
  const semi = trimmed.indexOf(";");
  return semi === -1 ? trimmed : trimmed.slice(0, semi).trim();
}

function stripUnsafeFilenameChars(raw: string): string {
  // Strip CR, LF, double-quote, backslash. These are the characters that can
  // either inject headers (CR/LF) or break out of the quoted-string in
  // Content-Disposition (quote/backslash).
  return raw.replace(/[\r\n"\\]/g, "");
}

function asciiFallback(sanitised: string): string {
  // Replace any non-ASCII byte with `_` so the legacy `filename="..."` form is
  // safe for clients that do not understand `filename*`.
  let out = "";
  for (const ch of sanitised) {
    out += ch.charCodeAt(0) < 0x80 ? ch : "_";
  }
  return out;
}

function buildContentDisposition(
  disposition: "inline" | "attachment",
  rawFilename: string | null | undefined,
): string {
  const sanitised = rawFilename ? stripUnsafeFilenameChars(rawFilename) : "";
  if (!sanitised) {
    return `${disposition}; filename="${FALLBACK_FILENAME}"`;
  }
  const ascii = asciiFallback(sanitised);
  const asciiSafe = ascii.length > 0 ? ascii : FALLBACK_FILENAME;
  // RFC 5987 percent-encoding for the UTF-8 form. encodeURIComponent over-encodes
  // some allowed characters but is always safe inside `filename*=UTF-8''<value>`.
  const utf8Encoded = encodeURIComponent(sanitised);
  return `${disposition}; filename="${asciiSafe}"; filename*=UTF-8''${utf8Encoded}`;
}

export function getSafeServingHeaders(
  rawContentType: string | null | undefined,
  rawFilename: string | null | undefined,
): SafeServingHeaders {
  const normalised = normaliseContentType(rawContentType);
  const contentType =
    rawContentType && rawContentType.trim().length > 0
      ? rawContentType.trim()
      : FALLBACK_CONTENT_TYPE;
  const disposition: "inline" | "attachment" =
    normalised && SAFE_INLINE_CONTENT_TYPES.has(normalised) ? "inline" : "attachment";
  return {
    contentType: normalised ? contentType : FALLBACK_CONTENT_TYPE,
    contentDisposition: buildContentDisposition(disposition, rawFilename),
    xContentTypeOptions: "nosniff",
  };
}
