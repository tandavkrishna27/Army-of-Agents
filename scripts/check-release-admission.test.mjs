/**
 * REL-004 Lane A — the CLI path, end to end.
 *
 * The pure verdict is tested in `lib/__tests__/release-manifest.test.mjs`. What is tested
 * HERE is that a real invocation actually refuses: the ticket's finding was not a wrong
 * decision function, it was a correct decision function nobody called, so a gate that is
 * only proven at the unit level would repeat exactly that mistake one layer up.
 *
 * The release directory is built at runtime with a freshly generated TEST key rather than
 * committed, so no key material lives in the repository and the fixture cannot drift from
 * the canonical payload builders it is signed with.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { canonicalSigningPayload } from "./lib/image-admission.mjs";
import { canonicalInstallerPayload } from "./lib/installer-admission.mjs";
import { canonicalUpdatePayload } from "./lib/update-admission.mjs";
import { canonicalReleaseManifestPayload } from "./lib/release-manifest.mjs";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "check-release-admission.mjs");
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const trustRoot = publicKey.export({ type: "spki", format: "pem" }).toString();

const CANDIDATE = "c".repeat(40);
const D = {
  control_plane: `sha256:${"1".repeat(64)}`,
  worker: `sha256:${"2".repeat(64)}`,
  sandbox: `sha256:${"3".repeat(64)}`,
  desktop_installer: `sha256:${"4".repeat(64)}`,
  desktop_updater: `sha256:${"5".repeat(64)}`,
};

const sign = (payload) =>
  cryptoSign("sha256", Buffer.from(payload, "utf8"), privateKey).toString("base64");

function buildRelease(mutate = () => {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "aoa-release-"));
  const manifest = {
    schema: 1,
    candidate: CANDIDATE,
    artifacts: {
      control_plane: { digest: D.control_plane, sourceRevision: CANDIDATE },
      worker: { digest: D.worker, sourceRevision: CANDIDATE },
      sandbox: { digest: D.sandbox, sourceRevision: CANDIDATE },
      desktop_installer: { digest: D.desktop_installer, version: "1.2.3", platform: "win32" },
      desktop_updater: {
        digest: D.desktop_updater, fromVersion: "1.2.2", toVersion: "1.2.3", platform: "win32",
      },
    },
  };
  const files = {
    manifest,
    signatures: {
      control_plane: sign(canonicalSigningPayload({ digest: D.control_plane, sourceRevision: CANDIDATE })),
      worker: sign(canonicalSigningPayload({ digest: D.worker, sourceRevision: CANDIDATE })),
      sandbox: sign(canonicalSigningPayload({ digest: D.sandbox, sourceRevision: CANDIDATE })),
      desktop_installer: sign(
        canonicalInstallerPayload({ digest: D.desktop_installer, version: "1.2.3", platform: "win32" }),
      ),
      desktop_updater: sign(
        canonicalUpdatePayload({
          digest: D.desktop_updater, fromVersion: "1.2.2", toVersion: "1.2.3", platform: "win32",
        }),
      ),
    },
    imageAllowlist: ["control_plane", "worker", "sandbox"].map((cls) => ({
      image: cls, digest: D[cls], sourceRevision: CANDIDATE,
    })),
    installerAllowlist: [{ digest: D.desktop_installer, version: "1.2.3", platform: "win32" }],
    revokedVersions: [],
    scanReport: {
      schema: 1,
      candidate: CANDIDATE,
      artifacts: Object.fromEntries(Object.keys(D).map((cls) => [cls, { findings: [] }])),
    },
    vulnerabilityExceptions: { schema: 1, exceptions: [] },
    omit: new Set(),
  };
  mutate(files);

  const write = (name, value) => {
    if (files.omit.has(name)) return;
    writeFileSync(path.join(dir, name), value, "utf8");
  };
  write("manifest.json", JSON.stringify(files.manifest, null, 2));
  write("manifest.sig", sign(canonicalReleaseManifestPayload(files.manifest)));
  write("trust-root.pem", trustRoot);
  write("signatures.json", JSON.stringify(files.signatures, null, 2));
  write("image-allowlist.json", JSON.stringify(files.imageAllowlist, null, 2));
  write("installer-allowlist.json", JSON.stringify(files.installerAllowlist, null, 2));
  write("revoked-versions.json", JSON.stringify(files.revokedVersions, null, 2));
  write("scan-report.json", JSON.stringify(files.scanReport, null, 2));
  write("vulnerability-exceptions.json", JSON.stringify(files.vulnerabilityExceptions, null, 2));
  return dir;
}

function run(dir) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, "--release-dir", dir], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, output: stdout };
  } catch (error) {
    return { code: error.status ?? 1, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

function withRelease(mutate, assertion) {
  const dir = buildRelease(mutate);
  try {
    assertion(run(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("REL-004 — the gate admits a correct release", () => {
  it("exits 0 and names every artifact class", () => {
    // Non-vacuity: without this, a CLI that always exited 1 would pass every case below.
    withRelease(() => {}, ({ code, output }) => {
      assert.equal(code, 0, output);
      assert.match(output, /ADMITTED/);
      for (const cls of Object.keys(D)) assert.match(output, new RegExp(cls));
    });
  });
});

describe("REL-004 — the gate REFUSES, from a real invocation", () => {
  it("refuses a tampered digest", () => {
    withRelease((f) => { f.manifest.artifacts.worker.digest = `sha256:${"f".repeat(64)}`; },
      ({ code, output }) => {
        assert.equal(code, 1);
        assert.match(output, /REFUSED/);
      });
  });

  it("refuses an incomplete release", () => {
    withRelease((f) => { delete f.manifest.artifacts.sandbox; }, ({ code, output }) => {
      assert.equal(code, 1);
      assert.match(output, /missing_artifact_class/);
      assert.match(output, /sandbox/);
    });
  });

  it("refuses an unsigned artifact", () => {
    withRelease((f) => { f.signatures.desktop_installer = ""; }, ({ code, output }) => {
      assert.equal(code, 1);
      assert.match(output, /desktop_installer/);
    });
  });

  it("refuses an artifact that was never promoted", () => {
    withRelease((f) => { f.imageAllowlist = f.imageAllowlist.filter((e) => e.image !== "sandbox"); },
      ({ code, output }) => {
        assert.equal(code, 1);
        assert.match(output, /sandbox/);
      });
  });

  it("refuses a revoked desktop update", () => {
    withRelease((f) => { f.revokedVersions = ["1.2.3"]; }, ({ code, output }) => {
      assert.equal(code, 1);
      assert.match(output, /version_revoked/);
    });
  });

  it("refuses when the deny-list file is ABSENT, rather than assuming nothing is revoked", () => {
    // DSK-004's D6, enforced at the IO boundary too: a missing policy file is a refusal.
    // Treating it as an empty list is how a withdrawn build gets promoted during an outage
    // of whatever serves the list.
    withRelease((f) => { f.omit.add("revoked-versions.json"); }, ({ code, output }) => {
      assert.equal(code, 1);
      assert.match(output, /cannot read the release/);
      assert.match(output, /revoked-versions\.json/);
    });
  });

  it("refuses when ANY required file is missing", () => {
    for (const name of [
      "manifest.json", "manifest.sig", "trust-root.pem",
      "signatures.json", "image-allowlist.json", "installer-allowlist.json",
      "scan-report.json", "vulnerability-exceptions.json",
    ]) {
      withRelease((f) => { f.omit.add(name); }, ({ code, output }) => {
        assert.equal(code, 1, name);
        assert.match(output, new RegExp(name.replace(".", "\\.")), name);
      });
    }
  });

  it("refuses a CRITICAL vulnerability on the same invocation as admission", () => {
    // Clause 1 and clause 2 gate the same promotion. Two separate commands would be two
    // chances to run only one of them, and the one skipped would be the one that failed.
    withRelease((f) => {
      f.scanReport.artifacts.worker.findings.push({
        id: "CVE-2026-9999", severity: "critical", package: "libfoo",
      });
    }, ({ code, output }) => {
      assert.equal(code, 1);
      assert.match(output, /blocked_by_vulnerability/);
      assert.match(output, /CVE-2026-9999/);
    });
  });

  it("refuses when the scan report is ABSENT, rather than promoting an unscanned build", () => {
    withRelease((f) => { f.omit.add("scan-report.json"); }, ({ code, output }) => {
      assert.equal(code, 1);
      assert.match(output, /scan-report\.json/);
    });
  });

  it("exits 2 without a --release-dir, rather than checking nothing and passing", () => {
    // A gate invoked wrongly must not look like a gate that passed.
    const { code } = (() => {
      try {
        execFileSync(process.execPath, [CLI], { encoding: "utf8", stdio: "pipe" });
        return { code: 0 };
      } catch (error) {
        return { code: error.status };
      }
    })();
    assert.equal(code, 2);
  });
});
