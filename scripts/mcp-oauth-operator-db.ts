import { loadConfig } from "../server/src/config.js";

/**
 * Resolve the database used by the active AoA instance.
 *
 * External deployments use DATABASE_URL/config. Embedded deployments expose
 * their database on the configured loopback port while the AoA server is
 * running, so operator commands work for the zero-config development path too.
 */
export function resolveActiveDatabaseUrl(): string {
  const config = loadConfig();
  const externalUrl = config.databaseUrl?.trim();
  if (externalUrl) return externalUrl;

  return `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;
}

export function readRequiredFlag(name: string): string {
  const prefix = `--${name}=`;
  const value = process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length).trim();
  if (!value) throw new Error(`Missing required ${prefix}<value>`);
  return value;
}

export function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
