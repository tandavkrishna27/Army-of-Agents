import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerMarketplaceCommands } from "../commands/client/marketplace.js";

const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const ORIGINAL_ENV = { ...process.env };

function successBody(operationId: string) {
  return {
    ok: true,
    operationId,
    executionDisposition: "started",
    replayed: false,
    status: "success",
    repairs: {
      crewCompaniesRepaired: 0,
      legacyStewardsAdopted: 0,
      teamsReconciled: 0,
      teamMembersAdded: 0,
    },
    catalog: {
      generatedAt: "2026-07-28T00:00:00.000Z",
      canonicalDigestSha256: "a".repeat(64),
      schemaVersion: "1.0.0",
      itemCount: 0,
      source: "cdn",
    },
    companiesExamined: 0,
    crewRepair: {
      catalogReady: true,
      inspected: 0,
      repaired: 0,
      skippedFailClosed: 0,
      skippedCooldown: 0,
      skippedOverBudget: 0,
      failed: 0,
    },
    legacySteward: {
      disabled: false,
      catalogReady: true,
      inspected: 0,
      adopted: 0,
      skippedOverBudget: 0,
      failed: 0,
    },
    crewUpdates: { succeeded: 0, failed: 0 },
    teamReconcile: { teamsReconciled: 0, membersAdded: 0 },
    skips: [],
    diagnostics: [],
    failures: [],
  };
}

function program(): Command {
  const root = new Command();
  root.exitOverride();
  registerMarketplaceCommands(root);
  return root;
}

function makeExitThrow(): void {
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${code ?? 0}`);
  }) as typeof process.exit);
}

describe("marketplace recovery CLI", () => {
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      AOA_API_URL: "https://testing.armyofagents.org",
      AOA_API_KEY: "board-key-secret",
    };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("prints the UUID first, sends the strict body, and never prints the key", async () => {
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => {
      output.push(String(value));
    });
    const progress: string[] = [];
    vi.spyOn(console, "error").mockImplementation((value) => {
      progress.push(String(value));
    });
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body).toEqual({
        scope: "fleet",
        mode: "repair",
        operationId: expect.any(String),
      });
      const headers = init.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer board-key-secret");
      return new Response(JSON.stringify(successBody(body.operationId)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await program().parseAsync([
      "node",
      "aoa",
      "marketplace",
      "reconcile",
      "--confirm-fleet",
      "--timeout-ms",
      "300000",
      "--json",
    ]);

    const first = JSON.parse(progress[0]!);
    expect(first).toMatchObject({
      operationId: expect.any(String),
      phase: "started",
    });
    expect(JSON.parse(output[0]!).operationId).toBe(first.operationId);
    expect([...progress, ...output].join("\n")).not.toContain("board-key-secret");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("links a retry to the explicitly inspected predecessor", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = vi.fn(
      async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        expect(body).toEqual({
          scope: "fleet",
          mode: "repair",
          operationId: expect.any(String),
          retryOfOperationId: OPERATION_ID,
        });
        expect(body.operationId).not.toBe(OPERATION_ID);
        return new Response(
          JSON.stringify(successBody(body.operationId)),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    await program().parseAsync([
      "node",
      "aoa",
      "marketplace",
      "reconcile",
      "--confirm-fleet",
      "--retry-of",
      OPERATION_ID,
      "--json",
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("schema-checks and prints durable inspection JSON", async () => {
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => {
      output.push(String(value));
    });
    const inspection = {
      operationId: OPERATION_ID,
      state: "running",
      startedAt: "2026-07-28T00:00:00.000Z",
      completedAt: null,
      deploymentSha: "reviewed-sha",
      targetCount: 0,
      targets: [],
      safeToRetry: false,
      retry: {
        kind: "inspect_first",
        recoveryCode: "inspect_operation",
        message: "Inspect the active operation before retrying.",
      },
    };
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify(inspection), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await program().parseAsync([
      "node",
      "aoa",
      "marketplace",
      "inspect",
      OPERATION_ID,
      "--json",
    ]);

    expect(JSON.parse(output[0]!)).toEqual(inspection);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(OPERATION_ID);
  });

  it("requires explicit fleet confirmation before generating or sending an operation", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => {
      output.push(String(value));
    });
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((value) => {
      errors.push(String(value));
    });
    makeExitThrow();

    await expect(
      program().parseAsync([
        "node",
        "aoa",
        "marketplace",
        "reconcile",
        "--json",
      ]),
    ).rejects.toThrow("process.exit:1");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(output).toEqual([]);
    expect(errors.join("\n")).toContain("--confirm-fleet is required");
  });

  it.each(["0", "not-a-number", "1800001"])(
    "rejects invalid timeout %s before generating or sending an operation",
    async (timeout) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const progress: string[] = [];
      vi.spyOn(console, "error").mockImplementation((value) => {
        progress.push(String(value));
      });
      makeExitThrow();

      await expect(
        program().parseAsync([
          "node",
          "aoa",
          "marketplace",
          "reconcile",
          "--confirm-fleet",
          "--timeout-ms",
          timeout,
          "--json",
        ]),
      ).rejects.toThrow("process.exit:1");

      expect(fetchMock).not.toHaveBeenCalled();
      expect(progress.join("\n")).toContain(
        "--timeout-ms must be an integer from 1 to 1800000",
      );
      expect(progress.join("\n")).not.toContain('"phase":"started"');
    },
  );

  it("prints the operation ID and directs a local timeout to inspection", async () => {
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => {
      output.push(String(value));
    });
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((value) => {
      errors.push(String(value));
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const error = new Error("local deadline");
        error.name = "TimeoutError";
        throw error;
      }),
    );
    makeExitThrow();

    await expect(
      program().parseAsync([
        "node",
        "aoa",
        "marketplace",
        "reconcile",
        "--confirm-fleet",
        "--json",
      ]),
    ).rejects.toThrow("process.exit:1");

    const operationId = JSON.parse(errors[0]!).operationId;
    expect(operationId).toEqual(expect.any(String));
    expect(errors.join("\n")).toContain(
      `aoa marketplace inspect ${operationId}`,
    );
    expect(errors.join("\n")).toContain("Do not retry");
    expect(errors.join("\n")).not.toContain("board-key-secret");
  });

  it("schema-checks a typed endpoint error before rendering recovery", async () => {
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => {
      output.push(String(value));
    });
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((value) => {
      errors.push(String(value));
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const operationId = JSON.parse(String(init?.body)).operationId;
        return new Response(
          JSON.stringify({
            ok: false,
            error: {
              code: "operation_in_flight",
              message: "Another marketplace reconciliation is already running.",
            },
            operationId,
            retry: {
              kind: "inspect_first",
              recoveryCode: "inspect_operation",
              message: "Inspect the active operation before starting another.",
            },
            docUrl: "/docs/guides/board-operator/marketplace-recovery",
          }),
          {
            status: 409,
            headers: { "content-type": "application/json" },
          },
        );
      }),
    );
    makeExitThrow();

    await expect(
      program().parseAsync([
        "node",
        "aoa",
        "marketplace",
        "reconcile",
        "--confirm-fleet",
        "--json",
      ]),
    ).rejects.toThrow("process.exit:1");

    expect(JSON.parse(output[0]!)).toMatchObject({
      ok: false,
      error: { code: "operation_in_flight" },
      retry: { recoveryCode: "inspect_operation" },
    });
    expect(errors.join("\n")).toContain(
      "operation_in_flight: Another marketplace reconciliation is already running.",
    );
  });

  it("fails closed when a successful endpoint response violates the schema", async () => {
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => {
      output.push(String(value));
    });
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((value) => {
      errors.push(String(value));
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: true, operationId: OPERATION_ID }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    makeExitThrow();

    await expect(
      program().parseAsync([
        "node",
        "aoa",
        "marketplace",
        "reconcile",
        "--confirm-fleet",
        "--json",
      ]),
    ).rejects.toThrow("process.exit:1");

    expect(output).toEqual([]);
    expect(errors.join("\n")).toMatch(/invalid_type|Invalid input|expected/i);
    expect(errors.join("\n")).not.toContain("board-key-secret");
  });
});
