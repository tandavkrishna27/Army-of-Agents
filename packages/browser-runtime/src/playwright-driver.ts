// packages/browser-runtime/src/playwright-driver.ts
//
// BRW-002 — the real Playwright adapter behind the injected `BrowserDriver` seam.
//
// THIS RUNS IN-GUEST, next to Chromium. The CDP pipe rides file descriptors 3 and 4 of the
// spawned child (`playwright-core/lib/server/browserType.js:268-269`), and only the spawning
// process can hold them — so a host-side orchestrator cannot drive Playwright across the
// sandbox boundary. It can start this and read what it emits, nothing more.
//
// Two Playwright facts are baked in because guessing them is what broke design v1:
//
//  * `downloadsPath` is a LAUNCH option, not a context option. Passing it to `newContext`
//    is accepted and SILENTLY DISCARDED, and downloads then land in a shared
//    `/tmp/playwright-artifacts-*` directory. `launchPersistentContext` takes it at launch,
//    which is why that is used here.
//  * `--user-data-dir` in `args` THROWS (`chromium.js:278-280`). The profile directory is a
//    PARAMETER of `launchPersistentContext`, never an argument.
//
// And `downloadsPath` is a STAGING area, not a sink: Playwright deletes its contents when the
// context closes. Durability comes from `saveAs`, which the orchestrator calls before close.
import { chromium, type BrowserContext, type Download } from "playwright";
import type { BrowserDriver, BrowserPage, DownloadHandle } from "./run-session.js";
import type { BrowserLaunchOptions } from "./launch-guard.js";

export interface PlaywrightDriverOptions {
  /** Chromium profile directory. A PARAMETER, never an `--user-data-dir` argument. */
  readonly userDataDir: string;
  /** Where Playwright stages downloads before `saveAs` persists them. */
  readonly downloadsStagingPath: string;
  /** Optional video directory; video is only written when the context closes. */
  readonly videoDir?: string;
}

/** Adapt a Playwright `Download` to the orchestrator's minimal handle. */
function toHandle(download: Download): DownloadHandle {
  return {
    suggestedFilename: () => download.suggestedFilename(),
    async saveAs(target: string) {
      await download.saveAs(target);
    },
  };
}

export function createPlaywrightDriver(options: PlaywrightDriverOptions): BrowserDriver {
  return {
    async launch(launchOptions: BrowserLaunchOptions): Promise<BrowserPage> {
      // The orchestrator has already run `checkBrowserLaunchSafety`. This adapter does NOT
      // re-derive safety — it passes the caller's decision through unchanged, so there is
      // exactly one place where "is this launch safe" is decided.
      const context: BrowserContext = await chromium.launchPersistentContext(options.userDataDir, {
        headless: launchOptions.headless ?? true,
        // Explicitly true: Playwright pushes `--no-sandbox` unless it is exactly `true`.
        chromiumSandbox: launchOptions.chromiumSandbox === true,
        acceptDownloads: true,
        downloadsPath: options.downloadsStagingPath,
        args: [...(launchOptions.args ?? [])],
        ...(options.videoDir === undefined ? {} : { recordVideo: { dir: options.videoDir } }),
      });

      // Downloads are collected as they fire, on EVERY page including popups — a download
      // triggered from a new tab would otherwise never be seen.
      const downloads: DownloadHandle[] = [];
      const attach = (page: { on: (event: "download", cb: (d: Download) => void) => void }): void => {
        page.on("download", (download) => downloads.push(toHandle(download)));
      };
      context.pages().forEach(attach);
      context.on("page", attach);

      const page = context.pages()[0] ?? (await context.newPage());

      // GRACEFUL-CANCELLATION TEARDOWN, and the measured reason it is not sufficient.
      //
      // ★ CORRECTED (BRW-003b). This said, as a universal claim: "MEASURED: killing the
      // runner with SIGKILL does NOT reap Chromium." That measurement was taken on WINDOWS
      // and generalised. Linux CI refuted it on the first green browser run — SIGKILL DOES
      // reap there, through the CDP pipe on fds 3/4 reaching EOF.
      //
      // PLATFORM IS THE VARIABLE, and the target platform is the one that matters:
      //   * LINUX (what an E2B sandbox is) — an uncatchable kill reaps the browser.
      //   * WINDOWS (developer machines) — the browser is orphaned; Node maps every
      //     child.kill() to TerminateProcess and the grandchild survives.
      //
      // Destroying the sandbox remains the OUTER backstop either way, which is what terrain
      // concluded about `destroy`/`terminate` versus the no-op `signal`. Both platforms are
      // asserted per-platform in browser-teardown.browser.test.ts, so this is a tested fact
      // rather than folklore.
      //
      // What this DOES buy is the catchable half: a graceful cancellation closes the context,
      // which both reaps the browser and flushes video. Registered `once` and removed on
      // close so a long-lived host process cannot accumulate listeners per session.
      let closed = false;
      const shutdown = (): void => {
        if (closed) return;
        closed = true;
        void context.close().catch(() => undefined);
      };
      process.once("SIGTERM", shutdown);
      process.once("SIGINT", shutdown);
      const detach = (): void => {
        process.removeListener("SIGTERM", shutdown);
        process.removeListener("SIGINT", shutdown);
      };

      return {
        async navigate(url: string) {
          // The waiter is ARMED BEFORE the navigation, deliberately. The `download` event can
          // fire before `goto`'s rejection propagates, so arming it afterwards is a race —
          // and it lost: a download-triggering navigation intermittently reported zero
          // downloads because the event had not arrived when they were collected.
          const started = page
            .waitForEvent("download", { timeout: 15_000 })
            .then(() => true)
            .catch(() => false);

          try {
            await page.goto(url, { waitUntil: "load" });
            // An ordinary navigation: nothing is waiting on the download, so make sure the
            // dangling promise is settled and cannot surface as an unhandled rejection.
            void started;
          } catch (error) {
            // MEASURED, not guessed: `page.goto` REJECTS with "Download is starting" when the
            // navigation results in a download rather than a document. The navigation did
            // exactly what was asked — the bytes are arriving on the `download` event — so
            // treating this rejection as a step failure would report every direct download
            // navigation as a failed session.
            //
            // Deliberately narrow: ONLY this message is absorbed. Every other navigation
            // error still propagates, because a broad catch here would silently turn a DNS
            // failure, a TLS refusal or an egress denial into a passing step — the opposite
            // of what this ticket exists to prove.
            const message = error instanceof Error ? error.message : String(error);
            if (!message.includes("Download is starting")) throw error;
            // Block until the download has actually been handed to the listener, so
            // `collectDownloads` cannot observe an empty list for a download that is on its
            // way.
            await started;
          }
        },
        async collectDownloads() {
          return downloads;
        },
        async close() {
          // Flushes video. Also destroys the staging directory — hence the orchestrator's
          // fixed ordering of saveAs before close.
          detach();
          closed = true;
          await context.close();
        },
      };
    },
  };
}
