import * as p from "@clack/prompts";
import pc from "picocolors";
import { runDatabaseRestore } from "@armyofagents/db";
import { readConfig, resolveConfigPath } from "../config/store.js";
import { printAoaCliBanner } from "../utils/banner.js";
import { resolveRestoreBackupFile } from "./db-restore-input.js";

type DbRestoreOptions = {
  config?: string;
  file?: string;
};

// Each `db:*` command self-contains its connection resolution (mirrors db-backup.ts).
function resolveConnectionString(configPath?: string): { value: string; source: string } {
  const envUrl = process.env.DATABASE_URL?.trim();
  if (envUrl) return { value: envUrl, source: "DATABASE_URL" };

  const config = readConfig(configPath);
  if (config?.database.mode === "postgres" && config.database.connectionString?.trim()) {
    return { value: config.database.connectionString.trim(), source: "config.database.connectionString" };
  }

  const port = config?.database.embeddedPostgresPort ?? 54329;
  return {
    value: `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`,
    source: `embedded-postgres@${port}`,
  };
}

export async function dbRestoreCommand(opts: DbRestoreOptions): Promise<void> {
  printAoaCliBanner();
  p.intro(pc.bgYellow(pc.black(" aoa db:restore ")));

  const configPath = resolveConfigPath(opts.config);
  const connection = resolveConnectionString(opts.config);
  const backupFile = resolveRestoreBackupFile(opts.file);

  p.log.message(pc.dim(`Config: ${configPath}`));
  p.log.message(pc.dim(`Connection source: ${connection.source}`));
  p.log.message(pc.dim(`Restore from: ${backupFile}`));
  p.log.message(pc.yellow("Restore OVERWRITES the target database's schema and data."));

  const spinner = p.spinner();
  spinner.start("Restoring database from backup...");
  try {
    await runDatabaseRestore({ connectionString: connection.value, backupFile });
    spinner.stop("Database restored.");
    p.outro(pc.green("Restore completed."));
  } catch (err) {
    spinner.stop(pc.red("Restore failed."));
    throw err;
  }
}
