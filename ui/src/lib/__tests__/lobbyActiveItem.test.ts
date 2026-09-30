import { describe, it, expect } from "vitest";
import { lobbyActiveItem } from "../lobbyActiveItem";

describe("lobbyActiveItem", () => {
  it("maps the index route to organizations", () => {
    expect(lobbyActiveItem("/")).toBe("organizations");
  });
  it("maps marketplace routes to marketplace", () => {
    expect(lobbyActiveItem("/marketplace")).toBe("marketplace");
    expect(lobbyActiveItem("/marketplace/search")).toBe("marketplace");
    expect(lobbyActiveItem("/marketplace/package/abc")).toBe("marketplace");
    expect(lobbyActiveItem("/marketplace/skill/foo")).toBe("marketplace");
  });
  it("maps instance settings to settings", () => {
    expect(lobbyActiveItem("/instance/settings")).toBe("settings");
    expect(lobbyActiveItem("/instance/settings?tab=backups")).toBe("settings");
  });
  it("maps instance access to settings (shares the Settings shell)", () => {
    expect(lobbyActiveItem("/instance/access")).toBe("settings");
  });
  it("defaults unknown paths to organizations", () => {
    expect(lobbyActiveItem("/whatever")).toBe("organizations");
  });
});
