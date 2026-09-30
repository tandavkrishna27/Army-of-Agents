import { beforeEach, describe, expect, it, vi } from "vitest";

const { insertMock, updateMock } = vi.hoisted(() => ({
  insertMock: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
  updateMock: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => undefined) })) })),
}));

vi.mock("@armyofagents/db", () => ({
  issueComments: { _: { name: "issue_comments" } },
  issues: { id: { name: "id" }, _: { name: "issues" } },
}));
vi.mock("drizzle-orm", () => ({ eq: (...a: unknown[]) => ({ __eq: a }) }));

import { postRunSummaryComment } from "../services/run-summary-comment.js";

function fakeDb() {
  return { insert: insertMock, update: updateMock } as never;
}

beforeEach(() => {
  insertMock.mockClear();
  insertMock.mockImplementation(() => ({ values: vi.fn(async () => undefined) }));
  updateMock.mockClear();
  updateMock.mockImplementation(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => undefined) })) }));
});

describe("postRunSummaryComment", () => {
  const base = {
    companyId: "co-1",
    issueId: "task-1" as string | null,
    agentName: "Engineer",
    runtimeConfig: {} as Record<string, unknown>,
    outcome: "succeeded" as const,
    durationMs: 135_000,
    inputTokens: 100 as number | null,
    outputTokens: 200 as number | null,
    costUsd: 0.12 as number | null,
    errorMessage: null as string | null,
    detectedFiles: [] as Array<{ path: string; type?: string }>,
  };

  it("writes a summary comment + touches the issue when not opted out", async () => {
    const result = await postRunSummaryComment(fakeDb(), base);
    expect(result).toEqual({ posted: true });
    expect(insertMock).toHaveBeenCalledTimes(1);
    const values = (insertMock.mock.results[0].value.values as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(values).toMatchObject({
      companyId: "co-1",
      issueId: "task-1",
      authorAgentId: null,
      authorUserId: null,
      authorType: "system",
      presentation: {
        kind: "system_notice",
        tone: "success",
        title: "Run summary",
        detailsDefaultOpen: false,
      },
    });
    expect(typeof values.body).toBe("string");
    expect(values.body).toContain("Engineer");
    expect(updateMock).toHaveBeenCalledTimes(1); // issues.updatedAt touch
  });

  it("no issueId → no-op (posted:false), no writes", async () => {
    const result = await postRunSummaryComment(fakeDb(), { ...base, issueId: null });
    expect(result).toEqual({ posted: false });
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("autoRunSummary === false → opt-out (posted:false), no writes", async () => {
    const result = await postRunSummaryComment(fakeDb(), { ...base, runtimeConfig: { autoRunSummary: false } });
    expect(result).toEqual({ posted: false });
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("a failed outcome still posts a summary (with the error)", async () => {
    const result = await postRunSummaryComment(fakeDb(), {
      ...base,
      outcome: "failed",
      errorMessage: "boom",
    });
    expect(result).toEqual({ posted: true });
    const values = (insertMock.mock.results[0].value.values as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(values.body).toContain("boom");
    expect(values.presentation).toMatchObject({ kind: "system_notice", tone: "danger" });
  });

  it("never throws — a DB insert error resolves posted:false", async () => {
    insertMock.mockReturnValueOnce({
      values: vi.fn(async () => {
        throw new Error("db down");
      }),
    } as never);
    const result = await postRunSummaryComment(fakeDb(), base);
    expect(result).toEqual({ posted: false });
  });
});
