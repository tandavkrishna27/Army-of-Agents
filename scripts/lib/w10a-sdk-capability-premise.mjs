// ─────────────────────────────────────────────────────────────────────────────────────────
// w10a-sdk-capability-premise — a NEGATIVE capability claim about a dependency is a claim,
// and nothing in this repository checked one.
//
// ★ WHY THIS EXISTS. For a year the programme recorded, as settled fact, that
// "managed-E2B egress is not fully lockable" (REFUTED as a capability claim — E8-F007).
// It said so in the 2026-08-05 cloud-execution
// spec, in a production code comment beside the only call that could have carried the
// configuration, in a test comment, in two plan documents, and inside finding `E8-F003`'s
// own reasoning — where it supplied the premise for "option (b) is unavailable", i.e. for
// the conclusion that the ONE enforcement layer outside the guest could not be used. The
// installed, lockfile-pinned SDK contradicts it: `e2b@2.30.5` exposes `SandboxOpts.network`,
// puts it in the create body, exposes `updateNetwork`, and reads the applied configuration
// back on `getInfo()`. See `E8-F007`.
//
// The sentence was never checked because it is PROSE ABOUT A DEPENDENCY, and this
// repository's guards check prose against the repository. A claim about what a third-party
// artifact cannot do is exactly the claim that rots silently: the artifact ships a new
// version, nobody re-reads its types, and the sentence keeps being quoted forward.
//
// ★ WHAT THIS CHECKS — four independent assertions, three of which need no `node_modules`:
//   (1) LOCKFILE PIN. The version whose surface was measured is still the version the
//       lockfile resolves. A bump reds the guard and forces a re-measurement, because the
//       declaration below is only true OF A VERSION.
//   (2) SDK SURFACE (only when the dependency is resolvable; REQUIRED under --require-sdk,
//       which is how CI's dependency-installing lane runs it). Every declared marker must
//       still be present in the resolved package. If the surface disappears the declaration
//       is stale and the guard says so rather than continuing to ban a sentence that may
//       have become true again.
//   (3) STALE CLAIM. While the capability is held, no tracked file may assert the stale
//       claim WITHOUT a correction marker near it. Quoting the sentence stays legal — the
//       record has to be able to quote what it is correcting — but quoting it without
//       saying it was refuted does not.
//   (4) NOT VACUOUS. Every declared pattern must still match something. A ban whose regex
//       has stopped matching anything is a check that nothing runs; it fails here rather
//       than passing silently, and the remedy is to delete the pattern deliberately.
//
// ★ WHAT IT DELIBERATELY DOES NOT DO, said plainly rather than implied.
//   - It does not claim the control WORKS. Nobody has run it. It asserts only that the
//     capability EXISTS IN THE INSTALLED ARTIFACT. Whether the operator's E2B tier honours
//     a network body is an OPEN MEASUREMENT.
//   - It does not ban discussing the topic. An honest sentence — "the SDK exposes it;
//     whether the tier honours it is unmeasured" — matches no pattern and stays green.
//   - It does not catch a REWORDING. The patterns are the sentence family that actually
//     occurred, not the idea. A guard that pretended to cover the idea would be the same
//     false claim of enforcement in a new place.
//
// Pure. The caller measures the lockfile, the SDK and the tree; this file does the reasoning.
// ─────────────────────────────────────────────────────────────────────────────────────────

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Default number of lines either side of an occurrence in which a correction marker counts. */
export const DEFAULT_CONTEXT_WINDOW_LINES = 6;

/**
 * Compile one declared stale-claim pattern.
 *
 * Stored as a SOURCE STRING in the manifest so the manifest itself does not match the
 * pattern it declares (`not\\s+fully\\s+lockable` as literal text contains backslash-s, not
 * whitespace) — otherwise the guard's own declaration would be its first violation.
 *
 * @returns {RegExp|null} null when the source is not a usable expression.
 */
export function compileStalePattern(source) {
  if (typeof source !== "string" || source.length === 0) return null;
  try {
    return new RegExp(source, "gi");
  } catch {
    return null;
  }
}

/**
 * Every match of every pattern in one file's text, with the line it sits on and whether a
 * correction marker appears within `contextWindowLines` lines either side.
 *
 * Line-window rather than paragraph: paragraph boundaries differ between Markdown, a `/* *\/`
 * comment block and a one-line JSON string, and the JSON case (the ownership register keeps
 * each `reason` on a single line) has no paragraph at all.
 *
 * @param {string} text
 * @param {{patterns: Array<{id: string, pattern: string}>, markers: string[], contextWindowLines?: number}} opts
 * @returns {Array<{patternId: string, line: number, marked: boolean, excerpt: string}>}
 */
export function scanTextForStaleClaims(text, opts) {
  if (typeof text !== "string" || !isPlainObject(opts)) return [];
  const patterns = Array.isArray(opts.patterns) ? opts.patterns : [];
  const markers = (Array.isArray(opts.markers) ? opts.markers : []).filter(
    (m) => typeof m === "string" && m.length > 0,
  );
  const window = Number.isInteger(opts.contextWindowLines)
    ? opts.contextWindowLines
    : DEFAULT_CONTEXT_WINDOW_LINES;

  const lines = text.split("\n");
  const markedLine = lines.map((line) => markers.some((marker) => line.includes(marker)));

  const hasMarkerNear = (index) => {
    const from = Math.max(0, index - window);
    const to = Math.min(lines.length - 1, index + window);
    for (let i = from; i <= to; i += 1) if (markedLine[i]) return true;
    return false;
  };

  const out = [];
  for (const declared of patterns) {
    if (!isPlainObject(declared)) continue;
    const regex = compileStalePattern(declared.pattern);
    if (!regex) continue;
    for (let i = 0; i < lines.length; i += 1) {
      regex.lastIndex = 0;
      if (!regex.test(lines[i])) continue;
      out.push({
        patternId: String(declared.id),
        line: i + 1,
        marked: hasMarkerNear(i),
        excerpt: lines[i].trim().slice(0, 160),
      });
    }
  }
  return out.sort((a, b) => a.line - b.line || a.patternId.localeCompare(b.patternId));
}

/**
 * @param {{
 *   declaration?: unknown,                                   // the manifest, already parsed
 *   lockfileVersions?: string[]|null,                        // versions the lockfile resolves for the package
 *   sdkSurface?: null | {version?: string|null, resolvedFrom?: Record<string,string|null>,
 *                        missingMarkers?: Array<{file: string, needle: string}>},
 *   occurrences?: Array<{file: string, patternId: string, line: number, marked: boolean, excerpt?: string}>,
 *   requireSdk?: boolean,
 * }} input
 * @returns {{ok: boolean, capabilityHeld: boolean, sdkMeasured: boolean,
 *            problems: Array<{kind: string, detail?: string}>, notes: string[],
 *            occurrenceCount: number, unmarkedCount: number}}
 */
export function evaluateSdkCapabilityPremise(input) {
  const problems = [];
  const notes = [];
  const fail = (kind, detail) => problems.push(detail === undefined ? { kind } : { kind, detail });

  if (!isPlainObject(input)) {
    return {
      ok: false,
      capabilityHeld: false,
      sdkMeasured: false,
      problems: [{ kind: "malformed_input" }],
      notes,
      occurrenceCount: 0,
      unmarkedCount: 0,
    };
  }

  const declaration = input.declaration;
  if (!isPlainObject(declaration)) {
    return {
      ok: false,
      capabilityHeld: false,
      sdkMeasured: false,
      problems: [{ kind: "malformed_declaration", detail: "manifest is not an object" }],
      notes,
      occurrenceCount: 0,
      unmarkedCount: 0,
    };
  }

  const pkg = typeof declaration.package === "string" ? declaration.package : null;
  const declaredVersion =
    typeof declaration.measuredVersion === "string" ? declaration.measuredVersion : null;
  const patterns = Array.isArray(declaration.stalePatterns) ? declaration.stalePatterns : [];
  const markers = Array.isArray(declaration.correctionMarkers) ? declaration.correctionMarkers : [];

  if (!pkg) fail("malformed_declaration", "package missing");
  if (!declaredVersion) fail("malformed_declaration", "measuredVersion missing");
  if (patterns.length === 0) {
    fail(
      "malformed_declaration",
      "stalePatterns is empty — a ban with no patterns is a check that nothing runs",
    );
  }
  if (markers.length === 0) {
    fail(
      "malformed_declaration",
      "correctionMarkers is empty — with no marker, every quotation of the claim is a violation",
    );
  }
  for (const declared of patterns) {
    if (!isPlainObject(declared) || typeof declared.id !== "string" || !declared.id) {
      fail("malformed_declaration", "a stalePatterns entry needs an id");
      continue;
    }
    if (compileStalePattern(declared.pattern) === null) {
      fail("malformed_declaration", `${declared.id}: pattern is not a usable expression`);
    }
    if (typeof declared.why !== "string" || declared.why.length === 0) {
      fail("malformed_declaration", `${declared.id}: why missing — an unexplained ban gets deleted`);
    }
  }
  if (problems.length > 0) {
    return {
      ok: false,
      capabilityHeld: false,
      sdkMeasured: false,
      problems,
      notes,
      occurrenceCount: 0,
      unmarkedCount: 0,
    };
  }

  // (1) LOCKFILE PIN — the declaration is true OF A VERSION, so a bump must re-derive it.
  const lockfileVersions = Array.isArray(input.lockfileVersions) ? input.lockfileVersions : null;
  if (lockfileVersions === null) {
    fail("lockfile_not_measured", `no lockfile entry was measured for ${pkg}`);
  } else if (lockfileVersions.length === 0) {
    fail("lockfile_package_absent", `the lockfile resolves no version of ${pkg}`);
  } else if (lockfileVersions.length > 1) {
    fail(
      "lockfile_version_ambiguous",
      `${pkg} resolves to ${lockfileVersions.join(", ")} — the guard refuses to pick a winner`,
    );
  } else if (lockfileVersions[0] !== declaredVersion) {
    fail(
      "lockfile_version_mismatch",
      `the lockfile resolves ${pkg}@${lockfileVersions[0]}, the surface below was measured on ${declaredVersion}`,
    );
  }

  // (2) SDK SURFACE — measured only where the dependency is installed.
  const sdk = input.sdkSurface;
  const sdkMeasured = isPlainObject(sdk);
  if (!sdkMeasured) {
    if (input.requireSdk === true) {
      fail(
        "sdk_not_resolvable",
        `${pkg} could not be resolved, and --require-sdk says this lane must measure it`,
      );
    } else {
      notes.push(
        `SDK surface NOT MEASURED here (${pkg} is not installed in this lane). ` +
          "The lockfile pin and the stale-claim ban still ran; the live surface is measured " +
          "by the same guard under --require-sdk in the dependency-installing lane.",
      );
    }
  } else {
    if (typeof sdk.version === "string" && declaredVersion && sdk.version !== declaredVersion) {
      fail(
        "sdk_version_mismatch",
        `resolved ${pkg}@${sdk.version}, declaration measured ${declaredVersion}`,
      );
    }
    const resolvedFrom = isPlainObject(sdk.resolvedFrom) ? sdk.resolvedFrom : {};
    for (const [from, where] of Object.entries(resolvedFrom)) {
      if (where === null) fail("sdk_not_resolvable", `${pkg} does not resolve from ${from}`);
    }
    const missing = Array.isArray(sdk.missingMarkers) ? sdk.missingMarkers : [];
    for (const marker of missing) {
      fail(
        "sdk_surface_missing",
        `${marker && marker.file}: ${JSON.stringify(marker && marker.needle)} is gone — ` +
          "the declaration no longer describes the installed artifact",
      );
    }
  }

  // The capability is held unless a measurement says otherwise. A lane that cannot measure
  // the SDK still enforces the ban, on the strength of the pinned version — which is why (1)
  // is a hard failure rather than a note.
  const surfaceIntact =
    !sdkMeasured || (Array.isArray(sdk.missingMarkers) ? sdk.missingMarkers.length === 0 : true);
  const capabilityHeld = surfaceIntact;

  // (3) + (4) — the tree.
  const occurrences = Array.isArray(input.occurrences) ? input.occurrences : [];
  const seenPatterns = new Set(occurrences.map((o) => o && o.patternId));
  for (const declared of patterns) {
    const min = Number.isInteger(declared.minOccurrences) ? declared.minOccurrences : 1;
    if (min > 0 && !seenPatterns.has(declared.id)) {
      fail(
        "pattern_matches_nothing",
        `${declared.id} matches no tracked file. Either the claim is genuinely gone from the ` +
          "tree — in which case delete the pattern deliberately and say so in E8-F007 — or the " +
          "scanner broke and this ban has silently stopped being a ban.",
      );
    }
  }

  let unmarkedCount = 0;
  if (capabilityHeld) {
    for (const occurrence of occurrences) {
      if (!isPlainObject(occurrence) || occurrence.marked === true) continue;
      unmarkedCount += 1;
      fail(
        "stale_claim_unmarked",
        `${occurrence.file}:${occurrence.line} asserts ${occurrence.patternId} with no ` +
          `correction marker (${markers.join(" | ")}) within reach — ${occurrence.excerpt ?? ""}`,
      );
    }
  } else {
    notes.push(
      "The stale-claim ban was NOT applied: the SDK surface this guard depends on is no " +
        "longer present, so the claim may have become true again. Re-measure and re-file " +
        "before trusting either direction.",
    );
  }

  return {
    ok: problems.length === 0,
    capabilityHeld,
    sdkMeasured,
    problems,
    notes,
    occurrenceCount: occurrences.length,
    unmarkedCount,
  };
}
