// BRW-002 — the browser launch guard (unit-shaped; runs on every OS).
//
// This guard is the enforcer for `public_cdp_endpoint`, a forbidden effect the frozen
// golden-journey fixture names (`browser-approval-download.json:222`) and which — as plan
// review established — NOTHING in the tree currently checks.
//
// It is measured, not assumed, that the danger is real: a probe from a GitHub runner fetched
// content from port 9222 of a live E2B sandbox with no credentials at all. So a Chromium that
// binds a debugging port publishes a fully-privileged control endpoint to the internet.
//
// WHY THE GUARD CHECKS OPTIONS AND NOT JUST ARGS. Design v1 inspected `args` only. That is
// the wrong surface: `cdpPort` is a LAUNCH OPTION that never appears in `args`, and on its own
// it flips Playwright from the pipe transport to a WebSocket endpoint —
// `browserType.js:265-266`: `if (options.cdpPort !== void 0 || !this.supportsPipeTransport())
// { transport = await WebSocketTransport.connect(...) }`.
import { describe, expect, it } from "vitest";
import {
  checkBrowserLaunchSafety,
  type BrowserLaunchOptions,
} from "../launch-guard.js";

/** The launch shape the runner actually uses: pipe transport, OS sandbox ON. */
const SAFE: BrowserLaunchOptions = {
  headless: true,
  chromiumSandbox: true,
  args: ["--disable-gpu"],
};

const NO_ENV: NodeJS.ProcessEnv = {};

describe("BRW-002 launch guard — the safe launch is accepted", () => {
  // Positive control. Without it every rejection below could pass for the wrong reason —
  // a guard that refuses everything is not a guard.
  it("accepts a pipe-transport launch with the OS sandbox enabled", () => {
    expect(checkBrowserLaunchSafety(SAFE, NO_ENV)).toEqual({ ok: true });
  });

  it("accepts an empty args array and an absent args field", () => {
    expect(checkBrowserLaunchSafety({ ...SAFE, args: [] }, NO_ENV).ok).toBe(true);
    const { args: _omitted, ...noArgs } = SAFE;
    expect(checkBrowserLaunchSafety(noArgs, NO_ENV).ok).toBe(true);
  });

  it("ignores unrelated env vars", () => {
    expect(checkBrowserLaunchSafety(SAFE, { HOME: "/root", PATH: "/usr/bin" }).ok).toBe(true);
  });
});

describe("BRW-002 launch guard — cdpPort is the surface args cannot see", () => {
  it("refuses cdpPort even though it never appears in args", () => {
    const result = checkBrowserLaunchSafety({ ...SAFE, cdpPort: 9222 }, NO_ENV);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("cdp_port_requested");
  });

  it("refuses cdpPort 0, which asks the OS to pick a port rather than disabling one", () => {
    // `--remote-debugging-port=0` is how Playwright's own bidi path opens an ephemeral port;
    // 0 is falsy, so a naive `if (options.cdpPort)` check would wave it through.
    const result = checkBrowserLaunchSafety({ ...SAFE, cdpPort: 0 }, NO_ENV);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("cdp_port_requested");
  });
});

describe("BRW-002 launch guard — arguments are an ALLOW-LIST, not a deny-list", () => {
  // WHY THIS IS AN ALLOW-LIST NOW. The first version matched the `--flag` spelling and was
  // REPRODUCIBLY BYPASSED by a single-dash switch: `-remote-debugging-port=9333` was
  // ACCEPTED, Playwright launched it (its own validation only rejects args that do not start
  // with "-"), and Chromium opened a live DevTools endpoint — HTTP 200 on /json/version —
  // while Playwright kept driving over its pipe so the session looked healthy. On E2B that
  // port is publicly reachable, so that is `public_cdp_endpoint`: the exact forbidden effect
  // this module exists to prevent, produced by ONE character.
  //
  // A deny-list cannot be made safe here. Chromium accepts roughly 1500 switches, honours
  // `-flag`, `--flag` and (on Windows) `/flag`, and new ones arrive every release. Only an
  // allow-list has a bounded, reviewable failure mode.
  const debugArgs = [
    "--remote-debugging-port=9222",
    "-remote-debugging-port=9222",
    "---remote-debugging-port=9222",
    "/remote-debugging-port=9222",
    "--remote-debugging-address=0.0.0.0",
    "-remote-debugging-pipe",
    "--REMOTE-DEBUGGING-PORT=9222",
    "  -remote-debugging-port=9222  ",
  ];

  for (const arg of debugArgs) {
    it(`refuses ${JSON.stringify(arg)} AS A DEBUGGING SWITCH`, () => {
      const result = checkBrowserLaunchSafety({ ...SAFE, args: [arg] }, NO_ENV);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      // ASSERTING THE REASON IS LOAD-BEARING, not decoration. Mutation testing found that
      // five separate normaliser defects — not stripping "/", not case-folding, not
      // trimming, and skipping the deny-set entirely — ALL still produced a refusal, because
      // the allow-list backstop catches whatever the normaliser fails to recognise. With only
      // `expect(ok).toBe(false)` the normaliser could be completely broken and this suite
      // would stay green. The reason is what distinguishes "recognised as dangerous" from
      // "not recognised at all".
      expect(result.reason).toBe("remote_debugging_arg");
    });
  }

  it("refuses an unrecognised switch instead of guessing whether it is safe", () => {
    const result = checkBrowserLaunchSafety({ ...SAFE, args: ["--some-future-switch=1"] }, NO_ENV);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("argument_not_allowed");
  });

  it("refuses --remote-allow-origins, which relaxes DevTools origin checks", () => {
    // The deny-list version deliberately ALLOWED this. Under the allow-list it is refused,
    // which is the better answer: nothing this runtime does needs it.
    expect(checkBrowserLaunchSafety({ ...SAFE, args: ["--remote-allow-origins=null"] }, NO_ENV).ok).toBe(false);
  });

  it("accepts the switches the runtime actually needs", () => {
    for (const arg of ["--disable-gpu", "--lang=en-US", "--window-size=1280,720", "--hide-scrollbars"]) {
      expect(checkBrowserLaunchSafety({ ...SAFE, args: [arg] }, NO_ENV).ok, arg).toBe(true);
    }
  });

  it("splits on the FIRST equals, so a value containing '=' is still allowed", () => {
    // `lastIndexOf` would yield the switch name "lang=en" — not on the allow-list — and
    // refuse a legitimate launch. Nothing else in the suite could tell the two apart.
    expect(checkBrowserLaunchSafety({ ...SAFE, args: ["--lang=en=US"] }, NO_ENV).ok).toBe(true);
  });

  it("refuses a single-dash spelling of an OTHERWISE-ALLOWED switch too", () => {
    // Normalisation must be applied uniformly, or the allow-list becomes a way to smuggle
    // spellings past a later deny check.
    expect(checkBrowserLaunchSafety({ ...SAFE, args: ["-disable-gpu"] }, NO_ENV).ok).toBe(true);
  });
});

describe("BRW-002 launch guard — env vars that reroute the driver", () => {
  const rerouteEnv = ["SELENIUM_REMOTE_URL", "PW_TEST_CONNECT_WS_ENDPOINT"];

  for (const name of rerouteEnv) {
    it(`refuses ${name}`, () => {
      const result = checkBrowserLaunchSafety(SAFE, { [name]: "http://attacker.example/wd" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("remote_endpoint_env");
    });
  }

  it("ignores an empty-string value for those vars", () => {
    // An empty value does not reroute anything; refusing it would make the guard noisy
    // enough to be disabled.
    expect(checkBrowserLaunchSafety(SAFE, { SELENIUM_REMOTE_URL: "" }).ok).toBe(true);
  });
});

describe("BRW-002 launch guard — Chromium's OS sandbox must be ON", () => {
  // Playwright pushes `--no-sandbox` unless `chromiumSandbox === true`
  // (chromium.js:295-296). Every containment argument in this ticket assumes the renderer
  // stays contained, so an omitted flag is a silent downgrade of clause (a).
  it("refuses a launch that omits chromiumSandbox", () => {
    const { chromiumSandbox: _omitted, ...noSandbox } = SAFE;
    const result = checkBrowserLaunchSafety(noSandbox, NO_ENV);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("chromium_sandbox_disabled");
  });

  it("refuses chromiumSandbox: false explicitly", () => {
    const result = checkBrowserLaunchSafety({ ...SAFE, chromiumSandbox: false }, NO_ENV);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("chromium_sandbox_disabled");
  });

  it("refuses --no-sandbox passed directly in args", () => {
    const result = checkBrowserLaunchSafety({ ...SAFE, args: ["--no-sandbox"] }, NO_ENV);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("chromium_sandbox_disabled");
  });

  it("refuses --disable-setuid-sandbox, which defeats the sandbox by another name", () => {
    expect(checkBrowserLaunchSafety({ ...SAFE, args: ["--disable-setuid-sandbox"] }, NO_ENV).ok).toBe(false);
  });

  it("refuses the single-dash and slash spellings of --no-sandbox AS SANDBOX DEFEAT", () => {
    // REPRODUCED bypass: `-no-sandbox` was ACCEPTED by the deny-list version. The reason is
    // asserted for the same argument as the debugging switches — without it, the allow-list
    // backstop would mask a broken normaliser.
    for (const arg of ["-no-sandbox", "/no-sandbox", "-disable-setuid-sandbox", "--NO-SANDBOX"]) {
      const result = checkBrowserLaunchSafety({ ...SAFE, args: [arg] }, NO_ENV);
      expect(result.ok, arg).toBe(false);
      if (result.ok) continue;
      expect(result.reason, arg).toBe("chromium_sandbox_disabled");
    }
  });
});

describe("BRW-002 launch guard — refusal ordering is deterministic", () => {
  // A launch can violate several rules at once. The reported reason must be stable, or a
  // test asserting a reason becomes flaky as the implementation is reordered.
  it("reports cdp_port_requested when a cdpPort and a bad env are both present", () => {
    const result = checkBrowserLaunchSafety(
      { ...SAFE, cdpPort: 9222 },
      { SELENIUM_REMOTE_URL: "http://x/" },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("cdp_port_requested");
  });
});
