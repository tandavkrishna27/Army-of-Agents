import { describe, expect, it } from "vitest";
import { createProjectSchema, createProjectWorkspaceSchema, updateProjectWorkspaceSchema } from "./project.js";

const reservedMetadata = {
  runtimeConfig: {
    desiredState: "running",
    workspaceRuntime: { services: [{ name: "web", command: "echo unsafe" }] },
  },
};

describe("project workspace reserved runtime metadata", () => {
  it("rejects runtimeConfig on generic workspace create and update validators", () => {
    expect(createProjectWorkspaceSchema.safeParse({ cwd: "/repo", metadata: reservedMetadata }).success).toBe(false);
    expect(updateProjectWorkspaceSchema.safeParse({ metadata: reservedMetadata }).success).toBe(false);
  });

  it("rejects nested workspace runtimeConfig during project creation", () => {
    expect(createProjectSchema.safeParse({
      name: "Project",
      workspace: { cwd: "/repo", metadata: reservedMetadata },
    }).success).toBe(false);
  });

  it("continues to allow non-reserved metadata", () => {
    expect(createProjectWorkspaceSchema.safeParse({
      cwd: "/repo",
      metadata: { label: "primary", editor: { tabSize: 2 } },
    }).success).toBe(true);
  });
});
