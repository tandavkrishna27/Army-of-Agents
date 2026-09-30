import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openDistributedExecutionDatabases } from "../db/distributed-execution-databases.js";

type FinalStartupInput = {
  enabled: boolean;
  ownerDb: unknown;
  requiredMigrationIdentity: { orderedHashes: readonly string[]; ledgerSha256: string };
  appDatabaseUrl: string | undefined;
  operatorDatabaseUrl: string | undefined;
};

const openFinalStartup = openDistributedExecutionDatabases as unknown as (
  input: FinalStartupInput,
) => ReturnType<typeof openDistributedExecutionDatabases>;

const validMigrationIdentity = {
  orderedHashes: ["a".repeat(64)],
  ledgerSha256: createHash("sha256")
    .update(JSON.stringify(["a".repeat(64)]))
    .digest("hex"),
} as const;

function validOwnerDbFixture(): unknown {
  const receipt = [{
    hash: "b".repeat(64),
    participant_pids_gone: true,
    owner_out_of_transaction: true,
    advisory_locks_gone: true,
  }];
  const owner = {
    execute: async () => receipt,
    transaction: async (callback: (transaction: unknown) => unknown) => callback(owner),
    $client: { unsafe: async () => receipt },
  };
  return owner;
}

function startupInput(input: Pick<FinalStartupInput, "enabled" | "appDatabaseUrl" | "operatorDatabaseUrl">) {
  return {
    ...input,
    ownerDb: validOwnerDbFixture(),
    requiredMigrationIdentity: validMigrationIdentity,
  };
}

async function expectStableStartupFailure(
  input: FinalStartupInput,
  code: string,
  forbidden: readonly string[],
): Promise<void> {
  let failure: unknown;
  try {
    await openFinalStartup(input);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(failure).toMatchObject({
    name: "DistributedExecutionStartupError",
    message: code,
  });
  const serialized = [
    String(failure),
    (failure as { name?: unknown } | undefined)?.name,
    (failure as { message?: unknown } | undefined)?.message,
    JSON.stringify(failure),
  ].join("\n");
  for (const value of forbidden) expect(serialized).not.toContain(value);
}

describe("JOB-001 non-owner startup composition", () => {
  it("opens no E3 pool and requires no URL while the flag is off", async () => {
    await expect(openFinalStartup(startupInput({
      enabled: false,
      appDatabaseUrl: undefined,
      operatorDatabaseUrl: undefined,
    }))).resolves.toBeNull();
  });

  it.each([
    ["app", undefined, "postgres://operator-user:operator-secret@127.0.0.1/example"],
    ["app", "   ", "postgres://operator-user:operator-secret@127.0.0.1/example"],
    ["operator", "postgres://app-user:app-secret@127.0.0.1/example", undefined],
    ["operator", "postgres://app-user:app-secret@127.0.0.1/example", ""],
  ] as const)("preserves the exact configuration code for a blank %s URL", async (
    _role,
    appDatabaseUrl,
    operatorDatabaseUrl,
  ) => {
    await expectStableStartupFailure(startupInput({
      enabled: true,
      appDatabaseUrl,
      operatorDatabaseUrl,
    }), "distributed_execution_configuration", [
      "aoa_app",
      "aoa_operator",
      "app-secret",
      "operator-secret",
      "postgres://",
    ]);
  });

  it.each([
    ["missing owner", undefined, validMigrationIdentity],
    ["invalid owner", {}, validMigrationIdentity],
    ["missing identity", validOwnerDbFixture(), undefined],
    ["invalid identity", validOwnerDbFixture(), { orderedHashes: "not-an-array", ledgerSha256: 7 }],
  ] as const)("does not remap %s input from configuration to close", async (
    _caseName,
    ownerDb,
    requiredMigrationIdentity,
  ) => {
    await expectStableStartupFailure({
      enabled: true,
      ownerDb,
      requiredMigrationIdentity,
      appDatabaseUrl: "postgres://app-user:app-secret@127.0.0.1/example",
      operatorDatabaseUrl: "postgres://operator-user:operator-secret@127.0.0.1/example",
    } as unknown as FinalStartupInput, "distributed_execution_configuration", [
      "distributed_execution_close",
      "aoa_app",
      "aoa_operator",
      "app-secret",
      "operator-secret",
      "postgres://",
    ]);
  });

  it("passes only the verified aoa_app handle and flag into createApp", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../index.ts", import.meta.url)),
      "utf8",
    );
    expect(source).toMatch(/distributedExecutionEnabled:\s*config\.distributedExecutionEnabled/);
    expect(source).toMatch(/tenantAppDb:\s*distributedExecutionDatabases\?\.appDb/);
    expect(source).toMatch(/operatorDb:\s*distributedExecutionDatabases\?\.operatorDb/);
    expect(source).toMatch(/workerSessionSigningKey:\s*process\.env\.AOA_WORKER_SESSION_SIGNING_KEY/);
    expect(source).not.toMatch(/tenantAppDb:\s*db\b/);
    expect(source).toMatch(/ownerDb:\s*db\b/);
    expect(source).toMatch(/requiredMigrationIdentity/);
    expect(source).toMatch(/loadRequiredMigrationIdentity/);
  });

  it("keeps worker-control, leasing, metrics, scheduler, and outbox outside the flag-off import graph", () => {
    // Mutation caught: restoring any eager import makes flag-off allocate/probe the E3 runtime.
    const indexSource = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    const appSource = readFileSync(new URL("../app.ts", import.meta.url), "utf8");
    expect(indexSource).not.toMatch(/^import .*job-control-metrics/m);
    expect(indexSource).not.toMatch(/^import .*job-ready-scheduler/m);
    expect(indexSource).not.toMatch(/^import .*job-outbox-worker/m);
    expect(appSource).not.toMatch(/^import .*worker-control/m);
    expect(appSource).not.toMatch(/^import .*job-leasing/m);
    expect(appSource).not.toMatch(/^import .*job-control-metrics/m);
    expect(appSource).toMatch(/distributedExecutionEnabled[\s\S]*await import\([^)]*worker-control/);
  });
});
