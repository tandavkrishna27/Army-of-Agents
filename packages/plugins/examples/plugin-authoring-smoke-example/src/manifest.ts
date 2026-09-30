import type { AoAPluginManifestV1 } from "@armyofagents/plugin-sdk";

const manifest: AoAPluginManifestV1 = {
  id: "aoa.plugin-authoring-smoke-example",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Plugin Authoring Smoke Example",
  description: "An AoA plugin",
  author: "Plugin Author",
  categories: ["connector"],
  capabilities: [
    "events.subscribe",
    "plugin.state.read",
    "plugin.state.write"
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui"
  },
  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: "health-widget",
        displayName: "Plugin Authoring Smoke Example Health",
        exportName: "DashboardWidget"
      }
    ]
  }
};

export default manifest;
