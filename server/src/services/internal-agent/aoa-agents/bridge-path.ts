import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

/**
 * Path to the mcp-bridge entrypoint.
 * Dev mode: returns .ts file (uses tsx command)
 * Prod mode: returns .js file (uses node command)
 */
export function resolveBridgeEntrypoint(): string {
  const here = typeof __dirname !== "undefined"
    ? __dirname
    : fileURLToPath(new URL(".", import.meta.url));

  // Try .ts first (dev mode)
  const tsPath = resolve(here, "..", "mcp-bridge.ts");
  if (existsSync(tsPath)) {
    return tsPath;
  }

  // Fall back to .js (prod/compiled mode)
  return resolve(here, "..", "mcp-bridge.js");
}
