const [, , rawUrl] = process.argv;

if (!rawUrl) {
  console.error("usage: node url-db-name.mjs <postgres-url>");
  process.exit(2);
}

const parsed = new URL(rawUrl);
const dbName = parsed.pathname.replace(/^\//, "");
if (!dbName) {
  console.error("postgres url does not include a database name");
  process.exit(2);
}

console.log(dbName);
