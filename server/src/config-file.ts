import fs from "node:fs";
import { paperclipConfigSchema, type AoaConfig } from "@armyofagents/shared";
import { resolveAoaConfigPath } from "./paths.js";

export function readConfigFile(): AoaConfig | null {
  const configPath = resolveAoaConfigPath();

  if (!fs.existsSync(configPath)) return null;

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return paperclipConfigSchema.parse(raw);
  } catch {
    return null;
  }
}
