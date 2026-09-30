// server/src/services/internal-agent/tools/artifact-create-version.ts
//
// Task C2 batch 2 — `create_artifact_version` (action tool, Engineer iteration).
//
// Creates a new version of an existing artifact by delegating to
// artifactService.addVersion — the single choke point that owns
// parent-validation, atomic version-numbering, the artifacts.current_version_id
// pointer bump, and assertAssetOwned. The tool keeps its own caller-company
// ownership pre-check (addVersion does not scope by caller company, and this is
// a crew-agent / prompt-injection surface).

import { eq } from "drizzle-orm";
import { artifacts } from "@armyofagents/db";
import type { AgentTool } from "../types.js";

export const createArtifactVersionTool: AgentTool = {
  name: "create_artifact_version",
  description:
    "Create a new version of an existing artifact (Engineer iteration loop).",
  parameters: {
    type: "object",
    properties: {
      artifactId: { type: "string", description: "Artifact id to add a version to" },
      content: { type: "string", description: "Text content for the new version" },
      parentVersionId: {
        type: "string",
        description: "Optional FK to a previous version for branching",
      },
    },
    required: ["artifactId", "content"],
  },
  category: "action",
  requiredRole: "team_member",
  requiresConfirmation: false,
  async execute(params, ctx) {
    const { artifactId, content, parentVersionId } = (params ?? {}) as {
      artifactId?: string;
      content?: string;
      parentVersionId?: string;
    };
    if (!artifactId || typeof artifactId !== "string") {
      return {
        success: false,
        data: null,
        summary: "artifactId is required",
        error: "INVALID_PARAMS",
      };
    }
    if (typeof content !== "string") {
      return {
        success: false,
        data: null,
        summary: "content must be a string",
        error: "INVALID_PARAMS",
      };
    }

    // SECURITY (company scoping): this is a crew-agent tool (Engineer/Planner)
    // driven by an LLM over untrusted task/discussion content — a prompt-injection
    // surface. artifactId is an arbitrary tool param; nothing below filters by
    // company, so without this gate a crew agent could add a version to, and
    // repoint current_version_id on, ANOTHER company's artifact. We verify
    // ownership on ctx.db BEFORE the transaction and treat a cross-company hit
    // exactly like a miss (same NOT_FOUND, nothing created) so the tool never
    // writes onto, or leaks the existence of, another company's artifact. This
    // MUST run before ctx.db.transaction(...): returning a failure from inside
    // the tx callback would be lost — the outer handler reads result.versionNumber
    // and would report success with bogus data.
    const [art] = await ctx.db
      .select({ companyId: artifacts.companyId })
      .from(artifacts)
      .where(eq(artifacts.id, artifactId));
    if (!art || art.companyId !== ctx.companyId) {
      return {
        success: false,
        data: null,
        summary: "Artifact not found",
        error: "NOT_FOUND",
      };
    }

    // All version writers funnel through artifactService.addVersion — the single
    // choke point that owns parent-validation, atomic version-numbering, the
    // currentVersionId pointer bump, AND assertAssetOwned. Inserting the version
    // row here directly would duplicate (and could drift from) those guards. The
    // company-ownership pre-check above stays in the tool because addVersion does
    // NOT scope by caller company, and this tool is a prompt-injection surface.
    try {
      const version = await ctx.services.artifacts.addVersion(artifactId, {
        source: "agent",
        content,
        parentVersionId: parentVersionId ?? null,
      });
      return {
        success: true,
        data: { versionId: version.id, versionNumber: version.versionNumber },
        summary: `Created artifact v${version.versionNumber}`,
      };
    } catch (err: any) {
      // addVersion throws badRequest (HttpError status 400) "parentVersionId does
      // not belong to this artifact" for a foreign/missing parent — mirror the
      // prior NOT_FOUND. Anchor on status 400 so a reworded message can't silently
      // downgrade this to TRANSACTION_FAILED; the substring keeps it specific.
      const foreignParent =
        err?.status === 400 && typeof err?.message === "string" && err.message.includes("parentVersionId");
      return {
        success: false,
        data: null,
        summary: foreignParent ? "Artifact version parent invalid" : `Failed to create artifact version: ${err?.message ?? "unknown error"}`,
        error: foreignParent ? "NOT_FOUND" : "TRANSACTION_FAILED",
      };
    }
  },
};
