import { beforeEach, describe, expect, it, vi } from "vitest";
import { createIssueParamNormalizer } from "../routes/issue-param-normalizer.js";
import { HttpError } from "../errors.js";

// Unit test (no DB, no routes): proves the shared normalizer turns an
// identifier-shaped MISS (e.g. `ACM-999` with nothing to resolve) into a 404
// throw instead of returning the raw string. Returning the raw identifier let
// callers that feed it into a UUID column (artifacts/output-detection/
// task-outputs/dependencies) hit Postgres 22P02 → un-statused → 500. A real
// UUID cannot match ISSUE_IDENTIFIER_RE, so a genuine-but-absent UUID still
// passes through to the handler's own 404.
//
// The normalizer builds its own `issueService(db)`, so we mock the module.

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
  getByIdentifierInCompany: vi.fn(),
}));

vi.mock("../services/issues.js", () => ({
  issueService: () => mockIssueService,
}));

const COMPANY_A = "11111111-1111-1111-1111-111111111111";
const RESOLVED_ISSUE_ID = "22222222-2222-4222-8222-222222222222";
const A_UUID = "33333333-3333-4333-8333-333333333333";

describe("normalizeIssueParam", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws a 404 HttpError when a bare identifier-shaped param misses", async () => {
    mockIssueService.getByIdentifier.mockResolvedValue(null);
    const normalize = createIssueParamNormalizer({} as never);

    await expect(
      normalize("ACM-999", undefined, [COMPANY_A]),
    ).rejects.toMatchObject({ status: 404 });

    // Confirm it is the shared HttpError (so the error handler emits 404, not 500).
    await expect(
      normalize("ACM-999", undefined, [COMPANY_A]),
    ).rejects.toBeInstanceOf(HttpError);

    expect(mockIssueService.getByIdentifier).toHaveBeenCalledWith("ACM-999", [
      COMPANY_A,
    ]);
    expect(mockIssueService.getByIdentifierInCompany).not.toHaveBeenCalled();
  });

  it("throws a 404 HttpError when a company-scoped identifier-shaped param misses", async () => {
    mockIssueService.getByIdentifierInCompany.mockResolvedValue(null);
    const normalize = createIssueParamNormalizer({} as never);

    await expect(normalize("ACM-999", COMPANY_A)).rejects.toMatchObject({
      status: 404,
    });

    expect(mockIssueService.getByIdentifierInCompany).toHaveBeenCalledWith(
      COMPANY_A,
      "ACM-999",
    );
    expect(mockIssueService.getByIdentifier).not.toHaveBeenCalled();
  });

  it("passes a non-identifier-shaped value (UUID) through unchanged without resolving", async () => {
    const normalize = createIssueParamNormalizer({} as never);

    await expect(normalize(A_UUID, undefined, [COMPANY_A])).resolves.toBe(
      A_UUID,
    );

    // A real UUID never matches ISSUE_IDENTIFIER_RE → no lookup, no throw.
    expect(mockIssueService.getByIdentifier).not.toHaveBeenCalled();
    expect(mockIssueService.getByIdentifierInCompany).not.toHaveBeenCalled();
  });

  it("returns the resolved issue id when a bare identifier resolves", async () => {
    mockIssueService.getByIdentifier.mockResolvedValue({
      id: RESOLVED_ISSUE_ID,
      companyId: COMPANY_A,
      identifier: "ACM-1",
    });
    const normalize = createIssueParamNormalizer({} as never);

    await expect(normalize("ACM-1", undefined, [COMPANY_A])).resolves.toBe(
      RESOLVED_ISSUE_ID,
    );
  });

  it("returns the resolved issue id when a company-scoped identifier resolves", async () => {
    mockIssueService.getByIdentifierInCompany.mockResolvedValue({
      id: RESOLVED_ISSUE_ID,
      companyId: COMPANY_A,
      identifier: "ACM-1",
    });
    const normalize = createIssueParamNormalizer({} as never);

    await expect(normalize("ACM-1", COMPANY_A)).resolves.toBe(RESOLVED_ISSUE_ID);
  });
});
