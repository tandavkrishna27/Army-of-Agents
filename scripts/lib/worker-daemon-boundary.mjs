/**
 * worker-daemon-boundary.mjs — pure, (almost) dependency-free boundary logic.
 *
 * Mirrors `scripts/lib/worker-protocol-boundary.mjs`, but enforces the DIFFERENT
 * dependency policy of the `@armyofagents/worker-daemon` leaf package (E4-D01):
 *
 *   - The manifest may declare EXACTLY the runtime dependencies
 *     `@armyofagents/worker-protocol` + `pino` (nothing more, nothing less).
 *   - Runtime source may import ONLY: `@armyofagents/worker-protocol`, `pino`
 *     (and `pino/*` subpaths), any Node built-in (`node:*` or a bare builtin
 *     name), or a relative path that normalizes INSIDE the package `src`
 *     directory. Everything else — most importantly `@armyofagents/db`,
 *     `@armyofagents/server`, `@armyofagents/shared`, `@armyofagents/adapters`,
 *     `drizzle-orm`, `pg`, Express, and any other bare package — is rejected.
 *
 * The worker daemon is a real runtime program (it reads env, installs signal
 * handlers, opens a loopback HTTP server), so — UNLIKE the worker-protocol
 * boundary — this checker does NOT forbid Node/runtime globals (`process`,
 * `Buffer`, `URL`, …). The H-05 isolation invariant this file enforces is
 * "imports no server/db/drizzle code and declares no forbidden dependency",
 * not "uses no Node global".
 *
 * The lexical scanner (`tokenizeSource`, `extractModuleSpecifiers`,
 * `classifyRuntimeSourceFileName`) is the ONE canonical implementation shared
 * with the worker-protocol boundary — imported here rather than duplicated so a
 * single tokenizer governs both gates. The only other import is the Node
 * standard `node:path` (pure path arithmetic, no reads) and `node:module`'s
 * `builtinModules` constant (pure data, no reads).
 *
 */

import path from "node:path";
import { builtinModules } from "node:module";

import {
  classifyRuntimeSourceFileName,
  extractModuleSpecifiers,
  findForbiddenGlobals,
} from "./worker-protocol-boundary.mjs";

// Re-export the shared file classifier so the command wrapper imports one symbol
// set, exactly as the worker-protocol wrapper does.
export { classifyRuntimeSourceFileName };

/** The package's required name. */
export const EXPECTED_PACKAGE_NAME = "@armyofagents/worker-daemon";

/**
 * Runtime dependencies the package manifest is permitted to declare — EXACTLY
 * these two, pre-sorted so a `.sort()`ed manifest key list compares by value.
 * Any addition/removal is a STOP for controller approval (E4-D01).
 */
export const REQUIRED_RUNTIME_DEPENDENCIES = ["@armyofagents/worker-protocol", "pino"];

/** Bare Node built-in module names (`fs`, `path`, `http`, `fs/promises`, …). */
const NODE_BUILTINS = new Set(builtinModules);

/** A relative specifier that points at a `.test` module (any JS/TS variant). */
const TEST_SPECIFIER_RE = /\.test(?:\.[cm]?[jt]s)?$/;

/**
 * Node builtins that are the CommonJS-escape bridge: `node:module`/`module`
 * expose `createRequire`, which resolves ANY package from the hoisted monorepo
 * node_modules at runtime, defeating the import allowlist. They are forbidden in
 * worker-daemon runtime source even though they are otherwise Node builtins.
 */
const FORBIDDEN_BRIDGE_BUILTINS = new Set(["module", "node:module"]);

/** True for a Node built-in specifier: any `node:` protocol import, or a bare
 * builtin name / builtin subpath root (`fs/promises` → root `fs`). */
function isNodeBuiltin(specifier) {
  if (specifier.startsWith("node:")) return true;
  if (NODE_BUILTINS.has(specifier)) return true;
  const root = specifier.split("/")[0];
  return NODE_BUILTINS.has(root);
}

/** True for a bare (non-relative) specifier the worker daemon may import. */
function isAllowedBareImport(specifier) {
  if (specifier === "@armyofagents/worker-protocol") return true;
  // Allow pino and its exact subpaths, but never a traversal specifier
  // (`pino/../@armyofagents/db`) that escapes the package via a `..` segment.
  if (specifier === "pino") return true;
  if (specifier.startsWith("pino/") && !specifier.split("/").includes("..")) return true;
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
  // Unlike the worker-protocol boundary, Node/runtime globals (`process`,
  // `Buffer`, `URL`, …) are NOT forbidden — the worker daemon legitimately uses
  // them. But CommonJS `require(...)` / `module.require(...)` IS forbidden: it
  // resolves any module from the hoisted monorepo node_modules at runtime and so
  // bypasses the static import allowlist above. `findForbiddenGlobals` tokenizes
  // (so a `require(` inside a string/comment is ignored); the `createRequire`
  // bridge is closed separately by forbidding `node:module` in the import scan.
  for (const forbidden of findForbiddenGlobals(source)) {
    if (forbidden === "require(") {
      errors.push(`${relPath}: CommonJS require() is forbidden in runtime source`);
    }
  }
  return errors;
}

/**
 * Validate the package manifest's boundary-relevant fields.
 * @param {unknown} manifest a parsed package.json object
 * @returns {string[]} policy-violation messages (empty ⇒ clean)
 */
export function evaluateManifest(manifest) {
  const errors = [];
  if (manifest == null || typeof manifest !== "object") {
    errors.push("packages/worker-daemon/package.json: not an object");
    return errors;
  }
  // Union EVERY runtime-effective dependency field, not just `dependencies` — a
  // forbidden package declared under optionalDependencies/peerDependencies/
  // bundledDependencies is equally resolvable at runtime and must fail the gate.
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
      `packages/worker-daemon/package.json: runtime dependencies must equal ${JSON.stringify(
        REQUIRED_RUNTIME_DEPENDENCIES,
      )}, got ${JSON.stringify(runtimeDependencies)}`,
    );
  }
  if (manifest.name !== EXPECTED_PACKAGE_NAME) {
    errors.push(
      `packages/worker-daemon/package.json: unexpected package name ${JSON.stringify(manifest.name)}`,
    );
  }
  return errors;
}
