// Verifies every assertBoard(req); call in server/src/routes/*.ts is paired
// somewhere in its handler body with one of:
//   - assertCompanyAccess(req, ...)
//   - assertCanManageInstanceSettings(req)
//   - assertRole(db, req, ..., ...)
//   - // rbac: instance-admin-not-required (or rbac: paired-via-helper) comment
//     on the same line or up to 2 lines above
//
// Files in ALLOWLISTED_FILES are exempt pending the plugins workstream that
// will gate them with assertCanManageInstanceSettings. Remove from the
// allowlist as each file gets its proper gates.
//
// Closes finding C3/C5/C6 + parallel-C5 + batch-2 recurrence-prevention
// from the 2026-05-05 codebase review. Five IDORs across the sprint had
// the same root cause: routes called assertBoard(req) (which means "actor
// is a board user, possibly across many companies") without the followup
// assertCompanyAccess or assertCanManageInstanceSettings to enforce the
// actual scope. This test pins the lesson — any new assertBoard(req); without
// an immediate paired check fails CI with a remediation hint.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ALLOWLISTED_FILES = new Set<string>([
  // Pending instance-admin sweep in the plugins workstream — tracked separately.
  // Remove from this set as each file gets its proper assertCanManageInstanceSettings gates.
  "marketplace.ts",
]);

const PAIRED_PATTERNS = [
  /assertCompanyAccess\s*\(/,
  /assertCanManageInstanceSettings\s*\(/,
  /assertRole\s*\(/,
];

const OPT_OUT_COMMENT = /\/\/\s*rbac:\s*(instance-admin-not-required|paired-via-helper)/;

function findRouteFiles(): string[] {
  let cur = __dirname;
  for (let i = 0; i < 8; i++) {
    try {
      readFileSync(join(cur, "pnpm-workspace.yaml"));
      const routesDir = join(cur, "server", "src", "routes");
      const out: string[] = [];
      for (const entry of readdirSync(routesDir)) {
        if (!entry.endsWith(".ts")) continue;
        const path = join(routesDir, entry);
        if (statSync(path).isFile()) out.push(path);
      }
      return out;
    } catch {
      cur = join(cur, "..");
    }
  }
  throw new Error("Could not locate workspace root from " + __dirname);
}

interface HandlerSpan {
  startLine: number; // 0-indexed (line of router.X( ... )
  endLine: number;   // 0-indexed exclusive (line of next router.X( or lines.length)
}

function findHandlerSpan(lines: readonly string[], assertBoardLineIdx: number): HandlerSpan {
  // Walk backward to find the most recent router.X( line.
  let start = 0;
  for (let i = assertBoardLineIdx - 1; i >= 0; i--) {
    if (/router\.(get|post|put|patch|delete|all)\s*\(/.test(lines[i])) {
      start = i;
      break;
    }
  }
  // Walk forward to find the next router.X( line.
  let end = lines.length;
  for (let i = assertBoardLineIdx + 1; i < lines.length; i++) {
    if (/router\.(get|post|put|patch|delete|all)\s*\(/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { startLine: start, endLine: end };
}

function isPaired(lines: readonly string[], assertBoardLineIdx: number): boolean {
  // (1) opt-out comment on the same line OR up to 2 lines above
  const surrounding = lines.slice(Math.max(0, assertBoardLineIdx - 2), assertBoardLineIdx + 1).join("\n");
  if (OPT_OUT_COMMENT.test(surrounding)) return true;

  // (2) paired check anywhere in the same handler body — BEFORE or after the
  // assertBoard line. The docstring says "paired somewhere in its handler body",
  // and a scope check that PRECEDES assertBoard is equally valid: e.g.
  // routes/cockpit.ts runs assertCompanyAccess first on purpose so an
  // unauthenticated actor gets 401 (not the 403 assertBoard would throw). Scanning
  // only the lookahead missed that legitimate ordering. Still catches genuinely
  // unpaired calls (no scope check anywhere in the handler). Span is bounded to a
  // single handler (between consecutive router.X( lines), so pairs don't leak across.
  const span = findHandlerSpan(lines, assertBoardLineIdx);
  const handlerBody = lines.slice(span.startLine, span.endLine).join("\n");
  if (PAIRED_PATTERNS.some((p) => p.test(handlerBody))) return true;

  return false;
}

describe("assertBoard pairing guard", () => {
  it("every assertBoard(req); is paired with an access check, an opt-out comment, or in an allowlisted file", () => {
    const files = findRouteFiles();
    expect(files.length).toBeGreaterThan(0);

    const violations: string[] = [];

    for (const file of files) {
      const filename = basename(file);
      if (ALLOWLISTED_FILES.has(filename)) continue;

      const content = readFileSync(file, "utf8");
      const lines = content.split("\n");

      lines.forEach((line, idx) => {
        if (!/assertBoard\s*\(\s*req\s*\)\s*;/.test(line)) return;
        if (isPaired(lines, idx)) return;
        violations.push(`${filename}:${idx + 1} — ${line.trim()}`);
      });
    }

    if (violations.length > 0) {
      throw new Error(
        `Found ${violations.length} unpaired assertBoard(req); call(s) in server/src/routes/:\n` +
          violations.map((v) => `  ${v}`).join("\n") +
          `\n\nPair each with one of:\n` +
          `  - assertCompanyAccess(req, <companyId>) — most routes\n` +
          `  - assertCanManageInstanceSettings(req) — instance-wide ops\n` +
          `  - assertRole(db, req, <companyId>, ...) — implicit company scoping\n` +
          `  - // rbac: instance-admin-not-required  — explicit opt-out (rare)\n` +
          `  - // rbac: paired-via-helper  — opt-out for helper functions called from gated handlers\n\n` +
          `See findings C3, C5, C6 + parallel-C5 + batch-2 in:\n` +
          `  docs/superpowers/specs/2026-05-05-sprint-1-security-fixes-design.md`,
      );
    }
  });

  it("ALLOWLISTED_FILES only contains tracked-pending files", () => {
    // This second test makes the allowlist visible in test output and
    // catches accidental over-allowing. Adjust as the plugins workstream
    // lands and files get their proper gates.
    expect([...ALLOWLISTED_FILES].sort()).toEqual(["marketplace.ts"]);
  });
});
