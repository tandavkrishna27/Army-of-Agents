// -----------------------------------------------------------------------------
// BRW-003b — where the STAGED runner actually gets Playwright from.
//
// ★ THIS TEST PREVIOUSLY ASSERTED THE WRONG INVARIANT, and CI proved it.
//
// It asserted `playwright` must be a runtime `dependency` of this package, on the
// reasoning that the runner is staged into a sandbox and a devDependency "does not
// travel". The second half is true; the conclusion does not follow. NOTHING from
// this package.json travels either — the host writes `runner.js` and
// `session.json` into the guest and execs them, with no node_modules and no
// manifest. A dependency declaration cannot help a process that never sees it.
//
// What actually makes the staged runner work is the IMAGE: Playwright installed
// globally with `NODE_PATH` pointing at the global root. That is asserted here and
// pinned by `image-playwright-parity.test.ts`.
//
// The move was also not free. `browser-teardown.browser.test.ts` went from 3352ms
// (browser up in ~3s) to 31395ms (browser never appeared inside a 30s wait) on the
// Linux lane, starting exactly at the commit that made the move — a real launch
// failure, not a marginal timeout, and invisible on Windows because that clause is
// Linux-gated.
// -----------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dockerfile = readFileSync(
  fileURLToPath(new URL("../../../../e2b/e2b.Dockerfile", import.meta.url)),
  "utf8",
);

describe("BRW-003b — the sandbox image is what supplies Playwright to the staged runner", () => {
  it("installs Playwright GLOBALLY in the image", () => {
    // Global, because the staged runner has no node_modules of its own to resolve
    // against — it is two files written into a bare guest.
    expect(dockerfile).toMatch(/npm install -g[^\n]*playwright@/);
  });

  it("sets NODE_PATH so a staged file can resolve the global install", () => {
    // Without this, a global install is invisible to a script executed from an
    // arbitrary directory — which is exactly how the runner is executed.
    expect(dockerfile).toMatch(/ENV NODE_PATH=\/usr\/local\/lib\/node_modules/);
  });

  it("installs a real browser, not just the module", () => {
    expect(dockerfile).toMatch(/playwright@[^\s]+ install[^\n]*chromium/);
  });

  it("★ proves BOTH at build time, because either alone passes vacuously", () => {
    // `require('playwright')` succeeds with no browser installed, and
    // `executablePath()` returns a string whether or not the file is there. The
    // image asserts the module resolves AND that the binary exists on disk.
    expect(dockerfile).toMatch(/chromium\.executablePath\(\)/);
    expect(dockerfile).toMatch(/accessSync/);
  });
});
