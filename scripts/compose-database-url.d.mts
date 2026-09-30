// Type declarations for compose-database-url.mjs (plain-JS Docker-layer script),
// so TypeScript consumers (e.g. the packages/db round-trip test) typecheck.
export function buildDatabaseUrl(opts: { user: string; password: string; db: string }): string;
export function databaseUrlFromEnv(env?: Record<string, string | undefined>): string | null;
