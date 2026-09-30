import { describe, it, expect } from "vitest";
import postgres from "postgres";
// The builder is a Docker-layer script (shipped in the image, invoked by
// scripts/docker-entrypoint.sh). It lives at the repo root, outside this
// package, but packages/db is the only vitest project with `postgres` on hand
// to prove the round-trip.
import { buildDatabaseUrl, databaseUrlFromEnv } from "../../../../scripts/compose-database-url.mjs";

// Parse a URL exactly the way the server does — hand it to the real postgres.js
// driver and read its resolved options. postgres.js parses lazily, so no socket
// is opened; end() just tears down the (empty) pool.
function parsedOptions(url: string): { user: string; pass: string; database: string } {
  const sql = postgres(url);
  const { user, pass, database } = sql.options as unknown as {
    user: string;
    pass: string;
    database: string;
  };
  void sql.end({ timeout: 0 }).catch(() => {});
  return { user, pass, database };
}

describe("buildDatabaseUrl", () => {
  it("round-trips a password full of URL-reserved characters through real postgres.js", () => {
    const password = "p@ss/w#rd?x%20&y:z";
    const url = buildDatabaseUrl({ user: "paperclip", password, db: "paperclip" });
    const opts = parsedOptions(url);
    expect(opts.pass).toBe(password);
    expect(opts.user).toBe("paperclip");
    expect(opts.database).toBe("paperclip");
  });

  it("round-trips a username containing reserved characters", () => {
    const user = "a:b@c/d";
    const url = buildDatabaseUrl({ user, password: "pw", db: "paperclip" });
    expect(parsedOptions(url).user).toBe(user);
  });

  it("places the database name literally, never percent-encoded", () => {
    const url = buildDatabaseUrl({ user: "u", password: "pw", db: "paperclip" });
    expect(url.endsWith("/paperclip")).toBe(true);
    expect(parsedOptions(url).database).toBe("paperclip");
  });

  it("hardcodes host:port as db:5432", () => {
    const url = buildDatabaseUrl({ user: "u", password: "pw", db: "paperclip" });
    expect(url).toContain("@db:5432/");
  });

  it("rejects a database name that is not a plain SQL identifier", () => {
    expect(() => buildDatabaseUrl({ user: "u", password: "pw", db: "my/db" })).toThrow();
    expect(() => buildDatabaseUrl({ user: "u", password: "pw", db: "" })).toThrow();
    expect(() => buildDatabaseUrl({ user: "u", password: "pw", db: "1bad" })).toThrow();
  });
});

describe("databaseUrlFromEnv", () => {
  it("returns null when no AOA_POSTGRES_PASSWORD is set (embedded-postgres deployments)", () => {
    // quickstart / standalone docker run ship no db service — must NOT assemble
    // an external URL, or the server flips off embedded postgres and can't connect.
    expect(databaseUrlFromEnv({})).toBeNull();
    expect(databaseUrlFromEnv({ AOA_POSTGRES_PASSWORD: "" })).toBeNull();
  });

  it("assembles with paperclip user/db defaults when only the password is set", () => {
    expect(databaseUrlFromEnv({ AOA_POSTGRES_PASSWORD: "paperclip" })).toBe(
      "postgres://paperclip:paperclip@db:5432/paperclip",
    );
  });

  it("encodes a password sourced from the environment", () => {
    const url = databaseUrlFromEnv({ AOA_POSTGRES_PASSWORD: "a b/c#d" });
    expect(url).not.toBeNull();
    expect(parsedOptions(url as string).pass).toBe("a b/c#d");
  });
});
