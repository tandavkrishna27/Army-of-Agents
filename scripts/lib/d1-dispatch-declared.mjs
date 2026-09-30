// WRK-008 slice 2b Step 9a — the pure D1-dispatch declaration evaluator.
//
// Fails on EITHER divergence direction — declared-absent-but-set OR declared-present/value-but-
// absent. Both matter: a guard that only caught accidental ENABLING would let a deliberate enable
// land silently once the declaration flipped, then quietly regress. An empty parsed env is a
// BROKEN checker (fail closed), never a pass — the "empty result set = pass" failure this repo
// has hit five times.

/**
 * @param {Record<string, Record<string, string>>} envByWorker  parsed compose env, per service
 * @param {{workers: Record<string, Record<string, {var: string, expect: string}>>}} expectation
 * @returns {string[]} violation messages (empty = declaration matches the tree)
 */
export function evaluateD1Dispatch(envByWorker, expectation) {
  const violations = [];
  for (const [worker, gates] of Object.entries(expectation.workers)) {
    const env = envByWorker[worker];
    if (env === undefined) {
      violations.push(`worker ${worker}: no environment parsed from the compose file — the checker cannot evaluate it (fail closed)`);
      continue;
    }
    for (const [gate, spec] of Object.entries(gates)) {
      if (gate.startsWith("$")) continue;
      const actual = env[spec.var];
      if (spec.expect === "absent") {
        if (actual !== undefined) {
          violations.push(`worker ${worker} gate ${gate}: ${spec.var} is declared ABSENT but the compose file sets it to ${JSON.stringify(actual)}`);
        }
      } else if (spec.expect === "present") {
        if (actual === undefined) {
          violations.push(`worker ${worker} gate ${gate}: ${spec.var} is declared PRESENT but the compose file does not set it`);
        }
      } else {
        if (actual === undefined) {
          violations.push(`worker ${worker} gate ${gate}: ${spec.var} is declared ${JSON.stringify(spec.expect)} but the compose file does not set it`);
        } else if (actual !== spec.expect) {
          violations.push(`worker ${worker} gate ${gate}: ${spec.var} = ${JSON.stringify(actual)}, but is declared ${JSON.stringify(spec.expect)}`);
        }
      }
    }
  }
  return violations;
}
