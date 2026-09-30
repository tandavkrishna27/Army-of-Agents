import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { userRoles } from "@armyofagents/db";
import type {
  GlobalSearchEntityType,
  GlobalSearchGroup,
  GlobalSearchResponse,
  GlobalSearchResult,
  UserRole,
} from "@armyofagents/shared";
import { deriveAgentUrlKey } from "@armyofagents/shared";

type Actor = {
  type: "none" | "board" | "agent" | "mcp" | "commander";
  source: string;
  userId?: string;
};

type SearchScope = {
  role: UserRole;
  userId: string | null;
  scopedProjectIds: Set<string>;
};

type SearchTaskRow = {
  id: string;
  identifier: string | null;
  title: string;
  subtitle: string | null;
  status: string;
  score: number | null;
  projectId: string | null;
  projectName: string | null;
  assigneeUserId: string | null;
};

type SearchGoalRow = {
  id: string;
  title: string;
  subtitle: string | null;
  status: string;
  score: number | null;
  projectIds: string[] | null;
  projectNames: string[] | null;
};

type SearchAgentRow = {
  id: string;
  name: string;
  title: string | null;
  role: string;
  status: string;
  score: number | null;
};

type SearchBriefRow = {
  id: string;
  title: string;
  subtitle: string | null;
  status: string;
  score: number | null;
  departmentId: string | null;
  projectId: string | null;
  departmentName: string | null;
};

type SearchMemoryRow = {
  id: string;
  title: string;
  subtitle: string | null;
  status: string;
  score: number | null;
  departmentId: string | null;
  projectId: string | null;
  departmentName: string | null;
  category: string;
  layer: string | null;
  visibility: string;
  taskAssigneeUserId: string | null;
};

type SearchArtifactRow = {
  id: string;
  title: string;
  subtitle: string | null;
  status: string;
  score: number | null;
  artifactType: string;
  currentVersionNumber: number | null;
  linkedIssueId: string | null;
  linkedIssueIdentifier: string | null;
  linkedIssueProjectId: string | null;
  linkedIssueAssigneeUserId: string | null;
};

type SearchSuggestionRow = {
  id: string;
  title: string;
  subtitle: string | null;
  status: string;
  score: number | null;
  category: string;
  relatedMemoryItemId: string | null;
  relatedMemoryDepartmentId: string | null;
  relatedMemoryProjectId: string | null;
  relatedMemoryVisibility: string | null;
  relatedMemoryTaskAssigneeUserId: string | null;
};

const GROUP_LABELS: Record<GlobalSearchEntityType, string> = {
  task: "Tasks",
  goal: "Goals",
  agent: "Agents",
  brief: "Briefs",
  memory: "Memory",
  artifact: "Artifacts",
  suggestion: "Suggestions",
};

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result) {
    return ((result as { rows?: T[] }).rows ?? []) as T[];
  }
  return [];
}

function excerpt(value: string | null | undefined, max = 100): string | null {
  const normalized = value?.trim().replace(/\s+/g, " ");
  if (!normalized) return null;
  return normalized.length > max ? `${normalized.slice(0, max - 1)}...` : normalized;
}

function toFiniteScore(value: number | string | null | undefined) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

async function resolveScope(db: Db, companyId: string, actor: Actor): Promise<SearchScope> {
  // Non-board bearer tokens (mcp / agent) are NEVER founder-equivalent for search.
  // A founder-created MCP key replays the founder's userId, which would otherwise
  // resolve to "founder" via the userRoles lookup and bypass ALL per-entity
  // visibility filtering (read-anyone). Confine them to team_member, owner-scoped
  // by the (possibly null) replayed userId; agents carry no userId and so see only
  // unscoped/shared entities (the null-safe checks in isVisibleToScope). Interactive
  // founder/role reach is via board sessions only. (Same board-gate pattern as the
  // sibling PR #194 / #195 authz fixes; intentionally stricter for mcp.)
  if (actor.type !== "board") {
    return { role: "team_member", userId: actor.userId ?? null, scopedProjectIds: new Set() };
  }
  if (actor.source === "local_implicit" || !actor.userId) {
    return { role: "founder", userId: actor.userId ?? null, scopedProjectIds: new Set() };
  }

  const assignments = await db
    .select({
      role: userRoles.role,
      projectId: userRoles.projectId,
    })
    .from(userRoles)
    .where(and(eq(userRoles.companyId, companyId), eq(userRoles.userId, actor.userId)));

  if (assignments.length === 0) {
    return { role: "founder", userId: actor.userId, scopedProjectIds: new Set() };
  }

  const roles = new Set(assignments.map((row) => row.role as UserRole));
  const role: UserRole = roles.has("founder")
    ? "founder"
    : roles.has("team_lead")
      ? "team_lead"
      : "team_member";

  return {
    role,
    userId: actor.userId,
    scopedProjectIds: new Set(
      assignments
        .map((row) => row.projectId)
        .filter((projectId): projectId is string => Boolean(projectId)),
    ),
  };
}

function isUnscoped(projectId?: string | null, departmentId?: string | null) {
  return !projectId && !departmentId;
}

function isVisibleToScope(
  result: GlobalSearchResult & Record<string, unknown>,
  scope: SearchScope,
): boolean {
  if (scope.role === "founder") return true;

  switch (result.type) {
    case "agent":
      return true;
    case "task":
      return scope.role === "team_lead"
        ? isUnscoped(result.projectId as string | null | undefined)
          || scope.scopedProjectIds.has((result.projectId as string | null) ?? "")
        : ((scope.userId != null && (result.assigneeUserId as string | null) === scope.userId)
          || isUnscoped(result.projectId as string | null | undefined));
    case "goal": {
      const projectIds = ((result.projectIds as string[] | null | undefined) ?? []).filter(Boolean);
      return scope.role === "team_lead"
        ? projectIds.length === 0 || projectIds.some((projectId) => scope.scopedProjectIds.has(projectId))
        : projectIds.length === 0;
    }
    case "brief":
      return scope.role === "team_lead"
        ? isUnscoped(
          result.projectId as string | null | undefined,
          result.departmentId as string | null | undefined,
        )
          || scope.scopedProjectIds.has((result.departmentId as string | null) ?? "")
          || scope.scopedProjectIds.has((result.projectId as string | null) ?? "")
        : isUnscoped(
          result.projectId as string | null | undefined,
          result.departmentId as string | null | undefined,
        );
    case "memory":
      if ((result.visibility as string | null) === "shared") return true;
      if (scope.role === "team_lead") {
        return scope.scopedProjectIds.has((result.departmentId as string | null) ?? "")
          || scope.scopedProjectIds.has((result.projectId as string | null) ?? "");
      }
      return scope.userId != null && (result.taskAssigneeUserId as string | null) === scope.userId;
    case "artifact":
      return scope.role === "team_lead"
        ? isUnscoped(result.linkedIssueProjectId as string | null | undefined)
          || scope.scopedProjectIds.has((result.linkedIssueProjectId as string | null) ?? "")
        : ((scope.userId != null && (result.linkedIssueAssigneeUserId as string | null) === scope.userId)
          || isUnscoped(result.linkedIssueProjectId as string | null | undefined));
    case "suggestion":
      if (!result.relatedMemoryItemId) return true;
      if ((result.relatedMemoryVisibility as string | null) === "shared") return true;
      if (scope.role === "team_lead") {
        return scope.scopedProjectIds.has((result.relatedMemoryDepartmentId as string | null) ?? "")
          || scope.scopedProjectIds.has((result.relatedMemoryProjectId as string | null) ?? "");
      }
      return scope.userId != null && (result.relatedMemoryTaskAssigneeUserId as string | null) === scope.userId;
    default:
      return false;
  }
}

export function searchService(db: Db) {
  return {
    search: async (
      companyId: string,
      input: {
        query: string;
        actor: Actor;
        includeArchived?: boolean;
        limitPerType?: number;
        /**
         * Phase 1 Phase E batch 3 (T24): when set, the brief/thread group is
         * pulled from `discussions` (instead of legacy `briefs+debriefs`) and
         * filtered by intent. The brief source is replaced — not augmented —
         * because the new producers all write to `discussions`.
         */
        intent?: string;
        /** Thread phase: `discuss | scope | assign | done`. See `THREAD_PHASES`. */
        phase?: string;
        /**
         * Participant filter formatted as `agent:<uuid>` or `user:<id>`.
         * Anything that doesn't parse cleanly is dropped silently — the
         * route validates URL shape; this is the service-level safety net.
         */
        participant?: string;
      },
    ): Promise<GlobalSearchResponse> => {
      const query = input.query.trim();
      if (!query) {
        return { query: "", tookMs: 0, totalCount: 0, groups: [] };
      }

      const startedAt = Date.now();
      const scope = await resolveScope(db, companyId, input.actor);
      const limitPerType = Math.max(1, Math.min(input.limitPerType ?? 8, 20));
      const fetchLimit = Math.max(limitPerType * 3, 24);
      const likePattern = `%${query}%`;
      const tsQuery = sql`websearch_to_tsquery('simple', ${query})`;

      // Phase 1 Phase E batch 3 (T24): parse participant once so both the
      // SQL EXISTS clause and the test contract see the same value.
      const participantParts = input.participant?.includes(":")
        ? input.participant.split(":", 2)
        : null;
      const participantType =
        participantParts?.[0] === "agent" || participantParts?.[0] === "user"
          ? participantParts[0]
          : null;
      const participantId = participantType ? participantParts![1] : null;
      // Trigger the discussions source whenever any thread-only filter is set.
      const useDiscussionsForBriefs =
        Boolean(input.intent) ||
        Boolean(input.phase) ||
        Boolean(participantId);

      const [
        taskRows,
        goalRows,
        agentRows,
        briefRows,
        memoryRows,
        artifactRows,
        suggestionRows,
      ] = await Promise.all([
        db.execute(sql`
          select
            i.id,
            i.identifier,
            i.title,
            i.description as subtitle,
            i.status,
            i.project_id as "projectId",
            p.name as "projectName",
            i.assignee_user_id as "assigneeUserId",
            greatest(
              ts_rank_cd(to_tsvector('simple', concat_ws(' ', coalesce(i.identifier, ''), i.title, coalesce(i.description, ''))), ${tsQuery}),
              case
                when i.title ilike ${likePattern} then 0.6
                when coalesce(i.description, '') ilike ${likePattern} then 0.35
                when coalesce(i.identifier, '') ilike ${likePattern} then 0.8
                else 0
              end
            ) as score
          from issues i
          left join projects p on p.id = i.project_id
          where i.company_id = ${companyId}
            and ${input.includeArchived ? sql`true` : sql`i.hidden_at is null`}
            and (
              to_tsvector('simple', concat_ws(' ', coalesce(i.identifier, ''), i.title, coalesce(i.description, ''))) @@ ${tsQuery}
              or i.title ilike ${likePattern}
              or coalesce(i.description, '') ilike ${likePattern}
              or coalesce(i.identifier, '') ilike ${likePattern}
            )
          order by score desc, i.updated_at desc
          limit ${fetchLimit}
        `),
        db.execute(sql`
          select
            g.id,
            g.title,
            g.description as subtitle,
            g.status,
            array_remove(array_agg(distinct pg.project_id), null) as "projectIds",
            array_remove(array_agg(distinct p.name), null) as "projectNames",
            greatest(
              ts_rank_cd(to_tsvector('simple', concat_ws(' ', g.title, coalesce(g.description, ''))), ${tsQuery}),
              case
                when g.title ilike ${likePattern} then 0.6
                when coalesce(g.description, '') ilike ${likePattern} then 0.35
                else 0
              end
            ) as score
          from goals g
          left join project_goals pg on pg.goal_id = g.id
          left join projects p on p.id = pg.project_id
          where g.company_id = ${companyId}
            and (
              to_tsvector('simple', concat_ws(' ', g.title, coalesce(g.description, ''))) @@ ${tsQuery}
              or g.title ilike ${likePattern}
              or coalesce(g.description, '') ilike ${likePattern}
            )
          group by g.id
          order by score desc, max(g.updated_at) desc
          limit ${fetchLimit}
        `),
        db.execute(sql`
          select
            a.id,
            a.name,
            a.title,
            a.role,
            a.status,
            greatest(
              ts_rank_cd(to_tsvector('simple', concat_ws(' ', a.name, coalesce(a.title, ''), a.role)), ${tsQuery}),
              case
                when a.name ilike ${likePattern} then 0.7
                when coalesce(a.title, '') ilike ${likePattern} then 0.4
                when a.role ilike ${likePattern} then 0.25
                else 0
              end
            ) as score
          from agents a
          where a.company_id = ${companyId}
            and (
              to_tsvector('simple', concat_ws(' ', a.name, coalesce(a.title, ''), a.role)) @@ ${tsQuery}
              or a.name ilike ${likePattern}
              or coalesce(a.title, '') ilike ${likePattern}
              or a.role ilike ${likePattern}
            )
          order by score desc, a.updated_at desc
          limit ${fetchLimit}
        `),
        // Phase 1 Phase E batch 3 (T24): if any thread-only filter is active
        // (intent/phase/participant), source the brief/thread group from
        // `discussions` so the filters can apply. Otherwise we preserve the
        // existing briefs+debriefs source to keep older tests + back-compat.
        useDiscussionsForBriefs
          ? db.execute(sql`
              select
                d.id,
                coalesce(d.title, 'Thread') as title,
                d.status,
                d.scope_id as "departmentId",
                null::uuid as "projectId",
                p.name as "departmentName",
                left(coalesce(d.summary_text, ''), 160) as subtitle,
                greatest(
                  ts_rank_cd(
                    to_tsvector(
                      'simple',
                      concat_ws(
                        ' ',
                        coalesce(d.title, ''),
                        coalesce(d.summary_text, '')
                      )
                    ),
                    ${tsQuery}
                  ),
                  case
                    when coalesce(d.title, '') ilike ${likePattern} then 0.6
                    when coalesce(d.summary_text, '') ilike ${likePattern} then 0.3
                    else 0
                  end
                ) as score
              from discussions d
              left join projects p on p.id = d.scope_id
              where d.company_id = ${companyId}
                and (
                  to_tsvector(
                    'simple',
                    concat_ws(
                      ' ',
                      coalesce(d.title, ''),
                      coalesce(d.summary_text, '')
                    )
                  ) @@ ${tsQuery}
                  or coalesce(d.title, '') ilike ${likePattern}
                  or coalesce(d.summary_text, '') ilike ${likePattern}
                )
                ${input.intent ? sql`and d.intent @> ${JSON.stringify([input.intent])}::jsonb` : sql``}
                ${input.phase ? sql`and d.phase = ${input.phase}` : sql``}
                ${participantType && participantId ? sql`
                  and exists (
                    select 1 from thread_participants tp
                    where tp.thread_id = d.id
                      and tp.principal_type = ${participantType}
                      and tp.principal_id = ${participantId}
                  )
                ` : sql``}
              order by score desc, d.updated_at desc
              limit ${fetchLimit}
            `)
          : db.execute(sql`
              select
                b.id,
                coalesce(d.title, 'Brief') as title,
                b.status,
                b.department_id as "departmentId",
                b.project_id as "projectId",
                p.name as "departmentName",
                left(coalesce(d.raw_content, ''), 160) as subtitle,
                greatest(
                  ts_rank_cd(
                    to_tsvector(
                      'simple',
                      concat_ws(
                        ' ',
                        coalesce(d.title, ''),
                        coalesce(d.raw_content, ''),
                        coalesce((
                          select string_agg(concat_ws(' ', bi.title, coalesce(bi.description, '')), ' ')
                          from brief_items bi
                          where bi.brief_id = b.id
                        ), '')
                      )
                    ),
                    ${tsQuery}
                  ),
                  case
                    when coalesce(d.title, '') ilike ${likePattern} then 0.6
                    when coalesce(d.raw_content, '') ilike ${likePattern} then 0.3
                    else 0
                  end
                ) as score
              from briefs b
              inner join debriefs d on d.id = b.debrief_id
              left join projects p on p.id = b.department_id
              where b.company_id = ${companyId}
                and (
                  to_tsvector(
                    'simple',
                    concat_ws(
                      ' ',
                      coalesce(d.title, ''),
                      coalesce(d.raw_content, ''),
                      coalesce((
                        select string_agg(concat_ws(' ', bi.title, coalesce(bi.description, '')), ' ')
                        from brief_items bi
                        where bi.brief_id = b.id
                      ), '')
                    )
                  ) @@ ${tsQuery}
                  or coalesce(d.title, '') ilike ${likePattern}
                  or coalesce(d.raw_content, '') ilike ${likePattern}
                )
              order by score desc, b.updated_at desc
              limit ${fetchLimit}
            `),
        db.execute(sql`
          select
            m.id,
            m.title,
            m.content as subtitle,
            m.status,
            m.department_id as "departmentId",
            m.project_id as "projectId",
            p.name as "departmentName",
            m.category,
            m.layer,
            m.visibility,
            i.assignee_user_id as "taskAssigneeUserId",
            greatest(
              ts_rank_cd(to_tsvector('simple', concat_ws(' ', m.title, m.content, coalesce(m.source_context, ''))), ${tsQuery}),
              case
                when m.title ilike ${likePattern} then 0.6
                when m.content ilike ${likePattern} then 0.4
                else 0
              end
            ) as score
          from memory_items m
          left join projects p on p.id = m.department_id
          left join issues i on i.id = m.task_id
          where m.company_id = ${companyId}
            and ${input.includeArchived ? sql`true` : sql`m.status <> 'archived'`}
            and (
              to_tsvector('simple', concat_ws(' ', m.title, m.content, coalesce(m.source_context, ''))) @@ ${tsQuery}
              or m.title ilike ${likePattern}
              or m.content ilike ${likePattern}
            )
          order by score desc, m.updated_at desc
          limit ${fetchLimit}
        `),
        db.execute(sql`
          select
            a.id,
            a.title,
            a.description as subtitle,
            a.status,
            a.type as "artifactType",
            av.version_number as "currentVersionNumber",
            i.id as "linkedIssueId",
            i.identifier as "linkedIssueIdentifier",
            i.project_id as "linkedIssueProjectId",
            i.assignee_user_id as "linkedIssueAssigneeUserId",
            greatest(
              ts_rank_cd(
                to_tsvector(
                  'simple',
                  concat_ws(' ', a.title, coalesce(a.description, ''), coalesce(av.changelog, ''), coalesce(av.content, ''))
                ),
                ${tsQuery}
              ),
              case
                when a.title ilike ${likePattern} then 0.6
                when coalesce(a.description, '') ilike ${likePattern} then 0.35
                else 0
              end
            ) as score
          from artifacts a
          left join artifact_versions av on av.id = a.current_version_id
          left join issues i on i.artifact_id = a.id and i.hidden_at is null
          where a.company_id = ${companyId}
            and ${input.includeArchived ? sql`true` : sql`a.status <> 'archived'`}
            and (
              to_tsvector(
                'simple',
                concat_ws(' ', a.title, coalesce(a.description, ''), coalesce(av.changelog, ''), coalesce(av.content, ''))
              ) @@ ${tsQuery}
              or a.title ilike ${likePattern}
              or coalesce(a.description, '') ilike ${likePattern}
            )
          order by score desc, a.updated_at desc
          limit ${fetchLimit}
        `),
        db.execute(sql`
          select
            s.id,
            s.title,
            s.evidence as subtitle,
            s.status,
            s.category,
            s.related_memory_item_id as "relatedMemoryItemId",
            m.department_id as "relatedMemoryDepartmentId",
            m.project_id as "relatedMemoryProjectId",
            m.visibility as "relatedMemoryVisibility",
            i.assignee_user_id as "relatedMemoryTaskAssigneeUserId",
            greatest(
              ts_rank_cd(to_tsvector('simple', concat_ws(' ', s.title, coalesce(s.evidence, ''))), ${tsQuery}),
              case
                when s.title ilike ${likePattern} then 0.6
                when coalesce(s.evidence, '') ilike ${likePattern} then 0.35
                else 0
              end
            ) as score
          from suggestions s
          left join memory_items m on m.id = s.related_memory_item_id
          left join issues i on i.id = m.task_id
          where s.company_id = ${companyId}
            and s.status = 'pending'
            and (
              to_tsvector('simple', concat_ws(' ', s.title, coalesce(s.evidence, ''))) @@ ${tsQuery}
              or s.title ilike ${likePattern}
              or coalesce(s.evidence, '') ilike ${likePattern}
            )
          order by score desc, s.updated_at desc
          limit ${fetchLimit}
        `),
      ]);

      const allResults: GlobalSearchResult[] = [
        ...resultRows<SearchTaskRow>(taskRows).map((row) => ({
          id: row.id,
          type: "task" as const,
          title: row.title,
          subtitle: excerpt(row.subtitle),
          href: `/issues/${row.identifier ?? row.id}`,
          score: toFiniteScore(row.score),
          identifier: row.identifier,
          status: row.status,
          departmentName: row.projectName,
          projectId: row.projectId,
          assigneeUserId: row.assigneeUserId,
        })),
        ...resultRows<SearchGoalRow>(goalRows).map((row) => ({
          id: row.id,
          type: "goal" as const,
          title: row.title,
          subtitle: row.projectNames?.length ? row.projectNames.join(", ") : excerpt(row.subtitle),
          href: `/goals/${row.id}`,
          score: toFiniteScore(row.score),
          status: row.status,
          projectIds: row.projectIds ?? [],
        })),
        ...resultRows<SearchAgentRow>(agentRows).map((row) => ({
          id: row.id,
          type: "agent" as const,
          title: row.name,
          subtitle: row.title,
          href: `/agents/${deriveAgentUrlKey(row.name, row.id)}`,
          score: toFiniteScore(row.score),
          role: row.role,
          status: row.status,
        })),
        ...resultRows<SearchBriefRow>(briefRows).map((row) => ({
          id: row.id,
          type: "brief" as const,
          title: row.title,
          subtitle: excerpt(row.subtitle),
          href: `/discussions/${row.id}`,
          score: toFiniteScore(row.score),
          status: row.status,
          departmentName: row.departmentName,
          departmentId: row.departmentId,
          projectId: row.projectId,
        })),
        ...resultRows<SearchMemoryRow>(memoryRows).map((row) => ({
          id: row.id,
          type: "memory" as const,
          title: row.title,
          subtitle: excerpt(row.subtitle),
          href: `/memory/explore?item=${encodeURIComponent(row.id)}`,
          score: toFiniteScore(row.score),
          status: row.status,
          departmentName: row.departmentName,
          category: row.category,
          layer: row.layer,
          visibility: row.visibility,
          departmentId: row.departmentId,
          projectId: row.projectId,
          taskAssigneeUserId: row.taskAssigneeUserId,
        })),
        ...resultRows<SearchArtifactRow>(artifactRows).map((row) => ({
          id: row.id,
          type: "artifact" as const,
          title: row.title,
          subtitle: excerpt(row.subtitle),
          href: row.linkedIssueIdentifier || row.linkedIssueId
            ? `/issues/${row.linkedIssueIdentifier ?? row.linkedIssueId}`
            : "/issues",
          score: toFiniteScore(row.score),
          status: row.status,
          artifactType: row.artifactType,
          currentVersionNumber: row.currentVersionNumber,
          linkedIssueProjectId: row.linkedIssueProjectId,
          linkedIssueAssigneeUserId: row.linkedIssueAssigneeUserId,
        })),
        ...resultRows<SearchSuggestionRow>(suggestionRows).map((row) => ({
          id: row.id,
          type: "suggestion" as const,
          title: row.title,
          subtitle: excerpt(row.subtitle),
          href: row.relatedMemoryItemId
            ? `/memory?tab=suggestions&item=${encodeURIComponent(row.relatedMemoryItemId)}`
            : "/home",
          score: toFiniteScore(row.score),
          status: row.status,
          suggestionCategory: row.category,
          relatedMemoryItemId: row.relatedMemoryItemId,
          relatedMemoryDepartmentId: row.relatedMemoryDepartmentId,
          relatedMemoryProjectId: row.relatedMemoryProjectId,
          relatedMemoryVisibility: row.relatedMemoryVisibility,
          relatedMemoryTaskAssigneeUserId: row.relatedMemoryTaskAssigneeUserId,
        })),
      ]
        .filter((result) => {
          if (input.includeArchived) return true;
          if (result.type === "memory" || result.type === "artifact") {
            return result.status !== "archived";
          }
          if (result.type === "suggestion") {
            return result.status === "pending";
          }
          return true;
        })
        .filter((result) => isVisibleToScope(result as GlobalSearchResult & Record<string, unknown>, scope))
        .sort((a, b) => b.score - a.score);

      const groups: GlobalSearchGroup[] = (Object.keys(GROUP_LABELS) as GlobalSearchEntityType[])
        .map((type) => {
          const items = allResults.filter((result) => result.type === type).slice(0, limitPerType);
          if (items.length === 0) return null;
          return {
            type,
            label: GROUP_LABELS[type],
            count: items.length,
            items,
          };
        })
        .filter((group): group is GlobalSearchGroup => Boolean(group));

      return {
        query,
        tookMs: Date.now() - startedAt,
        totalCount: groups.reduce((sum, group) => sum + group.count, 0),
        groups,
      };
    },
  };
}
