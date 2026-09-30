# Human Discovery / Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only, company-scoped way for humans and Commander to discover the right human by profile, role, responsibility, and capability knowledge.

**Architecture:** Build one shared backend discovery service that searches existing team profile data, role/department metadata, responsibility summaries, and capability markdown documents. Expose it through a Team -> Humans UI route and through a Commander/internal-agent query tool named `find_humans`. Keep the scope read-only and do not inject human context into task runs in this phase.

**Tech Stack:** Express 5 routes, Drizzle ORM, shared TypeScript contracts and Zod validators, React/Vite, TanStack Query, Vitest, Playwright.

---

## Product Decisions

- Top-level app area remains `Team`.
- Human-specific UI labels use `Humans` and person names; do not expose `board` as a human-facing person label.
- Discovery lives on the existing Team page's Humans tab/list.
- Commander/internal agent gets a read-only `find_humans` tool.
- The same backend service powers UI search and Commander search.
- This scope does not add automatic task/run context injection.
- This scope does not expose the search to external MCP or ordinary worker-agent callers.
- This scope does not add embeddings/vector search; start with deterministic database-backed text matching.
- This scope does not add document-level privacy labels because auth/RBAC hardening is a later phase.

## Search Contract

### Request

```ts
interface SearchHumansInput {
  q: string;
  role?: UserRole | "all";
  departmentId?: string | null;
  limit?: number;
}
```

Validation:

- `q` is trimmed and required for server search.
- `q` length is `1..200`.
- `limit` defaults to `20`, max `50`.
- `role` defaults to `"all"`.
- `departmentId` filters active company members only when provided.

### Response

```ts
type HumanSearchMatchedField =
  | "identity"
  | "authority"
  | "responsibility"
  | "capability_document";

interface HumanSearchMatchSnippet {
  field: HumanSearchMatchedField;
  label: string;
  value: string;
  documentId?: string;
  filename?: string;
}

interface HumanSearchResult {
  userId: string;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  title: string | null;
  role: UserRole;
  departmentId: string | null;
  departmentName: string | null;
  reportsToUserId: string | null;
  reportsToName: string | null;
  matchedFields: HumanSearchMatchedField[];
  snippets: HumanSearchMatchSnippet[];
  responsibilitySummary: {
    directHumanReportCount: number;
    directAgentTreeCount: number;
    assignedTaskCount: number;
    createdTaskCount: number;
  };
}

interface HumanSearchResponse {
  companyId: string;
  query: string;
  results: HumanSearchResult[];
}
```

Ranking:

1. Identity exact-ish matches: display name, email, title.
2. Authority matches: role, department, reports-to name.
3. Capability document title/filename matches.
4. Capability document content matches.
5. Responsibility summary fields.

Each result should include at most `3` snippets. Snippets should be short enough for UI cards and tool summaries.

---

## File Structure

- Modify `packages/shared/src/types/team.ts` to add search request/response types.
- Modify `packages/shared/src/validators/team.ts` to add `searchHumansSchema`.
- Modify `packages/shared/src/types/index.ts`, `packages/shared/src/index.ts`, and `packages/shared/src/validators/index.ts` to export the contracts.
- Create `server/src/services/human-discovery.ts` for read-only search composition and ranking.
- Modify `server/src/services/index.ts` and `server/src/services/internal-agent/service-container.ts` to expose the service.
- Modify `server/src/routes/team.ts` to add `GET /companies/:companyId/team/humans/search`.
- Modify `server/src/services/internal-agent/types.ts` if the internal tool context needs the new service typed.
- Modify `server/src/services/internal-agent/tools/query-tools.ts` to add `find_humans`.
- Modify `ui/src/api/team.ts` and `ui/src/lib/queryKeys.ts` for the search API/query key.
- Modify `ui/src/components/team/HumansTab.tsx` to use server search when a query is present, while preserving existing role and pending filters.
- Modify `ui/src/components/team/__tests__/HumansTab.test.tsx` for UI coverage.
- Create backend tests:
  - `server/src/__tests__/human-discovery-service.test.ts`
  - `server/src/__tests__/human-discovery-routes.test.ts`
  - `server/src/__tests__/find-humans-tool.test.ts`
- Extend `tests/e2e/human-profile.spec.ts` or create `tests/e2e/human-discovery.spec.ts` for UI search.

---

## Task 1: Shared Contracts

**Files:**
- Modify: `packages/shared/src/types/team.ts`
- Modify: `packages/shared/src/validators/team.ts`
- Modify: `packages/shared/src/types/index.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/src/validators/index.ts`
- Test: `packages/shared/src/__tests__/team-profile-schema.test.ts`

- [ ] **Step 1: Write failing shared validator/type tests**

Add tests covering:

```ts
searchHumansSchema.parse({ q: "product strategy" });
searchHumansSchema.parse({ q: "security", role: "team_lead", limit: 50 });
expect(() => searchHumansSchema.parse({ q: "" })).toThrow();
expect(() => searchHumansSchema.parse({ q: "x", limit: 51 })).toThrow();
expect(() => searchHumansSchema.parse({ q: "x", role: "owner" })).toThrow();
```

- [ ] **Step 2: Run the focused shared tests and verify failure**

Run:

```bash
pnpm --filter @armyofagents/shared test -- team-profile-schema.test.ts
```

Expected: fails because `searchHumansSchema` and search types do not exist.

- [ ] **Step 3: Add shared types**

Add `SearchHumansInput`, `HumanSearchMatchedField`, `HumanSearchMatchSnippet`, `HumanSearchResult`, and `HumanSearchResponse` to `packages/shared/src/types/team.ts`.

- [ ] **Step 4: Add validator**

Add `searchHumansSchema` to `packages/shared/src/validators/team.ts` with:

```ts
export const searchHumansSchema = z
  .object({
    q: z.string().trim().min(1).max(200),
    role: z.union([z.enum(USER_ROLES), z.literal("all")]).optional().default("all"),
    departmentId: z.string().uuid().nullable().optional(),
    limit: z.coerce.number().int().min(1).max(50).optional().default(20),
  })
  .strict();
```

- [ ] **Step 5: Export contracts**

Export the new types and validator through the shared barrel files.

- [ ] **Step 6: Verify focused shared tests pass**

Run:

```bash
pnpm --filter @armyofagents/shared test -- team-profile-schema.test.ts
```

Expected: PASS.

---

## Task 2: Human Discovery Service

**Files:**
- Create: `server/src/services/human-discovery.ts`
- Modify: `server/src/services/index.ts`
- Test: `server/src/__tests__/human-discovery-service.test.ts`

- [ ] **Step 1: Write failing service tests**

Cover:

- searches active members only inside the requested company
- matches profile fields such as display name, email, title, and bio
- matches role and department names
- matches capability document title, filename, and content
- returns snippets explaining why the human matched
- respects `role`, `departmentId`, and `limit`
- excludes users from another company

- [ ] **Step 2: Run focused service tests and verify failure**

Run:

```bash
pnpm --filter server test -- human-discovery-service.test.ts
```

Expected: fails because `humanDiscoveryService` does not exist.

- [ ] **Step 3: Implement `humanDiscoveryService(db)`**

Implement:

```ts
export function humanDiscoveryService(db: Db) {
  async function search(companyId: string, input: SearchHumansInput): Promise<HumanSearchResponse> {
    // 1. Load active human team members through teamService(db).listTeam(companyId, null).
    // 2. Apply role and department filters.
    // 3. Load capability documents for candidate userIds from company_user_capability_documents.
    // 4. Build weighted matches over identity, authority, responsibility, and docs.
    // 5. Sort by score, then display name/email.
    // 6. Return limited HumanSearchResult[].
  }

  return { search };
}
```

Use a small helper set:

```ts
function normalize(value: string | null | undefined): string;
function includesQuery(value: string | null | undefined, query: string): boolean;
function snippetFor(value: string, query: string, radius?: number): string;
```

- [ ] **Step 4: Export the service**

Add it to `server/src/services/index.ts`.

- [ ] **Step 5: Verify focused service tests pass**

Run:

```bash
pnpm --filter server test -- human-discovery-service.test.ts
```

Expected: PASS.

---

## Task 3: Board API Route

**Files:**
- Modify: `server/src/routes/team.ts`
- Test: `server/src/__tests__/human-discovery-routes.test.ts`

- [ ] **Step 1: Write failing route tests**

Cover:

- `GET /companies/:companyId/team/humans/search?q=product%20strategy` returns search results
- missing `q` returns `400`
- invalid `limit` returns `400`
- cross-company content is not returned
- response shape includes snippets and responsibility summary

- [ ] **Step 2: Run focused route tests and verify failure**

Run:

```bash
pnpm --filter server test -- human-discovery-routes.test.ts
```

Expected: fails because route does not exist.

- [ ] **Step 3: Add route**

Add before `GET /companies/:companyId/team/users/:userId` so `humans/search` is not captured as a `userId`:

```ts
router.get("/companies/:companyId/team/humans/search", async (req, res) => {
  const input = searchHumansSchema.parse(req.query);
  const result = await humanDiscoveryService(req.db).search(req.params.companyId, input);
  res.json(result);
});
```

Use the repo's existing async error handling and request DB access pattern from adjacent team routes.

- [ ] **Step 4: Verify focused route tests pass**

Run:

```bash
pnpm --filter server test -- human-discovery-routes.test.ts
```

Expected: PASS.

---

## Task 4: Commander Internal Tool

**Files:**
- Modify: `server/src/services/internal-agent/types.ts`
- Modify: `server/src/services/internal-agent/service-container.ts`
- Modify: `server/src/services/internal-agent/tools/query-tools.ts`
- Test: `server/src/__tests__/find-humans-tool.test.ts`
- Test: `server/src/__tests__/tool-registry.test.ts`
- Test: `server/src/__tests__/query-tools.test.ts`

- [ ] **Step 1: Write failing tool tests**

Cover:

- tool named `find_humans` is registered
- `q` is required
- tool calls the shared discovery service with company id and limit
- returns structured results and a compact summary
- no confirmation is required
- required role is `team_member`

- [ ] **Step 2: Run focused internal-agent tests and verify failure**

Run:

```bash
pnpm --filter server test -- find-humans-tool.test.ts query-tools.test.ts tool-registry.test.ts
```

Expected: fails because `find_humans` is not registered.

- [ ] **Step 3: Add service to internal-agent context**

Wire `humanDiscovery` beside `humanContext` in the internal-agent service container and types.

- [ ] **Step 4: Register `find_humans`**

Add a query tool:

```ts
{
  name: "find_humans",
  description: "Find company humans by profile, role, responsibility, and capability documents. Read-only; use before routing or escalating work.",
  parameters: {
    type: "object",
    properties: {
      q: { type: "string", description: "Search query, such as a skill, responsibility, domain, or person's name" },
      role: { type: "string", description: "Optional role filter: founder, team_lead, team_member, or all" },
      departmentId: { type: "string", description: "Optional department id filter" },
      limit: { type: "number", description: "Max results to return, default 20, max 50" }
    },
    required: ["q"]
  },
  category: "query",
  requiredRole: "team_member",
  requiresConfirmation: false,
  execute: async (params, ctx) => {
    const input = searchHumansSchema.parse(params ?? {});
    const result = await ctx.services.humanDiscovery.search(ctx.companyId, input);
    return {
      success: true,
      data: result,
      summary: `Found ${result.results.length} human(s) for "${result.query}"`,
    };
  }
}
```

Use `searchHumansSchema.parse(params)` inside execute.

- [ ] **Step 5: Update registry count expectations**

If the tool registry tests assert exact counts, increment the expected query/internal tool count by one.

- [ ] **Step 6: Verify focused tool tests pass**

Run:

```bash
pnpm --filter server test -- find-humans-tool.test.ts query-tools.test.ts tool-registry.test.ts
```

Expected: PASS.

---

## Task 5: UI API + Query Key

**Files:**
- Modify: `ui/src/api/team.ts`
- Modify: `ui/src/lib/queryKeys.ts`
- Test: existing UI API/query key tests if present

- [ ] **Step 1: Add `teamApi.searchHumans`**

Add:

```ts
searchHumans: (companyId: string, input: SearchHumansInput) =>
  api.get<HumanSearchResponse>(`/companies/${companyId}/team/humans/search`, { params: input }),
```

If the local API client does not support a `params` option, build `URLSearchParams` explicitly.

- [ ] **Step 2: Add query key**

Add a stable key:

```ts
team: {
  summary: (companyId: string) => ["team", companyId] as const,
  humanSearch: (companyId: string, input: SearchHumansInput) =>
    ["team", companyId, "humans", "search", input] as const,
}
```

- [ ] **Step 3: Run UI typecheck**

Run:

```bash
pnpm --filter ui typecheck
```

Expected: PASS after Task 6 is complete; may fail now if imports are unused.

---

## Task 6: Humans Tab Search UI

**Files:**
- Modify: `ui/src/components/team/HumansTab.tsx`
- Test: `ui/src/components/team/__tests__/HumansTab.test.tsx`

- [ ] **Step 1: Write failing UI tests**

Cover:

- search placeholder says it searches skills, responsibilities, role, and docs
- typing a non-empty query calls `teamApi.searchHumans`
- search results render matched snippets
- clicking a search result opens `/team/:userId`
- clearing search returns to the local member/invite/join-request list
- pending invites and join requests still filter locally when role filter is Pending

- [ ] **Step 2: Run focused UI test and verify failure**

Run:

```bash
pnpm --filter ui test -- HumansTab.test.tsx
```

Expected: fails because server search is not wired.

- [ ] **Step 3: Wire server search**

Use a debounced trimmed query or a short direct query with TanStack Query:

```ts
const trimmedSearch = search.trim();
const shouldUseHumanSearch = trimmedSearch.length > 0 && roleFilter !== "pending";
const humanSearchQuery = useQuery({
  queryKey: selectedCompanyId
    ? queryKeys.team.humanSearch(selectedCompanyId, { q: trimmedSearch, role: roleFilter === "pending" ? "all" : roleFilter, limit: 20 })
    : ["team", "human-search", "none"],
  queryFn: () => teamApi.searchHumans(selectedCompanyId!, { q: trimmedSearch, role: roleFilter === "pending" ? "all" : roleFilter, limit: 20 }),
  enabled: Boolean(selectedCompanyId && shouldUseHumanSearch),
});
```

For search-result cards, render the same human identity shell as `MemberCard`, plus up to three snippets:

```tsx
{result.snippets.slice(0, 3).map((snippet) => (
  <p key={`${result.userId}-${snippet.label}-${snippet.value}`} className="line-clamp-2 text-xs text-muted-foreground">
    <span className="font-medium text-foreground/80">{snippet.label}:</span> {snippet.value}
  </p>
))}
```

- [ ] **Step 4: Preserve non-search behavior**

When `search` is empty:

- keep the existing local member/invite/join-request grid
- keep role filter counts based on local team summary
- keep pending invite and join-request cards

When `roleFilter === "pending"`:

- do not call human discovery
- filter pending invites/join requests locally

- [ ] **Step 5: Verify focused UI tests pass**

Run:

```bash
pnpm --filter ui test -- HumansTab.test.tsx
```

Expected: PASS.

---

## Task 7: End-to-End Discovery Flow

**Files:**
- Create or modify: `tests/e2e/human-discovery.spec.ts`

- [ ] **Step 1: Write failing E2E test**

Flow:

1. Open Team -> Humans.
2. Add or use an existing human.
3. Open that human's Capabilities tab.
4. Edit `skills.md` or a custom capability doc with a unique phrase such as `enterprise routing alpha`.
5. Return to Team -> Humans.
6. Search `enterprise routing alpha`.
7. Verify the human appears.
8. Verify the matched snippet appears.
9. Click the result and verify the human detail page opens.

- [ ] **Step 2: Run E2E and verify failure**

Run:

```bash
pnpm e2e -- human-discovery.spec.ts
```

Expected: fails until service, route, and UI are implemented.

- [ ] **Step 3: Make E2E pass**

Fix only issues directly related to discovery search behavior.

- [ ] **Step 4: Verify E2E passes**

Run:

```bash
pnpm e2e -- human-discovery.spec.ts
```

Expected: PASS.

---

## Task 8: Documentation and Terminology Note

**Files:**
- Modify: `CLAUDE.md` or `docs/architecture/decisions.md` only if a current terminology section exists and this is not duplicative.
- Otherwise create/update: `docs/aoa/plans/2026-07-08-human-discovery-routing-plan.md`

- [ ] **Step 1: Add terminology note**

Document:

```md
Human-facing UI should label person records as humans or by the person's name. The internal/API/security term `board` remains a control-plane term and should not be used as a visible person label in human profile/discovery UI.
```

- [ ] **Step 2: Add non-goals**

Document that automatic task context injection, external MCP exposure, and document-level privacy labels are not included in this sprint.

---

## Task 9: Full Verification

**Files:** all changed files.

- [ ] **Step 1: Run focused tests**

Run:

```bash
pnpm --filter @armyofagents/shared test -- team-profile-schema.test.ts
pnpm --filter server test -- human-discovery-service.test.ts human-discovery-routes.test.ts find-humans-tool.test.ts query-tools.test.ts tool-registry.test.ts
pnpm --filter ui test -- HumansTab.test.tsx
pnpm e2e -- human-discovery.spec.ts
```

- [ ] **Step 2: Run repository verification**

Run:

```bash
pnpm -r typecheck
pnpm test:run
pnpm build
```

- [ ] **Step 3: Manual UI smoke**

Run the isolated worktree app on a port that does not conflict with the user's main app. Verify:

- Team -> Humans loads.
- Empty search shows normal member/invite/request list.
- Search by profile text returns the matching human.
- Search by capability doc content returns the matching human with snippet.
- Pending filter still shows pending invites/requests and does not call discovery.
- Clicking a result opens the human detail page.

---

## Open Follow-Ups After This Sprint

- Decide whether task/run context injection should call `query_human_context`, `find_humans`, or both.
- Decide whether crew agents beyond Commander can access human discovery.
- Add privacy/visibility labels when auth/RBAC is implemented.
- Consider embeddings/vector search only after deterministic search proves insufficient.
- Consider activity/capacity signals after responsibilities and capability docs are useful in real workflows.
