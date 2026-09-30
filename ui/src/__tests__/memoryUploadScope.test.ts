import { describe, it, expect } from "vitest";
import {
  canUploadInScope,
  isVirtualFolderPath,
  VIRTUAL_FOLDER_PATHS,
} from "../lib/memoryUploadScope";

describe("canUploadInScope", () => {
  it("allows concrete folder paths", () => {
    expect(
      canUploadInScope({
        folderPath: "engineering/Decisions",
        departmentId: "dept-1",
        layer: null,
      }),
    ).toBe(true);
    expect(
      canUploadInScope({
        folderPath: "Company",
        departmentId: null,
        layer: null,
      }),
    ).toBe(true);
  });

  it("allows dept root (folderPath empty + departmentId set + no layer)", () => {
    expect(
      canUploadInScope({
        folderPath: "",
        departmentId: "dept-1",
        layer: null,
      }),
    ).toBe(true);
  });

  // Codex P1 round 2 regression — these scopes used to render the upload
  // button, but the upload would land somewhere the user couldn't see it.
  it("blocks home (no folder, no dept, no layer)", () => {
    expect(
      canUploadInScope({
        folderPath: "",
        departmentId: null,
        layer: null,
      }),
    ).toBe(false);
  });

  it("blocks layer-only views (Identity / Domain / Active Context / Working)", () => {
    for (const layer of ["identity", "domain", "active_context", "working"]) {
      expect(
        canUploadInScope({
          folderPath: "",
          departmentId: null,
          layer,
        }),
      ).toBe(false);
    }
  });

  it("blocks layer-scoped-by-dept views (e.g. layer=domain + dept set)", () => {
    expect(
      canUploadInScope({
        folderPath: "",
        departmentId: "dept-1",
        layer: "domain",
      }),
    ).toBe(false);
  });

  it("blocks virtual shortcuts (Pinned, Pending, Recent, Archived)", () => {
    for (const path of VIRTUAL_FOLDER_PATHS) {
      expect(
        canUploadInScope({
          folderPath: path,
          departmentId: null,
          layer: null,
        }),
      ).toBe(false);
      // Same answer even if a dept is selected.
      expect(
        canUploadInScope({
          folderPath: path,
          departmentId: "dept-1",
          layer: null,
        }),
      ).toBe(false);
    }
  });
});

describe("isVirtualFolderPath", () => {
  it("recognizes the four reserved sentinels", () => {
    expect(isVirtualFolderPath("__pinned")).toBe(true);
    expect(isVirtualFolderPath("__pending")).toBe(true);
    expect(isVirtualFolderPath("__recent")).toBe(true);
    expect(isVirtualFolderPath("__archived")).toBe(true);
  });

  it("rejects empty + concrete paths", () => {
    expect(isVirtualFolderPath("")).toBe(false);
    expect(isVirtualFolderPath("engineering/Decisions")).toBe(false);
    expect(isVirtualFolderPath("Company")).toBe(false);
  });
});
