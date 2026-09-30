// packages/browser-runtime/src/launch-guard.ts
//
// BRW-002 — the enforcer for `public_cdp_endpoint`.
//
// That token is a FORBIDDEN EFFECT named in the frozen golden-journey fixture
// (`tests/fixtures/distributed-execution/browser-approval-download.json:222`) and, until this
// module, nothing in the tree checked it — `forbiddenEffects` is only length-checked by
// `golden-journeys.test.ts`. A named forbidden effect nobody enforces is this programme's
// signature defect.
//
// THE DANGER IS MEASURED, NOT ASSUMED. A probe run from a GitHub runner fetched marker
// content from port 9222 of a live E2B sandbox with no credentials of any kind
// (`packages/sandbox-e2b-provider/scripts/probe-e2b-port-exposure.mjs`). E2B routes sandbox
// ports on a public wildcard domain and the URL is derivable from the sandboxId alone. So a
// Chromium that binds a debugging port publishes a fully-privileged browser control endpoint
// — cookies, storage state, arbitrary navigation — to the internet.
//
// WHY THIS CHECKS OPTIONS AND NOT ONLY ARGS. An earlier design inspected `args` alone. That
// is the wrong surface. `cdpPort` is a LAUNCH OPTION that never appears in `args`, and on its
// own it flips Playwright off the pipe transport (`browserType.js:265-266`):
//     if (options.cdpPort !== void 0 || !this.supportsPipeTransport())
//       transport = await WebSocketTransport.connect(progress, wsEndpoint);
//     else
//       transport = new PipeTransport(stdio[3], stdio[4]);
//
// Pure and synchronous: no I/O, no clock, no process access. The caller supplies `env` rather
// than the module reading `process.env`, so every case is directly testable.

/** The launch surface this guard inspects. A structural subset of Playwright's
 * `LaunchOptions` — deliberately not imported, so this package stays dependency-free and the
 * guard can run anywhere (including on the host, before a runner is staged). */
export interface BrowserLaunchOptions {
  readonly headless?: boolean;
  /** Playwright pushes `--no-sandbox` unless this is exactly `true` (chromium.js:295-296). */
  readonly chromiumSandbox?: boolean;
  /** Set at all ⇒ WebSocket transport on a TCP port. Never appears in `args`. */
  readonly cdpPort?: number;
  readonly args?: readonly string[];
}

export type BrowserLaunchRefusal =
  | "cdp_port_requested"
  | "remote_debugging_arg"
  | "argument_not_allowed"
  | "remote_endpoint_env"
  | "chromium_sandbox_disabled";

export type BrowserLaunchCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: BrowserLaunchRefusal; readonly detail: string };

/** Env vars that reroute the driver to a remote endpoint instead of a local pipe. */
const REMOTE_ENDPOINT_ENV = ["SELENIUM_REMOTE_URL", "PW_TEST_CONNECT_WS_ENDPOINT"] as const;

/**
 * Switch NAMES (never spellings) that open or hand over a remote control channel.
 *
 * `remote-debugging-pipe` is included even though a pipe is what we want: Playwright manages
 * it itself and throws if the caller passes it (chromium.js:281-282), so refusing it turns a
 * launch-time crash into a typed refusal.
 */
const REMOTE_DEBUGGING_SWITCHES = new Set([
  "remote-debugging-port",
  "remote-debugging-address",
  "remote-debugging-pipe",
]);

/** Switch names that defeat Chromium's OS sandbox. */
const SANDBOX_DEFEATING_SWITCHES = new Set(["no-sandbox", "disable-setuid-sandbox"]);

/**
 * THE ALLOW-LIST. Every caller-supplied switch must be named here or the launch is refused.
 *
 * WHY AN ALLOW-LIST. The first version of this guard matched the `--flag` spelling and was
 * REPRODUCIBLY BYPASSED: `-remote-debugging-port=9333` (single dash) was ACCEPTED, Playwright
 * launched it — its own validation only rejects args that do not start with `-`
 * (chromium.js:283) — and Chromium opened a live DevTools endpoint, HTTP 200 on
 * `/json/version`, while Playwright kept driving over its pipe so the session looked
 * completely healthy. On E2B that port is publicly reachable (measured), so a one-character
 * change produced `public_cdp_endpoint`: the exact forbidden effect this module exists to
 * prevent.
 *
 * A deny-list cannot be repaired into safety here. Chromium accepts on the order of 1500
 * switches, honours `-flag`, `--flag` and `/flag`, and gains more every release; enumerating
 * the dangerous ones is a race nobody wins. An allow-list has a bounded, reviewable failure
 * mode: the worst case is refusing something benign, which surfaces as a loud typed refusal
 * rather than a silent public endpoint.
 *
 * Keep this SMALL. Every addition is a decision to trust a switch.
 */
const ALLOWED_SWITCHES = new Set([
  "disable-gpu",
  "disable-dev-shm-usage",
  "hide-scrollbars",
  "lang",
  "window-size",
  "force-color-profile",
  "disable-background-timer-throttling",
  "disable-backgrounding-occluded-windows",
  "disable-renderer-backgrounding",
]);

/**
 * Reduce an argument to the switch NAME Chromium would parse from it.
 *
 * Mirrors `base::CommandLine`: any leading run of `-` is a switch prefix, `/` is one on
 * Windows, the value is separated by the FIRST `=`, and matching is case-insensitive. Doing
 * this once, here, is what makes every downstream comparison spelling-proof — the previous
 * version compared raw spellings and lost.
 */
export function normalizeSwitchName(arg: string): string {
  let value = arg.trim().toLowerCase();
  // Strip every leading dash, not just two: `---remote-debugging-port` parses the same.
  let start = 0;
  while (start < value.length && (value[start] === "-" || value[start] === "/")) start += 1;
  value = value.slice(start);
  const equals = value.indexOf("=");
  return equals >= 0 ? value.slice(0, equals) : value;
}

/**
 * Decide whether a browser launch may proceed.
 *
 * Refusal order is FIXED and asserted by a test: a launch can violate several rules at once,
 * and an unstable reason would make every reason-asserting test flaky as the implementation
 * is reordered. Order: cdpPort → debugging args → env → OS sandbox.
 */
export function checkBrowserLaunchSafety(
  options: BrowserLaunchOptions,
  env: NodeJS.ProcessEnv,
): BrowserLaunchCheck {
  // `!== undefined`, never truthiness: `cdpPort: 0` asks the OS to pick an ephemeral port
  // (exactly what Playwright's bidi path does with `--remote-debugging-port=0`), and 0 is
  // falsy — so `if (options.cdpPort)` would wave through the very case that opens a port.
  if (options.cdpPort !== undefined) {
    return {
      ok: false,
      reason: "cdp_port_requested",
      detail: `cdpPort=${options.cdpPort} selects the WebSocket transport instead of the pipe`,
    };
  }

  const args = options.args ?? [];

  // Every argument is reduced to the switch NAME Chromium would parse, so `-x`, `--x`,
  // `---x`, `/x` and `--X=1` all collapse to the same token before any comparison happens.
  for (const arg of args) {
    const name = normalizeSwitchName(arg);
    if (REMOTE_DEBUGGING_SWITCHES.has(name)) {
      return {
        ok: false,
        reason: "remote_debugging_arg",
        detail: `argument ${arg.trim()} opens or reassigns a remote control channel`,
      };
    }
    if (SANDBOX_DEFEATING_SWITCHES.has(name)) {
      return {
        ok: false,
        reason: "chromium_sandbox_disabled",
        detail: `argument ${arg.trim()} defeats the OS sandbox`,
      };
    }
    if (!ALLOWED_SWITCHES.has(name)) {
      // Refuse rather than guess. An unrecognised switch might be harmless, but the cost of
      // being wrong is a public control endpoint, and the cost of being over-strict is a
      // loud typed refusal that a human resolves by adding one line above.
      return {
        ok: false,
        reason: "argument_not_allowed",
        detail: `argument ${arg.trim()} is not on the permitted switch list`,
      };
    }
  }

  for (const name of REMOTE_ENDPOINT_ENV) {
    // An empty value reroutes nothing; refusing it would make the guard noisy enough to be
    // switched off, which is worse than the case it would catch.
    if ((env[name] ?? "") !== "") {
      return {
        ok: false,
        reason: "remote_endpoint_env",
        detail: `${name} reroutes the driver to a remote endpoint`,
      };
    }
  }

  // Playwright DISABLES Chromium's own OS sandbox unless this is exactly `true`. Every
  // containment claim in BRW-002 assumes the renderer stays contained, so an omitted flag is
  // a silent downgrade, not a default.
  if (options.chromiumSandbox !== true) {
    return {
      ok: false,
      reason: "chromium_sandbox_disabled",
      detail: "chromiumSandbox must be true; Playwright otherwise passes --no-sandbox",
    };
  }

  return { ok: true };
}
