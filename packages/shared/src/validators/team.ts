import { z } from "zod";
import { USER_ROLES } from "../constants.js";
import type { HumanCapabilityDocumentTemplate, HumanSocialLinkType } from "../types/team.js";

export const HUMAN_SOCIAL_LINK_TYPES = [
  "linkedin",
  "github",
  "x",
  "instagram",
  "facebook",
  "substack",
  "website",
  "portfolio",
  "youtube",
  "medium",
  "other",
] as const satisfies readonly HumanSocialLinkType[];

const trimmedNullableString = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .nullable()
    .optional();

const socialLinkLabelSchema = z
  .string()
  .trim()
  .max(80)
  .nullable()
  .optional()
  .transform((value) => (value && value.length > 0 ? value : null));

export const humanSocialLinkSchema = z
  .object({
    type: z.enum(HUMAN_SOCIAL_LINK_TYPES),
    label: socialLinkLabelSchema,
    url: z.string().trim().url().max(2048),
  })
  .strict();

export const updateCompanyUserProfileSchema = z
  .object({
    displayName: trimmedNullableString(120),
    title: trimmedNullableString(160),
    bio: trimmedNullableString(2000),
    location: trimmedNullableString(120),
    timezone: trimmedNullableString(80),
    socialLinks: z.array(humanSocialLinkSchema).max(20).optional(),
    avatarAssetId: z.string().uuid().nullable().optional(),
  })
  .strict();

export type UpdateCompanyUserProfile = z.infer<typeof updateCompanyUserProfileSchema>;

export const STANDARD_HUMAN_CAPABILITY_DOCUMENTS = [
  {
    slug: "resume",
    filename: "resume.md",
    title: "Resume",
    kind: "resume",
    sortOrder: 10,
    content: `# Resume

## Summary

Add a short professional summary.

## Experience

- Role, company, dates, and impact.

## Education

- Degree, institution, dates.

## Achievements

- Notable outcomes, awards, launches, or metrics.

## Certifications

- Relevant certifications or training.
`,
  },
  {
    slug: "skills",
    filename: "skills.md",
    title: "Skills",
    kind: "skills",
    sortOrder: 20,
    content: `# Skills

## Core Skills

- Add the strongest skills this person can reliably contribute.

## Tools

- Add tools, platforms, frameworks, and systems.

## Domains

- Add industry, product, function, or customer domains.

## Languages

- Add spoken, written, or programming languages.

## Learning Areas

- Add skills currently being developed.
`,
  },
  {
    slug: "responsibilities",
    filename: "responsibilities.md",
    title: "Responsibilities",
    kind: "responsibilities",
    sortOrder: 30,
    content: `# Responsibilities

## Owned Areas

- Add the functions, systems, teams, or outcomes this person owns.

## Recurring Responsibilities

- Add ongoing rituals, reviews, reporting, or operational work.

## Decision Rights

- Add decisions this person can make or should be consulted on.

## Escalation Notes

- Add when and how agents or humans should escalate to this person.
`,
  },
  {
    slug: "preferences",
    filename: "preferences.md",
    title: "Preferences",
    kind: "preferences",
    sortOrder: 40,
    content: `# Preferences

## Communication

- Add preferred channels, tone, and level of detail.

## Collaboration

- Add how this person likes to work with humans and agents.

## Decision-Making

- Add preferred decision style, tradeoffs, and review expectations.

## Focus Style

- Add deep work, meeting, and interruption preferences.
`,
  },
  {
    slug: "availability",
    filename: "availability.md",
    title: "Availability",
    kind: "availability",
    sortOrder: 50,
    content: `# Availability

## Working Hours

- Add usual working hours and timezone notes.

## Response Expectations

- Add expected response windows by urgency.

## Planned Constraints

- Add upcoming travel, leave, or reduced-capacity periods.

## Capacity Notes

- Add areas where this person has or lacks bandwidth.
`,
  },
  {
    slug: "background",
    filename: "background.md",
    title: "Background",
    kind: "background",
    sortOrder: 60,
    content: `# Background

## Professional Background

- Add career context, founder story, or relevant history.

## Domain Context

- Add markets, customers, technologies, or problems this person understands well.

## Notable Projects

- Add projects, products, research, or companies this person has worked on.

## Operating Notes

- Add context agents should know when collaborating with this person.
`,
  },
] as const satisfies readonly HumanCapabilityDocumentTemplate[];

const STANDARD_HUMAN_CAPABILITY_FILENAMES: ReadonlySet<string> = new Set(
  STANDARD_HUMAN_CAPABILITY_DOCUMENTS.map((doc) => doc.filename),
);

const humanCapabilityFilenameSchema = z
  .string()
  .trim()
  .min(4)
  .max(120)
  .regex(/^[a-z0-9][a-z0-9-_]*\.md$/, "Filename must be a safe .md file name")
  .refine((filename) => !STANDARD_HUMAN_CAPABILITY_FILENAMES.has(filename), {
    message: "Standard capability document filenames are reserved",
  });

export const createHumanCapabilityDocumentSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    filename: humanCapabilityFilenameSchema,
    content: z.string().trim().max(100_000).optional().default(""),
  })
  .strict();

export type CreateHumanCapabilityDocument = z.infer<typeof createHumanCapabilityDocumentSchema>;

export const updateHumanCapabilityDocumentSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    content: z.string().trim().max(100_000).optional(),
  })
  .strict()
  .refine((value) => value.title !== undefined || value.content !== undefined, {
    message: "At least one field is required",
  });

export type UpdateHumanCapabilityDocument = z.infer<typeof updateHumanCapabilityDocumentSchema>;

export const searchHumansSchema = z
  .object({
    q: z.string().trim().min(1).max(200),
    role: z.union([z.enum(USER_ROLES), z.literal("all")]).optional().default("all"),
    departmentId: z.string().uuid().nullable().optional(),
    limit: z.coerce.number().int().min(1).max(50).optional().default(20),
  })
  .strict();

export type SearchHumans = z.infer<typeof searchHumansSchema>;

export const updateTeamMemberRoleSchema = z.object({
  role: z.enum(USER_ROLES),
  projectId: z.string().uuid().nullable().optional(),
  parentType: z.enum(["user"]).nullable().optional(),
  parentId: z.string().nullable().optional(),
});

export type UpdateTeamMemberRole = z.infer<typeof updateTeamMemberRoleSchema>;

export const addMemberSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email().max(320),
  role: z.enum(USER_ROLES),
  projectId: z.string().uuid().nullable().optional(),
  parentType: z.enum(["user"]).nullable().optional(),
  parentId: z.string().nullable().optional(),
});

export type AddMember = z.infer<typeof addMemberSchema>;

export const transferAdminSchema = z.object({
  toUserId: z.string().min(1),
  confirmation: z.literal("TRANSFER"),
});

export type TransferAdmin = z.infer<typeof transferAdminSchema>;

export const reassignAndRemoveSchema = z.object({
  humanReassignments: z.array(z.object({
    userId: z.string(),
    newParentId: z.string().nullable(),
  })),
  agentReassignments: z.array(z.object({
    agentId: z.string(),
    newParentId: z.string(),
    newParentType: z.literal("user"),
  })),
});

export type ReassignAndRemove = z.infer<typeof reassignAndRemoveSchema>;
