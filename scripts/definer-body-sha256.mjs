#!/usr/bin/env node
// Print the bodySha256 the SECURITY DEFINER certificate expects for every function in a
// migration.
//
// The certificate computes, in SQL (distributed-execution-databases.ts:411):
//   encode(sha256(convert_to(replace(prosrc, chr(13), ''), 'UTF8')), 'hex')
// `prosrc` is the body BETWEEN the `$$` delimiters — nothing else. The CR strip is
// load-bearing: packages/db/src/migrations/ carries no `eol=lf` pin, so a Windows checkout
// stores CRLF and Linux CI stores LF, and a raw hash would pin one platform and fail boot
// on the other.
//
// ★ WHY THIS EXISTS. A wrong-but-well-formed bodySha256 is 64 hex characters, satisfies
// every shape assertion in security-definer-manifest.test.ts, and passes every check
// runnable without a database — and then BRICKS EVERY BOOT, flag on or off, because
// `assertManifestedSecurityDefinerFunctions` runs unconditionally. Before this script the
// repository had no generator at all and the three `0267` hashes were produced by hand.
//
// ★ IT IS A TEXTUAL APPROXIMATION OF A CATALOG READ, and the difference is real: PostgreSQL
// stores what the parser kept, this reads what the file says. They agree for the shapes this
// repository writes (a single `AS $$ … $$;` body per function, no dollar-quote tags, no
// nested `$$`). Prove it on a known-good migration before trusting it on a new one:
//
//   node scripts/definer-body-sha256.mjs \
//     packages/db/src/migrations/0267_canary_preflight_evidence_org_scope.sql
//
// must reproduce the three values already pinned in server/src/db/security-definer-manifest.ts.
// If it does not, the tool is wrong — fix it there, not after a new migration is written.
//
// Usage: node scripts/definer-body-sha256.mjs <migration.sql>
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/definer-body-sha256.mjs <migration.sql>");
  process.exit(2);
}
const sql = readFileSync(file, "utf8");
const names = [...sql.matchAll(/CREATE OR REPLACE FUNCTION\s+(?:public\.)?(\w+)/g)].map((m) => m[1]);
const bodies = [...sql.matchAll(/AS \$\$([\s\S]*?)\$\$;/g)].map((m) => m[1]);
// A mismatch means the file uses a shape this extractor does not model (a dollar-quote tag,
// a nested $$, a function with no body match). Refuse rather than pair them positionally —
// a mis-paired hash is exactly the well-formed-and-wrong value described above.
if (names.length !== bodies.length) {
  console.error(`function/body count mismatch: ${names.length} vs ${bodies.length}`);
  process.exit(1);
}
if (names.length === 0) {
  console.error(`no CREATE OR REPLACE FUNCTION found in ${file}`);
  process.exit(1);
}
for (const [i, name] of names.entries()) {
  const hash = createHash("sha256").update(bodies[i].replace(/\r/g, ""), "utf8").digest("hex");
  console.log(`${name}\n  ${hash}`);
}
