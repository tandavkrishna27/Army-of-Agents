import { and, eq } from "drizzle-orm";
import { pluginCompanySettings, plugins, type Db } from "@armyofagents/db";
import type { WorkerToHostHandlers } from "./plugin-worker-manager.js";

/** Re-check mutable availability at a plugin execution boundary. */
export async function assertPluginRuntimeAvailable(
  db: Db,
  pluginId: string,
  expectedCompanyId?: string
): Promise<{ companyId: string }> {
  const [plugin] = await db
    .select({ companyId: plugins.companyId, status: plugins.status })
    .from(plugins)
    .where(eq(plugins.id, pluginId));
  if (
    !plugin ||
    plugin.status !== "ready" ||
    (expectedCompanyId !== undefined && plugin.companyId !== expectedCompanyId)
  ) {
    throw new Error("Plugin is not available");
  }

  const [settings] = await db
    .select({ enabled: pluginCompanySettings.enabled })
    .from(pluginCompanySettings)
    .where(
      and(
        eq(pluginCompanySettings.pluginId, pluginId),
        eq(pluginCompanySettings.companyId, plugin.companyId)
      )
    );
  if (settings?.enabled === false) {
    throw new Error("Plugin is disabled for this company");
  }
  return { companyId: plugin.companyId };
}

/** Guard every worker-to-host RPC, including handlers without company params. */
export function guardPluginHostHandlers(
  db: Db,
  pluginId: string,
  handlers: WorkerToHostHandlers
): WorkerToHostHandlers {
  return Object.fromEntries(
    Object.entries(handlers).map(([method, handler]) => [
      method,
      async (params: unknown) => {
        await assertPluginRuntimeAvailable(db, pluginId);
        return (handler as (value: unknown) => Promise<unknown>)(params);
      },
    ])
  ) as WorkerToHostHandlers;
}
