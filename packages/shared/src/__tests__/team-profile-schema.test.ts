import { describe, expect, expectTypeOf, it } from "vitest";
import {
  HUMAN_SOCIAL_LINK_TYPES,
  STANDARD_HUMAN_CAPABILITY_DOCUMENTS,
  createHumanCapabilityDocumentSchema,
  updateHumanCapabilityDocumentSchema,
  updateCompanyUserProfileSchema,
  searchHumansSchema,
  type UpdateCompanyUserProfile,
} from "../validators/team.js";
import type {
  CompanyUserProfile,
  HumanContextResolutionResult,
  HumanSearchResponse,
  HumanSocialLink,
  MemberDependencies,
  TeamMemberSummary,
} from "../types/team.js";

const uuid = "550e8400-e29b-41d4-a716-446655440000";

describe("team profile shared contracts", () => {
  it("accepts and normalizes a valid company profile update payload", () => {
    const parsed = updateCompanyUserProfileSchema.parse({
      displayName: "  Ada Lovelace  ",
      title: "  Founder  ",
      bio: "  Builds analytical engines.  ",
      location: "  London  ",
      timezone: "  Europe/London  ",
      avatarAssetId: uuid,
      socialLinks: [
        { type: "github", label: "  Code  ", url: " https://github.com/ada " },
        { type: "website", label: null, url: "https://example.com" },
      ],
    });

    expect(parsed).toEqual({
      displayName: "Ada Lovelace",
      title: "Founder",
      bio: "Builds analytical engines.",
      location: "London",
      timezone: "Europe/London",
      avatarAssetId: uuid,
      socialLinks: [
        { type: "github", label: "Code", url: "https://github.com/ada" },
        { type: "website", label: null, url: "https://example.com" },
      ],
    });
  });

  it("accepts nullable fields and does not accept external avatar URLs", () => {
    const parsed = updateCompanyUserProfileSchema.parse({
      displayName: null,
      title: null,
      bio: null,
      location: null,
      timezone: null,
      avatarAssetId: null,
      socialLinks: [],
    });

    expect(parsed.avatarAssetId).toBeNull();
    expect(
      updateCompanyUserProfileSchema.safeParse({ avatarUrl: "https://example.com/avatar.png" }).success,
    ).toBe(false);
  });

  it("rejects empty or overlong text fields", () => {
    expect(updateCompanyUserProfileSchema.safeParse({ displayName: "   " }).success).toBe(false);
    expect(updateCompanyUserProfileSchema.safeParse({ displayName: "a".repeat(121) }).success).toBe(false);
    expect(updateCompanyUserProfileSchema.safeParse({ timezone: "a".repeat(81) }).success).toBe(false);
    expect(updateCompanyUserProfileSchema.safeParse({ bio: "a".repeat(2001) }).success).toBe(false);
  });

  it("rejects unsupported social link types and invalid URLs", () => {
    expect(HUMAN_SOCIAL_LINK_TYPES).toContain("linkedin");
    expect(HUMAN_SOCIAL_LINK_TYPES).toContain("other");
    expect(
      updateCompanyUserProfileSchema.safeParse({
        socialLinks: [{ type: "mastodon", label: "Mastodon", url: "https://example.com/@ada" }],
      }).success,
    ).toBe(false);
    expect(
      updateCompanyUserProfileSchema.safeParse({
        socialLinks: [{ type: "github", label: "GitHub", url: "not-a-url" }],
      }).success,
    ).toBe(false);
  });

  it("exposes profile fields on team members and dependencies include agent ids per tree", () => {
    expectTypeOf<HumanSocialLink["type"]>().toEqualTypeOf<
      | "linkedin"
      | "github"
      | "x"
      | "instagram"
      | "facebook"
      | "substack"
      | "website"
      | "portfolio"
      | "youtube"
      | "medium"
      | "other"
    >();
    expectTypeOf<CompanyUserProfile>().toMatchTypeOf<{
      companyId: string;
      userId: string;
      socialLinks: HumanSocialLink[];
      avatarAssetId: string | null;
    }>();
    expectTypeOf<TeamMemberSummary>().toMatchTypeOf<{
      title: string | null;
      bio: string | null;
      location: string | null;
      timezone: string | null;
      socialLinks: HumanSocialLink[];
      avatarAssetId: string | null;
      avatarUrl: string | null;
    }>();
    expectTypeOf<MemberDependencies["agentTrees"][number]>().toMatchTypeOf<{
      rootAgentId: string;
      agentIds: string[];
    }>();
    expectTypeOf<UpdateCompanyUserProfile>().toMatchTypeOf<{
      socialLinks?: HumanSocialLink[];
      avatarAssetId?: string | null;
    }>();
  });

  it("defines standard human capability documents with useful markdown scaffolds", () => {
    expect(STANDARD_HUMAN_CAPABILITY_DOCUMENTS.map((doc) => doc.filename)).toEqual([
      "resume.md",
      "skills.md",
      "responsibilities.md",
      "preferences.md",
      "availability.md",
      "background.md",
    ]);

    for (const doc of STANDARD_HUMAN_CAPABILITY_DOCUMENTS) {
      expect(doc.content).toContain(`# ${doc.title}`);
      expect(doc.content).toContain("## ");
      expect(doc.content.trim().length).toBeGreaterThan(40);
    }
  });

  it("validates custom human capability markdown documents safely", () => {
    const parsed = createHumanCapabilityDocumentSchema.parse({
      title: " Portfolio ",
      filename: " portfolio.md ",
      content: " # Work \n\nThings shipped.",
    });

    expect(parsed).toEqual({
      title: "Portfolio",
      filename: "portfolio.md",
      content: "# Work \n\nThings shipped.",
    });

    expect(createHumanCapabilityDocumentSchema.safeParse({ title: "Hack", filename: "../hack.md" }).success).toBe(false);
    expect(createHumanCapabilityDocumentSchema.safeParse({ title: "Hack", filename: "hack.txt" }).success).toBe(false);
    expect(createHumanCapabilityDocumentSchema.safeParse({ title: "Resume", filename: "resume.md" }).success).toBe(false);
  });

  it("validates human capability document updates", () => {
    const parsed = updateHumanCapabilityDocumentSchema.parse({
      title: " Updated Skills ",
      content: " ## Tools\nTypeScript ",
    });

    expect(parsed).toEqual({
      title: "Updated Skills",
      content: "## Tools\nTypeScript",
    });
    expect(updateHumanCapabilityDocumentSchema.safeParse({ title: "" }).success).toBe(false);
    expect(updateHumanCapabilityDocumentSchema.safeParse({ content: "x".repeat(100_001) }).success).toBe(false);
  });

  it("validates human discovery search inputs", () => {
    expect(searchHumansSchema.parse({ q: " product strategy " })).toEqual({
      q: "product strategy",
      role: "all",
      limit: 20,
    });
    expect(searchHumansSchema.parse({ q: "security", role: "team_lead", limit: 50 })).toEqual({
      q: "security",
      role: "team_lead",
      limit: 50,
    });

    expect(searchHumansSchema.safeParse({ q: "" }).success).toBe(false);
    expect(searchHumansSchema.safeParse({ q: "x", limit: 51 }).success).toBe(false);
    expect(searchHumansSchema.safeParse({ q: "x", role: "owner" }).success).toBe(false);
  });

  it("exposes human discovery response contracts", () => {
    expectTypeOf<HumanSearchResponse>().toMatchTypeOf<{
      companyId: string;
      query: string;
      results: Array<{
        userId: string;
        matchedFields: Array<"identity" | "authority" | "responsibility" | "capability_document">;
        snippets: Array<{ label: string; value: string }>;
        responsibilitySummary: {
          directHumanReportCount: number;
          directAgentTreeCount: number;
          assignedTaskCount: number;
          createdTaskCount: number;
        };
      }>;
    }>();
  });

  it("exposes human context resolution result contracts", () => {
    expectTypeOf<HumanContextResolutionResult>().toMatchTypeOf<{
      mode: "direct_context" | "resolved_context" | "multiple_matches" | "no_match";
      query: string | null;
      selectedHuman: HumanSearchResponse["results"][number] | null;
      candidates: HumanSearchResponse["results"];
      bundle: {
        companyId: string;
        userId: string;
        markdown: string;
      } | null;
    }>();
  });
});
