// packages/worker-keystore/src/bin/aoa-worker-desktop.ts
//
// DSK-001 — the real entry point. Everything testable lives in
// `runDesktopHost`; this file is the `invokedDirectly` guard and nothing else,
// copying the shape of `worker-daemon/src/bin/worker-daemon.ts`.
//
// ONE DELIBERATE DIVERGENCE from that shape. The daemon's guard ends with
//
//     console.error(err && err.stack ? err.stack : String(err));
//
// which is the single path in the whole process that bypasses the logger's
// redactor. That is a known hazard there (I13) and it is a worse hazard here,
// because this host is the one that holds an enrollment ticket: an error thrown
// anywhere between reading the ticket and enrolling could carry it in a message
// or a stack frame, and it would print in full.
//
// Nothing in the coordinator interpolates the credential today — `ticket.ts`
// names only the failing constraint, and `enrollment-input.ts` never echoes file
// contents — so this is a last line of defence rather than a live leak. It costs
// one pure function, and "the credential cannot print" should not depend on
// every future error message remembering not to include it.

import process from "node:process";
import { pathToFileURL } from "node:url";

import { runDesktopHost } from "./desktop-host.js";

/**
 * Mask anything shaped like an enrollment code.
 *
 * The pattern mirrors the server's own regex (`worker-enrollment.ts:80-84`) and
 * the client mirror in `ticket.ts`, so it matches exactly what a real credential
 * looks like and nothing else. Pure, and exported so it is tested directly
 * rather than through a process that has to be spawned to observe.
 */
export function redactEnrollmentCodes(text: string): string {
  return text.replace(/aoa_enr_[A-Za-z0-9_-]{16,64}\.[A-Za-z0-9_-]{32,128}/g, "aoa_enr_[redacted]");
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  runDesktopHost({
    env: process.env,
    proc: process,
    platform: process.platform,
    argv: process.argv.slice(2),
  })
    .then((result) => {
      if (!result.ok) process.exit(1);
    })
    .catch((err: unknown) => {
      const detail = err instanceof Error && err.stack ? err.stack : String(err);
      console.error(redactEnrollmentCodes(detail));
      process.exit(1);
    });
}
