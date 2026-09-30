import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { secretRoutes } from "../routes/secrets.js";

const mockSecretService = vi.hoisted(() => ({
  listProviders: vi.fn().mockReturnValue([]),
  listProviderConfigs: vi.fn(),
  createProviderConfig: vi.fn(),
  getProviderConfigById: vi.fn(),
  updateProviderConfig: vi.fn(),
  deleteProviderConfig: vi.fn(),
  checkProviderConfig: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  getById: vi.fn(),
  rotate: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  listBindingsForSecret: vi.fn(),
  createBinding: vi.fn(),
  getBindingById: vi.fn(),
  deleteBinding: vi.fn(),
  listAccessEvents: vi.fn(),
  previewRemoteImport: vi.fn(),
  importRemoteSecrets: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockReindexCompany = vi.hoisted(() => vi.fn().mockResolvedValue({ requeuedFailed: 0, enqueuedMissing: 0 }));

vi.mock("../services/index.js", () => ({
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
}));

vi.mock("../services/embeddings-backfill.js", () => ({
  reindexCompany: mockReindexCompany,
}));

const companyAActor = {
  type: "board" as const,
  source: "session" as const,
  userId: "user-A",
  companyIds: ["company-A"],
  isInstanceAdmin: false,
};

function makeApp(actor: any = companyAActor) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", secretRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("secret routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("mounts provider config, binding, access-event, and remote import routes", () => {
    const router = secretRoutes({} as any) as any;
    const routePaths = router.stack
      .map((layer: any) => layer.route?.path)
      .filter(Boolean);

    expect(routePaths).toContain("/companies/:companyId/secret-provider-configs");
    expect(routePaths).toContain("/secret-provider-configs/:id");
    expect(routePaths).toContain("/secret-provider-configs/:id/check");
    expect(routePaths).toContain("/secrets/:id/bindings");
    expect(routePaths).toContain("/secret-bindings/:id");
    expect(routePaths).toContain("/secrets/:id/access-events");
    expect(routePaths).toContain("/companies/:companyId/secrets/remote-import/preview");
    expect(routePaths).toContain("/companies/:companyId/secrets/remote-import");
  });

  describe("reindex-on-key-add (P2)", () => {
    it("triggers reindexCompany when an OpenAI secret (name=llm:openai) is created", async () => {
      // secretService normalizes `key` to LLM_OPENAI but preserves name; the
      // trigger must match on name, which is what the provider resolver uses.
      mockSecretService.create.mockResolvedValue({
        id: "secret-oa",
        companyId: "company-A",
        name: "llm:openai",
        key: "LLM_OPENAI",
        provider: "openai",
      });

      const res = await request(makeApp())
        .post("/api/companies/company-A/secrets")
        .send({ name: "llm:openai", value: "sk-test" });

      expect(res.status).toBe(201);
      expect(mockReindexCompany).toHaveBeenCalledTimes(1);
      expect(mockReindexCompany).toHaveBeenCalledWith(expect.anything(), "company-A");
    });

    it("does NOT trigger reindexCompany for a non-OpenAI secret", async () => {
      mockSecretService.create.mockResolvedValue({
        id: "secret-an",
        companyId: "company-A",
        name: "llm:anthropic",
        key: "LLM_ANTHROPIC",
        provider: "anthropic",
      });

      const res = await request(makeApp())
        .post("/api/companies/company-A/secrets")
        .send({ name: "llm:anthropic", value: "sk-test" });

      expect(res.status).toBe(201);
      expect(mockReindexCompany).not.toHaveBeenCalled();
    });
  });

  it("blocks cross-company secret access before listing audit events", async () => {
    mockSecretService.getById.mockResolvedValue({
      id: "secret-1",
      companyId: "company-B",
    });

    const res = await request(makeApp()).get("/api/secrets/secret-1/access-events");

    expect(res.status).toBe(403);
    expect(mockSecretService.listAccessEvents).not.toHaveBeenCalled();
  });

  it("logs binding creation mutations", async () => {
    mockSecretService.getById.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-A",
    });
    mockSecretService.createBinding.mockResolvedValue({
      id: "binding-1",
      companyId: "company-A",
      secretId: "11111111-1111-4111-8111-111111111111",
      targetType: "agent",
      targetId: "agent-1",
      configPath: "env.OPENAI_API_KEY",
      versionSelector: "latest",
    });

    const res = await request(makeApp())
      .post("/api/secrets/11111111-1111-4111-8111-111111111111/bindings")
      .send({
        targetType: "agent",
        targetId: "agent-1",
        configPath: "env.OPENAI_API_KEY",
      });

    expect(res.status).toBe(201);
    expect(mockSecretService.createBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-A",
        secretId: "11111111-1111-4111-8111-111111111111",
        targetType: "agent",
        configPath: "env.OPENAI_API_KEY",
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "secret_binding.created",
        companyId: "company-A",
        entityId: "binding-1",
      }),
    );
  });
});
