import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      get: vi.fn(),
    },
  };
});

import { api } from "../client";
import {
  isCloudPluginExecutionBlockedError,
  pluginsApi,
} from "../plugins";
import { ApiError } from "../client";

describe("pluginsApi.listUiContributions", () => {
  beforeEach(() => {
    vi.mocked(api.get).mockReset();
  });

  it("qualifies UI contribution discovery with the selected company", async () => {
    vi.mocked(api.get).mockResolvedValueOnce([]);

    await pluginsApi.listUiContributions("company/with space");

    expect(api.get).toHaveBeenCalledWith(
      "/plugins/ui-contributions?companyId=company%2Fwith%20space",
    );
  });
});

describe("cloud plugin execution API errors", () => {
  it("recognizes the canonical blocked envelope for truthful install UX", () => {
    expect(
      isCloudPluginExecutionBlockedError(
        new ApiError("blocked", 503, {
          error:
            "Plugin execution is blocked on AoA Cloud until isolated workers are available",
          code: "PLUGIN_WORKER_BLOCKED_IN_CLOUD",
          docs: "/docs/guides/cloud-plugin-execution",
        }),
      ),
    ).toBe(true);
    expect(
      isCloudPluginExecutionBlockedError(
        new ApiError("unavailable", 503, { code: "OTHER" }),
      ),
    ).toBe(false);
  });
});
