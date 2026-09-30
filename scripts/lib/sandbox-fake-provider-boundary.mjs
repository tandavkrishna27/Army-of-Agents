/**
 * sandbox-fake-provider-boundary.mjs — pure, (almost) dependency-free boundary
 * logic for the DEP-000 leaf packages `@armyofagents/sandbox-fake-provider` and
 * `@armyofagents/sandbox-provider-contract`.
 *
 * Mirrors `scripts/lib/worker-daemon-boundary.mjs`, but enforces the DEP-000
 * dependency policy shared by BOTH new packages:
 *
 *   - The manifest may declare EXACTLY the runtime dependencies
 *     `@armyofagents/worker-protocol` + `zod` (nothing more, nothing less).
 *   - Runtime source may import ONLY: `@armyofagents/worker-protocol`, `zod`
 *     (and `zod/*` subpaths), any Node built-in (`node:*` or a bare builtin
 *     name), or a relative path that normalizes INSIDE the package `src`
 *     directory. Everything else — most importantly `@armyofagents/db`,
 *     `@armyofagents/server`, `@armyofagents/shared`, `@armyofagents/adapters`,
 *     `@armyofagents/worker-daemon`, the SIBLING sandbox package, `drizzle-orm`,
 *     `pg`, `pino`, Express, and any other bare package — is rejected. This is
 *     the machine-checkable "no tenant/server/db code on the host worker".
 *
 * Like the worker daemon (a real runtime program with a loopback HTTP server),
 * this checker does NOT forbid Node/runtime globals (`process`, `Buffer`, `URL`);
 * it DOES forbid the CommonJS `require(...)` bridge and `node:module`
 * (`createRequire` escapes the static import allowlist at runtime).
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
 * Runtime dependencies EITHER new package's manifest may declare — EXACTLY these
 * two, pre-sorted so a `.sort()`ed manifest key list compares by value. Any
 * addition/removal is a STOP for controller approval.
 */
export const REQUIRED_RUNTIME_DEPENDENCIES = ["@armyofagents/worker-protocol", "zod"];

const NODE_BUILTINS = new Set(builtinModules);
const TEST_SPECIFIER_RE = /\.test(?:\.[cm]?[jt]s)?$/;

/** `node:module`/`module` expose `createRequire`, which resolves ANY package
 * from the hoisted monorepo node_modules at runtime — forbidden even as a Node
 * builtin. */
const FORBIDDEN_BRIDGE_BUILTINS = new Set(["module", "node:module"]);

function isNodeBuiltin(specifier) {
  if (specifier.startsWith("node:")) return true;
  if (NODE_BUILTINS.has(specifier)) return true;
  const root = specifier.split("/")[0];
  return NODE_BUILTINS.has(root);
}

/** True for a bare (non-relative) specifier either package may import. */
function isAllowedBareImport(specifier) {
  if (specifier === "@armyofagents/worker-protocol") return true;
  if (specifier === "zod") return true;
  // Allow zod subpaths but never a traversal specifier that escapes via `..`.
  if (specifier.startsWith("zod/") && !specifier.split("/").includes("..")) return true;
  if (FORBIDDEN_BRIDGE_BUILTINS.has(specifier)) return false;
  return isNodeBuiltin(specifier);
}

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
    if (isAllowedBareImport(value)) continue;
    errors.push(`${relPath}: forbidden runtime import ${JSON.stringify(value)}`);
  }
  // Node/runtime globals are allowed; the CommonJS require() bridge is not.
  for (const forbidden of findForbiddenGlobals(source)) {
    if (forbidden === "require(") {
      errors.push(`${relPath}: CommonJS require() is forbidden in runtime source`);
    }
  }
  return errors;
}

/**
 * Validate the boundary-relevant fields of a package manifest.
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
  // Union EVERY runtime-effective dependency field — a forbidden dep hidden under
  // optional/peer/bundled is equally resolvable at runtime and must fail.
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
