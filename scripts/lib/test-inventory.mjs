/**
 * test-inventory.mjs — pure membership rules and the pure verdict for the
 * test-inventory guard. No filesystem access lives here; see
 * `scripts/check-test-inventory.mjs` for the walk.
 *
 * The guard exists because on 2026-08-21 a build script deleted 154 test files from
 * this repository and CI stayed green through four subsequent commits. Losing a test
 * subtracts a failure, so no gate anywhere reacts to it. This module encodes the one
 * question that would have reacted: is the suite still as large as we last agreed?
 *
 * Two modes, because the trees differ in kind:
 *
 *   pinned — the count is an exact contract in BOTH directions. Used for small,
 *     security-critical, slow-moving trees (the worker packages the desktop
 *     assembler links against, the policy scripts). Adding a test costs one integer
 *     in the manifest; in exchange a pin cannot silently decay into a floor, and a
 *     decayed floor is precisely what would let a later deletion through.
 *
 *   floor — the count may grow freely but never shrink. Used for the large,
 *     fast-moving trees (server, ui) where an exact pin would fail on every honest
 *     PR and would therefore be disabled within a week. A floor still catches the
 *     incident class, which is mass deletion.
 *
 * Coverage is DEFAULT-DENY: a tree containing tests but carrying no expectation is a
 * violation, not a pass. Otherwise a new package is born unguarded and the checker
 * reports green about a tree it has never looked at.
 */

/** Directory names never walked: vendored code, build output, VCS metadata. */
export const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".turbo",
  ".next",
  ".vite",
  "playwright-report",
  "test-results",
]);

const CODE_EXTENSIONS = new Set(["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"]);
const TEST_INFIXES = [".test.", ".spec."];
const TEST_DIRECTORY_NAME = "__tests__";

export const INVENTORY_MODES = ["pinned", "floor"];

export function isExcludedDirectory(name) {
  return EXCLUDED_DIRECTORY_NAMES.has(name);
}

function extensionOf(basename) {
  const dot = basename.lastIndexOf(".");
  return dot === -1 ? "" : basename.slice(dot + 1);
}

/**
 * Membership. A path counts when it is a code file that is EITHER named like a spec
 * OR lives under a `__tests__` directory — the latter because the prune that caused
 * the incident removed whole `__tests__` directories, taking fixtures and helpers
 * with them. A lost helper breaks the suite exactly as a lost spec does.
 */
export function isTestFile(relPath) {
  if (typeof relPath !== "string" || relPath.length === 0) return false;
  const segments = relPath.replaceAll("\\", "/").split("/");
  const basename = segments[segments.length - 1];
  if (!CODE_EXTENSIONS.has(extensionOf(basename))) return false;
  if (segments.slice(0, -1).includes(TEST_DIRECTORY_NAME)) return true;
  return TEST_INFIXES.some((infix) => basename.includes(infix));
}

/**
 * Attribution. `packages/*` splits one level deeper than everything else so each
 * workspace package carries its own expectation; a single `packages` floor would let
 * one package's suite vanish behind another's growth.
 */
export function treeForPath(relPath) {
  const segments = String(relPath ?? "").replaceAll("\\", "/").split("/");
  if (segments.length === 1) return ".";
  if (segments[0] === "packages" && segments.length > 2) return `packages/${segments[1]}`;
  return segments[0];
}

function malformed(tree, detail) {
  return { kind: "malformed_expectation", tree, detail };
}

/**
 * The verdict. Total: any caller-supplied shape yields `ok:false` rather than a throw,
 * so a corrupted manifest fails the build loudly instead of crashing ambiguously.
 */
export function evaluateInventory(input) {
  const violations = [];
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, violations: [malformed(null, "input is not an object")] };
  }
  const { counts, expectations } = input;
  const countsOk = typeof counts === "object" && counts !== null && !Array.isArray(counts);
  const expectationsOk =
    typeof expectations === "object" && expectations !== null && !Array.isArray(expectations);
  if (!countsOk || !expectationsOk) {
    return { ok: false, violations: [malformed(null, "counts/expectations must be objects")] };
  }

  for (const tree of Object.keys(expectations).sort()) {
    const expectation = expectations[tree];
    if (typeof expectation !== "object" || expectation === null) {
      violations.push(malformed(tree, "expectation is not an object"));
      continue;
    }
    const { mode, count: expected } = expectation;
    if (!INVENTORY_MODES.includes(mode)) {
      violations.push(malformed(tree, `unknown mode ${JSON.stringify(mode)}`));
      continue;
    }
    if (!Number.isInteger(expected) || expected < 0) {
      violations.push(malformed(tree, `count must be a non-negative integer, got ${String(expected)}`));
      continue;
    }
    // An ABSENT key means the tree was not found at all — the catastrophic case. It
    // must read as zero, never as a satisfied expectation.
    const actual = Number.isInteger(counts[tree]) ? counts[tree] : 0;
    if (mode === "pinned" && actual !== expected) {
      violations.push({ kind: "pinned_mismatch", tree, actual, expected, mode });
    } else if (mode === "floor" && actual < expected) {
      violations.push({ kind: "below_floor", tree, actual, expected, mode });
    }
  }

  for (const tree of Object.keys(counts).sort()) {
    if (!Object.hasOwn(expectations, tree) && Number.isInteger(counts[tree]) && counts[tree] > 0) {
      violations.push({ kind: "unmanaged_tree", tree, actual: counts[tree], expected: null });
    }
  }

  return { ok: violations.length === 0, violations };
}
