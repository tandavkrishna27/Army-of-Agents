import type { HelmetOptions } from "helmet";
import type { DeploymentMode } from "@armyofagents/shared";

export interface BuildHelmetOptionsInput {
  deploymentMode: DeploymentMode;
  /**
   * The UI delivery mode. Vite's development middleware injects an inline
   * React-refresh preamble and connects to its HMR WebSocket, so its responses
   * cannot use the static bundle's strict CSP.
   */
  uiMode?: "none" | "static" | "vite-dev";
  /**
   * `process.env.NODE_ENV` value (or equivalent). When the deployment mode
   * is `local_trusted` and this is anything other than `"production"`, the
   * legacy development fallback skips CSP. New callers should pass `uiMode`
   * so this decision follows the actual UI delivery mode.
   *
   * For production-built bundles in local_trusted (npm-package install,
   * Docker container) this is `"production"` and strict CSP applies.
   */
  nodeEnv: string | undefined;
  /**
   * Base64-encoded SHA-256 hashes of every inline `<script>` block in the
   * served `index.html`. These are dropped into `script-src` as
   * `'sha256-<value>'` directives so the Vite bootloader can run without
   * needing `'unsafe-inline'`. Empty array is fine (no inline scripts).
   */
  inlineScriptHashes: string[];
}

/**
 * Build the helmet config used by `createApp()`. Production deployment modes
 * (anything other than `local_trusted` + non-production node env) get a
 * strict CSP plus tightened cross-origin policies. Vite-dev mode skips CSP
 * because HMR's runtime needs inline scripts + WebSocket + eval.
 *
 * Cross-origin policies:
 * - `Cross-Origin-Opener-Policy: same-origin-allow-popups` — isolates the
 *   browsing context but allows OAuth popups to communicate back.
 * - `Cross-Origin-Resource-Policy: same-site` — prevents other origins from
 *   embedding our resources, but allows subdomains.
 * - `Cross-Origin-Embedder-Policy: false` (off) — enabling `require-corp`
 *   would block any external image/avatar that lacks an explicit CORP
 *   header. Audit external resource hosts before turning this on.
 */
export function buildHelmetOptions(input: BuildHelmetOptionsInput): HelmetOptions {
  const { deploymentMode, nodeEnv, inlineScriptHashes, uiMode } = input;

  const skipCsp = uiMode === "vite-dev"
    || (uiMode === undefined && deploymentMode === "local_trusted" && nodeEnv !== "production");

  const contentSecurityPolicy = skipCsp ? false : buildStrictCspConfig(inlineScriptHashes);

  return {
    contentSecurityPolicy,
    crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
    crossOriginResourcePolicy: { policy: "same-site" },
    // Intentionally NOT enabled — would break loading external images
    // (avatar generators, embedded media). Revisit once every external
    // resource host emits Cross-Origin-Resource-Policy.
    crossOriginEmbedderPolicy: false,
  };
}

function buildStrictCspConfig(inlineScriptHashes: string[]) {
  const scriptSrc: string[] = [
    "'self'",
    ...inlineScriptHashes.map((h) => `'sha256-${h}'`),
  ];

  return {
    // useDefaults: false — we list every directive explicitly so adding a
    // helmet major version doesn't silently introduce new directives.
    useDefaults: false,
    directives: {
      "default-src": ["'self'"],
      "script-src": scriptSrc,
      // Vite's CSS pipeline injects styles via dynamic <style> tags. We own
      // the build, so 'unsafe-inline' for stylesheets is acceptable: an
      // attacker-controlled script can't inject styles without already
      // having script execution. We do NOT allow style-src-attr inline.
      "style-src": ["'self'", "'unsafe-inline'"],
      // data: + blob: for client-generated previews (asset thumbnails,
      // canvas exports). https: blanket allows external avatar generators.
      "img-src": ["'self'", "data:", "blob:", "https:"],
      // data: for inline fonts (some icon fonts ship as data URIs).
      "font-src": ["'self'", "data:"],
      // Locked to self — the browser never calls LLM APIs directly. Every
      // outbound LLM request is server-mediated. Operators wiring a custom
      // backend may need to extend this list (see docs/deploy/distribution.md).
      "connect-src": ["'self'"],
      // Plugins (Flash, Java applets, etc.) — never needed.
      "object-src": ["'none'"],
      // Lock <base href> to the same origin so an injected <base> can't
      // redirect relative-URL navigation.
      "base-uri": ["'self'"],
      // Forms only post back to our own origin.
      "form-action": ["'self'"],
      // No site can frame us. Modern equivalent of X-Frame-Options: DENY.
      "frame-ancestors": ["'none'"],
      // When loaded over HTTPS, automatically rewrite http:// subresources
      // to https://. Cheap defense against accidentally including an
      // http:// resource via a relative URL behind a TLS-terminating proxy.
      "upgrade-insecure-requests": [],
    },
  } as const;
}
