// scripts/lib/guard-inventory.mjs
//
// A CHECK THAT NOTHING RUNS IS NOT A CHECK.
//
// REL-004's terrain map found three fail-closed admission verifiers with no caller, and
// two documents asserting an enforcement that never happened. This generalizes the fix
// from functions to executables: every `scripts/check-*` and `scripts/verify-*` declares
// whether anything runs it, and the declaration is verified against the tree.
//
// DECLARATION-BASED, DELIBERATELY. Inferring "is this script invoked" is harder than it
// looks. Five successive greps during the reconnaissance each produced a wrong answer, in
// both directions: a shell script that merely ECHOED a script's name read as an
// invocation, while real invocations written `node /app/scripts/x.mjs` or
// `node ../../../../scripts/x.mjs` read as absent. A subtly wrong detector is the same
// disease as the documentation that started this.
//
// So the hard direction is not inferred. A human declares the status; this verifies only
// the easy direction — that the declaration still matches the tree. That catches what
// actually bites: a script quietly dropped from CI while its entry, and everyone's belief
// about it, stays behind.
//
// Pure. The caller supplies the file lists and the workflow text.

/**
 * ci             — a workflow invokes the script itself.
 * ci_logic_only  — the CLI is not on any path, but a NAMED self-test is run by a workflow,
 *                  so the decision logic is proven even though the entry point is idle.
 * dormant        — nothing runs it. Permitted, but it must say why.
 */
export const GUARD_STATUSES = Object.freeze(["ci", "ci_logic_only", "dormant"]);

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasReason(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Does any invocation surface (workflows, package scripts) invoke `needle`?
 *
 * Comment lines are excluded, because the reconnaissance's worst false positive was a
 * comment being read as proof that a check ran. This is a weak signal on its own — it
 * cannot tell an invocation from a string that merely contains the name — which is why it
 * only ever CONFIRMS a human's declaration and never stands in for one.
 */
function invokes(invocationText, needle) {
  const text = typeof invocationText === "string" ? invocationText : "";
  return text.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) return false;
    return trimmed.includes(needle);
  });
}

/**
 * @param {{
 *   scripts?: string[],          // the check- and verify- scripts found on disk
 *   declared?: Record<string, {status: string, reason?: string, provenTest?: string}>,
 *   invocationText?: string,     // every workflow AND package.json, concatenated —
 *                                // a package `prebuild` reaches CI just as a workflow step does
 *   testFiles?: string[],        // test files present on disk
 * }} input
 * @returns {{ok: boolean, problems: Array<{kind: string, script: string, detail?: string}>}}
 */
export function evaluateGuardInventory(input) {
  const problems = [];
  if (!isPlainObject(input)) {
    return { ok: false, problems: [{ kind: "malformed_input", script: null }] };
  }
  const { scripts, declared, invocationText, testFiles } = input;
  if (!Array.isArray(scripts) || !isPlainObject(declared)) {
    return { ok: false, problems: [{ kind: "malformed_input", script: null }] };
  }
  const tests = new Set(Array.isArray(testFiles) ? testFiles : []);

  for (const script of [...scripts].sort()) {
    const entry = declared[script];
    // Default-deny: a new check must be classified, or it is born unclassified and nobody
    // ever asks whether anything runs it.
    if (!isPlainObject(entry)) {
      problems.push({ kind: "undeclared_script", script });
      continue;
    }
    if (!GUARD_STATUSES.includes(entry.status) || !hasReason(entry.reason)) {
      problems.push({ kind: "malformed_declaration", script, detail: String(entry.status) });
      continue;
    }
    if (entry.status === "ci") {
      if (!invokes(invocationText, script.split("/").pop())) {
        problems.push({ kind: "not_in_workflows", script });
      }
      continue;
    }
    if (entry.status === "ci_logic_only") {
      // "The logic is proven elsewhere" is a claim; a claim with no referent is exactly
      // what this guard refuses.
      if (typeof entry.provenTest !== "string" || entry.provenTest.length === 0) {
        problems.push({ kind: "malformed_declaration", script, detail: "provenTest missing" });
        continue;
      }
      if (!tests.has(entry.provenTest)) {
        problems.push({ kind: "proven_test_missing", script, detail: entry.provenTest });
        continue;
      }
      if (!invokes(invocationText, entry.provenTest)) {
        problems.push({ kind: "proven_test_not_in_workflows", script, detail: entry.provenTest });
      }
    }
    // `dormant` needs nothing further: the status plus a stated reason IS the declaration.
  }

  for (const script of Object.keys(declared).sort()) {
    if (!scripts.includes(script)) {
      problems.push({ kind: "stale_declaration", script });
    }
  }

  return { ok: problems.length === 0, problems };
}
