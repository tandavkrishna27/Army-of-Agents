import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import {
  MarketplaceReconcileErrorResponseSchema,
  MarketplaceReconcileRequestSchema,
  MarketplaceReconcileResponseSchema,
  MarketplaceReconciliationInspectionSchema,
} from "@armyofagents/shared";
import { ApiRequestError } from "../../client/http.js";
import {
  addCommonClientOptions,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface MarketplaceReconcileOptions extends BaseClientOptions {
  confirmFleet?: boolean;
  timeoutMs?: string;
  retryOf?: string;
}

function parseTimeout(value: string | undefined): number {
  const timeoutMs = Number(value ?? "300000");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1_800_000) {
    throw new Error("--timeout-ms must be an integer from 1 to 1800000");
  }
  return timeoutMs;
}

function printOperationStart(operationId: string, json: boolean): void {
  if (json) {
    console.error(JSON.stringify({ operationId, phase: "started" }));
  } else {
    console.error(`Marketplace reconciliation operation: ${operationId}`);
  }
}

function handleMarketplaceError(
  error: unknown,
  opts: { json: boolean; operationId: string },
): never {
  if (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  ) {
    throw new Error(
      `Operation ${opts.operationId} timed out locally. Do not retry it. Run ` +
        "`aoa marketplace inspect " +
        `${opts.operationId} --api-base <url> --json\` first.`,
    );
  }
  if (error instanceof ApiRequestError) {
    const parsed = MarketplaceReconcileErrorResponseSchema.safeParse(error.body);
    if (!parsed.success) {
      throw new Error(
        `Marketplace endpoint returned an invalid error contract (HTTP ${error.status})`,
      );
    }
    printOutput(parsed.data, { json: opts.json });
    throw new Error(
      `${parsed.data.error.code}: ${parsed.data.error.message} ` +
        `[recovery=${parsed.data.retry.recoveryCode}]`,
    );
  }
  throw error;
}

export function registerMarketplaceCommands(program: Command): void {
  const marketplace = program
    .command("marketplace")
    .description("Instance marketplace recovery utilities");

  addCommonClientOptions(
    marketplace
      .command("reconcile")
      .description("Run one guarded fleet marketplace reconciliation")
      .option(
        "--confirm-fleet",
        "Confirm that this operation may inspect and repair every company",
        false,
      )
      .option(
        "--timeout-ms <ms>",
        "Maximum local wait; timeout requires inspect, never an automatic retry",
        "300000",
      )
      .option(
        "--retry-of <operation-id>",
        "Retry the currently inspected outcome-unknown operation",
      )
      .action(async (opts: MarketplaceReconcileOptions) => {
        try {
          if (!opts.confirmFleet) {
            throw new Error(
              "--confirm-fleet is required for a fleet reconciliation",
            );
          }
          const timeoutMs = parseTimeout(opts.timeoutMs);
          const ctx = resolveCommandContext(opts);
          const operationId = randomUUID();
          const request = MarketplaceReconcileRequestSchema.parse({
            scope: "fleet",
            mode: "repair",
            operationId,
            ...(opts.retryOf
              ? { retryOfOperationId: opts.retryOf }
              : {}),
          });
          printOperationStart(operationId, ctx.json);
          try {
            const response = await ctx.api.post(
              "/api/admin/marketplace/reconcile",
              request,
              { timeoutMs },
            );
            const parsed = MarketplaceReconcileResponseSchema.parse(response);
            printOutput(parsed, { json: ctx.json });
          } catch (error) {
            handleMarketplaceError(error, {
              json: ctx.json,
              operationId,
            });
          }
        } catch (error) {
          handleCommandError(error);
        }
      }),
  );

  addCommonClientOptions(
    marketplace
      .command("inspect")
      .description("Inspect a durable marketplace reconciliation operation")
      .argument("<operation-id>", "Reconciliation operation UUID")
      .action(async (operationId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          try {
            const response = await ctx.api.get(
              `/api/admin/marketplace/reconciliations/${encodeURIComponent(operationId)}`,
            );
            const parsed =
              MarketplaceReconciliationInspectionSchema.parse(response);
            printOutput(parsed, { json: ctx.json });
          } catch (error) {
            handleMarketplaceError(error, {
              json: ctx.json,
              operationId,
            });
          }
        } catch (error) {
          handleCommandError(error);
        }
      }),
  );
}
