import { describe, expect, it, vi } from "vitest";

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: any[]) => args),
  eq: vi.fn((a: any, b: any) => ({ eq: [a, b] })),
  asc: vi.fn((a: any) => ({ asc: a })),
  desc: vi.fn((a: any) => ({ desc: a })),
}));

vi.mock("@armyofagents/db", () => ({
  documents: {
    id: "d_id",
    companyId: "d_company_id",
    title: "d_title",
    format: "d_format",
    latestBody: "d_latest_body",
    latestRevisionId: "d_latest_revision_id",
    latestRevisionNumber: "d_latest_revision_number",
    createdByAgentId: "d_created_by_agent_id",
    createdByUserId: "d_created_by_user_id",
    updatedByAgentId: "d_updated_by_agent_id",
    updatedByUserId: "d_updated_by_user_id",
    createdAt: "d_created_at",
    updatedAt: "d_updated_at",
  },
  documentRevisions: {
    id: "dr_id",
    companyId: "dr_company_id",
    documentId: "dr_document_id",
    revisionNumber: "dr_revision_number",
    body: "dr_body",
    changeSummary: "dr_change_summary",
    createdByAgentId: "dr_created_by_agent_id",
    createdByUserId: "dr_created_by_user_id",
    createdAt: "dr_created_at",
  },
  issueDocuments: {
    issueId: "id_issue_id",
    documentId: "id_document_id",
    key: "id_key",
    companyId: "id_company_id",
    createdAt: "id_created_at",
    updatedAt: "id_updated_at",
  },
  issues: {
    id: "i_id",
    companyId: "i_company_id",
  },
}));

import { documentService } from "../services/documents.js";

describe("documentService.upsertIssueDocument", () => {
  it("converts drizzle-wrapped 23505 (cause.code) to a clean conflict (D1 documents.ts fix)", async () => {
    // D1: pre-fix, documents.ts had a local isUniqueViolation() that
    // only checked err.code — missing the err.cause.code fallback that
    // drizzle-orm uses when wrapping the underlying postgres-js error.
    // Result: drizzle-wrapped 23505 errors fell through to the generic
    // 500 path instead of being mapped to 409 Conflict.
    //
    // Post-fix: documents.ts uses the shared isUniqueViolation() helper
    // which checks both err.code AND err.cause.code, so wrapped errors
    // are correctly detected.
    //
    // This test simulates the wrapped shape and asserts the conflict
    // path is hit. The test name is the regression-prevention contract:
    // if a future change reverts to a code-only check, this test fails.
    const wrappedErr = Object.assign(new Error("wrapped"), {
      cause: Object.assign(new Error("dup"), { code: "23505" }),
    });

    const db: any = {
      // Outer issue lookup: returns the issue so we proceed into the tx.
      select: () => ({
        from: () => ({
          where: () => ({
            then: (resolve: (rows: any[]) => any) =>
              Promise.resolve(resolve([{ id: "issue-1", companyId: "co-1" }])),
          }),
        }),
      }),
      transaction: async (cb: (tx: any) => any) => {
        const tx: any = {
          // Inside-tx: existing-row lookup returns empty (no existing doc)
          // → service falls through to the INSERT path.
          select: () => ({
            from: () => ({
              innerJoin: () => ({
                where: () => ({
                  then: (resolve: (rows: any[]) => any) =>
                    Promise.resolve(resolve([])),
                }),
              }),
            }),
          }),
          // INSERT throws the wrapped 23505 — pre-fix this would not be
          // detected and the error would bubble up as 500. Post-fix the
          // shared isUniqueViolation() catches err.cause.code and the
          // service throws conflict() (status: 409).
          insert: () => ({
            values: () => ({
              returning: () => {
                throw wrappedErr;
              },
            }),
          }),
        };
        return cb(tx);
      },
    };

    await expect(
      documentService(db).upsertIssueDocument({
        issueId: "issue-1",
        key: "plan",
        format: "markdown",
        body: "# Plan body",
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
});
