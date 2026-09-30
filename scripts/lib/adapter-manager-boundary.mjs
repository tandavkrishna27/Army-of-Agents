/**
 * adapter-manager-boundary.mjs — pure boundary logic for the DEP-012 Slice 3 · β2
 * provider host `@armyofagents/adapter-manager`.
 *
 * Forked in STRUCTURE from `scripts/lib/worker-keystore-boundary.mjs`, which itself
 * forked `sandbox-e2b-provider-boundary.mjs`. The confined capability is the same class
 * — the `e2b` network SDK (and the provider-control credential it fronts) crossing into a
 * trusted process — but the shape of the allow-list differs (see ★ below).
 *
 * WHY THIS CHECKER EXISTS. `packages/adapter-manager` is the out-of-process HOST of the
 * per-op SandboxProvider. Its request-path files — the HTTP server, the ownership gate,
 * the create-gate, the durable idempotency ledger, the capability verifier, the keyed
 * mutex — decide, per request, whether a caller may act on a sandbox. Those decisions must
 * be made WITHOUT the `e2b` SDK in the process image: the SDK (and `E2B_API_KEY`) may enter
 * from EXACTLY ONE composition-root file, `src/bin/adapter-manager.ts`, which dynamically
 * imports the provider and hands it to `createProviderServer`. Everything else stays
 * provider-free so the request path cannot leak provider internals or the credential.
 * Review cannot guarantee that; a mechanical PATH+prefix confinement can.
 *
 * ★ SUBPATH-AWARE ALLOW-LIST (review G1 — the load-bearing difference from the template).
 * The worker-keystore template's ALLOWED_BARE is EXACT-match. The adapter-manager request
 * path legitimately imports provider-wire SUBPATHS (`@armyofagents/provider-wire/codec` in
 * server.ts, `@armyofagents/provider-wire/capability` in capability-verify.ts). A faithful
 * exact-match copy would RED the shipped tree. So:
 *   - the NON-confined deps (`@armyofagents/provider-wire`, `@armyofagents/worker-daemon`)
 *     are allow-listed BARE and by subpath (`@scope/name` and `@scope/name/…`);
 *   - the provider (`@armyofagents/sandbox-e2b-provider`) is confined PREFIX-based (bare
 *     AND subpath) to the one bin path — a bare-only match would let a provider subpath
 *     (`.../real-transport.js`, which ALSO pulls `e2b`) leak into a request-path file;
 *   - `e2b` itself is NOT allow-listed → forbidden EVERYWHERE (this is what enforces "no
 *     `e2b` in the request path" LEXICALLY, for free);
 *   - `E2B_API_KEY` may appear in ZERO runtime source files (the bin does not read it —
 *     `createRealE2bTransport()` reads it itself; DEP-006 confinement), scanned over RAW
 *     source so even a comment counts.
 *
 * Policy:
 *   - The manifest declares EXACTLY `@armyofagents/provider-wire`,
 *     `@armyofagents/sandbox-e2b-provider` and `@armyofagents/worker-daemon` — the provider
 *     is a RUNTIME dep (β2.2.3 devDep→dep) because the bin dynamically imports it; `e2b`
 *     stays TRANSITIVE and is never declared. Anything else is a violation.
 *   - `@armyofagents/sandbox-e2b-provider` (bare or subpath) may be named from EXACTLY ONE
 *     runtime source PATH, `src/bin/adapter-manager.ts` — a full package-relative path, not
 *     a basename, so a same-named file in a subdirectory cannot inherit the permission.
 *   - The provider-control credential `E2B_API_KEY` may appear in ZERO runtime source files.
 *   - Non-literal imports and the `node:module` createRequire bridge are rejected, because
 *     either would let arbitrary code (including the provider or `e2b`) reach the process.
 *
 * The lexical scanner is the ONE canonical implementation shared with the worker-protocol
 * boundary — imported, never duplicated.
 */

import path from "node:path";
import { builtinModules } from "node:module";

import {
  classifyRuntimeSourceFileName,
  extractModuleSpecifiers,
  findForbiddenGlobals,
} from "./worker-protocol-boundary.mjs";

export { classifyRuntimeSourceFileName };

/**
 * Runtime dependencies this package may declare — EXACTLY these three, pre-sorted so a
 * `.sort()`ed manifest key list compares by value.
 *
 * The provider dep (`@armyofagents/sandbox-e2b-provider`) is declared because the
 * composition-root bin dynamically imports it (β2.2.3). `e2b` is DELIBERATELY absent — it
 * is a transitive dependency of the provider package and must never be declared here (its
 * presence in the set would let a request-path file name it and pass the exact-set check).
 */
export const REQUIRED_RUNTIME_DEPENDENCIES = [
  "@armyofagents/provider-wire",
  "@armyofagents/sandbox-e2b-provider",
  "@armyofagents/worker-daemon",
];

/**
 * The provider package, and the SINGLE runtime source path allowed to name it (β2.2.1/β2.2.2).
 *
 * A full package-relative path, not a basename, for the reason the worker-keystore
 * SUBPROCESS_HOST_PATH history taught: a same-named file in a subdirectory must not inherit
 * the permission. The confined file (`bin/adapter-manager.ts`) uses a LITERAL DYNAMIC import
 * of the BARE barrel so the `e2b` SDK is not loaded on any boot that constructs no provider.
 */
export const PROVIDER_SPECIFIER = "@armyofagents/sandbox-e2b-provider";
export const PROVIDER_HOST_PATH = "src/bin/adapter-manager.ts";

/**
 * The NON-confined dependency prefixes: allowed BARE and by subpath from any runtime source.
 * These are the provider-agnostic wire + daemon type surfaces the request path is built on.
 * Their transitive closures are `e2b`-free (server.ts's static closure is `codec` → the
 * provider-wire `errors` subpath → `worker-daemon` only), so no confinement is needed.
 */
export const ALLOWED_SCOPED_PREFIXES = ["@armyofagents/provider-wire", "@armyofagents/worker-daemon"];

/**
 * Provider-control credential tokens banned from EVERY runtime source file here.
 *
 * The bin does NOT read the credential — `createRealE2bTransport()` reads `E2B_API_KEY`
 * itself (DEP-006 confinement, in the e2b leaf). The adapter-manager composes the provider
 * without ever touching the key, so its NAME has no business in this package's source.
 * Scanned over RAW source, so even a comment naming it counts.
 */
export const FORBIDDEN_CREDENTIAL_TOKENS = ["E2B_API_KEY"];

const NODE_BUILTINS = new Set(builtinModules);

/** `node:module`/`module` expose `createRequire`, which resolves ANY package from the
 * hoisted monorepo node_modules at runtime — a general-purpose escape, forbidden even as a
 * builtin. */
const FORBIDDEN_BRIDGE_BUILTINS = new Set(["module", "node:module"]);

function isNodeBuiltin(specifier) {
  if (specifier.startsWith("node:")) return true;
  if (NODE_BUILTINS.has(specifier)) return true;
  const root = specifier.split("/")[0];
  return NODE_BUILTINS.has(root);
}

/** A bare specifier is a Node builtin (but not the createRequire bridge). The scoped
 * allow-list is handled separately (subpath-aware) in `evaluateRuntimeSourceImports`. */
function isAllowedNodeBuiltin(specifier) {
  if (FORBIDDEN_BRIDGE_BUILTINS.has(specifier)) return false;
  return isNodeBuiltin(specifier);
}

/** Is `value` an allowed NON-confined scoped dep — bare or a subpath of one? */
function isAllowedScopedImport(value) {
  return ALLOWED_SCOPED_PREFIXES.some((prefix) => value === prefix || value.startsWith(`${prefix}/`));
}

/** Is `value` the confined provider — bare or ANY subpath? PREFIX-based, so a provider
 * subpath (which ALSO pulls `e2b`) is confined exactly like the bare barrel. */
function isProviderImport(value) {
  return value === PROVIDER_SPECIFIER || value.startsWith(`${PROVIDER_SPECIFIER}/`);
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
    // Provider confinement (PREFIX-based): ONLY `bin/adapter-manager.ts` may name the
    // provider package or ANY of its subpaths. Keyed on the FULL package-relative path (a
    // basename check would let a subdirectory copy inherit permission), so the `e2b` SDK
    // enters this host process from one reviewable file and nowhere else. Runs BEFORE the
    // allow-list so a rejected path never reaches it.
    if (isProviderImport(value)) {
      const packageRelative = relPath.slice(relPath.indexOf("/src/") + 1);
      if (packageRelative !== PROVIDER_HOST_PATH) {
        errors.push(
          `${relPath}: ${JSON.stringify(value)} may be imported ONLY from ${PROVIDER_HOST_PATH} — ` +
            "the provider package (bare or subpath) pulls the e2b network SDK into the host " +
            "process, so it is confined to ONE PATH",
        );
      }
      continue;
    }
    // NON-confined deps: provider-wire + worker-daemon, bare or subpath.
    if (isAllowedScopedImport(value)) continue;
    // Node builtins (except the createRequire bridge).
    if (isAllowedNodeBuiltin(value)) continue;
    // Everything else — including a direct `e2b` import and any other bare package — is
    // default-denied. This is what keeps `e2b` out of the request path LEXICALLY.
    errors.push(`${relPath}: forbidden runtime import ${JSON.stringify(value)}`);
  }
  for (const forbidden of findForbiddenGlobals(source)) {
    if (forbidden === "require(") {
      errors.push(`${relPath}: CommonJS require() is forbidden in runtime source`);
    }
  }
  // The provider-control credential's NAME may not appear in ANY runtime source file here.
  // Scanned over RAW source (not the tokenizer), so a comment counts too: this package has
  // no legitimate reason to write the credential name even in prose. The transport reads it
  // (DEP-006 confinement); the adapter-manager never touches it.
  for (const token of FORBIDDEN_CREDENTIAL_TOKENS) {
    if (source.includes(token)) {
      errors.push(
        `${relPath}: the provider-control credential ${JSON.stringify(token)} must not appear in ANY ` +
          "adapter-manager runtime source (ZERO files) — this host composes the provider without ever " +
          "reading the credential; the transport does (DEP-006)",
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
