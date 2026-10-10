import { vi } from "vitest";

// Section unit tests replace domain services and do not supply a real DB.
// Recovery/transactions are tested separately against real PostgreSQL.
vi.mock("../../services/company-import-operations.js", async () => {
  const { companyService } = await import("../../services/companies.js");
  const { accessService } = await import("../../services/access.js");
  return { claimCompanyImport: async (db: any, input: any) => {
    const { company } = await companyService(db).createWithOperator(input.company,
      { requestedByUserId: input.actorUserId }, input.actorUserId, accessService);
    return {
      company, operationId: input.operationId,
      checkpoint: async (_key: string, effect: (tx: any) => Promise<unknown>) => effect(db),
      complete: async () => undefined,
      fail: async () => new Error("Synthetic unit import failure"),
    };
  } };
});
