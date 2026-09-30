#!/usr/bin/env node
/**
 * check-forbidden-tokens.mjs
 *
 * Scans the codebase for forbidden tokens before publishing to npm.
 * Mirrors the git pre-commit hook logic, but runs against the full
 * working tree (not just staged changes).
 *
 * Config sources (first match wins):
 *   1. .forbidden-tokens.json at repo root (tracked, shared by everyone).
 *      Schema: { tokens: string[], allowPaths: string[] }
 *      - tokens: substrings that must NOT appear in any tracked file.
 *      - allowPaths: git pathspecs (literal paths or globs) where the
 *        tokens are allowed to appear (e.g. release notes, the brand-check
 *        config itself, historical spec docs). Each path is passed to
 *        git grep as a `:!<path>` exclusion pathspec.
 *   2. .git/hooks/forbidden-tokens.txt (legacy, per-developer).
 *      One token per line, # comments ok. No allowlist — if you need
 *      one, migrate to the JSON config.
 *
 * If neither file exists, the check passes silently.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
const gitDir = execSync("git rev-parse --git-dir", { encoding: "utf8", cwd: repoRoot }).trim();

const jsonConfigFile = resolve(repoRoot, ".forbidden-tokens.json");
const txtTokensFile = resolve(repoRoot, gitDir, "hooks/forbidden-tokens.txt");

let tokens = [];
let allowPaths = [];
let configSource = null;

if (existsSync(jsonConfigFile)) {
  configSource = ".forbidden-tokens.json";
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(jsonConfigFile, "utf8"));
  } catch (err) {
    console.error(`ERROR: Failed to parse ${configSource}: ${err.message}`);
    process.exit(2);
  }
  tokens = Array.isArray(parsed.tokens) ? parsed.tokens.filter((t) => typeof t === "string" && t.length > 0) : [];
  allowPaths = Array.isArray(parsed.allowPaths) ? parsed.allowPaths.filter((p) => typeof p === "string" && p.length > 0) : [];
} else if (existsSync(txtTokensFile)) {
  configSource = ".git/hooks/forbidden-tokens.txt";
  tokens = readFileSync(txtTokensFile, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
} else {
  console.log("  ℹ  Forbidden tokens list not found — skipping check.");
  process.exit(0);
}

if (tokens.length === 0) {
  console.log(`  ℹ  Forbidden tokens list (${configSource}) is empty — skipping check.`);
  process.exit(0);
}

// Build the pathspec exclude list once. Always exclude pnpm-lock.yaml and .git.
// Each allowPaths entry becomes a `:!<path>` git-grep pathspec exclusion.
const baseExcludes = [":!pnpm-lock.yaml", ":!.git"];
const allowExcludes = allowPaths.map((p) => `:!${p}`);
const pathspecs = [...baseExcludes, ...allowExcludes].map((p) => JSON.stringify(p)).join(" ");

// Use git grep to search tracked files only (avoids node_modules, dist, etc.)
let found = false;

for (const token of tokens) {
  try {
    const result = execSync(
      `git grep -in --no-color -- ${JSON.stringify(token)} -- ${pathspecs}`,
      { encoding: "utf8", cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"] },
    );
    if (result.trim()) {
      if (!found) {
        console.error("ERROR: Forbidden tokens found in tracked files:\n");
      }
      found = true;
      // Print matches but DO NOT print which token was matched (avoids leaking the list)
      const lines = result.trim().split("\n");
      for (const line of lines) {
        console.error(`  ${line}`);
      }
    }
  } catch {
    // git grep returns exit code 1 when no matches — that's fine
  }
}

if (found) {
  console.error("\nBuild blocked. Remove the forbidden token(s) before publishing.");
  console.error(`(If a match is a legitimate exception, add its path to allowPaths in ${configSource}.)`);
  process.exit(1);
} else {
  console.log(`  ✓  No forbidden tokens found (checked ${tokens.length} token(s), ${allowPaths.length} allowlist path(s) from ${configSource}).`);
}
