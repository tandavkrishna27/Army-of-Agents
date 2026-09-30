import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const bridgeSrc = readFileSync(
  resolve(__dirname, "../services/internal-agent/mcp-bridge.ts"),
  "utf8",
);

const cliSrc = readFileSync(
  resolve(__dirname, "../services/internal-agent/cli-mode.ts"),
  "utf8",
);

const typesSrc = readFileSync(
  resolve(__dirname, "../services/internal-agent/types.ts"),
  "utf8",
);

describe("Commander actor type — implementation contract", () => {
  it("mcp-bridge reads AOA_ACTOR_TYPE from env", () => {
    expect(bridgeSrc).toContain("AOA_ACTOR_TYPE");
  });

  it("mcp-bridge adds actorType to toolContext", () => {
    expect(bridgeSrc).toContain("actorType");
  });

  it("cli-mode includes AOA_ACTOR_TYPE in buildMcpBridgeSpec env", () => {
    expect(cliSrc).toContain("AOA_ACTOR_TYPE");
  });

  it("McpConfigParams includes actorType field", () => {
    expect(cliSrc).toContain("actorType");
  });

  it("ToolContext includes actorType field", () => {
    expect(typesSrc).toContain("actorType");
  });
});
