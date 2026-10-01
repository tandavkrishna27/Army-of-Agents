function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatEmbeddedPostgresStartupError(error: unknown, dataDir: string): string {
  const message = errorMessage(error);
  if (errorCode(error) === "28P01" || /password authentication failed/i.test(message)) {
    return [
      `Embedded PostgreSQL could not authenticate the existing embedded PostgreSQL cluster at ${dataDir}.`,
      "The cluster credentials do not match this installation's expected credentials.",
      "Stop other AoA processes and preserve the data directory before attempting recovery.",
      "Use a supported database migration or backup/restore procedure; do not delete the data directory.",
      `Original error: ${message}`,
    ].join(" ");
  }
  return message;
}
