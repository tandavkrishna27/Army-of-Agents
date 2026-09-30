/**
 * worker-keystore-boundary.mjs — pure boundary logic for the DSK-001 leaf package
 * `@armyofagents/worker-keystore`.
 *
 * Forked in STRUCTURE from `scripts/lib/sandbox-e2b-provider-boundary.mjs`, but
 * the confined capability is different. The e2b leaf confines a CREDENTIAL to one
 * file; this leaf confines SUBPROCESS EXECUTION to one file.
 *
 * WHY THIS CHECKER EXISTS. The whole point of the package is that a private
 * device key crosses a process boundary on stdin. Everything that decides HOW
 * that happens — the planner, the outcome classifier, the envelope codec, the
 * store — is pure and OS-free so it is provable on the ubuntu-only REQUIRED CI
 * lane. That decomposition is only meaningful if the dangerous capability
 * actually stays in one place. Review cannot guarantee that; a mechanical
 * PATH confinement can. (The e2b leaf's CREDENTIAL_HOST_BASENAME is the same idea
 * keyed on a basename — which is weaker, and was the bug here: a same-named file
 * in a subdirectory inherited the permission.)
 *
 * Policy:
 *   - The manifest declares EXACTLY `@armyofagents/sandbox-e2b-provider`,
 *     `@armyofagents/worker-daemon` and `@armyofagents/worker-protocol`. Adding
 *     anything else is a STOP for controller approval — a native keychain binding
 *     (keytar, @napi-rs/keyring) must never arrive here by accident, because this
 *     package is injected INTO the daemon's process. The provider package was added
 *     under go-book §8 decision D-3 (Sprint 2 / DEP-010), which PAYS FOR the widening
 *     by making this checker TIGHTER, not merely wider — the two rules below.
 *   - `@armyofagents/sandbox-e2b-provider` (whose transitive closure pulls the `e2b`
 *     network SDK into this key-holding process) may be named from EXACTLY ONE runtime
 *     source PATH, `src/bin/sandbox-provider.ts` — a full package-relative path, not a
 *     basename, so a same-named file in a subdirectory cannot inherit the permission.
 *   - The provider-control credential `E2B_API_KEY` may appear in ZERO runtime source
 *     files here — not "one host file", zero. This package has no legitimate reason to
 *     name the credential (the transport reads it itself; DEP-006 confinement), and the
 *     scan is over RAW source, so even a comment naming it is a violation. Mirrors
 *     `sandbox-e2b-provider-boundary.mjs`'s raw-source credential scan.
 *   - `node:child_process` (and the bare `child_process`) may be imported from
 *     EXACTLY ONE runtime source PATH, `src/command-runner.ts`.
 *   - Non-literal imports and the `node:module` createRequire bridge are rejected,
 *     because either would let arbitrary code reach the process holding the key.
 *
 * The lexical scanner is the ONE canonical implementation shared with the
 * worker-protocol boundary — imported, never duplicated.
 */

import path from "node:path";
import { builtinModules } from "node:module";

import {
  classifyRuntimeSourceFileName,
  extractModuleSpecifiers,
  findForbiddenGlobals,
  tokenizeSource,
} from "./worker-protocol-boundary.mjs";

export { classifyRuntimeSourceFileName };

/**
 * Runtime dependencies this leaf may declare — EXACTLY these three, pre-sorted so a
 * `.sort()`ed manifest key list compares by value.
 *
 * The dependency arrow points keystore → daemon and never the reverse: the
 * daemon's own manifest is pinned to `["@armyofagents/worker-protocol","pino"]`
 * and `scripts/check-worker-daemon-boundary.mjs` rejects a bare specifier the
 * moment a file under `packages/worker-daemon/src` names it. So the host composes
 * this package in; the daemon never imports it.
 *
 * `@armyofagents/sandbox-e2b-provider` was added under go-book §8 D-3 (DEP-010): the
 * host resolves a real provider and injects it, but ONLY the one confined file below
 * may name that package, and the credential it fronts may not be named at all.
 */
export const REQUIRED_RUNTIME_DEPENDENCIES = [
  "@armyofagents/sandbox-e2b-provider",
  "@armyofagents/worker-daemon",
  "@armyofagents/worker-protocol",
];

/**
 * The single runtime source file permitted to spawn a subprocess, as a full
 * package-relative path.
 *
 * It was a BASENAME, and that was a real hole: a file at
 * `src/anything/command-runner.ts` inherited spawn permission simply by being
 * named the same. Demonstrated live — the checker passed such a file — so the
 * confinement was bypassable by anyone who created a subdirectory. "One
 * dangerous capability, one file" has to mean one PATH.
 */
export const SUBPROCESS_HOST_PATH = "src/command-runner.ts";

/**
 * The provider package, and the SINGLE runtime source path allowed to name it (DEP-010, D-3).
 *
 * Modelled on SUBPROCESS_HOST_PATH — a full package-relative path, not a basename, for the
 * same reason: a same-named file in a subdirectory must not inherit the permission. The
 * package's transitive closure pulls the `e2b` network SDK into this key-holding process, so
 * "one dangerous capability, one file" applies here exactly as it does to subprocess spawn.
 * The confined file (`bin/sandbox-provider.ts`) uses a LITERAL DYNAMIC import so the SDK is
 * not loaded on the default boot that constructs no provider.
 */
export const PROVIDER_SPECIFIER = "@armyofagents/sandbox-e2b-provider";
export const PROVIDER_HOST_PATH = "src/bin/sandbox-provider.ts";

/**
 * Provider-control credential tokens banned from EVERY runtime source file here (DEP-010, D-3).
 *
 * Not "one host file" — ZERO. The credential is read by the transport in the e2b leaf (DEP-006
 * confinement); this package composes the provider without ever touching the key, so its NAME
 * has no business in the key-holding package. Scanned over RAW source in
 * `evaluateRuntimeSourceImports`, so even a comment naming it counts — the same rule as
 * `sandbox-e2b-provider-boundary.mjs`'s CREDENTIAL_TOKEN scan.
 */
export const FORBIDDEN_CREDENTIAL_TOKENS = ["E2B_API_KEY"];

/**
 * The banned boolean-absence oracle, matched as a CODE TOKEN.
 *
 * Two earlier attempts at this line were wrong in instructive ways. The first
 * carried RAW 0x08 backspace bytes where `\b` was intended, so the regex matched
 * nothing while the corpus still reported green — a guard that was dead the day
 * it was written. The second was a plain substring scan over raw source, which
 * then flagged `command-runner.ts` for the COMMENTS explaining why existsSync was
 * removed: a checker that makes you delete the explanation of a bug is a bad
 * checker.
 *
 * The shared tokenizer already discards comments and string contents, so a `word`
 * token is the honest unit. It catches the named import and `fs.existsSync(...)`
 * alike, and prose is invisible to it.
 */
const BANNED_ORACLE_WORD = "existsSync";

/** Specifiers that grant subprocess execution. */
const SUBPROCESS_SPECIFIERS = new Set(["child_process", "node:child_process"]);

const NODE_BUILTINS = new Set(builtinModules);
const ALLOWED_BARE = new Set([
  // The provider specifier is allowed here, but ONLY after the PROVIDER_HOST_PATH check in
  // evaluateRuntimeSourceImports has passed — that check runs first and rejects it from any
  // other file, so membership here grants nothing outside `src/bin/sandbox-provider.ts`.
  PROVIDER_SPECIFIER,
  "@armyofagents/worker-daemon",
  "@armyofagents/worker-protocol",
]);

/** `node:module`/`module` expose `createRequire`, which resolves ANY package from
 * the hoisted monorepo node_modules at runtime — forbidden even as a builtin. */
const FORBIDDEN_BRIDGE_BUILTINS = new Set(["module", "node:module"]);

function isNodeBuiltin(specifier) {
  if (specifier.startsWith("node:")) return true;
  if (NODE_BUILTINS.has(specifier)) return true;
  const root = specifier.split("/")[0];
  return NODE_BUILTINS.has(root);
}

function isAllowedBareImport(specifier) {
  if (ALLOWED_BARE.has(specifier)) return true;
  if (FORBIDDEN_BRIDGE_BUILTINS.has(specifier)) return false;
  return isNodeBuiltin(specifier);
}

const TEST_SPECIFIER_RE = /\.test(?:\.[cm]?[jt]s)?$/;

/**
 * Validate the imports of a single runtime source file.
 * @param {{relPath:string, absPath:string, sourceRoot:string, source:string}} args
 * @returns {string[]} policy-violation messages (empty ⇒ clean)
 */
export function evaluateRuntimeSourceImports({ relPath, absPath, sourceRoot, source }) {
  const errors = [];
  for (const spec of extractModuleSpecifiers(source)) {
    if (spec.nonLiteral || spec.value == null) {
      errors.push(`${relPath}: non-literal ${spec.kind} import is forbidden in runtime source`);
      continue;
    }
    const value = spec.value;
    if (value.startsWith("./") || value.startsWith("../")) {
      if (TEST_SPECIFIER_RE.test(value)) {
        errors.push(`${relPath}: runtime import of test source is forbidden: ${JSON.stringify(value)}`);
        continue;
      }
      const resolved = path.resolve(path.dirname(absPath), value);
      if (resolved === sourceRoot || resolved.startsWith(`${sourceRoot}${path.sep}`)) continue;
      errors.push(`${relPath}: relative import escapes package src: ${JSON.stringify(value)}`);
      continue;
    }
    // Subprocess confinement: ONLY `command-runner.ts` may spawn.
    // The confinement keys on the FULL package-relative path. A basename check
    // let `src/anything/command-runner.ts` inherit spawn permission.
    const packageRelative = relPath.slice(relPath.indexOf("/src/") + 1);
    if (SUBPROCESS_SPECIFIERS.has(value) && packageRelative !== SUBPROCESS_HOST_PATH) {
      errors.push(
        `${relPath}: ${JSON.stringify(value)} may be imported ONLY from ${SUBPROCESS_HOST_PATH} — ` +
          "subprocess execution is confined to ONE PATH so the pure decision logic stays OS-free",
      );
      continue;
    }
    // DEP-010 (D-3) — provider confinement: ONLY `bin/sandbox-provider.ts` may name the
    // provider package. Keyed on the FULL package-relative path (a basename check would let a
    // subdirectory copy inherit permission), so the `e2b` SDK enters this key-holding process
    // from one reviewable file and nowhere else. Runs BEFORE the allow-list so a rejected path
    // never reaches it.
    if (value === PROVIDER_SPECIFIER && packageRelative !== PROVIDER_HOST_PATH) {
      errors.push(
        `${relPath}: ${JSON.stringify(value)} may be imported ONLY from ${PROVIDER_HOST_PATH} — ` +
          "the provider package pulls the e2b network SDK into the key-holding process, so it is " +
          "confined to ONE PATH",
      );
      continue;
    }
    if (isAllowedBareImport(value)) continue;
    errors.push(`${relPath}: forbidden runtime import ${JSON.stringify(value)}`);
  }
  for (const forbidden of findForbiddenGlobals(source)) {
    if (forbidden === "require(") {
      errors.push(`${relPath}: CommonJS require() is forbidden in runtime source`);
    }
  }
  // The boolean absence oracle, banned by NAME rather than by specifier.
  //
  // `node:fs` itself is legitimate here — `statSync` throws with a discriminating
  // errno and is what the probe is built on. `existsSync` is the specific hazard:
  // it returns FALSE for any error, so a permission-denied probe reads as "never
  // enrolled", the daemon mints a second identity, and the server denies it
  // forever. That exact bug shipped once and was caught only by re-reading.
  //
  // Matched as a code TOKEN so `fs.existsSync(p)` is caught as well as the named
  // import — a specifier check would see only `node:fs` and pass both — while the
  // comments that explain why it was removed stay legal.
  if (tokenizeSource(source).some((tk) => tk.type === "word" && tk.value === BANNED_ORACLE_WORD)) {
    errors.push(
      `${relPath}: existsSync is forbidden — it returns false for ANY error, so a ` +
        "permission-denied probe reads as 'never enrolled' and the daemon mints a " +
        "second identity the server denies forever. Use the errno-discriminating statSync probe",
    );
  }
  // DEP-010 (D-3) — the provider-control credential's NAME may not appear in ANY runtime source
  // file here. Scanned over RAW source (not the tokenizer), so a comment counts too: unlike the
  // existsSync explanation, this package has no legitimate reason to write the credential name
  // even in prose. The transport reads it (DEP-006 confinement); the keystore never touches it.
  for (const token of FORBIDDEN_CREDENTIAL_TOKENS) {
    if (source.includes(token)) {
      errors.push(
        `${relPath}: the provider-control credential ${JSON.stringify(token)} must not appear in ANY ` +
          "worker-keystore runtime source (ZERO files, not one) — this package is injected into the " +
          "daemon's key-holding process and never reads the credential; the transport does (DEP-006)",
      );
    }
  }
  return errors;
}

/**
 * Validate the boundary-relevant fields of the package manifest.
 * @param {unknown} manifest a parsed package.json object
 * @param {{ manifestRel:string, expectedName:string }} pkg
 * @returns {string[]} policy-violation messages (empty ⇒ clean)
 */
export function evaluateManifest(manifest, pkg) {
  const errors = [];
  if (manifest == null || typeof manifest !== "object") {
    errors.push(`${pkg.manifestRel}: not an object`);
    return errors;
  }
  const runtimeDependencies = [
    ...new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
      ...(Array.isArray(manifest.bundledDependencies) ? manifest.bundledDependencies : []),
      ...(Array.isArray(manifest.bundleDependencies) ? manifest.bundleDependencies : []),
    ]),
  ].sort();
  if (JSON.stringify(runtimeDependencies) !== JSON.stringify(REQUIRED_RUNTIME_DEPENDENCIES)) {
    errors.push(
      `${pkg.manifestRel}: runtime dependencies must equal ${JSON.stringify(
        REQUIRED_RUNTIME_DEPENDENCIES,
      )}, got ${JSON.stringify(runtimeDependencies)}`,
    );
  }
  if (manifest.name !== pkg.expectedName) {
    errors.push(`${pkg.manifestRel}: unexpected package name ${JSON.stringify(manifest.name)}`);
  }
  return errors;
}
