// WRK-008 slice 2b Step 9b — the pure boot-roots-provider-free evaluator.
//
// The declared property (reformulated at Sprint 2, §0.1 item 2): no boot root constructs a
// provider UNCONDITIONALLY, and the shipped default resolves to none. Concretely, for each
// declared root either (a) it passes NO provider (providerPosture "none"), or (b) the value it
// passes comes from a declared RESOLVER whose default is {kind:"none"}.
//
// This is weaker than revision 2's "no root passes a provider key" — after DEP-010 the desktop
// root DOES pass a provider key, so that guard would be red on every PR (§0.1). It is
// declaration-based (like check-guard-inventory) so a THIRD boot root added quietly — the way a
// three-gate root becomes a zero-gate one — cannot slip past: an unenumerated root fails.

/**
 * @param {{foundRoots: string[], expectation: {roots: Record<string, {providerPosture: string, resolverFile?: string, resolverNoneMarker?: string}>}, resolverContents: Record<string, string|undefined>}} input
 * @returns {string[]} violations (empty = property holds)
 */
export function evaluateBootRoots({ foundRoots, expectation, resolverContents }) {
  const violations = [];
  const declared = new Set(Object.keys(expectation.roots));

  // (a) EVERY found root must be declared — the important direction: a quietly-added root.
  for (const root of foundRoots) {
    if (!declared.has(root)) {
      violations.push(`undeclared boot root: ${root} obtains bootstrapWorkerDaemon but is not declared in boot-roots-expectation.json — a new boot root can turn a three-gate root into a zero-gate one`);
    }
  }

  // (b) EVERY declared root must still exist among the found roots (stale declaration).
  for (const root of declared) {
    if (!foundRoots.includes(root)) {
      violations.push(`declared boot root ${root} no longer obtains bootstrapWorkerDaemon (stale declaration — remove it or fix the enumeration)`);
    }
  }

  // (c) EVERY resolver-posture root's resolver must default to no provider.
  for (const [root, spec] of Object.entries(expectation.roots)) {
    if (spec.providerPosture === "resolver") {
      const content = resolverContents[spec.resolverFile];
      if (content === undefined) {
        violations.push(`boot root ${root}: resolver file ${spec.resolverFile} could not be read (fail closed)`);
        continue;
      }
      if (!content.includes(spec.resolverNoneMarker)) {
        violations.push(`boot root ${root}: resolver ${spec.resolverFile} does not default to no provider (marker ${JSON.stringify(spec.resolverNoneMarker)} not found) — a resolver defaulting to a provider is a zero-gate root`);
      }
    } else if (spec.providerPosture !== "none") {
      violations.push(`boot root ${root}: unknown providerPosture ${JSON.stringify(spec.providerPosture)} (expected "none" or "resolver")`);
    }
  }
  return violations;
}
