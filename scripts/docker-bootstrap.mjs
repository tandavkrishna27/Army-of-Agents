import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const logPrefix = "[docker-bootstrap]";

function clean(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function env(name, fallback = null) {
  return clean(process.env[name]) ?? fallback;
}

function firstEnv(names) {
  for (const name of names) {
    const value = env(name);
    if (value) {
      return value;
    }
  }
  return null;
}

function boolEnv(name, fallback) {
  const value = env(name);
  if (!value) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function intEnv(name, fallback) {
  const value = Number.parseInt(env(name) ?? "", 10);
  return Number.isFinite(value) ? value : fallback;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function normalizeEnvValue(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function readEnvValue(lines, key) {
  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = lines[index].match(pattern);
    if (match) {
      return normalizeEnvValue(match[1]);
    }
  }
  return null;
}

function setEnvValue(lines, key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^\\s*${key}\\s*=`);
  const index = lines.findIndex((candidate) => pattern.test(candidate));
  if (index >= 0) {
    lines[index] = line;
  } else {
    lines.push(line);
  }
}

function randomSecret() {
  return randomBytes(32).toString("hex");
}

function ensureSecret(lines, key, changed) {
  const fromProcess = env(key);
  const fromFile = clean(readEnvValue(lines, key));

  if (fromProcess) {
    if (!fromFile) {
      setEnvValue(lines, key, fromProcess);
      changed.value = true;
    }
    process.env[key] = fromProcess;
    return fromProcess;
  }

  if (fromFile) {
    process.env[key] = fromFile;
    return fromFile;
  }

  const generated = randomSecret();
  setEnvValue(lines, key, generated);
  changed.value = true;
  process.env[key] = generated;
  console.log(`${logPrefix} generated ${key} in the instance .env file`);
  return generated;
}

function hostFromUrl(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

const aoaHome = env("AOA_HOME", "/aoa");
const instanceId = env("AOA_INSTANCE_ID", "default");
const configPath = env(
  "AOA_CONFIG",
  path.join(aoaHome, "instances", instanceId, "config.json"),
);
const configDir = path.dirname(configPath);
const envPath = path.join(configDir, ".env");

process.env.AOA_HOME = aoaHome;
process.env.AOA_INSTANCE_ID = instanceId;
process.env.AOA_CONFIG = configPath;

ensureDir(aoaHome);
ensureDir(path.join(aoaHome, "instances"));
ensureDir(configDir);
ensureDir(path.join(configDir, "data", "storage"));
ensureDir(path.join(configDir, "data", "backups"));
ensureDir(path.join(configDir, "logs"));
ensureDir(path.join(configDir, "secrets"));
ensureDir(path.join(configDir, "workspaces"));

const envLines = fs.existsSync(envPath)
  ? fs.readFileSync(envPath, "utf8").split(/\r?\n/).filter(Boolean)
  : [
      "# AoA Docker instance environment",
      "# Generated on first container startup. Keep this file private.",
    ];
const envChanged = { value: false };
ensureSecret(envLines, "BETTER_AUTH_SECRET", envChanged);
ensureSecret(envLines, "AOA_AGENT_JWT_SECRET", envChanged);

if (envChanged.value || !fs.existsSync(envPath)) {
  fs.writeFileSync(envPath, `${envLines.join("\n")}\n`, { mode: 0o600 });
  fs.chmodSync(envPath, 0o600);
}

if (!fs.existsSync(configPath)) {
  const databaseUrl = env("DATABASE_URL");
  const publicBaseUrl = firstEnv([
    "AOA_AUTH_PUBLIC_BASE_URL",
    "BETTER_AUTH_URL",
    "BETTER_AUTH_BASE_URL",
    "AOA_PUBLIC_URL",
  ]);
  const deploymentMode = env("AOA_DEPLOYMENT_MODE", "authenticated");
  const exposure = env("AOA_DEPLOYMENT_EXPOSURE", "private");

  if (deploymentMode !== "local_trusted" && exposure === "public" && !publicBaseUrl) {
    console.error(
      `${logPrefix} AOA_DEPLOYMENT_EXPOSURE=public requires AOA_PUBLIC_URL or AOA_AUTH_PUBLIC_BASE_URL.`,
    );
    process.exit(1);
  }

  const allowedHostnames = new Set(
    (env("AOA_ALLOWED_HOSTNAMES", "") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const publicHostname = publicBaseUrl ? hostFromUrl(publicBaseUrl) : null;
  if (publicHostname) {
    allowedHostnames.add(publicHostname);
  }

  const config = {
    $meta: {
      source: "onboard",
      version: 1,
      updatedAt: new Date().toISOString(),
    },
    database: {
      mode: databaseUrl ? "postgres" : "embedded-postgres",
      embeddedPostgresDataDir: env(
        "AOA_EMBEDDED_POSTGRES_DATA_DIR",
        path.join(configDir, "db"),
      ),
      embeddedPostgresPort: intEnv("AOA_EMBEDDED_POSTGRES_PORT", 54329),
      backup: {
        enabled: boolEnv("AOA_DB_BACKUP_ENABLED", true),
        dir: env("AOA_DB_BACKUP_DIR", path.join(configDir, "data", "backups")),
        retentionDays: intEnv("AOA_DB_BACKUP_RETENTION_DAYS", 7),
        intervalMinutes: intEnv("AOA_DB_BACKUP_INTERVAL_MINUTES", 60),
      },
    },
    logging: {
      mode: "file",
      logDir: env("AOA_LOG_DIR", path.join(configDir, "logs")),
    },
    server: {
      deploymentMode,
      exposure,
      host: env("HOST", "0.0.0.0"),
      port: intEnv("PORT", 3100),
      allowedHostnames: Array.from(allowedHostnames),
      serveUi: boolEnv("SERVE_UI", true),
    },
    auth: {
      baseUrlMode: env("AOA_AUTH_BASE_URL_MODE", publicBaseUrl ? "explicit" : "auto"),
    },
    storage: {
      provider: env("AOA_STORAGE_PROVIDER", "local_disk"),
      localDisk: {
        baseDir: env("AOA_STORAGE_LOCAL_DIR", path.join(configDir, "data", "storage")),
      },
      s3: {
        bucket: env("AOA_STORAGE_S3_BUCKET", "paperclip"),
        region: env("AOA_STORAGE_S3_REGION", "us-east-1"),
        endpoint: env("AOA_STORAGE_S3_ENDPOINT", ""),
        prefix: env("AOA_STORAGE_S3_PREFIX", ""),
        forcePathStyle: boolEnv("AOA_STORAGE_S3_FORCE_PATH_STYLE", false),
      },
    },
    secrets: {
      provider: env("AOA_SECRETS_PROVIDER", "local_encrypted"),
      strictMode: boolEnv("AOA_SECRETS_STRICT_MODE", false),
      localEncrypted: {
        keyFilePath: env(
          "AOA_SECRETS_MASTER_KEY_FILE",
          path.join(configDir, "secrets", "master.key"),
        ),
      },
    },
  };

  if (databaseUrl) {
    config.database.connectionString = databaseUrl;
  }
  if (publicBaseUrl) {
    config.auth.publicBaseUrl = publicBaseUrl;
  }

  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(configPath, 0o600);
  console.log(`${logPrefix} wrote first-run config to ${configPath}`);
}
