import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  describeLocalInstancePaths,
  expandHomePrefix,
  resolveAoaHomeDir,
  resolveAoaInstanceId,
} from "../config/home.js";

const ORIGINAL_ENV = { ...process.env };

describe("home path resolution", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("defaults to ~/.aoa and default instance", () => {
    // Set AOA_HOME explicitly to its default value so the legacy
    // ~/.paperclip migration fallback doesn't depend on whether the
    // developer running the test has a real ~/.paperclip/ on disk.
    const defaultAoaHome = path.resolve(os.homedir(), ".aoa");
    process.env.AOA_HOME = defaultAoaHome;
    delete process.env.AOA_INSTANCE_ID;

    const paths = describeLocalInstancePaths();
    expect(paths.homeDir).toBe(defaultAoaHome);
    expect(paths.instanceId).toBe("default");
    expect(paths.configPath).toBe(path.resolve(defaultAoaHome, "instances", "default", "config.json"));
  });

  it("supports AOA_HOME and explicit instance ids", () => {
    process.env.AOA_HOME = "~/paperclip-home";

    const home = resolveAoaHomeDir();
    expect(home).toBe(path.resolve(os.homedir(), "paperclip-home"));
    expect(resolveAoaInstanceId("dev_1")).toBe("dev_1");
  });

  it("rejects invalid instance ids", () => {
    expect(() => resolveAoaInstanceId("bad/id")).toThrow(/Invalid instance id/);
  });

  it("expands ~ prefixes", () => {
    expect(expandHomePrefix("~")).toBe(os.homedir());
    expect(expandHomePrefix("~/x/y")).toBe(path.resolve(os.homedir(), "x/y"));
  });
});
