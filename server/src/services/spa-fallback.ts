import type { RequestHandler } from "express";

/**
 * SPA catch-all route: every GET that is not /api/* (JSON 404s, Issue #116)
 * and not /assets/* (a missing hashed bundle must 404 loudly, not serve
 * index.html). Express 5: string "*" is invalid — RegExp path is the
 * established pattern here.
 */
export const SPA_FALLBACK_ROUTE = /^(?!\/(?:api|assets)(?:\/|$)).*/;

/**
 * index.html is sent root-relative: sendFile with a bare absolute path runs
 * `send`'s dotfile check on EVERY path segment, so an install under a
 * dot-directory (e.g. ~/.aoa/wt/... worktrees, npx caches) 404s with
 * dotfiles:"ignore". With `root` set, only the path relative to root is
 * checked. Same failure mode as plugin-ui-static.ts.
 */
export function spaFallbackHandler(uiDistDir: string): RequestHandler {
  return (_req, res) => {
    res.sendFile("index.html", { root: uiDistDir });
  };
}
