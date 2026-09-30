#!/usr/bin/env node
// BRW-002 terrain probe — IS AN ARBITRARY SANDBOX PORT REACHABLE FROM THE PUBLIC INTERNET?
//
// WHY THIS EXISTS. BRW-002's acceptance is "browser process shares only the job sandbox",
// and the frozen golden-journey fixture names `public_cdp_endpoint` as a FORBIDDEN EFFECT
// (tests/fixtures/distributed-execution/browser-approval-download.json). Whether that
// forbidden effect is free or is the hardest part of E8 depends on one fact that CANNOT be
// settled from source:
//
//   Does E2B's edge serve a sandbox's arbitrary user ports to an unauthenticated caller?
//
// The E2B SDK's `getHost(port)` is pure string concatenation — `${port}-${id}.${domain}` —
// with no API call and no "expose" side effect. That means omitting a port-exposure
// operation from AoA's transport is NOT a control: anyone holding the sandboxId can build
// the URL. But whether the resulting URL actually SERVES is a property of E2B's edge, not
// of this repo. Source analysis can only say "plausible". This probe measures it.
//
// The probe runs FROM A GITHUB RUNNER, deliberately: that is a genuinely external network
// location, which is the actual threat model. Running it from inside the sandbox would
// prove nothing.
//
// SAFETY: creates exactly one short-TTL sandbox, always tears it down in `finally`, and
// never prints the API key. Skips cleanly (exit 0, SKIPPED) when E2B_API_KEY is absent —
// never fakes a result.
import { Sandbox } from "e2b";

const KEY = process.env.E2B_API_KEY;
const TEMPLATE = process.env.E2B_TEMPLATE || "base";
// A high, unprivileged port plus the canonical Chromium remote-debugging port. Both are
// probed because the question is about arbitrary user ports, and 9222 is the specific one
// BRW-002 cares about.
const PORTS = [8811, 9222];
const MARKER = `aoa-brw002-probe-${Math.trunc(Number(process.env.PROBE_NONCE || "1"))}`;
const TTL_MS = 120_000;

if (!KEY) {
  console.log("SKIPPED — E2B_API_KEY is not set. No result claimed.");
  process.exit(0);
}

const results = [];
let sandbox = null;

/** Fetch with NO credentials of any kind, from outside the sandbox. */
async function probe(url) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: { "user-agent": "aoa-brw002-probe" },
      signal: AbortSignal.timeout(20_000),
    });
    const body = await res.text().catch(() => "");
    return {
      url,
      reached: true,
      status: res.status,
      servedMarker: body.includes(MARKER),
      bodyPreview: body.slice(0, 200).replace(/\s+/g, " "),
      ms: Date.now() - started,
    };
  } catch (err) {
    return {
      url,
      reached: false,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      ms: Date.now() - started,
    };
  }
}

try {
  console.log(`Creating sandbox from template "${TEMPLATE}" (TTL ${TTL_MS}ms)...`);
  sandbox = await Sandbox.create(TEMPLATE, { apiKey: KEY, timeoutMs: TTL_MS });
  const sandboxId = String(sandbox.sandboxId);
  console.log(`sandboxId = ${sandboxId}`);

  // Serve a known marker so a 200 can be distinguished from an edge/placeholder page.
  await sandbox.files.write(`/home/user/probe/${"index.html"}`, MARKER);
  for (const port of PORTS) {
    await sandbox.commands.run(
      `sh -c 'cd /home/user/probe && nohup python3 -m http.server ${port} >/dev/null 2>&1 & sleep 0.4; echo started'`,
      { timeoutMs: 20_000 },
    );
  }

  // Confirm the listeners are actually up INSIDE the sandbox first. Without this, an
  // unreachable result outside is ambiguous between "edge blocks it" and "nothing listening".
  const inside = await sandbox.commands.run(
    `sh -c 'for p in ${PORTS.join(" ")}; do printf "%s=" "$p"; curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$p/" || echo ERR; printf "\\n"; done'`,
    { timeoutMs: 25_000 },
  );
  const insideOut = String(inside?.stdout ?? "").trim();
  console.log(`in-sandbox loopback check:\n${insideOut}`);

  for (const port of PORTS) {
    const host = await sandbox.getHost(port);
    const url = `https://${host}/`;
    console.log(`probing (unauthenticated, from the runner): ${url}`);
    results.push({ port, ...(await probe(url)) });
  }

  console.log("\n================ RESULT ================");
  console.log(`in-sandbox loopback: ${insideOut.replace(/\n/g, " | ")}`);
  for (const r of results) {
    if (!r.reached) {
      console.log(`port ${r.port}: NOT REACHABLE  (${r.error})  [${r.ms}ms]`);
    } else {
      console.log(
        `port ${r.port}: REACHABLE  http ${r.status}  servedOurMarker=${r.servedMarker}  [${r.ms}ms]  body="${r.bodyPreview}"`,
      );
    }
  }

  const anyServed = results.some((r) => r.reached && r.servedMarker);
  const anyReached = results.some((r) => r.reached);
  console.log("\nVERDICT:");
  if (anyServed) {
    console.log(
      "  PUBLICLY SERVED — an unauthenticated caller outside the sandbox retrieved content\n" +
        "  from an arbitrary in-sandbox port. `public_cdp_endpoint` is NOT free: BRW-002 must\n" +
        "  prevent CDP from binding a TCP port AT ALL (Playwright's default pipe transport),\n" +
        "  because the URL is derivable from the sandboxId alone.\n" +
        "  SCOPE: this probe bound 0.0.0.0, so it says NOTHING about a loopback-only listener.\n" +
        "  Do NOT read it as endorsing a 127.0.0.1 bind — that is untested here, and the E2B\n" +
        "  edge terminates outside the guest, so host intuitions about loopback do not carry.",
    );
  } else if (anyReached) {
    console.log(
      "  REACHED BUT NOT SERVED — the edge answered but did not return our content.\n" +
        "  Inspect the status/body above: an auth challenge (401/403) would mean E2B gates\n" +
        "  non-envd user ports, which materially weakens the exposure risk.",
    );
  } else {
    console.log(
      "  NOT REACHABLE — no unauthenticated route to the sandbox port from the runner.\n" +
        "  Treat as evidence, not proof, and re-check the in-sandbox loopback line above:\n" +
        "  if the listener was not up, this run proves nothing.",
    );
  }
  console.log("========================================\n");
} catch (err) {
  console.error("PROBE ERROR:", err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  process.exitCode = 1;
} finally {
  if (sandbox) {
    try {
      await Sandbox.kill(String(sandbox.sandboxId), { apiKey: KEY });
      console.log("sandbox torn down.");
    } catch (err) {
      console.error(
        "WARNING: teardown failed; the sandbox TTL will reap it.",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}
