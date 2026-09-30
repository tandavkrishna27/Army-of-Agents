import { describe, expect, it } from "vitest";
import path from "node:path";
import { existsSync } from "node:fs";
import { extractInlineScriptHashes } from "../services/csp-script-hashes.js";

// Smoke test: when the prod UI bundle has been built (`pnpm --filter
// @armyofagents/ui build`), confirm we extract exactly one inline-script
// hash from `ui/dist/index.html`. This catches:
//   - Vite emitting unexpected new inline scripts
//   - Our regex missing the existing inline script
//   - The dist file being moved or restructured
//
// The test self-skips if the dist file isn't present (CI step that doesn't
// build the UI shouldn't fail this assertion).
describe("CSP — real Vite production build", () => {
  it("ui/dist/index.html contains exactly one inline script (FOUC bootloader)", async () => {
    // From server/src/__tests__/ → ../../../ui/dist/index.html
    const distPath = path.resolve(__dirname, "../../../ui/dist/index.html");
    if (!existsSync(distPath)) {
      // Build artifact missing — this test is informational only.
      // We don't fail because not every CI step builds the UI.
      console.warn(
        `[csp-real-build] skipped — ${distPath} does not exist; run \`pnpm --filter @armyofagents/ui build\` first`,
      );
      return;
    }

    const hashes = await extractInlineScriptHashes(distPath);
    expect(hashes).toHaveLength(1);
    expect(hashes[0]).toMatch(/^[A-Za-z0-9+/=]+$/);
  });
});
