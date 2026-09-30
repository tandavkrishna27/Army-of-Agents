import { test } from "@playwright/test";

if (process.platform === "win32" && !process.env.DATABASE_URL?.trim()) {
  test.skip(
    "Windows e2e requires DATABASE_URL because embedded Postgres cannot start as runneradmin",
    async () => {},
  );
}
