import { describe, expect, it } from "vitest";
import { authorizeToolInvocation } from "../services/internal-agent/authorize-tool.js";
import { createThreadTools } from "../services/internal-agent/tools/thread-tools.js";
import { createPostEntryTool } from "../services/internal-agent/tools/post-entry-tool.js";
import { createAdvancePhaseTool } from "../services/internal-agent/tools/advance-phase-tool.js";
import { createNotifyOwnerTool } from "../services/internal-agent/tools/notify-owner-tool.js";
import { createArtifactTool } from "../services/internal-agent/tools/create-artifact-tool.js";

const NEW_TOOLS = [
  ...createThreadTools(),
  createPostEntryTool(),
  createAdvancePhaseTool(),
  createNotifyOwnerTool(),
  createArtifactTool(),
];

describe("P2 tool registry allowlist gate (P2.7)", () => {
  it("kind='aoa' with empty allowlist: all new tools denied", () => {
    NEW_TOOLS.forEach((tool) => {
      const result = authorizeToolInvocation(tool, "team_member", ["system_actions", "discussion_processing"], {
        agentKind: "aoa",
        toolAllowlist: [],
      });
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.error).toBe("NOT_IN_ALLOWLIST");
      }
    });
  });

  it("kind='aoa' with absent toolAllowlist: all new tools denied", () => {
    NEW_TOOLS.forEach((tool) => {
      const result = authorizeToolInvocation(tool, "team_member", ["system_actions", "discussion_processing"], {
        agentKind: "aoa",
        toolAllowlist: undefined,
      });
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.error).toBe("NOT_IN_ALLOWLIST");
      }
    });
  });

  it("kind='aoa' with explicit allowlist: only listed tools allowed", () => {
    const allowlist = ["query_threads", "post_entry", "advance_phase", "notify_owner"];

    // Find the query_threads tool
    const queryThreadsTool = NEW_TOOLS.find((t) => t.name === "query_threads");
    expect(queryThreadsTool).toBeDefined();

    if (queryThreadsTool) {
      const result = authorizeToolInvocation(queryThreadsTool, "team_member", ["system_actions", "discussion_processing"], {
        agentKind: "aoa",
        toolAllowlist: allowlist,
      });
      expect(result.allowed).toBe(true);
    }

    // Find the create_artifact tool
    const createArtifactTool_ = NEW_TOOLS.find((t) => t.name === "create_artifact");
    expect(createArtifactTool_).toBeDefined();

    if (createArtifactTool_) {
      const result = authorizeToolInvocation(createArtifactTool_, "team_member", ["system_actions", "discussion_processing"], {
        agentKind: "aoa",
        toolAllowlist: allowlist,
      });
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.error).toBe("NOT_IN_ALLOWLIST");
      }
    }
  });

  it("kind!='aoa' (Commander): allowlist gate is skipped", () => {
    const firstTool = NEW_TOOLS[0];
    expect(firstTool).toBeDefined();

    const result = authorizeToolInvocation(firstTool, "team_member", ["system_actions", "discussion_processing"], {
      agentKind: "commander",
      toolAllowlist: [],
    });
    // Since agentKind is not 'aoa', the allowlist gate is skipped
    // Result should be allowed (query tools have team_member required role and query category has no capability gate)
    expect(result.allowed).toBe(true);
  });
});
