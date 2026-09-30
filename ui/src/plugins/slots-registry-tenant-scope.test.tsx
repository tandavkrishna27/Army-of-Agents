import { afterEach, describe, expect, it } from "vitest";
import {
  _resetPluginModuleLoader,
  registerPluginReactComponent,
  resolveRegisteredPluginComponent,
  slotContextToHostContext,
} from "./slots";

const CompanyAComponent = () => null;
const CompanyBComponent = () => null;

afterEach(() => _resetPluginModuleLoader());

describe("plugin UI component registry tenant scope", () => {
  it("does not overwrite components when two tenant rows share a plugin key", () => {
    registerPluginReactComponent(
      "plugin-row-a",
      "Dashboard",
      CompanyAComponent
    );
    registerPluginReactComponent(
      "plugin-row-b",
      "Dashboard",
      CompanyBComponent
    );

    expect(
      resolveRegisteredPluginComponent("plugin-row-a", "Dashboard")
    ).toEqual({ kind: "react", component: CompanyAComponent });
    expect(
      resolveRegisteredPluginComponent("plugin-row-b", "Dashboard")
    ).toEqual({ kind: "react", component: CompanyBComponent });
  });

  it("exposes the tenant-specific installation UUID to plugin UI code", () => {
    expect(
      slotContextToHostContext(
        { companyId: "company-a", projectId: "project-a" },
        "user-a",
        "plugin-row-a"
      )
    ).toMatchObject({
      pluginInstallationId: "plugin-row-a",
      companyId: "company-a",
      projectId: "project-a",
      userId: "user-a",
    });
  });
});
