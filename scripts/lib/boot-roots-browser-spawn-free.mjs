// BRW-hostspawn-gate — the PURE boot-root browser-spawn evaluator. No filesystem access
// lives here; see `scripts/check-boot-roots-browser-spawn-free.mjs` for the scan.
//
// The declared property: no host-side browser spawn is reachable from a boot root EXCEPT
// the single declared, BRW-008-owned deferral (the current cli-mode.ts @playwright/mcp
// spawn, pinned at 3 signature occurrences). It is the browser-spawn sibling of
// `boot-roots-provider-free.mjs`, in the trackable-strict OWNED-DEFERRAL form of
// REL-FOUNDATION-GATE, made SPAWN-GRANULAR: the manifest pins the exact number of signature
// occurrences PER FILE and any deviation reds (a SECOND spawn in the already-declared file
// raises the count; removing the spawn lowers it). The declaration is a human's; the machine
// verifies the cheap direction. A false claim of ownership is worse than none, so an
// undeclared spawn is DEFAULT-DENY.
//
// `foundSites` is `Array<{path, occurrences}>`; `expectation` is the parsed manifest
// `{ deferredHostSpawns: { "<path>": { owner, reason, signatureOccurrences } } }` or a
// null/malformed sentinel the driver passes when the manifest is absent/unreadable.

const OWNER_TICKET_SHAPE = /^[A-Z]{2,5}-\d+$/;

/**
 * @param {{
 *   foundSites: Array<{path: string, occurrences: number}>,
 *   expectation: unknown,
 *   unreadableSources: string[],
 *   scannedFileCount: number,
 *   signatures?: string[],
 * }} input
 * @returns {string[]} violations (empty = property holds)
 */
export function evaluateBrowserSpawnFree({ foundSites, expectation, unreadableSources, scannedFileCount }) {
  const violations = [];
  const sites = Array.isArray(foundSites) ? foundSites : [];
  const unreadable = Array.isArray(unreadableSources) ? unreadableSources : [];

  // ── A0 — manifest fail-closed. An absent/unreadable/malformed manifest is treated as an
  // EMPTY deferral set, so every found spawn then reds via A3 — never a silent pass.
  const deferredRaw =
    expectation && typeof expectation === "object" && !Array.isArray(expectation)
      ? expectation.deferredHostSpawns
      : undefined;
  const deferredOk = deferredRaw && typeof deferredRaw === "object" && !Array.isArray(deferredRaw);
  const deferred = deferredOk ? deferredRaw : {};
  if (!deferredOk) {
    violations.push(
      "manifest fail-closed: expectation has no object 'deferredHostSpawns' (absent, unreadable, or malformed manifest) — treated as an empty deferral set, so every found host spawn is now undeclared",
    );
  }
  const declaredPaths = new Set(Object.keys(deferred));

  // ── A1 — vacuous scan. A guard that evaluated nothing must never read green.
  if (!(Number.isInteger(scannedFileCount) && scannedFileCount > 0)) {
    violations.push(
      "vacuous scan: scannedFileCount is 0 — the discovery layer found no in-scope files to scan (a broken glob or a moved tree); a guard that evaluated nothing must never read green",
    );
  }

  // ── A2 — unreadable source (fail closed). One violation each.
  for (const src of unreadable) {
    violations.push(`unreadable source (fail closed): ${src} is an in-scope file that could not be read during the scan`);
  }

  // ── A3 — undeclared host spawn (the important direction). Default-deny.
  for (const site of sites) {
    if (!declaredPaths.has(site.path)) {
      violations.push(
        `undeclared host spawn: ${site.path} carries a host-browser-spawn signature but is not declared in browser-spawn-expectation.json — a NEW host spawn must be declared (owner BRW-008, with a reason and signatureOccurrences) or removed`,
      );
    }
  }

  const foundByPath = new Map(sites.map((s) => [s.path, s.occurrences]));

  for (const declPath of declaredPaths) {
    // ── A4 — stale declaration. Declared but its signature is entirely gone.
    if (!foundByPath.has(declPath)) {
      violations.push(
        `stale declaration: ${declPath} is declared as an owned deferral but no longer carries any host-browser-spawn signature — remove the deferral in the same commit that removes the spawn (self-cleaning)`,
      );
      continue;
    }

    // ── A5 — malformed declaration (shape only; the owner is an accountability tag, not a
    // filesystem assertion — BRW-008 is unbuilt backlog, so we do NOT require its file).
    const entry = deferred[declPath];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      violations.push(`malformed declaration: ${declPath} — entry is not an object`);
      continue;
    }
    if (typeof entry.owner !== "string" || !OWNER_TICKET_SHAPE.test(entry.owner)) {
      violations.push(`malformed declaration: ${declPath} — 'owner' must be a ticket-id token (/^[A-Z]{2,5}-\\d+$/), got ${JSON.stringify(entry.owner)}`);
      continue;
    }
    if (typeof entry.reason !== "string" || entry.reason.trim().length === 0) {
      violations.push(`malformed declaration: ${declPath} — 'reason' must be a non-empty string`);
      continue;
    }
    if (!(Number.isInteger(entry.signatureOccurrences) && entry.signatureOccurrences > 0)) {
      violations.push(`malformed declaration: ${declPath} — 'signatureOccurrences' must be a positive integer, got ${JSON.stringify(entry.signatureOccurrences)}`);
      continue;
    }

    // ── A6 — spawn-count mismatch (the spawn-granular arm, F2). Exact pin, BOTH directions.
    const actual = foundByPath.get(declPath);
    if (actual !== entry.signatureOccurrences) {
      violations.push(
        `spawn-count mismatch: ${declPath} carries ${actual} host-browser-spawn signature occurrence(s) but is pinned at ${entry.signatureOccurrences} — a second host spawn raises the count (RED), removing the spawn lowers it (RED); bump signatureOccurrences only for a benign, reviewed mention`,
      );
    }
  }

  return violations;
}
