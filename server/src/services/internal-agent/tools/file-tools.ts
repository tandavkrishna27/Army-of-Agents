import type { AgentTool } from "../types.js";

export function createFileTools(): AgentTool[] {
  return [
    {
      name: "read_file",
      description: "Read an artifact's content. Returns the latest version by default, or a specific version number.",
      parameters: {
        type: "object",
        properties: {
          artifactId: { type: "string", description: "Artifact ID (required)" },
          versionNumber: { type: "number", description: "Specific version number to read (default: latest)" },
        },
        required: ["artifactId"],
      },
      category: "file",
      requiredRole: "team_lead",
      requiresConfirmation: false,
      execute: async (params: unknown, ctx) => {
        const { artifactId, versionNumber } = (params ?? {}) as Record<string, unknown>;
        const artifact = await ctx.services.artifacts.getById(artifactId as string);
        if (!artifact) {
          return { success: false, data: null, summary: "Artifact not found", error: "NOT_FOUND" };
        }
        const versions = (artifact as any).versions ?? [];
        const version = versionNumber
          ? versions.find((v: any) => v.versionNumber === versionNumber)
          : versions[versions.length - 1];
        if (!version) {
          return { success: false, data: null, summary: `Version ${versionNumber} not found`, error: "NOT_FOUND" };
        }
        return { success: true, data: { artifact, version }, summary: `Read artifact "${(artifact as any).title}" v${version.versionNumber}` };
      },
    },
  ];
}
