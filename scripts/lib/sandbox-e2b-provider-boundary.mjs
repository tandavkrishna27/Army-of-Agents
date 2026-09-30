/**
 * sandbox-e2b-provider-boundary.mjs — pure, (almost) dependency-free boundary
 * logic for the CLI-001 leaf package `@armyofagents/sandbox-e2b-provider`.
 *
 * Mirrors `scripts/lib/sandbox-fake-provider-boundary.mjs`, but for the E2B leaf's
 * DIFFERENT (wider) dependency policy — it is a REAL provider, so it legitimately
 * depends on the `e2b` SDK + the worker port + both provider-contract packages:
 *
 *   - The manifest may declare EXACTLY the runtime dependencies
 *     `@armyofagents/sandbox-provider-contract`, `@armyofagents/worker-daemon`,
 *     `@armyofagents/worker-protocol`, `e2b`, `zod` (nothing more, nothing less).
 *   - Runtime source may import ONLY: those five packages (+ `zod/*` subpaths),
 *     any Node built-in (`node:*`/bare, except the `module`/`node:module`
 *     createRequire bridge), or a relative path INSIDE the package `src` dir.
 *     Everything else — most importantly `@armyofagents/db`,
 *     `@armyofagents/server`, `@armyofagents/shared`, `@armyofagents/adapters`,
 *     the sibling `@armyofagents/sandbox-fake-provider` (a TEST double),
 *     `drizzle-orm`, `pg`, `pino`, Express — is rejected. This is the
 *     machine-checkable "no tenant/server/db code on the host worker".
 *
 * CREDENTIAL CONFINEMENT (DEP-006 reuse / CM-012 "no secret field leak"): the
 * provider-control credential token `E2B_API_KEY` may appear in EXACTLY ONE
 * runtime source file — `real-transport.ts`, the sole `e2b` SDK binding. Any other
 * runtime source referencing it is a violation: the credential must never leak
 * into the neutral adapter, the provider, the mock, or the seam.
 *
 * The lexical scanner is the ONE canonical implementation shared with the
 * worker-protocol boundary — imported here, not duplicated.
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
 * Runtime dependencies the E2B leaf may declare — EXACTLY these five, pre-sorted
 * so a `.sort()`ed manifest key list compares by value. Any addition/removal is a
 * STOP for controller approval.
 */
export const REQUIRED_RUNTIME_DEPENDENCIES = [
  "@armyofagents/sandbox-provider-contract",
  "@armyofagents/worker-daemon",
  "@armyofagents/worker-protocol",
  "e2b",
  "zod",
];

/** The provider-control credential token — confined to the SDK binding. */
export const CREDENTIAL_TOKEN = "E2B_API_KEY";
/** The single runtime source file allowed to reference the credential + `e2b`. */
export const CREDENTIAL_HOST_BASENAME = "real-transport.ts";

const NODE_BUILTINS = new Set(builtinModules);
const ALLOWED_BARE = new Set([
  "@armyofagents/sandbox-provider-contract",
  "@armyofagents/worker-daemon",
  "@armyofagents/worker-protocol",
  "e2b",
  "zod",
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
  if (specifier.startsWith("zod/") && !specifier.split("/").includes("..")) return true;
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
    // Only `real-transport.ts` may import the `e2b` SDK (credential confinement).
    if (value === "e2b" && path.basename(absPath) !== CREDENTIAL_HOST_BASENAME) {
      errors.push(`${relPath}: the "e2b" SDK may be imported ONLY from ${CREDENTIAL_HOST_BASENAME}`);
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
  // Credential confinement: the token may appear ONLY in the SDK-binding file.
  if (source.includes(CREDENTIAL_TOKEN) && path.basename(absPath) !== CREDENTIAL_HOST_BASENAME) {
    errors.push(`${relPath}: the provider-control credential ${JSON.stringify(CREDENTIAL_TOKEN)} may appear ONLY in ${CREDENTIAL_HOST_BASENAME}`);
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
