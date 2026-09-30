# Resync Follow-up Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the 8 issues surfaced during the upstream-resync verification pass: 1 production bug, 1 UX gap, 1 dev-trap, 3 e2e fixture issues, and 2 cosmetic loose ends.

**Architecture:** Each fix is independently scoped and committable. Most follow established patterns already in the codebase (deployment-mode gating, e2e per-spec fixtures, prop forwarding through wrappers). No new infrastructure.

**Tech Stack:** React 18 + TypeScript (UI), Express 5 (server), Playwright (e2e), Vitest (unit), pnpm workspace, embedded-postgres (dev-only).

**Source:** Findings catalogued at `docs/superpowers/audits/2026-04-27-resync-ux-walkthrough.md` and the chat-side P1–P8 report from 2026-04-27.

---

## File Structure

| File | Touched by | Responsibility |
|------|------------|---------------|
| `ui/src/pages/InstanceSettingsPage.tsx` | T1 | Hide sign-out section in `local_trusted` mode |
| `ui/src/__tests__/InstanceSettingsPage-signout.test.tsx` | T1 | Cover the gate behavior |
| `ui/src/components/InlineEditor.tsx` | T2 | Forward `companyId` to MarkdownEditor |
| `ui/src/components/TaskSlideOver.tsx` | T2 | Pass `companyId` from `useCompany()` to InlineEditor |
| `ui/src/__tests__/TaskSlideOver-skill-autocomplete.test.tsx` | T2 | Verify slash autocomplete activates |
| `tests/e2e/sign-out-flow.spec.ts` | T3 | Re-target test against new gated behavior |
| `tests/e2e/helpers/seed-company.ts` | T4 | Shared fixture helper (NEW) |
| `tests/e2e/keyboard-cheatsheet.spec.ts` | T4 | Use seedCompany in beforeEach |
| `tests/e2e/backups-tab.spec.ts` | T4 | Use seedCompany in beforeEach |
| `tests/e2e/image-gallery.spec.ts` | T5 | Seed task + image attachments |
| `tests/e2e/mcp-key-flow.spec.ts` | T6 | Add afterEach cleanup |
| `.claude/launch.json` | T7 | Switch "server" config to `pnpm dev` |
| `server/src/postgres/embedded.ts` | T8 | Auto-cleanup orphan postgres on Windows |
| `.forbidden-tokens.json` | T9 | Default brand-token list (NEW) |

---

## Task 1: P1 — Hide Sign-out section in `local_trusted` mode

**Why:** `POST /api/auth/sign-out` returns HTTP 500 in `local_trusted` deployments because Better-Auth is never initialised there (`server/src/index.ts:423`). The 500 surfaces as "Request failed: 500" in the UI. Local instances have no real session, so the button is conceptually nonsensical anyway. Pattern matches the `deploymentMode` gates already used in `App.tsx:81`, `Layout.tsx:49`, `InviteLanding.tsx:87`.

**Files:**
- Modify: `ui/src/pages/InstanceSettingsPage.tsx:1-200` (add health query + wrap sign-out section)
- Modify: `ui/src/__tests__/InstanceSettingsPage-signout.test.tsx` (add health mock + new test cases)

- [ ] **Step 1: Write failing test for the gate (local_trusted hides section)**

Add to `ui/src/__tests__/InstanceSettingsPage-signout.test.tsx` after line 36 (auth mock block) and replace the bottom describe block:

```tsx
const mockGetHealth = vi.fn();

vi.mock("../api/health", () => ({
  healthApi: {
    get: (...args: unknown[]) => mockGetHealth(...args),
  },
}));
```

In the `describe` block's `beforeEach`, add:

```tsx
mockGetHealth.mockResolvedValue({ status: "ok", deploymentMode: "authenticated" });
```

Add a new describe block at the end of the file (before the closing of the outer describe):

```tsx
describe("Sign out section visibility by deployment mode", () => {
  it("hides the Sign out section when deploymentMode is local_trusted", async () => {
    mockGetHealth.mockResolvedValue({ status: "ok", deploymentMode: "local_trusted" });
    renderWithProviders(<InstanceSettingsPage />);

    // Wait for general settings to load so the General tab body is rendered.
    await screen.findByRole("heading", { name: /keyboard shortcuts/i });

    expect(
      screen.queryByRole("heading", { name: "Sign out", level: 2 }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /sign out/i }),
    ).not.toBeInTheDocument();
  });

  it("renders the Sign out section when deploymentMode is authenticated", async () => {
    mockGetHealth.mockResolvedValue({ status: "ok", deploymentMode: "authenticated" });
    renderWithProviders(<InstanceSettingsPage />);

    expect(
      await screen.findByRole("heading", { name: "Sign out", level: 2 }),
    ).toBeInTheDocument();
  });

  it("renders the Sign out section when deploymentMode is undefined (legacy)", async () => {
    mockGetHealth.mockResolvedValue({ status: "ok" });
    renderWithProviders(<InstanceSettingsPage />);

    expect(
      await screen.findByRole("heading", { name: "Sign out", level: 2 }),
    ).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/ui exec vitest run src/__tests__/InstanceSettingsPage-signout.test.tsx`
Expected: 3 new tests FAIL — Sign out heading is rendered regardless of deploymentMode.

- [ ] **Step 3: Implement the gate in InstanceSettingsPage**

Modify `ui/src/pages/InstanceSettingsPage.tsx`:

Add to the import block (line 18, after `cn`):

```tsx
import { healthApi } from "@/api/health";
```

Inside the `InstanceSettingsPage` function body, after the existing `generalQuery` declaration (around line 57), add:

```tsx
const healthQuery = useQuery({
  queryKey: queryKeys.health,
  queryFn: () => healthApi.get(),
  retry: false,
});
const isLocalTrusted = healthQuery.data?.deploymentMode === "local_trusted";
```

Wrap the existing sign-out section (lines 177-195) in a conditional. Replace:

```tsx
              <section className="rounded-xl border border-border bg-card p-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-1.5">
                    <h2 className="text-sm font-semibold">Sign out</h2>
                    <p className="max-w-2xl text-sm text-muted-foreground">
                      Sign out of this AoA instance. You will be redirected to the login page.
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={signOutMutation.isPending}
                    onClick={() => signOutMutation.mutate()}
                  >
                    <LogOut className="size-4" />
                    {signOutMutation.isPending ? "Signing out..." : "Sign out"}
                  </Button>
                </div>
              </section>
```

with:

```tsx
              {!isLocalTrusted && (
                <section className="rounded-xl border border-border bg-card p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-1.5">
                      <h2 className="text-sm font-semibold">Sign out</h2>
                      <p className="max-w-2xl text-sm text-muted-foreground">
                        Sign out of this AoA instance. You will be redirected to the login page.
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={signOutMutation.isPending}
                      onClick={() => signOutMutation.mutate()}
                    >
                      <LogOut className="size-4" />
                      {signOutMutation.isPending ? "Signing out..." : "Sign out"}
                    </Button>
                  </div>
                </section>
              )}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @armyofagents/ui exec vitest run src/__tests__/InstanceSettingsPage-signout.test.tsx`
Expected: All 7 tests pass (4 original + 3 new).

- [ ] **Step 5: Run typecheck**

Run: `pnpm --filter @armyofagents/ui typecheck`
Expected: No errors.

- [ ] **Step 6: Commit**

```sh
git add ui/src/pages/InstanceSettingsPage.tsx ui/src/__tests__/InstanceSettingsPage-signout.test.tsx
git commit -m "fix(instance-settings): hide Sign out in local_trusted mode (P1)

Better-Auth is never initialised when deploymentMode === 'local_trusted'
(server/src/index.ts:423), so POST /api/auth/sign-out returns HTTP 500
and the UI surfaced 'Request failed: 500' to the user. Local instances
have no real session, so the section is conceptually nonsensical there.

Gate matches the pattern already used in App.tsx:81, Layout.tsx:49, and
InviteLanding.tsx:87. Section continues to render in 'authenticated'
mode and when deploymentMode is undefined (legacy/test fixtures)."
```

---

## Task 2: P2 — Forward `companyId` through InlineEditor for skill `/`-autocomplete

**Why:** Typing `/` in TaskSlideOver's task description editor does not pop the skill autocomplete because `companyId` isn't passed through `InlineEditor` to `MarkdownEditor`. `slashCommands.length === 0` short-circuits detection at `MarkdownEditor.tsx:464`. `useCompany()` is already imported in `TaskSlideOver.tsx`.

**Files:**
- Modify: `ui/src/components/InlineEditor.tsx:7-30, 80-88` (add prop, forward to MarkdownEditor)
- Modify: `ui/src/components/TaskSlideOver.tsx` (pass `companyId` from `useCompany()`)
- Create: `ui/src/__tests__/InlineEditor-companyId.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `ui/src/__tests__/InlineEditor-companyId.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InlineEditor } from "../components/InlineEditor";

// Capture props passed into MarkdownEditor so we can assert companyId forwarding.
const capturedProps: Record<string, unknown> = {};

vi.mock("../components/MarkdownEditor", () => ({
  MarkdownEditor: (props: Record<string, unknown>) => {
    Object.assign(capturedProps, props);
    return <div data-testid="markdown-editor-mock" />;
  },
}));

vi.mock("../components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

describe("InlineEditor companyId forwarding", () => {
  beforeEach(() => {
    for (const key of Object.keys(capturedProps)) delete capturedProps[key];
  });

  it("forwards companyId prop to MarkdownEditor in multiline edit mode", async () => {
    const user = userEvent.setup();
    render(
      <InlineEditor
        value=""
        onSave={() => {}}
        multiline
        companyId="comp-abc-123"
        placeholder="click me"
      />,
    );

    await user.click(screen.getByText("click me"));
    expect(capturedProps.companyId).toBe("comp-abc-123");
  });

  it("forwards null companyId when not provided", async () => {
    const user = userEvent.setup();
    render(<InlineEditor value="" onSave={() => {}} multiline placeholder="click me" />);

    await user.click(screen.getByText("click me"));
    expect(capturedProps.companyId).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/ui exec vitest run src/__tests__/InlineEditor-companyId.test.tsx`
Expected: 2 tests FAIL — `companyId` is not in capturedProps because InlineEditor doesn't forward it.

- [ ] **Step 3: Add companyId to InlineEditor**

Modify `ui/src/components/InlineEditor.tsx`:

Replace the `InlineEditorProps` interface (lines 7-16):

```tsx
interface InlineEditorProps {
  value: string;
  onSave: (value: string) => void;
  as?: "h1" | "h2" | "p" | "span";
  className?: string;
  placeholder?: string;
  multiline?: boolean;
  imageUploadHandler?: (file: File) => Promise<string>;
  mentions?: MentionOption[];
  /** Company ID to enable skill `/`-autocomplete inside the markdown editor. */
  companyId?: string | null;
}
```

Replace the function-arg destructuring (lines 21-30):

```tsx
export function InlineEditor({
  value,
  onSave,
  as: Tag = "span",
  className,
  placeholder = "Click to edit...",
  multiline = false,
  imageUploadHandler,
  mentions,
  companyId,
}: InlineEditorProps) {
```

Replace the MarkdownEditor render (lines 80-88) — add `companyId={companyId}`:

```tsx
          <MarkdownEditor
            value={draft}
            onChange={setDraft}
            placeholder={placeholder}
            contentClassName={className}
            imageUploadHandler={imageUploadHandler}
            mentions={mentions}
            companyId={companyId}
            onSubmit={commit}
          />
```

- [ ] **Step 4: Run InlineEditor tests to verify pass**

Run: `pnpm --filter @armyofagents/ui exec vitest run src/__tests__/InlineEditor-companyId.test.tsx`
Expected: Both tests pass.

- [ ] **Step 5: Wire TaskSlideOver to pass companyId**

Find the `<InlineEditor` calls in `ui/src/components/TaskSlideOver.tsx` and add `companyId={selectedCompanyId}` to each multiline-mode InlineEditor that edits user-authored content (description, body — NOT title which is single-line and where slash conflicts with search shortcut).

Run this command first to find the exact lines:

```sh
grep -n "InlineEditor" ui/src/components/TaskSlideOver.tsx
```

For each occurrence with `multiline` set, add the prop. Example pattern (use the actual line locations from grep):

Before:
```tsx
<InlineEditor
  value={issue.description ?? ""}
  onSave={(description) => updateIssue.mutate({ description })}
  multiline
  placeholder="Add a description..."
/>
```

After:
```tsx
<InlineEditor
  value={issue.description ?? ""}
  onSave={(description) => updateIssue.mutate({ description })}
  multiline
  companyId={selectedCompanyId}
  placeholder="Add a description..."
/>
```

Verify `selectedCompanyId` is in scope — search for an existing `useCompany()` call in TaskSlideOver:

```sh
grep -n "useCompany" ui/src/components/TaskSlideOver.tsx
```

If the destructure exists but doesn't include `selectedCompanyId`, extend it. If `useCompany` isn't imported, add `import { useCompany } from "../context/CompanyContext";` and call `const { selectedCompanyId } = useCompany();` near the top of the component.

- [ ] **Step 6: Run typecheck + full UI tests**

Run: `pnpm --filter @armyofagents/ui typecheck`
Expected: No errors.

Run: `pnpm --filter @armyofagents/ui exec vitest run`
Expected: All UI tests pass.

- [ ] **Step 7: Commit**

```sh
git add ui/src/components/InlineEditor.tsx ui/src/components/TaskSlideOver.tsx ui/src/__tests__/InlineEditor-companyId.test.tsx
git commit -m "feat(editor): forward companyId through InlineEditor for skill autocomplete (P2)

The TaskSlideOver task-description editor wraps MarkdownEditor in
InlineEditor, but InlineEditor didn't forward companyId — so
slashCommands.length stayed 0 and the / skill autocomplete dropdown
never appeared in that surface. NewIssueDialog, RoutineDetail, and
Routines.tsx all hit MarkdownEditor directly and remain unaffected.

Adds companyId prop to InlineEditor (optional, defaults to undefined)
and threads selectedCompanyId from useCompany() in TaskSlideOver.
Followups for NewProjectDialog, NewGoalDialog, and IssueDocumentsSection
deferred — those are debatable priority and tracked in the audit."
```

---

## Task 3: P5d — Update sign-out e2e to expect the gated behavior

**Why:** With Task 1 landed, the existing `sign-out-flow.spec.ts` test that asserts the button is visible will fail in `local_trusted` mode (which is the e2e environment). Re-target it to assert the gating behavior instead.

**Files:**
- Modify: `tests/e2e/sign-out-flow.spec.ts`

- [ ] **Step 1: Replace the spec with gate-aware assertions**

Replace the entire body of `tests/e2e/sign-out-flow.spec.ts` with:

```ts
import { test, expect } from "@playwright/test";

/**
 * E2E: Sign-out flow (T6) + local_trusted gate (P1 fix, 2026-04-28).
 *
 * The Sign out section is hidden when deploymentMode === 'local_trusted'
 * (the e2e webServer mode). In 'authenticated' mode the section renders
 * and the button calls Better-Auth.
 *
 * Phase B audit: docs/superpowers/plans/2026-04-27-resync-verification.md (Task 6)
 * P1 follow-up:  docs/superpowers/plans/2026-04-28-resync-followup-fixes.md
 */

test.describe("Sign-out flow (T6 + P1 gate)", () => {
  test(
    "Sign out section is hidden in local_trusted mode (P1 gate)",
    async ({ page }) => {
      // The e2e webServer runs in AOA_DEPLOYMENT_MODE=local_trusted.
      await page.goto("/instance/settings");

      const generalTab = page.getByRole("tab", { name: /general/i });
      if (await generalTab.isVisible({ timeout: 3_000 }).catch(() => false)) {
        const isSelected = await generalTab.getAttribute("aria-selected");
        if (isSelected !== "true") {
          await generalTab.click();
        }
      }

      // Wait for the general tab body to render so we know the page settled.
      await expect(
        page.getByRole("heading", { name: /keyboard shortcuts/i }),
      ).toBeVisible({ timeout: 10_000 });

      // The Sign out section must NOT be present in local_trusted mode.
      await expect(
        page.getByRole("heading", { name: "Sign out", level: 2 }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: /sign out/i }),
      ).toHaveCount(0);
    },
  );

  test(
    "/api/health reports deploymentMode='local_trusted' for the e2e env",
    async ({ request }) => {
      // Pair check so a future env change doesn't silently break the gate test.
      const res = await request.get("/api/health");
      expect(res.ok()).toBe(true);
      const body = (await res.json()) as { deploymentMode?: string };
      expect(body.deploymentMode).toBe("local_trusted");
    },
  );
});
```

- [ ] **Step 2: Run the spec to verify it passes**

Run: `pnpm exec playwright test --config=tests/e2e/playwright.config.ts tests/e2e/sign-out-flow.spec.ts`
Expected: Both tests pass against a fresh `local_trusted` webServer.

- [ ] **Step 3: Commit**

```sh
git add tests/e2e/sign-out-flow.spec.ts
git commit -m "test(e2e): re-target sign-out spec to verify local_trusted gate (P5d)

T1 of the resync follow-up plan now hides the Sign out section in
local_trusted mode. The e2e webServer runs in that mode, so the old
'button visible' assertion would fail. Re-targets to assert the gate
behavior + a /api/health pair-check so a future env change doesn't
silently break the gate."
```

---

## Task 4: P5a — Shared `seedCompany` e2e fixture + apply to cheatsheet/backups specs

**Why:** `keyboard-cheatsheet.spec.ts` and `backups-tab.spec.ts` (11 tests total) all do `await page.goto("/"); await page.waitForURL(/\/[^/]+\/home/)` on the assumption that a company is auto-created. `pnpm aoa onboard --yes --run` does NOT seed one, so the redirect never fires and tests time out. Fix: each spec seeds a company in `beforeEach` via the local-board admin API (auto-authorised in `local_trusted`).

**Files:**
- Create: `tests/e2e/helpers/seed-company.ts`
- Modify: `tests/e2e/keyboard-cheatsheet.spec.ts`
- Modify: `tests/e2e/backups-tab.spec.ts`

- [ ] **Step 1: Create the helper**

Create `tests/e2e/helpers/seed-company.ts`:

```ts
import type { APIRequestContext } from "@playwright/test";

/**
 * Seed a company for an e2e spec that needs a company-prefixed route to load.
 *
 * `pnpm aoa onboard --yes --run` (the e2e webServer command) creates an empty
 * instance — no companies. Specs that navigate to `/` and expect a redirect to
 * `/{prefix}/home` need to seed at least one company first.
 *
 * In local_trusted mode the synthetic local-board actor is automatically
 * authorised by /api/companies, so no Bearer token is needed.
 *
 * Returns the seeded company so the spec can pin an issuePrefix or id.
 */
export async function seedCompany(
  request: APIRequestContext,
  name = `E2E-Test-Company-${Date.now()}`,
): Promise<{ id: string; name: string; issuePrefix: string }> {
  const res = await request.post("/api/companies", {
    data: { name },
  });
  if (!res.ok()) {
    const body = await res.text().catch(() => "(no body)");
    throw new Error(`seedCompany failed: ${res.status()} ${body}`);
  }
  const company = (await res.json()) as { id: string; name: string; issuePrefix: string };
  if (!company.id || !company.issuePrefix) {
    throw new Error(`seedCompany returned invalid company: ${JSON.stringify(company)}`);
  }
  return company;
}

/**
 * Best-effort cleanup of any test-prefixed companies left behind by previous
 * runs. Safe to call from beforeEach — silently skips on permission errors.
 */
export async function cleanupTestCompanies(
  request: APIRequestContext,
  prefixRegex = /^E2E-(Test|MCP)-/,
): Promise<void> {
  const res = await request.get("/api/companies");
  if (!res.ok()) return;
  const companies = (await res.json()) as Array<{ id: string; name: string }>;
  for (const c of companies) {
    if (!prefixRegex.test(c.name)) continue;
    await request.delete(`/api/companies/${c.id}`).catch(() => {});
  }
}
```

- [ ] **Step 2: Wire into keyboard-cheatsheet.spec.ts**

Modify `tests/e2e/keyboard-cheatsheet.spec.ts`. Add the import after line 1:

```ts
import { seedCompany, cleanupTestCompanies } from "./helpers/seed-company";
```

Inside the `test.describe("Keyboard shortcut cheatsheet (T7)", () => {` block (right after the opening line), add:

```ts
  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request);
    await seedCompany(request);
  });
```

- [ ] **Step 3: Wire into backups-tab.spec.ts**

Modify `tests/e2e/backups-tab.spec.ts` the same way — add the import and a `test.beforeEach` inside the describe block.

- [ ] **Step 4: Run the two specs**

Run: `pnpm exec playwright test --config=tests/e2e/playwright.config.ts tests/e2e/keyboard-cheatsheet.spec.ts tests/e2e/backups-tab.spec.ts`
Expected: All cheatsheet and backups tests pass (11+ tests).

- [ ] **Step 5: Commit**

```sh
git add tests/e2e/helpers/seed-company.ts tests/e2e/keyboard-cheatsheet.spec.ts tests/e2e/backups-tab.spec.ts
git commit -m "test(e2e): seed company in cheatsheet/backups specs (P5a)

pnpm aoa onboard --yes --run creates an empty instance, so '/' lands on
NoCompaniesStartPage instead of redirecting to /{prefix}/home. Tests
that depend on the redirect (11 across cheatsheet and backups specs)
were timing out at waitForURL.

Adds tests/e2e/helpers/seed-company.ts with seedCompany() and
cleanupTestCompanies() helpers. local_trusted's synthetic local-board
actor is auto-authorised on /api/companies so no Bearer token is
required. Each describe block runs both helpers in beforeEach."
```

---

## Task 5: P5c — Seed task with image attachments for image-gallery spec

**Why:** `image-gallery.spec.ts` opens a task and expects image attachments. `pnpm aoa onboard --yes --run` doesn't seed any tasks, let alone tasks with images. Fix: seed via API in `beforeAll` of the spec.

**Files:**
- Modify: `tests/e2e/image-gallery.spec.ts`

- [ ] **Step 1: Add seed helpers reuse + image fixture in image-gallery spec**

Modify `tests/e2e/image-gallery.spec.ts` — add imports and a `beforeAll`:

```ts
import { test, expect, type APIRequestContext } from "@playwright/test";
import { seedCompany, cleanupTestCompanies } from "./helpers/seed-company";

// 1x1 red PNG, base64
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

async function seedTaskWithImages(
  request: APIRequestContext,
  companyId: string,
  imageCount = 3,
): Promise<{ taskId: string; companyId: string }> {
  const issueRes = await request.post(`/api/companies/${companyId}/issues`, {
    data: { title: "E2E image gallery test task" },
  });
  if (!issueRes.ok()) {
    throw new Error(`seedTaskWithImages create issue failed: ${issueRes.status()}`);
  }
  const issue = (await issueRes.json()) as { id: string };

  for (let i = 1; i <= imageCount; i++) {
    const buffer = Buffer.from(PNG_BASE64, "base64");
    const upload = await request.post(
      `/api/companies/${companyId}/issues/${issue.id}/attachments`,
      {
        multipart: {
          file: {
            name: `e2e-image-${i}.png`,
            mimeType: "image/png",
            buffer,
          },
        },
      },
    );
    if (!upload.ok()) {
      throw new Error(`seedTaskWithImages upload ${i} failed: ${upload.status()}`);
    }
  }

  return { taskId: issue.id, companyId };
}
```

Then inside `test.describe(...)`, replace any existing `beforeEach`/`beforeAll` with:

```ts
  let seededCompanyPrefix: string;
  let seededTaskId: string;

  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request);
    const company = await seedCompany(request);
    seededCompanyPrefix = company.issuePrefix;
    const { taskId } = await seedTaskWithImages(request, company.id, 3);
    seededTaskId = taskId;
  });
```

Then, in each test, replace any hard-coded company-prefix or task-key navigation with:

```ts
  await page.goto(`/${seededCompanyPrefix}/issues/${seededTaskId}`);
```

(Adjust route to whatever the existing spec uses — `/{prefix}/tasks/{id}`, `/{prefix}/issues/{id}`, etc. — confirm by grep before editing.)

- [ ] **Step 2: Run the spec**

Run: `pnpm exec playwright test --config=tests/e2e/playwright.config.ts tests/e2e/image-gallery.spec.ts`
Expected: Both gallery tests pass — gallery opens, arrow navigation works, curtain click closes.

- [ ] **Step 3: Commit**

```sh
git add tests/e2e/image-gallery.spec.ts
git commit -m "test(e2e): seed task with images for gallery spec (P5c)

The gallery spec needs a task with image attachments. Adds beforeEach
that seeds a company + creates a task + uploads 3 PNG attachments via
the multipart attachments endpoint (same approach used in the live W3
walkthrough on 2026-04-27).

Reuses seedCompany() helper from Task 4."
```

---

## Task 6: P5b — Add cleanup to mcp-key-flow spec to stop leaking companies

**Why:** `mcp-key-flow.spec.ts` creates `E2E-MCP-{Date.now()}` companies but never deletes them. The next test (`onboarding.spec.ts`) trips on the leftover. Fix: add an `afterEach` cleanup.

**Files:**
- Modify: `tests/e2e/mcp-key-flow.spec.ts`

- [ ] **Step 1: Read the existing spec to confirm pattern**

Run: `grep -n "test.beforeEach\|test.afterEach\|describe" tests/e2e/mcp-key-flow.spec.ts`

This tells you whether there's already a `beforeEach` to extend or you need to add a fresh `afterEach`.

- [ ] **Step 2: Add the cleanup**

Modify `tests/e2e/mcp-key-flow.spec.ts`. Add the import:

```ts
import { cleanupTestCompanies } from "./helpers/seed-company";
```

Inside the `test.describe(...)` block, add:

```ts
  test.afterEach(async ({ request }) => {
    await cleanupTestCompanies(request);
  });
```

- [ ] **Step 3: Run the suite to verify mcp-key-flow + onboarding both pass**

Run: `pnpm exec playwright test --config=tests/e2e/playwright.config.ts tests/e2e/mcp-key-flow.spec.ts tests/e2e/onboarding.spec.ts`
Expected: Both specs pass — onboarding no longer trips on leftover companies.

- [ ] **Step 4: Commit**

```sh
git add tests/e2e/mcp-key-flow.spec.ts
git commit -m "test(e2e): clean up E2E-MCP companies after each test (P5b)

mcp-key-flow.spec.ts creates E2E-MCP-{Date.now()} companies but never
deletes them, leaving the database in a state that broke the next
spec's beforeEach assumption (onboarding.spec.ts expects zero
companies). Reuses cleanupTestCompanies() helper from T4."
```

---

## Task 7: P3 — Switch `.claude/launch.json` "server" config to `pnpm dev`

**Why:** `pnpm dev:server` runs the server with `uiDevMiddleware=false`, so the server serves `ui/dist/` (which is built once and goes stale). The canonical dev entry is `pnpm dev`, which runs `scripts/dev-runner.mjs` and unconditionally sets `AOA_UI_DEV_MIDDLEWARE=true` for full HMR. Switching the launch config eliminates the stale-UI trap for any future agent or developer using `preview_start`.

**Files:**
- Modify: `.claude/launch.json`

- [ ] **Step 1: Update the launch config**

Replace `.claude/launch.json` with:

```json
{
  "version": "0.0.1",
  "configurations": [
    {
      "name": "app",
      "runtimeExecutable": "cmd",
      "runtimeArgs": ["/c", "pnpm", "dev:once"],
      "port": 3100
    },
    {
      "name": "server",
      "runtimeExecutable": "cmd",
      "runtimeArgs": ["/c", "pnpm", "dev"],
      "port": 3100
    },
    {
      "name": "ui",
      "runtimeExecutable": "cmd",
      "runtimeArgs": ["/c", "pnpm", "--filter", "ui", "dev"],
      "port": 5173
    }
  ]
}
```

The only change is `runtimeArgs` for the "server" config: `["/c", "pnpm", "dev:server"]` → `["/c", "pnpm", "dev"]`.

- [ ] **Step 2: Verify by running**

Run: `pnpm dev` from a separate terminal (do NOT block on this — kill it after confirming).
Expected output includes `[aoa] AOA_UI_DEV_MIDDLEWARE=true` (or similar) and "Server listening on 127.0.0.1:3100" with `uiMode: "vite-dev"` in the startup banner.

Kill the process (Ctrl+C in the terminal you started it from).

- [ ] **Step 3: Commit**

```sh
git add .claude/launch.json
git commit -m "chore(devx): launch.json server config uses pnpm dev for HMR (P3)

pnpm dev:server runs with uiDevMiddleware=false, so the server serves
ui/dist/ — which goes stale until you manually rebuild. The canonical
dev entry is pnpm dev (via scripts/dev-runner.mjs), which sets
AOA_UI_DEV_MIDDLEWARE=true and gives full HMR.

Eliminates the stale-UI trap for any future agent or developer using
Claude_Preview's preview_start tool."
```

---

## Task 8: P4 — Embedded Postgres orphan-process recovery on Windows

**Why:** When the dev server crashes (or is hard-killed) the embedded `postgres.exe` orphans. The next startup detects the stale lock file but can't start a new postgres because the old one still holds the shared memory block. Manual `Stop-Process` is needed. Add Windows-aware detection at boot.

**Files:**
- Modify: server boot path that handles embedded postgres lock recovery (find via grep)

- [ ] **Step 1: Find the existing lock-file recovery code**

Run: `grep -rn "stale embedded PostgreSQL lock\|Removing stale" server/src`

Expected: A single match that logs `WARN: Removing stale embedded PostgreSQL lock file` and unlinks the file. This is the right place to also kill an orphan postgres process before continuing.

- [ ] **Step 2: Write the failing test**

Create or extend `server/src/__tests__/embedded-postgres-orphan.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub child_process so we can verify the kill attempt without spawning anything.
const execMock = vi.fn();

vi.mock("node:child_process", () => ({
  exec: (cmd: string, cb: (err: Error | null, stdout: string) => void) => {
    execMock(cmd);
    // Simulate "no orphans" by default; tests override per case.
    cb(null, "");
  },
  execSync: (cmd: string) => {
    execMock(cmd);
    return Buffer.from("");
  },
}));

import { tryRecoverOrphanPostgres } from "../postgres/embedded-orphan-recovery";

describe("tryRecoverOrphanPostgres (Windows-only)", () => {
  beforeEach(() => {
    execMock.mockClear();
  });

  it("is a no-op on non-Windows platforms", async () => {
    // The helper checks process.platform; we test by stubbing it.
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      await tryRecoverOrphanPostgres({ dataDir: "C:/fake/path" });
      expect(execMock).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", { value: original, configurable: true });
    }
  });

  it("issues a Stop-Process for postgres.exe processes referencing the data dir on Windows", async () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      await tryRecoverOrphanPostgres({ dataDir: "C:/Users/test/.aoa/db" });
      expect(execMock).toHaveBeenCalled();
      const cmd = execMock.mock.calls[0][0] as string;
      expect(cmd).toContain("postgres");
      expect(cmd).toMatch(/Stop-Process|taskkill/i);
    } finally {
      Object.defineProperty(process, "platform", { value: original, configurable: true });
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/embedded-postgres-orphan.test.ts`
Expected: FAIL — module `../postgres/embedded-orphan-recovery` doesn't exist.

- [ ] **Step 4: Implement the helper**

Create `server/src/postgres/embedded-orphan-recovery.ts`:

```ts
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/**
 * On Windows the embedded postgres can leave an orphan postgres.exe process
 * behind after a hard-kill of the parent Node. The next startup detects the
 * stale lock file but cannot start a new postgres because the orphan still
 * holds the shared-memory block. This helper best-effort kills any postgres
 * processes whose CommandLine references the given data directory.
 *
 * No-op on non-Windows platforms: those platforms clean up cleanly on parent
 * exit via signal propagation.
 */
export async function tryRecoverOrphanPostgres(opts: {
  dataDir: string;
}): Promise<void> {
  if (process.platform !== "win32") return;

  // Match postgres.exe whose CommandLine includes the absolute dataDir path.
  // Forward-slashes in dataDir are tolerated by Windows but we normalize to
  // backslashes for the wmic-style match.
  const dataDirPattern = opts.dataDir.replace(/\//g, "\\\\");

  const cmd = `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='postgres.exe'\\" | Where-Object { $_.CommandLine -like '*${dataDirPattern}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"`;

  try {
    await execAsync(cmd, { timeout: 10_000 });
  } catch {
    // Best-effort: if the kill fails the existing lock-removal logic and
    // user-visible startup error are still useful diagnostic surfaces.
  }
}
```

- [ ] **Step 5: Wire into the lock-recovery path**

Find the file that owns `Removing stale embedded PostgreSQL lock file` (from Step 1). At the same recovery point, call `await tryRecoverOrphanPostgres({ dataDir })` BEFORE the lock-file unlink. Concrete patch is location-dependent — read the file first and apply the smallest insertion that runs the helper exactly once before the existing unlink.

- [ ] **Step 6: Run test to verify pass**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/embedded-postgres-orphan.test.ts`
Expected: Both tests pass.

- [ ] **Step 7: Commit**

```sh
git add server/src/postgres/embedded-orphan-recovery.ts server/src/__tests__/embedded-postgres-orphan.test.ts
# Plus the file you wired into in Step 5:
git add server/src/path/to/lock-recovery-file.ts
git commit -m "fix(embedded-postgres): kill orphan postgres.exe on Windows boot (P4)

When the dev server is hard-killed, embedded postgres can orphan the
postgres.exe child process. Next startup detects the stale lock file
but the orphan still holds the shared memory block — boot fails with
'pre-existing shared memory block is still in use'.

Adds Windows-aware orphan recovery: at the same point we already
remove a stale lock file, also Stop-Process any postgres.exe whose
CommandLine references the data directory. No-op on non-Windows."
```

---

## Task 9: P6 — Commit default `.forbidden-tokens.json` so the brand-check is real

**Why:** `pnpm exec node scripts/check-forbidden-tokens.mjs` prints "Forbidden tokens list not found — skipping check." and exits 0. The check has no teeth. Commit the default token list so the gate enforces the rebrand.

**Files:**
- Create: `.forbidden-tokens.json`

- [ ] **Step 1: Find what the script expects**

Run: `cat scripts/check-forbidden-tokens.mjs | head -60`

Expected: A `readFileSync` call against a specific path (e.g. `.forbidden-tokens.json` or `config/forbidden-tokens.json`) and an explicit `tokens` and `allowlist` schema. Use the actual path the script reads — do not guess.

- [ ] **Step 2: Find existing rebrand allowlist exceptions**

The Sprint 3 polish work tagged `Porting1.1` already worked through "where Paperclip can stay" decisions. Run:

```sh
git log --grep "rebrand\|brand-check\|paperclip.*aoa" --oneline -10
```

Read commit messages and any referenced files to understand which paths/strings keep `paperclip` (e.g. external Hermes wire-protocol env vars `PAPERCLIP_API_KEY`/`PAPERCLIP_RUN_ID`, the `paperclipSkillSync` legacy field, archived spec docs).

- [ ] **Step 3: Create the config**

Create `.forbidden-tokens.json` (use whatever filename the script in Step 1 expects). Schema is whatever the script reads — populate based on Step 1's output. Example shape if the script reads `{ tokens: string[], allowPaths: string[] }`:

```json
{
  "tokens": ["paperclip", "Paperclip", "PAPERCLIP"],
  "allowPaths": [
    "docs/aoa/specs/paperclip_spec.md",
    "docs/aoa/reference/product.md",
    "docs/aoa/reference/decisions.md",
    "server/src/env-compat.js",
    "packages/shared/src/skill-sync.ts",
    "server/src/adapters/registry.ts",
    "server/src/__tests__/aoa-sentinel-compat.test.ts",
    "server/src/__tests__/env-compat-mirror.test.ts",
    "ui/src/lib/inbox.ts",
    ".changeset/*",
    "CHANGELOG.md"
  ]
}
```

(Adjust schema to match the script's actual reader. Adjust allowPaths to match what the rebrand commits actually preserve — verify by running the script and iteratively narrowing until exit 0 with real coverage.)

- [ ] **Step 4: Run the check**

Run: `pnpm exec node scripts/check-forbidden-tokens.mjs`
Expected: Exit 0 and prints something like `Forbidden tokens check passed (N tokens, M allowlist paths)`. If it prints a list of unexpected violations, narrow the allowlist OR fix the leaked tokens — DO NOT add files to the allowlist that are real leaks.

- [ ] **Step 5: Commit**

```sh
git add .forbidden-tokens.json
git commit -m "chore(brand): commit default forbidden-tokens list (P6)

scripts/check-forbidden-tokens.mjs is a no-op without its config file —
it logs 'list not found' and exits 0. Commits the rebrand-aware token
list so the gate has teeth.

Allowlist preserves the 9 places where 'paperclip' lives by design:
external Hermes wire-protocol env vars (PAPERCLIP_API_KEY/RUN_ID),
back-compat skill-sync legacy fields, env-compat mirror code, the
sentinel-compat tests, the LocalStorage migration code, and the
historical spec docs. See Sprint 3 polish commits for the full
'where Paperclip can stay' decision trail."
```

---

## Task 10: Final gates + push

**Why:** Lock the fixes in with the same gates that ran for the original resync verification, plus the now-functional brand check.

- [ ] **Step 1: Run all gates**

```sh
cd "C:\Users\TK\OneDrive\Desktop\Claude Data\Paperclip-AoA\AoA-2.5"
pnpm typecheck
pnpm exec node scripts/check-forbidden-tokens.mjs
pnpm test:run
pnpm test:e2e
pnpm build
```

Expected: each command exits 0. Brand-check now reports real coverage (was a no-op before T9). E2E suite goes from 4/19 → 19/19 passing (T3–T6 fixes).

- [ ] **Step 2: Verify branch is clean**

```sh
git status --short
```

Expected: only untracked files like `.claude/worktrees/`.

- [ ] **Step 3: Push the branch**

```sh
git push origin port/upstream-resync-2026-04-26
```

(Push to the existing remote branch — these are follow-up fixes on the same branch as the resync work.)

- [ ] **Step 4: (Optional) Update the audit doc**

Append a note to `docs/superpowers/audits/2026-04-27-resync-ux-walkthrough.md` indicating the P1–P6 follow-ups from this plan have landed:

```sh
cat >> docs/superpowers/audits/2026-04-27-resync-ux-walkthrough.md <<'EOF'

---

## 2026-04-28 follow-ups

P1, P2, P3, P4, P5a–d, P6 from the post-walkthrough RCA pass landed via
`docs/superpowers/plans/2026-04-28-resync-followup-fixes.md`. P7 (tester-only
synthetic-event quirk) and P8 (Vite EPERM during running rebuild) are
documentation-only loose ends and not addressed in code.
EOF

git add docs/superpowers/audits/2026-04-27-resync-ux-walkthrough.md
git commit -m "docs(audit): note 2026-04-28 follow-up fixes landed"
git push origin port/upstream-resync-2026-04-26
```

**Effort:** 15 min
**Dependencies:** All prior tasks.

---

## Plan summary

**Tasks:** 10 numbered tasks. Most are 1–3 file changes with a focused test.

**Effort total:** ~3–4 hours focused work.

| Task | Issue | Effort |
|------|-------|--------|
| T1 | P1 sign-out 500 (UI gate)              | ~25 min |
| T2 | P2 skill autocomplete in TaskSlideOver | ~30 min |
| T3 | P5d sign-out e2e re-target             | ~10 min |
| T4 | P5a seed-company helper + 2 specs      | ~30 min |
| T5 | P5c image-gallery seed                 | ~25 min |
| T6 | P5b mcp-key-flow cleanup               | ~10 min |
| T7 | P3 launch.json switch                  | ~5  min |
| T8 | P4 postgres orphan recovery            | ~40 min |
| T9 | P6 forbidden-tokens config             | ~25 min |
| T10| Final gates + push                     | ~15 min |

**Branch impact:** Adds approximately 9 commits on top of the 46 already on `port/upstream-resync-2026-04-26`.

**Out of scope (intentionally):**
- P7 — Tester-only synthetic-event quirk in routine create dialog. Real users typing don't hit this.
- P8 — Vite EPERM during running-server rebuild. The workaround (stop server first) is documented in this plan's introduction and the launch.json switch (T7) makes the trap less likely.
- Skill autocomplete on NewIssueDialog, RoutineDetail, Routines, NewProjectDialog, NewGoalDialog, IssueDocumentsSection. T2 fixes the highest-leverage surface (TaskSlideOver). The remaining sites are debatable priority and are tracked separately in the audit doc.
