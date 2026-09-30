const IDENTITY_KEYS = new Set([
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "NVM_DIR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "PATH",
  "Path",
]);

export function sanitizeRemoteExecutionEnv(
  env: Record<string, string>,
  hostEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (IDENTITY_KEYS.has(key) && hostEnv[key] === value) continue;
    next[key] = value;
  }
  return next;
}
