import fs from "node:fs";

const [, , outputPath] = process.argv;

if (!outputPath) {
  console.error("usage: node write-redacted-env.mjs <output>");
  process.exit(2);
}

const secretKeyPattern =
  /(secret|token|password|api[_-]?key|connection|string|database[_-]?url|private[_-]?key|master[_-]?key)/i;
const interestingPrefix =
  /^(AOA_|DATABASE_URL|OPENAI_|ANTHROPIC_|GEMINI_|GOOGLE_|CURSOR_|BETTER_AUTH_|HOST$|PORT$|SERVE_UI$|NODE_ENV$|CI$)/;

const entries = Object.entries(process.env)
  .filter(([key]) => interestingPrefix.test(key))
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([key, value]) => [key, secretKeyPattern.test(key) ? "<redacted>" : value]);

fs.writeFileSync(outputPath, `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`);
