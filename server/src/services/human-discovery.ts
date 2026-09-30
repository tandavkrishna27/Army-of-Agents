import type { Db } from "@armyofagents/db";
import { companyUserCapabilityDocuments } from "@armyofagents/db";
import type {
  HumanCapabilityDocumentKind,
  HumanSearchMatchedField,
  HumanSearchMatchSnippet,
  HumanSearchResponse,
  HumanSearchResult,
  SearchHumansInput,
  TeamMemberSummary,
} from "@armyofagents/shared";
import { and, eq, inArray } from "drizzle-orm";
import { teamService } from "./team.js";

type CapabilityDocumentRow = {
  id: string;
  companyId: string;
  userId: string;
  filename: string;
  title: string;
  kind: HumanCapabilityDocumentKind;
  content: string;
};

function normalize(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function includesQuery(value: string | null | undefined, query: string): boolean {
  return normalize(value).includes(query);
}

function snippetFor(value: string, query: string, radius = 64): string {
  const compact = value.replace(/\s+/g, " ").trim();
  const idx = compact.toLowerCase().indexOf(query);
  if (idx === -1) return compact.slice(0, radius * 2);
  const start = Math.max(0, idx - radius);
  const end = Math.min(compact.length, idx + query.length + radius);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < compact.length ? "..." : "";
  return `${prefix}${compact.slice(start, end)}${suffix}`;
}

function addSnippet(
  snippets: HumanSearchMatchSnippet[],
  matchedFields: Set<HumanSearchMatchedField>,
  snippet: HumanSearchMatchSnippet,
) {
  matchedFields.add(snippet.field);
  if (snippets.length >= 3) return;
  if (snippets.some((existing) => existing.field === snippet.field && existing.label === snippet.label)) return;
  snippets.push(snippet);
}

function displayFor(member: TeamMemberSummary) {
  return member.displayName ?? member.email ?? member.userId;
}

function resultDisplay(result: HumanSearchResult) {
  return result.displayName ?? result.email ?? result.userId;
}

function scoreText(value: string | null | undefined, query: string, exactWeight: number, containsWeight: number) {
  const normalized = normalize(value);
  if (!normalized) return 0;
  if (normalized === query) return exactWeight;
  if (normalized.includes(query)) return containsWeight;
  return 0;
}

export function humanDiscoveryService(db: Db) {
  const team = teamService(db);

  async function search(companyId: string, input: SearchHumansInput): Promise<HumanSearchResponse> {
    const query = input.q.trim();
    const normalizedQuery = normalize(query);
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
    const role = input.role ?? "all";

    const summary = await team.listTeam(companyId, null);
    const memberById = new Map(summary.members.map((member) => [member.userId, member]));
    const candidates = summary.members.filter((member) => {
      if (role !== "all" && member.role !== role) return false;
      if (input.departmentId !== undefined && input.departmentId !== null && member.departmentId !== input.departmentId) {
        return false;
      }
      return true;
    });
    const candidateIds = candidates.map((member) => member.userId);

    const documents = candidateIds.length
      ? await db
          .select()
          .from(companyUserCapabilityDocuments)
          .where(
            and(
              eq(companyUserCapabilityDocuments.companyId, companyId),
              inArray(companyUserCapabilityDocuments.userId, candidateIds),
            ),
          )
      : [];

    const docsByUserId = new Map<string, CapabilityDocumentRow[]>();
    for (const doc of documents as CapabilityDocumentRow[]) {
      if (doc.companyId !== companyId || !candidateIds.includes(doc.userId)) continue;
      const docs = docsByUserId.get(doc.userId) ?? [];
      docs.push(doc);
      docsByUserId.set(doc.userId, docs);
    }

    const scored: Array<{ score: number; result: HumanSearchResult }> = [];
    for (const member of candidates) {
      let score = 0;
      const snippets: HumanSearchMatchSnippet[] = [];
      const matchedFields = new Set<HumanSearchMatchedField>();
      const manager = member.parentId ? memberById.get(member.parentId) : null;

      const identityFields = [
        ["Name", member.displayName, 100, 80],
        ["Email", member.email, 95, 70],
        ["Title", member.title, 90, 65],
        ["Bio", member.bio, 75, 45],
        ["Location", member.location, 35, 20],
        ["Timezone", member.timezone, 35, 20],
      ] as const;
      for (const [label, value, exactWeight, containsWeight] of identityFields) {
        const fieldScore = scoreText(value, normalizedQuery, exactWeight, containsWeight);
        if (fieldScore > 0) {
          score += fieldScore;
          addSnippet(snippets, matchedFields, {
            field: "identity",
            label,
            value: snippetFor(value ?? "", normalizedQuery),
          });
        }
      }

      const authorityFields = [
        ["Role", member.role, 65, 45],
        ["Department", member.departmentName, 70, 50],
        ["Reports to", manager?.displayName ?? manager?.email ?? null, 55, 35],
      ] as const;
      for (const [label, value, exactWeight, containsWeight] of authorityFields) {
        const fieldScore = scoreText(value, normalizedQuery, exactWeight, containsWeight);
        if (fieldScore > 0) {
          score += fieldScore;
          addSnippet(snippets, matchedFields, {
            field: "authority",
            label,
            value: snippetFor(value ?? "", normalizedQuery),
          });
        }
      }

      for (const doc of docsByUserId.get(member.userId) ?? []) {
        const titleScore = scoreText(doc.title, normalizedQuery, 60, 40);
        const filenameScore = scoreText(doc.filename, normalizedQuery, 55, 35);
        const contentScore = scoreText(doc.content, normalizedQuery, 45, 25);
        if (titleScore + filenameScore + contentScore > 0) {
          score += titleScore + filenameScore + contentScore;
          addSnippet(snippets, matchedFields, {
            field: "capability_document",
            label: doc.title,
            value: snippetFor(contentScore > 0 ? doc.content : `${doc.title} ${doc.filename}`, normalizedQuery),
            documentId: doc.id,
            filename: doc.filename,
          });
        }
      }

      if (score === 0) continue;

      const dependencies = await team.getDependencies(companyId, member.userId);
      scored.push({
        score,
        result: {
          userId: member.userId,
          email: member.email,
          displayName: member.displayName,
          avatarUrl: member.avatarUrl,
          title: member.title,
          role: member.role,
          departmentId: member.departmentId,
          departmentName: member.departmentName,
          reportsToUserId: member.parentId,
          reportsToName: manager ? displayFor(manager) : null,
          matchedFields: Array.from(matchedFields),
          snippets,
          responsibilitySummary: {
            directHumanReportCount: dependencies.teamMembers.length,
            directAgentTreeCount: dependencies.agentTrees.length,
            assignedTaskCount: dependencies.assignedTaskCount,
            createdTaskCount: dependencies.createdTaskCount,
          },
        },
      });
    }

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return resultDisplay(a.result).localeCompare(resultDisplay(b.result));
    });

    return {
      companyId,
      query,
      results: scored.slice(0, limit).map((entry) => entry.result),
    };
  }

  return { search };
}
