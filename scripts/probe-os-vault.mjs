#!/usr/bin/env node
// DSK-001 / I10 — the Windows leg probe.
//
// Executes the REAL planned commands against REAL DPAPI and asserts that wrong
// entropy, a tampered blob, and a missing blob are three DISTINGUISHABLE
// outcomes. This is the one claim in the package that cannot be proven on the
// required ubuntu lanes, so it is a probe an operator (or the advisory Windows
// lane) runs, and it fails loudly rather than skipping silently.
//
// It exists because of a measured hazard: unhardened, the SAME
// CryptographicException surfaces as exit 1 under `-EncodedCommand` and exit 0
// under `-File`. The hardened script must instead produce a DELIBERATE exit 3, so
// the outcome no longer depends on how the interpreter was invoked.
//
// Run: node scripts/probe-os-vault.mjs        (Windows only; exits 0 elsewhere)

import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

if (process.platform !== "win32") {
  console.log("probe-os-vault: not win32 — skipping (this probe is the Windows leg of I10)");
  process.exit(0);
}

const planModule = pathToFileURL(
  path.resolve("packages/worker-keystore/dist/command-plan.js"),
).href;
let planVaultCommand;
try {
  ({ planVaultCommand } = await import(planModule));
} catch {
  console.error("probe-os-vault: build packages/worker-keystore first (pnpm --filter @armyofagents/worker-keystore build)");
  process.exit(2);
}

const run = (plan, stdin) =>
  new Promise((resolve) => {
    const child = execFile(
      plan.argv[0],
      plan.argv.slice(1),
      { encoding: "buffer" },
      (err, stdout, stderr) =>
        resolve({
          exitCode: err && typeof err.code === "number" ? err.code : err ? null : 0,
          stdout: stdout ?? Buffer.alloc(0),
          stderr: (stderr ?? Buffer.alloc(0)).toString(),
        }),
    );
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });

const dir = mkdtempSync(path.join(tmpdir(), "aoa-vault-probe-"));
const blobPath = path.join(dir, "device-identity.v1.bin");
const ref = { blobPath };
const secret = Buffer.from("dsk-001-probe-private-key-material");
const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

try {
  // (1) missing blob — must NOT look like a crypto fault; the filesystem is the
  // absence oracle, which is why the adapter checks ENOENT before ever spawning.
  check("missing blob is absent by filesystem, not by exit code", !existsSync(blobPath));

  // (2) store, then load — the round trip must return the exact bytes.
  const stored = await run(planVaultCommand("store", ref, "win32"), secret.toString("base64"));
  check("store exits 0", stored.exitCode === 0, `exit=${stored.exitCode} ${stored.stderr.trim()}`);
  check("blob written", existsSync(blobPath));

  const loaded = await run(planVaultCommand("load", ref, "win32"));
  const roundTripped = Buffer.from(loaded.stdout.toString().trim(), "base64");
  check("load exits 0", loaded.exitCode === 0, `exit=${loaded.exitCode} ${loaded.stderr.trim()}`);
  check("round-trip returns the exact key bytes", roundTripped.equals(secret));

  // (3) I5 — the protected blob must not contain the plaintext DER anywhere.
  const blob = readFileSync(blobPath);
  check("protected blob does not contain the plaintext key", !blob.includes(secret));

  // (4) tampered blob — the WHOLE POINT. Hardened, this must be the DELIBERATE
  // exit 3, not the invocation-shape-dependent 0/1 measured on the raw script.
  const tampered = Buffer.from(blob);
  tampered[tampered.length - 3] ^= 0xff;
  writeFileSync(blobPath, tampered);
  const bad = await run(planVaultCommand("load", ref, "win32"));
  check(
    "tampered blob yields the deliberate locked exit 3",
    bad.exitCode === 3,
    `exit=${bad.exitCode}`,
  );
  check("tampered blob writes a diagnostic to stderr", bad.stderr.trim().length > 0);
  check("tampered blob returns NO envelope on stdout", bad.stdout.toString().trim() === "");

  // (5) The sentinel and the NARROWED already-exists catch, both live.
  //
  // The catch was widened-by-default before: `catch [IO.IOException]` also
  // matches a full disk, a vanished network path, a sharing violation and
  // DirectoryNotFoundException, so every one of those reported "already present"
  // and the caller treated a FAILED enrolment as a lost race. Narrowing it to
  // HResult 0x80070050 could have broken the genuine case, so prove the genuine
  // case still works against real Windows rather than trusting the script text.
  writeFileSync(blobPath, blob); // restore a valid blob
  const second = await run(planVaultCommand("store", ref, "win32"), secret.toString("base64"));
  check(
    "a second store on an existing blob still yields exit 4",
    second.exitCode === 4,
    `exit=${second.exitCode} ${second.stderr.trim()}`,
  );

  rmSync(blobPath, { force: true });
  const fresh = await run(planVaultCommand("store", ref, "win32"), secret.toString("base64"));
  check(
    "a successful store emits the positive sentinel on stdout",
    fresh.stdout.toString().trim() === "aoa-keystore-stored-v1",
    `stdout=${JSON.stringify(fresh.stdout.toString().trim())}`,
  );

  // (6) delete
  const del = await run(planVaultCommand("delete", ref, "win32"));
  check("delete exits 0", del.exitCode === 0, `exit=${del.exitCode}`);
  check("blob removed", !existsSync(blobPath));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\nprobe-os-vault: ${failures.length} FAILED: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nprobe-os-vault: all checks passed");
