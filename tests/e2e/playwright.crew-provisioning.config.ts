import { defineConfig } from "@playwright/test";
import baseConfig from "./playwright.config";

export default defineConfig({
  ...baseConfig,
  testMatch: "**/company-default-crew-provisioning.spec.ts",
  testIgnore: [],
});
