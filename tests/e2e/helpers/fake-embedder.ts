import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/**
 * Shared contract between the playwright config (which exports the control
 * path to the webServer env as AOA_E2E_FAKE_EMBEDDER_CONTROL) and the specs
 * (which rewrite the control file before each embedding-triggering action).
 *
 * The fake embedder (server/src/services/embeddings.ts createFakeEmbedder)
 * reads this file fresh on every embed() call. Writing the control file before
 * an action that triggers an embedding fully scripts the next embed outcome.
 *
 * Deterministic tmpdir path — identical computation in the runner process
 * (specs), the config process, and the server at embed time, so no plumbing
 * beyond the env var is needed (mirrors helpers/fake-codex.ts).
 */
export const FAKE_EMBEDDER_CONTROL_PATH = path.join(
  os.tmpdir(),
  "aoa-e2e-fake-embedder-control.json",
);

export interface FakeEmbedderControl {
  /**
   * Force embed() to throw an error classified by classifyEmbeddingError as
   * the given class. Omit (or set to undefined) for a successful embed.
   *
   *   - "systemic"      → throws { status: 401 } (bad API key / quota exhausted)
   *   - "transient"     → throws { status: 429 } (rate-limit, server error)
   *   - "row_permanent" → throws { status: 400 } (bad input, will never succeed)
   */
  fail?: "systemic" | "transient" | "row_permanent";
}

/** Write the control file to script the next embed() outcome. */
export function writeFakeEmbedderControl(ctrl: FakeEmbedderControl): void {
  fs.writeFileSync(FAKE_EMBEDDER_CONTROL_PATH, JSON.stringify(ctrl), "utf8");
}

/**
 * Remove the control file so the next embed() succeeds with the default
 * deterministic vector (no forced error).
 */
export function clearFakeEmbedderControl(): void {
  try {
    fs.rmSync(FAKE_EMBEDDER_CONTROL_PATH, { force: true });
  } catch {
    /* nothing to clear */
  }
}
