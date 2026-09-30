#!/usr/bin/env bash
# Guarantee GNU bash. The provisioner can be invoked as `sh -c "bash <script>"`
# (runWorkspaceCommand uses /bin/sh), where on minimal Linux images the `bash`
# token may resolve to dash/busybox, which rejects `set -o pipefail` on line 2.
if [ -z "${BASH_VERSION:-}" ]; then
  if command -v bash >/dev/null 2>&1; then exec bash "$0" "$@"; fi
  echo "provision-worktree.sh requires bash" >&2
  exit 1
fi
set -euo pipefail

base_cwd="${AOA_WORKSPACE_BASE_CWD:?AOA_WORKSPACE_BASE_CWD is required}"
worktree_cwd="${AOA_WORKSPACE_CWD:?AOA_WORKSPACE_CWD is required}"
paperclip_home="${AOA_HOME:-$HOME/.aoa}"
paperclip_instance_id="${AOA_INSTANCE_ID:-default}"
paperclip_dir="$worktree_cwd/.aoa"
worktree_config_path="$paperclip_dir/config.json"
worktree_env_path="$paperclip_dir/.env"
worktree_name="${AOA_WORKSPACE_BRANCH:-$(basename "$worktree_cwd")}"

if [[ ! -d "$base_cwd" ]]; then
  echo "Base workspace does not exist: $base_cwd" >&2
  exit 1
fi

if [[ ! -d "$worktree_cwd" ]]; then
  echo "Derived worktree does not exist: $worktree_cwd" >&2
  exit 1
fi

source_config_path="${AOA_CONFIG:-}"
if [[ -z "$source_config_path" && ( -e "$base_cwd/.aoa/config.json" || -L "$base_cwd/.aoa/config.json" ) ]]; then
  source_config_path="$base_cwd/.aoa/config.json"
fi
if [[ -z "$source_config_path" ]]; then
  source_config_path="$paperclip_home/instances/$paperclip_instance_id/config.json"
fi
source_env_path="$(dirname "$source_config_path")/.env"

mkdir -p "$paperclip_dir"

run_isolated_worktree_init() {
  if command -v pnpm >/dev/null 2>&1 && pnpm aoa --help >/dev/null 2>&1; then
    pnpm aoa worktree init --force --seed-mode minimal --name "$worktree_name" --from-config "$source_config_path"
    return 0
  fi

  if command -v aoa >/dev/null 2>&1; then
    aoa worktree init --force --seed-mode minimal --name "$worktree_name" --from-config "$source_config_path"
    return 0
  fi

  return 1
}

write_fallback_worktree_config() {
  WORKTREE_NAME="$worktree_name" \
  BASE_CWD="$base_cwd" \
  WORKTREE_CWD="$worktree_cwd" \
  AOA_DIR="$paperclip_dir" \
  SOURCE_CONFIG_PATH="$source_config_path" \
  SOURCE_ENV_PATH="$source_env_path" \
  AOA_WORKTREES_DIR="${AOA_WORKTREES_DIR:-}" \
  node <<'EOF'
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");

function expandHomePrefix(value) {
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.resolve(os.homedir(), value.slice(2));
  return value;
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function sanitizeInstanceId(value) {
  const trimmed = String(value ?? "").trim().toLowerCase();
  const normalized = trimmed
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  return normalized || "worktree";
}

function parseEnvFile(contents) {
  const entries = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = rawLine.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    const value = rawValue.trim();
    if (!value) {
      entries[key] = "";
      continue;
    }
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      entries[key] = value.slice(1, -1);
      continue;
    }
    entries[key] = value.replace(/\s+#.*$/, "").trim();
  }
  return entries;
}

async function findAvailablePort(preferredPort, reserved = new Set()) {
  const startPort = Number.isFinite(preferredPort) && preferredPort > 0 ? Math.trunc(preferredPort) : 0;
  if (startPort > 0) {
    for (let port = startPort; port < startPort + 100; port += 1) {
      if (reserved.has(port)) continue;
      const available = await new Promise((resolve) => {
        const server = net.createServer();
        server.unref();
        server.once("error", () => resolve(false));
        server.listen(port, "127.0.0.1", () => {
          server.close(() => resolve(true));
        });
      });
      if (available) return port;
    }
  }

  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate a port.")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

function rewriteLocalUrlPort(rawUrl, newPort) {
  if (!rawUrl) return rawUrl;
  let parsed;
  try { parsed = new URL(rawUrl); } catch { return rawUrl; }
  if (!parsed.port) return rawUrl;
  parsed.port = String(newPort);
  return parsed.toString();
}

function resolveRuntimeLikePath(value, configPath) {
  const expanded = expandHomePrefix(value);
  if (path.isAbsolute(expanded)) return expanded;
  return path.resolve(path.dirname(configPath), expanded);
}

async function main() {
  const worktreeName = process.env.WORKTREE_NAME;
  const paperclipDir = process.env.AOA_DIR;
  const sourceConfigPath = process.env.SOURCE_CONFIG_PATH;
  const sourceEnvPath = process.env.SOURCE_ENV_PATH;
  const worktreeHome = path.resolve(expandHomePrefix(nonEmpty(process.env.AOA_WORKTREES_DIR) ?? "~/.aoa-worktrees"));
  const instanceId = sanitizeInstanceId(worktreeName);
  const instanceRoot = path.resolve(worktreeHome, "instances", instanceId);
  const configPath = path.resolve(paperclipDir, "config.json");
  const envPath = path.resolve(paperclipDir, ".env");

  let sourceConfig = null;
  if (sourceConfigPath && fs.existsSync(sourceConfigPath)) {
    sourceConfig = JSON.parse(fs.readFileSync(sourceConfigPath, "utf8"));
  }

  const sourceEnvEntries =
    sourceEnvPath && fs.existsSync(sourceEnvPath)
      ? parseEnvFile(fs.readFileSync(sourceEnvPath, "utf8"))
      : {};

  const preferredServerPort = Number(sourceConfig?.server?.port ?? 3101) + 1;
  const serverPort = await findAvailablePort(preferredServerPort);
  const preferredDbPort = Number(sourceConfig?.database?.embeddedPostgresPort ?? 54329) + 1;
  const databasePort = await findAvailablePort(preferredDbPort, new Set([serverPort]));

  fs.rmSync(configPath, { force: true });
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.mkdirSync(instanceRoot, { recursive: true });

  const authPublicBaseUrl = rewriteLocalUrlPort(sourceConfig?.auth?.publicBaseUrl, serverPort);
  const targetConfig = {
    $meta: {
      version: 1,
      updatedAt: new Date().toISOString(),
      source: "configure",
    },
    ...(sourceConfig?.llm ? { llm: sourceConfig.llm } : {}),
    database: {
      mode: "embedded-postgres",
      embeddedPostgresDataDir: path.resolve(instanceRoot, "db"),
      embeddedPostgresPort: databasePort,
      backup: {
        enabled: sourceConfig?.database?.backup?.enabled ?? true,
        intervalMinutes: sourceConfig?.database?.backup?.intervalMinutes ?? 60,
        retentionDays: sourceConfig?.database?.backup?.retentionDays ?? 30,
        dir: path.resolve(instanceRoot, "data", "backups"),
      },
    },
    logging: {
      mode: sourceConfig?.logging?.mode ?? "file",
      logDir: path.resolve(instanceRoot, "logs"),
    },
    server: {
      deploymentMode: sourceConfig?.server?.deploymentMode ?? "local_trusted",
      exposure: sourceConfig?.server?.exposure ?? "private",
      host: sourceConfig?.server?.host ?? "127.0.0.1",
      port: serverPort,
      allowedHostnames: sourceConfig?.server?.allowedHostnames ?? [],
      serveUi: sourceConfig?.server?.serveUi ?? true,
    },
    auth: {
      baseUrlMode: sourceConfig?.auth?.baseUrlMode ?? "auto",
      ...(authPublicBaseUrl ? { publicBaseUrl: authPublicBaseUrl } : {}),
      disableSignUp: sourceConfig?.auth?.disableSignUp ?? false,
    },
    storage: {
      provider: sourceConfig?.storage?.provider ?? "local_disk",
      localDisk: {
        baseDir: path.resolve(instanceRoot, "data", "storage"),
      },
      s3: {
        bucket: sourceConfig?.storage?.s3?.bucket ?? "paperclip",
        region: sourceConfig?.storage?.s3?.region ?? "us-east-1",
        endpoint: sourceConfig?.storage?.s3?.endpoint,
        prefix: sourceConfig?.storage?.s3?.prefix ?? "",
        forcePathStyle: sourceConfig?.storage?.s3?.forcePathStyle ?? false,
      },
    },
    secrets: {
      provider: sourceConfig?.secrets?.provider ?? "local_encrypted",
      strictMode: sourceConfig?.secrets?.strictMode ?? false,
      localEncrypted: {
        keyFilePath: path.resolve(instanceRoot, "secrets", "master.key"),
      },
    },
  };

  fs.writeFileSync(configPath, `${JSON.stringify(targetConfig, null, 2)}\n`, { mode: 0o600 });

  const inlineMasterKey = nonEmpty(sourceEnvEntries.AOA_SECRETS_MASTER_KEY);
  if (inlineMasterKey) {
    fs.mkdirSync(path.resolve(instanceRoot, "secrets"), { recursive: true });
    fs.writeFileSync(targetConfig.secrets.localEncrypted.keyFilePath, inlineMasterKey, {
      encoding: "utf8",
      mode: 0o600,
    });
  } else {
    const sourceKeyFilePath = nonEmpty(sourceEnvEntries.AOA_SECRETS_MASTER_KEY_FILE)
      ? resolveRuntimeLikePath(sourceEnvEntries.AOA_SECRETS_MASTER_KEY_FILE, sourceConfigPath)
      : nonEmpty(sourceConfig?.secrets?.localEncrypted?.keyFilePath)
        ? resolveRuntimeLikePath(sourceConfig.secrets.localEncrypted.keyFilePath, sourceConfigPath)
        : null;

    if (sourceKeyFilePath && fs.existsSync(sourceKeyFilePath)) {
      fs.mkdirSync(path.resolve(instanceRoot, "secrets"), { recursive: true });
      fs.copyFileSync(sourceKeyFilePath, targetConfig.secrets.localEncrypted.keyFilePath);
      fs.chmodSync(targetConfig.secrets.localEncrypted.keyFilePath, 0o600);
    }
  }

  const envLines = [
    "AOA_HOME=" + JSON.stringify(worktreeHome),
    "AOA_INSTANCE_ID=" + JSON.stringify(instanceId),
    "AOA_CONFIG=" + JSON.stringify(configPath),
    "AOA_CONTEXT=" + JSON.stringify(path.resolve(worktreeHome, "context.json")),
    "AOA_IN_WORKTREE=true",
    "AOA_WORKTREE_NAME=" + JSON.stringify(worktreeName),
  ];

  const agentJwtSecret = nonEmpty(sourceEnvEntries.AOA_AGENT_JWT_SECRET);
  if (agentJwtSecret) {
    envLines.push("AOA_AGENT_JWT_SECRET=" + JSON.stringify(agentJwtSecret));
  }

  fs.writeFileSync(envPath, `${envLines.join("\n")}\n`, { mode: 0o600 });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
EOF
}

if ! run_isolated_worktree_init; then
  echo "aoa CLI not available in this workspace; writing isolated fallback config without DB seeding." >&2
  write_fallback_worktree_config
fi

while IFS= read -r relative_path; do
  [[ -n "$relative_path" ]] || continue
  source_path="$base_cwd/$relative_path"
  target_path="$worktree_cwd/$relative_path"

  [[ -d "$source_path" ]] || continue
  [[ -e "$target_path" || -L "$target_path" ]] && continue

  mkdir -p "$(dirname "$target_path")"
  ln -s "$source_path" "$target_path"
done < <(
  cd "$base_cwd" &&
    find . \
      -mindepth 1 \
      -maxdepth 3 \
      -type d \
      -name node_modules \
      ! -path './.git/*' \
      ! -path './.aoa/*' \
      | sed 's#^\./##'
)
