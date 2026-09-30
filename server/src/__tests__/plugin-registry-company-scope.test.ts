import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Db } from "@armyofagents/db";
import { pluginRegistryService } from "../services/plugin-registry.js";
import { PLUGIN_WORKER_BLOCKED_IN_CLOUD_REASON } from "@armyofagents/shared";

const dialect = new PgDialect();

function capturingDb(rows: unknown[] = []) {
  const captured: Array<{ whereSql: string | null }> = [];
  const db = {
    select() {
      const record = { whereSql: null as string | null };
      captured.push(record);
      const resolved = Promise.resolve(rows);
      const chain: Record<string, any> = {
        from() {
          return chain;
        },
        where(condition: unknown) {
          record.whereSql =
            condition == null
              ? null
              : dialect.sqlToQuery(condition as never).sql;
          return chain;
        },
        orderBy() {
          return chain;
        },
        then(
          onFulfilled: (value: unknown[]) => unknown,
          onRejected?: (reason: unknown) => unknown
        ) {
          return resolved.then(onFulfilled, onRejected);
        },
      };
      return chain;
    },
  } as unknown as Db;
  return { db, captured };
}

describe("plugin registry company-scope pushdown", () => {
  it("short-circuits an empty company set without querying", async () => {
    const { db, captured } = capturingDb();

    await expect(
      pluginRegistryService(db).listInstalledForCompanies([])
    ).resolves.toEqual([]);

    expect(captured).toHaveLength(0);
  });

  it("pushes the accessible company set into installed-list SQL", async () => {
    const { db, captured } = capturingDb();

    await pluginRegistryService(db).listInstalledForCompanies([
      "company-a",
      "company-b",
    ]);

    expect(captured[0]?.whereSql).toContain('"plugins"."company_id" in (');
    expect(captured[0]?.whereSql).toContain('"plugins"."status" <>');
  });

  it("pushes both company and lifecycle status into filtered-list SQL", async () => {
    const { db, captured } = capturingDb();

    await pluginRegistryService(db).listByStatusForCompanies("ready", [
      "company-a",
    ]);

    expect(captured[0]?.whereSql).toContain('"plugins"."company_id" in (');
    expect(captured[0]?.whereSql).toContain('"plugins"."status" =');
  });

  it("preserves the unscoped self-hosted query without a company predicate", async () => {
    const { db, captured } = capturingDb();

    await pluginRegistryService(db).listInstalledForCompanies(undefined);

    expect(captured[0]?.whereSql).toContain('"plugins"."status" <>');
    expect(captured[0]?.whereSql).not.toContain('"plugins"."company_id" in (');
  });
});

function statusDb() {
  const plugin = { id: "plugin-a", status: "error" };
  const writes: Array<Record<string, unknown>> = [];
  const db = {
    select() {
      const promise = Promise.resolve([plugin]);
      const chain: Record<string, any> = {
        from() {
          return chain;
        },
        where() {
          return chain;
        },
        then(
          resolve: (rows: unknown[]) => unknown,
          reject?: (reason: unknown) => unknown
        ) {
          return promise.then(resolve, reject);
        },
      };
      return chain;
    },
    update() {
      let values: Record<string, unknown> = {};
      const chain = {
        set(input: Record<string, unknown>) {
          values = input;
          writes.push(input);
          return chain;
        },
        where() {
          return chain;
        },
        returning() {
          return Promise.resolve([{ ...plugin, ...values }]);
        },
      };
      return chain;
    },
  } as unknown as Db;
  return { db, writes };
}

describe("plugin registry atomic status fields", () => {
  it("persists the cloud reason with the error diagnostic in one write", async () => {
    const { db, writes } = statusDb();
    await pluginRegistryService(db).updateStatus("plugin-a", {
      status: "error",
      lastError: "blocked",
      statusReasonCode: PLUGIN_WORKER_BLOCKED_IN_CLOUD_REASON,
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      status: "error",
      lastError: "blocked",
      statusReasonCode: PLUGIN_WORKER_BLOCKED_IN_CLOUD_REASON,
    });
  });

  it("clears stale diagnostics and reasons on a successful transition", async () => {
    const { db, writes } = statusDb();
    await pluginRegistryService(db).updateStatus("plugin-a", {
      status: "ready",
      lastError: "must be ignored",
      statusReasonCode: PLUGIN_WORKER_BLOCKED_IN_CLOUD_REASON,
    });

    expect(writes[0]).toMatchObject({
      status: "ready",
      lastError: null,
      statusReasonCode: null,
    });
  });

  it("preserves an operator-provided disable reason without a policy code", async () => {
    const { db, writes } = statusDb();
    await pluginRegistryService(db).updateStatus("plugin-a", {
      status: "disabled",
      lastError: "maintenance window",
      statusReasonCode: PLUGIN_WORKER_BLOCKED_IN_CLOUD_REASON,
    });

    expect(writes[0]).toMatchObject({
      status: "disabled",
      lastError: "maintenance window",
      statusReasonCode: null,
    });
  });

  it("uses a null structured reason for generic errors", async () => {
    const { db, writes } = statusDb();
    await pluginRegistryService(db).updateStatus("plugin-a", {
      status: "error",
      lastError: "ordinary crash",
    });

    expect(writes[0]).toMatchObject({
      status: "error",
      lastError: "ordinary crash",
      statusReasonCode: null,
    });
  });
});
