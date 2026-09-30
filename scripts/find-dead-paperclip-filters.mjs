#!/usr/bin/env node
/**
 * Audit: where does the codebase still filter for the legacy "[paperclip]"
 * log prefix? Anything that matches is now dead — adapters and scripts emit
 * "[aoa]" since commit 97eeddc.
 *
 * Output: JSON to stdout with { file, line, snippet } for each match.
 * Allow-list: docs that document the rename itself (the rename plan file
 * and the changelog) — they reference the old prefix as historical context.
 *
 * Run from the repo root:
 *   node scripts/find-dead-paperclip-filters.mjs
 *
 * Triage buckets:
 *   1. Dev scripts / Makefile / runbook docs   → fix inline (rename or remove)
 *   2. Test fixtures / parsers                 → leave if testing legacy format;
 *                                                flag with comment if production-hot
 *   3. Operator-shipped configs (Datadog, etc) → out of scope; document in
 *                                                docs/deploy/upgrade-guide.md
 *
 * Re-run this script any time you suspect log-filter drift was introduced.
 * It is NOT wired into CI — it is an on-demand audit tool.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const PATTERN = /\[paperclip\]/i;

/** Directories to skip entirely. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".claude",     // worktrees + local IDE configs — not shipping code
  "data",        // runtime data / embedded-pg files
]);

/**
 * Allow-listed file patterns.
 *
 * These files legitimately contain "[paperclip]" as historical context,
 * documentation of the rename, or as a parser for *upstream tool output*
 * (not an AoA-emitted prefix). They are NOT dead consumers.
 *
 * When adding a new allow-list entry, document WHY it belongs here.
 */
const ALLOW_LIST_PATTERNS = [
  // Rename plan — references old prefix as part of what is being renamed.
  /docs\/superpowers\/plans\/2026-04-25-paperclip-to-aoa-rename\.md$/,

  // Wire-compat reference — documents intentionally preserved legacy identifiers.
  /docs\/aoa\/reference\/wire-compat\.md$/,

  // Changeset that landed the rename — historical record.
  /\.changeset\/v1-0-0-rc-4-polish-batch\.md$/,

  // Cleanup sprint plan — describes what dead [paperclip] filter sites look like
  // as part of the Task 9 audit description. Not a live consumer.
  /docs\/superpowers\/plans\/2026-04-26-residual-cleanup\.md$/,

  // upgrade-guide.md — the "Log prefix change" paragraph is documentation prose
  // explaining the rename to operators, not a live grep filter.
  /docs\/deploy\/upgrade-guide\.md$/,

  // paperclip-vs-aoa.md — explains AoA's upstream heritage; uses "[paperclip]"
  // as a code-formatted example of the OLD prefix, not a filter.
  /docs\/start\/paperclip-vs-aoa\.md$/,

  // README.md — upstream attribution prose; "[paperclip]" appears in the badge
  // attribution sentence, not as a log filter.
  /README\.md$/,

  // pr.yml brand-check — Guard 6 of the CI is a *positive* guard that CATCHES
  // new uses of the old prefix; this is the opposite of a dead consumer.
  /\.github\/workflows\/pr\.yml$/,

  // normalize-transcript.ts — matches the *upstream Claude CLI binary's* stderr
  // output (the CLI itself still emits "[paperclip] …"). This is intentionally
  // kept so the filter works even with older CLI versions installed. The file
  // already carries a "brand-check-ignore: external-tool-output" annotation.
  // Bucket: test/parsing fixture — leave as-is.
  /ui\/src\/components\/workspace\/transcript\/normalize-transcript\.ts$/,

  // Self-reference — this script mentions the pattern for documentation.
  /scripts\/find-dead-paperclip-filters\.mjs$/,
];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walk(p));
    else if (s.isFile()) out.push(p);
  }
  return out;
}

const findings = [];

for (const filePath of walk(ROOT)) {
  // Normalize to forward slashes for cross-platform allow-list matching.
  const relPath = filePath.slice(ROOT.length + 1).replaceAll("\\", "/");

  if (ALLOW_LIST_PATTERNS.some((rx) => rx.test(relPath))) continue;

  let text;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    continue; // binary or unreadable — skip silently
  }

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (PATTERN.test(lines[i])) {
      findings.push({
        file: relPath,
        line: i + 1,
        snippet: lines[i].trim().slice(0, 200),
      });
    }
  }
}

process.stdout.write(JSON.stringify(findings, null, 2) + "\n");

if (findings.length === 0) {
  process.stderr.write(
    "audit: no dead [paperclip] log-filter consumers found outside the allow-list.\n"
  );
} else {
  process.stderr.write(
    `audit: ${findings.length} finding(s) — triage into buckets 1/2/3 per script header.\n`
  );
}

// Always exit 0 — informational output only, not a gate.
process.exit(0);
