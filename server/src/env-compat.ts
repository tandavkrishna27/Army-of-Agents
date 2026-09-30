// Runs once at module import: for every `PAPERCLIP_<key>` env var the user
// has set, mirror it into `AOA_<key>` unless `AOA_<key>` is already set.
// This preserves one-release migration for users with Paperclip-branded
// env files or shells. Remove the mirror in the next major after users
// have updated.
//
// Import this module before any code that reads `process.env.AOA_*`.
function mirrorAoaEnv(): void {
  const prefix = "PAPERCLIP_";
  for (const key of Object.keys(process.env)) {
    if (!key.startsWith(prefix)) continue;
    const aoaKey = `AOA_${key.slice(prefix.length)}`;
    if (process.env[aoaKey] !== undefined) continue;
    const value = process.env[key];
    if (value !== undefined) process.env[aoaKey] = value;
  }
}

mirrorAoaEnv();

export function readAoaEnv(key: string): string | undefined {
  const aoa = process.env[`AOA_${key}`];
  if (aoa !== undefined) return aoa;
  return process.env[`PAPERCLIP_${key}`];
}
