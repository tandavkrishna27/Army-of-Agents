import fs from "node:fs";

const [, , inputPath, outputPath] = process.argv;

if (!inputPath || !outputPath) {
  console.error("usage: node redact-json-file.mjs <input> <output>");
  process.exit(2);
}

const secretKeyPattern = /(secret|token|password|api[_-]?key|connectionstring|databaseurl|privatekey|masterkey)/i;

function redact(value, key = "") {
  if (value === null || value === undefined) return value;
  if (secretKeyPattern.test(key)) return "<redacted>";
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [childKey, redact(childValue, childKey)]),
    );
  }
  if (typeof value === "string" && /(postgres|mysql|mongodb|redis):\/\//i.test(value)) {
    return "<redacted-url>";
  }
  return value;
}

const parsed = JSON.parse(fs.readFileSync(inputPath, "utf8"));
fs.writeFileSync(outputPath, `${JSON.stringify(redact(parsed), null, 2)}\n`);
