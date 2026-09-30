/**
 * U6.6 — preview URLs via E2B `getHost(port)` -> task_outputs.
 *
 * Two layers, mirroring sandbox-file-movement-diff.test.ts (pure resolver,
 * hand-built runner double) and crew-output-capture.test.ts (DB-touching
 * emitter, module-mocked `taskOutputService`):
 *
 *  - `resolveSandboxPreviewUrl` (sandbox-file-movement.ts): pure, no DB.
 *    Asserts the URL is derived SOLELY from `runner.resolveHost` — never a
 *    host-loopback/internal address.
 *  - `emitSandboxPreviewTaskOutput` (task-output-emitters.ts): drives the
 *    resolver + upserts a `task_outputs` row of `type: "preview_url"`,
 *    asserted against a stubbed `taskOutputService` (module-mocked, same
 *    pattern as crew-output-capture.test.ts and task-output-emitters.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxFileMovementRunner } from "../services/sandbox-file-movement.js";

describe("resolveSandboxPreviewUrl (U6.6)", () => {
  it("returns https://<getHost> derived solely from runner.resolveHost", async () => {
    const { resolveSandboxPreviewUrl } = await import("../services/sandbox-file-movement.js");
    const calls: Array<{ port: number }> = [];
    const runner: SandboxFileMovementRunner = {
      async execute() {
        throw new Error("not exercised by resolveSandboxPreviewUrl");
      },
      async writeFiles() {
        throw new Error("not exercised by resolveSandboxPreviewUrl");
      },
      async resolveHost(input) {
        calls.push(input);
        return "3000-fakesandbox.e2b.app";
      },
    };

    const url = await resolveSandboxPreviewUrl({ runner, port: 3000 });

    expect(url).toBe("https://3000-fakesandbox.e2b.app");
    expect(calls).toEqual([{ port: 3000 }]);

    // SECURITY: the URL comes SOLELY from getHost, never the control-plane
    // host / an internal IP.
    expect(url).not.toMatch(/127\.0\.0\.1|localhost|internal/);
  });

  it("throws a clear, named error when the runner does not support resolveHost", async () => {
    const { resolveSandboxPreviewUrl } = await import("../services/sandbox-file-movement.js");
    const runner: SandboxFileMovementRunner = {
      async execute() {
        throw new Error("not exercised");
      },
      async writeFiles() {
        throw new Error("not exercised");
      },
      // resolveHost intentionally omitted.
    };

    await expect(resolveSandboxPreviewUrl({ runner, port: 3000 })).rejects.toThrow(
      /resolveSandboxPreviewUrl: runner does not support resolveHost/,
    );
  });
});

const mocks = vi.hoisted(() => ({
  upsertForIssue: vi.fn(
    async (companyId: string, issueId: string, input: Record<string, unknown>) => ({
      id: "output-1",
      companyId,
      issueId,
      ...input,
    }),
  ),
}));

vi.mock("../services/task-outputs.js", () => ({
  taskOutputService: () => ({ upsertForIssue: mocks.upsertForIssue }),
}));

describe("emitSandboxPreviewTaskOutput (U6.6)", () => {
  beforeEach(() => {
    mocks.upsertForIssue.mockClear();
  });

  it("upserts a preview_url task_output whose url is the resolved https://<getHost> URL", async () => {
    const { emitSandboxPreviewTaskOutput } = await import("../services/task-output-emitters.js");
    const runner: SandboxFileMovementRunner = {
      async execute() {
        throw new Error("not exercised");
      },
      async writeFiles() {
        throw new Error("not exercised");
      },
      async resolveHost({ port }) {
        return `${port}-fakesandbox.e2b.app`;
      },
    };

    const result = await emitSandboxPreviewTaskOutput({} as never, {
      companyId: "company-1",
      issueId: "issue-1",
      executionWorkspaceId: "workspace-1",
      runner,
      port: 3000,
      createdByRunId: "run-1",
      createdByAgentId: "agent-1",
    });

    expect(mocks.upsertForIssue).toHaveBeenCalledTimes(1);
    expect(mocks.upsertForIssue).toHaveBeenCalledWith(
      "company-1",
      "issue-1",
      expect.objectContaining({
        type: "preview_url",
        provider: "aoa",
        url: "https://3000-fakesandbox.e2b.app",
        title: "Preview",
        status: "active",
        reviewState: "none",
        isPrimary: false,
        healthStatus: "unknown",
        executionWorkspaceId: "workspace-1",
        createdByRunId: "run-1",
        createdByAgentId: "agent-1",
      }),
    );
    expect(result).not.toBeNull();

    // SECURITY: same invariant as the resolver itself — the persisted URL
    // never regresses to a host-loopback/internal address.
    const [, , upsertInput] = mocks.upsertForIssue.mock.calls[0] as [
      string,
      string,
      { url?: string },
    ];
    expect(upsertInput.url).not.toMatch(/127\.0\.0\.1|localhost|internal/);
  });

  it("guards issueId == null — returns null without calling upsertForIssue", async () => {
    const { emitSandboxPreviewTaskOutput } = await import("../services/task-output-emitters.js");
    const runner: SandboxFileMovementRunner = {
      async execute() {
        throw new Error("not exercised");
      },
      async writeFiles() {
        throw new Error("not exercised");
      },
      async resolveHost() {
        return "3000-fakesandbox.e2b.app";
      },
    };

    const result = await emitSandboxPreviewTaskOutput({} as never, {
      companyId: "company-1",
      issueId: null,
      runner,
      port: 3000,
    });

    expect(result).toBeNull();
    expect(mocks.upsertForIssue).not.toHaveBeenCalled();
  });

  it("never throws — a runner without resolveHost resolves to null instead of rejecting", async () => {
    const { emitSandboxPreviewTaskOutput } = await import("../services/task-output-emitters.js");
    const runner: SandboxFileMovementRunner = {
      async execute() {
        throw new Error("not exercised");
      },
      async writeFiles() {
        throw new Error("not exercised");
      },
      // resolveHost intentionally omitted.
    };

    await expect(
      emitSandboxPreviewTaskOutput({} as never, {
        companyId: "company-1",
        issueId: "issue-1",
        runner,
        port: 3000,
      }),
    ).resolves.toBeNull();
    expect(mocks.upsertForIssue).not.toHaveBeenCalled();
  });
});
