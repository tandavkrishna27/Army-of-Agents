import { bootstrapCeoInvite } from "../cli/src/commands/auth-bootstrap-ceo.ts";

function firstEnv(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

try {
  const result = await bootstrapCeoInvite({
    baseUrl: firstEnv(
      "BOOTSTRAP_BASE_URL",
      "AOA_PUBLIC_URL",
      "AOA_AUTH_PUBLIC_BASE_URL",
      "BETTER_AUTH_URL",
      "BETTER_AUTH_BASE_URL",
    ),
    force: ["1", "true", "yes", "on"].includes((process.env.BOOTSTRAP_FORCE ?? "").toLowerCase()),
  });
  process.exit(result.status === "failed" ? 1 : 0);
} catch (err) {
  console.error(err);
  process.exit(1);
}
