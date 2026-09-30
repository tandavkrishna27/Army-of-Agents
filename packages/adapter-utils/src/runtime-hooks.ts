/**
 * Shared constants for the W5b PreToolUse permission bridge.
 *
 * Placed in adapter-utils so they are importable by BOTH the server AND the
 * claude-local adapter package without introducing a new cross-package
 * dependency. (claude-local already depends on adapter-utils; server also
 * depends on adapter-utils.)
 */

/**
 * Maximum seconds the adapter's PreToolUse hook will block waiting for a
 * human decision before the configured timeout policy takes over.
 */
export const RUNTIME_HOOK_BLOCK_TIMEOUT_SEC = 300;

/**
 * Server-relative path for the permission-request endpoint that the adapter's
 * PreToolUse hook POSTs to. Prepend selfBaseUrl from RuntimeHookBridgeSpec to
 * form the full URL.
 */
export const RUNTIME_HOOK_PATH = "/internal/runtime-hooks/permission-request";
