/**
 * embedded-secret-scan.mjs — pure embedded-credential detection (DSK-003 Lane D, D7/D8).
 *
 * Clause (1) of DSK-003 is "no credential is embedded". This is the gate that decides it.
 *
 * SCANS THE BUILT ARTIFACT, NOT THE SOURCE. Source proves nothing about what packaging
 * swept in: a `.env` beside the entry point, a test fixture, a keystore file from a
 * developer's own machine. The caller supplies the packaged file set; this module decides.
 *
 * THE NON-VACUITY PROBLEM IS THE WHOLE DESIGN. A scanner that finds nothing looks exactly
 * like a scanner that looks for nothing, so `SECRET_PATTERNS` is exported and the test
 * suite plants one CI test identity PER PATTERN and asserts each is found by its own
 * pattern. A new pattern with no planted sample, or a sample with no pattern, fails the
 * suite. That is the half of the gate that keeps the other half honest.
 *
 * FINDINGS NEVER ECHO THE SECRET. This output goes to CI logs; printing the credential it
 * found would publish the very thing it guards. A finding carries the file, the pattern
 * id, and a line number — enough to locate it, nothing to leak.
 *
 * A FORBIDDEN KEY IS NOT A FINDING ON ITS OWN. `apiKey: process.env.API_KEY` is correct
 * code. Only a forbidden key assigned a plausible literal VALUE counts, or the gate gets
 * switched off within a week — and a gate that gets switched off is worse than none.
 *
 * Dependencies: none. Node built-ins are not even required.
 */

/**
 * The pattern classes. Each has a planted CI test identity in the test suite; the suite
 * fails if the two lists diverge.
 *
 * `re` must be global so every occurrence in a file is reported, and each is used with a
 * reset `lastIndex` because a shared global regex is stateful across calls.
 */
export const SECRET_PATTERNS = [
  {
    id: "aoa_enrollment_code",
    // Mirrors the server's own regex (`worker-enrollment.ts`) and the DSK-001 client
    // redactor, so it matches exactly what a real credential looks like and nothing else.
    re: /aoa_enr_[A-Za-z0-9_-]{16,64}\.[A-Za-z0-9_-]{32,128}/g,
  },
  {
    id: "private_key_pem",
    re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/g,
  },
  {
    id: "anthropic_api_key",
    re: /sk-ant-[A-Za-z0-9_-]{20,}/g,
  },
  {
    id: "openai_api_key",
    // Deliberately after the Anthropic pattern and requiring 32+ chars, so `sk-ant-…`
    // is claimed by its own class and a short `sk-` placeholder is not a finding.
    re: /sk-(?!ant-)[A-Za-z0-9]{32,}/g,
  },
  {
    id: "github_token",
    re: /gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/g,
  },
  {
    id: "aws_access_key_id",
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    id: "forbidden_key_assignment",
    // A forbidden wire key assigned a LITERAL value of plausible length. The key list is
    // the frozen `FORBIDDEN_WIRE_KEYS` vocabulary, reproduced here because this script is
    // dependency-free by design (it runs before/around a build, like image-admission).
    // `process.env.X`, destructuring, empty strings and `null` are all excluded by
    // requiring a quoted literal of at least 8 characters.
    re: /["']?(?:api[_-]?key|password|access[_-]?token|refresh[_-]?token|secret[_-]?value|credentials?|authorization)["']?\s*[:=]\s*["'][^"'\s]{8,}["']/gi,
  },
];

/** One detection. Carries WHERE, never WHAT. */
function makeFinding(file, patternId, line) {
  return { file, patternId, line };
}

/**
 * Scan one text blob. Returns a finding per match, ordered by pattern then position.
 *
 * Never throws: a packaged artifact contains images, fonts and archives, and the gate
 * must report on what it can read rather than failing the build on the first binary file.
 */
export function scanTextForSecrets(text, file, patterns = SECRET_PATTERNS) {
  if (typeof text !== "string" || text.length === 0) return [];
  const findings = [];
  for (const { id, re } of patterns) {
    // A shared global regex is stateful across calls. This reset is DEFENSIVE rather
    // than currently load-bearing: `exec` sets `lastIndex` back to 0 when it returns
    // null, and the loop below always runs to exhaustion, so a mutant deleting this line
    // survives — correctly. It becomes load-bearing the moment anyone adds an early
    // return or a findings cap, which a real gate eventually wants. Kept deliberately,
    // and recorded so the next reader does not delete it as dead.
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(text)) !== null) {
      const line = text.slice(0, match.index).split("\n").length;
      findings.push(makeFinding(file, id, line));
      // Advance past a ZERO-WIDTH match, or `exec` returns the same empty match forever
      // and the build hangs instead of failing. No shipped pattern can match zero-width
      // today, which is why `patterns` is injectable: the guard is proven against a
      // deliberately zero-width pattern rather than left as unreachable defence.
      if (match[0].length === 0) re.lastIndex += 1;
    }
  }
  return findings;
}

/**
 * Scan a whole file set.
 *
 * Sorted by file path so CI output is stable and a diff between two runs is meaningful
 * rather than reordered noise.
 */
export function scanFileSetForSecrets(files, patterns = SECRET_PATTERNS) {
  const findings = [];
  for (const entry of files ?? []) {
    if (!entry || typeof entry.path !== "string") continue;
    try {
      findings.push(...scanTextForSecrets(entry.text, entry.path, patterns));
    } catch {
      // A file that cannot be scanned is not a pass — but it is also not a credential.
      // The caller's manifest check is what proves the set was complete.
    }
  }
  return findings.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
}
