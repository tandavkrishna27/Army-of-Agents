import { DEPLOYMENT_MODES, type DeploymentMode } from "@armyofagents/shared";
import { applyPendingMigrations, inspectMigrations } from "./client.js";

function readDeploymentModeForMigration(): DeploymentMode | undefined {
  const raw = process.env.AOA_DEPLOYMENT_MODE ?? process.env.PAPERCLIP_DEPLOYMENT_MODE;
  if (raw === undefined || raw.trim() === "") return undefined;
  if (!DEPLOYMENT_MODES.includes(raw as DeploymentMode)) {
    throw new Error(
      `Invalid AOA_DEPLOYMENT_MODE '${raw}'. Expected one of: ${DEPLOYMENT_MODES.join(", ")}`,
    );
  }
  return raw as DeploymentMode;
}

const url = process.env.DATABASE_URL;

if (!url) {
  throw new Error("DATABASE_URL is required for db:migrate");
}

const before = await inspectMigrations(url);
if (before.status === "upToDate") {
  console.log("No pending migrations");
} else {
  console.log(`Applying ${before.pendingMigrations.length} pending migration(s)...`);
  await applyPendingMigrations(url, {
    deploymentMode: readDeploymentModeForMigration(),
  });

  const after = await inspectMigrations(url);
  if (after.status !== "upToDate") {
    throw new Error(`Migrations incomplete: ${after.pendingMigrations.join(", ")}`);
  }
  console.log("Migrations complete");
}
