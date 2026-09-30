// Assemble the server's DATABASE_URL from the discrete AOA_POSTGRES_* pieces,
// percent-encoding the user and password so URL-reserved characters (/ # ? % @ :)
// in a hardened AOA_POSTGRES_PASSWORD survive round-tripping through postgres.js.
//
// postgres.js (3.4.x) extracts each component differently:
//   - username / password : decodeURIComponent(urlObj.username|password)  -> ENCODE
//   - database             : (url.pathname || '').slice(1)  (no decode)   -> LITERAL
//   - host / port          : urlObj.host / urlObj.port                     -> LITERAL
// So we encodeURIComponent user + password only; host:port are fixed compose
// constants (db:5432, never user-controlled); the database name is validated as a
// plain identifier and placed literally (an encoded db name would be taken
// verbatim, e.g. `my%2Fdb`).
//
// Invoked by scripts/docker-entrypoint.sh:
//   DATABASE_URL="$(node /app/scripts/compose-database-url.mjs)"
// Only when DATABASE_URL is unset, so an explicit DATABASE_URL always wins.

import { pathToFileURL } from "node:url";

const DB_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function buildDatabaseUrl({ user, password, db }) {
  if (!DB_NAME_RE.test(db)) {
    throw new Error(`Unsafe AOA_POSTGRES_DB (must match ${DB_NAME_RE}): ${JSON.stringify(db)}`);
  }
  const enc = encodeURIComponent;
  return `postgres://${enc(user)}:${enc(password)}@db:5432/${db}`;
}

export function databaseUrlFromEnv(env = process.env) {
  const password = env.AOA_POSTGRES_PASSWORD;
  // No Postgres password => this is an embedded-postgres deployment
  // (docker-compose.quickstart.yml or the standalone `docker run` flow, which
  // ship no `db` service). Return null so the entrypoint leaves DATABASE_URL
  // unset and the server stays on embedded postgres. Only the multi-service
  // docker-compose.yml injects AOA_POSTGRES_* (password defaults to paperclip),
  // so only that stack assembles an external URL.
  if (!password) return null;
  // `|| default` mirrors compose's `${AOA_POSTGRES_*:-paperclip}` — an empty
  // value falls back to the default, same as the `:-` expansion.
  return buildDatabaseUrl({
    user: env.AOA_POSTGRES_USER || "paperclip",
    password,
    db: env.AOA_POSTGRES_DB || "paperclip",
  });
}

// CLI entry: print the assembled URL (nothing in embedded mode), or fail fast
// (nonzero exit) on a bad db name so the container aborts before boot instead
// of misconnecting.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const url = databaseUrlFromEnv();
    if (url) process.stdout.write(`${url}\n`);
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exit(1);
  }
}
