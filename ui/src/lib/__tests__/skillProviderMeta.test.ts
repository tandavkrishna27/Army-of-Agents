import { describe, expect, it } from "vitest";
import { providerFromSkillMetadata } from "../skillProviderMeta";

describe("providerFromSkillMetadata", () => {
  it("reads catalog provider metadata safely", () => {
    expect(providerFromSkillMetadata({
      catalogProvider: {
        id: "anthropic",
        name: "Anthropic",
        fallbackInitials: "A",
        logoUrl: "https://github.com/anthropics.png",
      },
    })).toEqual({
      id: "anthropic",
      name: "Anthropic",
      fallbackInitials: "A",
      logoUrl: "https://github.com/anthropics.png",
    });
  });

  it("derives fallback initials when provider metadata omits them", () => {
    expect(providerFromSkillMetadata({
      catalogProvider: {
        id: "openai",
        name: "OpenAI",
        logoUrl: "https://github.com/openai.png",
      },
    })).toEqual({
      id: "openai",
      name: "OpenAI",
      fallbackInitials: "O",
      logoUrl: "https://github.com/openai.png",
    });
  });

  it("returns null for incomplete provider metadata", () => {
    expect(providerFromSkillMetadata({ catalogProvider: { name: "Anthropic" } })).toBeNull();
    expect(providerFromSkillMetadata(null)).toBeNull();
  });
});
