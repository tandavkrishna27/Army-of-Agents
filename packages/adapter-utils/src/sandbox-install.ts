export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

const ENSURE_NPM_PREAMBLE =
  "AOA_NPM_BOOTSTRAPPED=; " +
  "if ! command -v npm >/dev/null 2>&1; then " +
  'NODE_ARCH="$(uname -m)"; ' +
  'case "$NODE_ARCH" in ' +
  "x86_64) NODE_ARCH=x64 ;; " +
  "aarch64|arm64) NODE_ARCH=arm64 ;; " +
  "esac; " +
  'NODE_VERSION="v22.11.0"; ' +
  'NODE_TARBALL="node-${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"; ' +
  'mkdir -p "$HOME/.local"; ' +
  'curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/${NODE_TARBALL}" -o "/tmp/${NODE_TARBALL}" && ' +
  'tar -xJf "/tmp/${NODE_TARBALL}" -C "$HOME/.local" --strip-components=1 && ' +
  'rm -f "/tmp/${NODE_TARBALL}" && ' +
  'export PATH="$HOME/.local/bin:$PATH" && ' +
  "AOA_NPM_BOOTSTRAPPED=1; " +
  "fi;";

export function buildSandboxNpmInstallCommand(packageName: string): string {
  const quotedPackageName = shellQuote(packageName);
  return [
    ENSURE_NPM_PREAMBLE,
    'if [ -n "$AOA_NPM_BOOTSTRAPPED" ]; then',
    `npm install -g ${quotedPackageName};`,
    'elif [ "$(id -u)" -eq 0 ]; then',
    `npm install -g ${quotedPackageName};`,
    'elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then',
    `sudo -E npm install -g ${quotedPackageName};`,
    "else",
    `mkdir -p "$HOME/.local" && npm install -g --prefix "$HOME/.local" ${quotedPackageName};`,
    "fi",
  ].join(" ");
}

function requireNonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} is required`);
  }
  return trimmed;
}

export function buildNpmGlobalInstallIfMissingCommand(input: {
  command: string;
  packageName: string;
}): string {
  const command = requireNonEmpty(input.command, "command");
  const packageName = requireNonEmpty(input.packageName, "packageName");
  const quotedCommand = shellQuote(command);
  return `if ! command -v ${quotedCommand} >/dev/null 2>&1; then npm install -g ${shellQuote(packageName)}; fi`;
}
