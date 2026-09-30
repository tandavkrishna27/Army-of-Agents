/**
 * REL-004 Lane A — the release manifest, and the gate that finally CALLS the three
 * admission verifiers (clause 1, I1–I4).
 *
 * The terrain map for this ticket found that `evaluateAdmission` (DEP-001),
 * `evaluateInstallerAdmission` (DSK-003) and `evaluateUpdateAdmission` (DSK-004) had no
 * caller anywhere outside their own unit suites. Three fail-closed, mutation-tested
 * verifiers, and nothing consulted any of them — so "an unapproved digest cannot run" was
 * vacuously true: nothing could be refused because nothing was checked.
 *
 * Two of the three orphans were my own work. So the test that matters most in this file is
 * not any single refusal — it is `no admission verifier is orphaned`, which fails if a
 * verifier module exists that the gate does not dispatch to. That is the part that stops
 * the finding from recurring.
 *
 * The manifest itself answers a question no per-artifact verifier can: not "is this digest
 * signed and allowlisted" but "are these the five artifacts of candidate X, and are they
 * ALL here". A promotion that silently omitted the sandbox image passes every existing
 * check today.
 */

import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";

import { canonicalInstallerPayload } from "../installer-admission.mjs";
import { canonicalSigningPayload } from "../image-admission.mjs";
import { canonicalUpdatePayload } from "../update-admission.mjs";
import {
  ARTIFACT_VERIFIERS,
  RELEASE_ARTIFACT_CLASSES,
  RELEASE_ARTIFACT_KINDS,
  RELEASE_MANIFEST_PAYLOAD_TYPE,
  canonicalReleaseManifestPayload,
  evaluateReleaseAdmission,
  evaluateReleaseManifest,
} from "../release-manifest.mjs";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const trustRoot = publicKey.export({ type: "spki", format: "pem" }).toString();

const CANDIDATE = "a".repeat(40);
const digestFor = (c) => `sha256:${c.repeat(64)}`;

const DIGESTS = {
  control_plane: digestFor("1"),
  worker: digestFor("2"),
  sandbox: digestFor("3"),
  desktop_installer: digestFor("4"),
  desktop_updater: digestFor("5"),
};

function sign(payload) {
  return cryptoSign("sha256", Buffer.from(payload, "utf8"), privateKey).toString("base64");
}

function manifest(overrides = {}) {
  return {
    schema: 1,
    candidate: CANDIDATE,
    artifacts: {
      control_plane: { digest: DIGESTS.control_plane, sourceRevision: CANDIDATE },
      worker: { digest: DIGESTS.worker, sourceRevision: CANDIDATE },
      sandbox: { digest: DIGESTS.sandbox, sourceRevision: CANDIDATE },
      desktop_installer: { digest: DIGESTS.desktop_installer, version: "1.2.3", platform: "win32" },
      desktop_updater: {
        digest: DIGESTS.desktop_updater,
        fromVersion: "1.2.2",
        toVersion: "1.2.3",
        platform: "win32",
      },
    },
    ...overrides,
  };
}

const signedManifest = (m = manifest()) => ({
  manifest: m,
  signature: sign(canonicalReleaseManifestPayload(m)),
  trustRoot,
});

describe("REL-004/I1 — the manifest is COMPLETE or it is refused", () => {
  it("admits a complete, correctly signed manifest", () => {
    // Non-vacuity: without this, a function that always refused would pass every case below.
    assert.deepEqual(evaluateReleaseManifest(signedManifest()), { admitted: true });
  });

  it("refuses when ANY artifact class is missing, naming the class", () => {
    for (const missing of RELEASE_ARTIFACT_CLASSES) {
      const m = manifest();
      delete m.artifacts[missing];
      const result = evaluateReleaseManifest({
        manifest: m,
        signature: sign(canonicalReleaseManifestPayload(m)),
        trustRoot,
      });
      assert.equal(result.admitted, false, missing);
      assert.equal(result.reason, "missing_artifact_class", missing);
      assert.equal(result.artifactClass, missing);
    }
  });

  it("refuses an UNKNOWN artifact class rather than ignoring it", () => {
    // Default-deny. An unrecognized class means the manifest and this gate disagree about
    // what a release contains, and the safe reading of that disagreement is not "ignore
    // the part I do not understand".
    const m = manifest();
    m.artifacts.mystery_box = { digest: digestFor("9") };
    const result = evaluateReleaseManifest({
      manifest: m,
      signature: sign(canonicalReleaseManifestPayload(m)),
      trustRoot,
    });
    assert.equal(result.admitted, false);
    assert.equal(result.reason, "unknown_artifact_class");
  });

  it("declares a kind for every class, and only known kinds", () => {
    for (const cls of RELEASE_ARTIFACT_CLASSES) {
      assert.ok(RELEASE_ARTIFACT_KINDS[cls], cls);
      assert.ok(Object.hasOwn(ARTIFACT_VERIFIERS, RELEASE_ARTIFACT_KINDS[cls]), cls);
    }
  });
});

describe("REL-004/I2 — the manifest signature is domain-separated", () => {
  it("uses a payload type distinct from all three per-artifact types", () => {
    const payload = canonicalReleaseManifestPayload(manifest());
    assert.match(payload, new RegExp(RELEASE_MANIFEST_PAYLOAD_TYPE));
    for (const other of [
      canonicalSigningPayload({ digest: DIGESTS.worker, sourceRevision: CANDIDATE }),
      canonicalInstallerPayload({ digest: DIGESTS.desktop_installer, version: "1.2.3", platform: "win32" }),
      canonicalUpdatePayload({
        digest: DIGESTS.desktop_updater, fromVersion: "1.2.2", toVersion: "1.2.3", platform: "win32",
      }),
    ]) {
      assert.notEqual(payload, other);
      // Asserting the payloads merely DIFFER is too weak — they differ anyway because
      // their structures differ, so the type string could collide and this would still
      // pass. The property is that the type is UNIQUE across schemes, which is what makes
      // it domain separation rather than decoration.
      assert.ok(
        !other.includes(RELEASE_MANIFEST_PAYLOAD_TYPE),
        `type ${RELEASE_MANIFEST_PAYLOAD_TYPE} also appears in ${other}`,
      );
    }
  });

  it("refuses a per-artifact signature replayed as a manifest signature", () => {
    // Without domain separation an installer signature would authorize a whole release.
    const result = evaluateReleaseManifest({
      manifest: manifest(),
      signature: sign(
        canonicalInstallerPayload({ digest: DIGESTS.desktop_installer, version: "1.2.3", platform: "win32" }),
      ),
      trustRoot,
    });
    assert.equal(result.admitted, false);
    assert.equal(result.reason, "signature_invalid");
  });

  it("binds the candidate AND every artifact digest", () => {
    const base = signedManifest();
    for (const mutate of [
      (m) => { m.candidate = "b".repeat(40); },
      ...RELEASE_ARTIFACT_CLASSES.map((cls) => (m) => { m.artifacts[cls].digest = digestFor("f"); }),
    ]) {
      const tampered = manifest();
      mutate(tampered);
      const result = evaluateReleaseManifest({ ...base, manifest: tampered });
      assert.equal(result.admitted, false, JSON.stringify(tampered.candidate));
      assert.equal(result.reason, "signature_invalid");
    }
  });

  it("orders artifacts canonically, not by object key order", () => {
    // Signer and verifier must produce byte-identical payloads regardless of how the
    // manifest JSON happened to be serialized.
    const forward = manifest();
    const reversed = { ...forward, artifacts: {} };
    for (const cls of [...RELEASE_ARTIFACT_CLASSES].reverse()) {
      reversed.artifacts[cls] = forward.artifacts[cls];
    }
    assert.equal(
      canonicalReleaseManifestPayload(forward),
      canonicalReleaseManifestPayload(reversed),
    );
  });
});

describe("REL-004 — a malformed manifest is refused, never guessed", () => {
  const bad = [
    ["malformed_manifest", { schema: 2 }],
    ["malformed_manifest", { schema: undefined }],
    ["malformed_candidate", { candidate: "not-a-sha" }],
    ["malformed_candidate", { candidate: "" }],
    ["malformed_manifest", { artifacts: undefined }],
    ["malformed_manifest", { artifacts: [] }],
  ];
  for (const [reason, override] of bad) {
    it(`refuses with ${reason} for ${JSON.stringify(override)}`, () => {
      const m = manifest(override);
      const result = evaluateReleaseManifest({
        manifest: m, signature: sign(canonicalReleaseManifestPayload(m)), trustRoot,
      });
      assert.equal(result.admitted, false);
      assert.equal(result.reason, reason);
    });
  }

  it("refuses a malformed artifact digest at the MANIFEST level, naming the class", () => {
    // The per-artifact verifier would also refuse this, but only once the gate reached it.
    // `evaluateReleaseManifest` is exported and used on its own, so it must be
    // self-consistent — and naming the class beats a generic malformed_digest.
    for (const cls of RELEASE_ARTIFACT_CLASSES) {
      const m = manifest();
      m.artifacts[cls].digest = "not-a-digest";
      const result = evaluateReleaseManifest({
        manifest: m, signature: sign(canonicalReleaseManifestPayload(m)), trustRoot,
      });
      assert.equal(result.admitted, false, cls);
      assert.equal(result.reason, "malformed_artifact_digest", cls);
      assert.equal(result.artifactClass, cls);
    }
  });

  it("distinguishes an ABSENT signature from an invalid one", () => {
    // Different operator stories: "this was never signed" sends them to the signing step,
    // "this signature does not match" sends them to the key or to tampering. Collapsing
    // them into signature_invalid loses that.
    for (const signature of [undefined, "", null, 7]) {
      const result = evaluateReleaseManifest({ ...signedManifest(), signature });
      assert.equal(result.reason, "missing_signature", JSON.stringify(signature) ?? "undefined");
    }
    assert.equal(
      evaluateReleaseManifest({ ...signedManifest(), signature: "bm90LWEtc2ln" }).reason,
      "signature_invalid",
    );
  });

  it("refuses a missing trust root, and never throws on garbage", () => {
    assert.equal(evaluateReleaseManifest({ ...signedManifest(), trustRoot: undefined }).reason,
      "missing_trust_root");
    for (const garbage of [undefined, null, 0, "", [], { manifest: 7 }]) {
      assert.equal(evaluateReleaseManifest(garbage).admitted, false, JSON.stringify(garbage) ?? "undefined");
    }
  });
});

// ---------------------------------------------------------------------------
// The gate: the manifest verdict PLUS every per-artifact verifier.
// ---------------------------------------------------------------------------

const imageAllowlist = ["control_plane", "worker", "sandbox"].map((cls) => ({
  image: cls, digest: DIGESTS[cls], sourceRevision: CANDIDATE,
}));
const installerAllowlist = [{ digest: DIGESTS.desktop_installer, version: "1.2.3", platform: "win32" }];

function fullRequest(overrides = {}) {
  const m = overrides.manifest ?? manifest();
  return {
    manifest: m,
    signature: sign(canonicalReleaseManifestPayload(m)),
    trustRoot,
    imageAllowlist,
    installerAllowlist,
    revokedVersions: [],
    signatures: {
      control_plane: sign(canonicalSigningPayload({ digest: DIGESTS.control_plane, sourceRevision: CANDIDATE })),
      worker: sign(canonicalSigningPayload({ digest: DIGESTS.worker, sourceRevision: CANDIDATE })),
      sandbox: sign(canonicalSigningPayload({ digest: DIGESTS.sandbox, sourceRevision: CANDIDATE })),
      desktop_installer: sign(
        canonicalInstallerPayload({ digest: DIGESTS.desktop_installer, version: "1.2.3", platform: "win32" }),
      ),
      desktop_updater: sign(
        canonicalUpdatePayload({
          digest: DIGESTS.desktop_updater, fromVersion: "1.2.2", toVersion: "1.2.3", platform: "win32",
        }),
      ),
    },
    ...overrides,
  };
}

describe("REL-004/I3 — the gate refuses when ANY verifier refuses", () => {
  it("admits a release whose manifest and every artifact check out", () => {
    const result = evaluateReleaseAdmission(fullRequest());
    assert.equal(result.admitted, true, JSON.stringify(result));
    assert.equal(result.artifacts.length, RELEASE_ARTIFACT_CLASSES.length);
    assert.ok(result.artifacts.every((a) => a.admitted));
  });

  it("refuses when an IMAGE digest is not on the image allowlist", () => {
    const result = evaluateReleaseAdmission(fullRequest({ imageAllowlist: [imageAllowlist[0]] }));
    assert.equal(result.admitted, false);
    assert.equal(result.reason, "artifact_refused");
    const failed = result.artifacts.filter((a) => !a.admitted).map((a) => a.artifactClass);
    assert.deepEqual(failed.sort(), ["sandbox", "worker"]);
  });

  it("refuses when the INSTALLER was never released", () => {
    // An EMPTY allowlist is a well-formed allowlist that promoted nothing, which is a
    // different fact from an ABSENT one — the verifier distinguishes them and so does this.
    const empty = evaluateReleaseAdmission(fullRequest({ installerAllowlist: [] }));
    assert.equal(empty.admitted, false);
    assert.equal(
      empty.artifacts.find((a) => a.artifactClass === "desktop_installer").reason,
      "digest_not_allowlisted",
    );

    const absent = evaluateReleaseAdmission(fullRequest({ installerAllowlist: undefined }));
    assert.equal(
      absent.artifacts.find((a) => a.artifactClass === "desktop_installer").reason,
      "missing_allowlist",
    );
  });

  it("refuses when the UPDATER target version is revoked", () => {
    // Proves the update verifier is genuinely consulted, and that its deny-list reaches it.
    const result = evaluateReleaseAdmission(fullRequest({ revokedVersions: ["1.2.3"] }));
    assert.equal(result.admitted, false);
    assert.equal(
      result.artifacts.find((a) => a.artifactClass === "desktop_updater").reason,
      "version_revoked",
    );
  });

  it("refuses the whole release when the MANIFEST is bad, without claiming artifact verdicts", () => {
    const m = manifest();
    delete m.artifacts.sandbox;
    const result = evaluateReleaseAdmission(fullRequest({ manifest: m }));
    assert.equal(result.admitted, false);
    assert.equal(result.reason, "missing_artifact_class");
    assert.deepEqual(result.artifacts, []);
  });

  it("never throws on caller-supplied garbage", () => {
    for (const garbage of [undefined, null, 0, "", [], { manifest: 7 }]) {
      assert.equal(evaluateReleaseAdmission(garbage).admitted, false, JSON.stringify(garbage) ?? "undefined");
    }
  });
});

describe("REL-004/I4 — no admission verifier is orphaned", () => {
  it("dispatches to EVERY admission verifier that exists on disk", async () => {
    // THE TEST THIS TICKET EXISTS FOR. Three verifiers were built, mutation-tested and
    // wired to nothing; the acceptance clause they served was vacuously true for the whole
    // programme. A future fourth verifier must not be able to repeat that: this fails
    // until the gate dispatches to it.
    const libDir = path.dirname(fileURLToPath(import.meta.url)).replace(/__tests__$/, "");
    const modules = readdirSync(libDir).filter((f) => /admission.*\.mjs$/.test(f));
    assert.ok(modules.length >= 3, `expected the known verifiers, found ${modules.join(", ")}`);

    const wired = new Set(Object.values(ARTIFACT_VERIFIERS));
    for (const file of modules) {
      const mod = await import(pathToFileURL(path.join(libDir, file)).href);
      const evaluators = Object.entries(mod).filter(
        ([name, value]) => typeof value === "function" && /^evaluate/.test(name),
      );
      assert.ok(evaluators.length > 0, `${file} exports no evaluate* function`);
      for (const [name, fn] of evaluators) {
        assert.ok(wired.has(fn), `${file}: ${name} is not reachable from the release gate`);
      }
    }
  });
});
