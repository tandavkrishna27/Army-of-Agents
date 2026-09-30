// Isomorphic scheme-safety GATE for a URL about to become an in-app iframe src.
// Returns the input unchanged when its scheme is safe (http/https, about:blank,
// single-slash app-relative, or a schemeless host[:port]); returns "about:blank"
// for dangerous schemes (javascript/data/file/blob/vbscript and any non-http(s)
// scheme://), protocol-relative "//"/backslash network-path forms, or control chars.
// This is a GATE, not a canonicalizer -- callers keep their own shaping. A URL is
// caller-supplied data; never trust its scheme.
const DANGEROUS_SCHEMES = new Set(["javascript", "data", "vbscript", "file", "blob"]);
const SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i;
const SCHEME_SLASHSLASH_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true; // C0 controls + DEL
  }
  return false;
}

export function toSafeBrowserUrl(value: string): string {
  const t = value.trim();
  if (!t) return "";
  if (t === "about:blank") return "about:blank";
  if (hasControlChar(t)) return "about:blank";
  // Backslash and protocol-relative forms resolve cross-origin in browsers.
  if (t.startsWith("\\")) return "about:blank";
  if (t.startsWith("//")) return "about:blank";
  if (t.startsWith("/\\")) return "about:blank";
  if (t.startsWith("/")) return t; // single-slash app / dev-server relative
  const m = SCHEME_RE.exec(t);
  if (m) {
    const scheme = m[1].toLowerCase();
    if (SCHEME_SLASHSLASH_RE.test(t)) {
      // absolute scheme:// -- only http/https allowed
      return scheme === "http" || scheme === "https" ? t : "about:blank";
    }
    // "scheme:" with no // -- block dangerous schemes; otherwise treat as host[:port]
    if (DANGEROUS_SCHEMES.has(scheme)) return "about:blank";
    // Bare non-dangerous schemes (mailto:, tel:, host:port, ...) pass through by
    // design: without a "//" they are not script-exec vectors in an iframe src.
    return t;
  }
  return t; // schemeless host
}
