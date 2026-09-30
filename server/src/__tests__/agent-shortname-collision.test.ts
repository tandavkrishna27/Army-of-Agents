import { describe, expect, it } from "vitest";
import {
  hasAgentShortnameCollision,
  findAgentShortnameCollision,
  deduplicateAgentName,
} from "../services/agent-shortnames.ts";

describe("hasAgentShortnameCollision", () => {
  it("detects collisions by normalized shortname", () => {
    const collision = hasAgentShortnameCollision("Codex Coder", [
      { id: "a1", name: "codex-coder", status: "idle" },
    ]);
    expect(collision).toBe(true);
  });

  it("ignores terminated agents", () => {
    const collision = hasAgentShortnameCollision("Codex Coder", [
      { id: "a1", name: "codex-coder", status: "terminated" },
    ]);
    expect(collision).toBe(false);
  });

  it("ignores the excluded agent id", () => {
    const collision = hasAgentShortnameCollision(
      "Codex Coder",
      [
        { id: "a1", name: "codex-coder", status: "idle" },
        { id: "a2", name: "other-agent", status: "idle" },
      ],
      { excludeAgentId: "a1" },
    );
    expect(collision).toBe(false);
  });

  it("does not collide when candidate has no shortname", () => {
    const collision = hasAgentShortnameCollision("!!!", [
      { id: "a1", name: "codex-coder", status: "idle" },
    ]);
    expect(collision).toBe(false);
  });
});

describe("deduplicateAgentName", () => {
  it("returns original name when no collision", () => {
    const name = deduplicateAgentName("OpenClaw", [
      { id: "a1", name: "other-agent", status: "idle" },
    ]);
    expect(name).toBe("OpenClaw");
  });

  it("appends suffix when name collides", () => {
    const name = deduplicateAgentName("OpenClaw", [
      { id: "a1", name: "openclaw", status: "idle" },
    ]);
    expect(name).toBe("OpenClaw 2");
  });

  it("increments suffix until unique", () => {
    const name = deduplicateAgentName("OpenClaw", [
      { id: "a1", name: "openclaw", status: "idle" },
      { id: "a2", name: "openclaw-2", status: "idle" },
      { id: "a3", name: "openclaw-3", status: "idle" },
    ]);
    expect(name).toBe("OpenClaw 4");
  });

  it("ignores terminated agents for collision", () => {
    const name = deduplicateAgentName("OpenClaw", [
      { id: "a1", name: "openclaw", status: "terminated" },
    ]);
    expect(name).toBe("OpenClaw");
  });
});

describe("findAgentShortnameCollision", () => {
  it("returns the colliding row (incl. kind) so callers can tailor the message", () => {
    // Regression: a founder hiring an org agent named "Engineer" collides with
    // the built-in AoA crew agent of the same name, which is hidden from the
    // Agents tab. The collision row's kind drives the actionable error message.
    const hit = findAgentShortnameCollision("Engineer", [
      { id: "aoa1", name: "Engineer", status: "idle", kind: "aoa" },
      { id: "o1", name: "Director", status: "idle", kind: "org" },
    ]);
    expect(hit?.id).toBe("aoa1");
    expect(hit?.kind).toBe("aoa");
  });

  it("returns null when there is no collision", () => {
    const hit = findAgentShortnameCollision("Engineer", [
      { id: "o1", name: "Director", status: "idle", kind: "org" },
    ]);
    expect(hit).toBeNull();
  });

  it("ignores terminated agents", () => {
    const hit = findAgentShortnameCollision("Engineer", [
      { id: "aoa1", name: "Engineer", status: "terminated", kind: "aoa" },
    ]);
    expect(hit).toBeNull();
  });

  it("respects excludeAgentId so renaming keeps an agent's own shortname", () => {
    const hit = findAgentShortnameCollision(
      "Engineer",
      [{ id: "a1", name: "Engineer", status: "idle", kind: "org" }],
      { excludeAgentId: "a1" },
    );
    expect(hit).toBeNull();
  });
});
