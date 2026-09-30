import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // ★ THE BROWSER SUITE MUST NOT RUN ITS FILES IN PARALLEL, and this is a correctness
    // requirement rather than a resource one.
    //
    // `browser-containment.browser.test.ts` measures listening sockets from `/proc/net/tcp`
    // and `/proc/net/tcp6` — its own header says it is "a measurement of the MACHINE, not an
    // inspection of the arguments we happened to pass". The delta it takes across a browser
    // launch is documented as robust to any PRE-EXISTING listener. It is not robust to one
    // that appears CONCURRENTLY, and vitest runs test files in parallel workers by default.
    //
    // `browser-teardown.browser.test.ts` — the only other file in this package that launches
    // real Chromium — also starts fixture HTTP servers. So a sibling's socket lands inside
    // the containment delta window and is attributed to the browser under test, and a
    // sibling's Chromium competes for CPU with the 30s startup wait.
    //
    // Both symptoms were observed on the two CI runs that got far enough to finish, on
    // DIFFERENT assertions each time (which is what a race looks like):
    //   - "browser opened listening port(s): 44893"  (containment, run 65b296ea2)
    //   - "the browser never started, so this test would prove nothing" (teardown, 701d860af)
    //
    // ★ CORRECTION, measured on run 32727172193: serialising did NOT fix the teardown
    // failure. With this in place the SIGKILL case still reported "the browser never
    // started" after 30s, while the SIGTERM case in the SAME file started and reaped in
    // 1.8s - so the observation helper works and contention is not the cause there. The
    // containment hazard above is still real and this still closes it, but it is now one
    // fix for one problem rather than the two it was first claimed to cover.
    //
    // It belongs here rather than as a CI flag so a
    // developer running the suite locally gets the same guarantee, and so it cannot be lost
    // by an edit to the workflow.
    fileParallelism: false,
  },
});
