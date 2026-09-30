import type { Db } from "@armyofagents/db";
import type { HumanContextBundle } from "@armyofagents/shared";
import { notFound } from "../errors.js";
import { humanCapabilitiesService } from "./human-capabilities.js";
import { teamService } from "./team.js";

function line(value: string | null | undefined, fallback = "Not set") {
  return value && value.trim() ? value.trim() : fallback;
}

export function renderHumanContextMarkdown(bundle: Omit<HumanContextBundle, "markdown">): string {
  const parts: string[] = [];
  parts.push("# Human Context");
  parts.push("");
  parts.push("## Identity");
  parts.push(`- Name: ${line(bundle.identity.displayName)}`);
  parts.push(`- Email: ${line(bundle.identity.email)}`);
  parts.push(`- Title: ${line(bundle.identity.title)}`);
  parts.push(`- Bio: ${line(bundle.identity.bio)}`);
  parts.push(`- Location: ${line(bundle.identity.location)}`);
  parts.push(`- Timezone: ${line(bundle.identity.timezone)}`);

  if (bundle.identity.socialLinks.length > 0) {
    parts.push("- Social links:");
    for (const link of bundle.identity.socialLinks) {
      parts.push(`  - ${line(link.label, link.type)}: ${link.url}`);
    }
  }

  parts.push("");
  parts.push("## Authority");
  parts.push(`- Role: ${bundle.authority.role}`);
  parts.push(`- Department: ${line(bundle.authority.departmentName)}`);
  parts.push(`- Reports to: ${line(bundle.authority.reportsToName)}`);
  parts.push(`- System admin: ${bundle.authority.isSystemAdmin ? "yes" : "no"}`);
  parts.push(`- Explicit grants: ${bundle.authority.explicitGrants.length ? bundle.authority.explicitGrants.join(", ") : "none"}`);

  parts.push("");
  parts.push("## Responsibilities");
  parts.push(`- Direct human reports: ${bundle.responsibility.directHumanReports.length}`);
  parts.push(`- Direct agent trees: ${bundle.responsibility.directAgentTrees.length}`);
  parts.push(`- Active assigned tasks: ${bundle.responsibility.assignedTaskCount}`);
  parts.push(`- Active created tasks: ${bundle.responsibility.createdTaskCount}`);

  parts.push("");
  parts.push("## Capability Documents");
  if (bundle.capabilities.length === 0) {
    parts.push("_No capability documents._");
  } else {
    for (const doc of bundle.capabilities) {
      parts.push("");
      parts.push(`### ${doc.title} (${doc.filename})`);
      parts.push(doc.content.trim() ? doc.content.trim() : "_Empty document._");
    }
  }

  return parts.join("\n");
}

export function humanContextService(db: Db) {
  const team = teamService(db);
  const capabilities = humanCapabilitiesService(db);

  async function getBundle(companyId: string, userId: string, actorUserId: string | null = null): Promise<HumanContextBundle> {
    const summary = await team.listTeam(companyId, actorUserId);
    const member = summary.members.find((row) => row.userId === userId);
    if (!member) {
      throw notFound("Team member not found");
    }

    const manager = member.parentId ? summary.members.find((row) => row.userId === member.parentId) : null;
    const dependencies = await team.getDependencies(companyId, userId);
    const capabilityBundle = await capabilities.listDocuments(companyId, userId, actorUserId);
    const generatedAt = new Date();

    const withoutMarkdown: Omit<HumanContextBundle, "markdown"> = {
      companyId,
      userId,
      generatedAt,
      identity: {
        userId,
        email: member.email,
        displayName: member.displayName,
        title: member.title,
        bio: member.bio,
        location: member.location,
        timezone: member.timezone,
        socialLinks: member.socialLinks,
      },
      authority: {
        role: member.role,
        departmentId: member.departmentId,
        departmentName: member.departmentName,
        reportsToUserId: member.parentId,
        reportsToName: manager?.displayName ?? manager?.email ?? null,
        isSystemAdmin: member.isSystemAdmin,
        explicitGrants: member.permissions,
      },
      responsibility: {
        directHumanReports: dependencies.teamMembers,
        directAgentTrees: dependencies.agentTrees,
        assignedTaskCount: dependencies.assignedTaskCount,
        createdTaskCount: dependencies.createdTaskCount,
      },
      capabilities: capabilityBundle.documents.map((doc) => ({
        id: doc.id,
        slug: doc.slug,
        filename: doc.filename,
        title: doc.title,
        kind: doc.kind,
        content: doc.content,
        isStandard: doc.isStandard,
        updatedAt: doc.updatedAt,
        updatedByUserId: doc.updatedByUserId,
      })),
    };

    return {
      ...withoutMarkdown,
      markdown: renderHumanContextMarkdown(withoutMarkdown),
    };
  }

  return { getBundle, renderHumanContextMarkdown };
}
